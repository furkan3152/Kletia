/**
 * Goal solver: the decision table (intent engine v2 §4.6, package P4), one
 * test per row D0-D14, on the clarify corpus' fixture wallets with stub
 * prices. Questions are checked against the clarify invariants (at most 8
 * options, labels within limits, purpose reasons never suggested); every
 * ready expansion round-trips through the policy, the canonical sentence and
 * the grammar. Offline: nothing reads a network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLARIFY_LIMITS, PURPOSE_REASONS, UNSUGGESTED_REASONS, type Goal } from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import { shape } from "../clarify/corpusHarness.js";
import type { Question, WorkStep } from "../clarify/types.js";
import { readGoals } from "../goal/index.js";
import { capabilityGraph, walletNodeId } from "../solver/graph.js";
import { chooseRoute, type GoalPins, type GoalReadNotes } from "../solver/decide.js";
import { searchRoutes, solveGoals, type SolveResult } from "../solver/index.js";
import { fixtureWallet, goalOf, runPolicy, snapshotOf, type SnapshotOptions } from "./solverFixtures.js";

const APY = { "base:aave-v3:usdc": 0.041, "base:morpho:steakhouse-prime-usdc": 0.05, "base:compound-v3:usdc": 0.038 } as const;

interface Run {
  readonly reads?: readonly (GoalReadNotes | undefined)[];
  readonly pins?: readonly (GoalPins | undefined)[];
  readonly snapshot?: SnapshotOptions;
}

function solve(wallet: string, goals: readonly Goal[], run: Run = {}): SolveResult {
  const result = solveGoals(goals, snapshotOf(wallet, run.snapshot ?? { apy: APY }), {
    accounts: fixtureWallet(wallet).accounts,
    ...(run.reads ? { reads: run.reads } : {}),
    ...(run.pins ? { pins: run.pins } : {}),
  });
  for (const question of result.questions) checkQuestion(question);
  return result;
}

function text(sentence: string): { goals: Goal[]; reads: GoalReadNotes[] } {
  const read = readGoals(sentence);
  assert.ok(read.every((entry) => entry !== null), sentence);
  return { goals: read.map((entry) => entry!.goal), reads: read.map((entry) => ({ orderOnly: entry!.notes.orderOnly, possessive: entry!.notes.possessive })) };
}

/** The clarify invariants every question keeps. */
function checkQuestion(question: Question): void {
  assert.ok(question.options.length <= CLARIFY_LIMITS.optionsPerQuestion, `${question.reason}: at most 8 options`);
  assert.ok(question.prompt.length <= CLARIFY_LIMITS.prompt && question.why.length <= CLARIFY_LIMITS.why, `${question.reason}: copy within limits`);
  for (const option of question.options) {
    assert.ok(option.label.length <= CLARIFY_LIMITS.optionLabel, `${question.reason}: "${option.label}" within ${CLARIFY_LIMITS.optionLabel}`);
    assert.ok((option.detail ?? "").length <= CLARIFY_LIMITS.optionDetail);
  }
  assert.ok(question.options.filter((option) => option.recommended).length <= 1, "at most one suggestion");
  if (UNSUGGESTED_REASONS.has(question.reason)) assert.ok(question.options.every((option) => !option.recommended), `${question.reason} never suggests`);
  assert.match(question.field, /^actions\[[0-7]\]\.[a-zA-Z]{1,24}$/u);
}

