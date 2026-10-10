/**
 * Per-webhook delivery log (GET /v1/webhooks/{id}/deliveries) and test
 * deliveries (POST /v1/webhooks/{id}/test).
 *
 * Every delivery attempt the dispatcher makes, every delivery it drops and
 * every test delivery is recorded: event id and type, attempt, outcome, HTTP
 * status, duration and a coarse error class. Payloads and error text are
 * never stored (error text can name internal addresses).
 *
 * Recording is fire-and-forget through a bounded queue, so it never delays
 * or blocks delivery. Storage: memory (last 100 per webhook) or Postgres
 * `kletia_webhook_deliveries` (pruned to 7 days and 1000 rows per webhook).
 */
import { performance } from "node:perf_hooks";
import { signWebhookPayload } from "@kletia/core";
import { buildEvent } from "../index.js";
import { HttpError } from "./context.js";
import { dbQuery, platformDatabaseUrl } from "./db.js";
import { randomHex } from "./secrets.js";
import { assertWebhooksAvailable, webhookSecret, webhooksForOwner, type WebhookRecord } from "./webhooks.js";

export type DeliveryStatus = "succeeded" | "failed" | "dropped";
/** Coarse failure class; `paused` is reserved for deliveries skipped while a webhook is paused. */
export type DeliveryError = "timeout" | "connection_failed" | "http_status" | "redirect" | "forbidden_address" | "queue_full" | "paused";

export const DELIVERY_ERRORS: readonly DeliveryError[] = Object.freeze([
  "timeout",
  "connection_failed",
  "http_status",
  "redirect",
  "forbidden_address",
  "queue_full",
  "paused",
]);

export interface WebhookDelivery {
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly intentId?: string;
  readonly attempt: number;
  readonly status: DeliveryStatus;
  readonly httpStatus?: number;
  readonly durationMs?: number;
  readonly error?: DeliveryError;
  /** When the dispatcher retries a failed attempt. */
  readonly nextRetryAt?: string;
  /** True for POST /v1/webhooks/{id}/test deliveries. */
  readonly test?: boolean;
  readonly at: string;
}

/** A delivery to record; `ownerKeyId` scopes it and is never returned. */
export interface DeliveryRecord extends WebhookDelivery {
  readonly ownerKeyId: string;
}

export const MEMORY_DELIVERIES_PER_WEBHOOK = 100;
export const DELIVERY_RETENTION_DAYS = 7;
export const MAX_DELIVERIES_PER_WEBHOOK = 1_000;
export const TEST_DELIVERIES_PER_MINUTE = 5;

export function newDeliveryId(): string {
  return `whd_${randomHex(12)}`;
}

/** Classifies a transport failure without keeping its text. */
export function classifyDeliveryError(error: unknown): DeliveryError {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "EWEBHOOKFORBIDDEN" || /not a public|non-public/iu.test(message)) return "forbidden_address";
  if (code === "ETIMEDOUT" || /timed out|timeout/iu.test(message)) return "timeout";
  return "connection_failed";
}

/** Outcome of an HTTP status: 2xx succeeded, 3xx a redirect (never followed), anything else an HTTP failure. */
export function classifyStatus(status: number): { readonly status: DeliveryStatus; readonly error?: DeliveryError } {
  if (status >= 200 && status < 300) return { status: "succeeded" };
  if (status >= 300 && status < 400) return { status: "failed", error: "redirect" };
  return { status: "failed", error: "http_status" };
}

/* ----------------------------------------------------------------- store */

export interface DeliveryStore {
  readonly kind: "memory" | "postgres";
  insert(records: readonly DeliveryRecord[]): Promise<void>;
  list(ownerKeyId: string, webhookId: string, limit: number): Promise<WebhookDelivery[]>;
  deleteForWebhook(webhookId: string): Promise<void>;
  prune(now: number): Promise<void>;
}

function publicView(record: DeliveryRecord): WebhookDelivery {
  const { ownerKeyId: _owner, ...delivery } = record;
  return delivery;
}

