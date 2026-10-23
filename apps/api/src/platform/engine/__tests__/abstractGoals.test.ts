/**
 * Abstract goals on constructed Goals, independent of the reader: rebalance
 * targets on both axes, atLeast and exactly targets, exposure classes,
 * exit-all, dust sweeps, the cheapest-payment question, the USD want
 * back-solve, conversions on the home network, the one abstract crossing leg,
 * the D8 chip text and plan-size move counting. Every ready expansion runs
 * through the policy, which confirms computed moves with every move listed.
 * Offline: the fixture wallets with stub prices; nothing reads a network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLARIFY_LIMITS, PURPOSE_REASONS, YIELD_VENUES, type AssetSel, type Goal, type NetworkKey, type Place } from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import { shape, roundTripDifferences } from "../clarify/corpusHarness.js";
import type { Analysis, FactsView, Question, ResolvedAction, WorkState, WorkStep } from "../clarify/types.js";
import { capabilityGraph } from "../solver/graph.js";
import { searchRoutes, solveGoals, type GoalPins, type SolveResult } from "../solver/index.js";
import { analyze } from "../clarify/policy.js";
import { render } from "../clarify/render.js";
import { homeNetworks, overCaps, planSize, planTooLargeQuestion, rebalancePlan, splitLabel } from "../solver/abstract.js";
import { EXACT_DELIVERY_PLANNED, movesReason } from "../solver/moves.js";
import type { Snapshot } from "../solver/snapshot.js";
import { contextOf, factsOf, fixtureWallet, goalOf, snapshotOf, type SnapshotOptions } from "./solverFixtures.js";

const on = (network: NetworkKey): Place => ({ network, custody: { kind: "wallet" } });
const units = (value: string) => BigInt(value) * 10n ** 18n;

function solve(wallet: string, goal: Goal, options: SnapshotOptions = {}, pins?: GoalPins, snapshot?: Snapshot): SolveResult {
  const result = solveGoals([goal], snapshot ?? snapshotOf(wallet, options), { accounts: fixtureWallet(wallet).accounts, ...(pins ? { pins: [pins] } : {}) });
  for (const question of result.questions) checkQuestion(question);
  return result;
}

function checkQuestion(question: Question): void {
  assert.ok(question.options.length <= CLARIFY_LIMITS.optionsPerQuestion);
  assert.ok(question.prompt.length <= CLARIFY_LIMITS.prompt && question.why.length <= CLARIFY_LIMITS.why);
  for (const option of question.options) assert.ok(option.label.length <= CLARIFY_LIMITS.optionLabel, option.label);
  if (PURPOSE_REASONS.has(question.reason)) assert.ok(question.options.every((option) => !option.recommended), `${question.reason} never suggests`);
}

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (isPlatformError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  assert.fail("expected a refusal");
}

/** The policy over expanded steps, with the snapshot's own balances as its facts (balance overrides included). */
function policy(wallet: string, steps: readonly WorkStep[], options: SnapshotOptions = {}): { analysis: Analysis; sentence: string | null; roundTrip: readonly string[] } {
  const snapshot = snapshotOf(wallet, options);
  const base = factsOf(wallet);
  const facts: FactsView = {
    ...base,
    balance(network, symbol) {
      const holding = snapshot.holdings.find((entry) => entry.network === network && entry.symbol.toUpperCase() === symbol.toUpperCase());
      return holding?.status === "known" ? holding.formatted : base.balance(network, symbol);
    },
  };
  const state: WorkState = { id: "th_test", rev: 1, status: "needs_input", steps: structuredClone([...steps]) as WorkStep[], open: [], corrections: [], turns: [], undo: [] };
  const ctx = contextOf(wallet);
  const analysis = analyze(state, ctx, facts);
  const sentence = analysis.resolved ? render(analysis.resolved) : null;
  return { analysis, sentence, roundTrip: analysis.resolved && sentence ? roundTripDifferences(analysis.resolved, sentence, ctx) : [] };
}

