import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_REVIEW_NOTICE, previewDigest } from "@kletia/core";
import { KletiaClient } from "@kletia/sdk";
import {
  approvalHref,
  blockingIssuesFor,
  cleanText,
  contractReviewModel,
  fareChangeLines,
  fareModel,
  formatUsdAbs,
  isContractStep,
  policyHold,
  policyOutcome,
  RECEIPT_SHARE_GROUPS,
  RECEIPT_SHARE_PROFILES,
  receiptApplies,
  receiptGroupsLabel,
  receiptPendingText,
  receiptShareHref,
} from "../dist/review.js";
import { createIntentSession } from "../dist/hooks/index.js";

const BASE = "eip155:8453:0x5eed00000000000000000000000000000000c0de";
const ARB = "eip155:42161:0x5eed00000000000000000000000000000000c0de";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_BASE = "eip155:8453/slip44:60";
const ETH_ARB = "eip155:42161/slip44:60";
const VAULT = "eip155:42161/erc20:0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA";

const amount = (units, formatted, usd) => ({ amount: units, formatted, ...(usd === undefined ? {} : { usd }) });
const row = (network, account, asset, symbol, decimals, expected, worst, certainty, steps, role = "you", listed = true) => ({
  network, account, asset, symbol, decimals, listed, expected, worst, certainty, steps, role,
});

