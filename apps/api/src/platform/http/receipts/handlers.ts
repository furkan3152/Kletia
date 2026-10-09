/**
 * Receipt routes (receipts design §11) and the read functions MCP shares.
 *
 * Owner routes take the intent id as the capability (like GET
 * /v1/intents/{id}); public routes serve only what is safe without it: keys,
 * log batches and inclusion proofs (digests reveal nothing), and a receipt's
 * signed payload while (and only while) the owner shares it. Unknown and
 * unshared receipts answer the same 404.
 */
import type { Request, RequestHandler, Response } from "express";
import {
  isReceiptableStatus,
  RECEIPT_DIGEST_PATTERN,
  RECEIPT_ID_PATTERN,
  RECEIPT_SHARE_ID_PATTERN,
  type ReceiptDisclosure,
  type ReceiptInclusion,
  type ReceiptKey,
  type ReceiptLogBatch,
  type ReceiptPayload,
} from "@kletia/core";
import { getIntent } from "../../index.js";
import { PlatformError } from "../../errors.js";
import { requireApiKey } from "../auth.js";
import { authOf, booleanQuery, cachePublicly, handle, HttpError, intentIdParam, integerQuery, invalidRequest, isRecord, pathParam, queryParam } from "../context.js";
import { idempotent } from "../idempotency.js";
import { randomHex } from "../secrets.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { EAS_CHAIN, EAS_SCHEMA_UID, type EasEnvelope } from "./eas.js";
import { enqueueReceipt, intentStateDigest } from "./issuer.js";
import { reportAnchor } from "./log.js";
import { encryptShare, parseShareRequest, shareGroups, shareUrl } from "./shares.js";
import { activeReceiptSigner, easAttester, receiptKeys, receiptsEnabled } from "./signer.js";
import { MAX_ACTIVE_SHARES, receiptInclusion, receiptStore, type QueueEntry, type StoredBatch, type StoredReceipt, type StoredShare } from "./store.js";

export const RECEIPT_KEYS_CACHE_SECONDS = 3_600;
export const MAX_LOG_LEAVES_PAGE = 1_000;
const SHARED_CACHE_SECONDS = 60;

/* ------------------------------------------------------------------ views */

export interface ReceiptDocumentView {
  readonly payload: ReceiptPayload;
  readonly digest: string;
  readonly signature: { readonly alg: "Ed25519"; readonly kid: string; readonly value: string };
  readonly disclosures?: Readonly<Record<string, ReceiptDisclosure>>;
  readonly inclusion?: ReceiptInclusion;
  readonly attestations?: { readonly eas?: EasEnvelope };
}

export interface PendingView {
  /** queued, awaiting_finality, finality_timeout, rpc_unavailable, anchor_reorged, signer_missing or issuer_error. */
  readonly reason: string;
  readonly expectedBy: string | null;
  readonly retryAfterSeconds: number;
}

export interface BatchView {
  readonly seq: number;
  readonly batch: ReceiptLogBatch;
  readonly batchDigest: string;
  readonly signature: string;
  readonly anchor: { readonly chain: string; readonly contract: string; readonly tx: string; readonly timestamp: number } | null;
  readonly closedAt: string;
}

async function documentView(receipt: StoredReceipt, withDisclosures: boolean): Promise<ReceiptDocumentView> {
  const batch = receipt.batchSeq === null ? null : await receiptStore().batch(receipt.batchSeq);
  const inclusion = receiptInclusion(receipt, batch);
  return {
    payload: receipt.payload,
    digest: receipt.digest,
    signature: { alg: "Ed25519", kid: receipt.kid, value: receipt.signature },
    ...(withDisclosures && receipt.disclosures ? { disclosures: receipt.disclosures } : {}),
    ...(inclusion ? { inclusion } : {}),
    ...(receipt.attestations?.eas ? { attestations: { eas: receipt.attestations.eas } } : {}),
  };
}

function batchView(batch: StoredBatch): BatchView {
  return { seq: batch.seq, batch: batch.document, batchDigest: batch.batchDigest, signature: batch.signature, anchor: batch.anchor, closedAt: batch.createdAt };
}

