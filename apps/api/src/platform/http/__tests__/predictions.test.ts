/**
 * /v1/predictions over HTTP on recorded Polymarket data: markets, one
 * market, positions, quote, prepare and the relay's refusals, the Rule Book
 * (agent keys refused until their rule book sets predictions.enabled, the
 * chain's stake cap), the account's Polymarket wallets and wallet moves, the
 * MCP tools, the hand-off through ?clarify=true and the OpenAPI entries.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { configurePredictionsIo } from "../../predictions/io.js";
import { resetPredictionsCache } from "../../predictions/service.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { predictionFixtureIo } from "../../engine/__tests__/predictionsHarness.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");

let server: TestServer;
const ACCOUNT = "eip155:137:0x1111111111111111111111111111111111111111";
const BUY = { marketId: "666861", outcome: "Yes", side: "buy", amountUsd: "20", account: ACCOUNT };

before(async () => {
  resetEngine();
  resetPredictionsCache();
  configurePredictionsIo(predictionFixtureIo({ chain: { pusd: 100_000_000n } }));
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  configurePredictionsIo(null);
  await server.close();
});

async function issue(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

describe("/v1/predictions", () => {
  it("lists venues and markets publicly, one market by id or condition id, and positions", async () => {
    const list = await call<{ venues: { id: string; enabled: boolean }[]; markets: { id: string }[] }>(server, "GET", "/predictions/markets?category=politics");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.venues.map((venue) => [venue.id, venue.enabled]), [["polymarket", true], ["limitless", false]]);
    assert.ok(list.body.markets.length > 0);
    const one = await call<{ market: { id: string }; outcomes: { book: unknown }[] }>(server, "GET", "/predictions/markets/666861");
    assert.equal(one.status, 200);
    assert.ok(one.body.outcomes[0]!.book);
    const byCondition = await call<{ market: { id: string } }>(server, "GET", "/predictions/markets/0x48b0b0bca515f68fccf95af4793dbd0edbfec1f8ec6e8df2c0f69ba74f8c4722");
    assert.equal(byCondition.body.market.id, "666861");
    assertError(await call(server, "GET", "/predictions/markets/abc"), 404, "PREDICTION_MARKET_NOT_FOUND");
    assertError(await call(server, "GET", "/predictions/markets?category=gossip"), 400, "INVALID_REQUEST");
    const positions = await call<{ positions: unknown[] }>(server, "GET", `/predictions/positions?account=${encodeURIComponent(ACCOUNT)}`);
    assert.equal(positions.status, 200);
    assert.equal(positions.body.positions.length, 4);
    assertError(await call(server, "GET", "/predictions/positions"), 400, "INVALID_REQUEST");
  });

  it("finds the account's Polymarket wallets and refuses moves for a wallet that is not its own", async () => {
    const wallets = await call<{ account: string; wallets: unknown[]; plainWallet: boolean; profile: { status: string } }>(server, "GET", `/predictions/wallets?account=${encodeURIComponent(ACCOUNT)}`);
    assert.equal(wallets.status, 200, JSON.stringify(wallets.body));
    assert.deepEqual([wallets.body.wallets.length, wallets.body.plainWallet, wallets.body.profile.status], [0, true, "none"], "no wallet is ever guessed");
    assertError(await call(server, "GET", "/predictions/wallets"), 400, "ACCOUNT_INVALID");
    const move = await call(server, "POST", "/predictions/wallet", { body: { account: ACCOUNT, wallet: "0x1dab69f26c401d587d9e4875e68dd0d878818719", action: "withdraw", amountUsd: "5" } });
    assertError(move, 422, "PREDICTION_WALLET_NOT_FOUND");
    assertError(await call(server, "POST", "/predictions/prepare", { body: { ...BUY, wallet: "0x1dab69f26c401d587d9e4875e68dd0d878818719" } }), 422, "PREDICTION_WALLET_NOT_FOUND");
  });

  it("quotes and prepares without a key; the relay refuses what prepare did not build", async () => {
    const quote = await call<{ quote: { maxLossUsd: number } }>(server, "POST", "/predictions/quote", { body: BUY });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.quote.maxLossUsd, 20);
    const prepared = await call<{ prepared: { steps: { id: string }[]; order: Record<string, unknown>; ticket: string } }>(server, "POST", "/predictions/prepare", { body: BUY });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual(prepared.body.prepared.steps.map((step) => step.id), ["approve-pusd-exchange", "sign-in", "order"]);
    const tampered = { ...prepared.body.prepared.order, makerAmount: "1" };
    assertError(await call(server, "POST", "/predictions/submit", { body: { account: ACCOUNT, order: tampered, ticket: prepared.body.prepared.ticket, signature: `0x${"11".repeat(65)}` } }), 400, "PREDICTION_SIGNATURE_INVALID");
    assertError(await call(server, "POST", "/predictions/prepare", { body: { ...BUY, venue: "limitless" } }), 422, "PREDICTION_VENUE_DISABLED");
    assertError(await call(server, "POST", "/predictions/prepare", { body: { ...BUY, nonsense: 1 } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/predictions/orders", { body: { account: ACCOUNT } }), 400, "PREDICTION_SESSION_REQUIRED");
  });

  it("refuses agent keys until their rule book enables prediction markets, then applies its stake cap", async () => {
    const project = await issue("predictions project");
    const agent = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "prediction bot" } });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    assertError(await call(server, "POST", "/predictions/prepare", { key: agent.body.key.key, body: BUY }), 403, "PREDICTION_POLICY_DENIED");
    const put = await call(server, "PUT", `/keys/${agent.body.key.id}/policy`, { key: project.key, body: { schema: "kletia.policy/v1", predictions: { enabled: true, maxStakeUsd: "10", venues: ["polymarket"] } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const capped = assertError(await call(server, "POST", "/predictions/prepare", { key: agent.body.key.key, body: BUY }), 422, "PREDICTION_STAKE_TOO_HIGH");
    assert.match(capped.error.message, /10\.00 USD cap/u);
    const ok = await call(server, "POST", "/predictions/prepare", { key: agent.body.key.key, body: { ...BUY, amountUsd: "10" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("hands prediction sentences to Predict through ?clarify=true, asking instead of guessing a market", async () => {
    const one = await call<{ status: string; handoff: { surface: string; input: Record<string, unknown> } }>(server, "POST", "/intents?clarify=true", { body: { text: "bet $20 on yes for trump out as president before 2027", accounts: [ACCOUNT] } });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.status, "handoff");
    assert.deepEqual(one.body.handoff.input, { action: "buy", venue: "polymarket", marketId: "666861", market: "Trump out as President before 2027?", outcome: "Yes", amountUsd: "20" });
    const many = await call<{ status: string; questions: { reason: string; options: { id: string }[] }[] }>(server, "POST", "/intents?clarify=true", { body: { text: "bet $20 on yes for trump", accounts: [ACCOUNT] } });
    assert.equal(many.body.status, "needs_input");
    assert.equal(many.body.questions[0]!.reason, "MARKET_AMBIGUOUS");
    assert.ok(many.body.questions[0]!.options.length > 1);
    const odds = await call<{ status: string; handoff: { input: Record<string, unknown> } }>(server, "POST", "/intents?clarify=true", { body: { text: "what are the odds of trump out as president?", accounts: [ACCOUNT] } });
    assert.deepEqual(odds.body.handoff.input, { action: "search", query: "trump out as president" });
  });

  it("serves the MCP tools and documents every route in the OpenAPI document", async () => {
    const reply = await call<{ paths: Record<string, Record<string, unknown>> }>(server, "GET", "/openapi.json");
    const routes = [
      ["/v1/predictions/markets", "get"], ["/v1/predictions/markets/{id}", "get"], ["/v1/predictions/positions", "get"], ["/v1/predictions/quote", "post"],
      ["/v1/predictions/prepare", "post"], ["/v1/predictions/session", "post"], ["/v1/predictions/submit", "post"], ["/v1/predictions/orders", "post"],
      ["/v1/predictions/orders/cancel", "post"], ["/v1/predictions/redeem", "post"], ["/v1/predictions/wallets", "get"], ["/v1/predictions/wallet", "post"],
    ] as const;
    for (const [path, method] of routes) assert.ok(reply.body.paths[path]?.[method], `${method} ${path}`);
  });
});
