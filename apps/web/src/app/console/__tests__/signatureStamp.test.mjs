// What a task's ticket and rows may claim about signatures (GAPS 3.1 and
// 3.2): never "Signing" or a SIGNED stamp before a wallet returned a
// signature, "nothing signed" only when that is known, and a neutral note
// (no FAILED stamp) for a sentence Kletia cannot plan yet. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { signatureStateOf, stampFor, taskStatusLabel, ticketStampOf, unstampedSentence } from "../tasks/taskModel.ts";

const step = (overrides = {}) => ({ id: "s1", status: "ready", references: [], ...overrides });

test("an intent is signed only once a wallet returned a reference or the API moved a step past signing", () => {
  assert.equal(signatureStateOf(null), "none");
  assert.equal(signatureStateOf({ steps: [step()] }), "none");
  // The fare gate is open, the step is prepared: nothing was signed (PREVIEW_CHANGED on Solana).
  assert.equal(signatureStateOf({ steps: [step({ status: "awaiting_signature" })] }, { s1: "preparing" }), "none");
  // The wallet shows the request: the outcome is not known yet.
  assert.equal(signatureStateOf({ steps: [step({ status: "awaiting_signature" })] }, { s1: "signing" }), "unknown");
  // A request went out before and no outcome came back (or the rejection did not prove nothing was sent).
  assert.equal(signatureStateOf({ steps: [step({ status: "awaiting_signature" })] }, {}, ["s1"]), "unknown");
  assert.equal(signatureStateOf({ steps: [step({ status: "awaiting_signature" })] }, { s1: "confirming" }), "signed");
  assert.equal(signatureStateOf({ steps: [step({ references: ["5".repeat(64)] })] }), "signed");
  for (const status of ["submitted", "confirmed", "settling", "settled", "indeterminate"]) {
    assert.equal(signatureStateOf({ steps: [step({ status })] }), "signed", status);
  }
  // A failed step without a reference was never signed.
  assert.equal(signatureStateOf({ steps: [step({ status: "failed" })] }), "none");
});

test("an executing task without a signature reads 'Awaiting approval' with a PLANNED stamp, never SIGNED", () => {
  const task = { status: "executing", intentId: "int_1", signature: "none" };
  assert.equal(stampFor("executing", "none"), "planned");
  assert.deepEqual(ticketStampOf(task), { state: "planned", detail: "NOT SIGNED YET", sentence: "Waiting for your approval. Nothing has been signed." });
  assert.equal(taskStatusLabel(task), "Awaiting approval");
  assert.equal(taskStatusLabel({ ...task, signature: "unknown" }), "In your wallet");
  assert.equal(ticketStampOf({ ...task, signature: "unknown" }).state, "planned");
  const signed = { ...task, signature: "signed" };
  assert.equal(ticketStampOf(signed).state, "signed");
  assert.equal(ticketStampOf(signed).sentence, "Signed in the user's wallet. Waiting for on-chain evidence.");
  assert.equal(taskStatusLabel(signed), "Signing");
});

test("a declined signature fails the task with 'nothing signed'; an unknown outcome never claims that", () => {
  assert.deepEqual(ticketStampOf({ status: "failed", intentId: "int_1", signature: "none" }), { state: "failed", detail: "NOTHING SIGNED", sentence: "Stopped. Nothing was signed." });
  assert.equal(ticketStampOf({ status: "failed", intentId: "int_1", signature: "unknown" }).detail, undefined);
  assert.equal(ticketStampOf({ status: "failed", intentId: null }).detail, "NOT PLANNED");
  // Paused before any signature (stopped at the fare gate) is planned, not "held, recover by hash".
  assert.equal(ticketStampOf({ status: "paused", intentId: "int_1", signature: "none" }).state, "planned");
  assert.equal(ticketStampOf({ status: "paused", intentId: "int_1", signature: "unknown" }).state, "held");
  assert.equal(ticketStampOf({ status: "paused", intentId: "int_1" }).state, "held");
  assert.equal(ticketStampOf({ status: "cancelled", intentId: "int_1", signature: "none" }).detail, "CANCELLED");
});

test("a sentence Kletia cannot plan, an engine task and a rate question carry no stamp", () => {
  assert.equal(ticketStampOf({ status: "unsupported", intentId: null }), null);
  assert.equal(unstampedSentence("unsupported"), "Kletia can't do that yet. Nothing was planned or signed.");
  assert.equal(taskStatusLabel({ status: "unsupported" }), "Can't do that yet");
  // A network engine task was not planned by the platform: no PLANNED stamp.
  assert.equal(ticketStampOf({ status: "engine", intentId: null }), null);
  const rates = { status: "completed", intentId: null, engine: { kind: "rates" } };
  assert.equal(ticketStampOf(rates), null);
  assert.equal(taskStatusLabel(rates), "Read only");
  assert.equal(taskStatusLabel({ ...rates, status: "planning" }), "Reading rates");
  assert.equal(unstampedSentence("completed", { kind: "rates" }), "Read only. Nothing was planned and nothing can be signed.");
  assert.equal(ticketStampOf({ status: "question", intentId: null }), null);
});
