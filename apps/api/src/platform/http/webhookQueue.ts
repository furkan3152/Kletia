/**
 * Durable delivery queue, enabled only with Postgres. Bodies are sealed under
 * the platform key; signing secrets and URLs are always read from the current
 * registration. A completed row retains only its deduplication identifiers.
 *
 * The short queue advisory lock serialises capacity checks and lease claims
 * across replicas, not network I/O. Fenced leases recover interrupted work;
 * a receiver must deduplicate by event id because a crash after HTTP success
 * but before the acknowledgement can cause the same event to be sent again.
 * This queue starts at webhook routing, not at the source graph transaction.
 */
import type pg from "pg";
import { dbQuery, dbTransaction } from "./db.js";
import { DELIVERIES_SCHEMA, newDeliveryId, type DeliveryRecord } from "./deliveries.js";
import { openSecret, randomHex, sealSecret } from "./secrets.js";

export const WEBHOOK_QUEUE_LEASE_MS = 30_000;
export const WEBHOOK_QUEUE_POLL_MS = 500;
const LOCK = "kletia_webhook_queue";
const SCHEMA = {
  name: "kletia_webhook_queue",
  ddl: `
SELECT pg_advisory_xact_lock(hashtextextended('kletia_schema:webhook_queue', 0));
CREATE TABLE IF NOT EXISTS kletia_webhook_queue (
  id text PRIMARY KEY,
  webhook_id text NOT NULL,
  owner_key_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  intent_id text,
  body_ciphertext text,
  attempt integer NOT NULL DEFAULT 1,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  leased_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_due_idx ON kletia_webhook_queue (due_at, created_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_owner_idx ON kletia_webhook_queue (owner_key_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_completed_idx ON kletia_webhook_queue (completed_at) WHERE completed_at IS NOT NULL;`,
} as const;

export interface QueuedWebhook {
  readonly id: string;
  readonly webhookId: string;
  readonly ownerKeyId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly intentId?: string;
  readonly body: string;
  readonly attempt: number;
  readonly leaseToken: string;
}

export interface WebhookQueueLimits {
  readonly queued: number;
  readonly perOwner: number;
  readonly concurrency: number;
  readonly perOwnerConcurrency: number;
}

interface Row extends pg.QueryResultRow {
  id: string;
  webhook_id: string;
  owner_key_id: string;
  event_id: string;
  event_type: string;
  intent_id: string | null;
  body_ciphertext: string;
  attempt: number;
  lease_token: string;
}

function bodyContext(input: Pick<QueuedWebhook, "id" | "ownerKeyId" | "webhookId" | "eventId" | "eventType" | "intentId">): string {
  // Bind the encrypted body to its routing scope as well as its row id.
  return JSON.stringify(["kletia.webhook-queue.v1", input.id, input.ownerKeyId, input.webhookId, input.eventId, input.eventType, input.intentId ?? null]);
}

async function lock(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [LOCK]);
}

