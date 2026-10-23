import assert from "node:assert/strict";
import test from "node:test";
import {
  CLARIFY_POLICY_VERSION,
  CLARIFY_REASONS,
  CLARIFY_STEP_KINDS,
  GOAL_KINDS,
  GOAL_LIMITS,
  GOAL_OPS,
  GOAL_SPEC,
  PURPOSE_REASONS,
  THREAD_LIMITS,
  THREAD_SPEC,
  UNSUGGESTED_REASONS,
  validateGoal,
  validateGoals,
  validateThread,
} from "../dist/index.js";

const paths = (result) => (result.ok ? [] : result.issues.map((issue) => issue.path));

function goal(overrides = {}) {
  return {
    kind: "convert",
    op: "swap",
    spend: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "1" }, from: { network: "solana", custody: { kind: "wallet" } } },
    want: { asset: { symbol: "USDC" } },
    holder: { t: "self" },
    constraints: {},
    confidence: "exact",
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    spec: THREAD_SPEC,
    id: "th_abcdefghijklmnopqrstuvwx",
    rev: 1,
    status: "ready",
    policy: CLARIFY_POLICY_VERSION,
    steps: [{ kind: { v: "swap", by: "user" }, from: { v: "SOL", by: "user" }, to: { v: "USDC", by: "user" }, amount: { v: { t: "exact", value: "1" }, by: "user" } }],
    open: [],
    corrections: [],
    turns: [],
    undo: [],
    ...overrides,
  };
}

/** A goal using every optional field at its widest. */
function wideGoal(index) {
  return {
    kind: "earn",
    op: "deposit",
    spend: {
      asset: { symbol: "So11111111111111111111111111111111111111112" },
      amount: { t: "allBut", keep: "0.123456789012345678" },
      from: { network: "arbitrum", custody: { kind: "position", protocol: "aave-v3" } },
    },
    want: {
      asset: { class: "any-stable" },
      amount: { t: "usd", value: "123456789.123456789" },
      at: { network: "base", custody: { kind: "venue", protocol: "morpho", vault: "0x616a4E1db48e22028f6bbf20444Cd3b8e3273738", category: "lending" } },
    },
    holder: { t: "address", value: "0x52908400098527886E0F7030069857D2E4169EE7" },
    constraints: { via: ["morpho", "across", "relay"], avoid: ["lifi", "debridge-dln"], prefer: "cheapest", keepGas: true },
    ...(index > 0 ? { chain: { after: index - 1 } } : {}),
    confidence: "frame",
  };
}

test("goal: reasons of the goal solver exist and are purpose questions; only ASSET_TYPO suggests", () => {
  const added = ["AMOUNT_EXCEEDS_BALANCE", "SCOPE_AMBIGUOUS", "EARN_KIND", "ASSET_TYPO", "INTERPRETATION_CONFIRM"];
  for (const reason of added) {
    assert.ok(CLARIFY_REASONS.includes(reason), reason);
    assert.ok(PURPOSE_REASONS.has(reason), reason);
  }
  assert.equal(new Set(CLARIFY_REASONS).size, CLARIFY_REASONS.length);
  assert.ok(!UNSUGGESTED_REASONS.has("ASSET_TYPO"));
  for (const reason of added.filter((r) => r !== "ASSET_TYPO")) assert.ok(UNSUGGESTED_REASONS.has(reason), reason);
  assert.equal(CLARIFY_POLICY_VERSION, "2026-11.1");
});

test("goal: GOAL_OPS mirrors CLARIFY_STEP_KINDS; constants are frozen", () => {
  assert.deepEqual([...GOAL_OPS], [...CLARIFY_STEP_KINDS]);
  assert.equal(GOAL_SPEC, "kletia.goal/v1");
  assert.equal(GOAL_KINDS.length, 10);
  assert.ok(Object.isFrozen(GOAL_LIMITS));
  assert.equal(GOAL_LIMITS.maxGoals, 8);
  assert.equal(GOAL_LIMITS.maxRouteSteps, 4);
});

test("goal: a valid goal round-trips through JSON", () => {
  for (const value of [goal(), wideGoal(0), goal({ kind: "consolidate", op: undefined, spend: { asset: { class: "usd-stable" }, amount: { t: "max" } }, want: { at: { network: "base", custody: { kind: "wallet" } } } })]) {
    const copy = JSON.parse(JSON.stringify(value));
    const result = validateGoal(copy);
    assert.deepEqual(paths(result), []);
    assert.deepEqual(result.value, copy);
  }
  for (const amount of [{ t: "portion", bps: 3333 }, { t: "previous" }, { t: "max" }, { t: "usd", value: "50" }]) {
    assert.ok(validateGoal(goal({ spend: { amount } })).ok, JSON.stringify(amount));
  }
  for (const holder of [{ t: "name", value: "alice.base.eth" }, { t: "nickname" }, { t: "selfOther" }]) {
    assert.ok(validateGoal(goal({ holder })).ok, JSON.stringify(holder));
  }
});

