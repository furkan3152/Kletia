/**
 * Journey builder on graphs and previews captured live on 2026-10-14
 * (fixtures/journey/*.json), with hand-written facts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  actionsFromGraph,
  assetIdentity,
  buildJourney,
  continuationRequest,
  JOURNEY_DIGEST_PATTERN,
  journeyDigest,
  openBlockers,
  refundPath,
} from "../dist/index.js";

const AT = "2026-10-14T13:40:00.000Z";
const LATER = "2026-10-14T13:40:09.000Z";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/journey/${name}.json`, import.meta.url), "utf8"));
}

const EMPTY_EVM = "0xde4bd9c9350682d24a10f5a4e4129cc4ba770d5e";
const EMPTY_SOL = "CmScyaDDQjK7wgsCc2GWjWew68ZZLVzFpidArohV58Rw";
const FULL_EVM = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_ETH = "eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_BASE = "eip155:8453/slip44:60";
const ETH_ARB = "eip155:42161/slip44:60";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const JITOSOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

const native = (amount) => ({ amount: String(amount), at: AT });
const fee = (network, asset, amount, certainty = "estimated") => ({ network, asset: { asset, symbol: asset.includes("501") ? "SOL" : "ETH", decimals: asset.includes("501") ? 9 : 18 }, amount: String(amount), certainty });

function facts(overrides = {}) {
  return {
    at: AT,
    reads: "live",
    native: {},
    gasPrice: {},
    solanaRent: { walletLamports: "650240", tokenAccountLamports: "1488440", at: AT },
    tokenAccounts: {},
    prices: {
      [USDC_BASE]: { usd: 1, source: "usd-par", at: AT },
      [USDC_SOL]: { usd: 1, source: "usd-par", at: AT },
      [USDC_ETH]: { usd: 1, source: "usd-par", at: AT },
      [ETH_BASE]: { usd: 2480, source: "jupiter", at: AT },
      [ETH_ARB]: { usd: 2480, source: "jupiter", at: AT },
      [SOL]: { usd: 106, source: "jupiter", at: AT },
      [JITOSOL]: { usd: 133, source: "jupiter", at: AT },
    },
    venues: {},
    policy: null,
    allowances: [],
    fees: {},
    exitFees: {},
    gasOptions: {},
    funding: {},
    ...overrides,
  };
}

/** P2e with enough gas everywhere (no R1). */
function p2Facts(overrides = {}) {
  return facts({
    native: { [`base:${EMPTY_EVM}`]: native(10n ** 16n), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) },
    fees: { s1: fee("solana", SOL, 105_000), s2: fee("base", ETH_BASE, "1649511814328", "simulated-assumed-funds") },
    gasOptions: { s1: { topup: true, gasLeg: null } },
    ...overrides,
  });
}

const stop = (journey, id) => journey.stops.find((entry) => entry.id === id);
const consequence = (journey, id) => journey.consequences.find((entry) => entry.id === id);

