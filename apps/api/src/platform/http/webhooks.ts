/**
 * Webhook registrations, owned by an API key.
 *
 * - Public HTTPS URLs only (see netguard.ts), at most 10 per key.
 * - The signing secret (`whsec_` + 32 base62) is returned once at creation and
 *   stored sealed with AES-256-GCM (secrets.ts), bound to the webhook id.
 * - Storage: memory, or Postgres `kletia_webhooks` when KLETIA_DATABASE_URL is set.
 */
import { PlatformError } from "../errors.js";
import type { IntentEventType } from "../index.js";
import { HttpError, invalidRequest, isRecord } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";
import { assertPublicWebhookUrl } from "./netguard.js";
import { openSecret, randomBase62, randomHex, sealingAvailable, sealSecret } from "./secrets.js";

/** Every engine intent event type; the Record forces this list to follow IntentEventType. */
const EVENT_TYPE_SET: Readonly<Record<IntentEventType, true>> = {
  "intent.created": true,
  "intent.status_changed": true,
  "intent.step_updated": true,
};

export const WEBHOOK_EVENT_TYPES: readonly IntentEventType[] = Object.freeze(Object.keys(EVENT_TYPE_SET) as IntentEventType[]);

export const MAX_WEBHOOKS_PER_KEY = 10;

export interface WebhookRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly url: string;
  readonly events: readonly IntentEventType[];
  readonly createdAt: string;
  readonly sealedSecret: string;
}

/** API representation; `secret` only in the creation response. */
export interface WebhookView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly IntentEventType[];
  readonly createdAt: string;
  readonly secret?: string;
}

function view(record: WebhookRecord, secret?: string): WebhookView {
  return {
    id: record.id,
    url: record.url,
    events: record.events,
    createdAt: record.createdAt,
    ...(secret ? { secret } : {}),
  };
}

function limitReached(): PlatformError {
  return new PlatformError("WEBHOOK_LIMIT_REACHED", `An API key can register at most ${MAX_WEBHOOKS_PER_KEY} webhooks. Delete one first.`, 409);
}

/* ----------------------------------------------------------------- store */

interface WebhookStore {
  readonly kind: "memory" | "postgres";
  /** Inserts unless the owner already has `max` webhooks (409 WEBHOOK_LIMIT_REACHED). */
  create(record: WebhookRecord, max: number): Promise<void>;
  listByOwner(ownerKeyId: string): Promise<WebhookRecord[]>;
  delete(ownerKeyId: string, id: string): Promise<boolean>;
}

class MemoryWebhookStore implements WebhookStore {
  readonly kind = "memory" as const;
  private readonly byOwner = new Map<string, WebhookRecord[]>();

  async create(record: WebhookRecord, max: number): Promise<void> {
    const existing = this.byOwner.get(record.ownerKeyId) ?? [];
    if (existing.length >= max) throw limitReached();
    this.byOwner.set(record.ownerKeyId, [...existing, record]);
  }

  async listByOwner(ownerKeyId: string): Promise<WebhookRecord[]> {
    return [...(this.byOwner.get(ownerKeyId) ?? [])];
  }

  async delete(ownerKeyId: string, id: string): Promise<boolean> {
    const existing = this.byOwner.get(ownerKeyId) ?? [];
    const next = existing.filter((record) => record.id !== id);
    if (next.length === existing.length) return false;
    if (next.length === 0) this.byOwner.delete(ownerKeyId);
    else this.byOwner.set(ownerKeyId, next);
    return true;
  }
}

const WEBHOOKS_SCHEMA = {
  name: "kletia_webhooks",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_webhooks (
  id text PRIMARY KEY,
  owner_key_id text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL,
  secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_webhooks_owner_idx ON kletia_webhooks (owner_key_id, created_at);`,
} as const;

interface WebhookRow {
  id: string;
  owner_key_id: string;
  url: string;
  events: unknown;
  secret_ciphertext: string;
  created_at: Date | string;
}

function eventTypes(value: unknown): IntentEventType[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is IntentEventType => WEBHOOK_EVENT_TYPES.includes(entry as IntentEventType));
}

function fromRow(row: WebhookRow): WebhookRecord {
  const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    ownerKeyId: row.owner_key_id,
    url: row.url,
    events: eventTypes(row.events),
    createdAt: Number.isNaN(created.getTime()) ? new Date(0).toISOString() : created.toISOString(),
    sealedSecret: row.secret_ciphertext,
  };
}

class PostgresWebhookStore implements WebhookStore {
  readonly kind = "postgres" as const;

  async create(record: WebhookRecord, max: number): Promise<void> {
    await dbTransaction(WEBHOOKS_SCHEMA, async (client) => {
      // Serialise registrations per owner so the per-key cap holds across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_webhooks:${record.ownerKeyId}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_webhooks WHERE owner_key_id = $1",
        [record.ownerKeyId],
      );
      if (Number(count.rows[0]?.count ?? "0") >= max) throw limitReached();
      await client.query(
        `INSERT INTO kletia_webhooks (id, owner_key_id, url, events, secret_ciphertext, created_at)
         VALUES ($1, $2, $3, $4::text[], $5, $6)`,
        [record.id, record.ownerKeyId, record.url, [...record.events], record.sealedSecret, record.createdAt],
      );
    });
  }

  async listByOwner(ownerKeyId: string): Promise<WebhookRecord[]> {
    const result = await dbQuery<WebhookRow>(
      WEBHOOKS_SCHEMA,
      `SELECT id, owner_key_id, url, events, secret_ciphertext, created_at
       FROM kletia_webhooks WHERE owner_key_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [ownerKeyId],
    );
    return result.rows.map(fromRow);
  }

  async delete(ownerKeyId: string, id: string): Promise<boolean> {
    const result = await dbQuery(WEBHOOKS_SCHEMA, "DELETE FROM kletia_webhooks WHERE id = $1 AND owner_key_id = $2", [id, ownerKeyId]);
    return result.rowCount === 1;
  }
}