/** The steps are confirmed with every move listed: the policy asks INTERPRETATION_CONFIRM, a "Every move:" prompt. */
function confirmsMoves(wallet: string, steps: readonly WorkStep[], options: SnapshotOptions = {}): string {
  const run = policy(wallet, steps, options);
  const question = run.analysis.questions[0];
  assert.equal(question?.reason, "INTERPRETATION_CONFIRM", JSON.stringify(run.analysis.questions.map((entry) => entry.prompt)));
  assert.match(question?.prompt ?? "", /^Every move: /u);
  return question?.prompt ?? "";
}

function plans(wallet: string, steps: readonly WorkStep[], options: SnapshotOptions = {}): string {
  const run = policy(wallet, steps, options);
  assert.deepEqual(run.analysis.questions.map((question) => `${question.field}:${question.reason}`), []);
  assert.ok(run.analysis.resolved && run.sentence);
  assert.deepEqual(run.roundTrip, [], `"${run.sentence}" compiles to the same actions`);
  return shape(run.analysis.resolved as ResolvedAction[]);
}

const kinds = (result: SolveResult) => result.steps.map((step) => `${step.kind?.v}@${step.network?.v}${step.toNetwork ? `->${step.toNetwork.v}` : ""} ${step.from?.v ?? ""}${step.to ? `->${step.to.v}` : ""}`);
const flagged = (step: WorkStep | undefined) => (step as (WorkStep & { movesConfirm?: true }) | undefined)?.movesConfirm === true;

/* ---------------------------------------------------------------- arithmetic */

describe("abstract goals: rebalance arithmetic and plan size", () => {
  it("moves the difference once, from the key with too much to the key with too little", () => {
    const plan = rebalancePlan([{ key: "base", value: units("200") }, { key: "arbitrum", value: units("150") }], [{ key: "base", bps: 5000 }, { key: "arbitrum", bps: 5000 }], units("1"), 0n);
    assert.deepEqual(plan.transfers, [{ from: "base", to: "arbitrum", value: units("25") }]);
    assert.equal(plan.total, units("350"));
  });

  it("moves nothing when every key is within the tolerance, and skips moves below the minimum", () => {
    const weights = [{ key: "a", bps: 5000 }, { key: "b", bps: 5000 }];
    assert.deepEqual(rebalancePlan([{ key: "a", value: units("101") }, { key: "b", value: units("99") }], weights, units("2"), 0n).transfers, []);
    assert.deepEqual(rebalancePlan([{ key: "a", value: units("101") }, { key: "b", value: units("99") }], weights, 0n, units("5")).transfers, []);
  });

  it("sells every unweighted key into a lone 100 % key, largest first and deterministic", () => {
    const plan = rebalancePlan([{ key: "other:ETH", value: units("70") }, { key: "stable", value: units("10") }, { key: "other:AERO", value: units("20") }], [{ key: "stable", bps: 10_000 }], units("1"), 0n);
    assert.deepEqual(plan.transfers, [{ from: "other:ETH", to: "stable", value: units("70") }, { from: "other:AERO", to: "stable", value: units("20") }]);
    assert.equal(splitLabel([{ bps: 10_000 }]), "100%");
    assert.equal(splitLabel([{ bps: 6000 }, { bps: 4000 }]), "60/40");
  });

  it("matches the largest surplus to the largest deficit across three keys", () => {
    const plan = rebalancePlan([{ key: "a", value: units("90") }, { key: "b", value: units("0") }, { key: "c", value: units("30") }], [{ key: "a", bps: 3334 }, { key: "b", bps: 3333 }, { key: "c", bps: 3333 }], units("1"), 0n);
    assert.equal(plan.transfers.length, 2);
    assert.equal(plan.transfers[0]?.from, "a");
    assert.equal(plan.transfers[0]?.to, "b");
  });

  it("lands a conversion where the money is when that network lists the asset, else on the networks that list it", () => {
    assert.deepEqual(homeNetworks({ from: "base", listed: ["base", "arbitrum"] }), ["base"]);
    assert.deepEqual(homeNetworks({ from: "base", listed: ["solana"] }), ["solana"]);
    assert.deepEqual(homeNetworks({ from: "solana", listed: ["base", "arbitrum", "solana-devnet"] }), ["base", "arbitrum"]);
  });

  it("counts signatures and auctions against the caps (8 signatures, 12 auctions) and lists the moves when over", () => {
    assert.deepEqual(planSize(["swap", "bridge", "deposit"]), { signatures: 3, auctions: 2 });
    assert.equal(overCaps({ signatures: 8, auctions: 8 }), false);
    assert.equal(overCaps({ signatures: 9, auctions: 0 }), true);
    assert.equal(overCaps({ signatures: 5, auctions: 5 }, 4), true, "the steps left in the thread count too");
    const moves = Array.from({ length: 10 }, (_, i) => ({ network: (i < 6 ? "base" : "arbitrum") as NetworkKey, label: `move ${i}`, steps: 1, auctions: 1 }));
    const question = planTooLargeQuestion({ index: 0, moves, room: 8, networkLabel: (network) => network });
    assert.equal(question?.reason, "PLAN_TOO_LARGE");
    assert.deepEqual(question?.options.map((option) => option.value), [{ source: "base" }, { source: "arbitrum" }, { target: "cancel" }]);
    assert.equal(planTooLargeQuestion({ index: 0, moves: Array.from({ length: 9 }, (_, i) => ({ network: "base" as NetworkKey, label: `m${i}`, steps: 1, auctions: 1 })), room: 8, networkLabel: String }), null,
      "no network's moves fit alone: refused by the caller");
  });

  it("a move of an abstract goal is a moves confirm even when it is the only one", () => {
    const step: WorkStep & { movesConfirm?: true } = { kind: { v: "bridge", by: "derived" }, amount: { v: { t: "exact", value: "25" }, by: "assumed" } };
    step.movesConfirm = true;
    const action: ResolvedAction = { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "25" };
    assert.deepEqual(movesReason({ actions: [action], steps: [step], origins: [{ step: 0, goal: true }], thirdParty: () => false, balance: () => undefined }),
      { kind: "computed", action: 0, network: "base", symbol: "USDC" });
  });
});

