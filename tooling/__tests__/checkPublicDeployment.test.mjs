// The public smoke checker against local stubs only (no network): the stale
// pre-v1 deployment fails, a deployment where every probe is right passes.
// Run with
//   node --test "tooling/__tests__/*.test.mjs"
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkPublicDeployment, parseOrigin } from "../check-public-deployment.mjs";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../check-public-deployment.mjs");
const SCRIPT_BODY = "/* kletia embed */ customElements.define('kletia-intent', class extends HTMLElement {});";
const INTEGRITY = `sha384-${createHash("sha384").update(SCRIPT_BODY).digest("base64")}`;

/** A local HTTP server answering from a route table ("METHOD path" → handler). */
async function stub(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url?.split("?")[0] ?? ""];
    if (req.method !== "GET" || !handler) {
      // The answer the stale hosted API gave (Express default 404 page).
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body><pre>Cannot ${req.method} ${req.url}</pre></body></html>`);
      return;
    }
    handler(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

const sendJson = (body, headers = {}) => (res) => {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const sendHtml = (headers = {}) => (res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end("<!doctype html><title>Kletia</title>");
};

function healthyApi(overrides = {}) {
  return {
    "/v1/health": sendJson({ status: "ok", api: "v1", version: "1.0.0", build: { commit: "6a3bc27f0e1d", source: "render" }, ...overrides }),
    "/v1/openapi.json": sendJson({ openapi: "3.1.0", paths: { "/v1/health": {} } }),
  };
}

function healthyWeb({ integrity = INTEGRITY, ancestors = "frame-ancestors *" } = {}) {
  return {
    "/developers": sendHtml({ "content-security-policy": "frame-ancestors 'self'" }),
    "/embed": sendHtml({ "content-security-policy": `default-src 'self'; ${ancestors}` }),
    "/sdk/embed/manifest.json": sendJson({
      schema: "kletia.embed-manifest/v1",
      version: "0.2.0",
      files: { "kletia-embed.min.js": { path: "/sdk/embed/0.2.0/kletia-embed.min.js", integrity, bytes: SCRIPT_BODY.length } },
    }),
    "/sdk/embed/0.2.0/kletia-embed.min.js": (res) => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(SCRIPT_BODY);
    },
  };
}

async function cli(...args) {
  try {
    const { stdout } = await run(process.execPath, [script, ...args], { timeout: 30_000 });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("exits 1 against the stale pre-v1 deployment (Cannot GET /v1/health)", async () => {
  const api = await stub({});
  const web = await stub({});
  try {
    const result = await cli(api.origin, web.origin, "--timeout", "5000");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FAIL\s+api-health .*HTTP 404 \(Cannot GET \/v1\/health\)/u);
    assert.match(result.stdout, /FAIL\s+web-developers/u);
    assert.match(result.stdout, /5 probe\(s\) failed/u);
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
});

test("exits 0 when every probe is right", async () => {
  const api = await stub(healthyApi());
  const web = await stub(healthyWeb());
  try {
    const result = await cli(api.origin, web.origin, "--timeout", "5000");
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stdout.match(/^PASS/gmu)?.length, 5);
    assert.match(result.stdout, /commit 6a3bc27f0e1d \(render\)/u);
    assert.match(result.stdout, /All probes passed\./u);
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
});

test("fails each probe on its own defect", async () => {
  const cases = [
    { api: healthyApi({ build: { commit: null, source: null } }), web: healthyWeb(), probe: "api-health", detail: /build\.commit is missing/u },
    { api: healthyApi({ status: "down" }), web: healthyWeb(), probe: "api-health", detail: /status down/u },
    { api: { ...healthyApi(), "/v1/openapi.json": sendJson({ swagger: "2.0" }) }, web: healthyWeb(), probe: "api-openapi", detail: /not an OpenAPI 3\.1/u },
    { api: healthyApi(), web: healthyWeb({ ancestors: "frame-ancestors 'none'" }), probe: "web-embed", detail: /expected \*/u },
    { api: healthyApi(), web: healthyWeb({ integrity: `sha384-${"A".repeat(64)}` }), probe: "embed-script", detail: /do not match the manifest integrity/u },
  ];
  for (const entry of cases) {
    const api = await stub(entry.api);
    const web = await stub(entry.web);
    try {
      const report = await checkPublicDeployment({ api: api.origin, web: web.origin, timeoutMs: 5_000 });
      assert.equal(report.ok, false);
      const failed = report.results.filter((result) => !result.ok);
      assert.deepEqual(failed.map((result) => result.probe), [entry.probe]);
      assert.match(failed[0].detail, entry.detail);
    } finally {
      await Promise.all([api.close(), web.close()]);
    }
  }
});

test("--skip leaves a probe out; bad arguments exit 2 without any request", async () => {
  const api = await stub(healthyApi());
  const web = await stub({ ...healthyWeb(), "/sdk/embed/manifest.json": undefined });
  try {
    assert.equal((await cli(api.origin, web.origin, "--timeout", "5000")).code, 1);
    const skipped = await cli(api.origin, web.origin, "--timeout", "5000", "--skip", "embed-script");
    assert.equal(skipped.code, 0, skipped.stdout);
    assert.match(skipped.stdout, /SKIP\s+embed-script/u);
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
  assert.equal((await cli("https://api.example/v1", "https://web.example")).code, 2);
  assert.equal((await cli("https://api.example")).code, 2);
  assert.equal((await cli("https://api.example", "https://web.example", "--skip", "everything")).code, 2);
  assert.equal(parseOrigin("ftp://example.com"), null);
  assert.equal(parseOrigin("https://example.com/"), "https://example.com");
});
