/**
 * Receipt storage (receipts design §12): receipts, the issuance queue, shares
 * and transparency-log batches. Memory (bounded) or Postgres through
 * `http/db.ts` (lazy DDL), chosen by KLETIA_DATABASE_URL like webhooks.
 *
 * Postgres transactions:
 * - issuance: `pg_advisory_xact_lock(hashtextextended('kletia_receipts:' || intent))`,
 *   re-read the latest receipt, drop the candidate when its state digest is
 *   already receipted or another issuer got there first, insert with
 *   `sequence + 1`, mark the previous `superseded_by`, delete the queue row
 *   only when nothing re-queued it meanwhile (`revision`);
 * - queue claim: `FOR UPDATE SKIP LOCKED` with a 2-minute lease;
 * - log close: one global advisory lock, unbatched rows in `(issued_at, id)`
 *   order `FOR UPDATE`, the batch and every leaf's index and audit path in
 *   the same transaction;
 * - share creation: per-receipt advisory lock and the 10-active-shares check.
 *
 * Additions to the design's DDL: `inclusion_path` and
 * `disclosures_withdrawn_at` on receipts, `owner_key_id`, `detail` and
 * `revision` on the queue.
 */
import type pg from "pg";
import type { CaipChainId, ReceiptDisclosure, ReceiptInclusion, ReceiptIntentStatus, ReceiptLogBatch, ReceiptPayload } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";
import type { EasEnvelope } from "./eas.js";

export const MAX_ACTIVE_SHARES = 10;
export const QUEUE_LEASE_MS = 2 * 60_000;
export const MAX_BATCH_LEAVES = 65_536;

export type QueueReason = "event" | "scan" | "read";
export type PendingReason = "awaiting_finality" | "finality_timeout" | "rpc_unavailable" | "anchor_reorged" | "signer_missing" | "issuer_error";

export interface StoredReceipt {
  readonly id: string;
  readonly intentId: string;
  readonly ownerKeyId: string | null;
  readonly sequence: number;
  readonly intentStatus: ReceiptIntentStatus;
  readonly stateDigest: string;
  readonly digest: string;
  readonly kid: string;
  readonly payload: ReceiptPayload;
  /** base64url Ed25519 signature value. */
  readonly signature: string;
  /** Null after the owner withdrew them (or for receipts issued after a withdrawal). */
  readonly disclosures: Readonly<Record<string, ReceiptDisclosure>> | null;
  readonly disclosuresWithdrawnAt: string | null;
  readonly attestations: { readonly eas?: EasEnvelope } | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly batchSeq: number | null;
  readonly leafIndex: number | null;
  readonly inclusionPath: readonly string[] | null;
  readonly issuedAt: string;
}

export interface QueueEntry {
  readonly intentId: string;
  readonly ownerKeyId: string | null;
  readonly reason: QueueReason;
  readonly notBefore: string;
  readonly attempts: number;
  readonly pendingReason: PendingReason | null;
  readonly detail: string | null;
  readonly expectedBy: string | null;
  readonly lockedUntil: string | null;
  readonly createdAt: string;
  /** Bumped by every enqueue: a claim only deletes the row it processed. */
  readonly revision: number;
}

export interface StoredShare {
  readonly id: string;
  readonly receiptId: string;
  readonly intentId: string;
  readonly groups: readonly string[];
  /** base64url(iv || ciphertext || tag); empty once revoked. */
  readonly ciphertext: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface BatchAnchor {
  readonly chain: string;
  readonly contract: string;
  readonly tx: string;
  readonly timestamp: number;
}

export interface StoredBatch {
  readonly seq: number;
  readonly document: ReceiptLogBatch;
  readonly batchDigest: string;
  readonly signature: string;
  readonly size: number;
  readonly anchor: BatchAnchor | null;
  readonly anchoredAt: string | null;
  readonly createdAt: string;
}

export type IssueResult = "issued" | "duplicate" | "stale";

/** What the log job computes for the leaves it selected (inside the store's transaction). */
export interface SealedBatch {
  readonly document: ReceiptLogBatch;
  readonly batchDigest: string;
  readonly signature: string;
  /** Audit path per leaf, in leaf order. */
  readonly paths: readonly (readonly string[])[];
}

export type BatchSealer = (leaves: readonly { readonly id: string; readonly digest: string }[], previous: StoredBatch | null) => Promise<SealedBatch>;

export interface ReceiptStore {
  readonly kind: "memory" | "postgres";
  latest(intentId: string): Promise<StoredReceipt | null>;
  bySequence(intentId: string, sequence: number): Promise<StoredReceipt | null>;
  byId(receiptId: string): Promise<StoredReceipt | null>;
  byDigest(digest: string): Promise<StoredReceipt | null>;
  /** Every receipt of an intent, sequence ascending. */
  list(intentId: string): Promise<StoredReceipt[]>;
  /**
   * Stores a receipt when the intent's latest receipt is still `expectedLatestId`
   * (else `stale`) and its state digest differs (else `duplicate`); then marks the
   * previous one superseded and removes the queue row of `queueRevision`.
   */
  issue(receipt: StoredReceipt, expectedLatestId: string | null, queueRevision: number | null): Promise<IssueResult>;
  /** Deletes stored disclosures of every receipt of the intent and every share. Returns how many receipts it touched. */
  withdraw(intentId: string, at: string): Promise<number>;

