import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(serviceRoot, "dist");
const port = Number(process.env.PORT || 10_000);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

/**
 * Origin of the Kletia API that serves intent link pages and share cards
 * (`/go/<id>` is proxied to `GET /v1/links/<id>/page`, `/go/<id>/card.png`
 * to `GET /v1/links/<id>/card.png`). Unset: `/go/<id>` is served by the web
 * app alone (it still works; link previews get the generic tags).
 */
const apiOrigin = (() => {
  const raw = process.env.KLETIA_API_ORIGIN?.trim();
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
})();

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

const corsHeadersFor = (pathname) =>
  pathname === ACTIONS_JSON
    ? actionsCorsHeaders
    : pathname === RECEIPT_KEYS
      ? receiptKeysHeaders
      : null;

const safePath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const target = resolve(distRoot, `.${decoded}`);
  return target === distRoot || target.startsWith(`${distRoot}${sep}`)
    ? target
    : null;
};

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

const send = (response, method, status, headers, body) => {
  response.writeHead(status, { ...headers, "Content-Length": body.byteLength });
  response.end(method === "HEAD" ? undefined : body);
};

const server = createServer(async (request, response) => {
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

  const requestedPath = safePath(
    url.pathname === "/" ? "/index.html" : url.pathname,
  );
  if (!requestedPath) {
    response.writeHead(400, { ...commonHeaders, "Cache-Control": "no-store" });
    response.end("Bad request");
    return;
  }

  let path = requestedPath;
  let details = await existingFile(path);
  if (!details) {
    const acceptsHtml = (request.headers.accept || "").includes("text/html");
    if (!acceptsHtml && extname(url.pathname)) {
      response.writeHead(404, {
        ...commonHeaders,
        ...frameHeaders(url.pathname),
        ...(cors ?? {}),
        "Cache-Control": "no-store",
      });
      response.end("Not found");
      return;
    }
    path = resolve(distRoot, "index.html");
    details = await existingFile(path);
  }

  if (!details) {
    response.writeHead(503, { ...commonHeaders, "Cache-Control": "no-store" });
    response.end("Frontend build is unavailable");
    return;
  }

  const extension = extname(path).toLowerCase();
  const immutableAsset = path.startsWith(
    `${resolve(distRoot, "assets")}${sep}`,
  );
  response.writeHead(200, {
    ...commonHeaders,
    ...frameHeaders(url.pathname),
    ...robotsHeaders(url.pathname),
    "Cache-Control": immutableAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    ...(cors ?? {}),
    "Content-Length": details.size,
    "Content-Type": contentTypes.get(extension) || "application/octet-stream",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path)
    .on("error", () => response.destroy())
    .pipe(response);
});

// Fail fast on a build without the files the hosted static site relies on.
for (const required of ["index.html", "go-shell.html"]) {
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