test("goal: invalid values are refused with their paths", () => {
  const cases = [
    [goal({ kind: "teleport" }), "kind"],
    [goal({ op: "mint" }), "op"],
    [goal({ confidence: "guess" }), "confidence"],
    [goal({ extra: 1 }), "extra"],
    [goal({ spend: { amount: { t: "exact", value: "0" } } }), "spend.amount.value"],
    [goal({ spend: { amount: { t: "exact", value: "-1" } } }), "spend.amount.value"],
    [goal({ spend: { amount: { t: "exact", value: "1e3" } } }), "spend.amount.value"],
    [goal({ spend: { amount: { t: "portion", bps: 0 } } }), "spend.amount.bps"],
    [goal({ spend: { amount: { t: "portion", bps: 10_001 } } }), "spend.amount.bps"],
    [goal({ spend: { amount: { t: "portion", bps: 33.3 } } }), "spend.amount.bps"],
    [goal({ spend: { amount: { t: "max", value: "1" } } }), "spend.amount.value"],
    [goal({ spend: { amount: { t: "half" } } }), "spend.amount.t"],
    [goal({ spend: { asset: { symbol: "US DC" } } }), "spend.asset.symbol"],
    [goal({ spend: { asset: { class: "btc" } } }), "spend.asset.class"],
    [goal({ spend: { from: { network: "mars", custody: { kind: "wallet" } } } }), "spend.from.network"],
    [goal({ spend: { from: { custody: { kind: "vault" } } } }), "spend.from.custody.kind"],
    [goal({ spend: { from: { custody: { kind: "wallet", protocol: "aave-v3" } } } }), "spend.from.custody.protocol"],
    [goal({ want: { at: { custody: { kind: "venue", protocol: "not-a-protocol" } } } }), "want.at.custody.protocol"],
    [goal({ want: { at: { custody: { kind: "venue", category: "farming" } } } }), "want.at.custody.category"],
    [goal({ want: { from: {} } }), "want.from"],
    [goal({ holder: { t: "address" } }), "holder.value"],
    [goal({ holder: { t: "self", value: "0xabc" } }), "holder.value"],
    [goal({ holder: { t: "mom" } }), "holder.t"],
    [goal({ constraints: { via: [] } }), "constraints.via"],
    [goal({ constraints: { via: ["jupiter", "jupiter"] } }), "constraints.via"],
    [goal({ constraints: { via: ["jupiter"], avoid: ["jupiter"] } }), "constraints.avoid"],
    [goal({ constraints: { prefer: "riskiest" } }), "constraints.prefer"],
    [goal({ constraints: { keepGas: "yes" } }), "constraints.keepGas"],
    [goal({ chain: { after: -1 } }), "chain.after"],
    [goal({ holder: undefined }), "holder"],
    [goal({ constraints: undefined }), "constraints"],
  ];
  for (const [value, path] of cases) {
    const result = validateGoal(JSON.parse(JSON.stringify(value)));
    assert.equal(result.ok, false, path);
    assert.ok(paths(result).includes(path), `${path}: ${JSON.stringify(paths(result))}`);
  }
  assert.equal(validateGoal(null).ok, false);
  assert.equal(validateGoal([goal()]).ok, false);
});

test("goal: lists hold at most 8 goals and chains point backwards", () => {
  assert.ok(validateGoals([goal(), goal({ chain: { after: 0 } })]).ok);
  assert.deepEqual(paths(validateGoals([goal({ chain: { after: 0 } })])), ["[0].chain.after"]);
  assert.deepEqual(paths(validateGoals([goal(), goal({ chain: { after: 1 } })])), ["[1].chain.after"]);
  assert.ok(validateGoals(Array.from({ length: 8 }, (_, i) => wideGoal(i))).ok);
  assert.equal(validateGoals(Array.from({ length: 9 }, () => goal())).ok, false);
  assert.equal(validateGoals({}).ok, false);
});

