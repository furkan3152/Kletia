/**
 * Verifiable receipts over HTTP (receipts design R3): the issuer (event →
 * queue → finality wait → issue, dedupe, supersession, concurrent issuers,
 * self-verification, kill switch, missing and development keys), the owner
 * and public routes (200 / 202 / 409 / 404), shares (key once, idempotent
 * replay sealed, list, revoke, expiry, limit, withdrawal), the key set, the
 * transparency log (batches, signatures, inclusion, pagination, anchors),
 * webhooks and SSE for `intent.receipt_issued`, MCP `get_receipt`, health
 * and usage, and the optional EAS envelope.
 *
 * Offline: stub venues, in-memory stores, and the real engine collector
 * reading a captured, finalized Solana v1 transaction through a fake RPC.
 * Nothing here signs or sends a transaction.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  intentRef,
  merkleAuditPath,
  merkleRoot,
  RECEIPT_ID_PATTERN,
  receiptKeyId,
  receiptLogBatchDigest,
  verifyMerkleInclusion,
  verifyReceipt,
  verifyReceiptLogBatch,
  type IntentGraph,
  type IntentStep,
  type ReceiptDocument,
  type ReceiptKey,
  type RpcTransport,
} from "@kletia/core";
import {
  collectReceiptInputs,
  configurePlatform,
  getIntentStore,
  subscribeReceiptEvents,
  type IntentEvent,
  type ReceiptEvent,
} from "../../index.js";
import { ACCOUNTS, resetEngine, stub } from "../../engine/__tests__/helpers.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, waitFor, withDatabaseTestLock, type CallOptions, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureHealthProbe } = await import("../health.js");
const { configureReceiptSigner, loadReceiptKeyring, resetReceiptKeyring, signerFromSeed } = await import("../receipts/signer.js");
const { configureReceiptStore, MemoryReceiptStore } = await import("../receipts/store.js");
const { ReceiptIssuer, intentStateDigest, startReceiptIssuer } = await import("../receipts/issuer.js");
const { closeReceiptBatch, configureAnchorTransport, EAS_GET_TIMESTAMP_SELECTOR, EAS_TIMESTAMP_SELECTOR, EAS_TIMESTAMPED_TOPIC, merkleTree, watchAnchors } = await import("../receipts/log.js");
const { decryptShare, parseShareUrl } = await import("../receipts/shares.js");
const { attestReceipt, verifyEasEnvelope, EAS_ADDRESS } = await import("../receipts/eas.js");
const { WebhookDispatcher } = await import("../dispatcher.js");

/* ------------------------------------------------------------ fixtures */

interface AnchorFixtures {
  readonly svm: { readonly getTransaction: { readonly slot: number; readonly transaction: { readonly signatures: string[] } }; readonly getBlock: { readonly blockhash: string } };
}

const fixtures = JSON.parse(fs.readFileSync(new URL("../../engine/__tests__/receiptAnchorFixtures.json", import.meta.url), "utf8")) as AnchorFixtures;
/** A finalized Solana v1 transaction captured read-only on 2026-10-09 (the receipt vectors' anchor). */
const SIGNATURE = fixtures.svm.getTransaction.transaction.signatures[0] as string;
const SLOT = Number(fixtures.svm.getTransaction.slot);
const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };
const SEED = createHash("sha256").update("kletia receipts http test seed").digest();
const MCP_VERSION = "2026-07-28";
const MCP_META = {
  "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "kletia-tests", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

let solanaConfirmation: "confirmed" | "finalized" = "finalized";

/** Answers the reads the engine collector makes for the fixture signature. */
const solanaRpc: RpcTransport = async (method, params) => {
  switch (method) {
    case "getSlot":
      return SLOT + 31;
    case "getSignatureStatuses":
      return { context: { slot: SLOT + 31 }, value: [params[0] && (params[0] as string[])[0] === SIGNATURE ? { slot: SLOT, confirmations: null, err: null, confirmationStatus: solanaConfirmation } : null] };
    case "getTransaction":
      return params[0] === SIGNATURE ? fixtures.svm.getTransaction : null;
    case "getBlock":
      return { blockhash: fixtures.svm.getBlock.blockhash };
    default:
      throw new Error(`unexpected Solana call ${method}`);
  }
};

let clock = Date.now();
const collect = (graph: IntentGraph) => collectReceiptInputs(graph, { transports: { solana: solanaRpc }, now: clock });

function newIssuer(options: { collect?: typeof collect } = {}) {
  return new ReceiptIssuer({ collect: options.collect ?? collect, now: () => clock });
}

/* ------------------------------------------------------------ server */

let server: TestServer;
let store: InstanceType<typeof MemoryReceiptStore>;
const signer = signerFromSeed(SEED, { status: "active", notBefore: "2026-01-01" });

/** Every call carries the operator key (1,200 a minute) unless the test sends its own or none. */
function call<T = unknown>(target: TestServer, method: string, path: string, options: CallOptions & { anonymous?: boolean } = {}): Promise<Reply<T>> {
  const { anonymous, ...rest } = options;
  return rawCall<T>(target, method, path, anonymous ? rest : { key: OPERATOR_KEY, ...rest });
}

async function issueDeveloperKey(): Promise<{ key: string; id: string }> {
  const reply = await rawCall<{ key: { key: string; id: string } }>(server, "POST", "/keys", { body: { name: "receipts" } });
  assert.equal(reply.status, 201);
  return { key: reply.body.key.key, id: reply.body.key.id };
}

/** Creates the swap intent and settles it with the fixture signature as its reference. */
async function completedIntent(key = OPERATOR_KEY): Promise<IntentGraph> {
  const created = await rawCall<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.intent.id;
  assert.equal((await rawCall(server, "POST", `/intents/${id}/steps/s1/prepare`, { key })).status, 200);
  const settled = await rawCall<{ intent: IntentGraph }>(server, "POST", `/intents/${id}/steps/s1/submit`, { key, body: { references: [SIGNATURE] } });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.intent.status, "completed");
  return settled.body.intent;
}

function statusChanged(intentId: string, status: IntentGraph["status"]): IntentEvent {
  return { id: `evt_${"0".repeat(32)}`, type: "intent.status_changed", at: new Date(clock).toISOString(), data: { intentId, status, previous: "executing" } } as IntentEvent;
}

/** Enqueues through the issuer's event path and waits for the row. */
async function enqueueByEvent(issuer: InstanceType<typeof ReceiptIssuer>, intentId: string, status: IntentGraph["status"] = "completed"): Promise<void> {
  issuer.onEvent(statusChanged(intentId, status));
  await waitFor(async () => (await store.queueEntry(intentId)) !== null, 2_000, "queue row");
}

