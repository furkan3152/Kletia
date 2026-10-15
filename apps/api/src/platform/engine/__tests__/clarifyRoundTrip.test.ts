/**
 * The canonical sentence: every ready turn of the corpus and every grammar
 * example renders a sentence the strict grammar compiles into exactly the
 * resolved actions (kind, networks, amount, assets, recipient, protocol,
 * vault, portion, provider, contract). A step with no sentence shape (a
 * bridge that pays a third party) renders no sentence and is planned as
 * structured actions instead.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GRAMMAR_EXAMPLES } from "../grammar.js";
import { configureHoldingsReaders } from "../holdings.js";
import { contextFor, installWallet, loadCorpus, roundTripDifferences, runTurn, turnInputOf, type CorpusCase } from "../clarify/corpusHarness.js";
import { closestSentence, render } from "../clarify/render.js";
import type { TurnDecision } from "../clarify/index.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));

after(() => configureHoldingsReaders(null));

async function readyDecisions(entry: CorpusCase): Promise<TurnDecision[]> {
  installWallet(corpus, entry.wallet);
  const ctx = contextFor(corpus, entry);
  const out: TurnDecision[] = [];
  let thread: TurnDecision["thread"] | null = null;
  for (const turn of entry.turns) {
    const result = await runTurn(thread, turnInputOf(turn), ctx);
    if (result.decision) {
      if (result.decision.status === "ready") out.push(result.decision);
      thread = result.decision.thread;
    }
  }
  return out;
}

describe("clarify round trip", () => {
  it("every ready corpus turn's sentence compiles to its actions", async () => {
    let checked = 0;
    let structured = 0;
    for (const entry of corpus.cases) {
      if (entry.phase === 2) continue;
      const ctx = contextFor(corpus, entry);
      for (const decision of await readyDecisions(entry)) {
        const actions = decision.actions ?? [];
        if (decision.sentence === null) {
          // No sentence shape: only a bridge that pays a third party, planned as structured actions.
          assert.ok(actions.some((action) => action.kind === "bridge" && action.recipient), `${entry.id}: only a third-party bridge has no sentence`);
          assert.ok(closestSentence(actions).length > 0, `${entry.id}: closest sentence`);
          structured += 1;
          continue;
        }
        assert.deepEqual(roundTripDifferences(actions, decision.sentence as string, ctx), [], `${entry.id}: "${decision.sentence}"`);
        checked += 1;
      }
    }
    assert.ok(checked >= 150, `round-tripped ${checked} ready turns`);
    assert.ok(structured >= 3, `structured fallbacks: ${structured} (J01, C17, C19)`);
  });

  it("every grammar example renders back to a sentence with the same actions", async () => {
    const entry = { id: "examples", category: "complete", title: "examples", wallet: "full", turns: [] } as CorpusCase;
    for (const text of GRAMMAR_EXAMPLES) {
      installWallet(corpus, "full");
      const ctx = contextFor(corpus, entry);
      let result = await runTurn(null, { text }, ctx);
      // D2: an example amount above the fixture balance is asked first; kept, it plans as written.
      const exceeds = result.decision?.questions[0];
      if (exceeds?.reason === "AMOUNT_EXCEEDS_BALANCE") result = await runTurn(result.decision?.thread ?? null, { answer: { question: exceeds.id, option: "keep" } }, ctx);
      assert.equal(result.decision?.status, "ready", `${text}: ${result.error?.code ?? ""}`);
      const decision = result.decision as TurnDecision;
      assert.ok(decision.sentence, text);
      assert.deepEqual(roundTripDifferences(decision.actions ?? [], decision.sentence, ctx), [], `${text} -> "${decision.sentence}"`);
    }
  });

  it("renders dependent steps with it, half and percentages, and pays a third party only through the structured fallback", () => {
    assert.equal(
      render([
        { kind: "bridge", network: "base", toNetwork: "solana", from: "USDC", amount: "50" },
        { kind: "swap", network: "solana", from: "USDC", to: "JitoSOL", amount: "max", portionBps: 5_000 },
        { kind: "stake", network: "solana", from: "JitoSOL", amount: "max", portionBps: 2_500, provider: "jito" },
      ]),
      "bridge 50 USDC from base to solana, then swap half to JitoSOL on solana, then stake 25% with jito",
    );
    assert.equal(render([{ kind: "bridge", network: "solana", toNetwork: "base", from: "USDC", amount: "5", recipient: "vitalik.eth" }]), null);
  });
});