test("P2e stops, legs, amounts and now", () => {
  const { graph, preview } = fixture("p2-empty");
  const journey = buildJourney(graph, preview, p2Facts(), AT);
  assert.deepEqual(journey.stops.map((entry) => entry.id), ["start:s1", "transit:s1", "out:s1", "out:s2"]);
  assert.deepEqual(journey.stops.map((entry) => entry.kind), ["start", "transit", "arrival", "end"]);
  const start = stop(journey, "start:s1");
  assert.equal(start.custody, "wallet");
  assert.equal(start.network, "solana");
  assert.equal(start.holdings[0].expected.amount, "100000000");
  assert.equal(start.holdings[0].value.source, "usd-par");
  assert.equal(start.holdings[0].value.expectedUsd, 100);
  const transit = stop(journey, "transit:s1");
  assert.equal(transit.custody, "provider");
  assert.equal(transit.holder.label, "Relay (in transit)");
  const leg1 = journey.legs.find((leg) => leg.id === "s1");
  assert.equal(leg1.refund.mode, "automatic");
  assert.equal(leg1.refund.upTo.amount, "100000000");
  assert.equal(leg1.refund.network, "solana");
  assert.match(leg1.refund.label, /refunds up to 100 USDC to your Solana wallet/u);
  // out:s1 equals the preview's credit row (fare row before netting), spent entirely by s2.
  const arrival = stop(journey, "out:s1");
  assert.equal(arrival.custody, "wallet");
  assert.equal(arrival.network, "base");
  assert.equal(arrival.holdings.length, 1);
  assert.equal(arrival.holdings[0].role, "spent-next");
  assert.deepEqual(arrival.holdings[0].next, { legId: "s2", portionBps: 10_000 });
  assert.equal(arrival.holdings[0].expected.amount, "99956099");
  assert.equal(arrival.holdings[0].atLeast.amount, "99456319");
  assert.equal(arrival.holdings[0].certainty, "venue-minimum");
  const end = stop(journey, "out:s2");
  assert.equal(end.custody, "venue");
  assert.equal(end.holder.label, "Aave V3 USDC");
  assert.equal(end.holdings[0].asset.symbol, "aBasUSDC");
  assert.equal(end.holdings[0].role, "position");
  assert.equal(end.holdings[0].identity.kind, "receipt");
  assert.equal(end.holdings[0].value.source, "venue-rate");
  assert.equal(end.holdings[0].value.expectedUsd, 99.96);
  assert.match(end.holdings[0].value.basis, /^1 aBasUSDC = 1 USDC plus interest/u);
  assert.deepEqual(journey.legs.map((leg) => [leg.id, leg.from, leg.via ?? null, leg.to]), [["s1", "start:s1", "transit:s1", "out:s1"], ["s2", "out:s1", null, "out:s2"]]);
  assert.match(journey.legs[1].title, /the USDC that arrives/u);
  assert.deepEqual(journey.now, { stopIds: ["start:s1"], legId: "s1", waitingFor: "signature" });
  assert.equal(journey.stage, "plan");
  assert.equal(journey.basis.previewDigest, preview.digest);
  assert.deepEqual(journey.blockers, []);
  assert.match(journey.digest, JOURNEY_DIGEST_PATTERN);
});

test("P5 half splits the arrival into spent-next and kept; kept equals the fare's you row", () => {
  const { graph, preview } = fixture("p5-empty");
  const journey = buildJourney(graph, preview, facts({ funding: { s2: { portionBps: 5_000 } } }), AT);
  const arrival = stop(journey, "out:s1");
  const spent = arrival.holdings.find((entry) => entry.role === "spent-next");
  const kept = arrival.holdings.find((entry) => entry.role === "kept");
  assert.deepEqual(spent.next, { legId: "s2", portionBps: 5_000 });
  assert.equal(spent.expected.amount, "24886457");
  assert.equal(spent.atLeast.amount, "24762025");
  const row = preview.rows.find((entry) => entry.role === "you" && entry.network === "solana" && entry.symbol === "USDC");
  assert.equal(kept.expected.amount, row.expected.amount);
  assert.equal(kept.atLeast.amount, row.worst.amount);
  // Remainder of an odd split goes to kept.
  assert.equal(BigInt(spent.expected.amount) + BigInt(kept.expected.amount), 49_772_914n);
  assert.equal(journey.legs[1].title, "Swap half of the USDC that arrives for JitoSOL on Solana");
  const end = stop(journey, "out:s2");
  assert.equal(end.holdings[0].identity.kind, "liquid-staking");
  assert.equal(end.holdings[0].value.source, "jupiter");
});

/** P8 with the planner's F6 reserve recorded on s2. */
function p8WithReserve(status = "ready", actual = null) {
  const { graph, preview } = fixture("p8-empty");
  const reserve = 900_000_000_000n;
  const steps = graph.steps.map((step) => {
    if (step.id === "s1" && actual) return { ...step, status: "settled", actualOutput: { ...step.minimumOutput, amount: String(actual) } };
    if (step.id === "s2") {
      return {
        ...step,
        status,
        input: { ...step.input, amount: String(BigInt(step.input.amount) - reserve) },
        funding: { from: "s1", portionBps: 10_000, gasReserve: { asset: ETH_ARB, symbol: "ETH", decimals: 18, amount: String(reserve), formatted: "0.0000009" } },
      };
    }
    return step;
  });
  return { graph: { ...graph, steps }, preview, reserve };
}

