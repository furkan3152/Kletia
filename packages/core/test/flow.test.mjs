import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOW_DEFAULT_SLIPPAGE_BPS,
  fundedFlow,
  fundingParent,
  isOwnRequestAccount,
  parentCreditFromGraph,
  scaleFloor,
  scaleOutput,
} from "../dist/index.js";

const OWN_BASE = "eip155:8453:0x52908400098527886E0F7030069857D2E4169EE7";
const OWN_ARB = "eip155:42161:0x52908400098527886E0F7030069857D2E4169EE7";
const THIRD = "eip155:42161:0x1111111111111111111111111111111111111111";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_ARB = "eip155:42161/slip44:60";

const amount = (asset, units, symbol = "USDC", decimals = 6) => ({ asset, symbol, decimals, amount: String(units), formatted: String(units) });

function graph(steps, request = {}) {
  return {
    id: "int_test",
    request: { accounts: [OWN_BASE], ...request },
    steps,
    edges: steps.flatMap((step) => step.dependsOn.map((from) => ({ from, to: step.id, kind: "funds" }))),
  };
}

const bridge = {
  id: "s1",
  dependsOn: [],
  account: OWN_BASE,
  input: amount(USDC_BASE, 100_000_000),
  expectedOutput: amount(USDC_ARB, 99_500_000),
  minimumOutput: amount(USDC_ARB, 99_000_000),
  settlement: { kind: "cross-network", destinationNetwork: "arbitrum" },
};

function child(overrides = {}) {
  return { id: "s2", dependsOn: ["s1"], account: OWN_ARB, input: amount(USDC_ARB, 99_000_000), ...overrides };
}

test("the funding parent is funding.from, else the funds edge", () => {
  const g = graph([bridge, child()]);
  assert.equal(fundingParent(g, g.steps[1])?.id, "s1");
  const explicit = graph([bridge, { ...bridge, id: "s0" }, child({ dependsOn: [], funding: { from: "s0", portionBps: 10_000 } })]);
  assert.equal(fundingParent(explicit, explicit.steps[2])?.id, "s0");
  assert.equal(fundingParent(g, g.steps[0]), null);
  assert.ok(isOwnRequestAccount(g, OWN_ARB), "same address on another EVM network");
  assert.ok(!isOwnRequestAccount(g, THIRD));
});

test("parent credit: observed once settled, else quoted / venue-minimum; other assets give null", () => {
  const g = graph([bridge, child()]);
  assert.deepEqual(parentCreditFromGraph(g, g.steps[1]), { expected: 99_500_000n, worst: 99_000_000n, certainty: "venue-minimum" });
  const settled = graph([{ ...bridge, actualOutput: amount(USDC_ARB, 99_300_000) }, child()]);
  assert.deepEqual(parentCreditFromGraph(settled, settled.steps[1]), { expected: 99_300_000n, worst: 99_300_000n, certainty: "observed" });
  const sameNetwork = graph([{ ...bridge, settlement: { kind: "same-network" } }, child()]);
  assert.equal(parentCreditFromGraph(sameNetwork, sameNetwork.steps[1]).certainty, "quoted");
  const otherAsset = graph([bridge, child({ input: amount(ETH_ARB, 1, "ETH", 18) })]);
  assert.equal(parentCreditFromGraph(otherAsset, otherAsset.steps[1]), null);
  const noParent = graph([bridge]);
  assert.equal(parentCreditFromGraph(noParent, noParent.steps[0]), null);
});

test("F3/F7: a share rounds down and the rest stays at the parent's output stop", () => {
  const g = graph([bridge, child({ funding: { from: "s1", portionBps: 3_333 } })]);
  const flow = fundedFlow(g, g.steps[1], { expected: 100n, worst: 99n, certainty: "quoted" });
  assert.deepEqual(flow.spends, { expected: 33n, worst: 32n });
  assert.deepEqual(flow.kept, { expected: 67n, worst: 67n });
  assert.equal(flow.reserve, 0n);
  assert.equal(flow.encoded, 99_000_000n);
  // Older stored intents without `funding` use the step ref's portion.
  const legacy = graph([bridge, child()]);
  assert.deepEqual(fundedFlow(legacy, legacy.steps[1], { expected: 100n, worst: 99n, certainty: "quoted" }, { portionBps: 5_000 }).spends, { expected: 50n, worst: 49n });
});

test("F6: the gas reserve is subtracted after the share, kept, and never makes the spend negative", () => {
  const reserve = amount(ETH_ARB, 1_000, "ETH", 18);
  const g = graph([bridge, child({ funding: { from: "s1", portionBps: 10_000, gasReserve: reserve } })]);
  const flow = fundedFlow(g, g.steps[1], { expected: 10_000n, worst: 9_000n, certainty: "quoted" });
  assert.deepEqual(flow.spends, { expected: 9_000n, worst: 8_000n });
  assert.deepEqual(flow.kept, { expected: 1_000n, worst: 1_000n });
  assert.equal(flow.reserve, 1_000n);
  const tiny = fundedFlow(g, g.steps[1], { expected: 500n, worst: 400n, certainty: "quoted" });
  assert.deepEqual(tiny.spends, { expected: 0n, worst: 0n });
  assert.deepEqual(tiny.kept, { expected: 500n, worst: 400n });
  // Without `funding`, the option applies (older intents).
  const legacy = graph([bridge, child()]);
  assert.equal(fundedFlow(legacy, legacy.steps[1], { expected: 10n, worst: 10n, certainty: "quoted" }, { gasReserve: 4n }).spends.expected, 6n);
});