export class MemoryDeliveryStore implements DeliveryStore {
  readonly kind = "memory" as const;
  private readonly byWebhook = new Map<string, DeliveryRecord[]>();

  constructor(
    private readonly perWebhook = MEMORY_DELIVERIES_PER_WEBHOOK,
    private readonly maxWebhooks = 10_000,
  ) {}

  async insert(records: readonly DeliveryRecord[]): Promise<void> {
    for (const record of records) {
      const ring = this.byWebhook.get(record.webhookId) ?? [];
      this.byWebhook.delete(record.webhookId);
      ring.push(record);
      if (ring.length > this.perWebhook) ring.splice(0, ring.length - this.perWebhook);
      this.byWebhook.set(record.webhookId, ring);
    }
    while (this.byWebhook.size > this.maxWebhooks) {
      const oldest = this.byWebhook.keys().next().value;
      if (oldest === undefined) break;
      this.byWebhook.delete(oldest);
    }
  }

  async list(ownerKeyId: string, webhookId: string, limit: number): Promise<WebhookDelivery[]> {
    return (this.byWebhook.get(webhookId) ?? [])
      .filter((record) => record.ownerKeyId === ownerKeyId)
      .slice(-limit)
      .reverse()
      .map(publicView);
  }

  async deleteForWebhook(webhookId: string): Promise<void> {
    this.byWebhook.delete(webhookId);
  }

  async prune(now: number): Promise<void> {
    const cutoff = new Date(now - DELIVERY_RETENTION_DAYS * 86_400_000).toISOString();
    for (const [webhookId, ring] of this.byWebhook) {
      const kept = ring.filter((record) => record.at >= cutoff);
      if (kept.length === 0) this.byWebhook.delete(webhookId);
      else if (kept.length !== ring.length) this.byWebhook.set(webhookId, kept);
    }
  }
}

export const DELIVERIES_SCHEMA = {
  name: "kletia_webhook_deliveries",
  ddl: `
SELECT pg_advisory_xact_lock(hashtextextended('kletia_schema:webhook_deliveries', 0));
CREATE TABLE IF NOT EXISTS kletia_webhook_deliveries (
  id text PRIMARY KEY,
  webhook_id text NOT NULL,
  owner_key_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  intent_id text,
  attempt integer NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'dropped')),
  http_status integer,
  duration_ms integer,
  error text,
  next_retry_at timestamptz,
  test boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_webhook_deliveries_webhook_idx ON kletia_webhook_deliveries (webhook_id, at DESC);
CREATE INDEX IF NOT EXISTS kletia_webhook_deliveries_at_idx ON kletia_webhook_deliveries (at);`,
} as const;

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  intent_id: string | null;
  attempt: number;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  error: string | null;
  next_retry_at: Date | string | null;
  test: boolean;
  at: Date | string;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function fromRow(row: DeliveryRow): WebhookDelivery {
  const status: DeliveryStatus = row.status === "succeeded" || row.status === "dropped" ? row.status : "failed";
  const error = DELIVERY_ERRORS.includes(row.error as DeliveryError) ? (row.error as DeliveryError) : undefined;
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    attempt: row.attempt,
    status,
    ...(row.http_status !== null ? { httpStatus: row.http_status } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(error ? { error } : {}),
    ...(row.next_retry_at ? { nextRetryAt: iso(row.next_retry_at) } : {}),
    ...(row.test ? { test: true } : {}),
    at: iso(row.at),
  };
}

export class PostgresDeliveryStore implements DeliveryStore {
  readonly kind = "postgres" as const;