/** Queues an intent and processes it once, due now. */
async function issueNow(issuer: InstanceType<typeof ReceiptIssuer>, intentId: string) {
  const due = new Date(clock - 1_000).toISOString();
  await store.enqueue({ intentId, ownerKeyId: null, reason: "scan", notBefore: due });
  const entry = await store.queueEntry(intentId);
  if (entry && Date.parse(entry.notBefore) > clock) await store.reschedule(intentId, { notBefore: due, pendingReason: entry.pendingReason });
  return issuer.runDue();
}

async function receiptOf(intentId: string): Promise<ReceiptDocument> {
  const reply = await call<{ receipt: ReceiptDocument }>(server, "GET", `/intents/${intentId}/receipt`);
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
  configureAnchorTransport(null);
  configureHealthProbe(null);
  await server.close();
});

beforeEach(() => {
  resetEngine();
  clock = Date.now();
  solanaConfirmation = "finalized";
  store = new MemoryReceiptStore();
  configureReceiptStore(store);
  configureReceiptSigner(signer);
  delete process.env.KLETIA_RECEIPTS_ENABLED;
});

afterEach(() => {
  delete process.env.KLETIA_RECEIPTS_ENABLED;
});

/* ============================================================ issuer */

describe("receipt issuer", () => {
  it("waits for finality, then issues a receipt that verifies offline with the published key", async () => {
    const intent = await completedIntent();
    const events: ReceiptEvent[] = [];
    const unsubscribe = subscribeReceiptEvents((event) => events.push(event));
    try {
      const issuer = newIssuer();
      await enqueueByEvent(issuer, intent.id);
      const queued = await store.queueEntry(intent.id);
      assert.ok(queued && Date.parse(queued.notBefore) >= clock + 59_000, "events wait 60 s");
      assert.deepEqual(await issuer.runDue(), [], "nothing is due yet");

      const early = await call<{ receipt: null; pending: { reason: string; retryAfterSeconds: number } }>(server, "GET", `/intents/${intent.id}/receipt`);
      assert.equal(early.status, 202);
      assert.equal(early.body.receipt, null);
      assert.equal(early.body.pending.reason, "queued");
      assert.ok(Number(early.headers.get("retry-after")) >= 5);

      clock += 61_000;
      solanaConfirmation = "confirmed";
      const [waiting] = await issuer.runDue();
      assert.equal(waiting?.kind, "rescheduled");
      assert.equal(waiting?.kind === "rescheduled" ? waiting.reason : null, "awaiting_finality");
      const pending = await call<{ pending: { reason: string; expectedBy: string | null } }>(server, "GET", `/intents/${intent.id}/receipt`);
      assert.equal(pending.status, 202);
      assert.equal(pending.body.pending.reason, "awaiting_finality");
      assert.ok(pending.body.pending.expectedBy && Date.parse(pending.body.pending.expectedBy) > clock, "expectedBy from the measured lag");

      clock = Date.parse((await store.queueEntry(intent.id))?.notBefore ?? "") + 1_000;
      solanaConfirmation = "finalized";
      const [issued] = await issuer.runDue();
      assert.equal(issued?.kind, "issued", JSON.stringify(issued));
      assert.equal(await store.queueEntry(intent.id), null, "the queue row is gone");

      const receipt = await receiptOf(intent.id);
      assert.match(receipt.payload.receiptId, RECEIPT_ID_PATTERN);
      assert.equal(receipt.payload.sequence, 1);
      assert.equal(receipt.payload.supersedes, null);
      assert.equal(receipt.payload.intent.ref, intentRef(intent.id));
      assert.equal(receipt.payload.intent.status, "completed");
      assert.equal(receipt.payload.intent.finality, "finalized");
      assert.equal(JSON.stringify(receipt.payload).includes(intent.id), false, "the intent id never appears in the payload");
      const evidence = receipt.disclosures?.["steps.s1.evidence"]?.value as unknown as { anchors: { vm: string; version?: string; signature?: string }[] };
      assert.equal(evidence.anchors.length, 1);
      assert.equal(evidence.anchors[0]?.version, "1", "a Solana v1 anchor");
      assert.equal(evidence.anchors[0]?.signature, SIGNATURE);

      const keys = await call<{ keys: ReceiptKey[]; attesters: unknown[] }>(server, "GET", "/receipts/keys", { anonymous: true });
      assert.equal(keys.status, 200);
      assert.equal(keys.headers.get("cache-control"), "public, max-age=3600");
      assert.equal(keys.body.keys[0]?.kid, signer.kid);
      assert.equal(keys.body.keys[0]?.alg, "Ed25519");
      assert.equal(keys.body.keys[0]?.kty, "OKP");
      assert.equal(keys.body.keys[0]?.status, "active");
      assert.deepEqual(keys.body.attesters, []);
      const check = await verifyReceipt(receipt, { keys: keys.body.keys, intentId: intent.id, requireGroups: ["steps.*.evidence", "intent.request"] });
      assert.equal(check.valid, true, JSON.stringify(check.problems));
      assert.equal(check.key.provenance, "supplied");
      assert.equal(check.sealed.length, 0, "the owner reads every group");
      assert.equal((await verifyReceipt(receipt, { keys: keys.body.keys, intentId: `int_${"1".repeat(32)}` })).valid, false, "bound to the intent id");

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "intent.receipt_issued");
      assert.equal(events[0]?.data.digest, receipt.digest);
      assert.equal(events[0]?.data.terminal, true);

      const list = await call<{ receipts: { sequence: number; digest: string; supersededBy: string | null }[] }>(server, "GET", `/intents/${intent.id}/receipts`);
      assert.deepEqual(list.body.receipts.map((entry) => [entry.sequence, entry.digest, entry.supersededBy]), [[1, receipt.digest, null]]);

      // A scan re-queues it: the state digest is unchanged, nothing new is issued.
      const [again] = await issueNow(issuer, intent.id);
      assert.deepEqual(again, { kind: "dropped", reason: "unchanged" });
      assert.equal((await store.list(intent.id)).length, 1);
    } finally {
      unsubscribe();
    }
  });

  it("supersedes a failed receipt when the retried step settles (sequence 2), and drops non-receiptable intents", async () => {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    const issuer = newIssuer();
    assert.deepEqual(await issueNow(issuer, id), [{ kind: "dropped", reason: "not_receiptable" }]);

    const intents = getIntentStore();
    const planned = (await intents.get(id)) as IntentGraph;
    const failedStep: IntentStep = { ...(planned.steps[0] as IntentStep), status: "failed", failure: { code: "SIMULATION_FAILED", message: "the swap reverted in simulation" } };
    const failed: IntentGraph = { ...planned, status: "failed", steps: [failedStep], updatedAt: new Date(Date.parse(planned.updatedAt) + 1).toISOString() };
    await intents.update(id, failed, planned.updatedAt);
    const [first] = await issueNow(issuer, id);
    assert.equal(first?.kind, "issued", JSON.stringify(first));
    const one = await receiptOf(id);
    assert.equal(one.payload.intent.status, "failed");
    assert.equal(one.payload.intent.terminal, false);
    assert.equal(one.payload.intent.finality, "none");
    assert.equal(one.payload.steps[0]?.failure?.code, "SIMULATION_FAILED");

    const now = new Date(Date.parse(failed.updatedAt) + 1).toISOString();
    const settledStep: IntentStep = {
      ...(planned.steps[0] as IntentStep),
      status: "settled",
      references: [SIGNATURE],
      evidence: [
        { kind: "note", network: "solana", reference: SIGNATURE, observedAt: now, detail: "References submitted." },
        { kind: "transaction", network: "solana", reference: SIGNATURE, observedAt: now },
      ],
    };
    const completed: IntentGraph = { ...failed, status: "completed", steps: [settledStep], updatedAt: now };
    await intents.update(id, completed, failed.updatedAt);
    const [second] = await issueNow(issuer, id);
    assert.equal(second?.kind, "issued", JSON.stringify(second));
    const two = await receiptOf(id);
    assert.equal(two.payload.sequence, 2);
    assert.equal(two.payload.supersedes, one.digest);
    assert.equal(two.payload.intent.terminal, true);
    const older = await call<{ receipt: ReceiptDocument }>(server, "GET", `/intents/${id}/receipt?sequence=1`);
    assert.equal(older.body.receipt.digest, one.digest);
    assertError(await call(server, "GET", `/intents/${id}/receipt?sequence=3`), 404, "RECEIPT_NOT_FOUND");
    assertError(await call(server, "GET", `/intents/${id}/receipt?sequence=zero`), 400, "INVALID_REQUEST");
    const list = await call<{ receipts: { receiptId: string; sequence: number; supersededBy: string | null }[] }>(server, "GET", `/intents/${id}/receipts`);
    assert.equal(list.body.receipts[0]?.supersededBy, two.payload.receiptId);
    assert.equal(list.body.receipts[1]?.supersededBy, null);
  });

  it("stores one receipt when two issuers race for the same intent", async () => {
    const intent = await completedIntent();
    await store.enqueue({ intentId: intent.id, ownerKeyId: null, reason: "scan", notBefore: new Date(clock - 1).toISOString() });
    const [entry] = await store.claim(new Date(clock).toISOString(), 1, 120_000);
    assert.ok(entry);
    const outcomes = await Promise.all([newIssuer().process(entry), newIssuer().process(entry)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["dropped", "issued"]);
    assert.equal((await store.list(intent.id)).length, 1);
  });

  it("aborts issuance when the receipt does not verify (a broken signer), with nothing stored", async () => {
    const intent = await completedIntent();
    const other = signerFromSeed(randomBytes(32));
    configureReceiptSigner({ kid: signer.kid, publicKey: signer.publicKey, sign: (message) => other.sign(message) });
    const [outcome] = await issueNow(newIssuer(), intent.id);
    assert.equal(outcome?.kind, "rescheduled");
    assert.equal(outcome?.kind === "rescheduled" ? outcome.reason : null, "issuer_error");
    assert.equal((await store.list(intent.id)).length, 0);
  });

  it("keeps queueing without a key and honours the kill switch", async () => {
    const intent = await completedIntent();
    configureReceiptSigner(null, { keys: [] });
    const [missing] = await issueNow(newIssuer(), intent.id);
    assert.equal(missing?.kind === "rescheduled" ? missing.reason : null, "signer_missing");
    assert.ok(await store.queueEntry(intent.id), "the entry stays queued");
    assertError(await call(server, "GET", `/intents/${intent.id}/receipt`), 503, "RECEIPTS_DISABLED");

    configureReceiptSigner(signer);
    clock += 11 * 60_000;
    const [issued] = await newIssuer().runDue();
    assert.equal(issued?.kind, "issued", "a key added later drains the queue");

    process.env.KLETIA_RECEIPTS_ENABLED = "false";
    assert.deepEqual(await issueNow(newIssuer(), intent.id), [], "the kill switch issues nothing");
    assert.equal((await call(server, "GET", `/intents/${intent.id}/receipt`)).status, 200, "existing receipts stay readable");
    resetEngine();
    const next = await completedIntent();
    assertError(await call(server, "GET", `/intents/${next.id}/receipt`), 503, "RECEIPTS_DISABLED");
    const stop = startReceiptIssuer();
    stop();
    const health = await call<{ receipts: { signer: string } }>(server, "GET", "/health");
    assert.equal(health.body.receipts.signer, "disabled");
  });

  it("reschedules RPC trouble with backoff, reorgs with an alert, and finality past the budget as finality_timeout", async () => {
    const intent = await completedIntent();
    const failing = newIssuer({ collect: async () => ({ state: "retry", anchors: {}, landedBindings: {}, finalityHeads: [], finalityMode: [], expectedBy: null, detail: "rpc down" }) });
    const [retry] = await issueNow(failing, intent.id);
    assert.equal(retry?.kind === "rescheduled" ? retry.reason : null, "rpc_unavailable");
    const reorg = newIssuer({ collect: async () => ({ state: "reorged", anchors: {}, landedBindings: {}, finalityHeads: [], finalityMode: [], expectedBy: null, detail: "slot moved" }) });
    const [reorged] = await issueNow(reorg, intent.id);
    assert.equal(reorged?.kind === "rescheduled" ? reorged.reason : null, "anchor_reorged");
    const waiting = newIssuer({ collect: async () => ({ state: "waiting_finality", anchors: {}, landedBindings: {}, finalityHeads: [], finalityMode: [], expectedBy: new Date(clock + 600_000).toISOString(), detail: "not final" }) });
    clock += 3 * 3_600_000;
    const [late] = await issueNow(waiting, intent.id);
    assert.equal(late?.kind === "rescheduled" ? late.reason : null, "finality_timeout");
    assert.equal((await store.list(intent.id)).length, 0, "never issued on unfinalized data");
  });
});