function planned(wallet: string, steps: readonly WorkStep[]): string {
  const run = runPolicy(wallet, steps);
  assert.deepEqual(run.analysis.questions.map((question) => `${question.field}:${question.reason}`), []);
  assert.ok(run.analysis.resolved && run.sentence);
  assert.deepEqual(run.roundTrip, [], `"${run.sentence}" compiles to the same actions`);
  return shape(run.analysis.resolved);
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

describe("goal solver: decision table", () => {
  it("D0: no route and no funds elsewhere is refused with the closest sentence", () => {
    const goal = goalOf({ kind: "relocate", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "5" } }, want: { at: { network: "base", custody: { kind: "wallet" } } } });
    const error = refusal(() => solve("sol_only", [goal]));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /Try a sentence such as "bridge 10 USDC from arbitrum to base"/u);
    assert.equal(refusal(() => solve("full", [goalOf({ kind: "rebalance" })])).code, "INTENT_UNSUPPORTED");
  });

  it("D0: no route from the named network but funds elsewhere asks FUNDS_ELSEWHERE", () => {
    const goal = goalOf({ kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "5" }, from: { network: "ethereum", custody: { kind: "wallet" } } }, want: { at: { network: "base", custody: { kind: "venue", protocol: "aave-v3" } } } });
    const result = solve("full", [goal]);
    assert.equal(result.questions[0]?.reason, "FUNDS_ELSEWHERE");
    assert.deepEqual(result.questions[0]?.options.map((option) => option.value.source), ["base", "arbitrum", "solana"]);
    assert.equal(result.steps.length, 0);
  });

  it("D1: a nickname or 'my other wallet' is asked, never completed", () => {
    for (const holder of [{ t: "nickname" }, { t: "selfOther" }] as const) {
      const result = solve("full", [goalOf({ kind: "deliver", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "5" } }, holder })]);
      assert.equal(result.questions[0]?.reason, "RECIPIENT_MISSING");
      assert.equal(result.questions[0]?.options.length, 0);
      assert.ok(PURPOSE_REASONS.has("RECIPIENT_MISSING"));
    }
  });

  it("D2: an amount above every known balance asks AMOUNT_EXCEEDS_BALANCE, with the funds elsewhere", () => {
    const { goals, reads } = text("deposit 100 USDC into aave on base");
    const result = solve("low_evm", goals, { reads });
    const question = result.questions[0];
    assert.equal(question?.reason, "AMOUNT_EXCEEDS_BALANCE");
    assert.equal(question?.field, "actions[0].amount");
    assert.deepEqual(question?.options.map((option) => option.id), ["all", "solana", "keep"]);
    assert.ok(PURPOSE_REASONS.has("AMOUNT_EXCEEDS_BALANCE"));
    // Unknown is never zero: an unread balance is not a shortfall.
    const unknown = solve("low_evm", goals, { reads, snapshot: { unknownNetworks: ["base"] } });
    assert.notEqual(unknown.questions[0]?.reason, "AMOUNT_EXCEEDS_BALANCE");
    // The answer pins the source: the funds on Solana are bridged first.
    const pinned = solve("low_evm", goals, { reads, pins: [{ source: "solana" }] });
    assert.match(planned("low_evm", pinned.steps), /^bridge@solana->base 100 USDC \| deposit@base max USDC \[aave-v3\]$/u);
  });

  it("D3: candidates spending different assets pick the exposure-neutral one (chip), else ask", () => {
    const { goals, reads } = text("get me 0.01 ETH on arbitrum");
    // C.1 rule 3: the funds would come from a network the person did not name, so where is asked first, the
    // exposure-neutral holding listed first; each option pins the holding its label names.
    const where = solve("full", goals, { reads });
    assert.equal(where.questions[0]?.reason, "FUNDS_ELSEWHERE");
    assert.equal(where.questions[0]?.options[0]?.label, "Use ETH on Base");
    assert.deepEqual(where.questions[0]?.options[0]?.value, { source: "base", asset: "ETH" });
    const neutral = solve("full", goals, { reads, pins: [{ source: "base" }] });
    const chip = neutral.assumptions.find((entry) => entry.field === "actions[0].from");
    assert.ok(chip?.material);
    assert.ok((chip?.alternatives.length ?? 0) > 0, "the other assets are one tap away");
    assert.equal(planned("full", neutral.steps), "bridge@base->arbitrum 0.01 ETH");
    const asked = solve("full", [goalOf({ kind: "acquire", want: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "0.1" }, at: { network: "solana", custody: { kind: "wallet" } } } })]);
    assert.equal(asked.questions[0]?.reason, "INPUT_ASSET_MISSING");
    assert.ok((asked.questions[0]?.options.length ?? 0) >= 2);
    assert.ok(asked.questions[0]?.options.every((option) => option.value.asset && option.value.source));
  });

  it("D4: a possessive scope on several networks asks SCOPE_AMBIGUOUS; one network above the share is used (chip)", () => {
    const { goals, reads } = text("put my USDC to work");
    const asked = solve("full", goals, { reads });
    const question = asked.questions[0];
    assert.equal(question?.reason, "SCOPE_AMBIGUOUS");
    assert.equal(question?.field, "actions[0].network");
    assert.deepEqual(question?.options.map((option) => option.id), ["all", "base", "arbitrum", "solana"]);
    // One network holds nearly everything: it is used, and what stays is said.
    const dominant = solve("low_evm", goals, { reads });
    assert.deepEqual(dominant.questions, []);
    const scope = dominant.assumptions.find((entry) => entry.field === "actions[0].network" && entry.source === "balance");
    assert.match(scope?.label ?? "", /400 USDC on Solana/u);
    assert.match(scope?.reason ?? "", /stays/u);
    // Answers: one network, or every network (one route per network).
    assert.equal(planned("full", solve("full", goals, { reads, pins: [{ source: "base" }] }).steps), "deposit@base 120.4 USDC [aave-v3]");
    const all = solve("full", goals, { reads, pins: [{ scope: "all" }] });
    assert.equal(all.outcomes[0]?.routes.length, 3);
    assert.match(planned("full", all.steps), /^deposit@base 120\.4 USDC \[aave-v3\] \| deposit@arbitrum 30 USDC \[[\w-]+\] \| deposit@solana 12 USDC \[[\w-]+\]$/u);
  });

  it("D5: staking or lending asks EARN_KIND; the answer picks the category", () => {
    const { goals, reads } = text("earn on my SOL");
    const asked = solve("full", goals, { reads });
    assert.equal(asked.questions[0]?.reason, "EARN_KIND");
    assert.deepEqual(asked.questions[0]?.options.map((option) => option.value.kind), ["stake", "deposit"]);
    assert.ok(PURPOSE_REASONS.has("EARN_KIND"));
    assert.match(planned("full", solve("full", goals, { reads, pins: [{ earnKind: "staking" }] }).steps), /^stake@solana 2\.4\d* SOL->JitoSOL \{jito\}$/u);
    assert.match(planned("full", solve("full", goals, { reads, pins: [{ earnKind: "lending" }] }).steps), /^deposit@solana 2\.4\d* SOL \[(kamino|jupiter-lend)\]$/u);
  });

  it("D6: one category picks the best risk-adjusted APY (chip); unknown APYs across risk tiers ask VENUE_MISSING", () => {
    const { goals, reads } = text("earn yield on 100 USDC");
    const result = solve("full", goals, { reads });
    assert.equal(planned("full", result.steps), "deposit@base 100 USDC [aave-v3]");
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].protocol");
    assert.match(chip?.label ?? "", /4\.1% APY/u);
    assert.ok((chip?.alternatives.length ?? 0) > 0);
    // Two venues of different tiers with no APY: asked (a means question, one suggestion).
    const graph = capabilityGraph();
    const source = { node: graph.nodes.get(walletNodeId("base", "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"))!, valueUsd: 100, amount: "120.4", status: "known" as const, position: false };
    const routes = searchRoutes({
      graph, sources: [source], kinds: new Set(["deposit"] as const), accounts: fixtureWallet("full").accounts,
      isTarget: (node) => node.custody.kind === "venue" && node.network === "base" && node.symbol === "USDC",
    });
    const core = routes.find((route) => route.risk === "core");
    const curated = routes.find((route) => route.risk === "curated");
    assert.ok(core && curated);
    const choice = chooseRoute({ goal: goals[0]!, index: 0, routes: [core, curated], assetNamed: true, sourceNamed: true });
    assert.equal(choice.kind, "ask");
    const question = choice.kind === "ask" ? choice.questions[0] : undefined;
    assert.equal(question?.reason, "VENUE_MISSING");
    checkQuestion(question!);
    assert.equal(question?.options.filter((option) => option.recommended).length, 1);
  });

  it("D7: the same asset on several networks: the cheaper source is chosen and shown", () => {
    const { goals, reads } = text("pay vitalik.eth 5 USDC from whatever network is cheapest");
    // I13 (A.6 cheapest-path payment): where vitalik.eth receives is purpose, asked with each network's cost, cheapest first.
    const asked = solve("full", goals, { reads });
    assert.equal(asked.questions[0]?.reason, "TRANSFER_NETWORK");
    assert.equal(asked.questions[0]?.options[0]?.id, "base", "the cheapest receiving network first");
    assert.match(asked.questions[0]?.options[0]?.detail ?? "", /^From your USDC there · /u);
    const answered = goals.map((goal) => ({ ...goal, want: { ...goal.want, at: { network: "base" as const, custody: { kind: "wallet" as const } } } }));
    const result = solve("full", answered, { reads });
    assert.equal(planned("full", result.steps), "transfer@base 5 USDC to vitalik.eth");
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].network");
    assert.equal(chip?.label, "From Base");
    assert.deepEqual(chip?.alternatives.map((option) => option.value.source), ["arbitrum", "solana"], "every other network holding enough USDC");
    assert.equal(result.steps[0]?.network?.by, "user", "the receiving network is the answered one");
  });

  it("D8: a bridge the person did not ask for is shown once its source is answered, and never pinned to a venue", () => {
    const { goals, reads } = text("I need 20 USDC on arbitrum");
    // C.1 rule 3: the source network was not named, so it is asked (FUNDS_ELSEWHERE), never a chip.
    const asked = solve("full", goals, { reads });
    assert.equal(asked.questions[0]?.reason, "FUNDS_ELSEWHERE");
    assert.equal(asked.questions[0]?.field, "actions[0].network");
    const result = solve("full", goals, { reads, pins: [{ source: "base", asset: "USDC" }] });
    assert.deepEqual(result.questions, []);
    const chip = result.assumptions.find((entry) => entry.field === "actions[0].toNetwork");
    assert.match(chip?.label ?? "", /^Bridges Base to Arbitrum One$/u);
    assert.equal(result.steps[0]?.protocol, undefined);
  });

  it("D9: a misspelt symbol asks ASSET_TYPO with the correction suggested", () => {
    const goal = goalOf({ kind: "convert", spend: { asset: { symbol: "SLO" }, amount: { t: "exact", value: "1" } }, want: { asset: { symbol: "USDC" } } });
    const result = solve("full", [goal], { reads: [{ typo: { side: "spend", raw: "SLO", candidates: ["SOL"] } }] });
    const question = result.questions[0];
    assert.equal(question?.reason, "ASSET_TYPO");
    assert.equal(question?.field, "actions[0].from");
    assert.deepEqual(question?.options.map((option) => [option.id, option.recommended ?? false]), [["SOL", true], ["cancel", false]]);
  });

  it("D10: a look-alike that covers the amount is left to the policy's ASSET_LOOKALIKE (not D2)", () => {
    const goal = goalOf({ kind: "deliver", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "100" } }, want: { at: { network: "base", custody: { kind: "wallet" } } }, holder: { t: "name", value: "vitalik.eth" } });
    const result = solve("lookalike", [goal]);
    assert.deepEqual(result.questions, []);
    const run = runPolicy("lookalike", result.steps);
    assert.equal(run.analysis.questions[0]?.reason, "ASSET_LOOKALIKE");
  });

  it("D11: a dollar amount of a token is priced (chip); without a usable price the amount is asked", () => {
    const { goals, reads } = text("swap $50 of SOL to USDC");
    const priced = solve("full", goals, { reads });
    assert.equal(planned("full", priced.steps), "swap@solana 0.331081 SOL->USDC");
    const chip = priced.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(chip?.source, "price");
    assert.match(chip?.reason ?? "", /\$151\.02 per SOL \(Jupiter/u);
    assert.equal(priced.steps[0]?.amount?.why?.code, "price.usd");
    const unpriced = solve("full", goals, { reads, snapshot: { prices: { SOL: null } } });
    assert.equal(unpriced.questions[0]?.reason, "AMOUNT_MISSING");
  });

  it("D12: a role filled by word order alone is confirmed before planning; the answer plans it", () => {
    const goal = goalOf({ kind: "convert", spend: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "1" } }, want: { asset: { symbol: "USDC" } } });
    const asked = solve("full", [goal], { reads: [{ orderOnly: true }] });
    assert.equal(asked.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    assert.match(asked.questions[0]?.prompt ?? "", /^Swap 1 SOL to USDC on Solana\. Is that what you meant\?$/u);
    assert.equal(asked.steps.length, 0);
    assert.equal(asked.outcomes[0]?.steps.length, 1, "the draft is kept for the confirm card");
    const confirmed = solve("full", [goal], { reads: [{ orderOnly: true }], pins: [{ confirmed: true }] });
    assert.equal(planned("full", confirmed.steps), "swap@solana 1 SOL->USDC");
  });

  it("D13: a goal from model-assisted reading is always confirmed, with the neutral disclosure", () => {
    const goal = goalOf({ kind: "convert", spend: { asset: { symbol: "SOL" }, amount: { t: "exact", value: "1" } }, want: { asset: { symbol: "USDC" } }, confidence: "llm" });
    const asked = solve("full", [goal]);
    assert.equal(asked.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    assert.equal(asked.questions[0]?.why, "Model-assisted reading. Kletia plans it only when you confirm.");
    assert.doesNotMatch(asked.questions[0]?.why ?? "", /language model|\bAI\b|LLM/u);
  });

  it("D14: otherwise ready, material chips first; later goals wait for an earlier question", () => {
    const { goals, reads } = text("zap 20 USDC from arbitrum into morpho on base");
    const ready = solve("full", goals, { reads });
    assert.deepEqual(ready.questions, []);
    const firstPlain = ready.assumptions.findIndex((entry) => !entry.material);
    assert.ok(firstPlain === -1 || ready.assumptions.slice(firstPlain).every((entry) => !entry.material), "material chips first");
    const waiting = solve("full", [goalOf({ kind: "deliver", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "1" } }, holder: { t: "nickname" } }), goals[0]!]);
    assert.equal(waiting.outcomes[1]?.status, "pending");
    assert.ok(waiting.questions.length <= 2);
  });
});
