// The last check before a wallet prompt: a step whose transaction is already
// recorded (by the API, or by this tab) is never offered for a signature again.
//   node --test apps/web/src/shared/platform/__tests__/signingGuard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { signingRefusal } from "../signingGuard.ts";

const step = (status) => ({ id: "s1", title: "Supply 100 USDC to Aave V3", status });
const HASH = "0x5e3a9c0d1f2b4a6c8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";

test("a step that is ready and has nothing recorded may be signed", () => {
  assert.equal(signingRefusal(step("ready")), null);
  assert.equal(signingRefusal(step("awaiting_signature"), []), null);
});

test("a step the API already saw sent is never signed again", () => {
  for (const status of ["submitted", "confirmed", "settling", "indeterminate", "settled"]) {
    assert.match(signingRefusal(step(status)) ?? "", /will not ask your wallet to sign “Supply 100 USDC to Aave V3” again/u, status);
  }
});

test("a transaction hash this tab recorded blocks a new signature until it is checked on-chain", () => {
  const refusal = signingRefusal(step("awaiting_signature"), [HASH]);
  assert.match(refusal ?? "", /already recorded its transaction 0x5e3a9c…1c2d/u);
  assert.match(refusal ?? "", /nothing new was requested/u);
});