/* ============================================================ routes */

describe("receipt routes", () => {
  it("answers 409 while the intent runs or expired, and 404 for unknown intents", async () => {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    const notReady = assertError(await call(server, "GET", `/intents/${id}/receipt`), 409, "RECEIPT_NOT_READY");
    assert.match(notReady.error.message, /planned/u);
    const intents = getIntentStore();
    const graph = (await intents.get(id)) as IntentGraph;
    await intents.update(id, { ...graph, expiresAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.parse(graph.updatedAt) + 1).toISOString() }, graph.updatedAt);
    assertError(await call(server, "GET", `/intents/${id}/receipt`), 409, "RECEIPT_NOT_APPLICABLE");
    assertError(await call(server, "GET", `/intents/int_${"0".repeat(32)}/receipt`), 404, "INTENT_NOT_FOUND");
    assertError(await call(server, "GET", "/intents/int_bad/receipt"), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${id}/receipt/shares`, { body: {} }), 409, "RECEIPT_NOT_APPLICABLE");
    assertError(await call(server, "DELETE", `/intents/${id}/receipt/disclosures`), 409, "RECEIPT_NOT_APPLICABLE");
    assert.deepEqual((await call<{ receipts: unknown[] }>(server, "GET", `/intents/${id}/receipts`)).body.receipts, []);
  });

  it("shares a receipt: link once, encrypted groups, public payload only while shared, revoke, expiry and limit", async () => {
    const intent = await completedIntent();
    await issueNow(newIssuer(), intent.id);
    const receipt = await receiptOf(intent.id);
    const receiptId = receipt.payload.receiptId;
    assertError(await call(server, "GET", `/receipts/${receiptId}`), 404, "RECEIPT_NOT_FOUND");

    const created = await call<{ share: { id: string; url: string; groups: string[]; expiresAt: string; sequence: number } }>(
      server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "proof", expiresInSeconds: 7 * 86_400 } },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const share = created.body.share;
    assert.deepEqual([...share.groups].sort(), ["intent.outcome", "intent.timing", "steps.s1.amounts", "steps.s1.evidence"]);
    assert.equal(share.sequence, 1);
    assert.ok(Math.abs(Date.parse(share.expiresAt) - (Date.now() + 7 * 86_400_000)) < 60_000);
    const link = parseShareUrl(share.url);
    assert.ok(link, share.url);
    assert.ok(share.url.startsWith(`https://kletiaai.xyz/r/${receiptId}#s=${share.id}&k=`), share.url);
    assert.equal(JSON.stringify(created.body).includes(intent.id), false);

    const listed = await call<{ shares: { id: string; url?: string }[] }>(server, "GET", `/intents/${intent.id}/receipt/shares`);
    assert.deepEqual(listed.body.shares.map((entry) => entry.id), [share.id]);
    assert.equal(listed.body.shares[0]?.url, undefined, "the key is never returned again");

    const publicReceipt = await call<{ receipt: ReceiptDocument }>(server, "GET", `/receipts/${receiptId}`, { anonymous: true });
    assert.equal(publicReceipt.status, 200);
    assert.equal(publicReceipt.headers.get("cache-control"), "public, max-age=60");
    assert.equal(publicReceipt.body.receipt.disclosures, undefined, "no disclosures in public reads");
    const status = await call<{ sequence: number; terminal: boolean; supersededBy: null }>(server, "GET", `/receipts/${receiptId}/status`);
    assert.deepEqual(status.body, { sequence: 1, terminal: true, supersededBy: null });
    const sealed = await call<{ ciphertext: string; alg: string; groups: string[] }>(server, "GET", `/receipts/${receiptId}/shares/${share.id}`, { anonymous: true });
    assert.equal(sealed.status, 200);
    assert.equal(sealed.body.alg, "A256GCM");
    const opened = decryptShare(receiptId, share.id, sealed.body.ciphertext, link.key);
    assert.ok(opened);
    assert.deepEqual(Object.keys(opened).sort(), [...share.groups].sort());
    assert.equal(decryptShare(receiptId, share.id, sealed.body.ciphertext, Buffer.alloc(32).toString("base64url")), null, "a wrong key opens nothing");
    assert.equal(decryptShare(receiptId, `rsh_${"0".repeat(24)}`, sealed.body.ciphertext, link.key), null, "bound to its share id");
    const keys = (await call<{ keys: ReceiptKey[] }>(server, "GET", "/receipts/keys")).body.keys;
    const shared = await verifyReceipt({ ...publicReceipt.body.receipt, disclosures: opened }, { keys, requireGroups: ["steps.*.evidence"] });
    assert.equal(shared.valid, true, JSON.stringify(shared.problems));
    assert.ok(shared.sealed.includes("intent.request") && shared.sealed.includes("steps.s1.parties"), "unshared groups stay sealed");

    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "everything" } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { groups: ["steps.s9.amounts"] } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "full", groups: ["intent.request"] } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { expiresInSeconds: 60 } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { sequence: 4 } }), 404, "RECEIPT_NOT_FOUND");
    const custom = await call<{ share: { groups: string[]; expiresAt: null } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { groups: ["steps.*.parties", "intent.request"], expiresInSeconds: null } });
    assert.equal(custom.status, 201);
    assert.deepEqual(custom.body.share.groups, ["steps.s1.parties", "intent.request"]);
    assert.equal(custom.body.share.expiresAt, null);

    // Expired shares answer 410; revoked and unknown ones 404.
    const expiredId = `rsh_${"e".repeat(24)}`;
    await store.createShare({ id: expiredId, receiptId, intentId: intent.id, groups: [], ciphertext: "AAAA", expiresAt: new Date(Date.now() - 1_000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() }, 10, new Date().toISOString());
    assertError(await call(server, "GET", `/receipts/${receiptId}/shares/${expiredId}`), 410, "RECEIPT_SHARE_EXPIRED");
    assert.equal((await call(server, "DELETE", `/intents/${intent.id}/receipt/shares/${share.id}`)).status, 204);
    assert.equal((await call(server, "DELETE", `/intents/${intent.id}/receipt/shares/${share.id}`)).status, 204, "idempotent");
    assertError(await call(server, "DELETE", `/intents/${intent.id}/receipt/shares/rsh_${"0".repeat(24)}`), 404, "RECEIPT_SHARE_NOT_FOUND");
    assertError(await call(server, "GET", `/receipts/${receiptId}/shares/${share.id}`), 404, "RECEIPT_SHARE_NOT_FOUND");
    assertError(await call(server, "GET", `/receipts/${receiptId}/shares/bad`), 400, "INVALID_REQUEST");
    assert.equal((await call(server, "GET", `/receipts/${receiptId}`)).status, 200, "still shared by the custom share");
    for (const entry of (await call<{ shares: { id: string }[] }>(server, "GET", `/intents/${intent.id}/receipt/shares`)).body.shares) {
      await call(server, "DELETE", `/intents/${intent.id}/receipt/shares/${entry.id}`);
    }
    assertError(await call(server, "GET", `/receipts/${receiptId}`), 404, "RECEIPT_NOT_FOUND");
    assertError(await call(server, "GET", `/receipts/${receiptId}/status`), 404, "RECEIPT_NOT_FOUND");

    for (let index = 0; index < 10; index += 1) assert.equal((await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: {} })).status, 201);
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: {} }), 409, "RECEIPT_SHARE_LIMIT");
  });

  it("replays a keyed share creation sealed under Idempotency-Key and refuses the header without a key", async () => {
    const developer = await issueDeveloperKey();
    const intent = await completedIntent(developer.key);
    await issueNow(newIssuer(), intent.id);
    const headers = { "idempotency-key": "share-1" };
    const first = await rawCall<{ share: { id: string; url: string } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { key: developer.key, headers, body: { profile: "amounts" } });
    assert.equal(first.status, 201);
    const replay = await rawCall<{ share: { id: string; url: string } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { key: developer.key, headers, body: { profile: "amounts" } });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.body.share, first.body.share, "the same link, not a second share");
    assert.equal((await rawCall<{ shares: unknown[] }>(server, "GET", `/intents/${intent.id}/receipt/shares`)).body.shares.length, 1);
    assertError(await rawCall(server, "POST", `/intents/${intent.id}/receipt/shares`, { headers, body: {} }), 400, "IDEMPOTENCY_KEY_REQUIRES_API_KEY");
  });

  it("withdraws stored disclosures and every share; later shares are refused", async () => {
    const intent = await completedIntent();
    await issueNow(newIssuer(), intent.id);
    const created = await call<{ share: { id: string } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "full" } });
    const receiptId = (await receiptOf(intent.id)).payload.receiptId;
    assert.equal((await call(server, "DELETE", `/intents/${intent.id}/receipt/disclosures`)).status, 204);
    const after = await receiptOf(intent.id);
    assert.equal(after.disclosures, undefined, "no disclosures left");
    assert.equal((await verifyReceipt(after, { keys: [signer.publicKey] })).valid, true, "the signed payload still verifies");
    assertError(await call(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: {} }), 410, "RECEIPT_DISCLOSURES_WITHDRAWN");
    assertError(await call(server, "GET", `/receipts/${receiptId}/shares/${created.body.share.id}`), 404, "RECEIPT_SHARE_NOT_FOUND");
    assertError(await call(server, "GET", `/receipts/${receiptId}`), 404, "RECEIPT_NOT_FOUND");
  });
});