test("a settled parent is observed; the funded step spends landed minus the reserve", () => {
  const landed = 9_950_000_000_000_000n;
  const { graph, reserve } = p8WithReserve("ready", landed);
  const journey = buildJourney(graph, null, facts({ native: { [`arbitrum:${EMPTY_EVM}`]: native(0) }, fees: { s2: fee("arbitrum", ETH_ARB, 445_876_944_000) } }), AT);
  const arrival = stop(journey, "out:s1");
  const spent = arrival.holdings.find((entry) => entry.role === "spent-next");
  assert.equal(spent.certainty, "observed");
  assert.equal(spent.expected.amount, (landed - reserve).toString());
  assert.equal(arrival.state, "current");
  const gas = arrival.holdings.find((entry) => entry.role === "gas");
  assert.equal(gas.expected.amount, reserve.toString());
  assert.equal(stop(journey, "transit:s1").state, "passed");
  assert.equal(journey.stage, "live");
});

test("R1 blocks with the top-up recommended on Base, the gas leg on Solana, nothing when gas suffices", () => {
  const { graph, preview } = fixture("p2-empty");
  const empty = buildJourney(graph, preview, p2Facts({ native: { [`base:${EMPTY_EVM}`]: native(0), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) }, exitFees: { base: "500000000000" } }), AT);
  const r1 = consequence(empty, "gas-to-continue:out:s1");
  assert.equal(r1.severity, "block");
  assert.deepEqual(r1.options.map((entry) => entry.id), ["gas-topup", "bring-gas"]);
  assert.equal(r1.options[0].recommended, true);
  assert.equal(r1.options[0].action.type, "replan");
  assert.deepEqual(r1.options[0].action.request.constraints.gasOnArrival, { base: "0.05" });
  assert.equal(r1.facts.need, "1649511814328");
  assert.ok(r1.prompt);
  assert.equal(r1.prompt.defaultOptionId, "gas-topup");
  assert.deepEqual(empty.blockers, ["gas-to-continue:out:s1"]);
  assert.equal(r1.collapsed, false);
  assert.equal(openBlockers(empty, {}).length, 1);
  assert.equal(openBlockers(empty, { "gas-to-continue:out:s1": "bring-gas" }).length, 0);
  assert.equal(openBlockers(empty, { "gas-to-continue:out:s1": "not-an-option" }).length, 1);

  const { graph: p5, preview: p5Preview } = fixture("p5-empty");
  const gasLeg = { kind: "bridge", network: "base", from: USDC_BASE, to: SOL, toNetwork: "solana", amount: "1", protocol: "relay" };
  const solana = buildJourney(p5, p5Preview, facts({
    native: { [`base:${EMPTY_EVM}`]: native(10n ** 16n), [`solana:${EMPTY_SOL}`]: native(0) },
    fees: { s1: fee("base", ETH_BASE, 10n ** 12n), s2: fee("solana", SOL, 2_243_680) },
    gasOptions: { s1: { topup: false, gasLeg } },
    funding: { s2: { portionBps: 5_000 } },
  }), AT);
  const r1s = consequence(solana, "gas-to-continue:out:s1");
  assert.equal(r1s.severity, "block");
  assert.deepEqual(r1s.options.map((entry) => entry.id), ["gas-leg", "bring-gas"]);
  assert.equal(r1s.facts.need, "2243680");
  const legRequest = r1s.options[0].action.request;
  assert.equal(legRequest.text, undefined);
  assert.deepEqual(legRequest.actions[0], gasLeg);
  assert.equal(legRequest.actions.length, 3);
  assert.match(r1s.options[0].label, /\$1 into SOL/u);

  const fine = buildJourney(graph, preview, p2Facts(), AT);
  assert.equal(fine.consequences.filter((entry) => entry.kind === "gas-to-continue").length, 0);
  // Nothing tops up on its own: the request is unchanged unless the option is chosen.
  assert.equal(graph.request.constraints, undefined);
});

