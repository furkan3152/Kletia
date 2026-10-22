// The review screen is shown before any signature: it names the wallet that will sign
// ("Signs with"), never "Signed by", so no page claims a signature that has not happened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const review = readFileSync(new URL("../IntentReview.tsx", import.meta.url), "utf8");

test("the review names the signer in the future tense", () => {
  assert.match(review, /Signs with <span className="font-code"/u);
  assert.doesNotMatch(review, /Signed by/u);
});