/* ============================================================ log */

describe("transparency log", () => {
  it("computes the same audit paths as core for every index", () => {
    for (let size = 1; size <= 9; size += 1) {
      const leaves = Array.from({ length: size }, (_, index) => createHash("sha256").update(`leaf ${index}`).digest("hex"));
      const tree = merkleTree(leaves);
      assert.equal(tree.root, merkleRoot(leaves), `root of ${size}`);
      leaves.forEach((leaf, index) => {
        assert.deepEqual(tree.paths[index], merkleAuditPath(index, leaves), `path ${index} of ${size}`);
        assert.equal(verifyMerkleInclusion({ leaf, leafIndex: index, treeSize: size, path: tree.paths[index] as string[], root: tree.root }), true);
      });
    }
  });

  it("closes signed, hash-chained batches and serves inclusion proofs that verify", async () => {
    const intents = [await completedIntent()];
    await issueNow(newIssuer(), intents[0]?.id as string);
    const first = await closeReceiptBatch();
    assert.ok(first);
    assert.equal(first.seq, 1);
    assert.equal(first.document.previous, null);
    assert.equal(await closeReceiptBatch(), null, "nothing left to batch");

    resetEngine();
    const second = await completedIntent();
    await issueNow(newIssuer(), second.id);
    const batch2 = await closeReceiptBatch();
    assert.equal(batch2?.seq, 2);
    assert.equal(batch2?.document.previous, first.batchDigest, "chained to batch 1");
    assert.equal(receiptLogBatchDigest(batch2?.document as never), batch2?.batchDigest);
    assert.equal((await verifyReceiptLogBatch(batch2?.document as never, batch2?.signature as string, [signer.publicKey])).valid, true);

    const listing = await call<{ batches: { seq: number; batchDigest: string; anchor: null }[] }>(server, "GET", "/receipts/log?limit=5", { anonymous: true });
    assert.deepEqual(listing.body.batches.map((entry) => entry.seq), [2, 1]);
    assert.deepEqual((await call<{ batches: unknown[] }>(server, "GET", "/receipts/log?unanchored=true")).body.batches.length, 2);
    const one = await call<{ batch: { seq: number }; leaves: { total: number; items: string[] } }>(server, "GET", "/receipts/log/2?leaves=true&offset=0&limit=1");
    assert.equal(one.status, 200);
    assert.equal(one.body.leaves.total, 1);
    const receipt = await receiptOf(second.id);
    assert.deepEqual(one.body.leaves.items, [receipt.digest]);
    assert.ok(receipt.inclusion, "the owner's receipt carries its inclusion proof");
    const keys = [signer.publicKey];
    const verified = await verifyReceipt(receipt, { keys });
    assert.deepEqual(verified.inclusion, { valid: true, batch: 2 });
    const byDigest = await call<{ inclusion: { leafIndex: number } }>(server, "GET", `/receipts/log/inclusion?digest=${receipt.digest}`);
    assert.equal(byDigest.status, 200);
    assert.equal(byDigest.body.inclusion.leafIndex, 0);
    assertError(await call(server, "GET", `/receipts/log/inclusion?digest=${"0".repeat(64)}`), 404, "RECEIPT_LOG_NOT_FOUND");
    assertError(await call(server, "GET", "/receipts/log/inclusion?digest=xyz"), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/receipts/log/9"), 404, "RECEIPT_LOG_NOT_FOUND");
    assertError(await call(server, "GET", "/receipts/log/zero"), 400, "INVALID_REQUEST");
  });

  it("records an anchor only for a successful EAS.timestamp(batchDigest) on Base, reported by an operator or found by the watcher", async () => {
    const intent = await completedIntent();
    await issueNow(newIssuer(), intent.id);
    const batch = await closeReceiptBatch();
    assert.ok(batch);
    const goodTx = `0x${"ab".repeat(32)}`;
    const wrongTx = `0x${"cd".repeat(32)}`;
    let anchoredAt = 0;
    const base: RpcTransport = async (method, params) => {
      const hash = typeof params[0] === "string" ? params[0] : "";
      switch (method) {
        case "eth_getTransactionByHash":
          if (hash === goodTx) return { to: EAS_ADDRESS, input: `${EAS_TIMESTAMP_SELECTOR}${batch.batchDigest}`, chainId: "0x2105", blockNumber: "0x10" };
          if (hash === wrongTx) return { to: EAS_ADDRESS, input: `${EAS_TIMESTAMP_SELECTOR}${"00".repeat(32)}`, chainId: "0x2105", blockNumber: "0x10" };
          return null;
        case "eth_getTransactionReceipt":
          return hash === goodTx || hash === wrongTx ? { status: "0x1", blockNumber: "0x10" } : null;
        case "eth_getBlockByNumber":
          if (params[0] === "latest") return { number: "0x20", timestamp: `0x${(1_800_000_000 + 32).toString(16)}` };
          return { number: params[0], timestamp: `0x${(1_800_000_000 + Number(BigInt(params[0] as string)) * 2 - 32).toString(16)}` };
        case "eth_call": {
          const data = (params[0] as { data: string }).data;
          assert.ok(data.startsWith(EAS_GET_TIMESTAMP_SELECTOR));
          return `0x${anchoredAt.toString(16).padStart(64, "0")}`;
        }
        case "eth_getLogs": {
          const filter = params[0] as { topics: string[] };
          assert.equal(filter.topics[0], EAS_TIMESTAMPED_TOPIC);
          return [{ transactionHash: goodTx }];
        }
        default:
          throw new Error(`unexpected Base call ${method}`);
      }
    };
    configureAnchorTransport(base);
    try {
      const developer = await issueDeveloperKey();
      assertError(await rawCall(server, "POST", "/receipts/log/1/anchor", { key: developer.key, body: { tx: goodTx } }), 401, "API_KEY_REQUIRED");
      assertError(await rawCall(server, "POST", "/receipts/log/1/anchor", { body: { tx: goodTx } }), 401, "API_KEY_REQUIRED");
      assertError(await call(server, "POST", "/receipts/log/1/anchor", { body: { tx: goodTx } }), 422, "RECEIPT_ANCHOR_INVALID");
      anchoredAt = 1_800_000_000;
      assertError(await call(server, "POST", "/receipts/log/1/anchor", { body: { tx: wrongTx } }), 422, "RECEIPT_ANCHOR_INVALID");
      assertError(await call(server, "POST", "/receipts/log/1/anchor", { body: { tx: `0x${"ef".repeat(32)}` } }), 422, "RECEIPT_ANCHOR_INVALID");
      assertError(await call(server, "POST", "/receipts/log/1/anchor", { body: { hash: goodTx } }), 400, "INVALID_REQUEST");
      assertError(await call(server, "POST", "/receipts/log/7/anchor", { body: { tx: goodTx } }), 404, "RECEIPT_LOG_NOT_FOUND");
      const recorded = await call<{ batch: { anchor: { tx: string; timestamp: number; chain: string } } }>(server, "POST", "/receipts/log/1/anchor", { body: { tx: goodTx } });
      assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
      assert.deepEqual(recorded.body.batch.anchor, { chain: "eip155:8453", contract: EAS_ADDRESS, tx: goodTx, timestamp: 1_800_000_000 });
      assertError(await call(server, "POST", "/receipts/log/1/anchor", { body: { tx: goodTx } }), 409, "RECEIPT_ANCHOR_EXISTS");
      const anchored = await call(server, "GET", "/receipts/log/1");
      assert.equal(anchored.headers.get("cache-control"), "public, max-age=86400, immutable");
      const receipt = await receiptOf(intent.id);
      assert.equal(receipt.inclusion?.anchor?.tx, goodTx);

      // The watcher finds a batch someone else timestamped.
      resetEngine();
      const next = await completedIntent();
      await issueNow(newIssuer(), next.id);
      const batch2 = await closeReceiptBatch();
      assert.equal(batch2?.seq, 2);
      assert.equal(await watchAnchors(base), 1);
      assert.equal((await store.batch(2))?.anchor?.tx, goodTx);
      assert.equal(await watchAnchors(base), 0, "already anchored");
    } finally {
      configureAnchorTransport(null);
    }
  });
});

/* ============================================================ events */

describe("intent.receipt_issued", () => {
  it("is delivered to the owner's webhooks that subscribe to it (not to older event lists)", async () => {
    const developer = await issueDeveloperKey();
    const old = await rawCall<{ webhook: { id: string } }>(server, "POST", "/webhooks", { key: developer.key, body: { url: "https://93.184.215.14/old", events: ["intent.created", "intent.status_changed"] } });
    const fresh = await rawCall<{ webhook: { id: string; events: string[] } }>(server, "POST", "/webhooks", { key: developer.key, body: { url: "https://93.184.215.14/new" } });
    assert.equal(fresh.status, 201);
    assert.ok(fresh.body.webhook.events.includes("intent.receipt_issued"), "new webhooks receive it by default");
    const deliveries: { url: string; type: string; body: string }[] = [];
    const dispatcher = new WebhookDispatcher(async (url, body, headers) => {
      deliveries.push({ url: url.toString(), type: headers["kletia-event-type"] as string, body });
      return 204;
    }, () => undefined);
    dispatcher.start();
    try {
      const intent = await completedIntent(developer.key);
      const [outcome] = await issueNow(newIssuer(), intent.id);
      assert.equal(outcome?.kind, "issued");
      await waitFor(() => deliveries.some((entry) => entry.type === "intent.receipt_issued"), 3_000, "the receipt delivery");
      const receiptDeliveries = deliveries.filter((entry) => entry.type === "intent.receipt_issued");
      assert.deepEqual(receiptDeliveries.map((entry) => entry.url), ["https://93.184.215.14/new"]);
      const event = JSON.parse(receiptDeliveries[0]?.body ?? "{}") as { data: Record<string, unknown> };
      assert.equal(event.data.intentId, intent.id);
      assert.equal(event.data.sequence, 1);
      assert.equal("disclosures" in event.data, false, "ids and digest only");
      assert.ok(old.body.webhook.id);
    } finally {
      dispatcher.stop();
    }
  });

  it("is replayed on the intent's SSE stream, merged by time and resumable with Last-Event-ID", async () => {
    const intent = await completedIntent();
    await issueNow(newIssuer(), intent.id);
    const frames = await readSse(`/intents/${intent.id}/events`, {}, (frame) => frame.event === "intent.receipt_issued");
    const receiptFrame = frames.find((frame) => frame.event === "intent.receipt_issued");
    assert.ok(receiptFrame, "receipt frame replayed");
    assert.equal(frames.at(-1)?.event, "intent.receipt_issued", "after the intent's own events");
    const previous = frames.at(-2)?.id as string;
    const resumed = await readSse(`/intents/${intent.id}/events`, { "last-event-id": previous }, (frame) => frame.event === "intent.receipt_issued");
    assert.deepEqual(resumed.filter((frame) => frame.event).map((frame) => frame.event), ["intent.receipt_issued"]);
  });
});

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

function readSse(path: string, headers: Record<string, string>, until: (frame: SseFrame) => boolean): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const request = http.get({ host: "127.0.0.1", port: server.port, path: `/v1${path}`, headers: { accept: "text/event-stream", authorization: `Bearer ${OPERATOR_KEY}`, ...headers } });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`timed out; frames: ${JSON.stringify(frames)}`));
    }, 3_000);
    request.on("error", reject);
    request.on("response", (response: IncomingMessage) => {
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame: SseFrame = {};
          for (const line of buffer.slice(0, index).split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4);
            else if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data = line.slice(6);
          }
          buffer = buffer.slice(index + 2);
          if (frame.event) frames.push(frame);
          if (until(frame)) {
            clearTimeout(timer);
            request.destroy();
            resolve(frames);
            return;
          }
          index = buffer.indexOf("\n\n");
        }
      });
    });
  });
}

