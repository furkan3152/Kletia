/**
 * Kletia-held clarify threads (clarify design §5.3): the memory of a task for
 * integrators whose backend keeps nothing between turns (`remember: true` on a
 * first turn of `POST /v1/intents?clarify=true`, then `threadId`).
 *
 * - Scoped to the API key that created the thread: another key, or the public
 *   tier, gets 404 THREAD_NOT_FOUND (never 403, so ids reveal nothing).
 * - Expires 30 minutes after its last turn and 24 hours after it was created,
 *   whichever comes first; an expired thread is THREAD_NOT_FOUND and is pruned
 *   hourly (`startThreadPruner`, run by startPlatformBackground).
 * - Closes after 50 turns or a cancel (THREAD_CLOSED, from the engine).
 * - A key holds at most 1,000 open threads (429 RATE_LIMITED, Retry-After).
 * - Every turn updates the row only while its `rev` is the one the turn read
 *   (`WHERE id = $1 AND rev = $2`): of two concurrent turns one applies and
 *   the other gets 409 THREAD_CONFLICT.
 *
 * A record keeps the thread blob (Kletia's slots and labels, never the
 * user's words), the request context of the last turn (accounts, networks,
 * constraints, metadata, clientReference), a compact last response and the
 * ids of at most 5 stored intents, within 32 KB. Nothing read during a turn
 * (balances, names) is stored. Storage: memory (LRU, 50,000 threads) or
 * Postgres `kletia_threads` when KLETIA_DATABASE_URL is set.
 */
import { THREAD_LIMITS, THREAD_STATUSES, type AccountId, type ClarifyThread, type IntentConstraints, type NetworkKey, type ThreadRef, type ThreadStatus } from "@kletia/core";
import { PlatformError } from "../errors.js";
import { HttpError, isRecord } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";

/* ================================================================== model */

/** The request context a Kletia-held thread keeps between turns (the last one sent wins, field by field). */
export interface ThreadContext {
  readonly accounts: readonly AccountId[];
  readonly defaultNetwork?: NetworkKey;
  readonly sourceNetwork?: NetworkKey | "auto";
  readonly constraints?: IntentConstraints;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly clientReference?: string;
}