/* ------------------------------------------------------------------ rebalance */

describe("abstract goals: rebalance", () => {
  const usdc = { symbol: "USDC" };
  const networks = (a: number, b: number): Goal["targets"] => ({ axis: "network", weights: [{ key: "base", bps: a }, { key: "arbitrum", bps: b }] });

  it("even out my usdc between base and arbitrum (two_usdc 200/150): one bridge of 25 USDC, confirmed with the move listed", () => {
    const result = solve("two_usdc", goalOf({ kind: "rebalance", spend: { asset: usdc }, targets: networks(5000, 5000) }));
    assert.deepEqual(result.questions, []);
    assert.deepEqual(kinds(result), ["bridge@base->arbitrum USDC"]);
    assert.deepEqual(result.steps[0]?.amount?.v, { t: "exact", value: "25" });
    assert.equal(result.steps[0]?.amount?.why?.code, "solver.target-amount");
    assert.ok(flagged(result.steps[0]));
    assert.match(result.assumptions[0]?.label ?? "", /^Rebalances USDC 50\/50$/u);
    assert.ok(result.assumptions[0]?.material);
    assert.match(confirmsMoves("two_usdc", result.steps), /Bridge 25 USDC from Base to Arbitrum One/u);
  });

  it("refuses when already within 1% or $1, when a weight network cannot be read, and when the shares do not add up", () => {
    assert.match(refusal(() => solve("two_usdc", goalOf({ kind: "rebalance", spend: { asset: usdc }, targets: networks(5700, 4300) }))).message, /already within 1%/u);
    assert.match(refusal(() => solve("two_usdc", goalOf({ kind: "rebalance", spend: { asset: usdc }, targets: networks(5000, 5000) }), { unknownNetworks: ["arbitrum"] })).message,
      /could not read your USDC on Arbitrum One/u);
    assert.match(refusal(() => solve("two_usdc", goalOf({ kind: "rebalance", spend: { asset: usdc }, targets: networks(5000, 4000) }))).message, /add up to 100%/u);
    assert.match(refusal(() => solve("two_usdc", goalOf({ kind: "rebalance", spend: { asset: usdc } }))).message, /Say the split you want/u);
    assert.match(refusal(() => solve("two_usdc", goalOf({ kind: "rebalance", targets: networks(5000, 5000) }))).message, /Say one token/u);
  });

  it("keeps the fee reserve when it spreads the gas token itself", () => {
    // full: 0.05 ETH on Base, 0.01 on Arbitrum One; 50/50 moves 0.02 (well inside what the reserve leaves).
    const result = solve("full", goalOf({ kind: "rebalance", spend: { asset: { symbol: "ETH" } }, targets: networks(5000, 5000) }));
    assert.deepEqual(kinds(result), ["bridge@base->arbitrum ETH"]);
    assert.deepEqual(result.steps[0]?.amount?.v, { t: "exact", value: "0.02" });
    // Ethereum's 0.002 ETH is all inside its 0.003 fee reserve: moving it all to Base is refused, never planned short.
    const away = goalOf({ kind: "rebalance", spend: { asset: { symbol: "ETH" } }, targets: { axis: "network", weights: [{ key: "ethereum", bps: 0 }, { key: "base", bps: 10_000 }] } });
    assert.match(refusal(() => solve("full", away)).message, /keeps 0\.003 ETH on Ethereum for network fees/u);
  });

  it("rebalance to 50/50 eth usdc on arbitrum (wide): sells the surplus ETH for USDC by USD value, one confirmed swap", () => {
    const goal = goalOf({ kind: "rebalance", targets: { axis: "asset", scope: on("arbitrum"), weights: [{ key: "ETH", bps: 5000 }, { key: "USDC", bps: 5000 }] } });
    const result = solve("wide", goal);
    assert.deepEqual(kinds(result), ["swap@arbitrum ETH->USDC"]);
    // 2 ETH ($6,825) and 500 USDC: half of $7,325 each, so $3,162.50 of ETH is sold.
    assert.deepEqual(result.steps[0]?.amount?.v, { t: "exact", value: "0.926739" });
    assert.ok(flagged(result.steps[0]));
    assert.match(confirmsMoves("wide", result.steps), /Swap 0\.926739 ETH to USDC on Arbitrum One/u);
  });

  it("go 100% stablecoins on base (wide): every other holding is sold into USDC, the gas reserve stays, each move listed", () => {
    const goal = goalOf({ kind: "rebalance", targets: { axis: "asset", scope: on("base"), weights: [{ key: "any-stable", bps: 10_000 }] } });
    const prices = { prices: { wstETH: 4000, cbETH: 3600 } };
    const result = solve("wide", goal, prices);
    assert.deepEqual(kinds(result), ["swap@base ETH->USDC", "swap@base wstETH->USDC", "swap@base cbETH->USDC"]);
    assert.deepEqual(result.steps[0]?.amount?.v, { t: "exact", value: "1.9995" }, "2 ETH minus Base's 0.0005 fee reserve");
    assert.ok(result.steps.every(flagged));
    confirmsMoves("wide", result.steps, prices);
    assert.match(refusal(() => solve("wide", goal)).message, /could not price wstETH/u, "an unpriced holding refuses: the split cannot be computed");
  });

  it("asks which network when the asset split's scope spans several, and plans the answered one", () => {
    const goal = goalOf({ kind: "rebalance", targets: { axis: "asset", weights: [{ key: "ETH", bps: 5000 }, { key: "USDC", bps: 5000 }] } });
    const asked = solve("wide", goal);
    assert.equal(asked.questions[0]?.reason, "SCOPE_AMBIGUOUS");
    assert.ok(asked.questions[0]?.options.some((option) => option.value.network === "arbitrum"));
    const answered = solve("wide", { ...goal, want: { at: on("arbitrum") } });
    assert.deepEqual(kinds(answered), ["swap@arbitrum ETH->USDC"]);
  });
});