async function record(client: pg.PoolClient, value: DeliveryRecord): Promise<void> {
  await client.query(
    `INSERT INTO kletia_webhook_deliveries
       (id, webhook_id, owner_key_id, event_id, event_type, intent_id, attempt, status, http_status, duration_ms, error, next_retry_at, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
    [value.id, value.webhookId, value.ownerKeyId, value.eventId, value.eventType, value.intentId ?? null,
      value.attempt, value.status, value.httpStatus ?? null, value.durationMs ?? null, value.error ?? null,
      value.nextRetryAt ?? null, value.at],
  );
}

/** One persistent store may be used by any number of dispatchers. */
export class PostgresWebhookQueue {
  private logsReady: Promise<unknown> | null = null;
  constructor(private readonly limits: WebhookQueueLimits) {}

  private async initializeLog(): Promise<void> {
    // Use the delivery store's own schema key: two independent lazy DDL
    // promises must never race to create the same Postgres table on startup.
    this.logsReady ??= dbQuery(DELIVERIES_SCHEMA, "SELECT 1", []).catch((error: unknown) => {
      this.logsReady = null;
      throw error;
    });
    await this.logsReady;
  }

  async enqueue(input: Omit<QueuedWebhook, "id" | "attempt" | "leaseToken">): Promise<boolean> {
    await this.initializeLog();
    const id = `whq_${randomHex(12)}`;
    const ciphertext = sealSecret(input.body, bodyContext({ ...input, id }));
    return dbTransaction(SCHEMA, async (client) => {
      await lock(client);
      const inserted = await client.query(
        `INSERT INTO kletia_webhook_queue (id,webhook_id,owner_key_id,event_id,event_type,intent_id,body_ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (webhook_id,event_id) DO NOTHING`,
        [id, input.webhookId, input.ownerKeyId, input.eventId, input.eventType, input.intentId ?? null, ciphertext],
      );
      if (inserted.rowCount !== 1) return false;
      // Evict this owner's oldest waiting work first. In-flight work keeps its
      // lease; an event flood can never replace another owner's active request.
      await this.evict(client, input.ownerKeyId, this.limits.perOwner);
      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM kletia_webhook_queue WHERE completed_at IS NULL AND (leased_until IS NULL OR leased_until <= now())",
      );
      // Expired leases can add a few recovered rows to the waiting backlog.
      // Enforce the full bound, rather than assuming one insert added only one.
      for (let excess = Number(count.rows[0]?.count ?? 0) - this.limits.queued; excess > 0; excess -= 1) {
        const owner = await client.query<{ owner_key_id: string }>(
          `SELECT owner_key_id FROM kletia_webhook_queue WHERE completed_at IS NULL
           AND (leased_until IS NULL OR leased_until <= now())
           GROUP BY owner_key_id ORDER BY count(*) DESC, owner_key_id LIMIT 1`,
        );
        if (!owner.rows[0]) break;
        await this.evict(client, owner.rows[0].owner_key_id, 0, 1);
      }
      return true;
    });
  }

  private async evict(client: pg.PoolClient, owner: string, keep: number, maximum?: number): Promise<void> {
    const evicted = await client.query<Row>(
      `UPDATE kletia_webhook_queue SET completed_at=now(), body_ciphertext=NULL, lease_token=NULL, leased_until=NULL
       WHERE id IN (SELECT id FROM kletia_webhook_queue WHERE owner_key_id=$1 AND completed_at IS NULL
         AND (leased_until IS NULL OR leased_until <= now()) ORDER BY created_at ${maximum ? "ASC" : "DESC"},id ${maximum ? "ASC" : "DESC"} OFFSET $2 LIMIT $3)
       RETURNING *`,
      [owner, keep, maximum ?? this.limits.perOwner + 1],
    );
    for (const row of evicted.rows) await record(client, {
      id: newDeliveryId(), webhookId: row.webhook_id, ownerKeyId: row.owner_key_id,
      eventId: row.event_id, eventType: row.event_type, ...(row.intent_id ? { intentId: row.intent_id } : {}),
      attempt: row.attempt, status: "dropped", error: "queue_full", at: new Date().toISOString(),
    });
  }

  async claim(limit: number, blockedWebhooks: readonly string[] = []): Promise<QueuedWebhook[]> {
    // Only a bounded batch leaves storage; clients cannot claim an unbounded
    // backlog even when a new worker takes over after downtime.
    const rows = await dbTransaction(SCHEMA, async (client) => {
      await lock(client);
      const claimed: Row[] = [];
      const maximum = Math.min(Math.max(0, Math.floor(limit)), this.limits.concurrency);
      for (let index = 0; index < maximum; index += 1) {
        const token = randomHex(16);
        const result = await client.query<Row>(
          `UPDATE kletia_webhook_queue q SET lease_token=$1, leased_until=now()+($2*interval '1 millisecond')
           WHERE q.id=(SELECT candidate.id FROM kletia_webhook_queue candidate
             WHERE candidate.completed_at IS NULL AND candidate.due_at <= now()
               AND (candidate.leased_until IS NULL OR candidate.leased_until <= now())
               AND NOT (candidate.webhook_id = ANY($3::text[]))
               AND NOT EXISTS (SELECT 1 FROM kletia_webhook_queue busy WHERE busy.completed_at IS NULL
                 AND busy.webhook_id=candidate.webhook_id AND busy.leased_until > now())
               AND (SELECT count(*) FROM kletia_webhook_queue active WHERE active.completed_at IS NULL
                 AND active.owner_key_id=candidate.owner_key_id AND active.leased_until > now()) < $4
               AND (SELECT count(*) FROM kletia_webhook_queue active WHERE active.completed_at IS NULL
                 AND active.leased_until > now()) < $5
             ORDER BY candidate.due_at,candidate.created_at,candidate.id LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING q.*`,
          [token, WEBHOOK_QUEUE_LEASE_MS, [...blockedWebhooks], this.limits.perOwnerConcurrency, this.limits.concurrency],
        );
        if (!result.rows[0]) break;
        claimed.push(result.rows[0]);
      }
      return claimed;
    });
    return rows.map((row) => {
      const routing = { id: row.id, webhookId: row.webhook_id, ownerKeyId: row.owner_key_id, eventId: row.event_id,
        eventType: row.event_type, ...(row.intent_id ? { intentId: row.intent_id } : {}) };
      return { ...routing, body: openSecret(row.body_ciphertext, bodyContext(routing)), attempt: row.attempt, leaseToken: row.lease_token };
    });
  }

  /** A stale worker cannot acknowledge or reschedule a newer worker's lease. */
  async finish(job: QueuedWebhook, outcome: DeliveryRecord, retryAt?: string): Promise<boolean> {
    await this.initializeLog();
    return dbTransaction(SCHEMA, async (client) => {
      const result = await client.query(
        `UPDATE kletia_webhook_queue SET due_at=COALESCE($3::timestamptz,due_at),
           attempt=attempt+CASE WHEN $3::timestamptz IS NULL THEN 0 ELSE 1 END,
           completed_at=CASE WHEN $3::timestamptz IS NULL THEN now() ELSE NULL END,
           body_ciphertext=CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE body_ciphertext END,
           lease_token=NULL,leased_until=NULL WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL`,
        [job.id, job.leaseToken, retryAt ?? null],
      );
      if (result.rowCount !== 1) return false;
      await record(client, outcome);
      return true;
    });
  }

  /** Storage/signing failures don't consume an endpoint attempt. */
  async release(job: QueuedWebhook, delayMs = 1_000): Promise<void> {
    await dbQuery(SCHEMA,
      `UPDATE kletia_webhook_queue SET due_at=now()+($3*interval '1 millisecond'),lease_token=NULL,leased_until=NULL
       WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL`, [job.id, job.leaseToken, delayMs]);
  }

  async waiting(): Promise<{ queued: number; retries: number }> {
    const result = await dbQuery<{ queued: string; retries: string }>(SCHEMA,
      `SELECT count(*) AS queued,count(*) FILTER (WHERE attempt > 1) AS retries FROM kletia_webhook_queue
       WHERE completed_at IS NULL AND (leased_until IS NULL OR leased_until <= now())`, []);
    return { queued: Number(result.rows[0]?.queued ?? 0), retries: Number(result.rows[0]?.retries ?? 0) };
  }

  async cancelWebhook(webhookId: string): Promise<void> {
    await cancelQueuedWebhook(webhookId);
  }

  async prune(now: number): Promise<void> {
    await pruneWebhookQueue(now);
  }
}

export async function cancelQueuedWebhook(webhookId: string): Promise<void> {
  await dbQuery(SCHEMA,
    "UPDATE kletia_webhook_queue SET completed_at=now(),body_ciphertext=NULL,lease_token=NULL,leased_until=NULL WHERE webhook_id=$1 AND completed_at IS NULL",
    [webhookId]);
}

export async function pruneWebhookQueue(now: number): Promise<void> {
  await dbQuery(SCHEMA, "DELETE FROM kletia_webhook_queue WHERE completed_at < $1", [new Date(now - 7 * 86_400_000).toISOString()]);
}
