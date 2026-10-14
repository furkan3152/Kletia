/**
 * Durable webhook delivery queue, used whenever Postgres is configured.
 *
 * Bodies are sealed under the platform key and bound to their routing scope;
 * signing secrets and URLs are always read from the current registration.
 * A completed row keeps only its deduplication identifiers (for 7 days).
 *
 * A short advisory lock serialises capacity checks and lease claims across
 * replicas, never network I/O. Fenced leases recover interrupted work; a
 * receiver must deduplicate by event id because a crash after HTTP success
 * but before the acknowledgement sends the same event again. The queue starts
 * at webhook routing, not at the source transaction.
 *
 * Poison and stuck rows never wedge the queue:
 * - a row whose body no longer opens (KLETIA_PLATFORM_SECRET changed, or its
 *   routing columns were altered) is completed inside the claim that found
 *   it and logged as dropped `payload_unreadable`; it never holds a lease and
 *   the claim continues with the next row;
 * - a delivery that cannot be attempted (key, webhook or intent storage
 *   failing) is deferred without spending an endpoint attempt, 1 s doubling
 *   to 60 s, and an interrupted claim (expired lease) counts as a deferral;
 *   after 120 deferrals (about two hours) the row is dropped as
 *   `deferred_too_long` with its attempt count unchanged.
 */
import type pg from "pg";
import { dbQuery, dbTransaction } from "./db.js";
import { DELIVERIES_SCHEMA, newDeliveryId, type DeliveryError, type DeliveryRecord } from "./deliveries.js";
import { openSecret, randomHex, sealingAvailable, sealSecret } from "./secrets.js";

