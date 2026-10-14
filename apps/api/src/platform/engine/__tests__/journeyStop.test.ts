/**
 * Ending an intent at a stop (journey design 6.3, test E5): stopIntent skips
 * every step not started once nothing is in flight; a step submitted,
 * settling, under manual review or holding a signable payload refuses the
 * stop with INTENT_IN_FLIGHT (409, retryable, Retry-After); nothing started
 * gives `cancelled`; a stop after a settled leg gives `partially_completed`;
 * repeated stops change nothing; receipt collection never throws for a
 * stopped intent.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ERROR_CATALOG, type IntentGraph, type IntentStep, type NetworkKey, type RpcTransport } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { collectReceiptInputs } from "../receipts/collect.js";
import { createIntent, getIntent, prepareStep, refreshIntent, stopIntent, STOP_RETRY_AFTER_SECONDS, submitStep } from "../service.js";
import type { MemoryIntentStore } from "../store.js";
import { nextTimestamp } from "../util.js";
import { ACCOUNTS, randomEvmHash, randomSolanaSignature, resetEngine, stub } from "./helpers.js";

const BRIDGE_THEN_SWAP = { text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS };

let store: MemoryIntentStore;

beforeEach(() => {
  store = resetEngine();
});

async function failure(promise: Promise<unknown>): Promise<PlatformError & { retryAfterSeconds?: number }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

function statuses(graph: IntentGraph): string {
  return `${graph.status}:${graph.steps.map((entry) => `${entry.id}=${entry.status}`).join(",")}`;
}

function step(graph: IntentGraph, id: string): IntentStep {
  const found = graph.steps.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

/** Bridge s1 submitted and left settling (the stub poll reports no fill yet). */
async function settlingIntent(): Promise<IntentGraph> {
  const created = await createIntent(BRIDGE_THEN_SWAP);
  await prepareStep(created.id, "s1");
  stub.poll = () => ({ status: "settling", evidence: [] });
  const graph = await submitStep(created.id, "s1", [randomEvmHash(), randomEvmHash()]);
  assert.equal(statuses(graph), "settling:s1=settling,s2=pending");
  return graph;
}

/** s1 settled (observed 30 USDC on Solana), s2 ready. */
async function settledFirstLeg(): Promise<IntentGraph> {
  const graph = await settlingIntent();
  const observed = { ...(step(graph, "s1").minimumOutput as NonNullable<IntentStep["minimumOutput"]>), amount: "30000000", formatted: "30" };
  stub.poll = () => ({ status: "settled", evidence: [{ kind: "settlement", network: "solana", reference: randomSolanaSignature(), observedAt: new Date().toISOString() }], actualOutput: observed });
  const settled = await refreshIntent(graph.id);
  assert.equal(statuses(settled), "executing:s1=settled,s2=ready");
  return settled;
}

/** Transports that fail every read: collection must report, never throw. */
const unreachable: Partial<Record<NetworkKey, RpcTransport>> = Object.fromEntries(
  (["base", "solana", "arbitrum"] as const).map((network) => [network, (async () => { throw new Error("unreachable"); }) as RpcTransport]),
);

describe("stopIntent", () => {
  it("cancels an intent nothing of which started, and repeated stops change nothing", async () => {
    const created = await createIntent(BRIDGE_THEN_SWAP);
    const stopped = await stopIntent(created.id);
    assert.equal(statuses(stopped), "cancelled:s1=skipped,s2=skipped");
    const again = await stopIntent(created.id);
    assert.equal(again.updatedAt, stopped.updatedAt, "idempotent");
    assert.equal(statuses(again), statuses(stopped));
    assert.equal((await collectReceiptInputs(again, { transports: unreachable })).state, "ready", "a cancelled intent carries no anchors");
  });

  it("refuses while a leg settles (INTENT_IN_FLIGHT, 409, retryable, Retry-After 30 s)", async () => {
    const graph = await settlingIntent();
    const error = await failure(stopIntent(graph.id));
    assert.equal(error.code, "INTENT_IN_FLIGHT");
    assert.equal(error.status, 409);
    assert.equal(ERROR_CATALOG.INTENT_IN_FLIGHT.retryable, true);
    assert.equal(error.retryAfterSeconds, STOP_RETRY_AFTER_SECONDS);
    assert.match(error.message, /Step s1 is settling/u);
    assert.equal(statuses(await getIntent(graph.id)), "settling:s1=settling,s2=pending", "nothing changed");
  });

  it("ends the journey after a settled leg: the rest is skipped with a note and the intent is partially completed", async () => {
    const settled = await settledFirstLeg();
    const stopped = await stopIntent(settled.id);
    assert.equal(statuses(stopped), "partially_completed:s1=settled,s2=skipped");
    assert.deepEqual(step(stopped, "s1"), step(settled, "s1"), "the settled leg is untouched");
    assert.ok(step(stopped, "s2").evidence.some((entry) => entry.kind === "note" && entry.detail === "Skipped: the journey was ended at the Solana stop after step 1."), JSON.stringify(step(stopped, "s2").evidence));
    const again = await stopIntent(settled.id);
    assert.equal(again.updatedAt, stopped.updatedAt, "idempotent");
    assert.equal((await failure(prepareStep(settled.id, "s2"))).code, "STEP_NOT_PREPARABLE", "a stopped leg is never prepared");
    // Receipt collection reads the settled leg's anchors and never throws for a stopped intent.
    const collection = await collectReceiptInputs(stopped, { transports: unreachable });
    assert.equal(collection.state, "retry");
  });

  it("waits for a prepared payload that can still be signed, then stops after it expires", async () => {
    const settled = await settledFirstLeg();
    const { intent } = await prepareStep(settled.id, "s2");
    const expiresAt = step(intent, "s2").prepared?.expiresAt as number;
    const error = await failure(stopIntent(settled.id));
    assert.equal(error.code, "INTENT_IN_FLIGHT");
    assert.ok(error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 90, String(error.retryAfterSeconds));
    assert.ok(error.retryAfterSeconds <= expiresAt - Math.floor(Date.now() / 1000) + 1);
    // The payload expired: it can no longer be submitted, so the stop goes through.
    const stored = await store.get(settled.id);
    assert.ok(stored);
    const steps = stored.steps.map((entry) => entry.id === "s2" && entry.prepared ? { ...entry, prepared: { ...entry.prepared, expiresAt: Math.floor(Date.now() / 1000) - 1 } } : entry);
    await store.update(settled.id, { ...stored, steps, updatedAt: nextTimestamp(stored.updatedAt) }, stored.updatedAt);
    const stopped = await stopIntent(settled.id);
    assert.equal(statuses(stopped), "partially_completed:s1=settled,s2=skipped");
  });

  it("skips a failed later leg (failed -> ready -> skipped) and refuses unknown intents", async () => {
    const settled = await settledFirstLeg();
    await prepareStep(settled.id, "s2");
    stub.verify = () => ({ status: "failed", evidence: [], failure: { code: "TRANSACTION_REVERTED", message: "reverted" } });
    const failed = await submitStep(settled.id, "s2", [randomSolanaSignature()]);
    assert.equal(statuses(failed), "partially_completed:s1=settled,s2=failed");
    const stopped = await stopIntent(settled.id);
    assert.equal(statuses(stopped), "partially_completed:s1=settled,s2=skipped");
    assert.equal(step(stopped, "s2").failure?.code, "TRANSACTION_REVERTED", "the failure stays on record");
    assert.equal((await failure(stopIntent("int_00000000000000000000000000000000"))).code, "INTENT_NOT_FOUND");
  });
});