test("a funded native step with a gas reserve keeps a gas holding and raises no R1 there", () => {
  const { graph } = p8WithReserve();
  const journey = buildJourney(graph, null, facts({
    native: { [`base:${EMPTY_EVM}`]: native(10n ** 16n), [`arbitrum:${EMPTY_EVM}`]: native(0) },
    fees: { s1: fee("base", ETH_BASE, 10n ** 11n), s2: fee("arbitrum", ETH_ARB, 445_876_944_000) },
  }), AT);
  const gas = stop(journey, "out:s1").holdings.find((entry) => entry.role === "gas");
  assert.equal(gas.expected.amount, "900000000000");
  assert.equal(journey.consequences.filter((entry) => entry.kind === "gas-to-continue").length, 0);
  // Without the reserve the same journey blocks on Arbitrum.
  const { graph: bare, preview } = fixture("p8-empty");
  const blocked = buildJourney(bare, preview, facts({
    native: { [`base:${EMPTY_EVM}`]: native(10n ** 16n), [`arbitrum:${EMPTY_EVM}`]: native(0) },
    fees: { s1: fee("base", ETH_BASE, 10n ** 11n), s2: fee("arbitrum", ETH_ARB, 445_876_944_000) },
  }), AT);
  assert.equal(consequence(blocked, "gas-to-continue:out:s1").severity, "block");
});

test("refund paths for Relay, LI.FI via Across and Polymer, Across, CCTP V2 and deBridge", () => {
  const { graph: p6 } = fixture("p6-full");
  const across = refundPath(p6, p6.steps[0]);
  assert.equal(across.mode, "after-deadline");
  assert.equal(across.typicalDelay, "hours");
  assert.match(across.label, /fill deadline/u);
  const polymerStep = { ...p6.steps[0], warnings: ["Route: LI.FI via Polymer CCTP (LI.FI charges 0.25%)."] };
  const polymer = refundPath(p6, polymerStep);
  assert.equal(polymer.mode, "none");
  assert.match(polymer.label, /no refund/u);
  assert.equal(refundPath(p6, { ...p6.steps[0], protocol: "across" }).mode, "after-deadline");
  const cctp = refundPath(p6, { ...p6.steps[0], protocol: "cctp-v2" });
  assert.equal(cctp.mode, "none");
  assert.match(cctp.label, /message hash/u);
  assert.equal(refundPath(p6, p6.steps[1]), null);

  const { graph, preview } = fixture("p5-empty");
  const dln = { ...graph, steps: graph.steps.map((step) => (step.id === "s1" ? { ...step, protocol: "debridge-dln" } : step)) };
  const journey = buildJourney(dln, preview, facts({ native: { [`solana:${EMPTY_SOL}`]: native(0), [`base:${EMPTY_EVM}`]: native(10n ** 16n) } }), AT);
  const leg = journey.legs[0];
  assert.equal(leg.refund.mode, "after-cancel");
  assert.equal(leg.refund.needs.network, "solana");
  assert.equal(leg.refund.needs.asset.symbol, "SOL");
  const r8 = consequence(journey, "refund-path:transit:s1");
  assert.equal(r8.severity, "act");
  assert.match(r8.detail, /you need SOL on Solana/u);
});

