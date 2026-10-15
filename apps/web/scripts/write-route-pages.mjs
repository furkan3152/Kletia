// Writes one HTML entry per fixed route next to dist/index.html, each with its
// own title, description, robots and canonical tags, plus dist/404.html.
//
// Static hosts without a rewrite rule (a Render static site created in the
// dashboard rather than from render.yaml) serve /developers from
// developers.html or developers/index.html; without these files every route
// except / answers 404. The SPA still decides what to render from the URL, so
// the files only carry the shell and the route's metadata. Pattern routes
// (/r/<id>, /go/<id>) and unknown paths need the host's SPA rewrite or its
// 404 page: dist/404.html is the same shell marked noindex.
//
// The route table (src/app/routes/routeTable.ts) is the single source: it is
// transpiled with TypeScript and imported; its lazy page imports never run.
//
// It also writes dist/route-manifest.json: the route table's matching rules
// as data (exact paths, prefixes, patterns and the portal's pages), so
// scripts/serve-production.mjs answers a real 404 for paths no route knows
// without reading sources (`routeStatus` below is the shared decision).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { routeStatus } from "./serve-production.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
const SITE_ORIGIN = "https://kletiaai.xyz";

export async function loadRoutes() {
  // The private matching tables are exported from the transpiled copy only, so the manifest reads the same values.
  const source = `${readFileSync(resolve(packageRoot, "src/app/routes/routeTable.ts"), "utf8")}\nexport { EXACT as __EXACT, SUB_PATTERNS as __SUB_PATTERNS };\n`;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const directory = mkdtempSync(join(tmpdir(), "kletia-routes-"));
  try {
    const file = join(directory, "routeTable.mjs");
    writeFileSync(file, outputText);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const escapeAttribute = (value) =>
  value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const escapeText = (value) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** Replaces the content of one existing tag; a missing tag fails the build (the template changed). */
function replaceTag(html, pattern, replacement, label) {
  if (!pattern.test(html)) throw new Error(`dist/index.html has no ${label} tag to rewrite.`);
  return html.replace(pattern, replacement);
}

function metaPattern(attribute, key) {
  return new RegExp(`<meta\\s+${attribute}="${key.replace(/\./gu, "\\.")}"\\s+content="[^"]*"\\s*\\/?>`, "su");
}

function pageFor(template, { title, description, robots, url }) {
  let html = template;
  html = replaceTag(html, /<title>[^<]*<\/title>/u, `<title>${escapeText(title)}</title>`, "<title>");
  const metas = [
    ["name", "description", description],
    ["name", "robots", robots],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
  ];
  for (const [attribute, key, value] of metas) {
    html = replaceTag(html, metaPattern(attribute, key), `<meta ${attribute}="${key}" content="${escapeAttribute(value)}" />`, key);
  }
  return replaceTag(html, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/u, `<link rel="canonical" href="${escapeAttribute(url)}" />`, "canonical");
}

const robotsFor = (route) =>
  route.robots ?? (route.id === "notFound" ? "noindex,follow" : route.kind === "embed" ? "noindex,nofollow" : "index,follow");

export const ROUTE_MANIFEST_SCHEMA = "kletia.route-manifest/v1";

/**
 * The route table's matching rules as data (what `matchRoute` and
 * `matchPortalPath` decide, for the production server):
 * - `exact`: paths a route answers as they are;
 * - `prefixes`: every path below them is that route (the desk at /app/…);
 * - `patterns`: regular expression sources of the pattern routes (/r/<id>, /go/<id>);
 * - `portal`: the developer portal's own pages, aliases and the pattern of
 *   what may follow a page's path; any other /developers path is "No page here".
 */
export function routeManifest(routes) {
  const { ROUTES, matchRoute, PORTAL_ROUTES, PORTAL_ALIASES, RECEIPT_PATH_PATTERN, LINK_PATH_PATTERN, __EXACT, __SUB_PATTERNS } = routes;
  if (!__EXACT || !__SUB_PATTERNS) throw new Error("routeTable.ts no longer defines EXACT and SUB_PATTERNS: update routeManifest in write-route-pages.mjs.");
  const portalPrefix = ROUTES.developers.path;
  const exact = Object.keys(__EXACT).filter((path) => path !== portalPrefix);
  // A route that answers every path below its own (probed through matchRoute, so the table stays the source).
  const prefixes = exact.filter((path) => path !== "/" && matchRoute(`${path}/route-manifest-probe`).id === __EXACT[path]).map((path) => `${path}/`);
  return {
    schema: ROUTE_MANIFEST_SCHEMA,
    exact,
    prefixes,
    patterns: [RECEIPT_PATH_PATTERN.source, LINK_PATH_PATTERN.source],
    portal: {
      prefix: portalPrefix,
      aliases: Object.keys(PORTAL_ALIASES),
      pages: PORTAL_ROUTES.map((page) => ({ path: page.path, ...(page.sub ? { sub: __SUB_PATTERNS[page.sub].source } : {}) })),
    },
  };
}

/** Writes the route pages, dist/404.html and dist/route-manifest.json. */
export function writeRoutePages(routes) {
  const { ROUTES, PRERENDER_PATHS } = routes;
  const template = readFileSync(resolve(dist, "index.html"), "utf8");

  // Fixed paths: every route whose canonical URL is its own path, and any extra
  // fixed paths the route table lists (for example the portal's sub-pages).
  // The operator panel (kind "admin") is never pre-rendered: robots.txt disallows it, its hosting headers say
  // noindex and the SPA shell sets its own robots tag.
  const pages = Object.values(ROUTES)
    .filter((route) => route.path !== "/" && route.id !== "notFound" && !route.canonicalFromPath && route.kind !== "admin")
    .map((route) => ({ path: route.path, title: route.title, description: route.description, robots: robotsFor(route) }));
  for (const extra of PRERENDER_PATHS ?? []) pages.push({ robots: "index,follow", ...extra });

  const written = [];
  for (const page of pages) {
    if (!/^\/[a-z0-9][a-z0-9/_-]*$/u.test(page.path) || page.path.includes("//")) throw new Error(`Unsafe route path ${page.path}`);
    const html = pageFor(template, { ...page, url: `${SITE_ORIGIN}${page.path}` });
    const relative = page.path.slice(1);
    mkdirSync(resolve(dist, relative), { recursive: true });
    writeFileSync(resolve(dist, `${relative}.html`), html);
    writeFileSync(resolve(dist, relative, "index.html"), html);
    written.push(page.path);
  }

  const notFound = ROUTES.notFound;
  writeFileSync(
    resolve(dist, "404.html"),
    pageFor(template, { title: notFound.title, description: notFound.description, robots: "noindex,follow", url: `${SITE_ORIGIN}/404` }),
  );

  const manifest = routeManifest(routes);
  for (const page of pages) if (routeStatus(manifest, page.path) !== 200) throw new Error(`The route manifest does not answer the pre-rendered path ${page.path}.`);
  writeFileSync(resolve(dist, "route-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`Route pages written: ${written.join(", ")} and 404.html; route-manifest.json (${manifest.exact.length} exact paths).`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) writeRoutePages(await loadRoutes());