/* ----------------------------------------------------------- atLeast / exactly */

describe("abstract goals: atLeast and exactly targets", () => {
  const solanaSol = { asset: { symbol: "SOL" }, at: on("solana"), mode: "atLeast" as const };

  it("make sure I have enough SOL for fees: refused when the fee reserve is already held, else only the difference is bought", () => {
    assert.match(refusal(() => solve("sol_only", goalOf({ kind: "fuel", want: solanaSol }))).message, /already hold 2\.5 SOL on Solana/u);
    const low = { balances: { "solana:SOL": "0.001" } };
    const result = solve("sol_only", goalOf({ kind: "fuel", want: solanaSol }), low);
    assert.deepEqual(kinds(result), ["swap@solana USDC->SOL"]);
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(chip?.label, "Tops up 0.009 SOL on Solana");
    assert.match(chip?.reason ?? "", /You hold 0\.001 of the 0\.01 SOL/u);
    assert.match(chip?.reason ?? "", /fee reserve on Solana/u);
    assert.equal(plans("sol_only", result.steps, low).split(" ")[0], "swap@solana");
  });

  it("prepare 100 usdc on optimism: asks where the money comes from (a network the person did not name), then moves only the difference", () => {
    const goal = goalOf({ kind: "relocate", want: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "100" }, at: on("optimism"), mode: "atLeast" } });
    const asked = solve("full", goal);
    assert.equal(asked.questions[0]?.reason, "FUNDS_ELSEWHERE");
    const result = solve("full", goal, { balances: { "optimism:USDC": "40" } }, { source: "base", asset: "USDC" });
    assert.deepEqual(kinds(result), ["bridge@base->optimism USDC"]);
    assert.deepEqual(result.steps[0]?.amount?.v, { t: "exact", value: "60" });
    assert.match(result.assumptions.find((entry) => entry.field === "actions[0].amount")?.label ?? "", /^Tops up 60 USDC on OP Mainnet$/u);
    assert.match(refusal(() => solve("full", goal, { balances: { "optimism:USDC": "100" } })).message, /already hold 100 USDC/u);
    assert.match(refusal(() => solve("full", goal, { unknownNetworks: ["optimism"] })).message, /could not read your USDC on OP Mainnet/u, "unknown is never zero");
  });

  it("make sure vitalik.eth gets exactly 50 usdc on arbitrum: one exact transfer from USDC already there; refused when only a crossing could pay it", () => {
    assert.equal(EXACT_DELIVERY_PLANNED, false);
    const goal = goalOf({ kind: "deliver", holder: { t: "name", value: "vitalik.eth" }, want: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "50" }, at: on("arbitrum"), mode: "exactly" } });
    const result = solve("two_usdc", goal);
    assert.equal(plans("two_usdc", result.steps), "transfer@arbitrum 50 USDC to vitalik.eth");
    assert.equal(result.steps[0]?.amount?.by, "user", "the stated amount is what is sent");
    assert.match(refusal(() => solve("full", goal)).message, /receives exactly 50 USDC on Arbitrum One only from USDC already there, and you hold 30/u);
  });

  it("get me $50 of ETH on base: the dollar target is read at the ETH price, then back-solved into USDC", () => {
    const result = solve("evm_base", goalOf({ kind: "acquire", want: { asset: { symbol: "ETH" }, amount: { t: "usd", value: "50" }, at: on("base") } }));
    assert.deepEqual(kinds(result), ["swap@base USDC->ETH"]);
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(chip?.label, "$50 read as 0.014653 ETH");
    assert.match(chip?.reason ?? "", /At \$3,412\.50 per ETH and \$1\.00 per USDC/u);
    assert.ok(Number((result.steps[0]?.amount?.v as { value: string }).value) > 50);
  });
});

