// One fee total everywhere (plan, review, fare, widget, receipt view): network
// fees, deducted venue fees and costs on top. The amount a step spends is never
// a fee, in the total or in the fare's row notes.
import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePreview, formatPreviewAmount, getAsset, totalFeesUsd } from "@kletia/core";

import { fareModel, formatUsdAbs } from "../dist/review.js";

const AT = "2026-10-25T00:00:00.000Z";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:6ncfqSF3xwxUbF1USdx1y8VqBDCKCoDxQHZ1usME27Xy";
const BASE = "eip155:8453:0x5eed00000000000000000000000000000000c0de";
const SOL_NATIVE = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const USDC_SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETH_BASE = "eip155:8453/slip44:60";
const PRICES = { [SOL_NATIVE]: 100, [USDC_SOL]: 1, [USDC_BASE]: 1, [ETH_BASE]: 2500 };

const delta = (network, account, asset, symbol, decimals, units) => ({
  network, account, asset, symbol, decimals, listed: getAsset(asset) !== null,
  expected: { amount: String(units), formatted: formatPreviewAmount(BigInt(units), decimals) },
  worst: { amount: String(units), formatted: formatPreviewAmount(BigInt(units), decimals) },
  certainty: "quoted", steps: [], role: "you",
});
const step = (id, index, network, account, input, extra = {}) => ({
  id, index, kind: "swap", title: `Leg ${index + 1}`, network, chain: network === "solana" ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" : "eip155:8453",
  account, protocol: "jupiter", mode: "wallet", dependsOn: [], status: "ready", evidence: [], input, feesUsd: 0.05, ...extra,
});
const amount = (asset, symbol, decimals, units) => ({ asset, symbol, decimals, amount: String(units), formatted: formatPreviewAmount(BigInt(units), decimals) });

function graph(steps) {
  return {
    spec: "kletia.intent/v1", id: "int_fees000000000000000000000000000", createdAt: AT, updatedAt: AT, expiresAt: AT, status: "planned",
    request: { accounts: [SOL, BASE] }, interpretation: { source: "grammar", confidence: 1 }, steps, edges: [],
    // The plan's own estimate (per-step feesUsd, summed by the planner): what a receipt carries.
    summary: { title: "x", networks: ["solana", "base"], inputs: [], outputs: [], totalFeesUsd: 0.1, signaturesRequired: 2, crossNetwork: false },
    warnings: [],
  };
}

test("swapping SOL: the 0.1 SOL input is not a fee; one fee total for the review, the fare and the plan", () => {
  const intent = graph([
    step("s1", 0, "solana", SOL, amount(SOL_NATIVE, "SOL", 9, 100_000_000)),
    step("s2", 1, "base", BASE, amount(USDC_BASE, "USDC", 6, 20_000_000)),
  ]);
  const previews = [
    {
      stepId: "s1", network: "solana", kind: "swap", status: "quoted", at: AT,
      deltas: [delta("solana", SOL, SOL_NATIVE, "SOL", 9, -100_005_000), delta("solana", SOL, USDC_SOL, "USDC", 6, 10_000_000)],
      payments: [], approvals: [], issues: [],
      fees: [
        { stepId: "s1", network: "solana", kind: "network", label: "Solana network fee", asset: { asset: SOL_NATIVE, symbol: "SOL", decimals: 9 }, amount: "5000", paid: "on-top", certainty: "estimated" },
        { stepId: "s1", network: "solana", kind: "venue", label: "Jupiter platform fee", asset: { asset: USDC_SOL, symbol: "USDC", decimals: 6 }, amount: "10000", paid: "deducted", certainty: "quoted" },
      ],
    },
    {
      stepId: "s2", network: "base", kind: "swap", status: "quoted", at: AT,
      // A fee-only debit: Base ETH pays the leg's network fee and nothing else.
      deltas: [delta("base", BASE, USDC_BASE, "USDC", 6, -20_000_000), delta("base", BASE, ETH_BASE, "ETH", 18, -364_000_000_000_000), delta("base", BASE, ETH_BASE.replace("slip44:60", "erc20:0x4200000000000000000000000000000000000006"), "WETH", 18, 7_600_000_000_000_000)],
      payments: [], approvals: [], issues: [],
      fees: [{ stepId: "s2", network: "base", kind: "network", label: "Base network fee", asset: { asset: ETH_BASE, symbol: "ETH", decimals: 18 }, amount: "364000000000000", paid: "on-top", certainty: "estimated" }],
    },
  ];
  const preview = aggregatePreview(intent, previews, PRICES, AT);
  const fare = fareModel(preview, intent);

  const solRow = fare.youPay.find((row) => row.expected.symbol === "SOL");
  assert.equal(solRow.note, "includes the network fee, leg 1", "the swapped SOL is the input, never labelled a fee");
  const ethRow = fare.youPay.find((row) => row.expected.symbol === "ETH");
  assert.equal(ethRow.note, "network fee, leg 2");
  assert.equal(fare.youPay.find((row) => row.expected.symbol === "USDC").note, null);

  // Fees: Solana 0.0005 + Jupiter 0.01 + Base 0.91 = 0.92; the $10 input is not in it.
  const total = totalFeesUsd({ summary: intent.summary, preview });
  assert.equal(total, 0.92);
  assert.ok(total < 1, "the 0.1 SOL ($10) input is not counted");
  // The review's "Total fees", the fare's head and the widget's "Fees ≈" all read this one total.
  assert.equal(fare.totals.fees, formatUsdAbs(total));
  assert.equal(fare.totals.fees, "$0.92");
  // Without a fare (a plan view, the receipt), the plan's estimate is the total.
  assert.equal(totalFeesUsd({ summary: intent.summary, preview: null }), 0.1);
  assert.equal(totalFeesUsd({ summary: {}, preview: null }), null);
});