/** The design's example: bridge 100 USDC Base → Arbitrum (Relay), then deposit into a custom vault. */
function designPreview(overrides = {}) {
  return {
    spec: "kletia.preview/v1",
    intentId: "int_3f9a0000000000000000000000000000",
    computedAt: "2026-10-09T13:40:12.418Z",
    stage: "plan",
    basis: "partial",
    digest: "sha256:" + "5b".repeat(32),
    rows: [
      row("base", BASE, USDC_BASE, "USDC", 6, amount("-100000000", "-100", -100), amount("-100000000", "-100", -100), "simulated", ["s1"]),
      row("base", BASE, ETH_BASE, "ETH", 18, amount("-627968980908", "-0.000000627969", -0.0016), amount("-627968980908", "-0.000000627969", -0.0016), "simulated", ["s1"]),
      row("arbitrum", ARB, ETH_ARB, "ETH", 18, amount("-8000000000000", "-0.000008", -0.02), amount("-8000000000000", "-0.000008", -0.02), "simulated-assumed-funds", ["s2"]),
      row("arbitrum", ARB, VAULT, "bbqUSDC", 18, amount("95477308837200000000", "+95.4773", 99.97), amount("94904922370720000000", "+94.9049", 99.37), "estimated", ["s2"], "you", false),
      row("arbitrum", ARB, USDC_ARB, "USDC", 6, amount("0", "0"), amount("0", "0"), "venue-minimum", ["s1", "s2"], "transit"),
    ],
    payments: [],
    fees: [
      { stepId: "s1", network: "base", kind: "network", label: "Base network fee", usd: 0.0016, paid: "on-top", certainty: "simulated" },
      { stepId: "s1", network: "base", kind: "l1-data", label: "Base L1 data fee", usd: 0.00001, paid: "on-top", certainty: "simulated" },
      { stepId: "s1", network: "base", kind: "venue", label: "Relay relayer fee", formatted: "0.034228", asset: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, usd: 0.03, paid: "deducted", certainty: "quoted" },
      { stepId: "s2", network: "arbitrum", kind: "network", label: "Arbitrum network fee", usd: 0.02, paid: "on-top", certainty: "simulated-assumed-funds" },
    ],
    approvals: [
      { stepId: "s1", network: "base", token: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31", spenderLabel: "Relay depository", amount: "100000000", formatted: "100", leftAfter: "0" },
      { stepId: "s2", network: "arbitrum", token: { asset: USDC_ARB, symbol: "USDC", decimals: 6 }, spender: "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA", spenderLabel: "Acme Yield (custom contract)", amount: "99465943", formatted: "99.465943", leftAfter: "1500000" },
    ],
    steps: [
      {
        stepId: "s1", network: "base", kind: "bridge", status: "simulated", at: "2026-10-09T13:40:12.418Z",
        deltas: [row("arbitrum", ARB, USDC_ARB, "USDC", 6, amount("99965772", "+99.965772"), amount("99465943", "+99.465943"), "venue-minimum", ["s1"])],
        payments: [], fees: [], approvals: [], issues: [],
      },
      {
        stepId: "s2", network: "arbitrum", kind: "call", status: "simulated-assumed-funds", at: "2026-10-09T13:40:12.418Z",
        deltas: [], payments: [], fees: [], approvals: [],
        issues: [
          { code: "PREVIEW_GAS_ON_ARRIVAL", severity: "warn", message: "You hold no ETH on Arbitrum to sign step 2." },
          { code: "PREVIEW_STEP_QUOTED", severity: "warn", message: "Step 2 is ‮evil‬ quoted." },
        ],
      },
    ],
    totals: {
      youPayUsd: 100.02, youGetUsd: { expected: 99.97, worst: 99.37 }, paidToOthersUsd: { expected: 0, worst: 0 },
      networkFeesUsd: 0.02, venueFeesUsd: 0.03, extraCostsUsd: 0, costUsd: { expected: 0.05, worst: 0.65 }, priceDifferenceUsd: 0, unpriced: [],
    },
    arrival: { network: "arbitrum", seconds: 16 },
    needs: [{ network: "arbitrum", account: ARB, asset: { asset: ETH_ARB, symbol: "ETH", decimals: 18 }, amount: "8000000000000", formatted: "0.000008", reason: "gas-on-arrival", have: "0" }],
    warnings: ["Step 2 was simulated with 99.465943 USDC that Relay delivers to you on Arbitrum; it will be simulated again before you sign it."],
    ...overrides,
  };
}

const graph = { steps: [{ id: "s1", index: 0 }, { id: "s2", index: 1 }] };

test("fareModel: you pay, you get with at least, transit collapsed, fees in USD, gas on arrival", () => {
  const fare = fareModel(designPreview(), graph);
  assert.equal(fare.legs, 2);
  assert.equal(fare.networkChanges, 1);
  assert.deepEqual(fare.youPay.map((r) => `${r.networkName}:${r.expected.amount} ${r.expected.symbol}:${r.expected.usd}:${r.note}`), [
    "Base:100 USDC:$100.00:null",
    "Base:0.000000627969 ETH:<$0.01:network fee, leg 1",
    "Arbitrum One:0.000008 ETH:$0.02:network fee, leg 2",
  ]);
  assert.equal(fare.youPay[2].expected.certainty, "simulated-assumed-funds");
  const vault = fare.youGet[0];
  assert.equal(vault.expected.amount, "95.4773");
  assert.equal(vault.bound.amount, "94.9049");
  assert.equal(vault.bound.usd, "$99.37");
  assert.equal(vault.expected.certainty, "estimated");
  assert.equal(vault.unlisted, true);
  assert.equal(fare.passesThrough.length, 1, "transit rows are collapsed");
  assert.equal(fare.passesThrough[0].text, "99.465943 to 99.965772 USDC");
  assert.equal(fare.passesThrough[0].legs, "legs 1, 2");
  assert.deepEqual(fare.fees.map((f) => `${f.label}=${f.usd}`), ["Base network fee=<$0.01", "Arbitrum One network fee=$0.02", "Relay relayer fee=$0.03"]);
  assert.match(fare.fees[2].detail, /already in the amount you get/u);
  assert.equal(fare.allowances[0].left, "0 left");
  assert.equal(fare.allowances[1].left, "1.5 USDC left");
  assert.equal(fare.allowances[1].leftover, true);
  assert.equal(fare.bring.length, 1);
  assert.match(fare.bring[0].text, /About 0\.000008 ETH on Arbitrum One to pay network fees/u);
  assert.equal(fare.bring[0].have, "0 ETH");
  assert.equal(fare.arrival, "On Arbitrum One in about 16 s");
  assert.equal(fare.basisNote !== null, true);
  // The gas-on-arrival issue is shown as a need, not twice; direction overrides are stripped.
  assert.equal(fare.warnings.some((w) => /no ETH on Arbitrum/u.test(w)), false);
  assert.equal(fare.warnings.some((w) => /‮/u.test(w)), false);
  assert.deepEqual(fare.legend, ["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"]);
  assert.equal(fare.totals.youGetAtLeast, "$99.37");
});

test("fareModel: coded intent warnings print their sentence once; codes the fare already shows are dropped", () => {
  const fare = fareModel(
    designPreview({
      warnings: [
        "Step 2 was simulated with 99.465943 USDC that Relay delivers to you on Arbitrum; it will be simulated again before you sign it.",
        "PREVIEW_GAS_ON_ARRIVAL: you need about 0.000008 ETH on Arbitrum One to sign step 2.",
        "PREVIEW_UNPRICED: no price for 1 asset(s); totals that need them are null.",
        "PREVIEW_SOMETHING_NEW: the venue changed its route.",
      ],
    }),
    graph,
  );
  assert.deepEqual(fare.warnings.filter((w) => !/^Step 2 is/u.test(w)), [
    "Step 2 was simulated with 99.465943 USDC that Relay delivers to you on Arbitrum; it will be simulated again before you sign it.",
    "The venue changed its route.",
  ]);
  assert.equal(fare.warnings.some((w) => /PREVIEW_|null/u.test(w)), false);
  assert.equal(fare.bring.length, 1, "gas on arrival stays under Bring");
});

test("fareModel: EVM recipients print in full, checksummed (EIP-55)", () => {
  const fare = fareModel(
    designPreview({
      payments: [{ stepId: "s1", network: "base", recipient: "eip155:8453:0x2211d1d0020daea8039e46cf1367962070d77da9", asset: USDC_BASE, symbol: "USDC", decimals: 6, expected: amount("25000000", "+25"), worst: amount("25000000", "+25"), certainty: "quoted" }],
    }),
    graph,
  );
  assert.equal(fare.paidToOthers[0].recipient, "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9");
});

test("fareModel: unpriced amounts are never $0, payments keep the full address, blocking issues surface", () => {
  const recipient = "eip155:8453:0x1111111111111111111111111111111111111111";
  const preview = designPreview({
    rows: [row("base", BASE, USDC_BASE, "USDC", 6, amount("-5000000", "-5"), amount("-5000000", "-5"), "simulated", ["s1"])],
    payments: [{ stepId: "s1", network: "base", recipient, recipientName: "acme.base.eth", asset: USDC_BASE, symbol: "USDC", decimals: 6, expected: amount("5000000", "+5"), worst: amount("4990000", "+4.99"), certainty: "simulated" }],
    totals: { ...designPreview().totals, unpriced: [USDC_BASE] },
    steps: [{ stepId: "s1", network: "base", kind: "transfer", status: "simulated", at: "x", deltas: [], payments: [], fees: [], approvals: [], issues: [{ code: "SIMULATION_ASSET_CHANGE_REFUSED", severity: "block", message: "Another token leaves you." }] }],
  });
  const fare = fareModel(preview, graph);
  assert.equal(fare.youPay[0].expected.usd, null);
  assert.deepEqual(fare.unpriced, ["USDC"]);
  assert.equal(fare.paidToOthers[0].recipient, "0x1111111111111111111111111111111111111111");
  assert.equal(fare.paidToOthers[0].recipientName, "acme.base.eth");
  assert.equal(fare.paidToOthers[0].atLeast.amount, "4.99");
  assert.equal(fare.blocking.length, 1);
  assert.equal(blockingIssuesFor("s1", null, preview).length, 1);
  assert.equal(blockingIssuesFor("s2", null, preview).length, 0);
  assert.equal(blockingIssuesFor("s1", { stepId: "s1", issues: [{ code: "X", severity: "block", message: "m" }] }).length, 1);
});

test("formatting helpers", () => {
  assert.equal(formatUsdAbs(-1234.5), "$1,234.50");
  assert.equal(formatUsdAbs(0.004), "<$0.01");
  assert.equal(formatUsdAbs(0), "$0.00");
  assert.equal(formatUsdAbs(undefined), null);
  assert.equal(cleanText("Acme‮ moc.evil‬  Yield\u0000", 80), "Acme moc.evil Yield");
  assert.equal(cleanText("x".repeat(300), 10).length, 10);
  assert.deepEqual(fareChangeLines([{ code: "A", severity: "block", message: "less" }, { code: "B", severity: "block", message: "less" }]), ["less"]);
});

const review = (overrides = {}) => ({
  kind: "evm-call",
  integrator: { name: "Acme <b>Yield</b>", website: "https://acme.example/app", domainVerified: true },
  notices: [CONTRACT_REVIEW_NOTICE, "Acme pays the gas rebate."],
  contract: {
    network: "arbitrum", address: "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA", explorerUrl: "https://arbiscan.io/address/0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA",
    source: "exact_match", proxy: { kind: "eip1967", implementation: "0x9999999999999999999999999999999999999999", implementationSource: "match" }, registeredAt: "2026-10-09T00:00:00Z", revision: 2,
  },
  call: {
    label: "Deposit into Acme vault", function: "deposit(uint256 assets, address receiver)",
    args: [
      { name: "assets", type: "uint256", display: "99.465943 USDC", source: "previousOutput" },
      { name: "receiver", type: "address", display: "0x5eed…c0de", source: "account" },
      { name: "referral", type: "uint16", display: "7", source: "literal" },
    ],
  },
  approvals: [{ token: { asset: USDC_ARB, symbol: "USDC", decimals: 6 }, spender: "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA", amount: { asset: USDC_ARB, symbol: "USDC", decimals: 6, amount: "99465943", formatted: "99.465943" } }],
  simulation: { status: "ok", at: "x", block: "398112004", assetChanges: [{ asset: USDC_ARB, symbol: "USDC", decimals: 6, listed: true, delta: "-99465943", formatted: "-99.465943" }, { asset: VAULT, symbol: "bbqUSDC", decimals: 18, listed: false, delta: "94904922370720000000", formatted: "+94.9049" }], warnings: [] },
  ...overrides,
});

test("contractReviewModel: who, what, permissions, result, provenance and the fixed notice", () => {
  const model = contractReviewModel(review());
  assert.equal(model.integrator.name, "Acme <b>Yield</b>", "names stay text (React escapes them)");
  assert.equal(model.integrator.website, "https://acme.example/app");
  assert.equal(model.integrator.domain, "acme.example");
  assert.equal(model.call.args[0].source, "the previous leg's output");
  assert.equal(model.call.args[1].source, "your address");
  assert.equal(model.call.args[2].source, "fixed by Acme <b>Yield</b>");
  assert.equal(model.permissions[0].text, "Allow Acme <b>Yield</b>'s contract to spend exactly 99.465943 USDC");
  assert.deepEqual(model.result.changes.map((c) => c.text), ["−99.465943 USDC", "+94.9049 bbqUSDC"]);
  assert.equal(model.result.where, "block 398112004");
  assert.equal(model.contract.proxy.kind, "EIP-1967 proxy");
  assert.equal(model.contract.proxy.verified, true);
  assert.equal(model.notices[0], CONTRACT_REVIEW_NOTICE);
  assert.equal(model.notices.length, 2);
  assert.equal(model.needsAcknowledgement, false);
});

test("contractReviewModel: unverified source or domain needs an acknowledgement; non-https links are dropped", () => {
  const model = contractReviewModel(
    review({
      integrator: { name: "Acme", website: "javascript:alert(1)", domainVerified: false },
      notices: ["Something else first"],
      contract: { ...review().contract, source: "unverified", explorerUrl: "http://arbiscan.io/x", proxy: undefined },
    }),
  );
  assert.equal(model.integrator.website, null);
  assert.equal(model.contract.explorerUrl, null);
  assert.equal(model.notices[0], CONTRACT_REVIEW_NOTICE, "the fixed notice always comes first");
  assert.equal(model.needsAcknowledgement, true);
  assert.equal(model.acknowledgementReasons.length, 2);
  const solana = contractReviewModel({
    kind: "solana-action", integrator: { name: "Blinky", domainVerified: true }, notices: [], approvals: [],
    action: { url: "https://blinky.example/api/stake", domain: "blinky.example", title: "Stake", instructionCount: 3, programs: [{ id: "Prog1111111111111111111111111111111111111", verified: null, upgradeable: true, upgradeAuthority: "Auth111111111111111111111111111111111111" }] },
    simulation: { status: "ok", at: "x", slot: "1", assetChanges: [], warnings: [] },
  });
  assert.equal(solana.action.url, "https://blinky.example/api/stake");
  assert.equal(solana.needsAcknowledgement, true, "an unverified program build needs an acknowledgement");
  assert.match(solana.action.programs[0].upgradeable, /^Upgradeable by Auth11…1111$/u);
  assert.equal(isContractStep({ kind: "call" }), true);
  assert.equal(isContractStep({ kind: "swap", protocol: "jupiter" }), false);
});

const APPROVAL = `apr_${"a".repeat(32)}`;

test("policy outcomes: holds and refusals carry rule ids and only safe approval links", () => {
  const hold = policyHold({
    policy: { decisionId: "pdc_x", outcome: "confirm", keyId: "key_x", chain: [], notionalUsd: "5200.00", evaluatedAt: "x",
      approval: { id: APPROVAL, url: `https://kletiaai.xyz/approve#${APPROVAL}`, expiresAt: "2026-10-09T13:52:10Z", ceilingUsd: "5304.00", triggers: ["confirm.aboveUsd"] } },
  });
  assert.equal(hold.kind, "held");
  assert.equal(hold.approval.href, `https://kletiaai.xyz/approve#${APPROVAL}`);
  assert.equal(hold.approval.ceilingUsd, "$5,304.00");
  assert.deepEqual(hold.rules.map((r) => r.rule), ["confirm.aboveUsd"]);
  assert.equal(policyHold({ policy: { outcome: "allow" } }), null);

  assert.equal(approvalHref({ id: APPROVAL, url: "javascript:alert(1)" }), null);
  assert.equal(approvalHref({ id: APPROVAL, url: `https://evil.example/phish#${APPROVAL}` }), null);
  assert.equal(approvalHref({ id: APPROVAL, url: `https://kletiaai.xyz/approve#apr_${"b".repeat(32)}` }), null);
  assert.equal(approvalHref({ id: APPROVAL, url: `http://127.0.0.1:5173/approve#${APPROVAL}` }, { fallbackOrigin: "http://127.0.0.1:5173" }), `http://127.0.0.1:5173/approve#${APPROVAL}`);
  assert.equal(approvalHref({ id: "apr_bad", url: "https://kletiaai.xyz/approve#apr_bad" }), null);

  const refused = policyOutcome({
    code: "POLICY_VIOLATION", message: "server text",
    policy: { decisionId: "pdc_1", stage: "plan", outcome: "deny", keyId: "key_1", retryAt: null, violations: [{ rule: "recipients.mode", scope: "key", message: "Recipient not allowed.", observed: "0xabc", limit: "allowlist" }] },
  });
  assert.equal(refused.kind, "refused");
  assert.equal(refused.rules[0].rule, "recipients.mode");
  assert.equal(refused.rules[0].detail, "observed 0xabc, limit allowlist");
  const required = policyOutcome({ code: "POLICY_APPROVAL_REQUIRED", policy: { violations: [], approval: { id: APPROVAL, url: `https://kletiaai.xyz/approve#${APPROVAL}`, expiresAt: "x" } } });
  assert.equal(required.kind, "held");
  assert.equal(required.approval.href, `https://kletiaai.xyz/approve#${APPROVAL}`);
  assert.equal(policyOutcome({ code: "QUOTE_MOVED" }), null);
});

test("receipt links: https share URLs of the right shape only", () => {
  const share = { id: `rsh_${"c".repeat(24)}`, receiptId: `rcpt_${"d".repeat(32)}` };
  const key = "A".repeat(43);
  const good = `https://kletiaai.xyz/r/${share.receiptId}#s=${share.id}&k=${key}`;
  assert.equal(receiptShareHref({ ...share, url: good }), good);
  assert.equal(receiptShareHref({ ...share, url: `https://evil.example/x#s=${share.id}&k=${key}` }), null);
  assert.equal(receiptShareHref({ ...share, url: `https://kletiaai.xyz/r/${share.receiptId}?x=1#s=${share.id}&k=${key}` }), null);
  assert.equal(receiptShareHref({ ...share, url: `http://localhost:5173/r/${share.receiptId}#s=${share.id}&k=${key}` }), null);
  assert.equal(
    receiptShareHref({ ...share, url: `http://localhost:5173/r/${share.receiptId}#s=${share.id}&k=${key}` }, { fallbackOrigin: "http://127.0.0.1:4174" }),
    `http://127.0.0.1:4174/r/${share.receiptId}#s=${share.id}&k=${key}`,
  );
  assert.equal(receiptApplies("completed"), true);
  assert.equal(receiptApplies("expired"), false);
  assert.equal(RECEIPT_SHARE_PROFILES.find((p) => p.id === "proof").revealsAddresses, true);
});

/* ---------------------------------------------------------- rendering */

async function server(t) {
  try {
    const [{ renderToStaticMarkup }, react, widget] = await Promise.all([import("react-dom/server"), import("react"), import("../dist/index.js")]);
    return { render: (element) => renderToStaticMarkup(element), h: react.createElement, widget };
  } catch {
    t.skip("react-dom is not installed");
    return null;
  }
}

test("FareBreakdown renders every section as text, with certainty labels and the at-least plate", async (t) => {
  const s = await server(t);
  if (!s) return;
  const html = s.render(s.h(s.widget.FareBreakdown, { preview: designPreview(), intent: graph }));
  for (const text of ["You pay", "You get", "Passes through your wallets", "Fees", "You allow", "Bring", "Arrives", "At least", "94.9049 bbqUSDC", "$99.37", "simulated with funds a bridge delivers"]) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.equal(html.includes("‮"), false);
  const changed = s.render(s.h(s.widget.FareBreakdown, { preview: designPreview(), previous: designPreview(), changes: [{ code: "PREVIEW_WORSE_AMOUNT", severity: "block", message: "You get less bbqUSDC." }] }));
  assert.ok(changed.includes("The fare changed since you approved it."));
  assert.ok(changed.includes("<s>"));
  assert.ok(changed.includes("You get less bbqUSDC."));
});

test("ContractReview renders integrator text escaped, https links only and the acknowledgement", async (t) => {
  const s = await server(t);
  if (!s) return;
  const html = s.render(
    s.h(s.widget.ContractReview, {
      review: review({ integrator: { name: "<img src=x onerror=alert(1)>", website: "javascript:alert(1)", domainVerified: false } }),
      acknowledged: false,
      onAcknowledge: () => undefined,
    }),
  );
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(html.includes("javascript:"), false);
  assert.ok(html.includes("Not audited by Kletia"));
  assert.ok(html.includes("Domain not verified"));
  assert.ok(html.includes('type="checkbox"'));
  const hrefs = [...html.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(hrefs.every((href) => href.startsWith("https://")), hrefs.join(" "));
});

test("PolicyNotice prints the rule ids and the approval link", async (t) => {
  const s = await server(t);
  if (!s) return;
  const outcome = policyOutcome({ code: "POLICY_APPROVAL_REQUIRED", policy: { violations: [{ rule: "confirm.aboveUsd", message: "Above $5,000." }], approval: { id: APPROVAL, url: `https://kletiaai.xyz/approve#${APPROVAL}`, expiresAt: "2026-10-09T13:52:10Z", ceilingUsd: "5304.00" } } });
  const html = s.render(s.h(s.widget.PolicyNotice, { outcome }));
  assert.ok(html.includes("confirm.aboveUsd"));
  assert.ok(html.includes(`href="https://kletiaai.xyz/approve#${APPROVAL}"`));
  assert.ok(html.includes("Held"));
});

/* ------------------------------------------------------- session hooks */

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("the intent session keeps the plan preview and opens stored intents with theirs", async () => {
  const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
  const intent = { spec: "kletia.intent/v1", id: "int_" + "e".repeat(32), status: "planned", updatedAt: "x", summary: { title: "Swap" }, steps: [] };
  const preview = designPreview({ intentId: intent.id });
  const digested = { ...preview, digest: await previewDigest(preview) };
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      calls.push(`${init.method} ${pathname}${search}`);
      if (init.method === "POST" && pathname === "/v1/intents") return jsonResponse(201, { intent, preview: digested });
      if (init.method === "GET" && pathname === `/v1/intents/${intent.id}`) return jsonResponse(200, { intent });
      if (init.method === "GET" && pathname === `/v1/intents/${intent.id}/preview`) return jsonResponse(404, { error: { code: "PREVIEW_NOT_FOUND", message: "none" } });
      if (init.method === "POST" && pathname === `/v1/intents/${intent.id}/preview`) return jsonResponse(200, { preview: digested });
      throw new Error(`unexpected ${init.method} ${pathname}`);
    },
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT], preview: true });
  session.attach();
  await session.plan("swap 1 SOL to USDC");
  assert.equal(session.getState().preview.digest, digested.digest);
  assert.ok(calls[0].includes("preview=true"));
  await session.open(intent.id);
  assert.equal(session.getState().intent.id, intent.id);
  assert.equal(session.getState().preview.digest, digested.digest);
  assert.deepEqual(calls.slice(1), [`GET /v1/intents/${intent.id}`, `GET /v1/intents/${intent.id}/preview`, `POST /v1/intents/${intent.id}/preview`]);
});

