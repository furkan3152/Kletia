// Display amounts and dollars on the review (GAPS section 4): token amounts
// are rounded for reading (down for what you receive, up for what you pay),
// and dollars print to the cent like the fare, so "$0.0053" never sits next
// to "cost $0.01". Run with
//   node --test apps/web/src/app/site/intent/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { displayDecimal, formatAmount, formatUsd } from "../format.ts";

test("long amounts are rounded for display, in the reader's favour", () => {
  assert.equal(displayDecimal("0.002097274691133383"), "0.00209727");
  assert.equal(displayDecimal("0.002097274691133383", "up"), "0.00209728");
  assert.equal(displayDecimal("1328.765384188"), "1328.7653");
  assert.equal(displayDecimal("1328.765384188", "up"), "1328.7654");
  assert.equal(displayDecimal("0.99999999", "up"), "1");
  assert.equal(displayDecimal("-0.0100148"), "-0.0100148");
  // Short amounts and anything that is not a plain decimal stay exactly as given.
  assert.equal(displayDecimal("5"), "5");
  assert.equal(displayDecimal("158.1622"), "158.1622");
  assert.equal(displayDecimal("1,000.5"), "1,000.5");
  assert.equal(formatAmount({ formatted: "0.002097274691133383", symbol: "ETH" }), "0.00209727 ETH");
  assert.equal(formatAmount({ formatted: "10.1234567", symbol: "USDC" }, "up"), "10.1235 USDC");
  assert.equal(formatAmount(undefined), null);
});

test("dollars print to the cent, '<$0.01' when a fee rounds to nothing", () => {
  assert.equal(formatUsd(0.0053), "$0.01");
  assert.equal(formatUsd(0.0016), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(null), null);
});
