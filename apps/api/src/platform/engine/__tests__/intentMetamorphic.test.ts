/**
 * The metamorphic suite (goal/evalMetamorphic.ts): from every
 * ready prompt of every corpus, seeded variants that must change the outcome
 * (a never-drop word, a unit word, a swapped asset pair or recipient pair, an
 * unsupported network, a question mark, a look-alike, an English word for a
 * network) or must not (a reviewed filler). The generator is deterministic;
 * every violation is allowlisted in the ledger with the package that clears
 * it, and an allowance no violation uses any more fails (the list only
 * shrinks).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader } from "../prices.js";
import { loadEvalFixtures, loadIntentEval, modeRunOptions, runIntentEval, type EvalResult, type IntentEvalPrompt } from "../goal/evalHarness.js";
import {
  MAX_VARIANTS_PER_PROMPT,
  METAMORPHIC_RELATIONS,
  checkMetamorphic,
  formatMetamorphic,
  judgeVariant,
  metamorphicVariants,
  runMetamorphic,
  type MetamorphicVariant,
} from "../goal/evalMetamorphic.js";
import { EVAL_CORPUS_FILES, loadLedger } from "../goal/evalTransitions.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ledger = loadLedger(fixture("intent-hard-ledger.json"));

after(() => {
  configureHoldingsReaders(null);
  configurePriceReader(null);
});

const prompt = (say: string, id = "M1"): IntentEvalPrompt => ({ id, family: "explicit", say, accept: ["P:^"], tags: [] });
const ready = (plan: string, id = "M1"): EvalResult => ({ id, say: "", status: "ready", questions: [], plan, assumptions: [] });
const variant = (relation: MetamorphicVariant["relation"], say = "x"): MetamorphicVariant => ({ id: `M1~${relation}~1`, of: "M1", relation, say, change: "" });

describe("metamorphic generator", () => {
  it("is deterministic in the prompt id and the seed, and capped per prompt", () => {
    const source = prompt("swap 1 SOL to USDC on solana");
    const original = ready("swap@solana 1 SOL->USDC");
    const first = metamorphicVariants(source, original);
    assert.deepEqual(metamorphicVariants(source, original), first);
    assert.notDeepEqual(metamorphicVariants(source, original, "another-seed"), first);
    assert.ok(first.length > 0 && first.length <= MAX_VARIANTS_PER_PROMPT);
    for (const entry of first) {
      assert.match(entry.id, /^M1~[a-z-]+~\d+$/u);
      assert.ok((METAMORPHIC_RELATIONS as readonly string[]).includes(entry.relation));
      assert.notEqual(entry.say, source.say);
    }
    const relations = new Set(first.map((entry) => entry.relation));
    for (const relation of ["never-drop", "unit", "asset-swap", "unsupported-network", "question-mark", "look-alike"]) assert.ok(relations.has(relation as never), relation);
    assert.deepEqual(metamorphicVariants(source, { ...original, status: "needs_input", plan: null }), [], "only ready prompts");
  });

  it("swaps two recipients and replaces 'base' by an English word", () => {
    const pay = metamorphicVariants(prompt("send 5 usdc to alice.eth and 5 usdc to bob.eth on base"), ready("transfer@base 5 USDC to alice.eth | transfer@base 5 USDC to bob.eth"));
    assert.ok(pay.some((entry) => entry.relation === "recipient-swap" && entry.say === "send 5 usdc to bob.eth and 5 usdc to alice.eth on base"));
    assert.ok(pay.some((entry) => entry.relation === "english-network" && !/\bon base\b/u.test(entry.say)));
  });
});

describe("metamorphic judge", () => {
  const original = ready("swap@solana 1 SOL->USDC");
  it("flags a variant that stays ready where it must not", () => {
    for (const relation of ["never-drop", "question-mark", "look-alike", "english-network", "unsupported-network"] as const) {
      assert.equal(judgeVariant(variant(relation), original, ready("swap@solana 1 SOL->USDC"))?.kind, "violation", relation);
      assert.equal(judgeVariant(variant(relation), original, { ...original, status: "refused", error: "NETWORK_UNSUPPORTED", plan: null }), null, relation);
    }
    // Another refusal for an unsupported network is safe, but short of the target code.
    assert.equal(judgeVariant(variant("unsupported-network"), original, { ...original, status: "refused", error: "INTENT_UNSUPPORTED", plan: null })?.kind, "gap");
  });

  it("units, asset swaps and fillers", () => {
    assert.equal(judgeVariant(variant("unit"), original, ready("swap@solana 1 SOL->USDC"))?.kind, "violation");
    assert.equal(judgeVariant(variant("unit"), original, ready("swap@solana 1000 SOL->USDC")), null);
    assert.equal(judgeVariant(variant("asset-swap"), original, ready("swap@solana 1 SOL->USDC"))?.kind, "violation");
    assert.equal(judgeVariant(variant("asset-swap"), original, ready("swap@solana 1 USDC->SOL")), null);
    assert.equal(judgeVariant(variant("filler"), original, ready("swap@solana 1 SOL->USDC")), null);
    assert.equal(judgeVariant(variant("filler"), original, ready("swap@solana 2 SOL->USDC"))?.kind, "violation");
    assert.equal(judgeVariant(variant("filler"), original, { ...original, status: "refused", plan: null })?.kind, "gap");
    assert.equal(judgeVariant(variant("filler"), original, { ...original, status: "crashed", plan: null })?.kind, "violation");
  });
});

describe("metamorphic suite over every corpus", () => {
  for (const [name, file] of Object.entries(EVAL_CORPUS_FILES)) {
    it(`${name}: every violation is allowlisted and no allowance is stale`, async () => {
      const path = fixture(file);
      const corpus = loadIntentEval(path);
      const fixtures = loadEvalFixtures(path, corpus);
      const originals = await runIntentEval(corpus, fixtures, modeRunOptions("decide"));
      const run = await runMetamorphic(corpus, fixtures, originals);
      assert.ok(run.variants > 0);
      const check = checkMetamorphic(name, run, ledger.metamorphic);
      assert.deepEqual(check.open.map((finding) => finding.variant.id), [], formatMetamorphic(name, run));
      assert.deepEqual(check.stale.map((allow) => allow.id), [], "stale allowances: remove them");
    });
  }
});
