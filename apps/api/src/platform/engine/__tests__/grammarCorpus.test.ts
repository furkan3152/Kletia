/**
 * Regression net for grammar changes: every phrase of the 76-phrase corpus
 * that main (31e6782) accepted compiles to exactly main's actions
 * (fixtures/grammar-corpus.json). Phrases main refused may now compile
 * (named venues, Spark, Yearn).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AccountId, IntentActionSpec } from "@kletia/core";
import { compileIntentText } from "../grammar.js";

interface CorpusPhrase {
  readonly text: string;
  readonly accepted: boolean;
  readonly actions?: readonly IntentActionSpec[];
}

const corpus = JSON.parse(readFileSync(new URL("./fixtures/grammar-corpus.json", import.meta.url), "utf8")) as {
  readonly accounts: readonly AccountId[];
  readonly phrases: readonly CorpusPhrase[];
};

describe("grammar corpus: main's accepted phrases are frozen", () => {
  it("has the 76 phrases of the grammar corpus", () => {
    assert.equal(corpus.phrases.length, 76);
    assert.equal(corpus.phrases.filter((phrase) => phrase.accepted).length, 39);
  });

  for (const phrase of corpus.phrases.filter((entry) => entry.accepted)) {
    it(`compiles "${phrase.text}" exactly as main did`, () => {
      assert.deepEqual(compileIntentText(phrase.text, { accounts: corpus.accounts }).actions, phrase.actions);
    });
  }
});
