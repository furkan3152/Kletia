// The production server (portal PD-7, integrator P1): /sdk/* answers any
// origin with an immutable cache and the JS type, /embed keeps its framing
// headers, text is compressed (brotli, then gzip) with Vary, and paths no
// route knows answer 404 with the app shell, decided from the route manifest
// write-route-pages writes from the route table.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { createFrontendServer, negotiateEncoding, routeStatus } from "../serve-production.mjs";
import { loadRoutes, routeManifest } from "../write-route-pages.mjs";

const routes = await loadRoutes();
const manifest = routeManifest(routes);
const SCRIPT = `/*! @kletia/embed 0.1.0 */${"var a=1;".repeat(400)}`;

function fixtureDist() {
  const dist = mkdtempSync(join(tmpdir(), "kletia-serve-"));
  const write = (path, content) => {
    mkdirSync(join(dist, path, ".."), { recursive: true });
    writeFileSync(join(dist, path), content);
  };
  write("index.html", `<!doctype html><title>Kletia</title>${"<!-- shell -->".repeat(100)}`);
  write("404.html", `<!doctype html><title>Page not found: Kletia</title>${"<!-- 404 -->".repeat(100)}`);
  write("go-shell.html", "<!doctype html>");
  write("embed.html", `<!doctype html><title>Kletia intent widget</title>`);
  write("assets/app-abc123.js", SCRIPT);
  write("assets/logo.png", Buffer.alloc(2048, 1));
  write("sdk/embed/0.1.0/kletia-embed.min.js", SCRIPT);
  write("sdk/embed/manifest.json", JSON.stringify({ schema: "kletia.embed-manifest/v1", version: "0.1.0", files: {} }));
  write("route-manifest.json", JSON.stringify(manifest));
  return dist;
}

const dist = fixtureDist();
const server = createFrontendServer({ distRoot: dist });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
test.after(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
});

function get(path, headers = {}, method = "GET") {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("the embed script answers every origin, may be loaded cross-origin, never changes and is JavaScript", async () => {
  const response = await get("/sdk/embed/0.1.0/kletia-embed.min.js");
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.body.toString("utf8"), SCRIPT);
  const manifestResponse = await get("/sdk/embed/manifest.json");
  assert.equal(manifestResponse.headers["cache-control"], "no-cache");
  assert.equal(manifestResponse.headers["access-control-allow-origin"], "*");
  const missing = await get("/sdk/embed/9.9.9/kletia-embed.min.js", { accept: "text/html" });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.body.toString("utf8"), /<!doctype/u, "a missing script is never answered with the app shell");
});

test("/embed keeps its headers: framed by any site, no X-Frame-Options", async () => {
  const response = await get("/embed", { accept: "text/html" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-security-policy"], "frame-ancestors *");
  assert.equal(response.headers["x-frame-options"], undefined);
  const home = await get("/", { accept: "text/html" });
  assert.equal(home.headers["x-frame-options"], "SAMEORIGIN");
});

test("/admin is never framed, indexed or cached (same headers as render.yaml)", async () => {
  for (const path of ["/admin", "/admin/deploy"]) {
    const response = await get(path, { accept: "text/html" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers["x-frame-options"], "DENY", path);
    assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'; object-src 'none'; base-uri 'none'", path);
    assert.equal(response.headers["x-robots-tag"], "noindex, nofollow", path);
    assert.equal(response.headers["cache-control"], "no-store", path);
  }
  const lookalike = await get("/administrator", { accept: "text/html" });
  assert.equal(lookalike.headers["x-robots-tag"], undefined);
});

test("text is compressed with brotli, then gzip, with Vary; binaries and small files are not", async () => {
  const br = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.equal(brotliDecompressSync(br.body).toString("utf8"), SCRIPT);
  assert.equal(Number(br.headers["content-length"]), br.body.byteLength);
  const gzip = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, br;q=0" });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gzip.body).toString("utf8"), SCRIPT);
  const identity = await get("/assets/app-abc123.js");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.headers.vary, "Accept-Encoding");
  assert.equal(identity.body.toString("utf8"), SCRIPT);
  const png = await get("/assets/logo.png", { "accept-encoding": "br" });
  assert.equal(png.headers["content-encoding"], undefined);
  const head = await get("/assets/app-abc123.js", { "accept-encoding": "gzip" }, "HEAD");
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(Number(head.headers["content-length"]), gzip.body.byteLength);
  assert.equal(negotiateEncoding("*"), "br");
  assert.equal(negotiateEncoding("identity"), null);
  assert.equal(negotiateEncoding("br;q=0, gzip;q=0.5"), "gzip");
});

test("unknown paths answer 404 with the app shell; fixed and pattern routes answer 200", async () => {
  for (const path of ["/nothing-here", "/developers/no-such-page", "/r/not-a-receipt", "/developers/contracts/a/b"]) {
    const response = await get(path, { accept: "text/html" });
    assert.equal(response.status, 404, path);
    assert.match(response.body.toString("utf8"), /Page not found: Kletia/u, path);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  }
  for (const path of ["/", "/studio", "/app/tasks", "/developers", "/developers/embed", "/developers/embed-builder", "/developers/contracts/ct_123", `/r/rcpt_${"a".repeat(32)}`, "/approve"]) {
    const response = await get(path, { accept: "text/html" });
    assert.equal(response.status, 200, path);
  }
});

test("the manifest decides like the route table (matchRoute and the portal's own pages)", () => {
  const probes = [
    "/", "/studio", "/studio/x", "/embed", "/embed/", "/app", "/app/holdings", "/app/x/y", "/approve", "/approve/x", "/networks", "/protocols",
    "/developers", "/developers/", "/developers/embed", "/developers/embed-builder", "/developers/api", "/developers/api/createIntent",
    "/developers/api/1bad", "/developers/recipes/react-widget", "/developers/recipes/UPPER", "/developers/webhooks/new", "/developers/webhooks/wh_1",
    "/developers/keys/x", "/developers/nope", "/developers/contracts/a/b", `/r/rcpt_${"0".repeat(32)}`, "/r/rcpt_short", `/go/lk_${"1".repeat(24)}`,
    "/go/other", "/404", "/r", "/go", "/x", "/sdk", "/console",
  ];
  for (const probe of probes) {
    const path = probe.length > 1 ? probe.replace(/\/+$/u, "") : probe;
    const route = routes.matchRoute(path);
    const portal = routes.matchPortalPath(path);
    const expected = route.id === "notFound" || portal?.id === "missing" ? 404 : 200;
    assert.equal(routeStatus(manifest, probe), expected, probe);
  }
});