  enqueue(entry: { readonly intentId: string; readonly ownerKeyId: string | null; readonly reason: QueueReason; readonly notBefore: string }): Promise<void>;
  claim(now: string, limit: number, leaseMs: number): Promise<QueueEntry[]>;
  reschedule(intentId: string, update: { readonly notBefore: string; readonly pendingReason: PendingReason | null; readonly detail?: string | null; readonly expectedBy?: string | null }): Promise<void>;
  /** Removes the row when its revision is still `revision` (else only releases the lease). */
  dequeue(intentId: string, revision: number): Promise<void>;
  queueEntry(intentId: string): Promise<QueueEntry | null>;
  queueStats(now: string): Promise<{ readonly size: number; readonly oldestPendingSeconds: number | null }>;

  createShare(share: StoredShare, maxActive: number, now: string): Promise<void>;
  share(shareId: string): Promise<StoredShare | null>;
  /** Active (unrevoked, unexpired) shares of an intent, newest first. */
  listShares(intentId: string, now: string): Promise<StoredShare[]>;
  /** `revoked` (now or earlier) or `missing` (no such share for this intent). */
  revokeShare(intentId: string, shareId: string, at: string): Promise<"revoked" | "missing">;
  hasActiveShare(receiptId: string, now: string): Promise<boolean>;

  /** Closes one batch of unbatched receipts (or returns null when there are none). */
  closeBatch(seal: BatchSealer, maxLeaves: number): Promise<StoredBatch | null>;
  batch(seq: number): Promise<StoredBatch | null>;
  /** Newest first. */
  batches(options: { readonly limit: number; readonly unanchored?: boolean; readonly since?: string }): Promise<StoredBatch[]>;
  batchLeaves(seq: number, offset: number, limit: number): Promise<string[]>;
  recordAnchor(seq: number, anchor: BatchAnchor, at: string): Promise<"recorded" | "exists" | "missing">;

  ownerCounts(ownerKeyId: string, since: string, now: string): Promise<{ readonly issued: number; readonly pending: number; readonly sharesActive: number }>;
}

function shareLimitReached(): PlatformError {
  return new PlatformError("RECEIPT_SHARE_LIMIT", `A receipt has at most ${MAX_ACTIVE_SHARES} active shares. Revoke one first.`, 409);
}

function active(share: StoredShare, now: string): boolean {
  return share.revokedAt === null && (share.expiresAt === null || Date.parse(share.expiresAt) > Date.parse(now));
}

/* ================================================================== memory */

const MAX_MEMORY_RECEIPTS = 20_000;
const MAX_MEMORY_QUEUE = 20_000;
const MAX_MEMORY_SHARES = 50_000;
const MAX_MEMORY_BATCHES = 10_000;

function evict<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly kind = "memory" as const;
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly queue = new Map<string, QueueEntry>();
  private readonly shares = new Map<string, StoredShare>();
  private readonly batchRows = new Map<number, StoredBatch>();
  private revisions = 0;

  async latest(intentId: string): Promise<StoredReceipt | null> {
    let best: StoredReceipt | null = null;
    for (const receipt of this.receipts.values()) if (receipt.intentId === intentId && (!best || receipt.sequence > best.sequence)) best = receipt;
    return best;
  }

  async bySequence(intentId: string, sequence: number): Promise<StoredReceipt | null> {
    for (const receipt of this.receipts.values()) if (receipt.intentId === intentId && receipt.sequence === sequence) return receipt;
    return null;
  }

  async byId(receiptId: string): Promise<StoredReceipt | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async byDigest(digest: string): Promise<StoredReceipt | null> {
    for (const receipt of this.receipts.values()) if (receipt.digest === digest) return receipt;
    return null;
  }

  async list(intentId: string): Promise<StoredReceipt[]> {
    return [...this.receipts.values()].filter((receipt) => receipt.intentId === intentId).sort((a, b) => a.sequence - b.sequence);
  }

  async issue(receipt: StoredReceipt, expectedLatestId: string | null, queueRevision: number | null): Promise<IssueResult> {
    // No await before the write: the check and the insert are atomic in this process.
    let latest: StoredReceipt | null = null;
    for (const candidate of this.receipts.values()) if (candidate.intentId === receipt.intentId && (!latest || candidate.sequence > latest.sequence)) latest = candidate;
    const finish = (result: IssueResult): IssueResult => {
      if (result !== "stale" && queueRevision !== null) this.dequeueSync(receipt.intentId, queueRevision);
      return result;
    };
    if (latest && latest.stateDigest === receipt.stateDigest) return finish("duplicate");
    if ((latest?.id ?? null) !== expectedLatestId) return "stale";
    if (receipt.sequence !== (latest?.sequence ?? 0) + 1) return "stale";
    for (const existing of this.receipts.values()) if (existing.digest === receipt.digest) return "stale";
    if (latest) this.receipts.set(latest.id, { ...latest, supersededBy: receipt.id });
    this.receipts.set(receipt.id, receipt);
    evict(this.receipts, MAX_MEMORY_RECEIPTS);
    return finish("issued");
  }