test("failure mapping: refunded, below floor with observed credit, and a failed later leg", () => {
  const { graph, preview } = fixture("p2-empty");
  const refunded = { ...graph, status: "failed", steps: graph.steps.map((step) => (step.id === "s1" ? { ...step, status: "failed", references: ["5".repeat(88)], failure: { code: "SETTLEMENT_REFUNDED", message: "Relay refunded the deposit." } } : step)) };
  const a = buildJourney(refunded, preview, p2Facts(), AT);
  assert.equal(stop(a, "transit:s1").state, "current");
  assert.equal(stop(a, "transit:s1").custody, "refund-due");
  assert.equal(stop(a, "out:s1").state, "skipped");
  assert.equal(a.now.waitingFor, "decision");

  const credit = { asset: USDC_BASE, symbol: "USDC", decimals: 6, amount: "99000000", formatted: "99" };
  const mismatch = { ...graph, status: "failed", steps: graph.steps.map((step) => (step.id === "s1" ? { ...step, status: "failed", references: ["5".repeat(88)], observedCredit: credit, failure: { code: "SETTLEMENT_MISMATCH", message: "Below the floor." } } : step)) };
  const b = buildJourney(mismatch, preview, p2Facts(), AT);
  const out = stop(b, "out:s1");
  assert.equal(out.state, "current");
  assert.equal(out.custody, "wallet");
  assert.equal(out.holdings[0].certainty, "observed");
  assert.equal(out.holdings[0].expected.amount, "99000000");

  const landed = { ...graph.steps[0].minimumOutput, amount: "99950000", formatted: "99.95" };
  const later = {
    ...graph,
    status: "partially_completed",
    steps: graph.steps.map((step) => step.id === "s1"
      ? { ...step, status: "settled", actualOutput: landed, references: ["5".repeat(88)] }
      : { ...step, status: "failed", failure: { code: "PREPARE_FAILED", message: "Aave refused the supply." } }),
  };
  const c = buildJourney(later, preview, p2Facts(), AT);
  assert.equal(stop(c, "out:s1").state, "current");
  const r7 = consequence(c, "if-stopped:out:s1");
  assert.equal(r7.severity, "act");
  assert.deepEqual(r7.options.map((entry) => entry.id), ["retry", "replan-same-venue", "replan-any-venue", "end-here", "bring-back"]);
  assert.equal(r7.options[0].recommended, true);
  assert.equal(r7.prompt.defaultOptionId, "retry");
  assert.deepEqual(r7.options.find((entry) => entry.id === "end-here").action, { type: "stop" });
  assert.equal(r7.options.find((entry) => entry.id === "bring-back").action.text, "bridge 99.95 USDC from base to solana");
  assert.equal(c.now.waitingFor, "decision");
  // No idle-funds suggestions while a decision is pending.
  assert.equal(c.consequences.filter((entry) => entry.kind === "idle-funds").length, 0);
});

test("R11 suggests listed venues with room to leave, never a fully used one; options are sentences", () => {
  const { graph, preview } = fixture("p5-empty");
  const venue = (apy, utilization, exitLiquidity) => ({ name: "", apy, utilization, exitLiquidity, capRemaining: null, paused: false, frozen: false, shareRate: null, at: AT });
  const journey = buildJourney(graph, preview, facts({
    funding: { s2: { portionBps: 5_000 } },
    venues: {
      "solana:jupiter-lend:usdc": venue(0.0873, 0.81, "22960228000000"),
      "solana:kamino:usdc": venue(0.16, 1, "1"),
    },
  }), AT);
  const r11 = journey.consequences.find((entry) => entry.kind === "idle-funds");
  assert.ok(r11);
  assert.equal(r11.severity, "info");
  assert.equal(r11.collapsed, true);
  assert.deepEqual(r11.options.map((entry) => entry.id), ["deposit:solana:jupiter-lend:usdc"]);
  assert.deepEqual(r11.options[0].action, { type: "plan-new", text: "deposit 24.762025 USDC into jupiter lend on solana" });
});

