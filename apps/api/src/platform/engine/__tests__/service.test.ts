import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { IntentGraph, IntentStep, StepStatus } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { subscribeIntentEvents, type IntentEvent } from "../events.js";
import {
  cancelIntent,
  createIntent,
  getIntent,
  prepareStep,
  refreshIntent,
  startSettlementPoller,
  submitStep,
} from "../service.js";
import type { MemoryIntentStore } from "../store.js";
import {
  ACCOUNTS,
  OTHER_EVM_ADDRESS,
  OTHER_SOL_ADDRESS,
  randomEvmHash,
  randomSolanaSignature,
  resetEngine,
  SOL_ADDRESS,
  stub,
  unsignedSolanaTransaction,
  JUPITER_PROGRAM,
} from "./helpers.js";

let store: MemoryIntentStore;

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

function step(graph: IntentGraph, id: string): IntentStep {
  const found = graph.steps.find((candidate) => candidate.id === id);
  assert.ok(found, `step ${id} exists`);
  return found;
}

function statuses(graph: IntentGraph): string {
  return `${graph.status}:${graph.steps.map((entry) => `${entry.id}=${entry.status}`).join(",")}`;
}

const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };
const BRIDGE_THEN_SWAP = { text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS };

describe("service lifecycle", () => {
  let events: IntentEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    store = resetEngine();
    events = [];
    unsubscribe = subscribeIntentEvents((event) => events.push(event));
  });

  afterEach(() => unsubscribe());

  it("creates, prepares, submits and settles a same-network step", async () => {
    const created = await createIntent(SWAP);
    assert.equal(statuses(created), "planned:s1=ready");
    const { intent: prepared, payload } = await prepareStep(created.id, "s1");
    assert.equal(statuses(prepared), "executing:s1=awaiting_signature");
    assert.equal(payload.vm, "svm");
    assert.equal(payload.transactions.length, 1);
    assert.equal(payload.quoteBinding, step(prepared, "s1").prepared?.quoteBinding);
    assert.match(payload.quoteBinding, /^[0-9a-f]{64}$/u);
    const signature = randomSolanaSignature();
    const settled = await submitStep(created.id, "s1", [signature]);
    assert.equal(statuses(settled), "completed:s1=settled");
    assert.deepEqual(step(settled, "s1").references, [signature]);
    assert.ok(step(settled, "s1").evidence.some((entry) => entry.kind === "transaction" && entry.reference === signature));
    assert.equal(step(settled, "s1").actualOutput, undefined, "stub verify reports no output");
    assert.deepEqual((await getIntent(created.id)).steps, settled.steps, "persisted");
  });

  it("emits events in lifecycle order", async () => {
    const created = await createIntent(SWAP);
    await prepareStep(created.id, "s1");
    await submitStep(created.id, "s1", [randomSolanaSignature()]);
    const mine = events.filter((event) => event.data.intentId === created.id);
    const sequence = mine.map((event) =>
      event.type === "intent.step_updated"
        ? `step:${event.data.status}`
        : event.type === "intent.status_changed"
          ? `status:${event.data.previous}->${event.data.status}`
          : "created");
    assert.deepEqual(sequence, [
      "created",
      "step:ready",
      "step:awaiting_signature",
      "status:planned->executing",
      "step:settled",
      "status:executing->completed",
    ]);
    assert.ok(mine.every((event) => /^evt_[0-9a-f]{32}$/u.test(event.id)));
    const settledEvent = mine.find((event) => event.type === "intent.step_updated" && event.data.status === "settled");
    assert.equal(settledEvent?.type === "intent.step_updated" ? settledEvent.data.evidence?.kind : null, "transaction");
  });

  it("validates reference count, format, repeats and step state without changing the step", async () => {
    const created = await createIntent(SWAP);
    const early = await failure(submitStep(created.id, "s1", [randomSolanaSignature()]));
    assert.equal(early.code, "STEP_NOT_AWAITING_SIGNATURE");
    assert.equal(early.status, 409);
    await prepareStep(created.id, "s1");
    const count = await failure(submitStep(created.id, "s1", [randomSolanaSignature(), randomSolanaSignature()]));
    assert.equal(count.code, "REFERENCE_COUNT_MISMATCH");
    assert.equal(count.status, 400);
    const format = await failure(submitStep(created.id, "s1", [randomEvmHash()]));
    assert.equal(format.code, "REFERENCE_INVALID");
    assert.equal(format.issues?.[0]?.path, "references[0]");
    const signature = randomSolanaSignature();
    assert.equal((await failure(submitStep(created.id, "s1", [signature, signature]))).code, "REFERENCES_INVALID");
    assert.equal((await failure(submitStep(created.id, "s1", []))).code, "REFERENCES_INVALID");
    assert.equal((await failure(submitStep(created.id, "s1", "0xabc"))).code, "REFERENCES_INVALID");
    assert.equal((await failure(submitStep(created.id, "s1", Array.from({ length: 5 }, randomSolanaSignature)))).code, "REFERENCES_INVALID");
    assert.equal((await failure(submitStep(created.id, "s9", [signature]))).code, "STEP_NOT_FOUND");
    assert.equal((await failure(submitStep("int_nope", "s1", [signature]))).code, "INTENT_NOT_FOUND");
    assert.equal(stub.calls.verify, 0, "nothing reached the chain");
    assert.equal(statuses(await getIntent(created.id)), "executing:s1=awaiting_signature");
  });

  it("refuses references that are not the step's transactions and keeps the step waiting", async () => {
    const created = await createIntent(SWAP);
    await prepareStep(created.id, "s1");
    for (const code of ["REFERENCE_WRONG_SENDER", "REFERENCE_MISMATCH", "REFERENCE_STALE", "REFERENCE_WRONG_CHAIN"]) {
      stub.verify = () => ({ status: "failed", evidence: [], failure: { code, message: `stub ${code}` } });
      const error = await failure(submitStep(created.id, "s1", [randomSolanaSignature()]));
      assert.equal(error.code, code);
      assert.equal(error.status, 422);
      const current = await getIntent(created.id);
      assert.equal(statuses(current), "executing:s1=awaiting_signature");
      assert.equal(step(current, "s1").references, undefined);
    }
    // The right transaction is still accepted afterwards.
    stub.verify = (context) => ({ status: "confirmed", evidence: [{ kind: "transaction", network: "solana", reference: context.references[0] as string, observedAt: new Date().toISOString() }] });
    assert.equal(statuses(await submitStep(created.id, "s1", [randomSolanaSignature()])), "completed:s1=settled");
  });

  it("keeps unverified references submitted and accepts a replacement (wallet speed-up)", async () => {
    const created = await createIntent({ text: `send 0.001 ETH to ${OTHER_EVM_ADDRESS} on arbitrum`, accounts: ACCOUNTS });
    await prepareStep(created.id, "s1");
    stub.verify = () => ({ status: "pending", evidence: [], reason: "not visible", stale: false });
    const first = randomEvmHash();
    const pending = await submitStep(created.id, "s1", [first]);
    assert.equal(statuses(pending), "executing:s1=submitted");
    assert.deepEqual(step(pending, "s1").references, [first]);
    // Same references again: idempotent, no second chain read.
    const before = stub.calls.verify;
    await submitStep(created.id, "s1", [first.toUpperCase().replace("0X", "0x")]);
    assert.equal(stub.calls.verify, before);
    // A replacement hash is verified and bound instead.
    stub.verify = (context) => ({ status: "confirmed", evidence: [{ kind: "receipt", network: "arbitrum", reference: context.references[0] as string, observedAt: new Date().toISOString() }] });
    const replacement = randomEvmHash();
    const settled = await submitStep(created.id, "s1", [replacement]);
    assert.equal(statuses(settled), "completed:s1=settled");
    assert.deepEqual(step(settled, "s1").references, [replacement]);
    // Once confirmed, new references are refused.
    assert.equal((await failure(submitStep(created.id, "s1", [randomEvmHash()]))).code, "STEP_NOT_AWAITING_SIGNATURE");
  });

  it("turns long-unseen references indeterminate and still accepts a replacement", async () => {
    const created = await createIntent({ text: `send 0.001 ETH to ${OTHER_EVM_ADDRESS} on arbitrum`, accounts: ACCOUNTS });
    await prepareStep(created.id, "s1");
    stub.verify = () => ({ status: "pending", evidence: [], reason: "not visible", stale: false });
    await submitStep(created.id, "s1", [randomEvmHash()]);
    stub.verify = () => ({ status: "pending", evidence: [], reason: "not visible", stale: true });
    const stale = await refreshIntent(created.id);
    assert.equal(statuses(stale), "indeterminate:s1=indeterminate");
    stub.verify = () => ({ status: "confirmed", evidence: [] });
    assert.equal(statuses(await submitStep(created.id, "s1", [randomEvmHash()])), "completed:s1=settled");
  });

  it("drops references rejected during refresh and returns the step to awaiting_signature", async () => {
    const created = await createIntent(SWAP);
    await prepareStep(created.id, "s1");
    stub.verify = () => ({ status: "pending", evidence: [], reason: "not visible", stale: false });
    await submitStep(created.id, "s1", [randomSolanaSignature()]);
    stub.verify = () => ({ status: "failed", evidence: [], failure: { code: "REFERENCE_WRONG_SENDER", message: "other payer" } });
    const refreshed = await refreshIntent(created.id);
    assert.equal(statuses(refreshed), "executing:s1=awaiting_signature");
    const current = step(refreshed, "s1");
    assert.equal(current.references, undefined);
    assert.ok(current.prepared, "the prepared payload is kept");
    assert.match(current.evidence.at(-1)?.detail ?? "", /References rejected \(REFERENCE_WRONG_SENDER\)/u);
  });

  it("fails a step on an on-chain failure and lets it be prepared again", async () => {
    const created = await createIntent(SWAP);
    await prepareStep(created.id, "s1");
    stub.verify = () => ({ status: "failed", evidence: [], failure: { code: "TRANSACTION_FAILED", message: "slippage exceeded" } });
    const failed = await submitStep(created.id, "s1", [randomSolanaSignature()]);
    assert.equal(statuses(failed), "failed:s1=failed");
    assert.equal(step(failed, "s1").failure?.code, "TRANSACTION_FAILED");
    const { intent } = await prepareStep(created.id, "s1");
    assert.equal(statuses(intent), "executing:s1=awaiting_signature");
    assert.equal(step(intent, "s1").failure, undefined);
    assert.equal(step(intent, "s1").references, undefined);
  });

  it("settles a cross-network step via the settlement poll and unlocks the funded step", async () => {
    const created = await createIntent(BRIDGE_THEN_SWAP);
    assert.equal(statuses(created), "planned:s1=ready,s2=pending");
    const notReady = await failure(prepareStep(created.id, "s2"));
    assert.equal(notReady.code, "STEP_NOT_READY");
    const { payload } = await prepareStep(created.id, "s1");
    assert.equal(payload.vm, "evm");
    assert.equal(payload.transactions.length, 2, "approve + deposit");
    const prepared = step(await getIntent(created.id), "s1");
    assert.ok(prepared.settlement?.trackingId, "tracking id recorded");
    assert.ok(prepared.evidence.some((entry) => entry.kind === "quote" && entry.reference === prepared.settlement?.trackingId));
    stub.poll = () => ({ status: "settling", evidence: [] });
    const settling = await submitStep(created.id, "s1", [randomEvmHash(), randomEvmHash()]);
    assert.equal(statuses(settling), "settling:s1=settling,s2=pending");
    const observed = { ...(step(settling, "s1").minimumOutput as NonNullable<IntentStep["minimumOutput"]>), amount: "30000000", formatted: "30" };
    stub.poll = () => ({ status: "settled", evidence: [{ kind: "settlement", network: "solana", reference: randomSolanaSignature(), observedAt: new Date().toISOString() }], actualOutput: observed });
    const settled = await refreshIntent(created.id);
    assert.equal(statuses(settled), "executing:s1=settled,s2=ready");
    assert.equal(step(settled, "s1").actualOutput?.amount, "30000000");
    const { intent, payload: second } = await prepareStep(created.id, "s2");
    assert.equal(second.vm, "svm");
    assert.equal(step(intent, "s2").input?.amount, "15000000", "half of the observed 30 USDC");
  });

  it("fails a cross-network step on a refund", async () => {
    const created = await createIntent({ text: "bridge 25 USDC from base to solana", accounts: ACCOUNTS });
    await prepareStep(created.id, "s1");
    stub.poll = () => ({ status: "failed", evidence: [], failure: { code: "SETTLEMENT_REFUNDED", message: "refunded" } });
    const graph = await submitStep(created.id, "s1", [randomEvmHash(), randomEvmHash()]);
    assert.equal(statuses(graph), "failed:s1=failed");
    assert.equal(step(graph, "s1").failure?.code, "SETTLEMENT_REFUNDED");
  });

  it("binds a reference to one step only (REFERENCE_ALREADY_USED)", async () => {
    const recipient = `send 0.001 ETH to ${OTHER_EVM_ADDRESS} on arbitrum`;
    const first = await createIntent({ text: recipient, accounts: ACCOUNTS });
    const second = await createIntent({ text: recipient, accounts: ACCOUNTS });
    await prepareStep(first.id, "s1");
    await prepareStep(second.id, "s1");
    const hash = randomEvmHash();
    assert.equal(statuses(await submitStep(first.id, "s1", [hash])), "completed:s1=settled");
    const reused = await failure(submitStep(second.id, "s1", [hash.toUpperCase().replace("0X", "0x")]));
    assert.equal(reused.code, "REFERENCE_ALREADY_USED");
    assert.equal(reused.status, 422);
    assert.equal(statuses(await getIntent(second.id)), "executing:s1=awaiting_signature");
  });

  it("refuses payloads that are not sent or fee-paid by the step account", async () => {
    const evm = await createIntent({ text: `send 0.001 ETH to ${OTHER_EVM_ADDRESS} on arbitrum`, accounts: ACCOUNTS });
    stub.tamper = (payload) => ({ ...payload, transactions: payload.transactions.map((transaction) => (transaction.vm === "evm" ? { ...transaction, from: OTHER_EVM_ADDRESS } : transaction)) });
    const foreignSender = await failure(prepareStep(evm.id, "s1"));
    assert.equal(foreignSender.code, "PAYLOAD_INVALID");
    assert.equal(statuses(await getIntent(evm.id)), "planned:s1=ready", "nothing persisted");

    const sol = await createIntent(SWAP);
    // Claims the right fee payer in the envelope but the wire transaction is paid by someone else.
    stub.tamper = (payload) => ({
      ...payload,
      transactions: payload.transactions.map((transaction) => (transaction.vm === "svm" ? { ...transaction, transaction: unsignedSolanaTransaction(OTHER_SOL_ADDRESS, JUPITER_PROGRAM) } : transaction)),
    });
    assert.equal((await failure(prepareStep(sol.id, "s1"))).code, "PROVIDER_TRANSACTION_REJECTED");
    // A second required signer is refused too.
    stub.tamper = (payload) => ({
      ...payload,
      transactions: payload.transactions.map((transaction) => (transaction.vm === "svm" ? { ...transaction, transaction: unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM, OTHER_SOL_ADDRESS) } : transaction)),
    });
    assert.equal((await failure(prepareStep(sol.id, "s1"))).code, "PROVIDER_TRANSACTION_REJECTED");
    // A recorded program the transaction never invokes is refused.
    stub.tamper = (payload) => ({ ...payload, records: payload.records.map((record) => ({ ...record, to: OTHER_SOL_ADDRESS })) });
    assert.equal((await failure(prepareStep(sol.id, "s1"))).code, "PAYLOAD_INVALID");
    stub.tamper = (payload) => ({ ...payload, transactions: [] , records: [] });
    assert.equal((await failure(prepareStep(sol.id, "s1"))).code, "PAYLOAD_INVALID");
    assert.equal(statuses(await getIntent(sol.id)), "planned:s1=ready");
  });

  it("refuses a first step whose fresh quote is below the planned minimum (QUOTE_MOVED)", async () => {
    const created = await createIntent(SWAP);
    stub.tamper = (payload) => ({ ...payload, expectedOutput: { ...payload.expectedOutput, amount: "100000000", formatted: "100" } });
    const moved = await failure(prepareStep(created.id, "s1"));
    assert.equal(moved.code, "QUOTE_MOVED");
    assert.equal(moved.status, 409);
  });

  it("cancels only before anything was submitted", async () => {
    const created = await createIntent(BRIDGE_THEN_SWAP);
    await prepareStep(created.id, "s1");
    const cancelled = await cancelIntent(created.id);
    assert.equal(statuses(cancelled), "cancelled:s1=skipped,s2=skipped");
    assert.equal((await failure(prepareStep(created.id, "s1"))).code, "INTENT_CANCELLED");
    assert.equal(statuses(await cancelIntent(created.id)), "cancelled:s1=skipped,s2=skipped", "idempotent");

    const started = await createIntent(SWAP);
    await prepareStep(started.id, "s1");
    stub.verify = () => ({ status: "pending", evidence: [], reason: "not visible", stale: false });
    await submitStep(started.id, "s1", [randomSolanaSignature()]);
    assert.equal((await failure(cancelIntent(started.id))).code, "INTENT_NOT_CANCELLABLE");
  });

  it("expires unstarted intents lazily and refuses to prepare them", async () => {
    const created = await createIntent(SWAP);
    const stored = await store.get(created.id);
    assert.ok(stored);
    await store.update(created.id, { ...stored, expiresAt: new Date(Date.now() - 1_000).toISOString(), updatedAt: new Date(Date.parse(stored.updatedAt) + 1).toISOString() }, stored.updatedAt);
    assert.equal((await getIntent(created.id)).status, "expired");
    const expired = await failure(prepareStep(created.id, "s1"));
    assert.equal(expired.code, "INTENT_EXPIRED");
    assert.equal(expired.status, 410);
  });

  it("does not persist dry runs and honours clientReference idempotency per key", async () => {
    const dry = await createIntent(SWAP, { dryRun: true });
    assert.equal((await failure(getIntent(dry.id))).code, "INTENT_NOT_FOUND");
    const request = { ...SWAP, clientReference: "order-42" };
    const first = await createIntent(request, { ownerKeyId: "key_a" });
    const again = await createIntent(request, { ownerKeyId: "key_a" });
    assert.equal(again.id, first.id);
    const otherKey = await createIntent(request, { ownerKeyId: "key_b" });
    assert.notEqual(otherKey.id, first.id);
  });

  it("serialises concurrent mutations of one intent", async () => {
    const created = await createIntent(SWAP);
    const results = await Promise.allSettled([prepareStep(created.id, "s1"), prepareStep(created.id, "s1"), prepareStep(created.id, "s1")]);
    assert.ok(results.every((result) => result.status === "fulfilled"), "no INTENT_CONFLICT inside one process");
    const graph = await getIntent(created.id);
    assert.equal(step(graph, "s1").evidence.filter((entry) => entry.kind === "quote" && /^[0-9a-f]{64}$/u.test(entry.reference ?? "")).length, 3);
  });
});

describe("settlement poller", () => {
  beforeEach(() => {
    store = resetEngine();
  });

  it("never leaks a rejection when the store or a refresh fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const created = await createIntent({ text: "bridge 25 USDC from base to solana", accounts: ACCOUNTS });
    await prepareStep(created.id, "s1");
    stub.poll = () => ({ status: "settling", evidence: [] });
    await submitStep(created.id, "s1", [randomEvmHash(), randomEvmHash()]);
    let listCalls = 0;
    const listActive = store.listActive.bind(store);
    store.listActive = async (limit: number) => {
      listCalls += 1;
      if (listCalls === 1) throw new Error("database down");
      return listActive(limit);
    };
    stub.poll = () => {
      throw new Error("relay down");
    };
    const stop = startSettlementPoller({ intervalMs: 2_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 4_300));
    } finally {
      stop();
      process.off("unhandledRejection", onUnhandled);
    }
    assert.ok(listCalls >= 2, "the poller kept ticking after a failed tick");
    assert.deepEqual(unhandled, []);
    const graph = await getIntent(created.id);
    assert.equal(step(graph, "s1").status satisfies StepStatus, "settling");
  });
});
