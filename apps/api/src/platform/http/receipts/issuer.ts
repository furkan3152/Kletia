/**
 * Receipt issuance (receipts design §5.6).
 *
 *   intent.status_changed / intent.step_updated ─┐      periodic scan (5 min, last 7 days)
 *                                                └─► enqueue(intent, not_before = now + 60 s) ◄─┘
 *   worker (claims with a 2-minute lease, 4 at a time):
 *     load graph ─► receiptable? ─► state digest already receipted? ─► signer present?
 *     ─► collectReceiptInputs (engine: anchors gated on finality) ─► ready?
 *     ─► buildReceipt (core, pure, fresh CSPRNG salts) ─► digest ─► Ed25519 sign
 *     ─► self-verify with core verifyReceipt ─► optional EAS envelope
 *     ─► store (advisory lock: sequence + 1, supersedes, dedupe) ─► intent.receipt_issued
 *
 * Never issues on unfinalized data: `waiting_finality` reschedules at the
 * expected time (finality budget KLETIA_RECEIPT_FINALITY_MAX_SECONDS, default
 * 7,200 s; past it the entry stays pending as `finality_timeout`, re-checked
 * hourly, with an alert), `retry` backs off, `reorged` logs an alert and
 * refreshes the intent. A failed self-verification aborts issuance (a bug,
 * never a partial receipt). Without a signing key the queue keeps
 * collecting and drains once a key is configured. Kill switch:
 * KLETIA_RECEIPTS_ENABLED=false (nothing is issued, reads keep working).
 */
import {
  buildReceipt,
  isReceiptableStatus,
  RECEIPTABLE_STATUSES,
  randomReceiptSalt,
  receiptDigest,
  receiptGroupSlots,
  receiptSigningInput,
  receiptStateDigest,
  verifyReceipt,
  type IntentGraph,
  type IntentStatus,
  type ReceiptCollection,
} from "@kletia/core";
import {
  collectReceiptInputs,
  getIntent,
  getIntentStore,
  isPlatformError,
  plannedAnchors,
  publishReceiptEvent,
  refreshIntent,
  subscribeIntentEvents,
  type IntentEvent,
} from "../../index.js";
import { PLATFORM_API_VERSION } from "../health.js";
import { resolveIntentOwner } from "../owners.js";
import { randomHex } from "../secrets.js";
import { attestReceipt, verifyEasEnvelope, type EasEnvelope } from "./eas.js";
import { activeReceiptSigner, easAttester, receiptKeys, receiptsEnabled } from "./signer.js";
import { QUEUE_LEASE_MS, receiptStore, type PendingReason, type QueueEntry, type QueueReason, type StoredReceipt } from "./store.js";

export const RECEIPT_EVENT_DELAY_MS = 60_000;
export const RECEIPT_POLL_MS = 15_000;
export const RECEIPT_SCAN_MS = 5 * 60_000;
export const RECEIPT_SCAN_WINDOW_MS = 7 * 86_400_000;
export const RECEIPT_CONCURRENCY = 4;
const CLAIM_LIMIT = 20;
const SCAN_PAGE = 1_000;
const SCAN_PAGES = 5;
const SCAN_OVERLAP_MS = 10 * 60_000;
const SIGNER_MISSING_RETRY_MS = 10 * 60_000;
const ISSUER_ERROR_RETRY_MS = 60 * 60_000;
const REORG_RETRY_MS = 5 * 60_000;
const MAX_WAIT_STEP_MS = 30 * 60_000;
const MIN_WAIT_STEP_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_TRACKED_STATUSES = 20_000;
export const DEFAULT_ISSUER_ORIGIN = "https://api.kletiaai.xyz";

export type ProcessOutcome =
  | { readonly kind: "issued"; readonly receipt: StoredReceipt }
  | { readonly kind: "dropped"; readonly reason: "not_found" | "not_receiptable" | "unchanged" }
  | { readonly kind: "rescheduled"; readonly reason: PendingReason; readonly notBefore: string; readonly expectedBy: string | null }
  | { readonly kind: "stale" };

