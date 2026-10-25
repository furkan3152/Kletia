// Reverts read as words, never as raw data (the Perps panel showed
// "custom error 0x5dac504d: 0000…").
//   node --test apps/web/src/shared/wallet/__tests__/revertReason.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { readableRevert } from "../revertReason.ts";

const DATA = "0".repeat(64) + "1".repeat(64);

test("GMX's InsufficientExecutionFee is named, the hex is gone", () => {
  const text = readableRevert(`Execution reverted with reason: custom error 0x5dac504d: 0x${DATA}`);
  assert.match(text, /execution fee .* below what GMX asks for .*\(InsufficientExecutionFee\)/u);
  assert.doesNotMatch(text, /0x5dac504d|0000/u);
});

test("an unknown custom error keeps only its selector; reason strings and panics read plainly", () => {
  assert.equal(readableRevert(`execution reverted: custom error 0xdeadbeef: ${DATA}`), "The contract refused this transaction (its error 0xdeadbeef is not one Kletia can name).");
  assert.equal(readableRevert("Execution reverted with reason: Too little received.\nContract Call:\n  address: 0x1"), "The contract refused this transaction: “Too little received”.");
  assert.equal(readableRevert("execution reverted: panic code 0x11"), "The contract refused this transaction: an amount overflowed or went below zero.");
  assert.equal(readableRevert(`execution reverted 0x${DATA}`), "The contract refused this transaction.");
});

test("other messages are left as they are", () => {
  assert.equal(readableRevert("User rejected the request."), "User rejected the request.");
});