export interface ThreadRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly rev: number;
  readonly status: ThreadStatus;
  /** The thread blob as the engine wrote it (`kletia.thread/v1`). */
  readonly thread: ClarifyThread;
  readonly context: ThreadContext;
  /** The last turn's response, compact: a planned turn keeps its sentence and chips, not the intent graph. */
  readonly lastResponse: Readonly<Record<string, unknown>> | null;
  /** Stored intents planned on this thread, newest last (at most THREAD_LIMITS.intentsPerThread). */
  readonly intents: readonly string[];
  /** One line for lists: the draft summary, the planned sentence, or "Cancelled". */
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** GET /v1/threads entries. */
export interface ThreadSummaryView extends ThreadRef {
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * GET /v1/threads/{id} (the whole body): the thread blob, its ref, the
 * context it keeps, its last response and its intents.
 */
export interface ThreadDetailView {
  readonly thread: ClarifyThread;
  readonly ref: ThreadRef;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly context: ThreadContext;
  readonly response: Readonly<Record<string, unknown>> | null;
  readonly intents: readonly string[];
}

export interface ThreadListFilter {
  readonly status?: ThreadStatus;
  readonly limit: number;
  /** Keyset cursor (`nextCursor` of the previous page). */
  readonly cursor?: ThreadCursor;
}

export interface ThreadCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ThreadPage {
  readonly records: readonly ThreadRecord[];
  readonly next: ThreadCursor | null;
}

/** Expiry of a thread last touched at `updatedAt`: 30 minutes idle, 24 hours in all. */
export function threadExpiry(createdAt: string, updatedAt: string): string {
  const idle = Date.parse(updatedAt) + THREAD_LIMITS.idleMs;
  const absolute = Date.parse(createdAt) + THREAD_LIMITS.absoluteMs;
  return new Date(Math.min(idle, absolute)).toISOString();
}

export function threadRef(record: Pick<ThreadRecord, "id" | "rev" | "status" | "expiresAt">): ThreadRef {
  return { id: record.id, rev: record.rev, status: record.status, expiresAt: record.expiresAt };
}

export function threadSummaryView(record: ThreadRecord): ThreadSummaryView {
  return { ...threadRef(record), summary: record.summary, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export function threadDetailView(record: ThreadRecord): ThreadDetailView {
  return {
    thread: record.thread,
    ref: threadRef(record),
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    context: record.context,
    response: record.lastResponse,
    intents: record.intents,
  };
}

/** The stored part of a record (the `record` column), within THREAD_LIMITS.storedRecordBytes. */
function storedBody(record: ThreadRecord): string {
  const body = { thread: record.thread, context: record.context, lastResponse: record.lastResponse, intents: record.intents, summary: record.summary };
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, "utf8") <= THREAD_LIMITS.storedRecordBytes) return json;
  // The last response is the only part that can be dropped; the thread and context are what the next turn needs.
  const lean = JSON.stringify({ ...body, lastResponse: null });
  if (Buffer.byteLength(lean, "utf8") <= THREAD_LIMITS.storedRecordBytes) return lean;
  throw new PlatformError("THREAD_INVALID", "This task no longer fits in a remembered thread. Start a new one with fewer accounts or less metadata.", 400, [
    { path: "thread", message: `A remembered thread is at most ${THREAD_LIMITS.storedRecordBytes} bytes.` },
  ]);
}

/** The record as it is stored (the last response dropped when the record would exceed 32 KB). */
export function boundedRecord(record: ThreadRecord): ThreadRecord {
  const body = JSON.parse(storedBody(record)) as { lastResponse: ThreadRecord["lastResponse"] };
  return body.lastResponse === null && record.lastResponse !== null ? { ...record, lastResponse: null } : record;
}

export function openThreadLimitReached(): HttpError {
  return new HttpError(429, "RATE_LIMITED", `An API key holds at most ${THREAD_LIMITS.openPerKey} open threads. Delete threads you no longer need (DELETE /v1/threads/{id}) or wait for them to expire.`, {
    headers: { "Retry-After": "60" },
  });
}

/* ================================================================== store */

export interface ThreadStore {
  readonly kind: "memory" | "postgres";
  /** Open threads of a key: not cancelled and not expired at `now`. */
  countOpen(ownerKeyId: string, now: string): Promise<number>;
  /** Inserts unless the owner already holds `maxOpen` open threads (429 RATE_LIMITED). */
  create(record: ThreadRecord, maxOpen: number, now: string): Promise<void>;
  get(id: string): Promise<ThreadRecord | null>;
  /** Replaces the record only while the stored `rev` is `expectedRev` (and the owner matches); false otherwise. */
  update(record: ThreadRecord, expectedRev: number): Promise<boolean>;
  /** The owner's threads that have not expired at `now`, most recently updated first. */
  list(ownerKeyId: string, filter: ThreadListFilter, now: string): Promise<ThreadPage>;
  /** Deletes the owner's thread; false when there was none. */
  delete(ownerKeyId: string, id: string): Promise<boolean>;
  /** Deletes threads that expired at or before `now`; returns how many. */
  prune(now: string): Promise<number>;
}

function isOpen(record: ThreadRecord, now: string): boolean {
  return record.status !== "cancelled" && record.expiresAt > now;
}

/** Newest first by (updatedAt, id). */
function newerFirst(a: ThreadRecord, b: ThreadRecord): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function afterCursor(record: ThreadRecord, cursor: ThreadCursor | undefined): boolean {
  if (!cursor) return true;
  return record.updatedAt < cursor.updatedAt || (record.updatedAt === cursor.updatedAt && record.id < cursor.id);
}

export class MemoryThreadStore implements ThreadStore {
  readonly kind = "memory" as const;
  private readonly threads = new Map<string, ThreadRecord>();

  constructor(private readonly maxThreads = 50_000) {}

  async countOpen(ownerKeyId: string, now: string): Promise<number> {
    let open = 0;
    for (const record of this.threads.values()) if (record.ownerKeyId === ownerKeyId && isOpen(record, now)) open += 1;
    return open;
  }

