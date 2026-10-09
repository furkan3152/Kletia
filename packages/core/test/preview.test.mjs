import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CERTAINTY_ORDER,
  PREVIEW_CHANGE_CODES,
  PREVIEW_SPEC,
  PREVIEW_WARNING_CODES,
  aggregatePreview,
  canonicalJson,
  formatPreviewAmount,
  getAsset,
  materialChange,
  previewDigest,
  previewDigestInput,
  validatePreviewAck,
} from "../dist/index.js";

const BASE = "eip155:8453:0x5eed00000000000000000000000000000000c0de";
const ARB = "eip155:42161:0x5eed00000000000000000000000000000000c0de";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:6ncfqSF3xwxUbF1USdx1y8VqBDCKCoDxQHZ1usME27Xy";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_BASE = "eip155:8453/slip44:60";
const ETH_ARB = "eip155:42161/slip44:60";
const BBQ = "eip155:42161/erc20:0x5c0c306aaa9f877de636f4d5822ca9f2e81563ba";
const SOL_NATIVE = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const AT = "2026-10-09T13:40:12.418Z";

const amount = (units) => ({ amount: String(units), formatted: formatPreviewAmount(BigInt(units), 6) });
const delta = (network, account, asset, symbol, decimals, expected, worst, certainty) => ({
  network,
  account,
  asset,
  symbol,
  decimals,
  listed: getAsset(asset) !== null,
  expected: { amount: String(expected), formatted: "" },
  worst: { amount: String(worst), formatted: "" },
  certainty,
  steps: [],
  role: "you",
});

function graph(overrides = {}) {
  const steps = [
    {
      id: "s1", index: 0, kind: "bridge", title: "Bridge", network: "base", chain: "eip155:8453", account: BASE, protocol: "relay", mode: "wallet",
      dependsOn: [], status: "ready", evidence: [], recipient: ARB, settlement: { kind: "cross-network", destinationNetwork: "arbitrum", expectedSeconds: 16 }, estimatedSeconds: 16,
    },
    {
      id: "s2", index: 1, kind: "call", title: "Deposit", network: "arbitrum", chain: "eip155:42161", account: ARB, protocol: "custom-call", mode: "wallet",
      dependsOn: ["s1"], status: "pending", evidence: [],
    },
  ];
  return {
    spec: "kletia.intent/v1", id: "int_3f9a0000000000000000000000000000", createdAt: AT, updatedAt: AT, expiresAt: AT, status: "planned",
    request: { accounts: [BASE], text: "bridge 100 USDC from base to arbitrum then deposit it" },
    interpretation: { source: "grammar", confidence: 1 }, steps, edges: [{ from: "s1", to: "s2", kind: "funds" }],
    summary: { title: "x", networks: ["base", "arbitrum"], inputs: [], outputs: [], signaturesRequired: 2, crossNetwork: true }, warnings: [],
    ...overrides,
  };
}

