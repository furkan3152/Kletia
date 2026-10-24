// assistantRouteOf: questions about the person's own data, portfolio
// requests and market questions go to the assistant; instructions (even
// with "my") stay with the sentence reader.
import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_LIMITS, assistantRouteOf } from "../dist/index.js";

test("routes questions, portfolio requests and market questions", () => {
  assert.equal(assistantRouteOf("How much did I spend on fees last month?"), "portfolio-question");
  assert.equal(assistantRouteOf("what's my health factor"), "portfolio-question");
  assert.equal(assistantRouteOf("what does 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4 hold?"), "portfolio-question", "read so the assistant can refuse it");
  assert.equal(assistantRouteOf("rebalance my portfolio to 60/40 ETH/USDC"), "portfolio-action");
  assert.equal(assistantRouteOf("dump my losers"), "portfolio-action");
  assert.equal(assistantRouteOf("what is SOL trading at?"), "market-question");
});

test("leaves instructions and everything else to the reader", () => {
  for (const text of ["swap 1 SOL to USDC", "bridge my USDC from base to arbitrum", "keep my USDC in the best yield", "what can you do", "", "x".repeat(ASSISTANT_LIMITS.questionChars + 1)]) {
    assert.equal(assistantRouteOf(text), null, text);
  }
  assert.equal(assistantRouteOf("swap 0.01 ETH to USDC on base?"), null, "an instruction with a question mark is still the reader's (it refuses it)");
});