test("the intent session turns a session into an intent for the configured accounts, with its fare", async () => {
  const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
  const SESSION = `cs_${"9".repeat(32)}`;
  const intent = { spec: "kletia.intent/v1", id: "int_" + "f".repeat(32), status: "planned", updatedAt: "x", summary: { title: "Deposit" }, steps: [] };
  const preview = designPreview({ intentId: intent.id });
  const digested = { ...preview, digest: await previewDigest(preview) };
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ call: `${init.method} ${pathname}`, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === "POST" && pathname === `/v1/sessions/${SESSION}/intents`) return jsonResponse(201, { intent });
      if (init.method === "POST" && pathname === `/v1/intents/${intent.id}/preview`) return jsonResponse(200, { preview: digested });
      if (pathname === `/v1/sessions/cs_${"0".repeat(32)}/intents`) return jsonResponse(403, { error: { code: "SESSION_ORIGIN_FORBIDDEN", message: "Not for this origin." } });
      throw new Error(`unexpected ${init.method} ${pathname}`);
    },
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT], preview: true });
  session.attach();
  const created = await session.startSession(SESSION, { hostOrigin: "https://acme.example", amount: "25" });
  assert.equal(created.id, intent.id);
  assert.equal(session.getState().phase, "planned");
  assert.equal(session.getState().preview.digest, digested.digest);
  assert.deepEqual(calls[0], { call: `POST /v1/sessions/${SESSION}/intents`, body: { accounts: [ACCOUNT], hostOrigin: "https://acme.example", amount: "25" } });
  // Without a page origin (no browser, none given) nothing is sent.
  calls.length = 0;
  assert.equal(await session.startSession(SESSION), null);
  assert.equal(calls.length, 0);
  assert.match(String(session.getState().error?.message), /allowedOrigins/u);
  // The API's refusal is the session's error.
  assert.equal(await session.startSession(`cs_${"0".repeat(32)}`, { hostOrigin: "https://evil.example" }), null);
  assert.equal(session.getState().error?.code, "SESSION_ORIGIN_FORBIDDEN");
  // Without accounts nothing is sent either.
  const empty = createIntentSession(client, { accounts: [] });
  empty.attach();
  calls.length = 0;
  assert.equal(await empty.startSession(SESSION, { hostOrigin: "https://acme.example" }), null);
  assert.equal(calls.length, 0);
});

