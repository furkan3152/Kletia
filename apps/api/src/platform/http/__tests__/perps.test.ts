/**
 * /v1/perps over HTTP on recorded venue data: markets, positions, quote,
 * prepare and submit, the Rule Book (agent keys refused until their rule book
 * sets perps.enabled, leverage caps from the chain) and the OpenAPI entries.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { configurePerpsIo } from "../../perps/io.js";
import { resetPerpsCache } from "../../perps/service.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { fixtureIo, GMX_FIXTURE } from "../../engine/__tests__/perpsHarness.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");

let server: TestServer;
const ACCOUNT = "eip155:42161:0x1111111111111111111111111111111111111111";
const OPEN = { venue: "hyperliquid", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 4, account: ACCOUNT };

before(async () => {
  resetEngine();
  resetPerpsCache();
  configurePerpsIo(fixtureIo());
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  configurePerpsIo(null);
  await server.close();
});

async function issue(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

describe("/v1/perps", () => {
  it("lists venues and markets publicly", async () => {
    const reply = await call<{ venues: { id: string; enabled: boolean }[]; markets: { venue: string; symbol: string }[] }>(server, "GET", "/perps/markets");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.venues.map((venue) => [venue.id, venue.enabled]), [["gmx-v2", true], ["hyperliquid", true], ["drift-v2", false]]);
    assert.ok(reply.body.markets.some((market) => market.venue === "gmx-v2" && market.symbol === "BTC"));
  });

  it("reads positions and requires ?account", async () => {
    const reply = await call<{ positions: { venue: string }[] }>(server, "GET", `/perps/positions?account=${encodeURIComponent(`eip155:42161:${GMX_FIXTURE.account}`)}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.positions[0]!.venue, "gmx-v2");
    assertError(await call(server, "GET", "/perps/positions"), 400, "INVALID_REQUEST");
  });

  it("quotes with the scorer and prepares unsigned steps without a key", async () => {
    const quote = await call<{ best: { venue: string; quote: { leverage: number } } }>(server, "POST", "/perps/quote", { body: { symbol: "ETH", side: "short", collateral: { asset: "USDC", amount: "50" }, leverage: 3 } });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.best.quote.leverage, 3);
    const prepared = await call<{ prepared: { steps: { id: string; kind: string }[]; expiresAt: number } }>(server, "POST", "/perps/prepare", { body: OPEN });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual(prepared.body.prepared.steps.map((step) => step.id), ["deposit", "leverage", "order"]);
    assertError(await call(server, "POST", "/perps/prepare", { body: { ...OPEN, leverage: 21 } }), 422, "PERPS_LEVERAGE_TOO_HIGH");
    assertError(await call(server, "POST", "/perps/prepare", { body: { ...OPEN, venue: "drift-v2" } }), 422, "PERPS_VENUE_DISABLED");
    assertError(await call(server, "POST", "/perps/prepare", { body: { ...OPEN, nonsense: 1 } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/perps/submit", { body: { venue: "hyperliquid", account: ACCOUNT, action: { type: "order" }, nonce: 1, signature: "0x" } }), 400, "PERPS_SIGNATURE_INVALID");
  });

  it("refuses agent keys until their rule book enables perps, then applies its leverage cap", async () => {
    const project = await issue("perps project");
    const agent = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "perps bot" } });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    assertError(await call(server, "POST", "/perps/prepare", { key: agent.body.key.key, body: OPEN }), 403, "PERPS_POLICY_DENIED");
    const put = await call(server, "PUT", `/keys/${agent.body.key.id}/policy`, { key: project.key, body: { schema: "kletia.policy/v1", perps: { enabled: true, maxLeverage: 3, venues: ["hyperliquid"] } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const capped = assertError(await call(server, "POST", "/perps/prepare", { key: agent.body.key.key, body: OPEN }), 422, "PERPS_LEVERAGE_TOO_HIGH");
    assert.match(capped.error.message, /rule book's 3x cap/u);
    const ok = await call(server, "POST", "/perps/prepare", { key: agent.body.key.key, body: { ...OPEN, leverage: 2 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assertError(await call(server, "POST", "/perps/prepare", { key: agent.body.key.key, body: { ...OPEN, venue: "gmx-v2", leverage: 2 } }), 403, "PERPS_POLICY_DENIED");
  });

  it("documents every perps route in the served OpenAPI document", async () => {
    const reply = await call<{ paths: Record<string, Record<string, unknown>> }>(server, "GET", "/openapi.json");
    for (const [path, method] of [["/v1/perps/markets", "get"], ["/v1/perps/positions", "get"], ["/v1/perps/quote", "post"], ["/v1/perps/prepare", "post"], ["/v1/perps/submit", "post"]] as const) {
      assert.ok(reply.body.paths[path]?.[method], `${method} ${path}`);
    }
  });
});
