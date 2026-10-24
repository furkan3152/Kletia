// The desk's portfolio assistant: which sentences go to it (questions about
// the person's data, portfolio requests, market questions) and which stay
// with the planner, the answer check before the card shows anything, chart
// bars and the per-tab model-help consent. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { barRows, parseAnswer, readConsent, rememberConsent, shortAddress, sourceName } from "../assistant/assistantModel.ts";
import { routeSubmission } from "../state/deskModel.ts";

test("questions and portfolio requests go to the assistant; instructions, rates and engine pins do not", () => {
  for (const text of [
    "how much did I spend on fees last month?",
    "what's my biggest position?",
    "did I bridge to Solana this week?",
    "how is my Aave loan doing?",
    "show my trades on base",
    "rebalance my portfolio to 60/40 ETH/USDC",
    "sell my worst performer",
    "move my idle stables to the best yield",
    "close everything risky",
    "what's the price of ETH",
  ]) {
    assert.deepEqual(routeSubmission({ text }), { engine: "assistant" }, text);
  }
  for (const text of ["swap 1 SOL to USDC", "sell all my SOL", "exit all my lending positions", "put my idle stables to work"]) {
    assert.deepEqual(routeSubmission({ text }), { engine: "platform" }, text);
  }
  assert.deepEqual(routeSubmission({ text: "show live Aave rates" }), { engine: "rates" });
  assert.equal(routeSubmission({ text: "what's my biggest position?", enginePin: "base" }).engine, "network");
});

const answer = {
  route: "portfolio-question", status: "answered", text: "You paid $1.40 in fees in September 2026.",
  facts: [{ id: "f1", label: "Fees paid in September 2026", value: "$1.40", number: 1.4, unit: "usd", source: "chain", asOf: "2026-10-24T12:00:00.000Z" }],
  query: null, followUps: ["Show my portfolio"], assumptions: [], gaps: [], wording: "template", understoodBy: "parser",
  wallets: [{ label: "EVM wallet 1", address: "0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C", vm: "evm" }], asOf: "2026-10-24T12:00:00.000Z",
};

test("an answer is shown only with the shape the card needs", () => {
  assert.equal(parseAnswer({ answer })?.text, answer.text);
  assert.equal(parseAnswer({ answer: { ...answer, status: "confirmed" } }), null);
  assert.equal(parseAnswer({ answer: { ...answer, facts: [{ label: 1 }] } }), null);
  assert.equal(parseAnswer({ answer: { ...answer, action: { sentences: [1] } } }), null);
  assert.equal(parseAnswer(null), null);
});

test("bars scale to the largest absolute value and keep the sign", () => {
  const rows = barRows({ kind: "bar", label: "Change", unit: "usd", points: [{ label: "ETH", value: -18.4 }, { label: "SOL", value: 36.8 }] });
  assert.deepEqual(rows.map((row) => [row.label, row.width, row.negative, row.text]), [["ETH", 50, true, "-$18.40"], ["SOL", 100, false, "$36.80"]]);
  assert.equal(barRows({ kind: "bar", label: "Share", unit: "fraction", points: [{ label: "Base", value: 0.483 }] })[0].text, "48.3%");
});

test("sources read as words; addresses are shortened; consent is per wallet and expires", () => {
  assert.equal(sourceName("aave-oracle"), "Aave oracle");
  assert.equal(shortAddress("0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C"), "0x4f18…6e5C");
  const memory = new Map();
  const store = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  rememberConsent("0xAbC", "tok", "2026-10-24T13:00:00.000Z", store);
  assert.equal(readConsent("0xabc", Date.parse("2026-10-24T12:00:00.000Z"), store), "tok");
  assert.equal(readConsent("0xother", Date.parse("2026-10-24T12:00:00.000Z"), store), null);
  assert.equal(readConsent("0xabc", Date.parse("2026-10-24T14:00:00.000Z"), store), null);
});