/* ============================================================ MCP, health, usage */

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await call<{ result?: { structuredContent: Record<string, unknown>; isError?: boolean } }>(server, "POST", "/mcp", {
    headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_VERSION, "mcp-method": "tools/call", "mcp-name": name },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: MCP_META } },
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return { ...(reply.body.result?.structuredContent ?? {}), ...(reply.body.result?.isError ? { isError: true } : {}) };
}

describe("MCP get_receipt, health and usage", () => {
  it("reads a receipt by intent id or share link (never exposing the intent id), pending and not ready", async () => {
    const planned = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body: SWAP });
    assert.equal((await tool("get_receipt", { intentId: planned.body.intent.id })).state, "not_ready");
    const intent = await completedIntent();
    const pending = await tool("get_receipt", { intentId: intent.id });
    assert.equal(pending.state, "pending");
    assert.equal(((await tool("get_intent", { intentId: intent.id })).receipt as { state: string }).state, "pending");
    await issueNow(newIssuer(), intent.id);
    const owner = await tool("get_receipt", { intentId: intent.id });
    assert.equal(owner.state, "issued", JSON.stringify(owner));
    const summary = owner.receipt as { verified: boolean; steps: { anchors: { ref: string; slot?: string; explorerUrl?: string }[] }[]; sealed: string[] };
    assert.equal(summary.verified, true);
    assert.equal(summary.steps[0]?.anchors[0]?.ref, SIGNATURE);
    assert.equal(summary.steps[0]?.anchors[0]?.slot, String(SLOT));
    assert.match(summary.steps[0]?.anchors[0]?.explorerUrl ?? "", /^https:\/\//u);
    assert.match(String(owner.verifyCommand), /receipt reverify/u);
    assert.equal(((await tool("get_intent", { intentId: intent.id })).receipt as { state: string }).state, "issued");

    const share = await call<{ share: { url: string } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "proof" } });
    const viaLink = await tool("get_receipt", { shareUrl: share.body.share.url });
    assert.equal(viaLink.state, "issued");
    assert.equal((viaLink.receipt as { verified: boolean }).verified, true);
    assert.equal(JSON.stringify(viaLink).includes(intent.id), false, "a share link never reveals the intent id");
    assert.ok((viaLink.receipt as { sealed: string[] }).sealed.includes("intent.request"));
    assert.equal((await tool("get_receipt", { shareUrl: share.body.share.url.replace(/k=[^&]+/u, `k=${"A".repeat(43)}`) })).isError, true);
    assert.equal((await tool("get_receipt", {})).isError, true, "exactly one of intentId or shareUrl");
    assert.equal((await tool("get_receipt", { intentId: intent.id, shareUrl: share.body.share.url })).isError, true);
  });

  it("reports receipts in health and usage", async () => {
    const developer = await issueDeveloperKey();
    const intent = await completedIntent(developer.key);
    await issueNow(newIssuer(), intent.id);
    await rawCall(server, "POST", `/intents/${intent.id}/receipt/shares`, { key: developer.key, body: {} });
    await closeReceiptBatch();
    const health = await call<{ receipts: { signer: string; store: string; queue: number; lastBatch: { seq: number; anchored: boolean } }; preview: { store: string } }>(server, "GET", "/health");
    assert.equal(health.body.receipts.signer, "configured");
    assert.equal(health.body.receipts.store, "memory");
    assert.equal(health.body.receipts.queue, 0);
    assert.deepEqual(health.body.receipts.lastBatch, { seq: 1, anchored: false });
    assert.equal(health.body.preview.store, "memory");
    const usage = await rawCall<{ receipts: { issued: number; pending: number; sharesActive: number } }>(server, "GET", "/usage", { key: developer.key });
    assert.equal(usage.status, 200);
    assert.deepEqual(usage.body.receipts, { issued: 1, pending: 0, sharesActive: 1 });
  });
});