function pendingView(entry: QueueEntry | null, now: number): PendingView {
  const target = entry?.expectedBy ? Date.parse(entry.expectedBy) : entry ? Date.parse(entry.notBefore) : Number.NaN;
  const seconds = Number.isFinite(target) ? Math.ceil((target - now) / 1000) : 30;
  return {
    reason: entry?.pendingReason ?? "queued",
    expectedBy: entry?.expectedBy ?? null,
    retryAfterSeconds: Math.min(3_600, Math.max(5, seconds)),
  };
}

/* -------------------------------------------------------------- owner reads */

function notReady(status: string): PlatformError {
  const error = new PlatformError(
    "RECEIPT_NOT_READY",
    `The intent is ${status}: receipts are issued after it ends and every on-chain reference is finalized. Retry later.`,
    409,
  );
  return Object.assign(error, { retryAfterSeconds: 60 });
}

function notApplicable(): PlatformError {
  return new PlatformError("RECEIPT_NOT_APPLICABLE", "The intent expired before anything executed, so it gets no receipt.", 409);
}

function receiptNotFound(): PlatformError {
  return new PlatformError("RECEIPT_NOT_FOUND", "Receipt not found.", 404);
}

export type OwnerReceipt =
  | { readonly state: "issued"; readonly receipt: StoredReceipt; readonly document: ReceiptDocumentView; readonly pending?: PendingView }
  | { readonly state: "pending"; readonly pending: PendingView };

/**
 * The latest receipt of an intent (or `sequence`), with every disclosure the
 * owner still stores. A newer state not yet receipted is `pending` (queued
 * on read, so a missed event never strands an intent).
 */
export async function readOwnerReceipt(intentId: string, sequence?: number, now = Date.now()): Promise<OwnerReceipt> {
  const graph = await getIntent(intentId);
  const store = receiptStore();
  if (sequence !== undefined) {
    const receipt = await store.bySequence(intentId, sequence);
    if (!receipt) throw receiptNotFound();
    return { state: "issued", receipt, document: await documentView(receipt, true) };
  }
  const latest = await store.latest(intentId);
  if (!isReceiptableStatus(graph.status)) {
    // An earlier receipt (e.g. of a failed step now retried) stays true as of its day.
    if (latest) return { state: "issued", receipt: latest, document: await documentView(latest, true) };
    if (graph.status === "expired") throw notApplicable();
    throw notReady(graph.status);
  }
  if (latest && latest.stateDigest === intentStateDigest(graph)) return { state: "issued", receipt: latest, document: await documentView(latest, true) };
  if (!receiptsEnabled() || !activeReceiptSigner()) {
    if (latest) return { state: "issued", receipt: latest, document: await documentView(latest, true) };
    throw new PlatformError("RECEIPTS_DISABLED", "Receipts are switched off or no signing key is configured on this deployment; existing receipts stay readable.", 503);
  }
  let entry = await store.queueEntry(intentId);
  if (!entry) {
    await enqueueReceipt(intentId, "read", 0, now);
    entry = await store.queueEntry(intentId);
  }
  const pending = pendingView(entry, now);
  if (latest) return { state: "issued", receipt: latest, document: await documentView(latest, true), pending };
  return { state: "pending", pending };
}

export interface ReceiptListEntry {
  readonly receiptId: string;
  readonly sequence: number;
  readonly status: string;
  readonly terminal: boolean;
  readonly digest: string;
  readonly issuedOn: string;
  readonly supersededBy: string | null;
}

export async function listOwnerReceipts(intentId: string): Promise<ReceiptListEntry[]> {
  await getIntent(intentId);
  return (await receiptStore().list(intentId)).map((receipt) => ({
    receiptId: receipt.id,
    sequence: receipt.sequence,
    status: receipt.intentStatus,
    terminal: receipt.payload.intent.terminal,
    digest: receipt.digest,
    issuedOn: receipt.payload.issuedOn,
    supersededBy: receipt.supersededBy,
  }));
}

/* ------------------------------------------------------------------- shares */

