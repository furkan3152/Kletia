/**
 * Receipts block of GET /v1/health (receipts design §11): signer state, queue
 * depth and age, and the last log batch. Never throws (storage trouble reads
 * as nulls).
 */
import { receiptSignerStatus, type ReceiptSignerStatus } from "./signer.js";
import { receiptStore } from "./store.js";

export interface ReceiptHealth {
  readonly signer: ReceiptSignerStatus;
  readonly store: "memory" | "postgres" | "unavailable";
  /** Intents waiting for a receipt (finality, retries, a missing key); null when unreadable. */
  readonly queue: number | null;
  readonly oldestPendingSeconds: number | null;
  readonly lastBatch: { readonly seq: number; readonly anchored: boolean } | null;
}

export async function receiptHealth(now = Date.now()): Promise<ReceiptHealth> {
  const signer = receiptSignerStatus();
  let kind: ReceiptHealth["store"] = "unavailable";
  try {
    kind = receiptStore().kind;
  } catch {
    kind = "unavailable";
  }
  const [stats, batches] = await Promise.all([
    receiptStore().queueStats(new Date(now).toISOString()).catch(() => null),
    receiptStore().batches({ limit: 1 }).catch(() => null),
  ]);
  const last = batches?.[0];
  return {
    signer,
    store: stats === null && batches === null ? "unavailable" : kind,
    queue: stats?.size ?? null,
    oldestPendingSeconds: stats?.oldestPendingSeconds ?? null,
    lastBatch: last ? { seq: last.seq, anchored: last.anchor !== null } : null,
  };
}
