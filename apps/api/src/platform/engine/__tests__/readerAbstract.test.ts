/**
 * P4-M4 (intent design A.2 vocabulary for abstract goals, A.6 IR, RF5/RF12)
 * and seam S1: abstract idioms are read by named rules into the words the
 * frames read or straight into the A.6 IR; a clause the reader cannot read
 * carries a non-serialised `unreadClauses` list; readings handed back per
 * clause index become model-read goal steps (source M).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Goal } from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import { parseSentence } from "../clarify/slots.js";
import type { UnreadClause, WorkStep } from "../clarify/types.js";
import { abstractRewrite, readAbstract } from "../goal/abstract.js";
import { normalizeClause } from "../goal/index.js";

const read = (text: string) => parseSentence(text, []).steps;
const goalOf = (text: string): Goal => {
  const steps = read(text);
  assert.equal(steps.length, 1, text);
  assert.ok(steps[0]?.goal, `${text}: a goal step`);
  return steps[0].goal as Goal;
};
const slots = (step: WorkStep | undefined) => ({
  kind: step?.kind?.v,
  network: step?.network?.v,
  from: step?.from?.v,
  to: step?.to?.v,
  amount: step?.amount?.v,
  recipient: step?.recipient?.v,
});

function refusal(fn: () => unknown): Error & { code: string } {
  try {
    fn();
  } catch (error) {
    if (isPlatformError(error)) return error as Error & { code: string };
    throw error;
  }
  assert.fail("expected a refusal");
}

describe("abstract rewrites: idioms read as the concrete action they say", () => {
  it("fund <recipient> with <amount>: a payment, values copied as typed", () => {
    for (const text of ["fund alice.eth with 25 usdc on base", "fund bob.base.eth with 7.5 usdc on base", "Fund carol.eth with 12 USDC on arbitrum"]) {
      const step = read(text)[0];
      assert.equal(step?.kind?.v, "transfer", text);
      assert.equal(step?.amount?.v.t, "exact");
    }
    assert.deepEqual(slots(read("fund alice.eth with 25 usdc on base")[0]), { kind: "transfer", network: "base", from: "usdc", to: undefined, amount: { t: "exact", value: "25" }, recipient: "alice.eth" });
  });

  it("pay <purpose> of <amount>: the purpose words are consumed, the payment is as typed", () => {
    const address = "0x2222222222222222222222222222222222222222";
    for (const text of [`pay rent of 500 usdc to ${address} on base`, `pay the bill of 40 usdc to ${address} on base`, `send salary of 900 usdc to ${address} on base`]) {
      const step = read(text)[0];
      assert.equal(step?.kind?.v, "transfer", text);
      assert.equal(step?.recipient?.v, address);
      assert.equal(step?.network?.v, "base");
    }
  });

  it("make sure <recipient> gets exactly <amount>: one exact transfer", () => {
    assert.deepEqual(slots(read("make sure alice.eth gets exactly 50 usdc on arbitrum")[0]), { kind: "transfer", network: "arbitrum", from: "usdc", to: undefined, amount: { t: "exact", value: "50" }, recipient: "alice.eth" });
    assert.equal(read("make sure dave.eth receives exactly 3 usdc on base")[0]?.amount?.v.t, "exact");
  });

  it("wrap / unwrap: the 1:1 step as a swap between ETH and WETH", () => {
    assert.deepEqual(slots(read("wrap 0.1 eth on base")[0]), { kind: "swap", network: "base", from: "eth", to: "weth", amount: { t: "exact", value: "0.1" }, recipient: undefined });
    assert.equal(read("unwrap 0.2 weth on base")[0]?.to?.v, "eth");
  });

  it("manner adverbs become a preference, never a dropped word", () => {
    assert.deepEqual(abstractRewrite("get usdc onto solana cheaply"), { text: "get usdc onto solana", rules: ["abstract:manner"], prefer: "cheapest" });
    assert.equal(goalOf("put my idle stables to work safely").constraints.prefer, "safest");
  });

  it("best-venue phrases: the solver ranks the venue", () => {
    assert.equal(read("stake half my sol with the best provider")[0]?.kind?.v ?? goalOf("stake half my sol with the best provider").kind, "stake");
    assert.equal(read("put my usdc to work on the safest venue on base")[0]?.network?.v, "base");
    // "my usdc" with no network is not every holding (C11): the amount stays open.
    assert.equal(read("give me the safest yield on my usdc")[0]?.amount, undefined);
  });

  it("an amount nobody said is asked, never guessed", () => {
    const step = read("send alice.eth enough eth for gas on arbitrum")[0];
    assert.equal(step?.kind?.v, "transfer");
    assert.equal(step?.amount, undefined);
  });
});

describe("abstract frames: the A.6 IR for the solver", () => {
  it("ensure: atLeast the fee reserve on the token's home network", () => {
    for (const text of ["make sure I have enough SOL for fees", "make sure i have enough sol for gas", "make sure there is enough sol for fees"]) {
      const goal = goalOf(text);
      assert.equal(goal.kind, "fuel");
      assert.deepEqual(goal.want, { asset: { symbol: "sol" }, at: { network: "solana", custody: { kind: "wallet" } }, mode: "atLeast" });
    }
    assert.equal(readAbstract("make sure i have enough usdc for fees"), null, "USDC has no single home network: not read");
  });

  it("prepare <amount> on <network>: an atLeast relocate that the solver tops up", () => {
    for (const text of ["prepare 100 usdc on optimism for a payment", "prepare 40 usdc on arbitrum"]) {
      const goal = goalOf(text);
      assert.equal(goal.kind, "relocate");
      assert.equal(goal.want.mode, "atLeast");
      assert.equal(goal.want.amount?.t, "exact");
    }
  });

  it("top up <network> gas: the destination is the network said, the amount is asked", () => {
    const goal = goalOf("top up my arbitrum gas");
    assert.deepEqual(goal.want, { asset: { class: "gas" }, at: { network: "arbitrum", custody: { kind: "wallet" } } });
    assert.equal(goalOf("top up gas on base").want.at?.network, "base");
  });

  it("rebalance: network axis 50/50 and asset axis 100%", () => {
    for (const text of ["even out my usdc between base and arbitrum", "balance my usdc across base and arbitrum"]) {
      const goal = goalOf(text);
      assert.equal(goal.kind, "rebalance");
      assert.deepEqual(goal.targets, { axis: "network", weights: [{ key: "base", bps: 5000 }, { key: "arbitrum", bps: 5000 }] });
    }
    const all = goalOf("go 100% stablecoins on base");
    assert.deepEqual(all.targets, { axis: "asset", scope: { network: "base", custody: { kind: "wallet" } }, weights: [{ key: "any-stable", bps: 10_000 }] });
    assert.equal(readAbstract("even out my usdc between base and base"), null);
  });

  it("exposure: liquid staking and bitcoin classes; the paying holding is not all of it", () => {
    assert.deepEqual(goalOf("get exposure to eth staking").want, { asset: { class: "eth-lst" } });
    const sol = goalOf("get me exposure to solana staking with my base usdc");
    assert.deepEqual(sol.want, { asset: { class: "sol-lst" } });
    assert.deepEqual(sol.spend, { asset: { symbol: "usdc" }, from: { network: "base", custody: { kind: "wallet" } } });
    assert.equal(sol.spend.amount, undefined);
    assert.deepEqual(goalOf("I want to hold btc on base").want, { asset: { class: "btc" }, at: { network: "base", custody: { kind: "wallet" } } });
  });

  it("exit-all: every position (of a category, on a network, of a token), never wallet tokens", () => {
    assert.deepEqual(goalOf("exit all my lending positions").spend, { amount: { t: "max" }, from: { custody: { kind: "position", category: "lending" } } });
    assert.deepEqual(goalOf("close everything on base").spend, { amount: { t: "max" }, from: { network: "base", custody: { kind: "position" } } });
    assert.deepEqual(goalOf("withdraw all my usdc from everywhere").spend, { asset: { symbol: "usdc" }, amount: { t: "max" }, from: { custody: { kind: "position" } } });
  });

  it("abstract goal steps are derived readings (source C) and never lowered", () => {
    const step = read("exit all my lending positions")[0];
    assert.equal(step?.source, "C");
    assert.equal(step?.goalRead?.lowered, false);
  });

  it("fail closed: an extra unknown word leaves the clause unread", () => {
    for (const text of ["even out my usdc between base and arbitrum tomorrow", "close everything on base except aave", "make sure I have enough SOL for fees maybe"]) {
      assert.equal(readAbstract(normalizeClause(text)), null, text);
      assert.equal(refusal(() => read(text)).code, "INTENT_UNSUPPORTED", text);
    }
  });
});

describe("seam S1: unread clauses and readings per clause index", () => {
  it("the refusal carries every unread clause with its closed-class record, never serialised", () => {
    const error = refusal(() => read("swap 1 sol to usdc on solana, then flibber the gizmo"));
    const unread = (error as unknown as { unreadClauses?: readonly UnreadClause[] }).unreadClauses;
    assert.ok(unread && unread.length === 1);
    assert.equal(unread[0]?.index, 1);
    assert.match(unread[0]?.text ?? "", /flibber the gizmo/u);
    assert.ok(unread[0]?.closedClass);
    assert.equal(Object.keys(error).includes("unreadClauses"), false);
    assert.equal(JSON.stringify(error).includes("unreadClauses"), false);
  });

  it("a reading for that index becomes a model-read goal step in place; other clauses read as before", () => {
    const goal: Goal = { kind: "convert", spend: { asset: { symbol: "usdc" } }, want: { asset: { symbol: "eth" } }, holder: { t: "self" }, constraints: {}, confidence: "llm" };
    const parsed = parseSentence("swap 1 sol to usdc on solana, then flibber the gizmo", [], false, 0, undefined, { readings: new Map([[1, [goal]]]) });
    assert.equal(parsed.steps.length, 2);
    assert.equal(parsed.steps[0]?.kind?.v, "swap");
    assert.equal(parsed.steps[1]?.modelRead, true);
    assert.equal(parsed.steps[1]?.source, "M");
    assert.deepEqual(parsed.steps[1]?.goal, goal);
    // A reading for a clause that was read is ignored: the deterministic reading stands.
    const kept = parseSentence("swap 1 sol to usdc on solana", [], false, 0, undefined, { readings: new Map([[0, [goal]]]) });
    assert.equal(kept.steps[0]?.kind?.v, "swap");
    assert.equal(kept.steps[0]?.modelRead, undefined);
  });
});