test("receipt share groups: labels for profiles and custom choices, pending reasons in words", () => {
  assert.equal(receiptGroupsLabel([]), "Route only");
  assert.equal(receiptGroupsLabel(["steps.s1.amounts", "steps.s2.amounts", "intent.outcome"]), "Route and amounts");
  assert.equal(receiptGroupsLabel(["steps.*.amounts", "intent.outcome", "steps.*.evidence", "intent.timing"]), "Proof");
  assert.equal(receiptGroupsLabel(RECEIPT_SHARE_GROUPS.map((group) => group.pattern)), "Everything");
  assert.equal(receiptGroupsLabel(["intent.timing", "steps.s1.evidence"]), "Custom: timing, transactions");
  assert.equal(receiptGroupsLabel(["something.else"]), "Custom");
  // Groups that reveal addresses say so (the share dialog shows the evidence warning for them).
  assert.deepEqual(RECEIPT_SHARE_GROUPS.filter((group) => group.revealsAddresses).map((group) => group.pattern), ["steps.*.evidence", "steps.*.parties", "intent.request"]);
  assert.match(receiptPendingText("awaiting_finality"), /final on-chain/u);
  assert.match(receiptPendingText("rpc_unavailable"), /Public nodes/u);
  assert.equal(receiptPendingText("<script>"), receiptPendingText("awaiting_finality"));
  assert.equal(receiptPendingText(undefined), receiptPendingText("awaiting_finality"));
});

