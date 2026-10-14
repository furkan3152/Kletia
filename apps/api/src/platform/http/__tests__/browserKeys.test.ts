/**
 * Server keys from browsers: a developer (`kl_dev_`) or agent (`kl_agt_`) key
 * presented with an `Origin` outside the first-party origins answers 403
 * SECRET_KEY_FROM_BROWSER, before the key is looked up. Requests without Origin
 * (server code), first-party origins, KLETIA_WEB_ORIGIN and
 * KLETIA_SECRET_KEY_BROWSER_ORIGINS exceptions pass; the public tier and
 * operator keys are unchanged.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { configurePlatform } from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_SECRET_KEY_BROWSER_ORIGINS;
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");

let server: TestServer;
let developer: { id: string; key: string };
let agent: { id: string; key: string };

before(async () => {
  resetEngine();
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  const issued = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name: "browser-keys" } });
  assert.equal(issued.status, 201);
  developer = issued.body.key;
  const child = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${developer.id}/children`, {
    key: developer.key,
    body: { name: "browser-agent", expiresInSeconds: 86_400 },
  });
  assert.equal(child.status, 201, JSON.stringify(child.body));
  agent = child.body.key;
});

afterEach(() => {
  delete process.env.KLETIA_SECRET_KEY_BROWSER_ORIGINS;
  delete process.env.KLETIA_WEB_ORIGIN;
});

after(async () => {
  configurePlatform({ adapters: null });
  await server.close();
});

function withOrigin(key: string, origin?: string) {
  return { key, ...(origin !== undefined ? { headers: { origin } } : {}) };
}

describe("secret keys from browsers", () => {
  it("refuses developer and agent keys sent with a foreign Origin", async () => {
    for (const key of [developer.key, agent.key]) {
      const refused = assertError(await call(server, "GET", "/keys", withOrigin(key, "https://evil.example")), 403, "SECRET_KEY_FROM_BROWSER");
      assert.match(refused.error.message, /server key/u);
      assert.match(refused.error.message, /createKletiaProxy/u);
    }
    // Also through X-Kletia-Key, on public routes, and for opaque origins (sandboxed frames, files).
    assertError(await call(server, "GET", "/protocols", { headers: { "x-kletia-key": developer.key, origin: "https://evil.example" } }), 403, "SECRET_KEY_FROM_BROWSER");
    assertError(await call(server, "GET", "/keys", withOrigin(developer.key, "null")), 403, "SECRET_KEY_FROM_BROWSER");
    // A look-alike of a first-party origin is foreign.
    assertError(await call(server, "GET", "/keys", withOrigin(developer.key, "https://kletiaai.xyz.evil.example")), 403, "SECRET_KEY_FROM_BROWSER");
  });

  it("refuses before the lookup, so an unknown key from a browser reveals nothing", async () => {
    const unknown = `kl_dev_${"A".repeat(32)}`;
    assertError(await call(server, "GET", "/keys", withOrigin(unknown, "https://evil.example")), 403, "SECRET_KEY_FROM_BROWSER");
    assertError(await call(server, "GET", "/keys", withOrigin(unknown)), 401, "INVALID_API_KEY");
  });

  it("passes requests without Origin and from first-party origins", async () => {
    for (const origin of [undefined, "https://kletiaai.xyz", "https://www.kletiaai.xyz", "http://localhost:5173"]) {
      const reply = await call(server, "GET", "/keys", withOrigin(developer.key, origin));
      assert.equal(reply.status, 200, `${origin ?? "no Origin"} → ${reply.status} ${JSON.stringify(reply.body)}`);
      assert.equal((await call(server, "GET", "/keys", withOrigin(agent.key, origin))).status, 200);
    }
  });

  it("honours KLETIA_SECRET_KEY_BROWSER_ORIGINS and KLETIA_WEB_ORIGIN, exactly", async () => {
    process.env.KLETIA_SECRET_KEY_BROWSER_ORIGINS = " https://prototype.partner.example , not an origin, https://other.example/path";
    assert.equal((await call(server, "GET", "/keys", withOrigin(developer.key, "https://prototype.partner.example"))).status, 200);
    assertError(await call(server, "GET", "/keys", withOrigin(developer.key, "https://partner.example")), 403, "SECRET_KEY_FROM_BROWSER");
    assertError(await call(server, "GET", "/keys", withOrigin(developer.key, "https://other.example")), 403, "SECRET_KEY_FROM_BROWSER");
    process.env.KLETIA_WEB_ORIGIN = "https://kletia.selfhosted.example";
    assert.equal((await call(server, "GET", "/keys", withOrigin(developer.key, "https://kletia.selfhosted.example"))).status, 200);
  });

  it("leaves /v1/mcp to its own Origin rule", async () => {
    const reply = await call<{ error?: { code: string } }>(server, "POST", "/mcp", {
      key: developer.key,
      headers: { origin: "https://agent.example", accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    assert.notEqual(reply.body?.error?.code, "SECRET_KEY_FROM_BROWSER");
  });

  it("leaves the public tier and operator keys unchanged", async () => {
    assert.equal((await call(server, "GET", "/protocols", { headers: { origin: "https://evil.example" } })).status, 200);
    assert.equal((await call(server, "GET", "/usage", withOrigin(OPERATOR_KEY, "https://evil.example"))).status, 200);
  });
});
