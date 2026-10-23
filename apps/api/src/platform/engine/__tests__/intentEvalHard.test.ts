/**
 * The hard corpus (design E.1: U2's 522 prompts, reviewed) and its ledger
 * ratchet (E.3). The corpus is well formed, every re-classified prompt keeps
 * U2's accept list and names the design rule it follows, and every mode
 * (decide, plan, strict) runs deterministically with every failure ledgered,
 * nothing worse than recorded, no ledgered prompt passing and no unreviewed
 * move to a less safe outcome.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader } from "../prices.js";
import { EVAL_MODES, formatScoreboard, loadEvalFixtures, loadIntentEval, parseAccept } from "../goal/evalHarness.js";
import { formatLedgerReport, ledgerOk, loadLedger, loadOutcomes, loadTransitions, runRatchet } from "../goal/evalTransitions.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const hardPath = fixture("intent-hard.json");
const corpus = loadIntentEval(hardPath);
const ledger = loadLedger(fixture("intent-hard-ledger.json"));
const outcomes = loadOutcomes(fixture("intent-outcomes.json"));
const transitions = loadTransitions(fixture("intent-transitions.json"));

after(() => {
  configureHoldingsReaders(null);
  configurePriceReader(null);
});

interface HardPrompt {
  readonly id: string;
  readonly tags: readonly string[];
  readonly why?: string;
  readonly u2Accept?: readonly string[] | null;
  readonly accept: readonly string[];
  readonly sub?: string;
}

describe("hard corpus (U2, reviewed)", () => {
  it("has U2's 522 prompts over its families, its own fixture wallets and well-formed accepts", () => {
    assert.equal(corpus.prompts.length, 522);
    const families = new Set(corpus.prompts.map((prompt) => prompt.family));
    for (const family of ["concrete", "crossnet", "multi", "payment", "amount", "noisy", "refuse_ask", "question", "departure", "abstract"]) {
      assert.ok(families.has(family), `family ${family}`);
    }
    const fixtures = loadEvalFixtures(hardPath, corpus);
    for (const prompt of corpus.prompts) {
      assert.ok(fixtures.fixtures.wallets[prompt.wallet ?? "full"], `${prompt.id}: wallet ${prompt.wallet}`);
      prompt.accept.forEach(parseAccept);
    }
  });

  it("every re-classified prompt keeps U2's accepts and names the design rule it follows", () => {
    const reclassified = (corpus.prompts as readonly HardPrompt[]).filter((prompt) => prompt.tags.includes("reclassified"));
    assert.equal(reclassified.length, 97);
    for (const prompt of reclassified) {
      assert.ok(Array.isArray(prompt.u2Accept) && prompt.u2Accept.length > 0, `${prompt.id}: u2Accept`);
      assert.notDeepEqual(prompt.u2Accept, prompt.accept, `${prompt.id}: the accepts changed`);
      assert.ok(typeof prompt.why === "string" && /design|red-team/iu.test(prompt.why), `${prompt.id}: why names the rule`);
      assert.ok(prompt.tags.some((tag) => tag !== "reclassified"), `${prompt.id}: a rule tag`);
    }
    // E.1: "1.000" asks only AMOUNT_FORMAT_AMBIGUOUS.
    const dotThousands = corpus.prompts.find((prompt) => prompt.id === "AMT031");
    assert.deepEqual(dotThousands?.accept, ["A:actions\\[\\d+\\]\\.amount:AMOUNT_FORMAT_AMBIGUOUS"]);
  });

  it("the ledger seeds U2's failures with a root class and the package that clears them", () => {
    const hard = ledger.entries.filter((entry) => entry.corpus === "hard" && entry.mode === "decide");
    assert.ok(hard.length >= 150, `${hard.length} decide entries`);
    for (const entry of ledger.entries) {
      assert.match(entry.clears, /^P[2-5]/u, `${entry.corpus}/${entry.mode}/${entry.id} clears`);
      assert.ok(entry.root.length > 1, `${entry.id} root`);
    }
    // Roots are U2's classes (WP/AQ/RF), the rule tag of a re-classified prompt, or F-2 for the planner.
    const tags = new Map(corpus.prompts.map((prompt) => [prompt.id, prompt.tags]));
    for (const entry of hard) {
      const ok = /^(?:WP|AQ|RF)\d+$/u.test(entry.root) || (tags.get(entry.id) ?? []).includes(entry.root) || entry.root.startsWith("F-2");
      assert.ok(ok, `${entry.id}: root ${entry.root}`);
    }
  });

  for (const mode of EVAL_MODES) {
    it(`${mode} mode: deterministic, every failure ledgered, no unreviewed less-safe transition`, async () => {
      const first = await runRatchet(hardPath, mode, { ledger, outcomes, transitions });
      const second = await runRatchet(hardPath, mode, { ledger, outcomes, transitions });
      assert.deepEqual(second.results, first.results, "two runs agree");
      assert.equal(first.board.byClass.crashed, 0, formatScoreboard(first.board, { failList: true, gates: false }));
      assert.ok(ledgerOk(first.ledger), formatLedgerReport("hard", mode, first.ledger));
      assert.deepEqual(first.transitions?.unreviewed, [], "unreviewed transitions");
      assert.deepEqual(first.transitions?.unrecorded, [], "every prompt has a recorded outcome");
    });
  }
});