  async withdraw(intentId: string, at: string): Promise<number> {
    let touched = 0;
    for (const [id, receipt] of this.receipts) {
      if (receipt.intentId !== intentId) continue;
      this.receipts.set(id, { ...receipt, disclosures: null, disclosuresWithdrawnAt: receipt.disclosuresWithdrawnAt ?? at });
      touched += 1;
    }
    for (const [id, share] of this.shares) if (share.intentId === intentId) this.shares.delete(id);
    return touched;
  }

  async enqueue(entry: { intentId: string; ownerKeyId: string | null; reason: QueueReason; notBefore: string }): Promise<void> {
    const existing = this.queue.get(entry.intentId);
    this.revisions += 1;
    if (existing) {
      const earlier = entry.reason === "event" && Date.parse(entry.notBefore) < Date.parse(existing.notBefore);
      this.queue.set(entry.intentId, {
        ...existing,
        ownerKeyId: existing.ownerKeyId ?? entry.ownerKeyId,
        ...(earlier ? { notBefore: entry.notBefore } : {}),
        revision: this.revisions,
      });
      return;
    }
    this.queue.set(entry.intentId, {
      intentId: entry.intentId,
      ownerKeyId: entry.ownerKeyId,
      reason: entry.reason,
      notBefore: entry.notBefore,
      attempts: 0,
      pendingReason: null,
      detail: null,
      expectedBy: null,
      lockedUntil: null,
      createdAt: new Date().toISOString(),
      revision: this.revisions,
    });
    evict(this.queue, MAX_MEMORY_QUEUE);
  }

  async claim(now: string, limit: number, leaseMs: number): Promise<QueueEntry[]> {
    const at = Date.parse(now);
    const due = [...this.queue.values()]
      .filter((entry) => Date.parse(entry.notBefore) <= at && (entry.lockedUntil === null || Date.parse(entry.lockedUntil) < at))
      .sort((a, b) => Date.parse(a.notBefore) - Date.parse(b.notBefore))
      .slice(0, limit);
    return due.map((entry) => {
      const claimed = { ...entry, lockedUntil: new Date(at + leaseMs).toISOString(), attempts: entry.attempts + 1 };
      this.queue.set(entry.intentId, claimed);
      return claimed;
    });
  }

  async reschedule(intentId: string, update: { notBefore: string; pendingReason: PendingReason | null; detail?: string | null; expectedBy?: string | null }): Promise<void> {
    const existing = this.queue.get(intentId);
    if (!existing) return;
    this.queue.set(intentId, {
      ...existing,
      notBefore: update.notBefore,
      pendingReason: update.pendingReason,
      detail: update.detail === undefined ? existing.detail : update.detail,
      expectedBy: update.expectedBy === undefined ? existing.expectedBy : update.expectedBy,
      lockedUntil: null,
    });
  }

  private dequeueSync(intentId: string, revision: number): void {
    const existing = this.queue.get(intentId);
    if (!existing) return;
    if (existing.revision === revision) this.queue.delete(intentId);
    else this.queue.set(intentId, { ...existing, lockedUntil: null, notBefore: new Date().toISOString() });
  }

  async dequeue(intentId: string, revision: number): Promise<void> {
    this.dequeueSync(intentId, revision);
  }

  async queueEntry(intentId: string): Promise<QueueEntry | null> {
    return this.queue.get(intentId) ?? null;
  }

  async queueStats(now: string): Promise<{ size: number; oldestPendingSeconds: number | null }> {
    let oldest: number | null = null;
    for (const entry of this.queue.values()) {
      const created = Date.parse(entry.createdAt);
      if (oldest === null || created < oldest) oldest = created;
    }
    return { size: this.queue.size, oldestPendingSeconds: oldest === null ? null : Math.max(0, Math.floor((Date.parse(now) - oldest) / 1000)) };
  }

  async createShare(share: StoredShare, maxActive: number, now: string): Promise<void> {
    const count = [...this.shares.values()].filter((entry) => entry.receiptId === share.receiptId && active(entry, now)).length;
    if (count >= maxActive) throw shareLimitReached();
    this.shares.set(share.id, share);
    evict(this.shares, MAX_MEMORY_SHARES);
  }

  async share(shareId: string): Promise<StoredShare | null> {
    return this.shares.get(shareId) ?? null;
  }