/* ============================================================ keys */

describe("receipt keys", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith("KLETIA_RECEIPT") || name === "KLETIA_EAS_ATTESTER_KEY" || name === "KLETIA_PLATFORM_SECRET") delete process.env[name];
    for (const [name, value] of Object.entries(saved)) if (name.startsWith("KLETIA_RECEIPT") || name === "KLETIA_PLATFORM_SECRET") process.env[name] = value;
    process.env.NODE_ENV = saved.NODE_ENV ?? "test";
    resetReceiptKeyring();
    configureReceiptSigner(signer);
  });

  it("uses an ephemeral development key without configuration, and refuses to sign in production without one", () => {
    delete process.env.KLETIA_RECEIPT_SIGNING_KEY;
    const development = loadReceiptKeyring();
    assert.equal(development.status, "development");
    assert.equal(development.keys[0]?.status, "development");
    process.env.NODE_ENV = "production";
    const production = loadReceiptKeyring();
    assert.equal(production.status, "missing");
    assert.equal(production.signer, null);
  });

  it("loads a configured seed with its key set, next key and kill switch; refuses keys tied to the platform secret", () => {
    const seed = randomBytes(32);
    const retiredX = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
    const revokedX = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
    const nextX = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
    process.env.KLETIA_RECEIPT_SIGNING_KEY = seed.toString("base64url");
    process.env.KLETIA_RECEIPT_KEY_NOT_BEFORE = "2026-10-01";
    process.env.KLETIA_RECEIPT_KEYSET = JSON.stringify([
      { x: retiredX, status: "retired", notBefore: "2026-01-01" },
      { x: revokedX, status: "revoked", notBefore: "2026-01-01", revokedOn: "2026-06-01" },
      { x: "short", status: "retired", notBefore: "2026-01-01" },
    ]);
    process.env.KLETIA_RECEIPT_NEXT_KEY = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: nextX, notBefore: "2027-01-01" });
    const ring = loadReceiptKeyring();
    assert.equal(ring.status, "configured");
    assert.equal(ring.signer?.kid, signerFromSeed(seed).kid);
    assert.deepEqual(ring.keys.map((key) => [key.status, key.kid]), [
      ["active", ring.signer?.kid],
      ["retired", receiptKeyId(retiredX)],
      ["revoked", receiptKeyId(revokedX)],
      ["next", receiptKeyId(nextX)],
    ]);
    assert.equal(ring.keys[0]?.notBefore, "2026-10-01");
    assert.equal(ring.keys[2]?.revokedOn, "2026-06-01");
    assert.ok(ring.problems.some((problem) => problem.includes("KLETIA_RECEIPT_KEYSET[2]")), "a malformed entry is reported and ignored");

    process.env.KLETIA_RECEIPTS_ENABLED = "false";
    assert.equal(loadReceiptKeyring().status, "disabled");
    delete process.env.KLETIA_RECEIPTS_ENABLED;

    process.env.KLETIA_PLATFORM_SECRET = "a-platform-secret-of-at-least-thirty-two-characters";
    process.env.KLETIA_RECEIPT_SIGNING_KEY = createHash("sha256").update(process.env.KLETIA_PLATFORM_SECRET).digest().toString("base64url");
    const derived = loadReceiptKeyring();
    assert.equal(derived.status, "missing", "a key derived from the platform secret never signs");
    assert.ok(derived.problems.some((problem) => problem.includes("KLETIA_PLATFORM_SECRET")));

    process.env.KLETIA_RECEIPT_SIGNING_KEY = seed.toString("base64url");
    process.env.KLETIA_RECEIPT_KEYSET = JSON.stringify([{ x: ring.signer?.publicKey.x, status: "revoked", notBefore: "2026-01-01", revokedOn: "2026-10-02" }]);
    assert.equal(loadReceiptKeyring().status, "missing", "a revoked key never signs");

    delete process.env.KLETIA_RECEIPT_KEYSET;
    delete process.env.KLETIA_RECEIPT_KEY_NOT_BEFORE;
    process.env.NODE_ENV = "production";
    process.env.KLETIA_PLATFORM_SECRET = "another-platform-secret-of-at-least-thirty-two";
    assert.equal(loadReceiptKeyring().status, "missing", "production needs KLETIA_RECEIPT_KEY_NOT_BEFORE");
  });

  it("publishes an EAS attester and signs offchain envelopes that verify offline only for the attested digest", async () => {
    const attesterKey = `0x${randomBytes(32).toString("hex")}`;
    process.env.KLETIA_EAS_ATTESTER_KEY = attesterKey;
    const ring = loadReceiptKeyring();
    assert.ok(ring.attester);
    const digest = createHash("sha256").update("a receipt").digest("hex");
    const envelope = await attestReceipt(ring.attester, { digest, spec: "kletia.receipt/v1", sequence: 1, issuedAt: new Date().toISOString() });
    assert.equal(envelope.sig.domain.chainId, 8453);
    assert.equal(envelope.sig.message.recipient, "0x0000000000000000000000000000000000000000");
    assert.equal(await verifyEasEnvelope(envelope, digest), true);
    assert.equal(await verifyEasEnvelope(envelope, createHash("sha256").update("another").digest("hex")), false);
    assert.equal(await verifyEasEnvelope({ ...envelope, sig: { ...envelope.sig, domain: { ...envelope.sig.domain, chainId: 1 } as never } }, digest), false);
    assert.equal(await verifyEasEnvelope({ ...envelope, sig: { ...envelope.sig, message: { ...envelope.sig.message, time: "1" } } }, digest), false);

    // The issuer attaches it and the keys endpoint lists the attester.
    resetReceiptKeyring();
    configureReceiptSigner(signer);
    const intent = await completedIntent();
    await issueNow(newIssuer(), intent.id);
    const receipt = await receiptOf(intent.id);
    const eas = receipt.attestations?.eas as Parameters<typeof verifyEasEnvelope>[0] | undefined;
    assert.ok(eas, "envelope attached");
    assert.equal(await verifyEasEnvelope(eas, receipt.digest), true);
    const keys = await call<{ attesters: { address: string; chain: string }[] }>(server, "GET", "/receipts/keys");
    assert.equal(keys.body.attesters[0]?.address, ring.attester.address);
    assert.equal(keys.body.attesters[0]?.chain, "eip155:8453");
  });
});

