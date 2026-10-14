/**
 * GET /v1/errors, the `docs` link on error envelopes, KLETIA_WEB_ORIGIN, and
 * the status badge (SVG and shields.io endpoint) driven by the health probe,
 * the deployment's build commit in GET /v1/health and the served OpenAPI
 * document's server list.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { CHAINS, ERROR_CATALOG, type NetworkKey } from "@kletia/core";
import { configurePlatform } from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { configureHealthProbe, createPlatformRouter, platformErrorHandler } = await import("../index.js");

function probe(healthy: (network: NetworkKey) => boolean) {
  return (network: NetworkKey) => {
    const chain = CHAINS[network];
    return Promise.resolve({ network, chain: chain.id, name: chain.name, environment: chain.environment, ok: healthy(network), latencyMs: 1 });
  };
}

let server: TestServer;

before(async () => {
  resetEngine();
  configureHealthProbe(probe(() => true));
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

const BUILD_ENV = ["RENDER_GIT_COMMIT", "KLETIA_BUILD_COMMIT", "KLETIA_API_ORIGIN"] as const;
const savedBuildEnv = Object.fromEntries(BUILD_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  delete process.env.KLETIA_WEB_ORIGIN;
  for (const name of BUILD_ENV) {
    if (savedBuildEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedBuildEnv[name];
  }
});

after(async () => {
  configureHealthProbe(null);
  configurePlatform({ adapters: null });
  await server.close();
});

describe("GET /v1/venues", () => {
  it("validates the network and lending protocol filters", async () => {
    assertError(await call(server, "GET", "/venues?network=atlantis"), 400, "INVALID_REQUEST");
    const swapOnly = assertError(await call(server, "GET", "/venues?protocol=jupiter"), 400, "INVALID_REQUEST");
    assert.match(swapOnly.error.message, /lending protocol/u);
  });

  it("lists only EVM lending venues: a Solana-only protocol has none, without any read", async () => {
    const reply = await call<{ venues: unknown[]; unavailable: unknown[] }>(server, "GET", "/venues?protocol=kamino");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(reply.body, { venues: [], unavailable: [] });
    const filtered = await call<{ venues: unknown[] }>(server, "GET", "/venues?network=solana&protocol=jupiter-lend");
    assert.deepEqual(filtered.body.venues, []);
  });
});

describe("GET /v1/errors", () => {
  it("serves the whole catalog with docs links and provider families, cacheably", async () => {
    const reply = await call<{ errors: { code: string; status: number | null; docs: string; retryable: boolean }[]; families: { pattern: string; code: string }[] }>(
      server,
      "GET",
      "/errors",
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "public, max-age=300");
    assert.equal(reply.body.errors.length, Object.keys(ERROR_CATALOG).length);
    const reused = reply.body.errors.find((entry) => entry.code === "IDEMPOTENCY_KEY_REUSED");
    assert.deepEqual([reused?.status, reused?.retryable], [422, false]);
    assert.equal(reused?.docs, "https://kletiaai.xyz/developers#error-IDEMPOTENCY_KEY_REUSED");
    assert.deepEqual(reply.body.families.map((family) => family.pattern), ["<PROVIDER>_UNAVAILABLE", "<PROVIDER>_REJECTED"]);
  });

  it("links every error envelope to its catalog entry, following KLETIA_WEB_ORIGIN", async () => {
    const missing = assertError(await call(server, "GET", `/intents/int_${"0".repeat(32)}`), 404, "INTENT_NOT_FOUND");
    assert.equal(missing.error.docs, "https://kletiaai.xyz/developers#error-INTENT_NOT_FOUND");
    process.env.KLETIA_WEB_ORIGIN = "http://localhost:5174";
    const local = assertError(await call(server, "GET", "/nope"), 404, "NOT_FOUND");
    assert.equal(local.error.docs, "http://localhost:5174/developers#error-NOT_FOUND");
    process.env.KLETIA_WEB_ORIGIN = "javascript:alert(1)";
    const unsafe = assertError(await call(server, "GET", "/nope"), 404, "NOT_FOUND");
    assert.equal(unsafe.error.docs, "https://kletiaai.xyz/developers#error-NOT_FOUND", "an unusable origin falls back to the hosted app");
  });
});

describe("GET /v1/status/badge", () => {
  it("renders an SVG badge from the health report", async () => {
    const reply = await call<string>(server, "GET", "/status/badge");
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type") ?? "", /^image\/svg\+xml/u);
    assert.equal(reply.headers.get("cache-control"), "public, max-age=60");
    assert.match(reply.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    assert.equal(reply.headers.get("cross-origin-resource-policy"), "cross-origin", "embeddable on other sites");
    assert.match(reply.body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    assert.match(reply.body, />operational<\/text>/u);
    assert.doesNotMatch(reply.body, /<script|on[a-z]+=/iu);
  });

  it("serves the shields.io endpoint document and reflects degraded and down networks", async () => {
    const ok = await call<{ schemaVersion: number; label: string; message: string; color: string }>(server, "GET", "/status/badge?format=shields");
    assert.deepEqual([ok.body.schemaVersion, ok.body.label, ok.body.message, ok.body.color], [1, "kletia api", "operational", "brightgreen"]);
    configureHealthProbe(probe((network) => network !== "base"));
    const degraded = await call<{ message: string; color: string }>(server, "GET", "/status/badge?format=shields");
    assert.deepEqual([degraded.body.message, degraded.body.color], ["degraded", "orange"]);
    configureHealthProbe(probe(() => false));
    const down = await call<string>(server, "GET", "/status/badge");
    assert.match(down.body, />down<\/text>/u);
    configureHealthProbe(probe(() => true));
    assertError(await call(server, "GET", "/status/badge?format=png"), 400, "INVALID_REQUEST");
  });
});

describe("GET /v1/health build", () => {
  type Build = { build: { commit: string | null; source: string | null } };
  const COMMIT = "6a3bc27f0e1d2c3b4a5968778695a4b3c2d1e0f9";

  it("is null when the deployment does not name its commit", async () => {
    for (const name of BUILD_ENV) delete process.env[name];
    const reply = await call<Build>(server, "GET", "/health");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.build, { commit: null, source: null });
  });

  it("reports RENDER_GIT_COMMIT first, then KLETIA_BUILD_COMMIT, and ignores values that are not commit ids", async () => {
    process.env.KLETIA_BUILD_COMMIT = "abcdef1";
    assert.deepEqual((await call<Build>(server, "GET", "/health")).body.build, { commit: "abcdef1", source: "env" });
    process.env.RENDER_GIT_COMMIT = COMMIT.toUpperCase();
    assert.deepEqual((await call<Build>(server, "GET", "/health")).body.build, { commit: COMMIT, source: "render" });
    process.env.RENDER_GIT_COMMIT = "<script>alert(1)</script>";
    process.env.KLETIA_BUILD_COMMIT = "main";
    assert.deepEqual((await call<Build>(server, "GET", "/health")).body.build, { commit: null, source: null });
  });
});

describe("GET /v1/openapi.json servers", () => {
  type Servers = { servers: { url: string; description: string }[] };

  it("lists production first when KLETIA_API_ORIGIN is unset, production or invalid", async () => {
    delete process.env.KLETIA_API_ORIGIN;
    const plain = await call<Servers>(server, "GET", "/openapi.json");
    assert.equal(plain.body.servers[0]?.url, "https://api.kletiaai.xyz");
    process.env.KLETIA_API_ORIGIN = "https://api.kletiaai.xyz";
    assert.equal((await call<Servers>(server, "GET", "/openapi.json")).body.servers[0]?.url, "https://api.kletiaai.xyz");
    process.env.KLETIA_API_ORIGIN = "http://evil.example";
    assert.equal((await call<Servers>(server, "GET", "/openapi.json")).body.servers[0]?.url, "https://api.kletiaai.xyz", "plain HTTP is accepted only for localhost");
    process.env.KLETIA_API_ORIGIN = "https://staging.example/v1?x=1";
    assert.equal((await call<Servers>(server, "GET", "/openapi.json")).body.servers[0]?.url, "https://api.kletiaai.xyz", "only a bare origin is accepted");
  });

  it("lists this deployment's origin first when KLETIA_API_ORIGIN names another origin, and keeps the exported document unchanged", async () => {
    process.env.KLETIA_API_ORIGIN = "https://staging.kletia.example";
    const reply = await call<Servers>(server, "GET", "/openapi.json");
    assert.deepEqual(reply.body.servers[0], { url: "https://staging.kletia.example", description: "This deployment" });
    assert.ok(reply.body.servers.some((entry) => entry.url === "https://api.kletiaai.xyz"), "production stays listed");
    process.env.KLETIA_API_ORIGIN = "http://localhost:3830";
    assert.equal((await call<Servers>(server, "GET", "/openapi.json")).body.servers[0]?.url, "http://localhost:3830");
    const { buildOpenApiDocument } = await import("../openapi.js");
    assert.equal((buildOpenApiDocument() as unknown as Servers).servers[0]?.url, "https://api.kletiaai.xyz", "the exported document never depends on the environment");
  });
});