  async listShares(intentId: string, now: string): Promise<StoredShare[]> {
    return [...this.shares.values()]
      .filter((share) => share.intentId === intentId && active(share, now))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async revokeShare(intentId: string, shareId: string, at: string): Promise<"revoked" | "missing"> {
    const share = this.shares.get(shareId);
    if (!share || share.intentId !== intentId) return "missing";
    if (share.revokedAt === null) this.shares.set(shareId, { ...share, revokedAt: at, ciphertext: "" });
    return "revoked";
  }

  async hasActiveShare(receiptId: string, now: string): Promise<boolean> {
    for (const share of this.shares.values()) if (share.receiptId === receiptId && active(share, now)) return true;
    return false;
  }

  async closeBatch(seal: BatchSealer, maxLeaves: number): Promise<StoredBatch | null> {
    const leaves = [...this.receipts.values()]
      .filter((receipt) => receipt.batchSeq === null)
      .sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, maxLeaves);
    if (leaves.length === 0) return null;
    const previous = this.batchRows.size === 0 ? null : (this.batchRows.get(Math.max(...this.batchRows.keys())) ?? null);
    const sealed = await seal(leaves.map((leaf) => ({ id: leaf.id, digest: leaf.digest })), previous);
    // Another close may have run during `seal` (single process: only the log job closes).
    if (this.batchRows.has(sealed.document.seq)) return null;
    const row: StoredBatch = {
      seq: sealed.document.seq,
      document: sealed.document,
      batchDigest: sealed.batchDigest,
      signature: sealed.signature,
      size: leaves.length,
      anchor: null,
      anchoredAt: null,
      createdAt: new Date().toISOString(),
    };
    this.batchRows.set(row.seq, row);
    evict(this.batchRows, MAX_MEMORY_BATCHES);
    leaves.forEach((leaf, index) => {
      const current = this.receipts.get(leaf.id);
      if (current) this.receipts.set(leaf.id, { ...current, batchSeq: row.seq, leafIndex: index, inclusionPath: sealed.paths[index] ?? [] });
    });
    return row;
  }

  async batch(seq: number): Promise<StoredBatch | null> {
    return this.batchRows.get(seq) ?? null;
  }

  async batches(options: { limit: number; unanchored?: boolean; since?: string }): Promise<StoredBatch[]> {
    return [...this.batchRows.values()]
      .filter((batch) => (!options.unanchored || batch.anchor === null) && (!options.since || batch.createdAt >= options.since))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, options.limit);
  }

  async batchLeaves(seq: number, offset: number, limit: number): Promise<string[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.batchSeq === seq)
      .sort((a, b) => (a.leafIndex ?? 0) - (b.leafIndex ?? 0))
      .slice(offset, offset + limit)
      .map((receipt) => receipt.digest);
  }

  async recordAnchor(seq: number, anchor: BatchAnchor, at: string): Promise<"recorded" | "exists" | "missing"> {
    const batch = this.batchRows.get(seq);
    if (!batch) return "missing";
    if (batch.anchor) return "exists";
    this.batchRows.set(seq, { ...batch, anchor, anchoredAt: at });
    return "recorded";
  }

  async ownerCounts(ownerKeyId: string, since: string, now: string): Promise<{ issued: number; pending: number; sharesActive: number }> {
    const owned = new Set<string>();
    let issued = 0;
    for (const receipt of this.receipts.values()) {
      if (receipt.ownerKeyId !== ownerKeyId) continue;
      owned.add(receipt.id);
      if (receipt.issuedAt >= since) issued += 1;
    }
    const pending = [...this.queue.values()].filter((entry) => entry.ownerKeyId === ownerKeyId).length;
    const sharesActive = [...this.shares.values()].filter((share) => owned.has(share.receiptId) && active(share, now)).length;
    return { issued, pending, sharesActive };
  }
}

/* ================================================================ postgres */

