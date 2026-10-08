import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IntentGraph, StepEvidence } from "@kletia/core";
import { emitGraphChanges, platformEvents, publishIntentEvent, readIntentEvents, subscribeIntentEvents, type IntentEvent } from "../events.js";
import { planIntent } from "../planner.js";
import { nextTimestamp } from "../util.js";
import { ACCOUNTS, resetEngine } from "./helpers.js";

async function graph(): Promise<IntentGraph> {
  resetEngine();
  return planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
}

function note(index: number): StepEvidence {
  return { kind: "note", network: "solana", observedAt: new Date(1_700_000_000_000 + index).toISOString(), detail: `note ${index}` };
}

describe("intent events", () => {
  it("buffers envelopes per intent and resumes after a given event id", () => {
    const intentId = "int_00000000000000000000000000000001";
    const first = publishIntentEvent("intent.status_changed", { intentId, status: "executing", previous: "planned" });
    const second = publishIntentEvent("intent.status_changed", { intentId, status: "completed", previous: "executing" });
    assert.deepEqual(readIntentEvents(intentId).map((event) => event.id), [first.id, second.id]);
    assert.deepEqual(readIntentEvents(intentId, first.id).map((event) => event.id), [second.id]);
    assert.deepEqual(readIntentEvents(intentId, second.id), []);
    assert.equal(readIntentEvents(intentId, "evt_unknown").length, 2, "unknown id replays the buffer");
    assert.deepEqual(readIntentEvents("int_ffffffffffffffffffffffffffffffff"), []);
  });

  it("keeps at most 100 events per intent", () => {
    const intentId = "int_00000000000000000000000000000002";
    for (let index = 0; index < 130; index += 1) {
      publishIntentEvent("intent.step_updated", { intentId, stepId: "s1", network: "solana", status: "submitted" });
    }
    assert.equal(readIntentEvents(intentId).length, 100);
  });

  it("delivers to envelope subscribers and the typed bus, isolating listener errors", () => {
    const intentId = "int_00000000000000000000000000000003";
    const seen: IntentEvent[] = [];
    const typed: string[] = [];
    const unsubscribeThrowing = subscribeIntentEvents(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = subscribeIntentEvents((event) => seen.push(event));
    const offTyped = platformEvents.on("intent.status_changed", (payload) => typed.push(payload.status));
    publishIntentEvent("intent.status_changed", { intentId, status: "failed", previous: "executing" });
    unsubscribe();
    unsubscribeThrowing();
    offTyped();
    publishIntentEvent("intent.status_changed", { intentId, status: "failed", previous: "failed" });
    assert.equal(seen.length, 1);
    assert.deepEqual(typed, ["failed"]);
  });

  it("emits created, then one step event per step for a new graph", async () => {
    const created = await graph();
    const before = readIntentEvents(created.id).length;
    emitGraphChanges(null, created);
    const events = readIntentEvents(created.id).slice(before);
    assert.deepEqual(events.map((event) => event.type), ["intent.created", "intent.step_updated"]);
  });

  it("emits step updates for new evidence even when the capped evidence list keeps its length", async () => {
    const base = await graph();
    const [step] = base.steps;
    assert.ok(step);
    const full = Array.from({ length: 50 }, (_, index) => note(index));
    const before: IntentGraph = { ...base, steps: [{ ...step, status: "submitted", evidence: full }] };
    const after: IntentGraph = {
      ...before,
      updatedAt: nextTimestamp(before.updatedAt),
      steps: [{ ...step, status: "submitted", evidence: [...full.slice(1), note(50)] }],
    };
    const count = readIntentEvents(base.id).length;
    emitGraphChanges(before, after);
    const events = readIntentEvents(base.id).slice(count);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.type, "intent.step_updated");
    assert.equal(event?.type === "intent.step_updated" ? event.data.evidence?.detail : null, "note 50");
    // Nothing changed: nothing emitted.
    emitGraphChanges(after, { ...after, updatedAt: nextTimestamp(after.updatedAt) });
    assert.equal(readIntentEvents(base.id).length, count + 1);
  });
});