export interface ShareView {
  readonly id: string;
  readonly receiptId: string;
  readonly sequence: number;
  readonly groups: readonly string[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  /** Only in the creation response: carries the decryption key in its fragment. */
  readonly url?: string;
}

function shareView(share: StoredShare, sequence: number, url?: string): ShareView {
  return { id: share.id, receiptId: share.receiptId, sequence, groups: share.groups, expiresAt: share.expiresAt, createdAt: share.createdAt, ...(url ? { url } : {}) };
}

export async function createReceiptShare(intentId: string, body: unknown, now = Date.now()): Promise<ShareView> {
  const request = parseShareRequest(body);
  const graph = await getIntent(intentId);
  const store = receiptStore();
  const receipt = request.sequence !== undefined ? await store.bySequence(intentId, request.sequence) : await store.latest(intentId);
  if (!receipt) {
    if (request.sequence !== undefined) throw receiptNotFound();
    if (graph.status === "expired") throw notApplicable();
    throw notReady(graph.status);
  }
  if (receipt.disclosuresWithdrawnAt || !receipt.disclosures) {
    throw new PlatformError("RECEIPT_DISCLOSURES_WITHDRAWN", "The owner withdrew this intent's disclosures, so no share can be created. The signed payloads remain.", 410);
  }
  const groups = shareGroups(request, receipt.payload);
  const id = `rsh_${randomHex(12)}`;
  const { ciphertext, key } = encryptShare(receipt.id, id, receipt.disclosures, groups);
  const at = new Date(now).toISOString();
  const share: StoredShare = {
    id,
    receiptId: receipt.id,
    intentId,
    groups,
    ciphertext,
    expiresAt: request.expiresInSeconds === null ? null : new Date(now + request.expiresInSeconds * 1000).toISOString(),
    revokedAt: null,
    createdAt: at,
  };
  await store.createShare(share, MAX_ACTIVE_SHARES, at);
  return shareView(share, receipt.sequence, shareUrl(kletiaWebOrigin(), receipt.id, id, key));
}

export async function listReceiptShares(intentId: string, now = Date.now()): Promise<ShareView[]> {
  await getIntent(intentId);
  const store = receiptStore();
  const sequences = new Map((await store.list(intentId)).map((receipt) => [receipt.id, receipt.sequence]));
  return (await store.listShares(intentId, new Date(now).toISOString())).map((share) => shareView(share, sequences.get(share.receiptId) ?? 0));
}

export async function revokeReceiptShare(intentId: string, shareId: string, now = Date.now()): Promise<void> {
  await getIntent(intentId);
  const result = await receiptStore().revokeShare(intentId, shareId, new Date(now).toISOString());
  if (result === "missing") throw new PlatformError("RECEIPT_SHARE_NOT_FOUND", "No such share for this intent.", 404);
}

/**
 * Deletes the stored disclosures of every receipt of the intent and every
 * share. With no receipt yet nothing could be withdrawn, so the caller is told
 * (409) rather than answered 204 for a no-op.
 */
export async function withdrawReceiptDisclosures(intentId: string, now = Date.now()): Promise<void> {
  const graph = await getIntent(intentId);
  const touched = await receiptStore().withdraw(intentId, new Date(now).toISOString());
  if (touched === 0) {
    if (graph.status === "expired") throw notApplicable();
    throw notReady(graph.status);
  }
}

/* ------------------------------------------------------------------ public */

/** The signed payload of a receipt while the owner shares it (no disclosures); 404 otherwise. */
export async function readSharedReceipt(receiptId: string, now = Date.now()): Promise<{ readonly receipt: StoredReceipt; readonly document: ReceiptDocumentView }> {
  const store = receiptStore();
  const receipt = await store.byId(receiptId);
  if (!receipt || !(await store.hasActiveShare(receiptId, new Date(now).toISOString()))) throw receiptNotFound();
  return { receipt, document: await documentView(receipt, false) };
}

export async function readShareCiphertext(receiptId: string, shareId: string, now = Date.now()): Promise<{ ciphertext: string; alg: "A256GCM"; groups: readonly string[]; expiresAt: string | null }> {
  const share = await receiptStore().share(shareId);
  if (!share || share.receiptId !== receiptId || share.revokedAt !== null || !share.ciphertext) {
    throw new PlatformError("RECEIPT_SHARE_NOT_FOUND", "The share link is unknown or was revoked.", 404);
  }
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= now) {
    throw new PlatformError("RECEIPT_SHARE_EXPIRED", "This share link expired. Ask the receipt's owner for a new one.", 410);
  }
  return { ciphertext: share.ciphertext, alg: "A256GCM", groups: share.groups, expiresAt: share.expiresAt };
}

