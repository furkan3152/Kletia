/**
 * Goal steps in clarify threads (intent engine v2 §4.4, §4.7, package P5):
 * the policy solves them each turn from the stored Goal, its pins and the
 * turn's snapshot; answers and chip changes become pins; the thread keeps
 * the Goal (no user words) next to a placeholder step. Also the policy rules
 * P5 adds for every step: D2 (amount above the balance), D9 (typo), D11
 * (priced dollar amounts), the venue picked by rate, the L2 stake question
 * and "sell X". Offline: the clarify corpus' fixture wallets and prices.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLARIFY_LIMITS, UNSUGGESTED_REASONS, validateThread, type ClarifyThread } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision, TurnInput } from "../clarify/index.js";
import { extendSnapshotReaders, type SnapshotReaders } from "../solver/snapshot.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));

after(() => uninstallWallet());

/** S8 readers laid over the fixture wallet on every turn of `thread` (null: the corpus harness alone). */
let s8: Partial<SnapshotReaders> | null = null;

interface Step {
  readonly decision?: TurnDecision;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Runs a thread turn by turn on a fixture wallet; each input is text or a structured turn. */
async function thread(wallet: string, ...inputs: (string | TurnInput)[]): Promise<Step[]> {
  const entry = { id: "t", category: "test", title: "t", wallet, turns: [] } as CorpusCase;
  const ctx = contextFor(corpus, entry);
  const out: Step[] = [];
  let current: ClarifyThread | null = null;
  for (const input of inputs) {
    installWallet(corpus, wallet);
    if (s8) extendSnapshotReaders(s8);
    const result = await runTurn(current, typeof input === "string" ? { text: input } : input, ctx);
    out.push(result);
    for (const q of result.decision?.questions ?? []) {
      assert.ok(q.options.length <= CLARIFY_LIMITS.optionsPerQuestion, `${q.reason}: at most 8 options`);
      if (UNSUGGESTED_REASONS.has(q.reason)) assert.ok(q.options.every((option) => !option.recommended), `${q.reason} is never suggested`);
    }
    if (result.decision) {
      current = result.decision.thread;
      assert.ok(validateThread(current).ok, "the thread validates");
    }
  }
  return out;
}

const planOf = (step: Step | undefined) => (step?.decision?.actions ? shape(step.decision.actions) : `${step?.decision?.status ?? step?.error?.code}`);
const asked = (step: Step | undefined) => step?.decision?.questions.map((q) => `${q.field}:${q.reason}`) ?? [];
const answer = (question: string, option: string): TurnInput => ({ answer: { question, option } });
const chip = (id: string, option: string): TurnInput => ({ assumption: { id, option } });

describe("clarify goal steps: thread memory", () => {
  it("a goal thread survives three turns and an answer, keeping the Goal (no user words) beside a placeholder step", async () => {
    // C.1 rule 3: where the ETH for Arbitrum comes from is asked first (no network was named for the funds); each
    // option pins the holding it names, ETH on Base (exposure-neutral) first.
    const [ask] = await thread("full", "get me 0.01 ETH on arbitrum");
    assert.deepEqual(asked(ask), ["actions[0].network:FUNDS_ELSEWHERE"]);
    assert.deepEqual(ask?.decision?.questions[0]?.options.map((option) => option.id).slice(0, 2), ["base:ETH", "base:USDC"]);
    const [, eth] = await thread("full", "get me 0.01 ETH on arbitrum", answer("q.actions.0.network", "base:ETH"));
    assert.equal(planOf(eth), "bridge@base->arbitrum 0.01 ETH");
    const turns = await thread("full", "get me 0.01 ETH on arbitrum", answer("q.actions.0.network", "base:USDC"), "make it 0.02", { none: true });
    assert.match(planOf(turns[1]), /^bridge@base->arbitrum [\d.]+ USDC/u);
    assert.match(planOf(turns[2]), /^bridge@base->arbitrum [\d.]+ USDC/u);
    assert.equal(planOf(turns[3]), planOf(turns[2]), "a commit turn re-solves to the same plan");
    const stored = turns[3]?.decision?.thread as ClarifyThread;
    assert.equal(stored.goals?.length, 1);
    assert.deepEqual(stored.steps, [{}], "the goal step is a placeholder");
    assert.deepEqual(stored.goals?.[0]?.spend.asset, { symbol: "USDC" }, "the answer is pinned in the Goal");
    assert.deepEqual(stored.goals?.[0]?.want.amount, { t: "exact", value: "0.02" });
    assert.ok(!JSON.stringify(stored).includes("get me") && !JSON.stringify(stored).includes("120.4"), "no user words and no facts in the thread");
  });

  it("EARN_KIND is a purpose question; the answer picks staking and the plan follows", async () => {
    const [first, second] = await thread("full", "earn on my SOL", answer("q.actions.0.kind", "stake"));
    assert.deepEqual(asked(first), ["actions[0].kind:EARN_KIND"]);
    assert.ok(first?.decision?.questions[0]?.options.every((option) => !option.recommended), "a purpose question suggests nothing");
    assert.equal(planOf(second), "stake@solana 2.49 SOL->JitoSOL {jito}");
  });

  it("reads positions to exit and to move a position", async () => {
    const [exit] = await thread("full", "exit my aave position");
    assert.equal(planOf(exit), "withdraw@base max USDC [aave-v3]");
    const [move] = await thread("full", "move my aave USDC to morpho");
    assert.match(planOf(move), /^withdraw@base max USDC \[aave-v3\] \| deposit@base max USDC \[morpho/u);
  });

  it("refuses what no route serves (an LST cannot be staked again) and a thread whose goals do not match its steps", async () => {
    const [lst] = await thread("full", "stake my JitoSOL");
    assert.equal(lst?.error?.code, "INTENT_UNSUPPORTED");
    const [ready] = await thread("full", "exit my aave position");
    const broken = { ...(ready?.decision?.thread as ClarifyThread), goals: [] };
    const entry = { id: "t", category: "test", title: "t", wallet: "full", turns: [] } as CorpusCase;
    const result = await runTurn(broken, { none: true }, contextFor(corpus, entry));
    assert.equal(result.error?.code, "THREAD_INVALID");
  });

  it("a goal after a decided step spends what that step lands", async () => {
    const [moved] = await thread("full", "move my arbitrum USDC to base and earn yield");
    assert.match(planOf(moved), /^bridge@arbitrum->base 30 USDC \| deposit@base max USDC \[/u);
  });
});

describe("clarify policy rules of package P5 (every step)", () => {
  it("D2: an amount above the balance asks all, funds elsewhere or keep; each answer plans", async () => {
    const [ask, all] = await thread("full", "swap 3 SOL to USDC", answer("q.actions.0.amount", "all"));
    assert.deepEqual(asked(ask), ["actions[0].amount:AMOUNT_EXCEEDS_BALANCE"]);
    assert.deepEqual(ask?.decision?.questions[0]?.options.map((option) => option.id), ["all", "keep"]);
    assert.equal(planOf(all), "swap@solana 2.49 SOL->USDC");
    const [, elsewhere] = await thread("full", "deposit 100 USDC into aave on arbitrum", answer("q.actions.0.amount", "base"));
    assert.equal(planOf(elsewhere), "bridge@base->arbitrum 100 USDC | deposit@arbitrum max USDC [aave-v3]");
    const [, kept] = await thread("full", "bridge 500 USDC from base to solana", answer("q.actions.0.amount", "keep"));
    assert.equal(planOf(kept), "bridge@base->solana 500 USDC");
    // Unknown is never a shortfall: the preview wallet is not read, so nothing is asked about the balance.
    const [unknown] = await thread("preview", "swap 3 SOL to USDC");
    assert.ok(!asked(unknown).some((entry) => entry.endsWith("AMOUNT_EXCEEDS_BALANCE")));
  });

  it("D9: a misspelt symbol is asked (the correction suggested); 'Neither, cancel' cancels the task", async () => {
    const [typo, fixed] = await thread("full", "swap 1 SLO to USDC", answer("q.actions.0.from", "SOL"));
    assert.deepEqual(asked(typo), ["actions[0].from:ASSET_TYPO"]);
    assert.equal(typo?.decision?.questions[0]?.options.find((option) => option.recommended)?.id, "SOL");
    assert.equal(planOf(fixed), "swap@solana 1 SOL->USDC");
    const [, cancelled] = await thread("full", "swap 1 SLO to USDC", answer("q.actions.0.from", "cancel"));
    assert.equal(cancelled?.decision?.status, "cancelled");
  });

  it("D11: a dollar amount of a token is priced with a material chip; without a price it is asked", async () => {
    const [priced] = await thread("full", "swap $10 of SOL to USDC");
    assert.equal(planOf(priced), "swap@solana 0.066216 SOL->USDC");
    const amount = priced?.decision?.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(amount?.source, "price");
    assert.equal(amount?.material, true);
    const [unpriced] = await thread("full", "swap $10 of BONK to USDC");
    assert.deepEqual(asked(unpriced), ["actions[0].amount:AMOUNT_MISSING"]);
  });

  it("a venue-less deposit picks the best 7-day rate for its risk (a chip whose alternatives change it)", async () => {
    // Morpho Steakhouse Prime 5.0% (curated: 4.5% after the 0.5-point allowance) beats Aave 4.1% (core) and Compound 3.8%.
    const metrics: Record<string, { smoothedApy: number; tvlUsd: number }> = {
      "base:aave-v3:usdc": { smoothedApy: 0.041, tvlUsd: 300_000_000 },
      "base:morpho:steakhouse-prime-usdc": { smoothedApy: 0.05, tvlUsd: 272_000_000 },
      "base:compound-v3:usdc": { smoothedApy: 0.038, tvlUsd: 60_000_000 },
    };
    s8 = { metrics: async (venue) => ({ smoothedApy: metrics[venue.id]?.smoothedApy ?? null, apyWindowSeconds: 604_800, tvlUsd: metrics[venue.id]?.tvlUsd ?? null }) };
    try {
      const [picked, changed] = await thread("full", "earn yield on 100 USDC", chip("a.actions.0.protocol", "compound-v3"));
      assert.equal(planOf(picked), "deposit@base 100 USDC [morpho:steakhouse-prime-usdc]");
      const venueChip = picked?.decision?.assumptions.find((entry) => entry.field === "actions[0].protocol");
      assert.match(venueChip?.label ?? "", /5% APY \(7-day\)/u);
      assert.ok(venueChip?.material);
      assert.deepEqual(venueChip?.alternatives.map((option) => option.id).slice(0, 2), ["aave-v3", "compound-v3"]);
      assert.equal(planOf(changed), "deposit@base 100 USDC [compound-v3]", changed?.error?.message);
    } finally {
      s8 = null;
    }
  });

  it("a venue-less deposit with no 7-day rate to compare asks the venue (never picked on a current rate)", async () => {
    s8 = { metrics: async () => ({ smoothedApy: null, apyWindowSeconds: null, tvlUsd: null }) };
    try {
      const [ask] = await thread("full", "earn yield on 100 USDC");
      assert.deepEqual(asked(ask), ["actions[0].protocol:VENUE_MISSING"]);
      assert.match(ask?.decision?.questions[0]?.why ?? "", /could not be compared/u);
    } finally {
      s8 = null;
    }
  });

  it("staking ETH on Base asks how; bridging plans a bridge then Lido, buying plans a swap", async () => {
    const [ask, bridged] = await thread("wide", "stake 1 ETH on base", answer("q.actions.0.provider", "bridge-stake"));
    assert.deepEqual(ask?.decision?.questions[0]?.options.map((option) => option.id), ["buy:wstETH", "buy:cbETH", "bridge-stake"]);
    assert.equal(planOf(bridged), "bridge@base->ethereum 1 ETH | stake@ethereum max ETH->wstETH {lido}");
  });

  it("'sell 1 SOL' receives the network's dollar stablecoin, shown as a chip", async () => {
    const [sold] = await thread("full", "sell 1 SOL");
    assert.equal(planOf(sold), "swap@solana 1 SOL->USDC");
    assert.ok(sold?.decision?.assumptions.some((entry) => entry.field === "actions[0].to"));
  });
});