test("goal: a thread with goals validates, round-trips and stays within 16 KB with 8 wide goals", () => {
  assert.ok(validateThread(thread()).ok, "goals stay optional");
  const goals = Array.from({ length: GOAL_LIMITS.maxGoals }, (_, i) => wideGoal(i));
  const steps = Array.from({ length: THREAD_LIMITS.maxSteps }, () => thread().steps[0]);
  const value = thread({ goals, steps, undo: [steps, steps, steps] });
  const text = JSON.stringify(value);
  assert.ok(Buffer.byteLength(text) <= THREAD_LIMITS.maxBytes, `${Buffer.byteLength(text)} bytes`);
  const result = validateThread(JSON.parse(text));
  assert.deepEqual(paths(result), []);
  assert.deepEqual(result.value, value);
});

test("goal: invalid goals in a thread are refused at goals[i]", () => {
  assert.deepEqual(paths(validateThread(thread({ goals: [goal({ kind: "x" })] }))), ["goals[0].kind"]);
  assert.deepEqual(paths(validateThread(thread({ goals: [goal(), goal({ chain: { after: 3 } })] }))), ["goals[1].chain.after"]);
  assert.deepEqual(paths(validateThread(thread({ goals: "convert" }))), ["goals"]);
  assert.equal(validateThread(thread({ goals: Array.from({ length: 9 }, () => goal()) })).ok, false);
});

// ------------------------------------------------------------ 2026-10 Goal IR additions

test("goal: the 2026-10 additions validate (keep, filter, want mode, targets, position category, yield)", async () => {
  const { GOAL_PREFERENCES, WANT_MODES, TARGET_AXES, EXPOSURE_ASSET_CLASSES, ASSET_CLASSES } = await import("../dist/index.js");
  assert.ok(GOAL_PREFERENCES.includes("yield"));
  assert.deepEqual([...WANT_MODES], ["add", "atLeast", "exactly"]);
  assert.deepEqual([...TARGET_AXES], ["network", "asset"]);
  // Exposure classes are declared but not accepted until the solver reads them.
  for (const klass of EXPOSURE_ASSET_CLASSES) assert.ok(!ASSET_CLASSES.includes(klass), klass);
  const keep = goal({
    constraints: { keep: [{ amount: { t: "exact", value: "50" } }, { asset: { symbol: "ETH" }, amount: { t: "exact", value: "0.05" }, network: "base" }], prefer: "yield" },
  });
  assert.equal(validateGoal(keep).ok, true, JSON.stringify(validateGoal(keep)));
  const dust = goal({ kind: "consolidate", spend: { asset: { class: "any-stable" }, amount: { t: "max" }, filter: { maxUsdEach: "5" } } });
  assert.equal(validateGoal(dust).ok, true);
  const ensure = goal({ kind: "acquire", spend: {}, want: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "0.05" }, mode: "atLeast", at: { network: "solana", custody: { kind: "wallet" } } } });
  assert.equal(validateGoal(ensure).ok, true);
  const exit = goal({ kind: "exit", spend: { amount: { t: "max" }, from: { custody: { kind: "position", category: "lending" } } }, want: {} });
  assert.equal(validateGoal(exit).ok, true);
  const rebalance = goal({
    kind: "rebalance", spend: {}, want: {},
    targets: { axis: "asset", scope: { network: "arbitrum", custody: { kind: "wallet" } }, weights: [{ key: "ETH", bps: 5_000 }, { key: "USDC", bps: 5_000 }] },
  });
  assert.equal(validateGoal(rebalance).ok, true, JSON.stringify(validateGoal(rebalance)));
  const evenOut = goal({ kind: "rebalance", spend: { asset: { symbol: "USDC" } }, want: {}, targets: { axis: "network", weights: [{ key: "base", bps: 5_000 }, { key: "arbitrum", bps: 5_000 }] } });
  assert.equal(validateGoal(evenOut).ok, true);
  assert.equal(GOAL_LIMITS.maxKeeps, 4);
  assert.equal(GOAL_LIMITS.maxTargetWeights, 8);
});