/* ------------------------------------------------- home network, crossing leg */

describe("abstract goals: conversions on the home network and the abstract crossing leg", () => {
  it("swap 10 usdc on base to sol: lands on Solana as one crossing leg (route picked by live quotes), never two steps chosen by static costs", () => {
    const goal = goalOf({ kind: "convert", op: "swap", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "10" }, from: on("base") }, want: { asset: { symbol: "SOL" } } });
    const result = solve("full", goal);
    assert.deepEqual(kinds(result), ["bridge@base->solana USDC->SOL"]);
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].toNetwork");
    assert.equal(chip?.label, "Bridges Base to Solana as SOL");
    assert.match(chip?.reason ?? "", /^Route picked by live quotes at planning; /u);
    assert.equal(plans("full", result.steps), "bridge@base->solana 10 USDC->SOL");
  });

  it("convert usdc on base to eth: ETH is listed on Base, so it stays a swap there", () => {
    const result = solve("full", goalOf({ kind: "convert", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "10" }, from: on("base") }, want: { asset: { symbol: "ETH" } } }));
    assert.deepEqual(kinds(result), ["swap@base USDC->ETH"]);
  });

  it("a wanted asset listed on several other networks asks where it should land", () => {
    const result = solve("full", goalOf({ kind: "convert", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "10" }, from: on("solana") }, want: { asset: { symbol: "wstETH" } } }));
    assert.equal(result.questions[0]?.reason, "DESTINATION_MISSING");
  });

  it("every route between two networks with a token change is one leg when a one-shot venue exists; no route returns to a network it left", () => {
    const graph = capabilityGraph();
    const source = [...graph.nodes.values()].find((node) => node.network === "base" && node.symbol === "USDC" && node.custody.kind === "wallet");
    assert.ok(source, "USDC on Base is listed");
    const routes = searchRoutes({
      graph, accounts: fixtureWallet("full").accounts, kinds: new Set(["swap", "bridge"]),
      sources: [{ node: source, valueUsd: 10, amount: "10", status: "known", position: false }],
      isTarget: (node) => node.network === "solana" && node.symbol === "SOL" && node.custody.kind === "wallet",
    });
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const networks = [route.source.node.network, ...route.hops.map((hop) => hop.to.network)];
      const left = new Set<string>();
      networks.forEach((network, index) => {
        if (index > 0 && network !== networks[index - 1]) {
          assert.ok(!left.has(network), `${route.id} returns to ${network}`);
          left.add(networks[index - 1] as string);
        }
      });
      const crossings = route.hops.filter((hop) => hop.edge.kind === "bridge");
      assert.equal(crossings.length, 1, route.id);
      assert.equal(route.hops.length, 1, `${route.id}: the crossing is one leg`);
    }
  });
});