/** The design's §8.2 example: bridge 100 USDC Base → Arbitrum (Relay), then deposit into a vault. */
function stepPreviews() {
  return [
    {
      stepId: "s1", network: "base", kind: "bridge", status: "simulated", at: AT, block: "52381583", endpoint: "base-rpc.publicnode.com",
      deltas: [
        delta("base", BASE, USDC_BASE, "USDC", 6, -100_000_000, -100_000_000, "simulated"),
        delta("base", BASE, ETH_BASE, "ETH", 18, -627968980908, -627968980908, "simulated"),
        // Destination credit to the user's own account on Arbitrum: venue minimum.
        delta("arbitrum", ARB, USDC_ARB, "USDC", 6, 99_965_772, 99_465_943, "venue-minimum"),
      ],
      payments: [],
      fees: [
        { stepId: "s1", network: "base", kind: "network", label: "Base network fee", asset: { asset: ETH_BASE, symbol: "ETH", decimals: 18 }, amount: "627968980908", paid: "on-top", certainty: "simulated" },
        { stepId: "s1", network: "base", kind: "l1-data", label: "Base L1 data fee", asset: { asset: ETH_BASE, symbol: "ETH", decimals: 18 }, amount: "4000000000", paid: "on-top", certainty: "simulated" },
        { stepId: "s1", network: "base", kind: "venue", label: "Relay relayer fee", asset: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, amount: "34228", paid: "deducted", certainty: "quoted" },
      ],
      approvals: [
        { stepId: "s1", network: "base", token: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31", spenderLabel: "Relay depository", amount: "100000000", formatted: "100", leftAfter: "0" },
      ],
      issues: [],
    },
    {
      stepId: "s2", network: "arbitrum", kind: "call", status: "simulated-assumed-funds", at: AT, overrides: [{ asset: USDC_ARB, amount: "99465943" }],
      deltas: [
        delta("arbitrum", ARB, USDC_ARB, "USDC", 6, -99_965_772, -99_465_943, "simulated-assumed-funds"),
        delta("arbitrum", ARB, ETH_ARB, "ETH", 18, -8_000_000_000_000, -8_000_000_000_000, "simulated-assumed-funds"),
        delta("arbitrum", ARB, BBQ, "bbqUSDC", 18, 95477308837200000000n, 94904922370720000000n, "estimated"),
      ],
      payments: [],
      fees: [{ stepId: "s2", network: "arbitrum", kind: "network", label: "Arbitrum network fee", asset: { asset: ETH_ARB, symbol: "ETH", decimals: 18 }, amount: "8000000000000", paid: "on-top", certainty: "simulated-assumed-funds" }],
      approvals: [
        { stepId: "s2", network: "arbitrum", token: { asset: USDC_ARB, symbol: "USDC", decimals: 6 }, spender: "0x5c0C306aaa9f877de636f4d5822ca9f2e81563ba", spenderLabel: "Acme Yield (custom contract)", amount: "99465943", formatted: "99.465943", leftAfter: "0" },
      ],
      issues: [],
    },
  ];
}

const PRICES = { [ETH_BASE]: 2500, [ETH_ARB]: 2500, [USDC_BASE]: 1, [USDC_ARB]: 1, [BBQ]: 1.047, [SOL_NATIVE]: 110 };

test("aggregatePreview: bridge + funded deposit nets the transit row to zero in expected and worst, with the weakest certainty", () => {
  const preview = aggregatePreview(graph(), stepPreviews(), PRICES, AT, { stage: "plan", warnings: ["Step 2 was simulated with funds Relay delivers."] });
  assert.equal(preview.spec, PREVIEW_SPEC);
  assert.equal(preview.intentId, "int_3f9a0000000000000000000000000000");
  assert.equal(preview.basis, "simulated");
  assert.deepEqual(
    preview.rows.map((row) => [row.network, row.symbol, row.role, row.expected.amount, row.worst.amount, row.certainty]),
    [
      ["base", "USDC", "you", "-100000000", "-100000000", "simulated"],
      ["base", "ETH", "you", "-627968980908", "-627968980908", "simulated"],
      ["arbitrum", "ETH", "you", "-8000000000000", "-8000000000000", "simulated-assumed-funds"],
      ["arbitrum", "bbqUSDC", "you", "95477308837200000000", "94904922370720000000", "estimated"],
      ["arbitrum", "USDC", "transit", "0", "0", "venue-minimum"],
    ],
  );
  const transit = preview.rows.at(-1);
  assert.deepEqual(transit.steps, ["s1", "s2"]);
  assert.equal(preview.rows[3].listed, false);
  assert.equal(preview.rows[0].listed, true);
  assert.equal(preview.rows[0].expected.formatted, "-100");
  assert.equal(preview.rows[3].expected.formatted, "+95.4773");
  assert.equal(preview.rows[1].expected.formatted, "-0.000000627968");
  assert.deepEqual(preview.arrival, { network: "arbitrum", seconds: 16 });
  assert.equal(preview.approvals.length, 2);
  assert.deepEqual(preview.warnings, ["Step 2 was simulated with funds Relay delivers."]);
  const totals = preview.totals;
  assert.equal(totals.youPayUsd, 100.02);
  assert.equal(totals.youGetUsd.expected, 99.96);
  assert.equal(totals.youGetUsd.worst, 99.37);
  assert.deepEqual(totals.paidToOthersUsd, { expected: 0, worst: 0 });
  assert.equal(totals.networkFeesUsd, 0.02);
  assert.equal(totals.venueFeesUsd, 0.03);
  assert.equal(totals.extraCostsUsd, 0);
  assert.equal(totals.costUsd.expected, 0.06, "100.0216 − 99.9647");
  assert.equal(totals.costUsd.worst, 0.66, "100.0216 − 99.3655");
  assert.equal(totals.priceDifferenceUsd, 0, "0.0568 − 0.0216 network − 0.0342 venue");
  assert.deepEqual(totals.unpriced, []);
  assert.match(preview.digest, /^sha256:[0-9a-f]{64}$/u);
});

test("aggregatePreview: deducted venue fees are fee lines only (never double counted in You pay)", () => {
  const withoutVenue = stepPreviews();
  withoutVenue[0].fees = withoutVenue[0].fees.filter((fee) => fee.kind !== "venue");
  const a = aggregatePreview(graph(), stepPreviews(), PRICES, AT);
  const b = aggregatePreview(graph(), withoutVenue, PRICES, AT);
  assert.equal(a.totals.youPayUsd, b.totals.youPayUsd);
  assert.equal(a.totals.costUsd.expected, b.totals.costUsd.expected);
  assert.equal(b.totals.venueFeesUsd, 0);
  assert.equal(a.digest, b.digest, "fee estimates are not part of the digest");
});

test("aggregatePreview: unpriced assets make the totals that need them null and are listed", () => {
  const prices = { ...PRICES };
  delete prices[BBQ];
  const preview = aggregatePreview(graph(), stepPreviews(), prices, AT);
  assert.equal(preview.totals.youGetUsd.expected, null);
  assert.equal(preview.totals.costUsd.expected, null);
  assert.equal(preview.totals.priceDifferenceUsd, null);
  assert.equal(preview.totals.youPayUsd, 100.02, "debits are still priced");
  assert.deepEqual(preview.totals.unpriced, [BBQ]);
  assert.equal(preview.rows[3].expected.usd, undefined);
  const fn = aggregatePreview(graph(), stepPreviews(), (asset) => PRICES[asset] ?? null, AT);
  assert.equal(fn.totals.youPayUsd, 100.02, "prices may be a function");
});

test("aggregatePreview: payments to own accounts become rows; third-party payments stay payments; Solana and EVM rows are separate", () => {
  const g = graph({ request: { accounts: [BASE, SOL] } });
  const previews = [
    {
      stepId: "s1", network: "base", kind: "bridge", status: "simulated", at: AT,
      deltas: [delta("base", BASE, USDC_BASE, "USDC", 6, -25_157_732, -25_157_732, "simulated")],
      payments: [
        { stepId: "s1", network: "arbitrum", recipient: "eip155:42161:0x1111111111111111111111111111111111111111", recipientName: "acme.base.eth", asset: USDC_ARB, symbol: "USDC", decimals: 6, expected: amount(25_130_724), worst: amount(25_005_071), certainty: "venue-minimum" },
        { stepId: "s1", network: "arbitrum", recipient: ARB.toUpperCase().replace("EIP155", "eip155").replace("0X", "0x"), asset: USDC_ARB, symbol: "USDC", decimals: 6, expected: amount(100), worst: amount(0), certainty: "estimated" },
      ],
      fees: [], approvals: [], issues: [],
    },
    {
      stepId: "s2", network: "solana", kind: "swap", status: "quoted", at: AT,
      deltas: [delta("solana", SOL, SOL_NATIVE, "SOL", 9, -5_000, -5_000, "quoted")],
      payments: [], fees: [], approvals: [], issues: [],
    },
  ];
  const preview = aggregatePreview(g, previews, PRICES, AT);
  assert.equal(preview.basis, "partial");
  assert.equal(preview.payments.length, 1);
  assert.equal(preview.payments[0].recipientName, "acme.base.eth");
  assert.equal(preview.payments[0].worst.usd, 25.005071);
  assert.deepEqual(preview.rows.map((row) => `${row.network}:${row.symbol}:${row.role}:${row.certainty}`), ["base:USDC:you:simulated", "solana:SOL:you:quoted", "arbitrum:USDC:you:estimated"]);
  assert.equal(preview.totals.paidToOthersUsd.worst, 25.01);
  const quotedOnly = aggregatePreview(g, [previews[1]], PRICES, AT);
  assert.equal(quotedOnly.basis, "quoted");
  assert.equal(aggregatePreview(g, [], PRICES, AT).basis, "unavailable");
  assert.deepEqual(CERTAINTY_ORDER, ["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"]);
});

test("previewDigest: stable across key order, USD, times and fees; changes with an amount, a recipient or an approval; fixed vector", async () => {
  const preview = aggregatePreview(graph(), stepPreviews(), PRICES, AT);
  assert.equal(await previewDigest(preview), preview.digest);
  const later = aggregatePreview(graph(), stepPreviews(), { ...PRICES, [ETH_BASE]: 2600 }, "2026-10-09T14:00:00Z", { stage: "refresh" });
  assert.equal(later.digest, preview.digest);
  const reordered = { ...preview, rows: [...preview.rows].reverse(), approvals: [...preview.approvals].reverse() };
  assert.equal(await previewDigest(reordered), preview.digest);
  const recased = { ...preview, rows: preview.rows.map((row) => ({ ...row, account: row.account.toUpperCase().replace("EIP155", "eip155").replace("0X", "0x") })) };
  assert.equal(await previewDigest(recased), preview.digest, "EVM address case does not matter");
  // Independent recomputation of the formula.
  const independent = `sha256:${createHash("sha256").update(canonicalJson(previewDigestInput(preview))).digest("hex")}`;
  assert.equal(preview.digest, independent);
  const changed = stepPreviews();
  changed[1].deltas[2] = delta("arbitrum", ARB, BBQ, "bbqUSDC", 18, 95477308837200000000n, 94904922370720000001n, "estimated");
  assert.notEqual(aggregatePreview(graph(), changed, PRICES, AT).digest, preview.digest);
  const approval = stepPreviews();
  approval[0].approvals[0] = { ...approval[0].approvals[0], amount: "100000001" };
  assert.notEqual(aggregatePreview(graph(), approval, PRICES, AT).digest, preview.digest);
});

test("previewDigest fixed vector", async () => {
  const fixed = {
    spec: PREVIEW_SPEC,
    intentId: "int_vector",
    rows: [{ network: "base", account: BASE, asset: USDC_BASE, expected: { amount: "-1" }, worst: { amount: "-2" } }],
    payments: [{ network: "base", recipient: "eip155:8453:0x1111111111111111111111111111111111111111", asset: USDC_BASE, expected: { amount: "1" }, worst: { amount: "1" } }],
    approvals: [{ network: "base", token: { asset: USDC_BASE }, spender: "0xABCDEF0000000000000000000000000000000001", amount: "2" }],
  };
  const expectedInput =
    '{"approvals":[["base","eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","0xabcdef0000000000000000000000000000000001","2"]],"intentId":"int_vector",' +
    '"payments":[["base","eip155:8453:0x1111111111111111111111111111111111111111","eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","1","1"]],' +
    '"rows":[["base","eip155:8453:0x5eed00000000000000000000000000000000c0de","eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","-1","-2"]],"spec":"kletia.preview/v1"}';
  assert.equal(canonicalJson(previewDigestInput(fixed)), expectedInput);
  assert.equal(await previewDigest(fixed), `sha256:${createHash("sha256").update(expectedInput).digest("hex")}`);
});

/* ------------------------------------------------------------------ material change */

function simple({ rows = [], payments = [], approvals = [], network = 0.1, extra = 0 } = {}) {
  return {
    spec: PREVIEW_SPEC, intentId: "int_x", computedAt: AT, stage: "plan", basis: "simulated", digest: "", steps: [], needs: [], warnings: [], fees: [],
    rows: rows.map(([asset, expected, worst]) => ({ network: "base", account: BASE, asset, symbol: "TKN", decimals: 6, listed: true, expected: { amount: String(expected), formatted: "" }, worst: { amount: String(worst), formatted: "" }, certainty: "simulated", steps: ["s1"], role: "you" })),
    payments: payments.map(([recipient, worst]) => ({ stepId: "s1", network: "base", recipient, asset: USDC_BASE, symbol: "USDC", decimals: 6, expected: { amount: String(worst), formatted: "" }, worst: { amount: String(worst), formatted: "" }, certainty: "simulated" })),
    approvals: approvals.map(([spender, value]) => ({ stepId: "s1", network: "base", token: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, spender, spenderLabel: "Venue", amount: String(value), formatted: "", leftAfter: "0" })),
    totals: { youPayUsd: 1, youGetUsd: { expected: 1, worst: 1 }, paidToOthersUsd: { expected: 0, worst: 0 }, networkFeesUsd: network, venueFeesUsd: 0, extraCostsUsd: extra, costUsd: { expected: 0, worst: 0 }, priceDifferenceUsd: 0, unpriced: [] },
  };
}
const issueCodes = (before, after) => materialChange(before, after).map((issue) => issue.code);

test("materialChange rule 1: a new debit row", () => {
  assert.deepEqual(issueCodes(simple({ rows: [[USDC_BASE, -10, -10]] }), simple({ rows: [[USDC_BASE, -10, -10], [ETH_BASE, -1, -1]] })), [PREVIEW_CHANGE_CODES.newDebit]);
  assert.deepEqual(issueCodes(simple(), simple({ rows: [[ETH_BASE, 5, 5]] })), [], "a new credit is not worse");
});

test("materialChange rule 2: worse by more than max(1 unit, 10 bps); boundaries at ±1 unit and 10 bps", () => {
  const before = simple({ rows: [[USDC_BASE, 1_000_000, 1_000_000]] });
  assert.deepEqual(issueCodes(before, simple({ rows: [[USDC_BASE, 1_000_000, 999_000]] })), [], "exactly 10 bps lower");
  assert.deepEqual(issueCodes(before, simple({ rows: [[USDC_BASE, 1_000_000, 998_999]] })), [PREVIEW_CHANGE_CODES.worseAmount], "10 bps + 1 unit lower");
  const small = simple({ rows: [[USDC_BASE, 100, 100]] });
  assert.deepEqual(issueCodes(small, simple({ rows: [[USDC_BASE, 100, 99]] })), [], "1 unit tolerated");
  assert.deepEqual(issueCodes(small, simple({ rows: [[USDC_BASE, 100, 98]] })), [PREVIEW_CHANGE_CODES.worseAmount], "2 units on a tiny amount");
  const debit = simple({ rows: [[USDC_BASE, -1_000_000, -1_000_000]] });
  assert.deepEqual(issueCodes(debit, simple({ rows: [[USDC_BASE, -1_002_000, -1_002_000]] })), [PREVIEW_CHANGE_CODES.worseAmount], "a larger debit");
  assert.deepEqual(issueCodes(debit, simple({ rows: [[USDC_BASE, -990_000, -990_000]] })), [], "a smaller debit is better");
  assert.deepEqual(issueCodes(before, simple()), [PREVIEW_CHANGE_CODES.worseAmount], "a guaranteed credit that disappears");
});

test("materialChange rule 3: another recipient, or a payment lower by more than 10 bps", () => {
  const alice = "eip155:8453:0x1111111111111111111111111111111111111111";
  const mallory = "eip155:8453:0x9999999999999999999999999999999999999999";
  const before = simple({ payments: [[alice, 1_000_000]] });
  assert.deepEqual(issueCodes(before, simple({ payments: [[mallory, 1_000_000]] })), [PREVIEW_CHANGE_CODES.recipientChanged]);
  assert.deepEqual(issueCodes(before, simple({ payments: [[alice.replace("0x1111111111111111111111111111111111111111", "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x")), 1_000_000]] })), []);
  assert.deepEqual(issueCodes(before, simple({ payments: [[alice, 999_000]] })), [], "exactly 10 bps");
  assert.deepEqual(issueCodes(before, simple({ payments: [[alice, 998_999]] })), [PREVIEW_CHANGE_CODES.paymentLower]);
});

