/**
 * Goal solver: search, ranking and expansion. Golden routes on the clarify
 * corpus' fixture wallets with the stub prices; every expansion is run
 * through the existing policy, rendered as the canonical sentence and
 * compiled back by the grammar (`roundTripDifferences` must be empty).
 * Offline: nothing reads a network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Goal } from "@kletia/core";
import { shape } from "../clarify/corpusHarness.js";
import type { WorkStep } from "../clarify/types.js";
import { readGoals } from "../goal/index.js";
import { capabilityGraph, walletNodeId } from "../solver/graph.js";
import { ceilTo } from "../solver/decide.js";
import { searchRoutes, solveGoals, type SearchSource, type SolveResult } from "../solver/index.js";
import { goalOf, fixtureWallet, runPolicy, snapshotOf, STUB_PRICES, type SnapshotOptions } from "./solverFixtures.js";

const APY = { "base:aave-v3:usdc": 0.041, "base:morpho:steakhouse-prime-usdc": 0.05, "base:compound-v3:usdc": 0.038 } as const;

function goalsOf(text: string): { goals: Goal[]; reads: { orderOnly: boolean; possessive: boolean }[] } {
  const read = readGoals(text);
  assert.ok(read.length > 0 && read.every((entry) => entry !== null), `"${text}" reads as goals`);
  return { goals: read.map((entry) => entry!.goal), reads: read.map((entry) => ({ orderOnly: entry!.notes.orderOnly, possessive: entry!.notes.possessive })) };
}

function solveText(wallet: string, text: string, options: SnapshotOptions = { apy: APY }): SolveResult {
  const { goals, reads } = goalsOf(text);
  return solveGoals(goals, snapshotOf(wallet, options), { accounts: fixtureWallet(wallet).accounts, reads });
}

/** Runs the steps through the policy; asserts it plans them and the sentence round-trips. Returns the plan shape. */
function planned(wallet: string, steps: readonly WorkStep[]): string {
  const run = runPolicy(wallet, steps);
  assert.deepEqual(run.analysis.questions.map((question) => `${question.field}:${question.reason}`), [], "the policy asks nothing more");
  assert.ok(run.analysis.resolved && run.sentence, "the policy resolves the steps to a sentence");
  assert.deepEqual(run.roundTrip, [], `"${run.sentence}" compiles to the same actions`);
  return shape(run.analysis.resolved);
}

