// Production server of the web app (Docker, `npm start`): static files from
// dist/ with the hosting headers render.yaml and vercel.json also set, the
// /go/<id> link page proxy, the embed script under /sdk/ (cross-origin,
// immutable), gzip and brotli for text, and a real 404 status (with the app
// shell) for paths no route knows, decided from dist/route-manifest.json,
// which scripts/write-route-pages.mjs writes from the route table. Node
// built-ins only and no source files, so a copy of dist/ and scripts/ runs
// on its own.
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const serviceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Origin of the Kletia API that serves intent link pages and share cards
 * (`/go/<id>` is proxied to `GET /v1/links/<id>/page`, `/go/<id>/card.png`
 * to `GET /v1/links/<id>/card.png`). Unset: `/go/<id>` is served by the web
 * app alone (it still works; link previews get the generic tags).
 */
export function parseApiOrigin(value) {
  const raw = value?.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("KLETIA_API_ORIGIN must be an absolute http(s) origin.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("KLETIA_API_ORIGIN must contain only an http(s) origin.");
  }
  return url.origin;
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const commonHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** Text types worth compressing (images, fonts and wasm are already compressed or binary). */
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest", ".xml"]);
const COMPRESS_MIN_BYTES = 1024;

const LINK_PAGE = /^\/go\/(lk_[0-9a-f]{24})\/?$/u;
const LINK_CARD = /^\/go\/(lk_[0-9a-f]{24})\/card\.png$/u;
const ACTIONS_JSON = "/actions.json";
const RECEIPT_KEYS = "/.well-known/kletia-receipt-keys.json";

// Only the embeddable widget page may be framed by other sites; intent link
// pages may not be framed at all.
const frameHeaders = (pathname) =>
  /^\/embed(?:\/|$)/u.test(pathname)
    ? { "Content-Security-Policy": "frame-ancestors *" }
    : /^\/go(?:\/|$)/u.test(pathname)
      ? {
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "frame-ancestors 'none'",
        }
      : {
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "frame-ancestors 'self'",
        };

// Receipts, approvals and intent link pages carry user content: never
// indexed. (A link's share card, /go/<id>/card.png, is served without it.)
const robotsHeaders = (pathname) =>
  /^\/(?:r|go|approve)(?:\/|$)/u.test(pathname) && !LINK_CARD.test(pathname)
    ? { "X-Robots-Tag": "noindex, nofollow" }
    : {};

// Solana Actions clients read /actions.json from any origin (Actions spec CORS).
const actionsCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
};

// Receipt verifiers (SDK, CLI, other sites) read the key mirror from any origin.
const receiptKeysHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Cache-Control": "public, max-age=3600",
};

// The embed script (integrator 4.1): any page may load it, with
// `crossorigin="anonymous"` and an SRI hash, so it answers every origin and
// may be embedded cross-origin. Versioned files never change.
const SDK_PREFIX = "/sdk/";
const SDK_MANIFEST = /^\/sdk\/[a-z0-9-]+\/manifest\.json$/u;
const sdkCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const corsHeadersFor = (pathname) =>
  pathname === ACTIONS_JSON
    ? actionsCorsHeaders
    : pathname === RECEIPT_KEYS
      ? receiptKeysHeaders
      : pathname.startsWith(SDK_PREFIX)
        ? sdkCorsHeaders
        : null;

