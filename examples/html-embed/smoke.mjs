// Smoke run (npm run check, and the build step of check-examples): a stand-in
// Kletia origin serves a manifest and a script on 127.0.0.1, and the page must
// pin exactly that script with its SHA-384 integrity and crossorigin; without a
// manifest the page loads no script at all. No network, no key, nothing signed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { renderPage, startServer } from "./server.mjs";

const script = Buffer.from("/*! @kletia/embed 9.9.9 | stand-in */ window.KletiaEmbed = {};\n");
const integrity = `sha384-${createHash("sha384").update(script).digest("base64")}`;
let serveManifest = true;

const kletia = createServer((request, response) => {
  if (request.url === "/sdk/embed/manifest.json" && serveManifest) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schema: "kletia.embed-manifest/v1", version: "9.9.9", files: { "kletia-embed.min.js": { path: "/sdk/embed/9.9.9/kletia-embed.min.js", integrity, bytes: script.byteLength } } }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => kletia.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${kletia.address().port}`;
const page = await startServer({ origin, port: 0 });
const url = `http://127.0.0.1:${page.address().port}/`;

try {
  const html = await (await fetch(url)).text();
  assert.ok(
    html.includes(`<script src="${origin}/sdk/embed/9.9.9/kletia-embed.min.js" integrity="${integrity}" crossorigin="anonymous"></script>`),
    "the script comes from the Kletia origin with its integrity and crossorigin",
  );
  assert.match(html, /<kletia-intent[\s\S]*accent="0F766E"[\s\S]*><\/kletia-intent>/u, "the element carries appearance attributes");
  assert.doesNotMatch(html, /\sorigin="/u, "the element takes its origin from the script URL");
  assert.match(html, /kletia:\$\{name\}/u, "the page logs the widget's events");
  assert.doesNotMatch(html, /kl_(?:dev|agt)_/u, "no secret key in the page");

  serveManifest = false;
  const without = await (await fetch(url)).text();
  assert.doesNotMatch(without, /<script src=/u, "no manifest, no script");
  assert.match(without, /cannot be pinned/u);
  assert.equal((await fetch(`${url}secrets.env`)).status, 404, "only the page is served");
  assert.match(renderPage({ src: 'https://x.example/"><script>', integrity: "sha384-x" }), /src="https:\/\/x\.example\/&quot;&gt;&lt;script&gt;"/u);
  console.log("html-embed smoke: ok");
} finally {
  page.close();
  kletia.close();
}