  async insert(records: readonly DeliveryRecord[]): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    const rows = records.map((record, index) => {
      values.push(
        record.id,
        record.webhookId,
        record.ownerKeyId,
        record.eventId,
        record.eventType,
        record.intentId ?? null,
        record.attempt,
        record.status,
        record.httpStatus ?? null,
        record.durationMs ?? null,
        record.error ?? null,
        record.nextRetryAt ?? null,
        record.test === true,
        record.at,
      );
      const base = index * 14;
      return `(${Array.from({ length: 14 }, (_, offset) => `$${base + offset + 1}`).join(", ")})`;
    });
    await dbQuery(
      DELIVERIES_SCHEMA,
      `INSERT INTO kletia_webhook_deliveries
         (id, webhook_id, owner_key_id, event_id, event_type, intent_id, attempt, status, http_status, duration_ms, error, next_retry_at, test, at)
       VALUES ${rows.join(", ")} ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }

  async list(ownerKeyId: string, webhookId: string, limit: number): Promise<WebhookDelivery[]> {
    const result = await dbQuery<DeliveryRow>(
      DELIVERIES_SCHEMA,
      `SELECT id, webhook_id, event_id, event_type, intent_id, attempt, status, http_status, duration_ms, error, next_retry_at, test, at
       FROM kletia_webhook_deliveries WHERE webhook_id = $1 AND owner_key_id = $2 ORDER BY at DESC, id DESC LIMIT $3`,
      [webhookId, ownerKeyId, limit],
    );
    return result.rows.map(fromRow);
  }

  async deleteForWebhook(webhookId: string): Promise<void> {
    await dbQuery(DELIVERIES_SCHEMA, "DELETE FROM kletia_webhook_deliveries WHERE webhook_id = $1", [webhookId]);
    await (await import("./webhookQueue.js")).cancelQueuedWebhook(webhookId);
  }

  async prune(now: number): Promise<void> {
    await (await import("./webhookQueue.js")).pruneWebhookQueue(now);
    await dbQuery(DELIVERIES_SCHEMA, "DELETE FROM kletia_webhook_deliveries WHERE at < $1", [
      new Date(now - DELIVERY_RETENTION_DAYS * 86_400_000).toISOString(),
    ]);
    await dbQuery(
      DELIVERIES_SCHEMA,
      `DELETE FROM kletia_webhook_deliveries WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (PARTITION BY webhook_id ORDER BY at DESC, id DESC) AS position FROM kletia_webhook_deliveries
         ) AS ranked WHERE ranked.position > $1
       )`,
      [MAX_DELIVERIES_PER_WEBHOOK],
    );
  }
}

let store: DeliveryStore | null = null;

export function deliveryStore(): DeliveryStore {
  store ??= platformDatabaseUrl() ? new PostgresDeliveryStore() : new MemoryDeliveryStore();
  return store;
}

/* -------------------------------------------------------------- recorder */

const MAX_PENDING = 1_000;
const FLUSH_BATCH = 100;
const pending: DeliveryRecord[] = [];
let flushing: Promise<void> | null = null;
let droppedRecords = 0;

async function drain(): Promise<void> {
  // Bounded rounds; records still queued afterwards start another drain.
  for (let round = 0; round < 20 && pending.length > 0; round += 1) {
    const batch = pending.splice(0, FLUSH_BATCH);
    try {
      await deliveryStore().insert(batch);
    } catch (error) {
      droppedRecords += batch.length;
      console.warn(`[platform] webhook delivery log write failed (${droppedRecords} records lost since start):`, error instanceof Error ? error.message : error);
    }
  }
}

function startDrain(): void {
  flushing ??= Promise.resolve()
    .then(drain)
    .finally(() => {
      flushing = null;
      if (pending.length > 0) startDrain();
    });
}

/**
 * Queues a delivery for the log. Never throws and never waits: when the
 * queue is full the oldest record is discarded.
 */
export function recordDelivery(record: DeliveryRecord): void {
  pending.push(record);
  if (pending.length > MAX_PENDING) {
    pending.splice(0, pending.length - MAX_PENDING);
    droppedRecords += 1;
  }
  startDrain();
}

/** Waits (at most `timeoutMs`) for queued records to be written, so a log read sees the latest attempts. */
export async function flushDeliveryLog(timeoutMs = 2_000): Promise<void> {
  const current = flushing;
  if (!current) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([current, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  if (timer) clearTimeout(timer);
}

/** Hourly pruning of the delivery log (long-running hosts). Returns a stop function. */
export function startDeliveryPruner(intervalMs = 60 * 60_000): () => void {
  const timer = setInterval(() => {
    deliveryStore()
      .prune(Date.now())
      .catch((error: unknown) => {
        console.warn("[platform] webhook delivery prune failed:", error instanceof Error ? error.message : error);
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------- service */

async function ownedWebhook(ownerKeyId: string, webhookId: string): Promise<WebhookRecord> {
  assertWebhooksAvailable();
  const hook = (await webhooksForOwner(ownerKeyId, { fresh: true })).find((entry) => entry.id === webhookId);
  if (!hook) throw new HttpError(404, "WEBHOOK_NOT_FOUND", "Webhook not found.");
  return hook;
}

export async function listDeliveries(ownerKeyId: string, webhookId: string, limit: number): Promise<WebhookDelivery[]> {
  await ownedWebhook(ownerKeyId, webhookId);
  await flushDeliveryLog();
  return deliveryStore().list(ownerKeyId, webhookId, limit);
}

/* Test deliveries: per webhook, fixed 1-minute windows (process-local). */
const testWindows = new Map<string, { count: number; readonly start: number }>();

function takeTestSlot(webhookId: string, now: number): void {
  let window = testWindows.get(webhookId);
  if (!window || now - window.start >= 60_000) {
    window = { count: 0, start: now };
    testWindows.delete(webhookId);
    testWindows.set(webhookId, window);
    while (testWindows.size > 10_000) {
      const oldest = testWindows.keys().next().value;
      if (oldest === undefined) break;
      testWindows.delete(oldest);
    }
  }
  if (window.count >= TEST_DELIVERIES_PER_MINUTE) {
    const seconds = Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000));
    throw new HttpError(429, "RATE_LIMITED", `At most ${TEST_DELIVERIES_PER_MINUTE} test deliveries per minute per webhook. Retry in ${seconds}s.`, {
      headers: { "Retry-After": String(seconds) },
    });
  }
  window.count += 1;
}

/** Posts one signed body; resolves with the HTTP status code (dispatcher.ts). */
export type DeliveryTransport = (url: URL, body: string, headers: Readonly<Record<string, string>>) => Promise<number>;

/**
 * Sends one signed `webhook.test` event synchronously through the delivery
 * transport (same network guard, timeout and no-redirect rules as real
 * deliveries) and records it. Never counts towards pausing the webhook.
 */
export async function sendTestDelivery(ownerKeyId: string, webhookId: string, transport: DeliveryTransport, userAgent: string): Promise<WebhookDelivery> {
  const hook = await ownedWebhook(ownerKeyId, webhookId);
  takeTestSlot(webhookId, Date.now());
  const event = buildEvent("webhook.test", { webhookId });
  const body = JSON.stringify(event);
  const signature = await signWebhookPayload(webhookSecret(hook), body);
  const started = performance.now();
  let outcome: { status: DeliveryStatus; error?: DeliveryError; httpStatus?: number };
  try {
    const status = await transport(new URL(hook.url), body, {
      "content-type": "application/json",
      "user-agent": userAgent,
      "kletia-signature": signature,
      "kletia-event-id": event.id,
      "kletia-event-type": event.type,
      "kletia-webhook-id": webhookId,
      "kletia-delivery-attempt": "1",
    });
    outcome = { ...classifyStatus(status), httpStatus: status };
  } catch (error) {
    outcome = { status: "failed", error: classifyDeliveryError(error) };
  }
  const delivery: DeliveryRecord = {
    id: newDeliveryId(),
    webhookId,
    ownerKeyId,
    eventId: event.id,
    eventType: event.type,
    attempt: 1,
    status: outcome.status,
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    durationMs: Math.round(performance.now() - started),
    ...(outcome.error ? { error: outcome.error } : {}),
    test: true,
    at: new Date().toISOString(),
  };
  recordDelivery(delivery);
  return publicView(delivery);
}
