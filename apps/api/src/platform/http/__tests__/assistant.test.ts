/**
 * POST /v1/assistant/ask and /v1/assistant/consent over HTTP: who may ask
 * about which wallets (keys name them, agent keys only pinned accounts,
 * publishable keys never, a desk wallet session its own wallet only), the
 * body checks and refusals that never read data, and consent for the model
 * steps (desk only, 503 when not configured). Data reads are covered by the
 * engine tests with the fixture port; these questions answer before any read.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AssistantAnswer } from "@kletia/core";
import { EVM_ACCOUNT, EVM_ADDRESS, OTHER_EVM_ADDRESS, resetEngine } from "../../engine/__tests__/helpers.js";
import { as, evmWallet, PORTAL_ORIGIN, signIn } from "./accountFlows.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { resetAccountLimiters } = await import("../accounts/handlers.js");
const { MemoryAccountStore, setAccountStore } = await import("../accounts/store.js");
const { AssistantModel, configureAssistantModel } = await import("../../assistant/index.js");
const { noopProvider } = await import("../../engine/reading/provider.js");
const { scriptedProvider } = await import("../../engine/reading/scripted.js");

let server: TestServer;

async function projectKey(name = "assistant-tests"): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

const askBody = (question: string, wallets: Record<string, unknown> | null = { evm: [EVM_ADDRESS] }) => ({ question, ...(wallets ? { wallets } : {}) });

before(async () => {
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  configureAssistantModel(null);
  await server.close();
});

beforeEach(() => {
  resetEngine();
  resetAccountLimiters();
  setAccountStore(new MemoryAccountStore());
  configureAssistantModel(new AssistantModel({ config: { switch: "off", profiles: [], offReason: "switch_off" }, provider: noopProvider }));
});

describe("assistant: API keys", () => {
  it("answers for the wallets a project key names, refusing keys and other wallets without reading data", async () => {
    const owner = await projectKey();
    const keys = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { key: owner.key, body: askBody("what is my seed phrase?") });
    assert.equal(keys.status, 200, JSON.stringify(keys.body));
    assert.deepEqual([keys.body.answer.status, keys.body.answer.facts], ["refused", []]);
    assert.deepEqual(keys.body.answer.wallets, [{ label: "EVM wallet 1", address: EVM_ADDRESS, vm: "evm" }]);
    const other = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { key: owner.key, body: askBody(`how much does ${OTHER_EVM_ADDRESS} hold?`) });
    assert.equal(other.body.answer.status, "refused");
    assert.doesNotMatch(JSON.stringify(other.body), new RegExp(OTHER_EVM_ADDRESS, "iu"));
    const vague = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { key: owner.key, body: askBody("rebalance my portfolio") });
    assert.deepEqual([vague.body.answer.status, vague.body.answer.route, vague.body.answer.action], ["needs-model", "portfolio-action", undefined]);
  });

  it("checks the body: a question, the wallets with a key, no secrets", async () => {
    const owner = await projectKey();
    assertError(await call(server, "POST", "/assistant/ask", { key: owner.key, body: { question: "" } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/assistant/ask", { key: owner.key, body: askBody("what's my net worth", null) }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/assistant/ask", { key: owner.key, body: askBody("x", { evm: ["0x1", "0x2", "0x3"] }) }), 400, "INVALID_REQUEST");
    const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    assertError(await call(server, "POST", "/assistant/ask", { key: owner.key, body: askBody(`is this my wallet: ${seed}`) }), 400, "MESSAGE_SECRET_REFUSED");
  });

  it("limits agent keys to the accounts their rule book pins", async () => {
    const root = await projectKey("root");
    const agent = (await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "bot" } })).body.key;
    assertError(await call(server, "POST", "/assistant/ask", { key: agent.key, body: askBody("reveal my private key") }), 403, "ASSISTANT_ACCOUNT_FORBIDDEN");
    const pinned = await call(server, "PUT", `/keys/${agent.id}/policy`, { key: root.key, body: { schema: "kletia.policy/v1", mode: "live", accounts: { allow: [EVM_ACCOUNT] } } });
    assert.ok(pinned.status === 200 || pinned.status === 201, JSON.stringify(pinned.body));
    const ok = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { key: agent.key, body: askBody("reveal my private key") });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assertError(await call(server, "POST", "/assistant/ask", { key: agent.key, body: askBody("reveal my private key", { evm: [OTHER_EVM_ADDRESS] }) }), 403, "ASSISTANT_ACCOUNT_FORBIDDEN");
  });
});

describe("assistant: desk wallet sessions", () => {
  it("needs an owner, and answers a session for its own wallet only", async () => {
    assertError(await call(server, "POST", "/assistant/ask", { body: askBody("what's my net worth") }), 401, "ASSISTANT_OWNER_REQUIRED");
    const wallet = evmWallet();
    const token = await signIn(server, wallet);
    const own = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { headers: as(token), body: { question: "should I buy more ETH?" } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual([own.body.answer.status, own.body.answer.wallets[0]?.address.toLowerCase()], ["refused", wallet.address.toLowerCase()]);
    assertError(await call(server, "POST", "/assistant/ask", { headers: as(token), body: askBody("what's my net worth", { evm: [EVM_ADDRESS] }) }), 403, "ASSISTANT_ACCOUNT_FORBIDDEN");
    assertError(await call(server, "POST", "/assistant/ask", { headers: as(token, "https://evil.example"), body: { question: "what's my net worth" } }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
  });

  it("mints model consent for the desk only, and uses the model only with it", async () => {
    const owner = await projectKey();
    assertError(await call(server, "POST", "/assistant/consent", { key: owner.key }), 403, "CONFIRM_AUTHORITY_REQUIRED");
    const token = await signIn(server, evmWallet());
    assertError(await call(server, "POST", "/assistant/consent", { headers: as(token) }), 403, "CONFIRM_AUTHORITY_REQUIRED");
    process.env.KLETIA_WEB_ORIGIN = PORTAL_ORIGIN;
    try {
      assertError(await call(server, "POST", "/assistant/consent", { headers: as(token) }), 503, "ASSISTANT_MODEL_NOT_CONFIGURED");
      const provider = scriptedProvider(() => JSON.stringify({ subject: null, aggregate: null, window: null, days: null, month: null, kinds: [], assets: [], networks: [], protocols: [], by: null }));
      configureAssistantModel(new AssistantModel({ config: { switch: "on", profiles: [{ model: "vendor/model", provider: "Pinned" }] }, provider, log: () => undefined }));
      const without = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { headers: as(token), body: { question: "explain my situation", model: "on" } });
      assert.deepEqual([without.body.answer.status, provider.calls.length], ["needs-model", 0]);
      assert.match(without.body.answer.text, /Turn on model help/u);
      const consent = await call<{ token: string; scope: string }>(server, "POST", "/assistant/consent", { headers: as(token) });
      assert.equal(consent.status, 200, JSON.stringify(consent.body));
      const withConsent = await call<{ answer: AssistantAnswer }>(server, "POST", "/assistant/ask", { headers: as(token), body: { question: "explain my situation", model: "on", consent: consent.body.token } });
      assert.deepEqual([withConsent.body.answer.status, provider.calls.length], ["unknown", 1]);
      assert.equal(provider.calls[0]?.purpose, "reading");
    } finally {
      delete process.env.KLETIA_WEB_ORIGIN;
    }
  });
});