/* -------------------------------------------------------------- exposure */

describe("abstract goals: exposure classes", () => {
  const prices = { prices: { wstETH: 4000, cbETH: 3600, cbBTC: 100_000 } };
  const exposure = (cls: string, symbol: string, amount: string): Goal => goalOf({
    kind: "acquire", spend: { asset: { symbol }, amount: { t: "exact", value: amount }, from: on("base") }, want: { asset: { class: cls } as unknown as AssetSel },
  });

  it("eth staking exposure on base: buys a liquid staking token there, shown as a material chip with the other tokens", () => {
    const result = solve("wide", exposure("eth-lst", "ETH", "0.1"), prices);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.kind?.v, "swap");
    assert.equal(result.steps[0]?.network?.v, "base");
    const chip = result.assumptions.find((entry) => /^Holds /u.test(entry.label));
    assert.ok(chip?.material);
    assert.ok(["wstETH", "cbETH"].includes(result.steps[0]?.to?.v ?? ""));
  });

  it("the token with the best compared 7-day rate leads", () => {
    const snapshot = snapshotOf("wide", prices);
    const stakes = new Map([["ETH" as const, [
      { provider: "lido", network: "ethereum" as NetworkKey, lst: "wstETH", smoothedApy: 0.028, tvlUsd: 9e9 },
      { provider: "coinbase", network: "ethereum" as NetworkKey, lst: "cbETH", smoothedApy: 0.031, tvlUsd: 2e9 },
    ]]]);
    const result = solve("wide", exposure("eth-lst", "ETH", "0.1"), {}, undefined, { ...snapshot, stakes });
    assert.ok(result.steps.length > 0);
    const lead = result.steps[result.steps.length - 1]?.to?.v;
    assert.ok(lead === "wstETH" || lead === "cbETH");
  });

  it("hold btc on base: cbBTC, the bitcoin Kletia lists there (material chip)", () => {
    const result = solve("wide", exposure("btc", "USDC", "100"), prices);
    assert.deepEqual(kinds(result), ["swap@base USDC->cbBTC"]);
    assert.equal(result.assumptions.find((entry) => /^Holds /u.test(entry.label))?.label, "Holds cbBTC");
  });
});

/* ------------------------------------------------------------- exit-all */

