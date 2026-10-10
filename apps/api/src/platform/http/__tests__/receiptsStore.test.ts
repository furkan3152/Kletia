/**
 * Receipt store contract (receipts design §12), against memory and, when
 * KLETIA_TEST_DATABASE_URL is set, Postgres: issuance under the per-intent
 * lock (sequence, supersession, dedupe, stale candidates, one winner under
 * concurrency), the queue (lease, reschedule, revision-safe dequeue, event vs
 * scan enqueue), shares (limit, expiry, revoke), withdrawal, log batches
 * (chained seq, leaf indexes and paths, pagination, anchors) and owner counts.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { RECEIPT_LOG_SPEC_VERSION, receiptLogBatchDigest, type ReceiptLogBatch, type ReceiptPayload } from "@kletia/core";
import { useTestEnvironment, withDatabaseTestLock } from "./support.js";

useTestEnvironment();
const { MemoryReceiptStore, PostgresReceiptStore } = await import("../receipts/store.js");
const { merkleTree } = await import("../receipts/log.js");
const { closePlatformDatabase } = await import("../db.js");
type ReceiptStore = import("../receipts/store.js").ReceiptStore;
type StoredReceipt = import("../receipts/store.js").StoredReceipt;
type BatchSealer = import("../receipts/store.js").BatchSealer;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function receipt(intentId: string, sequence: number, stateDigest: string, overrides: Partial<StoredReceipt> = {}): StoredReceipt {
  const id = `rcpt_${hex(16)}`;
  return {
    id,
    intentId,
    ownerKeyId: "key_store_contract",
    sequence,
    intentStatus: "completed",
    stateDigest,
    digest: hex(32),
    kid: "test-kid",
    payload: { receiptId: id, sequence } as unknown as ReceiptPayload,
    signature: "c2ln",
    disclosures: { "intent.request": { salt: "AAAAAAAAAAAAAAAAAAAAAA", value: { requestDigest: hex(32), request: { accounts: [] } } } } as never,
    disclosuresWithdrawnAt: null,
    attestations: null,
    supersedes: null,
    supersededBy: null,
    batchSeq: null,
    leafIndex: null,
    inclusionPath: null,
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

const seal: BatchSealer = async (leaves, previous) => {
  const tree = merkleTree(leaves.map((leaf) => leaf.digest));
  const document: ReceiptLogBatch = {
    spec: RECEIPT_LOG_SPEC_VERSION,
    seq: (previous?.seq ?? 0) + 1,
    size: leaves.length,
    root: tree.root,
    previous: previous?.batchDigest ?? null,
    closedOn: new Date().toISOString().slice(0, 10),
  };
  return { document, batchDigest: receiptLogBatchDigest(document), signature: "c2lnbmF0dXJl", paths: tree.paths };
};

function contract(name: string, make: () => ReceiptStore, databaseUrl?: string): void {
  describe(`${name} receipt store`, () => {
    it("issues sequences under the intent lock: supersession, dedupe, stale candidates", async () => {
      const store = make();
      const intentId = `int_${hex(16)}`;
      const one = receipt(intentId, 1, "a".repeat(64));
      assert.equal(await store.issue(one, null, null), "issued");
      assert.equal(await store.issue(receipt(intentId, 2, "a".repeat(64)), one.id, null), "duplicate", "same state digest");
      assert.equal(await store.issue(receipt(intentId, 2, "b".repeat(64)), null, null), "stale", "another receipt was issued meanwhile");
      assert.equal(await store.issue(receipt(intentId, 3, "b".repeat(64)), one.id, null), "stale", "sequence must follow the latest");
      const two = receipt(intentId, 2, "b".repeat(64), { supersedes: one.digest });
      assert.equal(await store.issue(two, one.id, null), "issued");
      assert.equal((await store.latest(intentId))?.id, two.id);
      assert.equal((await store.bySequence(intentId, 1))?.supersededBy, two.id);
      assert.equal((await store.byDigest(two.digest))?.id, two.id);
      assert.equal((await store.byId(one.id))?.sequence, 1);
      assert.deepEqual((await store.list(intentId)).map((entry) => entry.sequence), [1, 2]);
    });

    it("lets one of two concurrent candidates win", async () => {
      const store = make();
      const intentId = `int_${hex(16)}`;
      const results = await Promise.all([store.issue(receipt(intentId, 1, "c".repeat(64)), null, null), store.issue(receipt(intentId, 1, "d".repeat(64)), null, null)]);
      assert.deepEqual(results.sort(), ["issued", "stale"]);
      assert.equal((await store.list(intentId)).length, 1);
    });

    it("leases queue entries and only dequeues the revision it processed", async () => {
      const store = make();
      const intentId = `int_${hex(16)}`;
      const now = Date.now();
      const later = new Date(now + 60_000).toISOString();
      await store.enqueue({ intentId, ownerKeyId: "key_store_contract", reason: "event", notBefore: later });
      await store.enqueue({ intentId, ownerKeyId: null, reason: "scan", notBefore: new Date(now - 1_000).toISOString() });
      assert.equal((await store.queueEntry(intentId))?.notBefore, later, "a scan never accelerates an entry");
      await store.enqueue({ intentId, ownerKeyId: null, reason: "event", notBefore: new Date(now + 30_000).toISOString() });
      const entry = await store.queueEntry(intentId);
      assert.equal(entry?.notBefore, new Date(now + 30_000).toISOString(), "an event may pull it earlier");
      assert.equal(entry?.ownerKeyId, "key_store_contract");
      const at = new Date(now + 31_000).toISOString();
      const claimed = (await store.claim(at, 1_000, 120_000)).filter((row) => row.intentId === intentId);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.attempts, 1);
      assert.equal((await store.claim(at, 1_000, 120_000)).filter((row) => row.intentId === intentId).length, 0, "leased");
      await store.reschedule(intentId, { notBefore: new Date(now + 40_000).toISOString(), pendingReason: "awaiting_finality", expectedBy: new Date(now + 50_000).toISOString(), detail: "slot not final" });
      const waiting = await store.queueEntry(intentId);
      assert.equal(waiting?.pendingReason, "awaiting_finality");
      assert.equal(waiting?.expectedBy, new Date(now + 50_000).toISOString());
      assert.equal(waiting?.lockedUntil, null);
      const again = (await store.claim(new Date(now + 41_000).toISOString(), 1_000, 120_000)).find((row) => row.intentId === intentId);
      assert.ok(again);
      // An event arrives while it is processed: the row survives the dequeue.
      await store.enqueue({ intentId, ownerKeyId: null, reason: "event", notBefore: new Date(now + 99_000).toISOString() });
      await store.dequeue(intentId, again.revision);
      assert.ok(await store.queueEntry(intentId), "re-queued state is not lost");
      const current = await store.queueEntry(intentId);
      await store.dequeue(intentId, current?.revision as number);
      assert.equal(await store.queueEntry(intentId), null);
      const stats = await store.queueStats(new Date().toISOString());
      assert.ok(stats.size >= 0);
    });

    it("limits active shares, hides expired and revoked ones, and withdraws everything", async () => {
      const store = make();
      const intentId = `int_${hex(16)}`;
      const one = receipt(intentId, 1, "e".repeat(64));
      assert.equal(await store.issue(one, null, null), "issued");
      const now = new Date().toISOString();
      const share = (id: string, expiresAt: string | null) => ({ id, receiptId: one.id, intentId, groups: ["intent.request"], ciphertext: "Y2lwaGVy", expiresAt, revokedAt: null, createdAt: now });
      await store.createShare(share(`rsh_${hex(12)}`, new Date(Date.now() - 1_000).toISOString()), 2, now);
      const live = `rsh_${hex(12)}`;
      await store.createShare(share(live, null), 2, now);
      await store.createShare(share(`rsh_${hex(12)}`, new Date(Date.now() + 60_000).toISOString()), 2, now);
      await assert.rejects(store.createShare(share(`rsh_${hex(12)}`, null), 2, now), (error: { code?: string }) => error.code === "RECEIPT_SHARE_LIMIT");
      assert.equal((await store.listShares(intentId, now)).length, 2, "expired shares are not listed");
      assert.equal(await store.hasActiveShare(one.id, now), true);
      assert.equal(await store.revokeShare(intentId, live, now), "revoked");
      assert.equal(await store.revokeShare(intentId, live, now), "revoked", "idempotent");
      assert.equal(await store.revokeShare(`int_${hex(16)}`, live, now), "missing", "scoped to the intent");
      assert.equal((await store.share(live))?.ciphertext, "", "a revoked share keeps no ciphertext");
      assert.equal((await store.ownerCounts("key_store_contract", new Date(Date.now() - 60_000).toISOString(), now)).sharesActive >= 1, true);
      assert.equal(await store.withdraw(intentId, now), 1);
      assert.equal((await store.latest(intentId))?.disclosures, null);
      assert.ok((await store.latest(intentId))?.disclosuresWithdrawnAt);
      assert.equal(await store.hasActiveShare(one.id, now), false, "withdrawal removes every share");
      assert.equal(await store.share(live), null);
    });

    it("stores a receipt built before a withdrawal without its disclosures (the withdrawal is re-read under the lock)", async () => {
      const store = make();
      const intentId = `int_${hex(16)}`;
      const one = receipt(intentId, 1, "7".repeat(64));
      assert.equal(await store.issue(one, null, null), "issued");
      // The issuer read `latest` (not withdrawn) and built sequence 2 with every disclosure...
      const built = receipt(intentId, 2, "8".repeat(64), { supersedes: one.digest });
      assert.ok(built.disclosures && built.disclosuresWithdrawnAt === null);
      // ...then the owner withdrew before it was stored.
      const at = new Date(Date.now() - 5_000).toISOString();
      assert.equal(await store.withdraw(intentId, at), 1);
      assert.equal(await store.issue(built, one.id, null), "issued");
      const two = await store.latest(intentId);
      assert.equal(two?.id, built.id);
      assert.equal(two?.disclosures, null, "no disclosure is stored after a withdrawal");
      assert.equal(two?.disclosuresWithdrawnAt, at, "the withdrawal time is carried over");
      // And a third one stays withdrawn too.
      const three = receipt(intentId, 3, "9".repeat(64), { supersedes: built.digest });
      assert.equal(await store.issue(three, built.id, null), "issued");
      assert.equal((await store.latest(intentId))?.disclosures, null);
      // Another intent is not affected.
      const other = receipt(`int_${hex(16)}`, 1, "7".repeat(64));
      assert.equal(await store.issue(other, null, null), "issued");
      assert.notEqual((await store.byId(other.id))?.disclosures, null);
    });

    it("closes chained batches with leaf indexes and paths, pages leaves and records one anchor", () => withDatabaseTestLock(databaseUrl, "receipt-log", async () => {
      const store = make();
      // Batch whatever earlier runs left unbatched, so the next batch holds exactly ours.
      while (await store.closeBatch(seal, 65_536)) { /* drain */ }
      const before = (await store.batches({ limit: 1 }))[0] ?? null;
      const intentId = `int_${hex(16)}`;
      const first = receipt(intentId, 1, "1".repeat(64), { issuedAt: new Date(Date.now() - 2_000).toISOString() });
      const second = receipt(`int_${hex(16)}`, 1, "2".repeat(64), { issuedAt: new Date(Date.now() - 1_000).toISOString() });
      await store.issue(first, null, null);
      await store.issue(second, null, null);
      const batch = await store.closeBatch(seal, 65_536);
      assert.ok(batch);
      assert.equal(batch.seq, (before?.seq ?? 0) + 1);
      assert.equal(batch.document.previous, before?.batchDigest ?? null);
      assert.equal(batch.size, 2);
      assert.equal(await store.closeBatch(seal, 65_536), null, "nothing left");
      const stored = await store.byId(first.id);
      assert.equal(stored?.batchSeq, batch.seq);
      assert.equal(stored?.leafIndex, 0);
      assert.deepEqual(stored?.inclusionPath, merkleTree([first.digest, second.digest]).paths[0]);
      assert.deepEqual(await store.batchLeaves(batch.seq, 1, 5), [second.digest]);
      assert.equal((await store.batches({ limit: 5, unanchored: true }))[0]?.seq, batch.seq);
      const anchor = { chain: "eip155:8453", contract: "0x4200000000000000000000000000000000000021", tx: `0x${hex(32)}`, timestamp: 1_800_000_000 };
      assert.equal(await store.recordAnchor(batch.seq, anchor, new Date().toISOString()), "recorded");
      assert.equal(await store.recordAnchor(batch.seq, anchor, new Date().toISOString()), "exists");
      assert.equal(await store.recordAnchor(batch.seq + 1_000_000, anchor, new Date().toISOString()), "missing");
      assert.deepEqual((await store.batch(batch.seq))?.anchor, anchor);
      assert.equal((await store.batches({ limit: 5, unanchored: true })).some((entry) => entry.seq === batch.seq), false);
    }));

    it("counts a key's receipts, waiting intents and active shares", async () => {
      const store = make();
      const owner = `key_${hex(12)}`;
      const intentId = `int_${hex(16)}`;
      const now = new Date().toISOString();
      const one = receipt(intentId, 1, "f".repeat(64), { ownerKeyId: owner });
      await store.issue(one, null, null);
      await store.enqueue({ intentId: `int_${hex(16)}`, ownerKeyId: owner, reason: "event", notBefore: now });
      await store.createShare({ id: `rsh_${hex(12)}`, receiptId: one.id, intentId, groups: [], ciphertext: "eA", expiresAt: null, revokedAt: null, createdAt: now }, 10, now);
      assert.deepEqual(await store.ownerCounts(owner, new Date(Date.now() - 60_000).toISOString(), now), { issued: 1, pending: 1, sharesActive: 1 });
    });
  });
}

contract("memory", () => new MemoryReceiptStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
describe("postgres", { skip: databaseUrl ? false : "set KLETIA_TEST_DATABASE_URL to run" }, () => {
  before(() => {
    process.env.KLETIA_DATABASE_URL = databaseUrl;
  });
  after(async () => {
    await closePlatformDatabase();
    delete process.env.KLETIA_DATABASE_URL;
  });
  contract("postgres", () => new PostgresReceiptStore(), databaseUrl);
});