test("materialChange rule 4: an approval appears or grows", () => {
  const before = simple({ approvals: [["0xspender", 100]] });
  assert.deepEqual(issueCodes(before, simple({ approvals: [["0xspender", 100]] })), []);
  assert.deepEqual(issueCodes(before, simple({ approvals: [["0xspender", 101]] })), [PREVIEW_CHANGE_CODES.approvalGrew]);
  assert.deepEqual(issueCodes(before, simple({ approvals: [["0xspender", 100], ["0xother", 1]] })), [PREVIEW_CHANGE_CODES.approvalGrew]);
  assert.deepEqual(issueCodes(before, simple({ approvals: [["0xspender", 50]] })), []);
});

test("materialChange rule 5: network + extra fees up by more than max(5 %, $0.05), only when both are priced", () => {
  assert.deepEqual(issueCodes(simple({ network: 0.1 }), simple({ network: 0.15 })), [], "+$0.05 exactly");
  assert.deepEqual(issueCodes(simple({ network: 0.1 }), simple({ network: 0.16 })), [PREVIEW_CHANGE_CODES.feesUp]);
  assert.deepEqual(issueCodes(simple({ network: 10 }), simple({ network: 10.5 })), [], "+5 % exactly");
  assert.deepEqual(issueCodes(simple({ network: 10 }), simple({ network: 10.51 })), [PREVIEW_CHANGE_CODES.feesUp]);
  assert.deepEqual(issueCodes(simple({ network: 0.1, extra: 0 }), simple({ network: 0.1, extra: 1 })), [PREVIEW_CHANGE_CODES.feesUp]);
  assert.deepEqual(issueCodes(simple({ network: null }), simple({ network: 99 })), [], "unpriced fees skip rule 5");
  assert.ok(materialChange(simple({ network: 0.1 }), simple({ network: 0.16 })).every((issue) => issue.severity === "block"));
});

