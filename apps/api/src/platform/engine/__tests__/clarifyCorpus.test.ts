/**
 * The clarify corpus (fixtures/clarify-corpus.json, the source of truth):
 * every case is a thread, every turn a message, an answer or a chip
 * change with the expected outcome. Facts come from the fixture wallets
 * through holdings.readFacts (stub readers). Every turn runs twice
 * (determinism); every ready turn's sentence compiles to its actions.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureHoldingsReaders } from "../holdings.js";
import {
  contextFor,
  installWallet,
  loadCorpus,
  roundTripDifferences,
  runTurn,
  shape,
  turnInputOf,
  type CorpusCase,
} from "../clarify/corpusHarness.js";
import type { TurnDecision } from "../clarify/index.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));

after(() => configureHoldingsReaders(null));

/** A decision without the parts that legitimately differ between two identical runs (a new thread's random id). */
function comparable(decision: TurnDecision | undefined, firstTurn: boolean): unknown {
  if (!decision) return null;
  const { optionSentences, state: _state, thread, ...rest } = decision;
  const text = JSON.stringify({ ...rest, thread, optionSentences: [...optionSentences.entries()] });
  return firstTurn ? text.replaceAll(thread.id, "th_x") : text;
}

async function runCase(entry: CorpusCase): Promise<void> {
  installWallet(corpus, entry.wallet);
  const ctx = contextFor(corpus, entry);
  let thread: TurnDecision["thread"] | null = null;
  for (const [position, turn] of entry.turns.entries()) {
    const expect = turn.expect;
    const label = `${entry.id} turn ${position + 1}`;
    const before: string | null = thread ? JSON.stringify(thread) : null;
    const result = await runTurn(thread, turnInputOf(turn), ctx);
    const decision = result.decision;
    const status = result.error ? "refused" : decision?.status;
    assert.equal(status, expect.status, `${label}: status (${result.error?.code ?? ""} ${result.error?.message ?? ""}) questions=${JSON.stringify(decision?.questions.map((q) => [q.field, q.reason]) ?? [])} plan=${decision?.actions ? shape(decision.actions) : ""}`);
    if (expect.turn) assert.equal(decision?.turn, expect.turn, `${label}: turn kind`);
    if (expect.status === "refused") {
      assert.equal(result.error?.code, expect.error, `${label}: error code`);
      // A refusal never returns a thread; the caller keeps the one it sent.
      assert.equal(thread ? JSON.stringify(thread) : null, before, `${label}: thread unchanged`);
      continue;
    }
    const d = decision as TurnDecision;
    if (expect.plan) {
      assert.ok(d.actions, `${label}: plan`);
      assert.equal(shape(d.actions), expect.plan, `${label}: plan shape`);
      if (d.sentence) assert.deepEqual(roundTripDifferences(d.actions, d.sentence, ctx), [], `${label}: "${d.sentence}" compiles to the same actions`);
    }
    if (expect.questions) {
      const want = expect.questions as Record<string, unknown>[];
      assert.equal(d.questions.length, want.length, `${label}: question count ${JSON.stringify(d.questions.map((q) => [q.field, q.reason]))}`);
      want.forEach((q, i) => {
        const got = d.questions[i]!;
        assert.equal(got.field, q.field, `${label}: question ${i + 1} field`);
        assert.equal(got.kind, q.kind, `${label}: question ${i + 1} kind`);
        assert.equal(got.reason, q.reason, `${label}: question ${i + 1} reason`);
        if (q.options) assert.deepEqual(got.options.map((option) => option.id), q.options, `${label}: question ${i + 1} options`);
        if ("recommended" in q) assert.equal(got.options.find((option) => option.recommended)?.id ?? null, q.recommended, `${label}: question ${i + 1} recommended`);
        if (q.allowsText !== undefined) assert.equal(got.allowsText, q.allowsText, `${label}: question ${i + 1} allowsText`);
        for (const banned of (q.mustNotOffer as string[] | undefined) ?? []) {
          assert.ok(!got.options.some((option) => option.id === banned || option.label.includes(banned)), `${label}: must not offer ${banned}`);
        }
      });
    }
    if (expect.assumptions) {
      const want = expect.assumptions as Record<string, unknown>[];
      if (expect.assumptionsExact) assert.equal(d.assumptions.length, want.length, `${label}: assumption count ${JSON.stringify(d.assumptions.map((a) => [a.field, a.source]))}`);
      for (const a of want) {
        const got = d.assumptions.find((entry) => entry.field === a.field);
        assert.ok(got, `${label}: assumption on ${a.field} (have ${JSON.stringify(d.assumptions.map((x) => [x.field, x.source]))})`);
        assert.equal(got.source, a.source, `${label}: assumption ${a.field} source`);
        if (a.value) assert.deepEqual(got.value, a.value, `${label}: assumption ${a.field} value`);
        if (a.material !== undefined) assert.equal(got.material, a.material, `${label}: assumption ${a.field} material`);
      }
    }
    // Determinism (R13): the same thread, input and facts give the same decision.
    installWallet(corpus, entry.wallet);
    const again = await runTurn(before ? JSON.parse(before) : null, turnInputOf(turn), ctx);
    assert.deepEqual(comparable(again.decision, thread === null), comparable(d, thread === null), `${label}: deterministic`);
    thread = d.thread;
  }
}

describe("clarify corpus", () => {
  it("has a well-formed corpus with unique case ids", () => {
    assert.equal(corpus.spec, "kletia.clarify-corpus/v1");
    assert.ok(corpus.cases.length >= 173, `${corpus.cases.length} cases`);
    const ids = corpus.cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "case ids are unique");
  });

  for (const entry of corpus.cases) {
    const run = entry.phase === 2 ? it.skip : it;
    run(`${entry.id} ${entry.title}`, async () => {
      await runCase(entry);
    });
  }
});