test("a third-party recipient is never paid more than the planned input plus slippage", () => {
  const toThird = graph([bridge, child({ recipient: THIRD, input: amount(USDC_ARB, 1_000_000) })]);
  const flow = fundedFlow(toThird, toThird.steps[1], { expected: 2_000_000n, worst: 1_500_000n, certainty: "quoted" });
  const cap = (1_000_000n * BigInt(10_000 + FLOW_DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  assert.deepEqual(flow.spends, { expected: cap, worst: cap });
  assert.deepEqual(flow.kept, { expected: 2_000_000n - cap, worst: 1_500_000n - cap });
  // The request's slippage, then the step ref's, then the planned input.
  const withRequest = graph([bridge, child({ recipient: THIRD, input: amount(USDC_ARB, 1_000_000) })], { constraints: { maxSlippageBps: 100 } });
  assert.equal(fundedFlow(withRequest, withRequest.steps[1], { expected: 2_000_000n, worst: 2_000_000n, certainty: "quoted" }).spends.expected, 1_010_000n);
  assert.equal(
    fundedFlow(withRequest, withRequest.steps[1], { expected: 2_000_000n, worst: 2_000_000n, certainty: "quoted" }, { slippageBps: 10, plannedInput: 500_000n }).spends.expected,
    500_500n,
  );
  // The user's own account is not capped.
  const own = graph([bridge, child({ recipient: OWN_ARB, input: amount(USDC_ARB, 1_000_000) })]);
  assert.equal(fundedFlow(own, own.steps[1], { expected: 2_000_000n, worst: 2_000_000n, certainty: "quoted" }).spends.expected, 2_000_000n);
});

test("outputs scale linearly with what the step spends; floors only scale down", () => {
  const flow = { spends: { expected: 50n, worst: 40n }, kept: { expected: 0n, worst: 0n }, reserve: 0n, encoded: 100n };
  assert.deepEqual(scaleOutput(1_000n, flow), { expected: 500n, estimated: true });
  assert.deepEqual(scaleOutput(1_000n, { ...flow, spends: { expected: 100n, worst: 100n } }), { expected: 1_000n, estimated: false });
  assert.deepEqual(scaleOutput(1_000n, null), { expected: 1_000n, estimated: false });
  assert.equal(scaleFloor(1_000n, flow), 400n);
  assert.equal(scaleFloor(1_000n, { ...flow, spends: { expected: 200n, worst: 150n } }), 1_000n, "never scaled up");
  assert.equal(scaleFloor(1_000n, { ...flow, encoded: 0n }), 1_000n);
});

test("journey contract constants: rules R1-R12, severities, option kinds and limits", async () => {
  const journey = await import("../dist/index.js");
  assert.deepEqual(journey.JOURNEY_RULE_IDS, ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"]);
  assert.equal(new Set(Object.values(journey.JOURNEY_RULES)).size, 12);
  assert.deepEqual(journey.CONSEQUENCE_SEVERITIES, ["block", "act", "warn", "info"]);
  assert.deepEqual(journey.JOURNEY_CERTAINTY_ORDER, ["observed", ...journey.CERTAINTY_ORDER]);
  for (const kind of ["gas-topup", "retry", "end-here", "bring-back", "track", "ok"]) assert.ok(journey.JOURNEY_OPTION_KINDS.includes(kind), kind);
  assert.equal(journey.JOURNEY_DEPOSIT_OPTION_PREFIX, "deposit:");
  assert.ok(Object.isFrozen(journey.JOURNEY_LIMITS));
  assert.equal(journey.JOURNEY_LIMITS.topupMinUsd, Number(journey.GAS_ON_ARRIVAL_USD.min));
  assert.ok(journey.JOURNEY_LIMITS.topupMaxUsd <= Number(journey.GAS_ON_ARRIVAL_USD.max));
  assert.match(journey.JOURNEY_SPEC, /^kletia\.journey\/v\d+$/u);
});

test("F6 reserve arithmetic: two times the fees plus rent, two significant digits, the 25 % limit", async () => {
  const { ceilSignificant, gasReserveUnits, reserveTooLarge, GAS_RESERVE_MAX_SHARE_BPS } = await import("../dist/index.js");
  assert.equal(ceilSignificant(4_458n), 4_500n);
  assert.equal(ceilSignificant(4_500n), 4_500n);
  assert.equal(ceilSignificant(4_501n), 4_600n);
  assert.equal(ceilSignificant(99n), 99n);
  assert.equal(ceilSignificant(991n), 1_000n);
  assert.equal(ceilSignificant(0n), 0n);
  // 2 x 445,876 gwei-units of fees -> 891,752 -> 900,000.
  assert.equal(gasReserveUnits(445_876n), 900_000n);
  // Solana with an empty wallet: 2 x 105,000 lamports + 890,880 rent-exempt minimum = 1,100,880 -> 1,200,000.
  assert.equal(gasReserveUnits(105_000n, 890_880n), 1_200_000n);
  assert.equal(GAS_RESERVE_MAX_SHARE_BPS, 2_500);
  assert.equal(reserveTooLarge(25n, 100n), true);
  assert.equal(reserveTooLarge(24n, 100n), false);
  assert.equal(reserveTooLarge(0n, 0n), false);
});