export interface KeySetView {
  readonly keys: readonly ReceiptKey[];
  readonly attesters: readonly { readonly type: "eas"; readonly chain: string; readonly address: string; readonly schemaUid: string; readonly status: "active" }[];
}

export function receiptKeySet(): KeySetView {
  const attester = easAttester();
  return {
    keys: receiptKeys(),
    attesters: attester ? [{ type: "eas", chain: EAS_CHAIN, address: attester.address, schemaUid: EAS_SCHEMA_UID, status: "active" }] : [],
  };
}

export async function inclusionByDigest(digest: string): Promise<ReceiptInclusion> {
  const receipt = await receiptStore().byDigest(digest);
  const batch = receipt && receipt.batchSeq !== null ? await receiptStore().batch(receipt.batchSeq) : null;
  const inclusion = receipt ? receiptInclusion(receipt, batch) : null;
  if (!inclusion) throw new PlatformError("RECEIPT_LOG_NOT_FOUND", "No log batch includes this digest yet (batches close hourly).", 404);
  return inclusion;
}

/* ------------------------------------------------------------------ params */

export function receiptIdParam(req: Request): string {
  const id = pathParam(req, "receiptId");
  if (!RECEIPT_ID_PATTERN.test(id)) throw invalidRequest("Receipt ids look like rcpt_ followed by 32 lowercase hex characters.", [{ path: "receiptId", message: "Invalid receipt id." }]);
  return id;
}

export function shareIdParam(req: Request): string {
  const id = pathParam(req, "shareId");
  if (!RECEIPT_SHARE_ID_PATTERN.test(id)) throw invalidRequest("Share ids look like rsh_ followed by 24 lowercase hex characters.", [{ path: "shareId", message: "Invalid share id." }]);
  return id;
}

function seqParam(req: Request): number {
  const raw = pathParam(req, "seq");
  if (!/^[1-9]\d{0,14}$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalidRequest("Log batch numbers are positive integers.", [{ path: "seq", message: "Invalid batch number." }]);
  return Number(raw);
}

function sequenceQuery(req: Request): number | undefined {
  const raw = queryParam(req, "sequence", 10);
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d{0,8}$/u.test(raw)) throw invalidRequest("sequence must be a positive integer.", [{ path: "sequence", message: "Expected a positive integer." }]);
  return Number(raw);
}