describe("abstract goals: exit-all", () => {
  const exitAll = (network?: NetworkKey) => goalOf({ kind: "exit", spend: { from: { ...(network ? { network } : {}), custody: { kind: "position", category: "lending" } } } });

  function lender(extra: { readonly venue: string; readonly amount: string; readonly status?: "known" | "unknown" }[]): Snapshot {
    const snapshot = snapshotOf("full");
    const positions = [...snapshot.positions];
    for (const entry of extra) {
      const venue = YIELD_VENUES.find((candidate) => candidate.id === entry.venue);
      assert.ok(venue, entry.venue);
      positions.push(entry.status === "unknown"
        ? { venue: venue.id, network: venue.network, protocol: venue.protocol, symbol: venue.asset, status: "unknown", usd: null, apy: null, reason: "read-failed" }
        : { venue: venue.id, network: venue.network, protocol: venue.protocol, symbol: venue.asset, status: "known", units: entry.amount, formatted: entry.amount, decimals: 6, usd: Number(entry.amount), apy: null });
    }
    return { ...snapshot, positions };
  }

  it("exit all my lending positions: one withdraw of each whole position, every move confirmed, wallet tokens stay", () => {
    const snapshot = lender([{ venue: "base:morpho:steakhouse-prime-usdc", amount: "40" }, { venue: "arbitrum:aave-v3:usdc", amount: "20" }]);
    const result = solve("full", exitAll(), {}, undefined, snapshot);
    assert.deepEqual(result.questions, []);
    assert.equal(result.steps.length, 3);
    assert.ok(result.steps.every((step) => step.kind?.v === "withdraw" && step.amount?.v.t === "position" && step.amount.v.bps === 10_000));
    assert.ok(result.steps.every(flagged));
    assert.equal(result.assumptions[0]?.label, "Withdraws 3 positions");
    assert.match(result.assumptions[0]?.reason ?? "", /Wallet tokens stay where they are/u);
  });

  it("close everything on base: only the positions on Base", () => {
    const snapshot = lender([{ venue: "base:morpho:steakhouse-prime-usdc", amount: "40" }, { venue: "arbitrum:aave-v3:usdc", amount: "20" }]);
    const result = solve("full", exitAll("base"), {}, undefined, snapshot);
    assert.equal(result.steps.length, 2);
    assert.ok(result.steps.every((step) => step.network?.v === "base"));
  });

  it("a network whose positions could not be read is named and asked about, never treated as empty", () => {
    const snapshot = lender([{ venue: "arbitrum:aave-v3:usdc", amount: "0", status: "unknown" }]);
    const asked = solve("full", exitAll(), {}, undefined, snapshot);
    assert.equal(asked.questions[0]?.reason, "SCOPE_AMBIGUOUS");
    assert.match(asked.questions[0]?.prompt ?? "", /could not read your positions on Arbitrum One/u);
    assert.deepEqual(asked.questions[0]?.options.map((option) => option.value.target), ["all", "cancel"]);
    const result = solve("full", exitAll(), {}, { scope: "all" }, snapshot);
    assert.equal(result.steps.length, 1);
    assert.match(result.assumptions[0]?.reason ?? "", /could not read Arbitrum One; nothing there is withdrawn/u);
    assert.match(confirmsMoves("full", result.steps), /Withdraw all USDC from Aave V3 on Base/u);
  });
});

/* ---------------------------------------------------------------- dust */

describe("abstract goals: dust sweeps", () => {
  const dust = (maxUsdEach?: string) => goalOf({ kind: "consolidate", spend: { filter: maxUsdEach ? { maxUsdEach } : {} }, want: { asset: { symbol: "USDC" }, at: on("base") } });
  const small = { balances: { "base:DAI": "2", "base:EURC": "3", "base:AERO": "4" }, prices: { AERO: 1 } };

  it("sweep my dust into usdc on base: every holding worth $5 or less, the gas tokens stay, every conversion confirmed", () => {
    const result = solve("full", dust(), small);
    assert.deepEqual(kinds(result).sort(), ["swap@base AERO->USDC", "swap@base DAI->USDC", "swap@base EURC->USDC"]);
    assert.ok(result.steps.every((step) => step.amount?.v.t === "balance" && step.amount.v.bps === 10_000));
    assert.ok(result.steps.every(flagged));
    assert.match(result.assumptions[0]?.label ?? "", /^Sweeps 3 small holdings into USDC$/u);
    assert.match(result.assumptions[0]?.reason ?? "", /Gas tokens stay/u);
    confirmsMoves("full", result.steps, small);
  });

  it("lists what it skips (no price), honours the cap, and refuses when nothing is left to sweep", () => {
    const unpriced = solve("full", dust(), { ...small, prices: { AERO: null } });
    assert.equal(unpriced.steps.length, 2);
    assert.match(unpriced.assumptions[0]?.reason ?? "", /Skipped: AERO on Base \(no price\)/u);
    const capped = solve("full", dust("2.5"), small);
    assert.deepEqual(kinds(capped), ["swap@base DAI->USDC"]);
    assert.match(refusal(() => solve("evm_base", dust())).message, /^Nothing to sweep into USDC/u);
  });

  it("asks what to sweep into, and where, when the goal does not say", () => {
    assert.equal(solve("full", goalOf({ kind: "consolidate", spend: { filter: {} }, want: { at: on("base") } })).questions[0]?.reason, "OUTPUT_ASSET_MISSING");
    assert.equal(solve("full", goalOf({ kind: "consolidate", spend: { filter: {} }, want: { asset: { symbol: "USDC" } } })).questions[0]?.reason, "DESTINATION_MISSING");
  });
});