/** Cache-Control of a served file: immutable for hashed assets and versioned SDK files, else revalidated. */
export function cacheControlFor(pathname, file, distRoot) {
  if (pathname === RECEIPT_KEYS) return receiptKeysHeaders["Cache-Control"];
  if (pathname.startsWith(SDK_PREFIX)) return SDK_MANIFEST.test(pathname) ? "no-cache" : "public, max-age=31536000, immutable";
  return file.startsWith(`${resolve(distRoot, "assets")}${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * The encoding to answer with for an Accept-Encoding header: brotli, then
 * gzip, honouring `q=0` and `*`; null for identity.
 */
export function negotiateEncoding(header) {
  const accepted = new Map();
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/u.exec(param)?.[1]).find((value) => value !== undefined);
    accepted.set(name, q === undefined ? 1 : Number(q));
  }
  const allows = (name) => (accepted.has(name) ? accepted.get(name) > 0 : (accepted.get("*") ?? 0) > 0);
  if (allows("br")) return "br";
  if (allows("gzip")) return "gzip";
  return null;
}

/**
 * 200 when a route of the manifest (dist/route-manifest.json) answers
 * `pathname` as the browser sent it, else 404. Trailing slashes are dropped
 * like the app's router does.
 */
export function routeStatus(manifest, pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") || "/" : pathname;
  if (manifest.exact.includes(path)) return 200;
  if (manifest.prefixes.some((prefix) => path.startsWith(prefix))) return 200;
  if (manifest.patterns.some((source) => new RegExp(source, "u").test(path))) return 200;
  const portal = manifest.portal;
  if (path === portal.prefix) return 200;
  if (path.startsWith(`${portal.prefix}/`)) {
    if (portal.aliases.includes(path)) return 200;
    if (portal.pages.some((page) => page.path === path)) return 200;
    const slash = path.lastIndexOf("/");
    const page = portal.pages.find((item) => item.path === path.slice(0, slash) && item.path !== portal.prefix);
    if (page?.sub && new RegExp(page.sub, "u").test(path.slice(slash + 1))) return 200;
  }
  return 404;
}

/** The route manifest of a build, or null (an older build: every path then answers 200 with the shell). */
export function readRouteManifest(distRoot) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(distRoot, "route-manifest.json"), "utf8"));
    return manifest?.schema === "kletia.route-manifest/v1" ? manifest : null;
  } catch {
    return null;
  }
}

const existingFile = async (path) => {
  try {
    const details = await stat(path);
    return details.isFile() ? details : null;
  } catch {
    return null;
  }
};

const PROXY_TIMEOUT_MS = 5_000;
const PROXY_MAX_BYTES = 512 * 1024;

const send = (response, method, status, headers, body) => {
  response.writeHead(status, { ...headers, "Content-Length": body.byteLength });
  response.end(method === "HEAD" ? undefined : body);
};

/** Compressed bodies by file, encoding, size and mtime (the dist files never change while serving). */
const COMPRESSED_CACHE_LIMIT = 256;
function compressedBody(cache, key, body, encoding) {
  const cached = cache.get(key);
  if (cached) return cached;
  const encoded =
    encoding === "br"
      ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.byteLength } })
      : gzipSync(body, { level: 9 });
  if (cache.size >= COMPRESSED_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, encoded);
  return encoded;
}

/**
 * The production request handler for a dist directory. `apiOrigin` (the
 * KLETIA_API_ORIGIN value) enables the /go/<id> proxy and the generated
 * actions.json.
 */
export function createFrontendServer({ distRoot = resolve(serviceRoot, "dist"), apiOrigin = null } = {}) {
  const routes = readRouteManifest(distRoot);
  const compressed = new Map();

  const safePath = (pathname) => {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    const target = resolve(distRoot, `.${decoded}`);
    return target === distRoot || target.startsWith(`${distRoot}${sep}`) ? target : null;
  };

  /**
   * Reads one API response for `/go/*` (5 s, 512 KB, no cookies or
   * credentials forwarded; only the user agent, which the API uses to tell link
   * unfurls from page views and then drops). Null when the API cannot answer.
   */
  async function fetchFromApi(path, request) {
    if (!apiOrigin) return null;
    try {
      const response = await fetch(`${apiOrigin}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: {
          accept: request.headers.accept || "*/*",
          ...(request.headers["user-agent"] ? { "user-agent": String(request.headers["user-agent"]).slice(0, 512) } : {}),
        },
      });
      const declared = Number(response.headers.get("content-length") || "0");
      if (declared > PROXY_MAX_BYTES) return null;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > PROXY_MAX_BYTES) return null;
      return { status: response.status, headers: response.headers, body };
    } catch {
      return null;
    }
  }

  const generatedActions = apiOrigin
    ? `${JSON.stringify({ rules: [{ pathPattern: "/go/*", apiPath: `${apiOrigin}/v1/blinks/*` }] }, null, 2)}\n`
    : null;

  /** Sends a file from dist, compressed when the type is text and the client accepts it. */
  async function sendFile(request, response, method, status, path, details, headers) {
    const extension = extname(path).toLowerCase();
    const compressible = COMPRESSIBLE.has(extension);
    const encoding = compressible && details.size >= COMPRESS_MIN_BYTES ? negotiateEncoding(request.headers["accept-encoding"]) : null;
    let body;
    try {
      body = await readFile(path);
    } catch {
      response.writeHead(503, { ...commonHeaders, "Cache-Control": "no-store" });
      response.end("Frontend build is unavailable");
      return;
    }
    if (encoding) body = compressedBody(compressed, `${path}:${details.size}:${details.mtimeMs}:${encoding}`, body, encoding);
    send(response, method, status, {
      ...headers,
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
      ...(encoding ? { "Content-Encoding": encoding } : {}),
      "Content-Type": contentTypes.get(extension) || "application/octet-stream",
    }, body);
  }

  return createServer(async (request, response) => {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const cors = corsHeadersFor(url.pathname);

    if (method === "OPTIONS" && cors) {
      response.writeHead(204, { ...commonHeaders, ...cors, "Access-Control-Max-Age": "86400" });
      response.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, {
        ...commonHeaders,
        Allow: cors ? "GET, HEAD, OPTIONS" : "GET, HEAD",
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      const body = Buffer.from(JSON.stringify({ success: true, service: "kletia-frontend" }));
      send(response, method, 200, { ...commonHeaders, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }, body);
      return;
    }

    // The deployment's own API origin, so blinks never point at another deployment.
    if (url.pathname === ACTIONS_JSON && generatedActions) {
      send(response, method, 200, { ...commonHeaders, ...actionsCorsHeaders, "Cache-Control": "public, max-age=300", "Content-Type": "application/json; charset=utf-8" }, Buffer.from(generatedActions));
      return;
    }

    const card = LINK_CARD.exec(url.pathname);
    if (card) {
      const query = url.searchParams;
      const params = new URLSearchParams();
      if (query.get("variant") === "square") params.set("variant", "square");
      if (/^\d{1,9}$/u.test(query.get("v") || "")) params.set("v", query.get("v"));
      const upstream = await fetchFromApi(`/v1/links/${card[1]}/card.png${params.size ? `?${params}` : ""}`, request);
      if (!upstream || upstream.status !== 200 || !(upstream.headers.get("content-type") || "").startsWith("image/png")) {
        send(response, method, upstream?.status === 404 ? 404 : 502, { ...commonHeaders, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Card unavailable"));
        return;
      }
      // No X-Robots-Tag: link previews must be able to fetch the card.
      send(response, method, 200, {
        ...commonHeaders,
        ...frameHeaders(url.pathname),
        "Content-Type": "image/png",
        "Cache-Control": upstream.headers.get("cache-control") || "public, max-age=300",
        ...(upstream.headers.get("etag") ? { ETag: upstream.headers.get("etag") } : {}),
        "Cross-Origin-Resource-Policy": "cross-origin",
      }, upstream.body);
      return;
    }

    const linkPage = LINK_PAGE.exec(url.pathname);
    if (linkPage) {
      const upstream = await fetchFromApi(`/v1/links/${linkPage[1]}/page`, request);
      // 200, or 404/410 with the neutral "no longer available" tags; anything
      // else (API down, no shell yet) falls back to the app, which still works.
      if (upstream && [200, 404, 410].includes(upstream.status) && (upstream.headers.get("content-type") || "").startsWith("text/html")) {
        send(response, method, upstream.status, {
          ...commonHeaders,
          ...frameHeaders(url.pathname),
          ...robotsHeaders(url.pathname),
          "Cache-Control": upstream.headers.get("cache-control") || "public, max-age=60",
          "Content-Type": "text/html; charset=utf-8",
        }, upstream.body);
        return;
      }
    }

    const requestedPath = safePath(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!requestedPath) {
      response.writeHead(400, { ...commonHeaders, "Cache-Control": "no-store" });
      response.end("Bad request");
      return;
    }

    let path = requestedPath;
    let details = await existingFile(path);
    let status = 200;
    if (!details && !extname(url.pathname)) {
      // A fixed route has its own entry with its title and description (scripts/write-route-pages.mjs).
      const routePage = safePath(`${url.pathname.replace(/\/+$/u, "")}.html`);
      const routeDetails = routePage ? await existingFile(routePage) : null;
      if (routeDetails) {
        path = routePage;
        details = routeDetails;
      }
    }
    if (!details) {
      const acceptsHtml = (request.headers.accept || "").includes("text/html");
      if ((!acceptsHtml && extname(url.pathname)) || url.pathname.startsWith(SDK_PREFIX)) {
        response.writeHead(404, {
          ...commonHeaders,
          ...frameHeaders(url.pathname),
          ...(cors ?? {}),
          "Cache-Control": "no-store",
        });
        response.end("Not found");
        return;
      }
      // The app shell answers every route; a path no route knows gets it with a 404 status (its own not-found page).
      status = routes && routeStatus(routes, url.pathname) === 404 ? 404 : 200;
      const shell = status === 404 ? resolve(distRoot, "404.html") : null;
      const shellDetails = shell ? await existingFile(shell) : null;
      path = shellDetails ? shell : resolve(distRoot, "index.html");
      details = shellDetails ?? (await existingFile(path));
    }

    if (!details) {
      response.writeHead(503, { ...commonHeaders, "Cache-Control": "no-store" });
      response.end("Frontend build is unavailable");
      return;
    }

    await sendFile(request, response, method, status, path, details, {
      ...commonHeaders,
      ...frameHeaders(url.pathname),
      ...robotsHeaders(url.pathname),
      "Cache-Control": status === 404 ? "no-cache" : cacheControlFor(url.pathname, path, distRoot),
      ...(cors ?? {}),
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 10_000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const apiOrigin = parseApiOrigin(process.env.KLETIA_API_ORIGIN);
  const distRoot = resolve(serviceRoot, "dist");
  const server = createFrontendServer({ distRoot, apiOrigin });

  // Fail fast on a build without the files the hosted static site relies on.
  for (const required of ["index.html", "go-shell.html", "route-manifest.json"]) {
    if (!(await existingFile(resolve(distRoot, required)))) {
      console.warn(`[frontend] dist/${required} is missing; build the web app first.`);
    }
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Kletia unified frontend listening on 0.0.0.0:${port}`);
    if (!apiOrigin) console.log("KLETIA_API_ORIGIN is not set: /go/<id> is served without per-link preview tags.");
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
