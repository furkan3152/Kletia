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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
const SITE_ORIGIN = "https://kletiaai.xyz";

async function loadRoutes() {
  const source = readFileSync(resolve(packageRoot, "src/app/routes/routeTable.ts"), "utf8");
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

const { ROUTES, PRERENDER_PATHS } = await loadRoutes();
const template = readFileSync(resolve(dist, "index.html"), "utf8");

const robotsFor = (route) =>
  route.robots ?? (route.id === "notFound" ? "noindex,follow" : route.kind === "embed" ? "noindex,nofollow" : "index,follow");

// Fixed paths: every route whose canonical URL is its own path, and any extra
// fixed paths the route table lists (for example the portal's sub-pages).
const pages = Object.values(ROUTES)
  .filter((route) => route.path !== "/" && route.id !== "notFound" && !route.canonicalFromPath)
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

console.log(`Route pages written: ${written.join(", ")} and 404.html.`);
