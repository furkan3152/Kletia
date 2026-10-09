// The `/embed` fragment: integrator-created intents and sessions. Run with
//   node --test apps/web/src/app/pages/embed/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { buildEmbedUrl } from "../../../../../../../packages/embed/src/index.ts";
import { readEmbedFragment, readEmbedParams } from "../embedParams.ts";

const INTENT = `int_${"a".repeat(32)}`;
const SESSION = `cs_${"b".repeat(32)}`;

test("the frame reads #intent= and #session= ids of the exact shape", () => {
  assert.deepEqual(readEmbedFragment(`#intent=${INTENT}`), { kind: "intent", id: INTENT });
  assert.deepEqual(readEmbedFragment(`#session=${SESSION}`), { kind: "session", id: SESSION });
  assert.deepEqual(readEmbedFragment(`#session=${SESSION}&intent=${INTENT}`), { kind: "intent", id: INTENT }, "the intent wins, as in @kletia/embed");
  for (const hash of ["", "#", "#intent=", "#intent=int_ABC", `#intent=${INTENT}x`, `#intent=${INTENT}&intent=${INTENT}`, `#session=cs_${"b".repeat(31)}`, "#intent=javascript:alert(1)", `#${"x".repeat(300)}`]) {
    assert.equal(readEmbedFragment(hash), null, hash);
  }
});

test("the element and the frame agree: what the element puts in the fragment, the frame reads", () => {
  const intentUrl = new URL(buildEmbedUrl("https://kletiaai.xyz", { intent: INTENT, text: "ignored" }, "https://shop.example"));
  assert.deepEqual(readEmbedFragment(intentUrl.hash), { kind: "intent", id: INTENT });
  assert.equal(intentUrl.searchParams.get("intent"), null, "ids never travel in the query string");
  const sessionUrl = new URL(buildEmbedUrl("https://kletiaai.xyz", { session: SESSION }, "https://shop.example"));
  assert.deepEqual(readEmbedFragment(sessionUrl.hash), { kind: "session", id: SESSION });
  // The query parameters the frame reads are unaffected by the fragment.
  assert.equal(readEmbedParams(intentUrl.search).text, "ignored");
});