export const WEBHOOK_QUEUE_LEASE_MS = 30_000;
/** Poll interval while there is work; idle polls back off to WEBHOOK_QUEUE_IDLE_POLL_MS. */
export const WEBHOOK_QUEUE_POLL_MS = 500;
export const WEBHOOK_QUEUE_IDLE_POLL_MS = 5_000;
/** Deferrals (deliveries that could not be attempted) after which a delivery is dropped as `deferred_too_long`. */
export const WEBHOOK_MAX_DEFERRALS = 120;
/** Unreadable rows one claim may complete besides the rows it hands out; later polls continue. */
const UNREADABLE_PER_CLAIM = 50;
const COMPLETED_RETENTION_MS = 7 * 86_400_000;
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
ALTER TABLE kletia_webhook_queue ADD COLUMN IF NOT EXISTS deferrals integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_due_idx ON kletia_webhook_queue (due_at, created_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_owner_idx ON kletia_webhook_queue (owner_key_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS kletia_webhook_queue_completed_idx ON kletia_webhook_queue (completed_at) WHERE completed_at IS NOT NULL;`,
} as const;

/**
 * Wait before the next try of a delivery deferred `deferrals` times before:
 * 1 s doubling to 60 s (`baseMs` scales it; tests shorten it).
 */
export function webhookDeferralDelayMs(deferrals: number, baseMs = 1_000): number {
  return baseMs * Math.min(60, 2 ** Math.min(Math.max(0, Math.floor(deferrals)), 6));
}

export interface QueuedWebhook {
  readonly id: string;
  readonly webhookId: string;
  readonly ownerKeyId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly intentId?: string;
  readonly body: string;
  readonly attempt: number;
  /** Times this delivery was handed back (or its claim interrupted) without an attempt outcome. */
  readonly deferrals: number;
  readonly leaseToken: string;
}

export interface WebhookQueueLimits {
  readonly queued: number;
  readonly perOwner: number;
  readonly concurrency: number;
  readonly perOwnerConcurrency: number;
}

/** Waiting (unleased, uncompleted) rows; `nextDueMs` is the wait until the earliest is due (0 when overdue, null when none). */
export interface WebhookQueueSnapshot {
  readonly queued: number;
  readonly retries: number;
  readonly nextDueMs: number | null;
}

/** What happened to a job handed back with `release`. */
export type WebhookReleaseOutcome = "released" | "dropped" | "lost";

interface Row extends pg.QueryResultRow {
  id: string;
  webhook_id: string;
  owner_key_id: string;
  event_id: string;
  event_type: string;
  intent_id: string | null;
  body_ciphertext: string | null;
  attempt: number;
  deferrals: number;
  lease_token: string;
}

type Routing = Pick<QueuedWebhook, "id" | "ownerKeyId" | "webhookId" | "eventId" | "eventType" | "intentId">;

function bodyContext(input: Routing): string {
  // Bind the encrypted body to its routing scope as well as its row id.
  return JSON.stringify(["kletia.webhook-queue.v1", input.id, input.ownerKeyId, input.webhookId, input.eventId, input.eventType, input.intentId ?? null]);
}

function routingOf(row: Row): Routing {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    ownerKeyId: row.owner_key_id,
    eventId: row.event_id,
    eventType: row.event_type,
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
  };
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

/** Completes a row without sending it (its body is discarded) and logs the drop. */
async function drop(client: pg.PoolClient, routing: Routing, attempt: number, error: DeliveryError, deferrals?: number): Promise<void> {
  await client.query(
    `UPDATE kletia_webhook_queue SET completed_at=now(),body_ciphertext=NULL,lease_token=NULL,leased_until=NULL,
       deferrals=COALESCE($2,deferrals) WHERE id=$1`,
    [routing.id, deferrals ?? null],
  );
  await record(client, {
    id: newDeliveryId(), webhookId: routing.webhookId, ownerKeyId: routing.ownerKeyId,
    eventId: routing.eventId, eventType: routing.eventType, ...(routing.intentId ? { intentId: routing.intentId } : {}),
    attempt, status: "dropped", error, at: new Date().toISOString(),
  });
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

  async enqueue(input: Omit<QueuedWebhook, "id" | "attempt" | "deferrals" | "leaseToken">): Promise<boolean> {
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
    for (const row of evicted.rows) {
      await record(client, {
        id: newDeliveryId(), webhookId: row.webhook_id, ownerKeyId: row.owner_key_id,
        eventId: row.event_id, eventType: row.event_type, ...(row.intent_id ? { intentId: row.intent_id } : {}),
        attempt: row.attempt, status: "dropped", error: "queue_full", at: new Date().toISOString(),
      });
    }
  }

  /**
   * Leases at most `limit` due rows (bounded by the shared caps) and opens
   * their bodies inside the same transaction. A row that does not open is
   * completed as `payload_unreadable` and never handed out or left leased; a
   * row reached after its claim expired is `deferred_too_long` once the
   * deferral bound is spent. Never throws for a single row.
   */
  async claim(limit: number, blockedWebhooks: readonly string[] = []): Promise<QueuedWebhook[]> {
    // Without the platform key nothing is opened, and nothing is discarded either.
    if (!sealingAvailable()) return [];
    await this.initializeLog();
    let unreadable = 0;
    const jobs = await dbTransaction(SCHEMA, async (client) => {
      await lock(client);
      const claimed: QueuedWebhook[] = [];
      // Only a bounded batch leaves storage; clients cannot claim an unbounded
      // backlog even when a new worker takes over after downtime.
      const maximum = Math.min(Math.max(0, Math.floor(limit)), this.limits.concurrency);
      for (let round = 0; claimed.length < maximum && round < maximum + UNREADABLE_PER_CLAIM; round += 1) {
        const token = randomHex(16);
        const result = await client.query<Row>(
          `UPDATE kletia_webhook_queue q SET lease_token=$1, leased_until=now()+($2*interval '1 millisecond'),
             deferrals=q.deferrals+CASE WHEN q.lease_token IS NULL THEN 0 ELSE 1 END
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
        const row = result.rows[0];
        if (!row) break;
        const routing = routingOf(row);
        let body: string;
        try {
          if (row.body_ciphertext === null) throw new Error("Queued body is missing.");
          body = openSecret(row.body_ciphertext, bodyContext(routing));
        } catch {
          // Fail closed: an unreadable body is never sent, and never holds a lease or a slot.
          unreadable += 1;
          await drop(client, routing, row.attempt, "payload_unreadable");
          continue;
        }
        if (row.deferrals >= WEBHOOK_MAX_DEFERRALS) {
          await drop(client, routing, row.attempt, "deferred_too_long");
          continue;
        }
        claimed.push({ ...routing, body, attempt: row.attempt, deferrals: row.deferrals, leaseToken: row.lease_token });
      }
      return claimed;
    });
    if (unreadable > 0) {
      console.warn(
        `[platform] dropped ${unreadable} queued webhook deliver${unreadable === 1 ? "y" : "ies"} whose payload no longer opens (did KLETIA_PLATFORM_SECRET change?).`,
      );
    }
    return jobs;
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

  /**
   * Hands a claimed job back without spending an endpoint attempt. A deferral
   * (storage or signing failed before sending) waits 1 s doubling to 60 s and
   * counts towards WEBHOOK_MAX_DEFERRALS; the last one drops the job as
   * `deferred_too_long`. A shutdown hand-back keeps the job's due time and
   * does not count.
   */
  async release(job: QueuedWebhook, reason: "deferred" | "shutdown" = "deferred"): Promise<WebhookReleaseOutcome> {
    if (reason === "shutdown") {
      const result = await dbQuery(SCHEMA,
        "UPDATE kletia_webhook_queue SET lease_token=NULL,leased_until=NULL WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL",
        [job.id, job.leaseToken]);
      return result.rowCount === 1 ? "released" : "lost";
    }
    await this.initializeLog();
    return dbTransaction(SCHEMA, async (client) => {
      const current = await client.query<{ deferrals: number }>(
        "SELECT deferrals FROM kletia_webhook_queue WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL FOR UPDATE",
        [job.id, job.leaseToken],
      );
      const row = current.rows[0];
      if (!row) return "lost";
      const deferrals = row.deferrals + 1;
      if (deferrals >= WEBHOOK_MAX_DEFERRALS) {
        await drop(client, job, job.attempt, "deferred_too_long", deferrals);
        return "dropped";
      }
      await client.query(
        `UPDATE kletia_webhook_queue SET deferrals=$2,due_at=now()+($3*interval '1 millisecond'),lease_token=NULL,leased_until=NULL
         WHERE id=$1`,
        [job.id, deferrals, webhookDeferralDelayMs(row.deferrals)],
      );
      return "released";
    });
  }

  /** The shared backlog: rows waiting for a worker (expired leases included). */
  async waiting(): Promise<WebhookQueueSnapshot> {
    const result = await dbQuery<{ queued: string; retries: string; next_due_ms: string | null }>(SCHEMA,
      `SELECT count(*) AS queued, count(*) FILTER (WHERE attempt > 1) AS retries,
         CASE WHEN min(due_at) IS NULL THEN NULL
           ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (min(due_at) - now())) * 1000)) END AS next_due_ms
       FROM kletia_webhook_queue WHERE completed_at IS NULL AND (leased_until IS NULL OR leased_until <= now())`, []);
    const row = result.rows[0];
    return {
      queued: Number(row?.queued ?? 0),
      retries: Number(row?.retries ?? 0),
      nextDueMs: row?.next_due_ms === null || row?.next_due_ms === undefined ? null : Number(row.next_due_ms),
    };
  }

  async cancelWebhook(webhookId: string): Promise<void> {
    await cancelQueuedWebhook(webhookId);
  }

  async prune(now: number): Promise<void> {
    await pruneWebhookQueue(now);
  }
}

/** Completes every queued delivery of a deleted webhook and discards their bodies. */
export async function cancelQueuedWebhook(webhookId: string): Promise<void> {
  await dbQuery(SCHEMA,
    "UPDATE kletia_webhook_queue SET completed_at=now(),body_ciphertext=NULL,lease_token=NULL,leased_until=NULL WHERE webhook_id=$1 AND completed_at IS NULL",
    [webhookId]);
}

/** Removes completed rows (deduplication tombstones) older than 7 days. */
export async function pruneWebhookQueue(now: number): Promise<void> {
  await dbQuery(SCHEMA, "DELETE FROM kletia_webhook_queue WHERE completed_at < $1", [new Date(now - COMPLETED_RETENTION_MS).toISOString()]);
}
