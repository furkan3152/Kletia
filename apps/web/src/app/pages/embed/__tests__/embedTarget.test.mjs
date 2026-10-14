// Target scoping of the `/embed` frame: a host that moves the frame from
// `#session=A` to `#session=B` (or to an intent) must never see A's intent
// again, and the widget with its signer lease is replaced. Run with
//   node --test apps/web/src/app/pages/embed/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { readEmbedFragment } from "../embedParams.ts";
import { embedTargetKey, embedWidgetKey, openIntentFor } from "../embedTarget.ts";

const SESSION_A = `cs_${"a".repeat(32)}`;
const SESSION_B = `cs_${"b".repeat(32)}`;
const INTENT_OF_A = `int_${"1".repeat(32)}`;
const HOST_INTENT = `int_${"2".repeat(32)}`;
const OWNERS = "eip155:0x1111111111111111111111111111111111111111,solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("the intent a session created is reopened for that session only", () => {
  const a = readEmbedFragment(`#session=${SESSION_A}`);
  const b = readEmbedFragment(`#session=${SESSION_B}`);
  const remembered = { sessionId: SESSION_A, intentId: INTENT_OF_A };
  assert.equal(openIntentFor(a, remembered), INTENT_OF_A, "a remount on A reopens A's intent");
  assert.equal(openIntentFor(b, remembered), null, "after #session=A -> #session=B, A's intent is never shown");
  assert.equal(openIntentFor(null, remembered), null, "nor in the free-text widget");
  assert.equal(openIntentFor(readEmbedFragment(`#intent=${HOST_INTENT}`), remembered), HOST_INTENT, "an intent target opens itself");
  assert.equal(openIntentFor(b, null), null);
});

test("a new target remounts the widget, and so replaces its signer lease", () => {
  const a = readEmbedFragment(`#session=${SESSION_A}`);
  const b = readEmbedFragment(`#session=${SESSION_B}`);
  const intent = readEmbedFragment(`#intent=${HOST_INTENT}`);
  for (const live of [true, false]) {
    const keys = [a, b, intent, null].map((target) => embedWidgetKey(live, OWNERS, target));
    assert.equal(new Set(keys).size, 4, `every target has its own widget (live: ${live})`);
    assert.equal(embedWidgetKey(live, OWNERS, a), embedWidgetKey(live, OWNERS, readEmbedFragment(`#session=${SESSION_A}`)), "the same target keeps the widget");
  }
  assert.notEqual(embedWidgetKey(true, OWNERS, a), embedWidgetKey(false, "", a), "connecting a wallet remounts it");
  assert.notEqual(embedWidgetKey(true, OWNERS, a), embedWidgetKey(true, `${OWNERS},solana:other`, a), "another account set remounts it");
});

test("target keys never collide between kinds or with free text", () => {
  assert.equal(embedTargetKey(null), "text");
  assert.equal(embedTargetKey({ kind: "session", id: SESSION_A }), `session:${SESSION_A}`);
  assert.notEqual(embedTargetKey({ kind: "intent", id: "x" }), embedTargetKey({ kind: "session", id: "x" }));
});