/* ============================================================ state digest */

describe("state digest", () => {
  it("changes with the status, references and fills, not with unrelated fields", async () => {
    const intent = await completedIntent();
    const base = intentStateDigest(intent);
    assert.equal(intentStateDigest({ ...intent, summary: { ...intent.summary, title: "renamed" } }), base);
    assert.notEqual(intentStateDigest({ ...intent, status: "failed" }), base);
    const step = intent.steps[0] as IntentStep;
    assert.notEqual(intentStateDigest({ ...intent, steps: [{ ...step, references: [] }] }), base);
  });
});

/* ============================================================ Postgres end to end */

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();

describe("receipts on Postgres", { skip: databaseUrl ? false : "set KLETIA_TEST_DATABASE_URL to run" }, () => {
  // The transparency log is global: hold the log lock so receiptsStore.test.ts (another process on the
  // same database) cannot batch this receipt with its test sealer, or see it inside its own batch.
  it("issues, shares, batches and serves a receipt from the Postgres store", () => withDatabaseTestLock(databaseUrl, "receipt-log", async () => {
    const { PostgresReceiptStore } = await import("../receipts/store.js");
    const { closePlatformDatabase } = await import("../db.js");
    process.env.KLETIA_DATABASE_URL = databaseUrl;
    const postgres = new PostgresReceiptStore();
    configureReceiptStore(postgres);
    try {
      const intent = await completedIntent();
      await postgres.enqueue({ intentId: intent.id, ownerKeyId: null, reason: "scan", notBefore: new Date(clock - 1_000).toISOString() });
      const outcomes = await Promise.all([newIssuer().runDue(), newIssuer().runDue()]);
      assert.equal(outcomes.flat().filter((outcome) => outcome.kind === "issued").length, 1, "one issuer claims it");
      const receipt = await receiptOf(intent.id);
      assert.equal((await verifyReceipt(receipt, { keys: [signer.publicKey], intentId: intent.id })).valid, true);
      const share = await call<{ share: { id: string; url: string } }>(server, "POST", `/intents/${intent.id}/receipt/shares`, { body: { profile: "amounts" } });
      assert.equal(share.status, 201);
      const link = parseShareUrl(share.body.share.url);
      const sealed = await call<{ ciphertext: string }>(server, "GET", `/receipts/${receipt.payload.receiptId}/shares/${share.body.share.id}`);
      assert.ok(link && decryptShare(receipt.payload.receiptId, share.body.share.id, sealed.body.ciphertext, link.key));
      while (await closeReceiptBatch()) { /* drain earlier runs' receipts too */ }
      const withInclusion = await receiptOf(intent.id);
      assert.equal((await verifyReceipt(withInclusion, { keys: [signer.publicKey] })).inclusion?.valid, true);
    } finally {
      configureReceiptStore(store);
      await closePlatformDatabase();
      delete process.env.KLETIA_DATABASE_URL;
    }
  }));
});