test("valuation sources, unpriced never zero, receipt and share bases", () => {
  const { graph, preview } = fixture("p6-full");
  const noPrices = buildJourney(graph, preview, facts({ prices: {} }), AT);
  const shares = stop(noPrices, "out:s2").holdings[0];
  assert.equal(shares.value.source, "unpriced");
  assert.equal(shares.value.expectedUsd, null);
  assert.equal(shares.value.price, null);
  const venues = { "base:morpho:steakhouse-prime-usdc": { name: "Steakhouse Prime USDC", apy: 0.0463, utilization: null, exitLiquidity: null, capRemaining: null, paused: false, frozen: false, shareRate: "1047400000000000000", at: AT } };
  const priced = buildJourney(graph, preview, facts({ venues }), AT);
  const valued = stop(priced, "out:s2").holdings[0];
  assert.equal(valued.identity.kind, "receipt");
  assert.equal(valued.value.source, "venue-rate");
  assert.match(valued.value.basis, /^1 steakUSDC = 1\.0474 USDC/u);
  assert.ok(valued.value.expectedUsd > 99 && valued.value.expectedUsd < 101);
  // Without a share rate a vault share stays unpriced (never 1:1 by assumption).
  const rateless = buildJourney(graph, preview, facts({ venues: { "base:morpho:steakhouse-prime-usdc": { ...venues["base:morpho:steakhouse-prime-usdc"], shareRate: null } } }), AT);
  assert.equal(stop(rateless, "out:s2").holdings[0].value.source, "unpriced");
  // Identities: issuer USDC, wrapped WETH, bridged Polygon WETH, EVM LSTs, unlisted.
  assert.equal(assetIdentity({ asset: USDC_BASE, symbol: "USDC", decimals: 6 }, "base").kind, "issuer");
  assert.equal(assetIdentity({ asset: "eip155:8453/erc20:0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 }, "base").kind, "wrapped");
  assert.equal(assetIdentity({ asset: "eip155:137/erc20:0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18 }, "polygon").kind, "bridged");
  assert.equal(assetIdentity({ asset: "eip155:1/erc20:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18 }, "ethereum").kind, "liquid-staking");
  assert.equal(assetIdentity({ asset: "eip155:1/erc20:0x1111111111111111111111111111111111111111", symbol: "X", decimals: 18 }, "ethereum").kind, "unlisted");
  // Receipt tokens: SparkLend aToken, Spark Savings sUSDC, Fluid fToken, Yearn shares.
  for (const [asset, network] of [
    ["eip155:1/erc20:0x377C3bd93f2a2984E1E7bE6A5C22c525eD4A4815", "ethereum"],
    ["eip155:1/erc20:0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE", "ethereum"],
    ["eip155:1/erc20:0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d", "ethereum"],
    ["eip155:1/erc20:0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f", "ethereum"],
    ["eip155:8453/erc20:0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", "base"],
    ["eip155:1/erc20:0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204", "ethereum"],
    ["eip155:1/erc20:0xc56413869c6CDf96496f2b1eF801fEDBdFA7dDB0", "ethereum"],
  ]) {
    const identity = assetIdentity({ asset, symbol: "R", decimals: 18 }, network);
    assert.equal(identity.kind, "receipt", asset);
    assert.ok(identity.underlying, asset);
  }
});

test("deterministic JSON and digest; USD and time do not move it, amounts and severities do", () => {
  const { graph, preview } = fixture("p2-empty");
  const one = buildJourney(graph, preview, p2Facts(), AT);
  const two = buildJourney(graph, preview, p2Facts(), AT);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  const repriced = buildJourney(graph, preview, p2Facts({ at: LATER, prices: { ...facts().prices, [ETH_BASE]: { usd: 2600, source: "jupiter", at: LATER } } }), LATER);
  assert.equal(repriced.digest, one.digest);
  assert.notEqual(repriced.computedAt, one.computedAt);
  const blocked = buildJourney(graph, preview, p2Facts({ native: { [`base:${EMPTY_EVM}`]: native(0), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) } }), AT);
  assert.notEqual(blocked.digest, one.digest);
  const moved = { ...graph, steps: graph.steps.map((step) => (step.id === "s1" ? { ...step, status: "settled", actualOutput: { ...step.minimumOutput, amount: "99900000" } } : step)) };
  assert.notEqual(buildJourney(moved, preview, p2Facts(), AT).digest, one.digest);
  const { digest, ...rest } = one;
  assert.equal(journeyDigest(rest), digest);
});

test("continuationRequest after a failed s2: the exact landed amount, same accounts, metadata.continues", () => {
  const { graph } = fixture("p2-empty");
  const landed = { ...graph.steps[0].minimumOutput, amount: "99950000", formatted: "99.95" };
  const failed = {
    ...graph,
    request: { ...graph.request, constraints: { deadline: 1, maxSlippageBps: 30 }, metadata: { order: "42" } },
    steps: graph.steps.map((step) => step.id === "s1" ? { ...step, status: "settled", actualOutput: landed } : { ...step, status: "failed", failure: { code: "PREPARE_FAILED", message: "x" } }),
  };
  const request = continuationRequest(failed, "out:s1", { now: Date.parse(AT) });
  assert.equal(request.actions.length, 1);
  assert.deepEqual(request.actions[0], {
    kind: "deposit",
    network: "base",
    from: USDC_BASE,
    amount: "99.95",
    protocol: "aave-v3",
    params: { venue: "base:aave-v3:usdc" },
  });
  assert.deepEqual(request.accounts, graph.request.accounts);
  assert.equal(request.text, undefined);
  assert.deepEqual(request.metadata, { order: "42", continues: graph.id });
  assert.deepEqual(request.constraints, { maxSlippageBps: 30 });
  const any = continuationRequest(failed, "out:s1", { anyVenue: true, now: Date.parse(AT) });
  assert.equal(any.actions[0].protocol, undefined);
  assert.equal(any.actions[0].params, undefined);
  const call = { ...failed, steps: failed.steps.map((step) => (step.id === "s2" ? { ...step, kind: "call", protocol: "custom-call" } : step)) };
  assert.equal(continuationRequest(call, "out:s1"), null);
  assert.equal(continuationRequest(failed, "out:nope"), null);
});

test("actionsFromGraph: merged bridge, bridge plus half swap, third-party transfer", () => {
  const { graph: p4 } = fixture("p4-full");
  assert.deepEqual(actionsFromGraph(p4), [{
    kind: "bridge",
    network: "base",
    from: ETH_BASE,
    to: "eip155:10/erc20:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    amount: "0.05",
    toNetwork: "optimism",
    protocol: "relay",
  }]);
  const { graph: p5 } = fixture("p5-empty");
  const half = { ...p5, steps: p5.steps.map((step) => (step.id === "s2" ? { ...step, funding: { from: "s1", portionBps: 5_000 } } : step)) };
  const actions = actionsFromGraph(half);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].amount, "50");
  assert.equal(actions[0].toNetwork, "solana");
  assert.deepEqual(actions[1], { kind: "swap", network: "solana", from: USDC_SOL, to: JITOSOL, amount: "max", protocol: "jupiter", params: { portionBps: 5_000 } });
  const { graph: p10 } = fixture("p10-empty");
  const transfer = actionsFromGraph(p10)[1];
  assert.equal(transfer.kind, "transfer");
  assert.equal(transfer.amount, "max");
  assert.equal(transfer.recipient, "eip155:42161:0x000000000000000000000000000000000000dEaD");
  const call = { ...p10, steps: p10.steps.map((step) => (step.id === "s2" ? { ...step, kind: "call" } : step)) };
  assert.equal(actionsFromGraph(call), null);
});

test("folding: blocks and acts expand, then one warn, at most three; reads none gives one folded note", () => {
  const { graph, preview } = fixture("p5-empty");
  const journey = buildJourney(graph, preview, facts({ funding: { s2: { portionBps: 5_000 } }, reads: "none" }), AT);
  assert.equal(journey.basis.reads, "none");
  assert.equal(journey.basis.factsAt, null);
  const note = consequence(journey, "gas-to-continue:reads-none");
  assert.equal(note.severity, "info");
  assert.match(note.title, /Connect your wallets to check gas on Base and Solana/u);
  const open = journey.consequences.filter((entry) => !entry.collapsed);
  assert.ok(open.length <= 3);
  assert.equal(open.filter((entry) => entry.severity === "warn").length <= 1, true);
  // Sorted by severity first.
  const ranks = journey.consequences.map((entry) => ["block", "act", "warn", "info"].indexOf(entry.severity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("a failed balance read is reported as unknown, never omitted", () => {
  const { graph, preview } = fixture("p2-empty");
  const journey = buildJourney(graph, preview, p2Facts({ native: { [`base:${EMPTY_EVM}`]: null, [`solana:${EMPTY_SOL}`]: native(10n ** 9n) } }), AT);
  const r1 = consequence(journey, "gas-to-continue:out:s1");
  assert.equal(r1.severity, "warn");
  assert.match(r1.title, /Could not read your ETH balance on Base/u);
  assert.equal(journey.consequences.filter((entry) => entry.kind === "gas-to-leave").length, 0);
});

test("R2, R4 and R5: no gas left after a merged leg, cross-asset exposure, a full venue blocks", () => {
  const { graph, preview } = fixture("p4-full");
  const journey = buildJourney(graph, preview, facts({
    native: { [`base:${FULL_EVM}`]: native(10n ** 18n), [`optimism:${FULL_EVM}`]: native(0) },
    fees: { s1: fee("base", ETH_BASE, 155_645_359_071, "simulated") },
    exitFees: { optimism: "300000000000" },
    gasOptions: { s1: { topup: true, gasLeg: null } },
    prices: { ...facts().prices, "eip155:10/slip44:60": { usd: 2480, source: "jupiter", at: AT } },
  }), AT);
  const r2 = consequence(journey, "gas-to-leave:out:s1");
  assert.equal(r2.severity, "warn");
  assert.equal(r2.options[0].id, "gas-topup");
  assert.ok(consequence(journey, "price-exposure:out:s1:cross-asset"));

  const p2 = fixture("p2-empty");
  const cap = (capRemaining, paused = false) => ({ "base:aave-v3:usdc": { name: "Aave V3 USDC", apy: 0.0397, utilization: 0.9, exitLiquidity: "18126363000000", capRemaining, paused, frozen: false, shareRate: null, at: AT } });
  const full = buildJourney(p2.graph, p2.preview, p2Facts({ venues: cap("1000000") }), AT);
  assert.equal(consequence(full, "venue-capacity:out:s2").severity, "block");
  assert.equal(consequence(full, "venue-capacity:out:s2").options[0].id, "replan-any-venue");
  const paused = buildJourney(p2.graph, p2.preview, p2Facts({ venues: cap(null, true) }), AT);
  assert.equal(consequence(paused, "venue-capacity:out:s2").severity, "block");
  const roomy = buildJourney(p2.graph, p2.preview, p2Facts({ venues: cap("500000000") }), AT);
  assert.equal(consequence(roomy, "venue-capacity:out:s2").severity, "warn");
  const fine = buildJourney(p2.graph, p2.preview, p2Facts({ venues: cap(null) }), AT);
  assert.equal(consequence(fine, "venue-capacity:out:s2"), undefined);
  assert.match(consequence(fine, "exit-path:out:s2").detail, /18,?126,?363|18126363/u);
});

test("a leg's explorer link is its main transaction, not the approval; every transaction is linked, main first", () => {
  const { graph, preview } = fixture("p2-empty");
  const APPROVAL = `0x${"aa".repeat(32)}`;
  const DEPOSIT = `0x${"bb".repeat(32)}`;
  const done = {
    ...graph,
    status: "completed",
    steps: graph.steps.map((step) =>
      step.id === "s1"
        ? { ...step, status: "settled", references: ["5".repeat(88)] }
        : {
            ...step,
            status: "settled",
            references: [APPROVAL, DEPOSIT],
            prepared: { quoteBinding: "b", preparedAt: AT, expiresAt: 0, transactions: [{ vm: "evm", network: "base", description: "Approve USDC" }, { vm: "evm", network: "base", description: "Supply USDC to Aave V3" }] },
          },
    ),
  };
  const journey = buildJourney(done, preview, p2Facts(), AT);
  const leg = journey.legs.find((entry) => entry.id === "s2");
  assert.match(leg.tracking.url, new RegExp(`${DEPOSIT}$`, "u"));
  assert.match(leg.tracking.label, /^View on /u);
  assert.deepEqual(leg.transactions.map((link) => link.url.slice(-8)), [DEPOSIT.slice(-8), APPROVAL.slice(-8)]);
  assert.match(leg.transactions[1].label, /^Approve USDC on /u);
  // One transaction: no separate list.
  assert.equal(journey.legs.find((entry) => entry.id === "s1").transactions, undefined);
});