test("goal: the 2026-10 additions refuse bad values with their paths", () => {
  const cases = [
    [goal({ constraints: { keep: [] } }), "constraints.keep"],
    [goal({ constraints: { keep: Array(5).fill({ amount: { t: "exact", value: "1" } }) } }), "constraints.keep"],
    [goal({ constraints: { keep: [{ asset: { symbol: "ETH" } }] } }), "constraints.keep[0].amount"],
    [goal({ constraints: { keep: [{ amount: { t: "max" } }] } }), "constraints.keep[0].amount"],
    [goal({ constraints: { keep: [{ amount: { t: "previous" } }] } }), "constraints.keep[0].amount"],
    [goal({ constraints: { keep: [{ amount: { t: "exact", value: "1" }, network: "mars" }] } }), "constraints.keep[0].network"],
    [goal({ constraints: { keep: [{ amount: { t: "exact", value: "1" }, why: "gas" }] } }), "constraints.keep[0].why"],
    [goal({ spend: { asset: { symbol: "USDC" }, filter: { maxUsdEach: "0" } } }), "spend.filter.maxUsdEach"],
    [goal({ spend: { asset: { symbol: "USDC" }, filter: { below: "5" } } }), "spend.filter.below"],
    [goal({ want: { asset: { symbol: "USDC" }, mode: "most" } }), "want.mode"],
    [goal({ want: { asset: { symbol: "USDC" }, filter: {} } }), "want.filter"],
    [goal({ spend: { mode: "atLeast" } }), "spend.mode"],
    [goal({ spend: { from: { custody: { kind: "position", category: "perps" } } } }), "spend.from.custody.category"],
    [goal({ constraints: { prefer: "riskiest" } }), "constraints.prefer"],
    // Targets only on a rebalance, weights summing to 10 000 over distinct keys of the axis.
    [goal({ targets: { axis: "network", weights: [{ key: "base", bps: 10_000 }] } }), "targets"],
    [goal({ kind: "rebalance", targets: { axis: "chain", weights: [{ key: "base", bps: 10_000 }] } }), "targets.axis"],
    [goal({ kind: "rebalance", targets: { axis: "network", weights: [{ key: "base", bps: 6_000 }, { key: "arbitrum", bps: 3_000 }] } }), "targets.weights"],
    [goal({ kind: "rebalance", targets: { axis: "network", weights: [{ key: "mars", bps: 10_000 }] } }), "targets.weights[0].key"],
    [goal({ kind: "rebalance", targets: { axis: "asset", weights: [{ key: "ETH", bps: 5_000 }, { key: "ETH", bps: 5_000 }] } }), "targets.weights[1].key"],
    [goal({ kind: "rebalance", targets: { axis: "asset", weights: [{ key: "ETH", bps: 5_000.5 }, { key: "USDC", bps: 4_999.5 }] } }), "targets.weights[0].bps"],
    [goal({ kind: "rebalance", targets: { axis: "asset", weights: [] } }), "targets.weights"],
    [goal({ kind: "rebalance", targets: { axis: "asset", weights: [{ key: "ETH", bps: 10_000 }], scope: { network: "mars", custody: { kind: "wallet" } } } }), "targets.scope.network"],
  ];
  for (const [input, path] of cases) {
    const result = validateGoal(input);
    assert.equal(result.ok, false, `${path}: ${JSON.stringify(input)}`);
    assert.ok(paths(result).includes(path), `${path} in ${JSON.stringify(paths(result))}`);
  }
});

test("goal: \"the rest\" and the exposure classes are declared but refused until something reads them", async () => {
  const { isRestAmount } = await import("../dist/index.js");
  assert.equal(isRestAmount({ t: "rest" }), true);
  assert.equal(isRestAmount({ t: "rest", bps: 1 }), false);
  assert.equal(isRestAmount({ t: "max" }), false);
  assert.ok(paths(validateGoal(goal({ spend: { asset: { symbol: "SOL" }, amount: { t: "rest" } } }))).includes("spend.amount.t"));
  for (const klass of ["eth-lst", "sol-lst", "btc"]) {
    assert.ok(paths(validateGoal(goal({ want: { asset: { class: klass } } }))).includes("want.asset.class"), klass);
  }
});

test("goal: the new reasons of reading and placement are purpose questions with no suggestion", () => {
  const added = [
    "AMOUNT_VAGUE", "REFERENCE_AMBIGUOUS", "RECIPIENT_EACH", "SPEND_CONFLICT", "STAKE_INPUT_MISMATCH", "NETWORK_CONTRADICTION",
    "PAIRING_AMBIGUOUS", "DELIVERY_AMOUNT", "GAS_ON_ARRIVAL", "FEE_HIGH", "PLAN_TOO_LARGE",
  ];
  assert.equal(added.length, 11);
  for (const reason of added) {
    assert.ok(CLARIFY_REASONS.includes(reason), reason);
    assert.ok(PURPOSE_REASONS.has(reason), `${reason} is a purpose question`);
    assert.ok(UNSUGGESTED_REASONS.has(reason), `${reason} carries no suggestion`);
  }
  assert.deepEqual(CLARIFY_REASONS.slice(-11), added, "appended at the end (existing order unchanged)");
});