test("validatePreviewAck accepts an absent or empty body and a digest; refuses anything else", () => {
  assert.deepEqual(validatePreviewAck(undefined), { ok: true, value: {} });
  assert.deepEqual(validatePreviewAck({}), { ok: true, value: {} });
  const digest = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(validatePreviewAck({ acknowledgedPreview: digest }), { ok: true, value: { acknowledgedPreview: digest } });
  assert.equal(validatePreviewAck({ acknowledgedPreview: "sha256:XYZ" }).ok, false);
  assert.equal(validatePreviewAck({ acknowledgedPreview: digest, extra: 1 }).ok, false);
  assert.equal(validatePreviewAck([]).ok, false);
  assert.equal(PREVIEW_WARNING_CODES.unavailable, "PREVIEW_UNAVAILABLE");
});

test("formatPreviewAmount: signed, six significant digits, truncated toward zero", () => {
  assert.equal(formatPreviewAmount(0n, 6), "0");
  assert.equal(formatPreviewAmount(-100_000_000n, 6), "-100");
  assert.equal(formatPreviewAmount(95477308837200000000n, 18), "+95.4773");
  assert.equal(formatPreviewAmount(1_234_567_890n, 0), "+1234567890");
  assert.equal(formatPreviewAmount(-1n, 18), "-0.000000000000000001");
});
