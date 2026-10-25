/**
 * Intent retention (docs/platform/data-retention.md): the request text is
 * removed 24 h after an intent became final (salted digest and length kept,
 * plan record digest recomputed, text-bearing receipt disclosures dropped),
 * the graph is deleted 30 days after (receipt disclosures and shares
 * withdrawn, signed payloads kept), stale intents follow the 7 / 90 day
 * bounds, and DELETE /v1/intents/{id} deletes on request (409 while a step is
 * in flight). Receipts downloaded before any of this still verify.
 *
 * Offline: stub venues, in-memory stores, a captured finalized Solana
 * transaction read through a fake RPC. Nothing signs or sends a transaction.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  INTENT_RETENTION,
  planRecordDigest,
  requestTextDigest,
  verifyReceipt,
  type IntentGraph,
  type ReceiptDocument,
  type RpcTransport,
} from "@kletia/core";
import { collectReceiptInputs, configurePlatform, getIntentStore } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { intentRetentionStage, redactIntentText, sweepIntentRetention } from "../../engine/retention.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, type CallOptions, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureHealthProbe } = await import("../health.js");
const { configureReceiptSigner, signerFromSeed } = await import("../receipts/signer.js");
const { configureReceiptStore, MemoryReceiptStore } = await import("../receipts/store.js");
const { ReceiptIssuer } = await import("../receipts/issuer.js");
const { receiptRetentionHooks } = await import("../intentRetention.js");

interface AnchorFixtures {
  readonly svm: { readonly getTransaction: { readonly slot: number; readonly transaction: { readonly signatures: string[] } }; readonly getBlock: { readonly blockhash: string } };
}

const fixtures = JSON.parse(fs.readFileSync(new URL("../../engine/__tests__/receiptAnchorFixtures.json", import.meta.url), "utf8")) as AnchorFixtures;
const SIGNATURE = fixtures.svm.getTransaction.transaction.signatures[0] as string;
const SLOT = Number(fixtures.svm.getTransaction.slot);
const TEXT = "swap 1 SOL to USDC";
const SWAP = { text: TEXT, accounts: ACCOUNTS };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const solanaRpc: RpcTransport = async (method, params) => {
  switch (method) {
    case "getSlot":
      return SLOT + 31;
    case "getSignatureStatuses":
      return { context: { slot: SLOT + 31 }, value: [params[0] && (params[0] as string[])[0] === SIGNATURE ? { slot: SLOT, confirmations: null, err: null, confirmationStatus: "finalized" } : null] };
    case "getTransaction":
      return params[0] === SIGNATURE ? fixtures.svm.getTransaction : null;
    case "getBlock":
      return { blockhash: fixtures.svm.getBlock.blockhash };
    default:
      throw new Error(`unexpected Solana call ${method}`);
  }
};

let server: TestServer;
let receipts: InstanceType<typeof MemoryReceiptStore>;
const signer = signerFromSeed(createHash("sha256").update("kletia retention test seed").digest(), { status: "active", notBefore: "2026-01-01" });

function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
  return rawCall<T>(server, method, path, { key: OPERATOR_KEY, ...options });
}

async function plannedIntent(): Promise<IntentGraph> {
  const created = await call<{ intent: IntentGraph }>("POST", "/intents", { body: SWAP });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.intent;
}

async function completedIntent(): Promise<IntentGraph> {
  const id = (await plannedIntent()).id;
  assert.equal((await call("POST", `/intents/${id}/steps/s1/prepare`)).status, 200);
  const settled = await call<{ intent: IntentGraph }>("POST", `/intents/${id}/steps/s1/submit`, { body: { references: [SIGNATURE] } });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.intent.status, "completed");
  return settled.body.intent;
}

async function issueReceipt(intentId: string, now: number): Promise<ReceiptDocument> {
  const issuer = new ReceiptIssuer({ collect: (graph) => collectReceiptInputs(graph, { transports: { solana: solanaRpc }, now }), now: () => now });
  await receipts.enqueue({ intentId, ownerKeyId: null, reason: "scan", notBefore: new Date(now - 1_000).toISOString() });
  await issuer.runDue();
  const reply = await call<{ receipt: ReceiptDocument }>("GET", `/intents/${intentId}/receipt`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.receipt;
}

before(async () => {
  resetEngine();
  configureHealthProbe((network) => Promise.resolve({ network, chain: "x", name: network, environment: "mainnet", ok: true, latencyMs: 1 }));
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configurePlatform({ adapters: null });
  configureReceiptSigner(null);
  configureReceiptStore(null);
  configureHealthProbe(null);
  await server.close();
});

beforeEach(() => {
  resetEngine();
  receipts = new MemoryReceiptStore();
  configureReceiptStore(receipts);
  configureReceiptSigner(signer);
});

describe("retention policy", () => {
  it("keeps a final intent's text for 24 hours, then redacts it, and purges after 30 days", async () => {
    const intent = await completedIntent();
    const finished = Date.parse(intent.updatedAt);
    assert.equal(intentRetentionStage(intent, finished + INTENT_RETENTION.textGraceMs - 1), "keep");
    assert.equal(intentRetentionStage(intent, finished + INTENT_RETENTION.textGraceMs), "redact");
    assert.equal(intentRetentionStage(intent, finished + INTENT_RETENTION.purgeAfterMs), "purge");
  });

  it("dates an unprepared intent's end from its expiry, and a stale one from its last change", async () => {
    const intent = await plannedIntent();
    const expired = Date.parse(intent.expiresAt);
    assert.equal(intentRetentionStage(intent, expired + INTENT_RETENTION.textGraceMs + 1), "redact", "expired lazily: final at expiresAt");
    const stuck: IntentGraph = { ...intent, status: "indeterminate", steps: intent.steps.map((step) => ({ ...step, status: "indeterminate" as const })) };
    const changed = Date.parse(stuck.updatedAt);
    assert.equal(intentRetentionStage(stuck, changed + INTENT_RETENTION.staleTextMs - 1), "keep");
    assert.equal(intentRetentionStage(stuck, changed + INTENT_RETENTION.staleTextMs), "redact");
    assert.equal(intentRetentionStage(stuck, changed + INTENT_RETENTION.stalePurgeMs), "purge");
  });

  it("replaces the text with a salted digest and its length and recomputes the plan digest", async () => {
    const intent = await completedIntent();
    const redacted = redactIntentText(intent, Date.parse(intent.updatedAt) + DAY, "c2FsdHNhbHRzYWx0c2FsdA");
    assert.ok(redacted);
    const graph = redacted.graph;
    assert.equal(graph.request.text, undefined);
    assert.equal(graph.interpretation.normalizedText, undefined);
    assert.equal(graph.request.textRedaction?.alg, "sha256-salted-v1");
    assert.equal(graph.request.textRedaction?.length, [...TEXT].length);
    assert.equal(graph.request.textRedaction?.digest, requestTextDigest(TEXT, "c2FsdHNhbHRzYWx0c2FsdA"), "whoever kept the text can prove it");
    assert.notEqual(graph.request.textRedaction?.digest, requestTextDigest(TEXT, "b3RoZXJzYWx0b3RoZXJzYQ"), "another salt, another digest");
    assert.equal(graph.plan?.record.interpretation.normalizedText, null);
    assert.equal(graph.plan?.digest, planRecordDigest(graph.plan!.record), "the plan digest matches the redacted record");
    assert.equal(graph.updatedAt, intent.updatedAt, "updatedAt is unchanged");
    assert.equal(JSON.stringify(graph).includes(TEXT), false, "the sentence is nowhere in the graph");
    assert.deepEqual(graph.request.accounts, intent.request.accounts);
    assert.equal(redactIntentText(graph, Date.now()), null, "nothing left to redact");
  });
});

describe("retention sweep", () => {
  it("redacts the text, drops the text-bearing receipt disclosures, and earlier receipts still verify", async () => {
    const intent = await completedIntent();
    const issuedAt = Date.parse(intent.updatedAt) + 60_000;
    const downloaded = await issueReceipt(intent.id, issuedAt);
    assert.ok(downloaded.disclosures?.["intent.request"], "the receipt discloses the request before redaction");

    const early = await sweepIntentRetention({ now: Date.parse(intent.updatedAt) + HOUR, hooks: receiptRetentionHooks() });
    assert.deepEqual(early, { redacted: 0, purged: 0 }, "nothing happens inside the grace window");

    const result = await sweepIntentRetention({ now: Date.parse(intent.updatedAt) + INTENT_RETENTION.textGraceMs + HOUR, hooks: receiptRetentionHooks() });
    assert.deepEqual(result, { redacted: 1, purged: 0 });
    const read = await call<{ intent: IntentGraph }>("GET", `/intents/${intent.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.intent.request.text, undefined);
    assert.ok(read.body.intent.request.textRedaction);
    assert.equal(JSON.stringify(read.body.intent).includes(TEXT), false);

    const served = await call<{ receipt: ReceiptDocument }>("GET", `/intents/${intent.id}/receipt`);
    assert.equal(served.body.receipt.disclosures?.["intent.request"], undefined, "the request group can no longer be disclosed");
    assert.equal(served.body.receipt.disclosures?.["intent.plan"], undefined);
    assert.ok(served.body.receipt.disclosures?.["steps.s1.evidence"], "step groups stay");
    assert.equal(JSON.stringify(served.body.receipt.disclosures).includes(TEXT), false);
    assert.equal((await verifyReceipt(served.body.receipt, { keys: [signer.publicKey], intentId: intent.id })).valid, true, "the stored receipt still verifies");
    assert.equal((await verifyReceipt(downloaded, { keys: [signer.publicKey], intentId: intent.id, requireGroups: ["intent.request"] })).valid, true, "a receipt downloaded earlier still verifies with its request group");

    const full = await call<{ share: { groups: string[] } }>("POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "full" } });
    assert.equal(full.status, 201, JSON.stringify(full.body));
    assert.equal(full.body.share.groups.includes("intent.request"), false, "a share lists only the groups it carries");
    assert.ok(full.body.share.groups.includes("steps.s1.evidence"));
    assertError(await call("POST", `/intents/${intent.id}/receipt/shares`, { body: { groups: ["intent.request"] } }), 400, "INVALID_REQUEST");
  });

  it("purges the graph 30 days after it became final, withdraws disclosures and keeps the signed payload", async () => {
    const intent = await completedIntent();
    const receipt = await issueReceipt(intent.id, Date.parse(intent.updatedAt) + 60_000);
    const result = await sweepIntentRetention({ now: Date.parse(intent.updatedAt) + INTENT_RETENTION.purgeAfterMs + HOUR, hooks: receiptRetentionHooks() });
    assert.equal(result.purged, 1);
    assertError(await call("GET", `/intents/${intent.id}`), 404, "INTENT_NOT_FOUND");
    const stored = await receipts.byId(receipt.payload.receiptId);
    assert.ok(stored, "the signed receipt row stays (log leaf, public verification)");
    assert.equal(stored.disclosures, null, "no stored disclosures are left");
    assert.equal((await verifyReceipt(receipt, { keys: [signer.publicKey], intentId: intent.id })).valid, true, "the downloaded receipt still verifies");
  });

  it("keeps intents that are not due and deletes stale ones after 90 days", async () => {
    const intent = await plannedIntent();
    const store = getIntentStore();
    const stuck: IntentGraph = { ...intent, status: "indeterminate", steps: intent.steps.map((step) => ({ ...step, status: "indeterminate" as const })) };
    await store.update(intent.id, stuck, intent.updatedAt);
    const changed = Date.parse(intent.updatedAt);
    assert.deepEqual(await sweepIntentRetention({ now: changed + INTENT_RETENTION.staleTextMs - HOUR }), { redacted: 0, purged: 0 });
    assert.deepEqual(await sweepIntentRetention({ now: changed + INTENT_RETENTION.staleTextMs + HOUR }), { redacted: 1, purged: 0 });
    assert.deepEqual(await sweepIntentRetention({ now: changed + INTENT_RETENTION.stalePurgeMs + HOUR }), { redacted: 0, purged: 1 });
    assert.equal(await store.get(intent.id), null);
  });
});

describe("DELETE /v1/intents/{id}", () => {
  it("deletes the intent for the holder of its id and withdraws its receipt disclosures", async () => {
    const intent = await completedIntent();
    const receipt = await issueReceipt(intent.id, Date.parse(intent.updatedAt) + 60_000);
    const removed = await rawCall(server, "DELETE", `/intents/${intent.id}`);
    assert.equal(removed.status, 204, "the intent id is the capability, as for reading it");
    assertError(await call("GET", `/intents/${intent.id}`), 404, "INTENT_NOT_FOUND");
    assertError(await call("DELETE", `/intents/${intent.id}`), 404, "INTENT_NOT_FOUND");
    assert.equal((await receipts.byId(receipt.payload.receiptId))?.disclosures, null);
    assert.equal((await verifyReceipt(receipt, { keys: [signer.publicKey], intentId: intent.id })).valid, true);
  });

  it("refuses while a step is in flight", async () => {
    const intent = await plannedIntent();
    const store = getIntentStore();
    const moving: IntentGraph = { ...intent, status: "settling", steps: intent.steps.map((step) => ({ ...step, status: "settling" as const })) };
    await store.update(intent.id, moving, intent.updatedAt);
    assertError(await call("DELETE", `/intents/${intent.id}`), 409, "INTENT_IN_FLIGHT");
    assert.ok(await store.get(intent.id), "nothing was deleted");
  });

  it("rejects malformed ids", async () => {
    assertError(await call("DELETE", "/intents/not-an-id"), 400, "INVALID_REQUEST");
  });
});

describe("privacy trace of POST /v1/intents", () => {
  it("says what was stored, for how long, and how to delete it; a dry run stores nothing", async () => {
    const stored = await call<{ intent: IntentGraph; privacy: import("@kletia/core").PlatformPrivacyTrace }>("POST", "/intents", { body: SWAP });
    assert.equal(stored.status, 201);
    assert.deepEqual(stored.body.privacy.storage, { stored: true, textHoursAfterFinal: 24, intentDaysAfterFinal: 30, deleteWith: "DELETE /v1/intents/{id}" });
    assert.equal(stored.body.privacy.modelProvider.sent, "nothing");
    assert.deepEqual(
      stored.body.privacy.quoteProviders,
      (stored.body.intent.interpretation.providersContacted ?? []).map((contact) => ({ provider: contact.provider, sawAccount: contact.sawAccount })),
    );
    const dry = await call<{ privacy: import("@kletia/core").PlatformPrivacyTrace }>("POST", "/intents?dryRun=true", { body: SWAP });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.privacy.storage, { stored: false, textHoursAfterFinal: null, intentDaysAfterFinal: null, deleteWith: null });
    assert.equal(JSON.stringify(stored.body.privacy).includes(TEXT), false, "the trace never repeats the request");
  });
});
