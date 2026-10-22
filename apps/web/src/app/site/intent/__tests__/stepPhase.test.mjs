// The progress panel after a run stops: the header and the steps
// say the same thing as the task (no "Executing" or "Awaiting signature"
// under a failed or paused run), and a step whose request has no known
// outcome is never called unsigned. Run with
//   node --test apps/web/src/app/site/intent/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { progressBadge, progressStepPhase, runPhaseOf, stepDisplayPhase } from "../stepPhase.ts";

const step = (overrides = {}) => ({ id: "s1", index: 0, status: "awaiting_signature", references: [], evidence: [], ...overrides });

test("while the run is live, the phase is the step's own", () => {
  assert.equal(progressStepPhase(step(), undefined, { running: true, signatureUnknown: false }), "awaiting_signature");
  assert.equal(progressStepPhase(step(), "preparing", { running: true, signatureUnknown: false }), "preparing");
  assert.equal(progressStepPhase(step(), "signing", { running: true, signatureUnknown: true }), "awaiting_signature");
});

test("after a declined signature the step reads 'Not signed', or 'Check your wallet' when the outcome is unknown", () => {
  assert.equal(progressStepPhase(step(), undefined, { running: false, signatureUnknown: false }), "not_signed");
  assert.equal(progressStepPhase(step({ status: "ready" }), undefined, { running: false, signatureUnknown: false }), "not_signed");
  assert.equal(progressStepPhase(step(), undefined, { running: false, signatureUnknown: true }), "signature_unknown");
  // A step with a reference, or past signing, keeps its own phase.
  assert.equal(progressStepPhase(step({ references: ["a".repeat(64)] }), undefined, { running: false, signatureUnknown: false }), "awaiting_signature");
  assert.equal(progressStepPhase(step({ status: "submitted" }), undefined, { running: false, signatureUnknown: false }), "submitted");
  assert.equal(progressStepPhase(step({ status: "pending" }), undefined, { running: false, signatureUnknown: false }), "waiting");
  assert.equal(stepDisplayPhase(step({ status: "failed" })), "failed");
});

test("the badge follows the run: Stopped, Paused or Cancelled under an intent the API still lists as executing", () => {
  assert.deepEqual(progressBadge({ status: "executing" }, "failed"), { label: "Stopped", tone: "red" });
  assert.deepEqual(progressBadge({ status: "executing" }, "paused"), { label: "Paused", tone: "yellow" });
  assert.deepEqual(progressBadge({ status: "planned" }, "cancelled"), { label: "Cancelled", tone: "neutral" });
  assert.deepEqual(progressBadge({ status: "executing" }, "executing"), { label: "executing", tone: "yellow" });
  // A finished intent keeps its own status.
  assert.deepEqual(progressBadge({ status: "partially_completed" }, "failed"), { label: "partially completed", tone: "yellow" });
});

test("runPhaseOf reads the execution hook's state", () => {
  const phaseOf = runPhaseOf({ status: "failed", stepPhases: {}, signatureUnknownStepIds: ["s2"] });
  assert.equal(phaseOf(step()), "not_signed");
  assert.equal(phaseOf(step({ id: "s2" })), "signature_unknown");
  assert.equal(runPhaseOf({ status: "executing", stepPhases: { s1: "signing" }, signatureUnknownStepIds: [] })(step()), "awaiting_signature");
});
