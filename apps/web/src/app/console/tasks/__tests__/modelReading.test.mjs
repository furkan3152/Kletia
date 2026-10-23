// Model-assisted reading and route explanations on the desk. Run with
//   node --test apps/web/src/app/console/tasks/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { mintReadingConsent, modelRead, providersLine, readAsChips, readingAvailable, readingPreference, rememberReadingPreference, routeRows, walletOfAccount } from "../modelReading.ts";

const score = { valueUsd: 100, expectedUsd: 99.5, minimumUsd: 99, minimumKind: "onchain", gasUsd: 0.1, feesUsd: 0.3, seconds: 12, signatures: 1, riskUsd: 0 };

test("only an INTENT_UNSUPPORTED refusal marked available offers model reading", () => {
  assert.equal(readingAvailable({ code: "INTENT_UNSUPPORTED", details: { modelReading: "available" } }), true);
  assert.equal(readingAvailable({ code: "INTENT_UNSUPPORTED", details: null }), false);
  assert.equal(readingAvailable({ code: "NETWORK_UNSUPPORTED", details: { modelReading: "available" } }), false);
  assert.equal(readingAvailable(null), false);
});

test("the preference defaults to ask and survives a broken store", () => {
  const map = new Map();
  const store = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  assert.equal(readingPreference(store), "ask");
  rememberReadingPreference("session", store);
  assert.equal(readingPreference(store), "session");
  const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  assert.equal(readingPreference(broken), "ask");
  rememberReadingPreference("off", broken);
});

test("consent is minted with the scope and binding, and a refusal is null", async () => {
  let sent = null;
  const ok = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ token: "mar1.a.b" }) };
  };
  assert.equal(await mintReadingConsent("https://api.example", { scope: "once", wallet: "0x2222222222222222222222222222222222222222", text: "swap" }, ok), "mar1.a.b");
  assert.equal(sent.url, "https://api.example/v1/reading-consent");
  assert.equal(sent.body.scope, "once");
  assert.equal(await mintReadingConsent("https://api.example", { scope: "confirm", wallet: "0x2", threadId: "th_a" }, async () => ({ ok: false })), null);
  assert.equal(await mintReadingConsent("https://api.example", { scope: "confirm", wallet: "0x2", threadId: "th_a" }, async () => { throw new Error("down"); }), null);
  assert.equal(walletOfAccount("eip155:8453:0x2222222222222222222222222222222222222222"), "0x2222222222222222222222222222222222222222");
  assert.equal(walletOfAccount(undefined), null);
});

test("route rows show the chosen route, compared ones, minimum kinds and estimates; providers and chips", () => {
  const intent = {
    interpretation: {
      routes: [{
        steps: ["s1"], shape: "bridge", carrier: "USDC", venues: ["across"], score, reason: "Across was cheapest after gas.",
        compared: [{ label: "Relay", score: { ...score, minimumKind: "claimed", estimate: true } }, { label: "deBridge", excluded: "No route for this pair." }],
        alternatives: [{ id: "fastest", label: "Fastest: Relay, 1 step", detail: "About 5 s", constraints: { routePreference: "fastest" } }],
        snapshot: { quotes: [], cutByDeadline: [], breakerSkipped: [], haircutsBps: {}, gas: {} },
      }],
      providersContacted: [{ provider: "across", sawAccount: true }, { provider: "relay", sawAccount: false }],
      modelReading: { used: true, sent: "masked_clause", families: 2, agreed: true, confirmed: true },
    },
  };
  const [leg] = routeRows(intent);
  assert.equal(leg.reason, "Across was cheapest after gas.");
  assert.equal(leg.rows[0].chosen, true);
  assert.match(leg.rows[0].detail, /guaranteed minimum \(enforced on-chain\)/u);
  assert.match(leg.rows[1].detail, /quoted minimum/u);
  assert.match(leg.rows[1].detail, /\(estimate\)/u);
  assert.equal(leg.rows[2].excluded, "No route for this pair.");
  assert.equal(leg.alternatives[0].label, "Fastest: Relay, 1 step");
  assert.equal(providersLine(intent), "across");
  assert.equal(modelRead(intent), true);
  assert.deepEqual(readAsChips([
    { id: "a.1", field: "actions[0].text", label: "Ignored: lol, rn", source: "default", material: false, alternatives: [] },
    { id: "a.2", field: "actions[0].amount", label: "Read as 1500 USDC", source: "default", material: true, alternatives: [] },
    { id: "a.3", field: "actions[0].network", label: "Base", source: "default", material: true, alternatives: [] },
  ]).map((chip) => chip.label), ["Read as 1500 USDC", "Ignored: lol, rn"]);
});