/* -------------------------------------------------- cheapest-path payment */

describe("abstract goals: cheapest-path payments", () => {
  it("cheapest way to send 20 usdc to vitalik.eth: the receiving network is asked, cheapest first, with what each costs", () => {
    const goal = goalOf({ kind: "deliver", holder: { t: "name", value: "vitalik.eth" }, spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "20" } }, constraints: { prefer: "cheapest" } });
    const result = solve("full", goal);
    const question = result.questions[0];
    assert.equal(question?.reason, "TRANSFER_NETWORK");
    assert.equal(question?.options[0]?.id, "base");
    assert.match(question?.options[0]?.detail ?? "", /^From your USDC there · /u);
    assert.ok(question?.options.some((option) => /^Bridges from /u.test(option.detail ?? "")), "networks the money must cross to say so");
    assert.ok(question?.options.every((option) => !option.recommended));
    const answered = solve("full", { ...goal, want: { at: on("base") } });
    assert.equal(plans("full", answered.steps), "transfer@base 20 USDC to vitalik.eth");
  });

  it("a recipient that implies its network (.base.eth) is not asked", () => {
    const goal = goalOf({ kind: "deliver", holder: { t: "name", value: "jesse.base.eth" }, spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "20" } } });
    assert.deepEqual(solve("full", goal).questions, []);
  });
});

/* ------------------------------------------------------------ plan size */

describe("abstract goals: plan-size move counting", () => {
  it("send everything on base to vitalik.eth with more holdings than one plan holds: refused with the moves, never cut", () => {
    const many = { balances: { "base:DAI": "2", "base:EURC": "3", "base:AERO": "4", "base:cbBTC": "0.001", "base:WETH": "0.01", "base:USDbC": "5", "base:wstETH": "0.01", "base:cbETH": "0.01" } };
    const goal = goalOf({ kind: "consolidate", holder: { t: "name", value: "vitalik.eth" }, spend: { from: on("base") }, want: { at: on("base") } });
    const refused = refusal(() => solve("wide", goal, many));
    assert.equal(refused.code, "PLAN_TOO_LARGE");
  });

  it("move all my stables to arbitrum with more moves than one plan holds: asks which network's moves to plan now", () => {
    const many = { balances: { "ethereum:DAI": "10", "base:DAI": "10", "base:EURC": "10", "polygon:DAI": "10" } };
    const goal = goalOf({ kind: "relocate", spend: { asset: { class: "any-stable" }, amount: { t: "max" } }, want: { at: on("arbitrum") } });
    // "all my stables" across networks asks the scope first (D4); the answer "every network" is more than one plan holds.
    assert.equal(solve("wide", goal, many).questions[0]?.reason, "SCOPE_AMBIGUOUS");
    const result = solve("wide", goal, many, { scope: "all" });
    const question = result.questions[0];
    assert.equal(question?.reason, "PLAN_TOO_LARGE");
    assert.ok((question?.options.length ?? 0) >= 2);
    assert.equal(question?.options.at(-1)?.value.target, "cancel");
    const network = question?.options[0]?.value.source as NetworkKey;
    const answered = solve("wide", { ...goal, spend: { ...goal.spend, from: on(network) } }, many, { scope: "all" });
    assert.deepEqual(answered.questions, []);
    assert.ok(answered.steps.length > 0 && answered.steps.every((step) => step.network?.v === network));
  });
});