test("ContractReview prints what moved since planning, struck through", async (t) => {
  const s = await server(t);
  if (!s) return;
  const planned = review();
  const prepared = review({
    simulation: { ...planned.simulation, assetChanges: [{ ...planned.simulation.assetChanges[0] }, { ...planned.simulation.assetChanges[1], delta: "89000000000000000000", formatted: "+89" }] },
  });
  const html = s.render(s.h(s.widget.ContractReview, { review: prepared, planned }));
  assert.ok(html.includes("Changed since planning"));
  assert.ok(html.includes("<s>"));
  const same = s.render(s.h(s.widget.ContractReview, { review: planned, planned }));
  assert.equal(same.includes("Changed since planning"), false);
});

test("the widget opens an integrator's intent with its fare, its contract review and the wallet it needs", async (t) => {
  const s = await server(t);
  if (!s) return;
  // Server rendering shows the first paint: the intent is loading, nothing can be executed yet.
  const html = s.render(s.h(s.widget.KletiaIntentWidget, { accounts: [], intentId: `int_${"a".repeat(32)}` }));
  assert.equal(html.includes("<textarea"), false, "no free text when the integrator named the intent");
  assert.ok(/<button[^>]*disabled=""[^>]*>Execute<\/button>/u.test(html), "Execute stays disabled while loading");
  const sessionHtml = s.render(s.h(s.widget.KletiaIntentWidget, { accounts: [], sessionId: `cs_${"b".repeat(32)}` }));
  assert.equal(sessionHtml.includes("<textarea"), false);
});

test("fareModel names the wallet of each row only when several wallets of one kind move money", () => {
  const single = fareModel(designPreview(), graph);
  assert.ok([...single.youPay, ...single.youGet].every((entry) => entry.accountLabel === null), "one EVM wallet on two chains is one wallet");
  const OTHER = "eip155:8453:0x1111111111111111111111111111111111111111";
  const preview = designPreview();
  const two = fareModel(
    { ...preview, rows: [...preview.rows, row("base", OTHER, USDC_BASE, "USDC", 6, amount("-5000000", "-5", -5), amount("-5000000", "-5", -5), "simulated", ["s1"])] },
    graph,
  );
  const labels = two.youPay.map((entry) => entry.accountLabel);
  assert.ok(labels.includes("0x1111…1111"));
  assert.ok(labels.includes("0x5eed…c0de"));
});