export interface ReceiptIssuerOptions {
  /** Reads anchors gated on finality (default: the engine's collectReceiptInputs). */
  readonly collect?: (graph: IntentGraph) => Promise<ReceiptCollection>;
  readonly now?: () => number;
  readonly concurrency?: number;
  readonly pollMs?: number;
  readonly scanMs?: number;
  readonly eventDelayMs?: number;
}

/** KLETIA_RECEIPT_FINALITY_MAX_SECONDS (default 7,200). */
export function finalityBudgetMs(): number {
  const raw = Number(process.env.KLETIA_RECEIPT_FINALITY_MAX_SECONDS?.trim() ?? "");
  return (Number.isSafeInteger(raw) && raw >= 60 ? raw : 7_200) * 1000;
}

/** The `issuer.origin` of signed payloads: KLETIA_RECEIPT_ISSUER_ORIGIN (an exact HTTPS origin) or the hosted API. */
export function receiptIssuerOrigin(): string {
  const raw = process.env.KLETIA_RECEIPT_ISSUER_ORIGIN?.trim();
  if (!raw) return DEFAULT_ISSUER_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch {
    // fall through
  }
  return DEFAULT_ISSUER_ORIGIN;
}

/** The dedupe digest of an intent's receiptable state (§5.7): fills are the destination references settlement evidence names. */
export function intentStateDigest(graph: IntentGraph): string {
  const fills: Record<string, string[]> = {};
  for (const anchor of plannedAnchors(graph)) if (anchor.role === "fill") (fills[anchor.step.id] ??= []).push(anchor.reference);
  return receiptStateDigest(graph, fills);
}