describe("goal solver: golden routes", () => {
  it("get me 0.01 ETH on arbitrum, ETH on Base: bridges ETH (exposure-neutral, D3 chip)", () => {
    const result = solveText("full", "get me 0.01 ETH on arbitrum");
    assert.deepEqual(result.questions, []);
    assert.equal(planned("full", result.steps), "bridge@base->arbitrum 0.01 ETH");
    const source = result.assumptions.find((entry) => entry.field === "actions[0].from");
    assert.ok(source?.material, "the source is a material chip");
    assert.match(source.label, /ETH on Base/u);
    assert.ok(result.assumptions.some((entry) => entry.field === "actions[0].toNetwork"), "the bridge is shown (D8)");
    // The steps carry provenance: the solver's choices are assumed with a template code.
    const step = result.steps[0] as WorkStep;
    assert.equal(step.toNetwork?.by, "user");
    assert.equal(step.from?.by, "assumed");
    assert.equal(step.from?.why?.code, "solver.source");
    assert.equal(step.amount?.why?.code, "solver.target-amount");
  });

  it("get me 0.01 ETH on arbitrum with only USDC: swaps into ETH across, back-solved with the stub prices (D3 chip)", () => {
    const result = solveText("evm_base", "get me 0.01 ETH on arbitrum", { balances: { "base:ETH": "0" } });
    assert.deepEqual(result.questions, []);
    const route = result.outcomes[0]?.routes[0];
    assert.ok(route);
    assert.equal(route.source.node.symbol, "USDC");
    assert.equal(route.landing.network, "arbitrum");
    assert.equal(route.landing.symbol, "ETH");
    assert.ok(route.hops.some((hop) => hop.edge.kind === "bridge"), "it crosses to Arbitrum");
    // Back-solving: 0.01 ETH at $3,412.50 in USDC at par, divided by the fee shares, plus a 1% buffer.
    const kept = route.hops.reduce((share, hop) => share * (1 - hop.edge.feeBps / 10_000), 1);
    const expected = ceilTo(((0.01 * (STUB_PRICES.ETH as number)) / 1 / kept) * 1.01, 6);
    const amount = result.steps[0]?.amount?.v;
    assert.deepEqual(amount, { t: "exact", value: expected });
    assert.ok(Number(expected) > 34.12 && Number(expected) < 35, `about 34.5 USDC, got ${expected}`);
    const source = result.assumptions.find((entry) => entry.field === "actions[0].from");
    assert.ok(source?.material);
    assert.match(source.label, /USDC on Base/u);
    const target = result.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.ok(target?.material, "a priced target amount is a material chip");
    assert.match(planned("evm_base", result.steps), /USDC.*ETH|ETH/u);
  });

  it("consolidate to Base (two_usdc): bridges Arbitrum's 150 USDC; gas tokens stay", () => {
    const result = solveText("two_usdc", "consolidate to Base");
    assert.deepEqual(result.questions, []);
    assert.equal(planned("two_usdc", result.steps), "bridge@arbitrum->base 150 USDC");
    assert.match(result.assumptions[0]?.reason ?? "", /Gas tokens stay|Stays/u);
  });

  it("consolidate my USDC on base (two_usdc): the lone network is the destination", () => {
    const result = solveText("two_usdc", "consolidate my USDC on base");
    assert.equal(planned("two_usdc", result.steps), "bridge@arbitrum->base 150 USDC");
  });

  it("move my aave USDC to morpho: withdraw the whole position, then deposit it", () => {
    const result = solveText("full", "move my aave USDC to morpho");
    assert.deepEqual(result.questions, []);
    assert.match(planned("full", result.steps), /^withdraw@base max USDC \[aave-v3\] \| deposit@base max USDC \[morpho:steakhouse-prime-usdc\]$/u);
    assert.equal(result.steps[0]?.protocol?.by, "user");
    assert.equal(result.steps[1]?.protocol?.by, "user");
    assert.equal(result.steps[1]?.vault?.why?.code, "solver.venue-apy");
  });

  it("zap 20 USDC from arbitrum into morpho on base: bridge, then deposit all of it", () => {
    const result = solveText("full", "zap 20 USDC from arbitrum into morpho on base");
    assert.deepEqual(result.questions, []);
    assert.match(planned("full", result.steps), /^bridge@arbitrum->base 20 USDC \| deposit@base max USDC \[morpho:/u);
    assert.deepEqual(result.steps[1]?.amount?.v, { t: "previous", bps: 10_000 });
  });

  it("send 20 USDC to toly.sns: Solana holds too little, so it bridges first and then sends", () => {
    const result = solveText("full", "send 20 USDC to toly.sns");
    assert.match(planned("full", result.steps), /^bridge@\w+->solana 20 USDC \| transfer@solana max USDC to toly\.sns$/u);
    assert.equal(result.steps[1]?.recipient?.by, "user");
  });

  it("I need 20 USDC on arbitrum (low_evm): moves exactly 20 USDC from Solana", () => {
    const result = solveText("low_evm", "I need 20 USDC on arbitrum");
    assert.equal(planned("low_evm", result.steps), "bridge@solana->arbitrum 20 USDC");
  });

  it("move everything from Solana to Arbitrum and earn yield: the second goal chains on the first landing", () => {
    const result = solveText("full", "move everything from Solana to Arbitrum and earn yield");
    assert.deepEqual(result.questions, []);
    assert.match(planned("full", result.steps), /^bridge@solana->arbitrum 12 USDC \| deposit@arbitrum max USDC \[/u);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[1]?.landings[0]?.place.custody.kind, "venue");
  });

  it("swap all but 0.1 SOL to USDC: the kept amount is subtracted from the known balance (chip)", () => {
    const result = solveText("full", "swap all but 0.1 SOL to USDC");
    assert.equal(planned("full", result.steps), "swap@solana 2.4 SOL->USDC");
    assert.ok(result.assumptions.some((entry) => entry.field === "actions[0].amount" && entry.material));
  });
});

describe("goal solver: search", () => {
  it("is deterministic: the same goals give the same steps, chips and routes", () => {
    for (const text of ["get me 0.01 ETH on arbitrum", "consolidate to base", "send 20 USDC to toly.sns", "go all in on SOL"]) {
      const first = solveText("full", text);
      const second = solveText("full", text);
      assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)), text);
    }
  });

  it("orders ties by registry order and node id, not by the order of the sources", () => {
    const graph = capabilityGraph();
    const snapshot = snapshotOf("full");
    const sources: SearchSource[] = snapshot.holdings
      .filter((holding) => holding.status === "known" && holding.asset && Number(holding.formatted) > 0 && holding.symbol === "USDC")
      .map((holding) => ({ node: graph.nodes.get(walletNodeId(holding.network, holding.asset!))!, valueUsd: 20, amount: holding.formatted!, status: "known" as const, position: false }));
    assert.ok(sources.length >= 2);
    const spec = {
      graph,
      isTarget: (node: { network: string; symbol: string; custody: { kind: string } }) => node.network === "optimism" && node.symbol === "USDC" && node.custody.kind === "wallet",
      kinds: new Set(["bridge", "swap"] as const),
      accounts: fixtureWallet("full").accounts,
    };
    const forward = searchRoutes({ ...spec, sources });
    const backward = searchRoutes({ ...spec, sources: [...sources].reverse() });
    assert.ok(forward.length > 0);
    assert.deepEqual(backward.map((route) => route.id), forward.map((route) => route.id));
  });

  it("keeps a swap on one network when only one network is said, and never pins a bridge or DEX unless named", () => {
    const swap = solveGoals([goalOf({ kind: "convert", op: "swap", spend: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "1" } }, want: { asset: { symbol: "USDC" } } })], snapshotOf("full"), { accounts: fixtureWallet("full").accounts });
    assert.ok(swap.outcomes[0]?.routes[0]?.hops.every((hop) => hop.edge.kind !== "bridge"));
    assert.equal(swap.steps[0]?.protocol, undefined, "no DEX pinned");
    const via = solveGoals([goalOf({ kind: "relocate", op: "bridge", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "10" }, from: { network: "base", custody: { kind: "wallet" } } }, want: { at: { network: "arbitrum", custody: { kind: "wallet" } } }, constraints: { via: ["across"] } })], snapshotOf("full"), { accounts: fixtureWallet("full").accounts });
    assert.equal(via.outcomes[0]?.routes[0]?.hops[0]?.edge.protocol, "across");
    assert.deepEqual(via.steps[0]?.protocol, { v: "across", by: "user" });
    assert.match(planned("full", via.steps), /^bridge@base->arbitrum 10 USDC \[across\]$/u);
  });

  it("avoids a protocol the goal avoids", () => {
    const goal = goalOf({ kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "50" }, from: { network: "base", custody: { kind: "wallet" } } }, want: { at: { network: "base", custody: { kind: "venue", category: "lending" } } }, constraints: { avoid: ["aave-v3"] } });
    const result = solveGoals([goal], snapshotOf("full", { apy: APY }), { accounts: fixtureWallet("full").accounts });
    assert.notEqual(result.steps[0]?.protocol?.v, "aave-v3");
    assert.ok(result.outcomes[0]?.routes[0]?.hops.every((hop) => hop.edge.protocol !== "aave-v3"));
  });

  it("never routes on a network without an account of its family", () => {
    const result = solveText("evm_base", "get me 0.01 ETH on arbitrum");
    for (const route of result.outcomes[0]?.routes ?? []) for (const hop of route.hops) assert.notEqual(hop.edge.network, "solana");
  });

  it("asks the amount when a priced target has no price (never guessed)", () => {
    const result = solveText("evm_base", "get me 0.01 ETH on arbitrum", { balances: { "base:ETH": "0" }, prices: { ETH: null, WETH: null } });
    assert.equal(result.steps.length, 0);
    assert.equal(result.questions[0]?.reason, "AMOUNT_MISSING");
  });

  it("solves a warm goal within the latency budget", () => {
    capabilityGraph();
    solveText("full", "get me 0.01 ETH on arbitrum");
    const started = performance.now();
    solveText("full", "get me 0.01 ETH on arbitrum");
    const ms = performance.now() - started;
    assert.ok(ms < 250, `solved in ${ms.toFixed(1)} ms`);
  });
});
