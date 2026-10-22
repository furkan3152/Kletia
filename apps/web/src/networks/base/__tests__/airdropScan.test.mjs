// The Airdrop check's failure state (GAPS 3.12): when a Blockscout list or the
// price read aborts, the panel shows what failed and a retry instead of a
// browser alert that a dismissed or blocked dialog hid. Run with
//   node --test apps/web/src/networks/base/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { INVALID_ADDRESS_FAILURE, safeProviderErrorMessage, scanFailure } from "../components/airdropScan.ts";

test("a timed-out or refused provider read is retryable and says nothing was sent", () => {
  for (const message of ["Blockscout ERC-20 transfers timed out.", "Blockscout ERC-721 transfers returned HTTP 503.", "Failed to fetch"]) {
    const failure = scanFailure(new Error(message));
    assert.equal(failure.retryable, true, message);
    assert.equal(failure.detail, message);
    assert.match(failure.hint, /Nothing was sent or signed/u);
    assert.match(failure.hint, /try again in a minute/u);
  }
  const odd = scanFailure(new Error("Blockscout normal transactions returned malformed records."));
  assert.equal(odd.retryable, true);
  assert.match(odd.hint, /Try again/u);
  assert.equal(scanFailure("not an error").detail, "A live provider did not answer.");
});

test("provider messages never show URLs, credentials or long payloads", () => {
  const message = safeProviderErrorMessage(
    new Error(`fetch https://base.blockscout.com/api?module=account&apikey=abc failed, api_key=sk_live_1 with 0x${"ab".repeat(60)}`),
    "fallback",
  );
  assert.doesNotMatch(message, /https?:\/\//u);
  assert.doesNotMatch(message, /sk_live_1/u);
  assert.doesNotMatch(message, /0xabab/u);
  assert.equal(safeProviderErrorMessage(new Error("   "), "fallback"), "fallback");
});

test("an invalid address is not retryable as is", () => {
  assert.equal(INVALID_ADDRESS_FAILURE.retryable, false);
});

test("the panel renders the failure with a retry and no longer uses alert()", () => {
  const source = readFileSync(new URL("../components/AirdropSimulator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\balert\(/u);
  assert.match(source, /role="alert"/u);
  assert.match(source, /Try again/u);
  assert.match(source, /setFailure\(scanFailure\(error\)\)/u);
});