let store: WebhookStore | null = null;

function webhookStore(): WebhookStore {
  store ??= platformDatabaseUrl() ? new PostgresWebhookStore() : new MemoryWebhookStore();
  return store;
}

/* ---------------------------------------------------- owner cache (dispatch) */

const OWNER_CACHE_TTL_MS = 30_000;
const ownerCache = new Map<string, { readonly records: readonly WebhookRecord[]; readonly expiresAt: number }>();

function invalidateOwner(ownerKeyId: string): void {
  ownerCache.delete(ownerKeyId);
}

/**
 * Webhooks of one owner for delivery (cached briefly; local writes
 * invalidate). `fresh` re-reads the store, e.g. for a request that names a
 * webhook created on another instance.
 */
export async function webhooksForOwner(ownerKeyId: string, options: { readonly fresh?: boolean } = {}): Promise<readonly WebhookRecord[]> {
  const now = Date.now();
  const cached = ownerCache.get(ownerKeyId);
  if (!options.fresh && cached && cached.expiresAt > now) return cached.records;
  const records = await webhookStore().listByOwner(ownerKeyId);
  ownerCache.set(ownerKeyId, { records, expiresAt: now + OWNER_CACHE_TTL_MS });
  while (ownerCache.size > 5_000) {
    const oldest = ownerCache.keys().next().value;
    if (oldest === undefined) break;
    ownerCache.delete(oldest);
  }
  return records;
}

/** The signing secret of a stored webhook. */
export function webhookSecret(record: WebhookRecord): string {
  return openSecret(record.sealedSecret, record.id);
}

/* --------------------------------------------------------------- service */

export function assertWebhooksAvailable(): void {
  if (!sealingAvailable()) {
    throw new PlatformError(
      "WEBHOOKS_NOT_CONFIGURED",
      "Webhooks are unavailable on this deployment until KLETIA_PLATFORM_SECRET is configured.",
      503,
    );
  }
}

function parseEvents(value: unknown): IntentEventType[] {
  if (value === undefined) return [...WEBHOOK_EVENT_TYPES];
  if (!Array.isArray(value) || value.length === 0 || value.length > WEBHOOK_EVENT_TYPES.length) {
    throw invalidRequest(`events must be a non-empty list drawn from ${WEBHOOK_EVENT_TYPES.join(", ")}.`, [
      { path: "events", message: "Invalid event list." },
    ]);
  }
  const issues = value.flatMap((entry, index) =>
    typeof entry === "string" && WEBHOOK_EVENT_TYPES.includes(entry as IntentEventType)
      ? []
      : [{ path: `events[${index}]`, message: `Unknown event type. Use one of ${WEBHOOK_EVENT_TYPES.join(", ")}.` }],
  );
  if (issues.length > 0) throw invalidRequest("events contains an unknown event type.", issues);
  return [...new Set(value as IntentEventType[])];
}

export async function createWebhook(ownerKeyId: string, body: unknown): Promise<WebhookView> {
  assertWebhooksAvailable();
  if (!isRecord(body)) {
    throw invalidRequest("Body must be { \"url\": \"https://…\", \"events\"?: [...] }.", [{ path: "", message: "Expected an object." }]);
  }
  const events = parseEvents(body.events);
  const url = await assertPublicWebhookUrl(body.url);
  const existing = await webhookStore().listByOwner(ownerKeyId);
  if (existing.length >= MAX_WEBHOOKS_PER_KEY) throw limitReached();
  const href = url.toString();
  if (existing.some((record) => record.url === href)) {
    throw new PlatformError("WEBHOOK_EXISTS", "A webhook with this URL is already registered for this key.", 409, [
      { path: "url", message: "Duplicate URL." },
    ]);
  }
  const id = `wh_${randomHex(12)}`;
  const secret = `whsec_${randomBase62(32)}`;
  const record: WebhookRecord = {
    id,
    ownerKeyId,
    url: href,
    events,
    createdAt: new Date().toISOString(),
    sealedSecret: sealSecret(secret, id),
  };
  await webhookStore().create(record, MAX_WEBHOOKS_PER_KEY);
  invalidateOwner(ownerKeyId);
  return view(record, secret);
}

export async function listWebhooks(ownerKeyId: string): Promise<WebhookView[]> {
  assertWebhooksAvailable();
  return (await webhookStore().listByOwner(ownerKeyId)).map((record) => view(record));
}

export async function deleteWebhook(ownerKeyId: string, id: string): Promise<void> {
  assertWebhooksAvailable();
  const deleted = await webhookStore().delete(ownerKeyId, id);
  invalidateOwner(ownerKeyId);
  if (!deleted) throw new HttpError(404, "WEBHOOK_NOT_FOUND", "Webhook not found.");
}

export function webhookStoreKind(): "memory" | "postgres" {
  return webhookStore().kind;
}
