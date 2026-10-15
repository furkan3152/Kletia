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
