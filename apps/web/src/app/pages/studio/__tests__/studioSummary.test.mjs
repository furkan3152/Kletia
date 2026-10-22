// Studio's intent card: a 2-leg route that needs 3 signatures read "Steps 0 · Signatures 0"
// because the counts were count-up animations that start at 0 and wait to be scrolled into view. Studio
// now prints them as they are. Run with
//   node --test apps/web/src/app/pages/studio/__tests__/studioSummary.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workspace = read("../StudioWorkspace.tsx");
const graphView = read("../../../site/intent/IntentGraphView.tsx");

test("Studio renders the intent card without the count-up entrance", () => {
  const uses = [...workspace.matchAll(/<IntentGraphView\b[^>]*\/>/gu)].map((match) => match[0]);
  assert.ok(uses.length > 0, "Studio renders the intent card");
  for (const use of uses) assert.doesNotMatch(use, /\bentrance\b/u, use);
  assert.match(workspace, /className="kl-drop[^"]*"/u, "the card still drops in");
});

test("without the entrance the card prints the step count and the signatures the API returned", () => {
  assert.ok(graphView.includes(": intent.steps.length} />"), "Steps falls back to the plain count");
  assert.ok(graphView.includes(": summary.signaturesRequired}"), "Signatures falls back to the plain count");
});

test("with the entrance the counters start at once instead of waiting to be scrolled into view", () => {
  const counters = [...graphView.matchAll(/<AnimatedNumber\b[^>]*\/>/gu)].map((match) => match[0]);
  assert.equal(counters.length, 2);
  for (const counter of counters) assert.match(counter, /startOnView=\{false\}/u, counter);
});
