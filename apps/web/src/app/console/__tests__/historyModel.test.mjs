// The desk's History view and value chart model (history/historyModel.ts):
// rows with legs, unknown values kept unknown, receipt links only for Kletia
// steps, coverage notes, the filter query, the value line and PnL rows.
import assert from "node:assert/strict";
import test from "node:test";

import { amountText, coverageNotes, EMPTY_FILTERS, filterQuery, historyNotConfigured, historyRow, legValue, pnlRows, valueChart } from "../history/historyModel.ts";

const ACCOUNT = "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D";

function tx(overrides = {}) {
  return {
    id: "base:0x02", network: "base", hash: "0x02", account: ACCOUNT, time: "2026-10-20T10:00:00.000Z", block: 1, kind: "swap", status: "success",
    legs: [
      { asset: { symbol: "ETH", address: null, decimals: 18, id: "eip155:8453/slip44:60" }, amount: "0.100000000000000001", direction: "out", usdAtTime: 412.5, priceSource: "defillama" },
      { asset: { symbol: "USDC", address: "0x83", decimals: 6, id: null }, amount: "2500", direction: "in", usdAtTime: null, priceSource: null, reason: "No historical price was found for this time." },
    ],
    fee: { asset: { symbol: "ETH", address: null, decimals: 18, id: null }, amount: "0.000001", usd: null },
    counterparty: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", protocol: { id: "kyberswap", label: "KyberSwap", role: "aggregator-router" }, method: "swap",
    kletiaIntentId: null, kletiaReceiptId: null, source: "etherscan", explorerUrl: "https://basescan.org/tx/0x02",
    ...overrides,
  };
}

test("a row names the kind and protocol, signs the legs, and keeps unknown values unknown", () => {
  const row = historyRow(tx());
  assert.equal(row.title, "Swap · KyberSwap");
  assert.match(row.meta, /^Base · /u);
  assert.deepEqual(row.legs, ["−0.1… ETH", "+2,500 USDC"]);
  assert.equal(row.fee, "0.000001 ETH", "an unknown fee value is left out, never $0");
  assert.equal(row.explorerName, "BaseScan");
  assert.equal(row.receiptPath, null);
  assert.equal(row.kletia, false);
  assert.deepEqual(legValue(tx().legs[1]), { text: "No historical price was found for this time.", known: false });
  assert.deepEqual(legValue(tx().legs[0]), { text: "$412.50", known: true });
});

test("a Kletia step links its receipt, and a plain send names the other side", () => {
  const linked = historyRow(tx({ kletiaIntentId: "int_1", kletiaReceiptId: "rcpt_1" }));
  assert.equal(linked.receiptPath, "/r/rcpt_1");
  assert.equal(linked.kletia, true);
  const send = historyRow(tx({ kind: "send", protocol: null, counterparty: "0x1111111111111111111111111111111111111111" }));
  assert.equal(send.title, "Sent to 0x1111…1111");
  assert.equal(amountText({ amount: null, asset: { symbol: "XYZ" } }), "Unknown amount of XYZ");
  const tiny = historyRow(tx({ fee: { asset: { symbol: "ETH", address: null, decimals: 18, id: null }, amount: "0.000001", usd: 0.004 } }));
  assert.equal(tiny.fee, "0.000001 ETH (<$0.01)", "a fee under a cent never reads $0.00");
});

test("coverage notes group the unread accounts, and all-unconfigured is its own state", () => {
  const coverage = [
    { account: ACCOUNT, network: "base", provider: null, status: "not-configured", reason: "EVM history needs ETHERSCAN_API_KEY.", env: ["ETHERSCAN_API_KEY"] },
    { account: ACCOUNT.replace("8453", "1"), network: "ethereum", provider: null, status: "not-configured", reason: "EVM history needs ETHERSCAN_API_KEY.", env: ["ETHERSCAN_API_KEY"] },
  ];
  assert.deepEqual(coverageNotes(coverage), ["Base, Ethereum: EVM history needs ETHERSCAN_API_KEY."]);
  assert.equal(historyNotConfigured(coverage), true);
  assert.equal(historyNotConfigured([{ ...coverage[0], status: "ok", provider: "etherscan", reason: undefined }]), false);
  assert.deepEqual(coverageNotes([{ ...coverage[0], status: "ok", provider: "etherscan", reason: undefined }]), []);
});

test("the filter query leaves blank fields out", () => {
  assert.deepEqual(filterQuery(EMPTY_FILTERS), { limit: 50 });
  assert.deepEqual(filterQuery({ network: "base", kind: "swap", asset: "  usdc ", kletiaOnly: true }, "abc"), { network: "base", kind: "swap", asset: "usdc", kletiaOnly: true, cursor: "abc", limit: 50 });
});

test("the value line needs two points and scales to its own range", () => {
  assert.equal(valueChart([{ at: "2026-10-24T08:00:00.000Z", usd: 1, complete: true }]), null);
  const chart = valueChart([
    { at: "2026-10-24T08:00:00.000Z", usd: 100, complete: true },
    { at: "2026-10-24T09:00:00.000Z", usd: 150, complete: false },
    { at: "2026-10-24T10:00:00.000Z", usd: 120, complete: true },
  ]);
  assert.equal(chart.path, "M0.00 38.00 L50.00 2.00 L100.00 23.60");
  assert.equal(chart.min, 100);
  assert.equal(chart.max, 150);
  assert.equal(chart.incomplete, 1);
});

test("PnL rows keep unknown parts unknown and tone the known total", () => {
  const rows = pnlRows({
    assets: [
      { key: "ETH", symbol: "ETH", openQuantity: 0.5, costBasisUsd: 1500, realizedUsd: 2500, unrealizedUsd: 500, currentUsd: 2000 },
      { key: "USDC", symbol: "USDC", openQuantity: 0, costBasisUsd: 0, realizedUsd: null, unrealizedUsd: 0, currentUsd: 0, reason: "More was disposed of than the read history acquired." },
      { key: "DUST", symbol: "DUST", openQuantity: 0, costBasisUsd: 0, realizedUsd: 0, unrealizedUsd: 0, currentUsd: 0 },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.symbol, row.realized, row.unrealized, row.tone]), [["ETH", "+$2,500.00", "+$500.00", "up"], ["USDC", "Unknown", "$0.00", "flat"]]);
  assert.match(rows[1].note, /More was disposed/u);
});