/** Queues an intent for issuance (idempotent per intent; events may pull a waiting entry earlier). */
export async function enqueueReceipt(intentId: string, reason: QueueReason, delayMs = 0, now = Date.now()): Promise<void> {
  const owner = await resolveIntentOwner(intentId);
  await receiptStore().enqueue({ intentId, ownerKeyId: owner ?? null, reason, notBefore: new Date(now + delayMs).toISOString() });
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export class ReceiptIssuer {
  private readonly collect: (graph: IntentGraph) => Promise<ReceiptCollection>;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly statuses = new Map<string, IntentStatus>();
  private lastScan: number | null = null;
  private working = false;
  private scanning = false;

  constructor(private readonly options: ReceiptIssuerOptions = {}) {
    this.collect = options.collect ?? ((graph) => collectReceiptInputs(graph));
    this.now = options.now ?? Date.now;
    this.concurrency = Math.max(1, options.concurrency ?? RECEIPT_CONCURRENCY);
  }

  /** Subscribes to intent events and starts the worker and the scan. Returns a stop function. */
  start(): () => void {
    const unsubscribe = subscribeIntentEvents((event) => this.onEvent(event));
    const worker = setInterval(() => void this.tick(), this.options.pollMs ?? RECEIPT_POLL_MS);
    const scanner = setInterval(() => void this.scanSafely(), this.options.scanMs ?? RECEIPT_SCAN_MS);
    worker.unref?.();
    scanner.unref?.();
    // The first scan catches up on intents that finished while no issuer ran (after a minute: boot stays light).
    const first = setTimeout(() => void this.scanSafely(), Math.min(this.options.scanMs ?? RECEIPT_SCAN_MS, 60_000));
    first.unref?.();
    return () => {
      unsubscribe();
      clearInterval(worker);
      clearInterval(scanner);
      clearTimeout(first);
    };
  }

  private remember(intentId: string, status: IntentStatus): void {
    this.statuses.delete(intentId);
    this.statuses.set(intentId, status);
    while (this.statuses.size > MAX_TRACKED_STATUSES) {
      const oldest = this.statuses.keys().next().value;
      if (oldest === undefined) break;
      this.statuses.delete(oldest);
    }
  }

  /** In-process events: a receiptable status, or a step change of an intent last seen receiptable. */
  onEvent(event: IntentEvent): void {
    let due = false;
    if (event.type === "intent.status_changed") {
      this.remember(event.data.intentId, event.data.status);
      due = isReceiptableStatus(event.data.status);
    } else if (event.type === "intent.step_updated") {
      const status = this.statuses.get(event.data.intentId);
      due = status !== undefined && isReceiptableStatus(status);
    }
    if (!due || !receiptsEnabled()) return;
    enqueueReceipt(event.data.intentId, "event", this.options.eventDelayMs ?? RECEIPT_EVENT_DELAY_MS, this.now()).catch((error: unknown) => {
      console.warn("[platform] receipt enqueue failed:", error instanceof Error ? error.message : error);
    });
  }

  private async scanSafely(): Promise<void> {
    if (this.scanning || !receiptsEnabled()) return;
    this.scanning = true;
    try {
      await this.scan();
    } catch (error) {
      console.warn("[platform] receipt scan failed:", error instanceof Error ? error.message : error);
    } finally {
      this.scanning = false;
    }
  }

  /** Queues every receiptable intent changed since the last scan (first scan: 7 days). Returns how many. */
  async scan(): Promise<number> {
    const store = getIntentStore();
    if (!store.listChangedSince) return 0;
    const now = this.now();
    let cursor = new Date(this.lastScan === null ? now - RECEIPT_SCAN_WINDOW_MS : this.lastScan - SCAN_OVERLAP_MS).toISOString();
    let queued = 0;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const changes = await store.listChangedSince(RECEIPTABLE_STATUSES, cursor, SCAN_PAGE);
      for (const change of changes) {
        await enqueueReceipt(change.id, "scan", 0, now);
        queued += 1;
      }
      const last = changes.at(-1);
      if (changes.length < SCAN_PAGE || !last || last.updatedAt === cursor) break;
      cursor = last.updatedAt;
    }
    this.lastScan = now;
    return queued;
  }

  private async tick(): Promise<void> {
    if (this.working || !receiptsEnabled() || !activeReceiptSigner()) return;
    this.working = true;
    try {
      await this.runDue();
    } catch (error) {
      console.warn("[platform] receipt worker failed:", error instanceof Error ? error.message : error);
    } finally {
      this.working = false;
    }
  }

  /** Claims due queue entries and processes them, `concurrency` at a time. */
  async runDue(limit = CLAIM_LIMIT): Promise<ProcessOutcome[]> {
    if (!receiptsEnabled()) return [];
    const entries = await receiptStore().claim(new Date(this.now()).toISOString(), limit, QUEUE_LEASE_MS);
    const outcomes: ProcessOutcome[] = new Array<ProcessOutcome>(entries.length);
    let next = 0;
    const lane = async () => {
      while (next < entries.length) {
        const index = next;
        next += 1;
        const entry = entries[index] as QueueEntry;
        outcomes[index] = await this.process(entry).catch(async (error: unknown): Promise<ProcessOutcome> => {
          console.error(`[platform] receipt issuance for ${entry.intentId} failed:`, error instanceof Error ? error.message : error);
          return this.reschedule(entry, "issuer_error", this.now() + ISSUER_ERROR_RETRY_MS, null, "unexpected issuer error");
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, entries.length) }, lane));
    return outcomes;
  }

  private async reschedule(entry: QueueEntry, reason: PendingReason, notBefore: number, expectedBy: string | null, detail: string | null): Promise<ProcessOutcome> {
    const at = new Date(notBefore).toISOString();
    await receiptStore().reschedule(entry.intentId, { notBefore: at, pendingReason: reason, detail: detail?.slice(0, 300) ?? null, expectedBy });
    return { kind: "rescheduled", reason, notBefore: at, expectedBy };
  }

  /** One queue entry: drop, reschedule or issue. */
  async process(entry: QueueEntry): Promise<ProcessOutcome> {
    const store = receiptStore();
    const now = this.now();
    let graph: IntentGraph;
    try {
      graph = await getIntent(entry.intentId);
    } catch (error) {
      if (isPlatformError(error) && error.code === "INTENT_NOT_FOUND") {
        await store.dequeue(entry.intentId, entry.revision);
        return { kind: "dropped", reason: "not_found" };
      }
      throw error;
    }
    if (!isReceiptableStatus(graph.status)) {
      await store.dequeue(entry.intentId, entry.revision);
      return { kind: "dropped", reason: "not_receiptable" };
    }
    const stateDigest = intentStateDigest(graph);
    const latest = await store.latest(graph.id);
    if (latest?.stateDigest === stateDigest) {
      await store.dequeue(entry.intentId, entry.revision);
      return { kind: "dropped", reason: "unchanged" };
    }
    const signer = activeReceiptSigner();
    if (!signer) return this.reschedule(entry, "signer_missing", now + SIGNER_MISSING_RETRY_MS, null, "no receipt signing key is configured");

    let collection: ReceiptCollection;
    try {
      collection = await this.collect(graph);
    } catch (error) {
      collection = { state: "retry", anchors: {}, landedBindings: {}, finalityHeads: [], finalityMode: [], expectedBy: null, detail: error instanceof Error ? error.message : "collection failed" };
    }
    const waited = now - Date.parse(entry.createdAt);
    if (collection.state === "waiting_finality" || collection.state === "retry") {
      if (Number.isFinite(waited) && waited > finalityBudgetMs()) {
        console.error(`[platform] receipt finality_timeout for ${graph.id} after ${Math.round(waited / 1000)} s: ${collection.detail ?? collection.state}`);
        return this.reschedule(entry, "finality_timeout", now + 60 * 60_000, collection.expectedBy, collection.detail ?? null);
      }
    }
    if (collection.state === "waiting_finality") {
      const expected = collection.expectedBy ? Date.parse(collection.expectedBy) : Number.NaN;
      const target = Number.isFinite(expected) ? expected + 5_000 : now + MIN_WAIT_STEP_MS;
      const notBefore = Math.min(Math.max(target, now + MIN_WAIT_STEP_MS), now + MAX_WAIT_STEP_MS);
      return this.reschedule(entry, "awaiting_finality", notBefore, collection.expectedBy, collection.detail ?? null);
    }
    if (collection.state === "retry") {
      const backoff = Math.min(MIN_WAIT_STEP_MS * 2 ** Math.max(0, entry.attempts - 1), MAX_BACKOFF_MS);
      return this.reschedule(entry, "rpc_unavailable", now + backoff, null, collection.detail ?? null);
    }
    if (collection.state === "reorged") {
      console.error(`[platform] receipt anchor_reorged for ${graph.id}: ${collection.detail ?? "an anchor's block changed"}`);
      refreshIntent(graph.id).catch((error: unknown) => console.warn("[platform] refresh after a reorg failed:", error instanceof Error ? error.message : error));
      return this.reschedule(entry, "anchor_reorged", now + REORG_RETRY_MS, null, collection.detail ?? null);
    }

    // Ready: build, sign, self-verify, store.
    const receiptId = `rcpt_${randomHex(16)}`;
    const issuedAt = new Date(now).toISOString();
    const sequence = (latest?.sequence ?? 0) + 1;
    const built = buildReceipt({
      graph,
      collection,
      receiptId,
      sequence,
      supersedes: latest?.digest ?? null,
      issuedAt,
      issuer: { name: "Kletia", origin: receiptIssuerOrigin(), apiVersion: PLATFORM_API_VERSION, kid: signer.kid },
      salts: () => randomReceiptSalt(),
    });
    const digest = await receiptDigest(built.payload);
    const value = base64Url(await signer.sign(new TextEncoder().encode(receiptSigningInput(digest))));
    const document = { payload: built.payload, digest, signature: { alg: "Ed25519" as const, kid: signer.kid, value }, disclosures: built.disclosures };
    const check = await verifyReceipt(document, { keys: receiptKeys(), intentId: graph.id, requireGroups: receiptGroupSlots(built.payload), now });
    if (!check.valid || check.problems.length > 0) {
      console.error(`[platform] receipt self-verification failed for ${graph.id}: ${check.problems.map((problem) => problem.code).join(", ")}; nothing was issued.`);
      return this.reschedule(entry, "issuer_error", now + ISSUER_ERROR_RETRY_MS, null, "self-verification failed");
    }

    let eas: EasEnvelope | null = null;
    const attester = easAttester();
    if (attester) {
      try {
        const envelope = await attestReceipt(attester, { digest, spec: built.payload.spec, sequence, issuedAt, refUID: latest?.attestations?.eas?.sig.uid ?? null });
        if (await verifyEasEnvelope(envelope, digest)) eas = envelope;
        else console.error(`[platform] EAS envelope for ${receiptId} did not verify; issued without it.`);
      } catch (error) {
        console.warn(`[platform] EAS envelope for ${receiptId} failed:`, error instanceof Error ? error.message : error);
      }
    }

    const withdrawnAt = latest?.disclosuresWithdrawnAt ?? null;
    const owner = entry.ownerKeyId ?? (await resolveIntentOwner(graph.id)) ?? null;
    const receipt: StoredReceipt = {
      id: receiptId,
      intentId: graph.id,
      ownerKeyId: owner,
      sequence,
      intentStatus: built.payload.intent.status,
      stateDigest,
      digest,
      kid: signer.kid,
      payload: built.payload,
      signature: value,
      // A withdrawal covers later receipts of the intent too: their disclosures are never stored.
      disclosures: withdrawnAt ? null : built.disclosures,
      disclosuresWithdrawnAt: withdrawnAt,
      attestations: eas ? { eas } : null,
      supersedes: latest?.digest ?? null,
      supersededBy: null,
      batchSeq: null,
      leafIndex: null,
      inclusionPath: null,
      issuedAt,
    };
    const result = await store.issue(receipt, latest?.id ?? null, entry.revision);
    if (result === "duplicate") return { kind: "dropped", reason: "unchanged" };
    if (result === "stale") {
      // Another issuer stored a receipt meanwhile: release the lease so the next pass rebuilds on top of it.
      await store.reschedule(entry.intentId, { notBefore: issuedAt, pendingReason: entry.pendingReason });
      return { kind: "stale" };
    }
    publishReceiptEvent({
      intentId: graph.id,
      receiptId,
      sequence,
      status: built.payload.intent.status,
      terminal: built.payload.intent.terminal,
      digest,
      kid: signer.kid,
      supersedes: receipt.supersedes,
    });
    return { kind: "issued", receipt };
  }
}

let running: { readonly issuer: ReceiptIssuer; readonly stop: () => void } | null = null;

/** Starts the process-wide issuer (idempotent; not when the kill switch is on). Returns a stop function. */
export function startReceiptIssuer(options: ReceiptIssuerOptions = {}): () => void {
  if (!receiptsEnabled()) {
    console.info("[platform] receipts are disabled (KLETIA_RECEIPTS_ENABLED=false); nothing is issued.");
    return () => undefined;
  }
  if (!running) {
    const issuer = new ReceiptIssuer(options);
    running = { issuer, stop: issuer.start() };
  }
  const current = running;
  return () => {
    current.stop();
    if (running === current) running = null;
  };
}

/** The running issuer (tests, operators). */
export function receiptIssuer(): ReceiptIssuer | null {
  return running?.issuer ?? null;
}