  async create(record: ThreadRecord, maxOpen: number, now: string): Promise<void> {
    // Synchronous between the count and the insert: concurrent creations in this process cannot both pass.
    let open = 0;
    for (const existing of this.threads.values()) if (existing.ownerKeyId === record.ownerKeyId && isOpen(existing, now)) open += 1;
    if (open >= maxOpen) throw openThreadLimitReached();
    storedBody(record);
    this.threads.set(record.id, boundedRecord(record));
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  async get(id: string): Promise<ThreadRecord | null> {
    return this.threads.get(id) ?? null;
  }

  async update(record: ThreadRecord, expectedRev: number): Promise<boolean> {
    const current = this.threads.get(record.id);
    if (!current || current.ownerKeyId !== record.ownerKeyId || current.rev !== expectedRev) return false;
    const bounded = boundedRecord(record);
    // Most recently used last, so the LRU bound drops idle threads first.
    this.threads.delete(record.id);
    this.threads.set(record.id, bounded);
    return true;
  }

  async list(ownerKeyId: string, filter: ThreadListFilter, now: string): Promise<ThreadPage> {
    const matching = [...this.threads.values()]
      .filter((record) => record.ownerKeyId === ownerKeyId && record.expiresAt > now && (!filter.status || record.status === filter.status))
      .sort(newerFirst)
      .filter((record) => afterCursor(record, filter.cursor));
    const records = matching.slice(0, filter.limit);
    const last = records[records.length - 1];
    return { records, next: matching.length > filter.limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }

  async delete(ownerKeyId: string, id: string): Promise<boolean> {
    const current = this.threads.get(id);
    if (!current || current.ownerKeyId !== ownerKeyId) return false;
    this.threads.delete(id);
    return true;
  }

  async prune(now: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.threads) {
      if (record.expiresAt <= now) {
        this.threads.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

const THREADS_SCHEMA = {
  name: "kletia_threads",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_threads (
  id text PRIMARY KEY,
  owner_key_id text NOT NULL,
  rev integer NOT NULL,
  status text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS kletia_threads_owner ON kletia_threads (owner_key_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS kletia_threads_expiry ON kletia_threads (expires_at);`,
} as const;

interface ThreadRow {
  id: string;
  owner_key_id: string;
  rev: number;
  status: string;
  record: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
}

const THREAD_COLUMNS = "id, owner_key_id, rev, status, record, created_at, updated_at, expires_at";

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function threadFromRow(row: ThreadRow): ThreadRecord | null {
  const body = row.record;
  if (!isRecord(body) || !isRecord(body.thread) || !isRecord(body.context) || !(THREAD_STATUSES as readonly string[]).includes(row.status)) return null;
  return {
    id: row.id,
    ownerKeyId: row.owner_key_id,
    rev: row.rev,
    status: row.status as ThreadStatus,
    thread: body.thread as unknown as ClarifyThread,
    context: body.context as unknown as ThreadContext,
    lastResponse: isRecord(body.lastResponse) ? body.lastResponse : null,
    intents: Array.isArray(body.intents) ? body.intents.filter((entry): entry is string => typeof entry === "string") : [],
    summary: typeof body.summary === "string" ? body.summary : "",
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
    expiresAt: isoOf(row.expires_at),
  };
}

export class PostgresThreadStore implements ThreadStore {
  readonly kind = "postgres" as const;

  async countOpen(ownerKeyId: string, now: string): Promise<number> {
    const result = await dbQuery<{ count: string }>(
      THREADS_SCHEMA,
      "SELECT count(*)::text AS count FROM kletia_threads WHERE owner_key_id = $1 AND status <> 'cancelled' AND expires_at > $2",
      [ownerKeyId, now],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async create(record: ThreadRecord, maxOpen: number, now: string): Promise<void> {
    const body = storedBody(record);
    const inserted = await dbTransaction(THREADS_SCHEMA, async (client) => {
      // Serialise per owner so the open-thread cap holds across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_threads:${record.ownerKeyId}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_threads WHERE owner_key_id = $1 AND status <> 'cancelled' AND expires_at > $2",
        [record.ownerKeyId, now],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxOpen) return false;
      await client.query(
        `INSERT INTO kletia_threads (id, owner_key_id, rev, status, record, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [record.id, record.ownerKeyId, record.rev, record.status, body, record.createdAt, record.updatedAt, record.expiresAt],
      );
      return true;
    });
    if (!inserted) throw openThreadLimitReached();
  }

  async get(id: string): Promise<ThreadRecord | null> {
    const result = await dbQuery<ThreadRow>(THREADS_SCHEMA, `SELECT ${THREAD_COLUMNS} FROM kletia_threads WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? threadFromRow(row) : null;
  }

  async update(record: ThreadRecord, expectedRev: number): Promise<boolean> {
    const result = await dbQuery(
      THREADS_SCHEMA,
      `UPDATE kletia_threads SET rev = $4, status = $5, record = $6::jsonb, updated_at = $7, expires_at = $8
       WHERE id = $1 AND owner_key_id = $2 AND rev = $3`,
      [record.id, record.ownerKeyId, expectedRev, record.rev, record.status, storedBody(record), record.updatedAt, record.expiresAt],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async list(ownerKeyId: string, filter: ThreadListFilter, now: string): Promise<ThreadPage> {
    const values: unknown[] = [ownerKeyId, now];
    let where = "owner_key_id = $1 AND expires_at > $2";
    if (filter.status) {
      values.push(filter.status);
      where += ` AND status = $${values.length}`;
    }
    if (filter.cursor) {
      values.push(filter.cursor.updatedAt, filter.cursor.id);
      where += ` AND (updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`;
    }
    values.push(filter.limit + 1);
    const result = await dbQuery<ThreadRow>(
      THREADS_SCHEMA,
      `SELECT ${THREAD_COLUMNS} FROM kletia_threads WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    const records = result.rows.map(threadFromRow).filter((record): record is ThreadRecord => record !== null);
    const page = records.slice(0, filter.limit);
    const last = page[page.length - 1];
    return { records: page, next: result.rows.length > filter.limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }

  async delete(ownerKeyId: string, id: string): Promise<boolean> {
    const result = await dbQuery(THREADS_SCHEMA, "DELETE FROM kletia_threads WHERE id = $1 AND owner_key_id = $2", [id, ownerKeyId]);
    return (result.rowCount ?? 0) === 1;
  }

  async prune(now: string): Promise<number> {
    const result = await dbQuery(THREADS_SCHEMA, "DELETE FROM kletia_threads WHERE expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }
}

let store: ThreadStore | null = null;

export function threadStore(): ThreadStore {
  store ??= platformDatabaseUrl() ? new PostgresThreadStore() : new MemoryThreadStore();
  return store;
}

/** Replaces the store (tests); `null` re-selects by KLETIA_DATABASE_URL on next use. */
export function configureThreadStore(custom: ThreadStore | null): void {
  store = custom;
}

let clock: () => number = Date.now;

/** The clock of thread expiry (tests); `null` restores Date.now. */
export function configureThreadClock(next: (() => number) | null): void {
  clock = next ?? Date.now;
}

export function threadNow(): number {
  return clock();
}

/* ================================================================ cursors */

/** `nextCursor`: base64url of `<updatedAt>|<id>`. */
export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(`${cursor.updatedAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Null when the cursor is not one Kletia wrote. */
export function decodeThreadCursor(raw: string): ThreadCursor | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(raw)) return null;
  const [updatedAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !updatedAt || !id || !/^th_[a-z2-7]{24}$/u.test(id)) return null;
  const time = Date.parse(updatedAt);
  if (Number.isNaN(time) || new Date(time).toISOString() !== updatedAt) return null;
  return { updatedAt, id };
}

/* ================================================================= pruner */

/** Hourly deletion of expired threads (long-running hosts). Returns a stop function. */
export function startThreadPruner(intervalMs = 60 * 60_000): () => void {
  const timer = setInterval(() => {
    threadStore()
      .prune(new Date(threadNow()).toISOString())
      .catch((error: unknown) => console.warn("[platform] thread prune failed:", error instanceof Error ? error.message : error));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
