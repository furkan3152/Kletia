// A zero-dependency server for index.html. The page must be served over
// http(s): the widget proves which site embeds it through the page's origin,
// and a file:// page has none.
//
// The embed script comes from the Kletia origin itself, pinned by the SHA-384
// integrity this server reads from <KLETIA_ORIGIN>/sdk/embed/manifest.json on
// every page view, so a changed script is refused by the browser. The script
// also tells the element where it came from, so the element needs no
// `origin` attribute for a local or self-hosted Kletia.
//
//   KLETIA_ORIGIN  Kletia web origin (default https://kletiaai.xyz;
//                  http://localhost:<port> for a local Kletia)
//   PORT           port of this page (default 3000; 0 picks a free one)
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PAGE = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const MARKER = "<!--KLETIA_SCRIPT-->";

/** https, or http on localhost only; nothing but an origin. */
export function kletiaOrigin(value = "https://kletiaai.xyz") {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new Error("KLETIA_ORIGIN must be an https origin, or http://localhost:<port>.");
  }
  return url.origin;
}

const escapeAttribute = (value) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** The classic script's path and integrity from the manifest; null when it cannot be used (fail closed). */
export async function readManifest(origin) {
  try {
    const response = await fetch(`${origin}/sdk/embed/manifest.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) return null;
    const manifest = await response.json();
    const file = manifest?.files?.["kletia-embed.min.js"];
    const versioned = /^\/sdk\/embed\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/kletia-embed\.min\.js$/u.exec(file?.path ?? "");
    if (manifest?.schema !== "kletia.embed-manifest/v1" || !versioned || versioned[1] !== manifest.version) return null;
    if (!/^sha384-[A-Za-z0-9+/]{64}$/u.test(file.integrity ?? "")) return null;
    return { src: `${origin}${file.path}`, integrity: file.integrity };
  } catch {
    return null;
  }
}

/** index.html with the pinned script tag, or a notice and no script when the manifest is unavailable. */
export function renderPage(script) {
  const tag = script
    ? `<script src="${escapeAttribute(script.src)}" integrity="${escapeAttribute(script.integrity)}" crossorigin="anonymous"></script>`
    : `<p class="notice">The Kletia origin did not serve /sdk/embed/manifest.json, so the widget script cannot be pinned and is not loaded.</p>`;
  return PAGE.replace(MARKER, tag);
}

export function startServer({ origin = kletiaOrigin(process.env.KLETIA_ORIGIN || undefined), port = Number(process.env.PORT ?? 3000) } = {}) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if ((request.method !== "GET" && request.method !== "HEAD") || (path !== "/" && path !== "/index.html")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const body = renderPage(await readManifest(origin));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      // The widget frame only needs to be framed by this page; this page frames only Kletia.
      "content-security-policy": `frame-src ${origin}; frame-ancestors 'none'`,
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      console.log(`Acme checkout on http://localhost:${address.port} (Kletia: ${origin})`);
      resolve(server);
    });
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await startServer();