/* ---------------------------------------------------------------- handlers */

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/** Route handlers keyed like the router's table ("<method> <path>"). */
export function receiptHandlers(): Record<string, RequestHandler[]> {
  return {
    "get /intents/:id/receipt": [
      handle(async (req, res) => {
        const read = await readOwnerReceipt(intentIdParam(req), sequenceQuery(req));
        if (read.state === "pending") {
          res.setHeader("Retry-After", String(read.pending.retryAfterSeconds));
          sendJson(res, 202, { receipt: null, pending: read.pending });
          return;
        }
        sendJson(res, 200, { receipt: read.document, ...(read.pending ? { pending: read.pending } : {}) });
      }),
    ],
    "get /intents/:id/receipts": [
      handle(async (req, res) => {
        sendJson(res, 200, { receipts: await listOwnerReceipts(intentIdParam(req)) });
      }),
    ],
    "post /intents/:id/receipt/shares": [
      // Keyed callers may retry safely; the stored response carries the link key, so it is sealed.
      idempotent({ route: "POST /intents/:id/receipt/shares", secret: true }),
      handle(async (req, res) => {
        sendJson(res, 201, { share: await createReceiptShare(intentIdParam(req), req.body) });
      }),
    ],
    "get /intents/:id/receipt/shares": [
      handle(async (req, res) => {
        sendJson(res, 200, { shares: await listReceiptShares(intentIdParam(req)) });
      }),
    ],
    "delete /intents/:id/receipt/shares/:shareId": [
      handle(async (req, res) => {
        await revokeReceiptShare(intentIdParam(req), shareIdParam(req));
        res.status(204).end();
      }),
    ],
    "delete /intents/:id/receipt/disclosures": [
      handle(async (req, res) => {
        await withdrawReceiptDisclosures(intentIdParam(req));
        res.status(204).end();
      }),
    ],
    "get /receipts/keys": [
      handle((_req, res) => {
        cachePublicly(res, RECEIPT_KEYS_CACHE_SECONDS);
        sendJson(res, 200, receiptKeySet());
      }),
    ],
    "get /receipts/log": [
      handle(async (req, res) => {
        const limit = integerQuery(req, "limit", 20, 1, 100);
        const unanchored = booleanQuery(req, "unanchored");
        const batches = await receiptStore().batches({ limit, unanchored });
        cachePublicly(res, SHARED_CACHE_SECONDS);
        sendJson(res, 200, { batches: batches.map(batchView) });
      }),
    ],
    "get /receipts/log/inclusion": [
      handle(async (req, res) => {
        const digest = queryParam(req, "digest", 64) ?? "";
        if (!RECEIPT_DIGEST_PATTERN.test(digest)) throw invalidRequest("digest must be a receipt digest (64 lowercase hex characters).", [{ path: "digest", message: "Invalid digest." }]);
        const inclusion = await inclusionByDigest(digest);
        cachePublicly(res, SHARED_CACHE_SECONDS);
        sendJson(res, 200, { inclusion });
      }),
    ],
    "get /receipts/log/:seq": [
      handle(async (req, res) => {
        const seq = seqParam(req);
        const withLeaves = booleanQuery(req, "leaves");
        const offset = integerQuery(req, "offset", 0, 0, 65_535);
        const limit = integerQuery(req, "limit", MAX_LOG_LEAVES_PAGE, 1, MAX_LOG_LEAVES_PAGE);
        const batch = await receiptStore().batch(seq);
        if (!batch) throw new PlatformError("RECEIPT_LOG_NOT_FOUND", `Log batch ${seq} does not exist.`, 404);
        const leaves = withLeaves ? await receiptStore().batchLeaves(seq, offset, limit) : null;
        // A closed batch never changes; its anchor may still be recorded later.
        if (batch.anchor) res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        else cachePublicly(res, SHARED_CACHE_SECONDS);
        sendJson(res, 200, { batch: batchView(batch), ...(leaves ? { leaves: { offset, limit, total: batch.size, items: leaves } } : {}) });
      }),
    ],
    "post /receipts/log/:seq/anchor": [
      requireApiKey,
      handle(async (req, res) => {
        if (authOf(req).tier !== "operator") throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an operator API key.");
        const seq = seqParam(req);
        const body: unknown = req.body;
        if (!isRecord(body) || typeof body.tx !== "string" || Object.keys(body).some((key) => key !== "tx")) {
          throw invalidRequest("Body must be { \"tx\": \"0x…\" } (the Base transaction that called EAS.timestamp for this batch).", [{ path: "tx", message: "Required transaction hash." }]);
        }
        sendJson(res, 200, { batch: batchView(await reportAnchor(seq, body.tx)) });
      }),
    ],
    "get /receipts/:receiptId": [
      handle(async (req, res) => {
        const { document } = await readSharedReceipt(receiptIdParam(req));
        cachePublicly(res, SHARED_CACHE_SECONDS);
        sendJson(res, 200, { receipt: document });
      }),
    ],
    "get /receipts/:receiptId/status": [
      handle(async (req, res) => {
        const { receipt } = await readSharedReceipt(receiptIdParam(req));
        cachePublicly(res, SHARED_CACHE_SECONDS);
        sendJson(res, 200, { sequence: receipt.sequence, terminal: receipt.payload.intent.terminal, supersededBy: receipt.supersededBy });
      }),
    ],
    "get /receipts/:receiptId/shares/:shareId": [
      handle(async (req, res) => {
        sendJson(res, 200, await readShareCiphertext(receiptIdParam(req), shareIdParam(req)));
      }),
    ],
  };
}