export const RECEIPT_SCHEMA = {
  name: "kletia_receipts",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_receipts (
  id text PRIMARY KEY,
  intent_id text NOT NULL,
  owner_key_id text,
  sequence integer NOT NULL,
  intent_status text NOT NULL,
  state_digest text NOT NULL,
  digest text NOT NULL UNIQUE,
  kid text NOT NULL,
  payload jsonb NOT NULL,
  signature text NOT NULL,
  disclosures jsonb,
  disclosures_withdrawn_at timestamptz,
  attestations jsonb,
  supersedes text,
  superseded_by text,
  batch_seq bigint,
  leaf_index integer,
  inclusion_path jsonb,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, sequence)
);
CREATE INDEX IF NOT EXISTS kletia_receipts_intent_idx ON kletia_receipts (intent_id, sequence DESC);
CREATE INDEX IF NOT EXISTS kletia_receipts_owner_idx ON kletia_receipts (owner_key_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS kletia_receipts_unbatched_idx ON kletia_receipts (issued_at, id) WHERE batch_seq IS NULL;
CREATE INDEX IF NOT EXISTS kletia_receipts_batch_idx ON kletia_receipts (batch_seq, leaf_index) WHERE batch_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS kletia_receipt_queue (
  intent_id text PRIMARY KEY,
  owner_key_id text,
  reason text NOT NULL,
  not_before timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  pending_reason text,
  detail text,
  expected_by timestamptz,
  locked_until timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_receipt_queue_due_idx ON kletia_receipt_queue (not_before);
CREATE INDEX IF NOT EXISTS kletia_receipt_queue_owner_idx ON kletia_receipt_queue (owner_key_id);

CREATE TABLE IF NOT EXISTS kletia_receipt_shares (
  id text PRIMARY KEY,
  receipt_id text NOT NULL REFERENCES kletia_receipts(id),
  intent_id text NOT NULL,
  groups text[] NOT NULL,
  ciphertext text NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_receipt_shares_receipt_idx ON kletia_receipt_shares (receipt_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS kletia_receipt_shares_intent_idx ON kletia_receipt_shares (intent_id);

CREATE TABLE IF NOT EXISTS kletia_receipt_batches (
  seq bigint PRIMARY KEY,
  document jsonb NOT NULL,
  batch_digest text NOT NULL UNIQUE,
  signature text NOT NULL,
  size integer NOT NULL,
  anchor_chain text, anchor_contract text, anchor_tx text, anchor_timestamp bigint, anchored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);`,
} as const;

interface ReceiptRow {
  id: string;
  intent_id: string;
  owner_key_id: string | null;
  sequence: number;
  intent_status: string;
  state_digest: string;
  digest: string;
  kid: string;
  payload: unknown;
  signature: string;
  disclosures: unknown;
  disclosures_withdrawn_at: Date | string | null;
  attestations: unknown;
  supersedes: string | null;
  superseded_by: string | null;
  batch_seq: string | number | null;
  leaf_index: number | null;
  inclusion_path: unknown;
  issued_at: Date | string;
}

interface QueueRow {
  intent_id: string;
  owner_key_id: string | null;
  reason: string;
  not_before: Date | string;
  attempts: number;
  pending_reason: string | null;
  detail: string | null;
  expected_by: Date | string | null;
  locked_until: Date | string | null;
  revision: string | number;
  created_at: Date | string;
}

interface ShareRow {
  id: string;
  receipt_id: string;
  intent_id: string;
  groups: string[];
  ciphertext: string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface BatchRow {
  seq: string | number;
  document: unknown;
  batch_digest: string;
  signature: string;
  size: number;
  anchor_chain: string | null;
  anchor_contract: string | null;
  anchor_tx: string | null;
  anchor_timestamp: string | number | null;
  anchored_at: Date | string | null;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

const RECEIPT_COLUMNS = `id, intent_id, owner_key_id, sequence, intent_status, state_digest, digest, kid, payload, signature, disclosures,
  disclosures_withdrawn_at, attestations, supersedes, superseded_by, batch_seq, leaf_index, inclusion_path, issued_at`;

function receiptFromRow(row: ReceiptRow): StoredReceipt {
  return {
    id: row.id,
    intentId: row.intent_id,
    ownerKeyId: row.owner_key_id,
    sequence: Number(row.sequence),
    intentStatus: row.intent_status as ReceiptIntentStatus,
    stateDigest: row.state_digest,
    digest: row.digest,
    kid: row.kid,
    payload: row.payload as ReceiptPayload,
    signature: row.signature,
    disclosures: (row.disclosures ?? null) as StoredReceipt["disclosures"],
    disclosuresWithdrawnAt: isoOrNull(row.disclosures_withdrawn_at),
    attestations: (row.attestations ?? null) as StoredReceipt["attestations"],
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    batchSeq: row.batch_seq === null ? null : Number(row.batch_seq),
    leafIndex: row.leaf_index,
    inclusionPath: Array.isArray(row.inclusion_path) ? (row.inclusion_path as string[]) : null,
    issuedAt: iso(row.issued_at),
  };
}

function queueFromRow(row: QueueRow): QueueEntry {
  return {
    intentId: row.intent_id,
    ownerKeyId: row.owner_key_id,
    reason: row.reason as QueueReason,
    notBefore: iso(row.not_before),
    attempts: Number(row.attempts),
    pendingReason: row.pending_reason as PendingReason | null,
    detail: row.detail,
    expectedBy: isoOrNull(row.expected_by),
    lockedUntil: isoOrNull(row.locked_until),
    createdAt: iso(row.created_at),
    revision: Number(row.revision),
  };
}

function shareFromRow(row: ShareRow): StoredShare {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    intentId: row.intent_id,
    groups: [...row.groups],
    ciphertext: row.ciphertext,
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function batchFromRow(row: BatchRow): StoredBatch {
  return {
    seq: Number(row.seq),
    document: row.document as ReceiptLogBatch,
    batchDigest: row.batch_digest,
    signature: row.signature,
    size: Number(row.size),
    anchor:
      row.anchor_tx && row.anchor_chain && row.anchor_contract && row.anchor_timestamp !== null
        ? { chain: row.anchor_chain, contract: row.anchor_contract, tx: row.anchor_tx, timestamp: Number(row.anchor_timestamp) }
        : null,
    anchoredAt: isoOrNull(row.anchored_at),
    createdAt: iso(row.created_at),
  };
}

const QUEUE_COLUMNS = "intent_id, owner_key_id, reason, not_before, attempts, pending_reason, detail, expected_by, locked_until, revision, created_at";
const SHARE_COLUMNS = "id, receipt_id, intent_id, groups, ciphertext, expires_at, revoked_at, created_at";
const BATCH_COLUMNS = "seq, document, batch_digest, signature, size, anchor_chain, anchor_contract, anchor_tx, anchor_timestamp, anchored_at, created_at";

export class PostgresReceiptStore implements ReceiptStore {
  readonly kind = "postgres" as const;

  private async receiptWhere(where: string, values: readonly unknown[]): Promise<StoredReceipt | null> {
    const result = await dbQuery<ReceiptRow>(RECEIPT_SCHEMA, `SELECT ${RECEIPT_COLUMNS} FROM kletia_receipts WHERE ${where} LIMIT 1`, values);
    const row = result.rows[0];
    return row ? receiptFromRow(row) : null;
  }

  latest(intentId: string): Promise<StoredReceipt | null> {
    return this.receiptWhere("intent_id = $1 ORDER BY sequence DESC", [intentId]);
  }

  bySequence(intentId: string, sequence: number): Promise<StoredReceipt | null> {
    return this.receiptWhere("intent_id = $1 AND sequence = $2", [intentId, sequence]);
  }

  byId(receiptId: string): Promise<StoredReceipt | null> {
    return this.receiptWhere("id = $1", [receiptId]);
  }

  byDigest(digest: string): Promise<StoredReceipt | null> {
    return this.receiptWhere("digest = $1", [digest]);
  }

  async list(intentId: string): Promise<StoredReceipt[]> {
    const result = await dbQuery<ReceiptRow>(RECEIPT_SCHEMA, `SELECT ${RECEIPT_COLUMNS} FROM kletia_receipts WHERE intent_id = $1 ORDER BY sequence ASC LIMIT 1000`, [intentId]);
    return result.rows.map(receiptFromRow);
  }

  private async dequeueWith(client: pg.PoolClient, intentId: string, revision: number): Promise<void> {
    const removed = await client.query("DELETE FROM kletia_receipt_queue WHERE intent_id = $1 AND revision = $2", [intentId, revision]);
    if (removed.rowCount === 0) {
      await client.query("UPDATE kletia_receipt_queue SET locked_until = NULL, not_before = now() WHERE intent_id = $1", [intentId]);
    }
  }

  async issue(receipt: StoredReceipt, expectedLatestId: string | null, queueRevision: number | null): Promise<IssueResult> {
    return dbTransaction(RECEIPT_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`kletia_receipts:${receipt.intentId}`]);
      const latestResult = await client.query<{ id: string; sequence: number; state_digest: string }>(
        "SELECT id, sequence, state_digest FROM kletia_receipts WHERE intent_id = $1 ORDER BY sequence DESC LIMIT 1",
        [receipt.intentId],
      );
      const latest = latestResult.rows[0];
      if (latest && latest.state_digest === receipt.stateDigest) {
        if (queueRevision !== null) await this.dequeueWith(client, receipt.intentId, queueRevision);
        return "duplicate";
      }
      if ((latest?.id ?? null) !== expectedLatestId || receipt.sequence !== Number(latest?.sequence ?? 0) + 1) return "stale";
      const inserted = await client.query(
        `INSERT INTO kletia_receipts (id, intent_id, owner_key_id, sequence, intent_status, state_digest, digest, kid, payload, signature,
           disclosures, disclosures_withdrawn_at, attestations, supersedes, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15)
         ON CONFLICT DO NOTHING`,
        [
          receipt.id,
          receipt.intentId,
          receipt.ownerKeyId,
          receipt.sequence,
          receipt.intentStatus,
          receipt.stateDigest,
          receipt.digest,
          receipt.kid,
          JSON.stringify(receipt.payload),
          receipt.signature,
          receipt.disclosures === null ? null : JSON.stringify(receipt.disclosures),
          receipt.disclosuresWithdrawnAt,
          receipt.attestations === null ? null : JSON.stringify(receipt.attestations),
          receipt.supersedes,
          receipt.issuedAt,
        ],
      );
      if (inserted.rowCount !== 1) return "stale";
      if (latest) await client.query("UPDATE kletia_receipts SET superseded_by = $1 WHERE id = $2", [receipt.id, latest.id]);
      if (queueRevision !== null) await this.dequeueWith(client, receipt.intentId, queueRevision);
      return "issued";
    });
  }

  async withdraw(intentId: string, at: string): Promise<number> {
    return dbTransaction(RECEIPT_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`kletia_receipts:${intentId}`]);
      await client.query("DELETE FROM kletia_receipt_shares WHERE intent_id = $1", [intentId]);
      const updated = await client.query(
        "UPDATE kletia_receipts SET disclosures = NULL, disclosures_withdrawn_at = COALESCE(disclosures_withdrawn_at, $2) WHERE intent_id = $1",
        [intentId, at],
      );
      return updated.rowCount ?? 0;
    });
  }

  async enqueue(entry: { intentId: string; ownerKeyId: string | null; reason: QueueReason; notBefore: string }): Promise<void> {
    // Events may pull a waiting entry earlier; scans and reads never delay or accelerate one.
    await dbQuery(
      RECEIPT_SCHEMA,
      `INSERT INTO kletia_receipt_queue (intent_id, owner_key_id, reason, not_before)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (intent_id) DO UPDATE SET
         revision = kletia_receipt_queue.revision + 1,
         owner_key_id = COALESCE(kletia_receipt_queue.owner_key_id, EXCLUDED.owner_key_id),
         not_before = CASE WHEN EXCLUDED.reason = 'event' THEN LEAST(kletia_receipt_queue.not_before, EXCLUDED.not_before) ELSE kletia_receipt_queue.not_before END`,
      [entry.intentId, entry.ownerKeyId, entry.reason, entry.notBefore],
    );
  }

  async claim(now: string, limit: number, leaseMs: number): Promise<QueueEntry[]> {
    const result = await dbQuery<QueueRow>(
      RECEIPT_SCHEMA,
      `UPDATE kletia_receipt_queue SET locked_until = $1::timestamptz + ($3::bigint * interval '1 millisecond'), attempts = attempts + 1
       WHERE intent_id IN (
         SELECT intent_id FROM kletia_receipt_queue
         WHERE not_before <= $1 AND (locked_until IS NULL OR locked_until < $1)
         ORDER BY not_before LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING ${QUEUE_COLUMNS}`,
      [now, limit, leaseMs],
    );
    return result.rows.map(queueFromRow);
  }

  async reschedule(intentId: string, update: { notBefore: string; pendingReason: PendingReason | null; detail?: string | null; expectedBy?: string | null }): Promise<void> {
    await dbQuery(
      RECEIPT_SCHEMA,
      `UPDATE kletia_receipt_queue SET not_before = $2, pending_reason = $3, locked_until = NULL,
         detail = CASE WHEN $4::boolean THEN $5 ELSE detail END,
         expected_by = CASE WHEN $6::boolean THEN $7::timestamptz ELSE expected_by END
       WHERE intent_id = $1`,
      [intentId, update.notBefore, update.pendingReason, update.detail !== undefined, update.detail ?? null, update.expectedBy !== undefined, update.expectedBy ?? null],
    );
  }

  async dequeue(intentId: string, revision: number): Promise<void> {
    await dbTransaction(RECEIPT_SCHEMA, (client) => this.dequeueWith(client, intentId, revision));
  }

  async queueEntry(intentId: string): Promise<QueueEntry | null> {
    const result = await dbQuery<QueueRow>(RECEIPT_SCHEMA, `SELECT ${QUEUE_COLUMNS} FROM kletia_receipt_queue WHERE intent_id = $1`, [intentId]);
    const row = result.rows[0];
    return row ? queueFromRow(row) : null;
  }

  async queueStats(now: string): Promise<{ size: number; oldestPendingSeconds: number | null }> {
    const result = await dbQuery<{ size: string; oldest: Date | string | null }>(
      RECEIPT_SCHEMA,
      "SELECT count(*)::text AS size, min(created_at) AS oldest FROM kletia_receipt_queue",
      [],
    );
    const row = result.rows[0];
    const oldest = row?.oldest ? Date.parse(iso(row.oldest)) : null;
    return { size: Number(row?.size ?? "0"), oldestPendingSeconds: oldest === null ? null : Math.max(0, Math.floor((Date.parse(now) - oldest) / 1000)) };
  }

  async createShare(share: StoredShare, maxActive: number, now: string): Promise<void> {
    await dbTransaction(RECEIPT_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`kletia_receipt_shares:${share.receiptId}`]);
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kletia_receipt_shares
         WHERE receipt_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
        [share.receiptId, now],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxActive) throw shareLimitReached();
      await client.query(
        `INSERT INTO kletia_receipt_shares (id, receipt_id, intent_id, groups, ciphertext, expires_at, created_at)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7)`,
        [share.id, share.receiptId, share.intentId, [...share.groups], share.ciphertext, share.expiresAt, share.createdAt],
      );
    });
  }

  async share(shareId: string): Promise<StoredShare | null> {
    const result = await dbQuery<ShareRow>(RECEIPT_SCHEMA, `SELECT ${SHARE_COLUMNS} FROM kletia_receipt_shares WHERE id = $1`, [shareId]);
    const row = result.rows[0];
    return row ? shareFromRow(row) : null;
  }

  async listShares(intentId: string, now: string): Promise<StoredShare[]> {
    const result = await dbQuery<ShareRow>(
      RECEIPT_SCHEMA,
      `SELECT ${SHARE_COLUMNS} FROM kletia_receipt_shares
       WHERE intent_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
       ORDER BY created_at DESC LIMIT 200`,
      [intentId, now],
    );
    return result.rows.map(shareFromRow);
  }

  async revokeShare(intentId: string, shareId: string, at: string): Promise<"revoked" | "missing"> {
    const result = await dbQuery<{ id: string }>(
      RECEIPT_SCHEMA,
      `UPDATE kletia_receipt_shares SET revoked_at = COALESCE(revoked_at, $3), ciphertext = ''
       WHERE id = $1 AND intent_id = $2 RETURNING id`,
      [shareId, intentId, at],
    );
    return result.rowCount === 1 ? "revoked" : "missing";
  }

  async hasActiveShare(receiptId: string, now: string): Promise<boolean> {
    const result = await dbQuery(
      RECEIPT_SCHEMA,
      `SELECT 1 FROM kletia_receipt_shares WHERE receipt_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) LIMIT 1`,
      [receiptId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async closeBatch(seal: BatchSealer, maxLeaves: number): Promise<StoredBatch | null> {
    return dbTransaction(RECEIPT_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kletia_receipt_log', 0))");
      const leaves = await client.query<{ id: string; digest: string }>(
        `SELECT id, digest FROM kletia_receipts WHERE batch_seq IS NULL ORDER BY issued_at, id LIMIT $1 FOR UPDATE`,
        [maxLeaves],
      );
      if (leaves.rows.length === 0) return null;
      const previousResult = await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM kletia_receipt_batches ORDER BY seq DESC LIMIT 1`);
      const previous = previousResult.rows[0] ? batchFromRow(previousResult.rows[0]) : null;
      const sealed = await seal(leaves.rows, previous);
      const inserted = await client.query<BatchRow>(
        `INSERT INTO kletia_receipt_batches (seq, document, batch_digest, signature, size)
         VALUES ($1, $2::jsonb, $3, $4, $5) RETURNING ${BATCH_COLUMNS}`,
        [sealed.document.seq, JSON.stringify(sealed.document), sealed.batchDigest, sealed.signature, leaves.rows.length],
      );
      await client.query(
        `UPDATE kletia_receipts AS r SET batch_seq = $1, leaf_index = v.idx, inclusion_path = v.path
         FROM unnest($2::text[], $3::int[], $4::jsonb[]) AS v(id, idx, path) WHERE r.id = v.id`,
        [
          sealed.document.seq,
          leaves.rows.map((row) => row.id),
          leaves.rows.map((_, index) => index),
          sealed.paths.map((path) => JSON.stringify(path)),
        ],
      );
      return batchFromRow(inserted.rows[0] as BatchRow);
    });
  }

  async batch(seq: number): Promise<StoredBatch | null> {
    const result = await dbQuery<BatchRow>(RECEIPT_SCHEMA, `SELECT ${BATCH_COLUMNS} FROM kletia_receipt_batches WHERE seq = $1`, [seq]);
    const row = result.rows[0];
    return row ? batchFromRow(row) : null;
  }

  async batches(options: { limit: number; unanchored?: boolean; since?: string }): Promise<StoredBatch[]> {
    const result = await dbQuery<BatchRow>(
      RECEIPT_SCHEMA,
      `SELECT ${BATCH_COLUMNS} FROM kletia_receipt_batches
       WHERE ($2::boolean IS NOT TRUE OR anchor_tx IS NULL) AND ($3::timestamptz IS NULL OR created_at >= $3)
       ORDER BY seq DESC LIMIT $1`,
      [options.limit, options.unanchored === true, options.since ?? null],
    );
    return result.rows.map(batchFromRow);
  }

  async batchLeaves(seq: number, offset: number, limit: number): Promise<string[]> {
    const result = await dbQuery<{ digest: string }>(
      RECEIPT_SCHEMA,
      "SELECT digest FROM kletia_receipts WHERE batch_seq = $1 ORDER BY leaf_index ASC OFFSET $2 LIMIT $3",
      [seq, offset, limit],
    );
    return result.rows.map((row) => row.digest);
  }

  async recordAnchor(seq: number, anchor: BatchAnchor, at: string): Promise<"recorded" | "exists" | "missing"> {
    const result = await dbQuery<{ seq: string }>(
      RECEIPT_SCHEMA,
      `UPDATE kletia_receipt_batches SET anchor_chain = $2, anchor_contract = $3, anchor_tx = $4, anchor_timestamp = $5, anchored_at = $6
       WHERE seq = $1 AND anchor_tx IS NULL RETURNING seq`,
      [seq, anchor.chain, anchor.contract, anchor.tx, anchor.timestamp, at],
    );
    if (result.rowCount === 1) return "recorded";
    return (await this.batch(seq)) ? "exists" : "missing";
  }

  async ownerCounts(ownerKeyId: string, since: string, now: string): Promise<{ issued: number; pending: number; sharesActive: number }> {
    const result = await dbQuery<{ issued: string; pending: string; shares: string }>(
      RECEIPT_SCHEMA,
      `SELECT
         (SELECT count(*) FROM kletia_receipts WHERE owner_key_id = $1 AND issued_at >= $2)::text AS issued,
         (SELECT count(*) FROM kletia_receipt_queue WHERE owner_key_id = $1)::text AS pending,
         (SELECT count(*) FROM kletia_receipt_shares s JOIN kletia_receipts r ON r.id = s.receipt_id
            WHERE r.owner_key_id = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > $3))::text AS shares`,
      [ownerKeyId, since, now],
    );
    const row = result.rows[0];
    return { issued: Number(row?.issued ?? "0"), pending: Number(row?.pending ?? "0"), sharesActive: Number(row?.shares ?? "0") };
  }
}

/* ------------------------------------------------------------------ choice */

let store: ReceiptStore | null = null;

/** Memory, or Postgres when KLETIA_DATABASE_URL is set (resolved lazily, once). */
export function receiptStore(): ReceiptStore {
  store ??= platformDatabaseUrl() ? new PostgresReceiptStore() : new MemoryReceiptStore();
  return store;
}

/** Replaces the store (tests); null re-resolves it from the environment. */
export function configureReceiptStore(next: ReceiptStore | null): void {
  store = next;
}

export function receiptInclusion(receipt: StoredReceipt, batch: StoredBatch | null): ReceiptInclusion | null {
  if (receipt.batchSeq === null || receipt.leafIndex === null || !receipt.inclusionPath || !batch || batch.seq !== receipt.batchSeq) return null;
  return {
    batch: batch.document,
    batchSignature: batch.signature,
    leafIndex: receipt.leafIndex,
    path: [...receipt.inclusionPath],
    anchor: batch.anchor ? { chain: batch.anchor.chain as CaipChainId, contract: batch.anchor.contract, timestamp: batch.anchor.timestamp, tx: batch.anchor.tx } : null,
  };
}
