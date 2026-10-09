/**
 * API keys and tier resolution.
 *
 * - Developer keys: `kl_dev_` + 32 base62 characters, issued by POST /v1/keys.
 *   Only sha256(key) is stored (memory, or Postgres `kletia_api_keys` when
 *   KLETIA_DATABASE_URL is set). The raw key is returned exactly once.
 * - Projects: a key issued with another developer key joins that key's
 *   project (at most 5 active keys); an anonymously issued key starts a new
 *   one. Keys of one project can list, rotate and revoke each other (keys.ts).
 * - Rotation keeps the key id (intents and webhooks stay attached) and swaps
 *   the secret; the previous secret keeps authenticating until its grace
 *   window ends, but cannot manage keys.
 * - Operator keys: raw keys in KLETIA_OPERATOR_API_KEYS (comma separated),
 *   hashed when the router is created and never stored. They cannot be managed.
 * - Agent keys (Rule Book, policy design §8): `kl_agt_` + 32 base62, children
 *   of a key (`parentId`, `lineage` = ancestors, project key first), at most 2
 *   levels below a project key and 100 active per project, always with an
 *   expiry. A key authenticates only while it and every ancestor are neither
 *   revoked nor expired (checked by the store in the same read), so a
 *   revocation holds even if the cascade write of a subtree failed.
 *
 * A request presents a key as `Authorization: Bearer <key>` or
 * `X-Kletia-Key: <key>`. No key means the public tier; a key that does not
 * authenticate is always 401 (never silently downgraded to public).
 *
 * Verified keys are cached for 15 s per process: revocation and the end of a
 * grace window take effect immediately on the instance that handled them and
 * within 15 s everywhere else.
 */
import type { RequestHandler } from "express";
import { AGENT_KEY_PATTERN, AGENT_KEY_PREFIX } from "@kletia/core";
import { PlatformError } from "../errors.js";
import { authOf, HttpError, invalidRequest, isRecord, sendError, setAuth, type ApiTier } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";
import { clientIp, TIER_LIMITS } from "./limits.js";
import { randomBase62, randomHex, sha256Hex } from "./secrets.js";

export type KeyTier = Exclude<ApiTier, "public">;

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  /** Keys issued from one another share a project; a legacy key is a project of one (its own id). */
  readonly projectId: string;
  /** Last four characters of the current secret (null for keys issued before they were recorded). */
  readonly last4: string | null;
  readonly rotatedAt: string | null;
  /** End of the previous secret's grace window after a rotation (null when none is valid). */
  readonly previousExpiresAt: string | null;
  readonly lastUsedAt: string | null;
  /** `project` (default: every key issued by POST /v1/keys) or `agent` (a child key, Rule Book). */
  readonly kind?: ApiKeyKind;
  /** Parent of an agent key (null for project keys). */
  readonly parentId?: string | null;
  /** Ancestors of an agent key, project key first (empty for project keys). */
  readonly lineage?: readonly string[];
  /** When the key stops authenticating (always set on agent keys; null: never). */
  readonly expiresAt?: string | null;
}

export type ApiKeyKind = "project" | "agent";

export interface IssuedApiKey {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly createdAt: string;
  /** The raw key. Shown once; Kletia keeps only its SHA-256 hash. */
  readonly key: string;
}

/** A store hit: the record, and whether the hash matched the previous (rotated-out) secret. */
export interface ApiKeyMatch {
  readonly record: ApiKeyRecord;
  readonly viaPrevious: boolean;
  /**
   * The key and every ancestor are neither revoked nor expired at the time of
   * the lookup (false refuses authentication). Absent means true (stores that
   * predate agent keys).
   */
  readonly active?: boolean;
}

/** The kind of a stored key (records written before agent keys are project keys). */
export function keyKindOf(record: Pick<ApiKeyRecord, "kind">): ApiKeyKind {
  return record.kind === "agent" ? "agent" : "project";
}

/** A key that is not revoked and not expired at `now` (its own state only). */
export function keyLive(record: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">, now: number): boolean {
  return !record.revokedAt && !(record.expiresAt && Date.parse(record.expiresAt) <= now);
}

export const DEVELOPER_KEY_PREFIX = "kl_dev_";
const DEVELOPER_KEY_PATTERN = /^kl_dev_[0-9A-Za-z]{32}$/u;
export { AGENT_KEY_PREFIX };
const MIN_OPERATOR_KEY_LENGTH = 24;
const MAX_KEY_LENGTH = 256;

export function keyCollision(): PlatformError {
  return new PlatformError("KEY_COLLISION", "Key generation collided; try again.", 409);
}

export function keyLimitReached(max: number): PlatformError {
  return new PlatformError("KEY_LIMIT_REACHED", `A project holds at most ${max} active API keys. Revoke one with DELETE /v1/keys/{id} first.`, 409);
}

export function agentKeyLimitReached(max: number): PlatformError {
  return new PlatformError("AGENT_KEY_LIMIT_REACHED", `A project holds at most ${max} active agent keys. Revoke one with DELETE /v1/keys/{id} first.`, 409);
}

/* ----------------------------------------------------------------- store */

export type RevokeOutcome = "revoked" | "already_revoked" | "missing";

export interface SubtreeRevocation {
  readonly outcome: RevokeOutcome;
  /** Every key revoked by this call (the subject and its descendants that were still active). */
  readonly cascade: readonly string[];
}

export interface ApiKeyStore {
  readonly kind: "memory" | "postgres";
  /** Inserts a project key; with `maxActive`, refuses (409 KEY_LIMIT_REACHED) when its project already holds that many active project keys. */
  insert(record: ApiKeyRecord, keyHash: string, maxActive?: number): Promise<void>;
  /**
   * Inserts an agent key (`kind: "agent"`), refusing (409
   * AGENT_KEY_LIMIT_REACHED) when its project already holds `maxActiveAgents`
   * active agent keys; serialised per project like `insert`.
   */
  insertAgent(record: ApiKeyRecord, keyHash: string, maxActiveAgents: number, now: number): Promise<void>;
  /** The key whose current secret, or unexpired previous secret, hashes to `keyHash` (with lineage liveness). */
  findByHash(keyHash: string, now: number): Promise<ApiKeyMatch | null>;
  /** The key with this id (revoked or not), null when unknown. */
  findById(id: string): Promise<ApiKeyRecord | null>;
  /** Several keys by id (unknown ids are left out). */
  findMany(ids: readonly string[]): Promise<ApiKeyRecord[]>;
  /** Keys of one project, newest first (at most 200, revoked ones included). */
  listByProject(projectId: string): Promise<ApiKeyRecord[]>;
  /**
   * Replaces the secret of an active developer key in `projectId`. The old
   * secret stays valid until `previousExpiresAt` (null: never). Returns null
   * when no such active key exists.
   */
  rotate(id: string, projectId: string, keyHash: string, last4: string, rotatedAt: string, previousExpiresAt: string | null): Promise<ApiKeyRecord | null>;
  revoke(id: string, projectId: string, revokedAt: string): Promise<RevokeOutcome>;
  /** Revokes a key and its whole subtree (every key whose lineage holds it) in one write. */
  revokeSubtree(id: string, projectId: string, revokedAt: string): Promise<SubtreeRevocation>;
  /** Sets the expiry of an active key of the project; null when no such key. */
  setExpiry(id: string, projectId: string, expiresAt: string | null): Promise<ApiKeyRecord | null>;
  /** Records when keys were last used (never moves a timestamp backwards). */
  touch(lastUsed: ReadonlyMap<string, string>): Promise<void>;
}

/** Active agent keys of a project at `now` (not revoked, not expired). */
function activeAgent(record: ApiKeyRecord, projectId: string, now: number): boolean {
  return record.projectId === projectId && keyKindOf(record) === "agent" && keyLive(record, now);
}

interface MemoryKeyEntry {
  record: ApiKeyRecord;
  keyHash: string;
  previousHash: string | null;
}

export class MemoryApiKeyStore implements ApiKeyStore {
  readonly kind = "memory" as const;
  private readonly byId = new Map<string, MemoryKeyEntry>();
  /** Current and previous secret hashes -> key id. */
  private readonly byHash = new Map<string, string>();

  constructor(private readonly maxKeys = 50_000) {}

  private activeInProject(projectId: string): number {
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.record.projectId === projectId && !entry.record.revokedAt && keyKindOf(entry.record) === "project") count += 1;
    }
    return count;
  }

  /** The key and each ancestor are live at `now` (unknown ancestors are not). */
  private lineageLive(record: ApiKeyRecord, now: number): boolean {
    if (!keyLive(record, now)) return false;
    return (record.lineage ?? []).every((id) => {
      const ancestor = this.byId.get(id)?.record;
      return ancestor !== undefined && keyLive(ancestor, now);
    });
  }

  async insert(record: ApiKeyRecord, keyHash: string, maxActive?: number): Promise<void> {
    if (this.byHash.has(keyHash) || this.byId.has(record.id)) throw keyCollision();
    if (maxActive !== undefined && this.activeInProject(record.projectId) >= maxActive) throw keyLimitReached(maxActive);
    this.add(record, keyHash);
  }

  async insertAgent(record: ApiKeyRecord, keyHash: string, maxActiveAgents: number, now: number): Promise<void> {
    if (this.byHash.has(keyHash) || this.byId.has(record.id)) throw keyCollision();
    let count = 0;
    for (const entry of this.byId.values()) if (activeAgent(entry.record, record.projectId, now)) count += 1;
    if (count >= maxActiveAgents) throw agentKeyLimitReached(maxActiveAgents);
    this.add({ ...record, kind: "agent" }, keyHash);
  }

  private add(record: ApiKeyRecord, keyHash: string): void {
    this.byId.set(record.id, { record, keyHash, previousHash: null });
    this.byHash.set(keyHash, record.id);
    while (this.byId.size > this.maxKeys) {
      const oldest = this.byId.entries().next().value;
      if (oldest === undefined) break;
      const [id, entry] = oldest;
      this.byId.delete(id);
      this.byHash.delete(entry.keyHash);
      if (entry.previousHash) this.byHash.delete(entry.previousHash);
    }
  }

  async findByHash(keyHash: string, now: number): Promise<ApiKeyMatch | null> {
    const id = this.byHash.get(keyHash);
    const entry = id === undefined ? undefined : this.byId.get(id);
    if (!entry) return null;
    const active = this.lineageLive(entry.record, now);
    if (entry.keyHash === keyHash) return { record: entry.record, viaPrevious: false, active };
    const expires = entry.record.previousExpiresAt ? Date.parse(entry.record.previousExpiresAt) : 0;
    return entry.previousHash === keyHash && expires > now ? { record: entry.record, viaPrevious: true, active } : null;
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    return this.byId.get(id)?.record ?? null;
  }

  async findMany(ids: readonly string[]): Promise<ApiKeyRecord[]> {
    return ids.flatMap((id) => {
      const record = this.byId.get(id)?.record;
      return record ? [record] : [];
    });
  }

  async listByProject(projectId: string): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()]
      .map((entry) => entry.record)
      .filter((record) => record.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 200);
  }

  async rotate(id: string, projectId: string, keyHash: string, last4: string, rotatedAt: string, previousExpiresAt: string | null): Promise<ApiKeyRecord | null> {
    const entry = this.byId.get(id);
    if (!entry || entry.record.projectId !== projectId || entry.record.revokedAt || entry.record.tier !== "developer") return null;
    if (this.byHash.has(keyHash)) throw keyCollision();
    if (entry.previousHash) this.byHash.delete(entry.previousHash);
    const previousHash = previousExpiresAt ? entry.keyHash : null;
    if (!previousHash) this.byHash.delete(entry.keyHash);
    entry.previousHash = previousHash;
    entry.keyHash = keyHash;
    entry.record = { ...entry.record, last4, rotatedAt, previousExpiresAt };
    this.byHash.set(keyHash, id);
    return entry.record;
  }

  async revoke(id: string, projectId: string, revokedAt: string): Promise<RevokeOutcome> {
    const entry = this.byId.get(id);
    if (!entry || entry.record.projectId !== projectId) return "missing";
    if (entry.record.revokedAt) return "already_revoked";
    if (entry.previousHash) this.byHash.delete(entry.previousHash);
    entry.previousHash = null;
    entry.record = { ...entry.record, revokedAt, previousExpiresAt: null };
    return "revoked";
  }

  async revokeSubtree(id: string, projectId: string, revokedAt: string): Promise<SubtreeRevocation> {
    const subject = this.byId.get(id);
    if (!subject || subject.record.projectId !== projectId) return { outcome: "missing", cascade: [] };
    const outcome: RevokeOutcome = subject.record.revokedAt ? "already_revoked" : "revoked";
    const cascade: string[] = [];
    for (const entry of this.byId.values()) {
      const record = entry.record;
      if (record.projectId !== projectId || (record.id !== id && !(record.lineage ?? []).includes(id))) continue;
      if (!record.revokedAt) cascade.push(record.id);
      if (entry.previousHash) this.byHash.delete(entry.previousHash);
      entry.previousHash = null;
      entry.record = { ...record, revokedAt: record.revokedAt ?? revokedAt, previousExpiresAt: null };
    }
    return { outcome, cascade };
  }

  async setExpiry(id: string, projectId: string, expiresAt: string | null): Promise<ApiKeyRecord | null> {
    const entry = this.byId.get(id);
    if (!entry || entry.record.projectId !== projectId || entry.record.revokedAt) return null;
    entry.record = { ...entry.record, expiresAt };
    return entry.record;
  }

  async touch(lastUsed: ReadonlyMap<string, string>): Promise<void> {
    for (const [id, at] of lastUsed) {
      const entry = this.byId.get(id);
      if (entry && (!entry.record.lastUsedAt || entry.record.lastUsedAt < at)) entry.record = { ...entry.record, lastUsedAt: at };
    }
  }
}

const API_KEYS_SCHEMA = {
  name: "kletia_api_keys",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_api_keys (
  id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('developer', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE kletia_api_keys
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS last4 text,
  ADD COLUMN IF NOT EXISTS previous_key_hash text,
  ADD COLUMN IF NOT EXISTS previous_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS kletia_api_keys_previous_hash_idx ON kletia_api_keys (previous_key_hash) WHERE previous_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS kletia_api_keys_project_idx ON kletia_api_keys ((COALESCE(project_id, id)), created_at);
ALTER TABLE kletia_api_keys
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'project',
  ADD COLUMN IF NOT EXISTS parent_id text,
  ADD COLUMN IF NOT EXISTS lineage text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kletia_api_keys_kind_check') THEN
    ALTER TABLE kletia_api_keys ADD CONSTRAINT kletia_api_keys_kind_check CHECK (kind IN ('project', 'agent'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS kletia_api_keys_lineage_idx ON kletia_api_keys USING gin (lineage);
CREATE INDEX IF NOT EXISTS kletia_api_keys_parent_idx ON kletia_api_keys (parent_id) WHERE parent_id IS NOT NULL;`,
} as const;

const KEY_COLUMNS = "id, name, tier, created_at, revoked_at, project_id, last4, rotated_at, previous_expires_at, last_used_at, kind, parent_id, lineage, expires_at";

interface ApiKeyRow {
  id: string;
  name: string;
  tier: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
  project_id: string | null;
  last4: string | null;
  rotated_at: Date | string | null;
  previous_expires_at: Date | string | null;
  last_used_at: Date | string | null;
  kind: string | null;
  parent_id: string | null;
  lineage: string[] | null;
  expires_at: Date | string | null;
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function recordFromRow(row: ApiKeyRow): ApiKeyRecord | null {
  if (row.tier !== "developer" && row.tier !== "operator") return null;
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    createdAt: isoOf(row.created_at) ?? new Date(0).toISOString(),
    revokedAt: isoOf(row.revoked_at),
    projectId: row.project_id ?? row.id,
    last4: row.last4,
    rotatedAt: isoOf(row.rotated_at),
    previousExpiresAt: isoOf(row.previous_expires_at),
    lastUsedAt: isoOf(row.last_used_at),
    kind: row.kind === "agent" ? "agent" : "project",
    parentId: row.parent_id,
    lineage: Array.isArray(row.lineage) ? row.lineage : [],
    expiresAt: isoOf(row.expires_at),
  };
}

/** SQL: the key row `k` and every ancestor are neither revoked nor expired at $2. */
const LINEAGE_ACTIVE = `(k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > $2) AND NOT EXISTS (
  SELECT 1 FROM kletia_api_keys a WHERE a.id = ANY(k.lineage)
    AND (a.revoked_at IS NOT NULL OR (a.expires_at IS NOT NULL AND a.expires_at <= $2))
) AND cardinality(k.lineage) = (SELECT count(*) FROM kletia_api_keys a WHERE a.id = ANY(k.lineage)))`;

export class PostgresApiKeyStore implements ApiKeyStore {
  readonly kind = "postgres" as const;

  async insert(record: ApiKeyRecord, keyHash: string, maxActive?: number): Promise<void> {
    await dbTransaction(API_KEYS_SCHEMA, async (client) => {
      if (maxActive !== undefined) {
        // Serialise issuance per project so the cap holds across instances.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_api_keys:${record.projectId}`]);
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM kletia_api_keys WHERE COALESCE(project_id, id) = $1 AND revoked_at IS NULL AND kind = 'project'",
          [record.projectId],
        );
        if (Number(count.rows[0]?.count ?? "0") >= maxActive) throw keyLimitReached(maxActive);
      }
      const result = await client.query(
        `INSERT INTO kletia_api_keys (id, key_hash, name, tier, created_at, project_id, last4)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [record.id, keyHash, record.name, record.tier, record.createdAt, record.projectId, record.last4],
      );
      if (result.rowCount !== 1) throw keyCollision();
    });
  }

  async insertAgent(record: ApiKeyRecord, keyHash: string, maxActiveAgents: number, now: number): Promise<void> {
    await dbTransaction(API_KEYS_SCHEMA, async (client) => {
      // The same per-project lock as project key issuance: the agent cap holds across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_api_keys:${record.projectId}`]);
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kletia_api_keys
         WHERE COALESCE(project_id, id) = $1 AND kind = 'agent' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
        [record.projectId, new Date(now).toISOString()],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxActiveAgents) throw agentKeyLimitReached(maxActiveAgents);
      const result = await client.query(
        `INSERT INTO kletia_api_keys (id, key_hash, name, tier, created_at, project_id, last4, kind, parent_id, lineage, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent', $8, $9::text[], $10) ON CONFLICT DO NOTHING`,
        [record.id, keyHash, record.name, record.tier, record.createdAt, record.projectId, record.last4, record.parentId ?? null, [...(record.lineage ?? [])], record.expiresAt ?? null],
      );
      if (result.rowCount !== 1) throw keyCollision();
    });
  }

  async findByHash(keyHash: string, now: number): Promise<ApiKeyMatch | null> {
    const result = await dbQuery<ApiKeyRow & { via_previous: boolean; active: boolean }>(
      API_KEYS_SCHEMA,
      `SELECT ${KEY_COLUMNS.split(", ").map((column) => `k.${column}`).join(", ")}, k.key_hash <> $1 AS via_previous, ${LINEAGE_ACTIVE} AS active
       FROM kletia_api_keys k
       WHERE k.key_hash = $1 OR (k.previous_key_hash = $1 AND k.previous_expires_at > $2)
       LIMIT 1`,
      [keyHash, new Date(now).toISOString()],
    );
    const row = result.rows[0];
    const record = row ? recordFromRow(row) : null;
    return row && record ? { record, viaPrevious: row.via_previous === true, active: row.active === true } : null;
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    const result = await dbQuery<ApiKeyRow>(API_KEYS_SCHEMA, `SELECT ${KEY_COLUMNS} FROM kletia_api_keys WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? recordFromRow(row) : null;
  }

  async findMany(ids: readonly string[]): Promise<ApiKeyRecord[]> {
    if (ids.length === 0) return [];
    const result = await dbQuery<ApiKeyRow>(API_KEYS_SCHEMA, `SELECT ${KEY_COLUMNS} FROM kletia_api_keys WHERE id = ANY($1::text[])`, [[...ids]]);
    const byId = new Map(result.rows.flatMap((row) => {
      const record = recordFromRow(row);
      return record ? [[record.id, record] as const] : [];
    }));
    return ids.flatMap((id) => {
      const record = byId.get(id);
      return record ? [record] : [];
    });
  }

  async listByProject(projectId: string): Promise<ApiKeyRecord[]> {
    const result = await dbQuery<ApiKeyRow>(
      API_KEYS_SCHEMA,
      `SELECT ${KEY_COLUMNS} FROM kletia_api_keys WHERE COALESCE(project_id, id) = $1 ORDER BY created_at DESC LIMIT 200`,
      [projectId],
    );
    return result.rows.map(recordFromRow).filter((record): record is ApiKeyRecord => record !== null);
  }

  async rotate(id: string, projectId: string, keyHash: string, last4: string, rotatedAt: string, previousExpiresAt: string | null): Promise<ApiKeyRecord | null> {
    const result = await dbQuery<ApiKeyRow>(
      API_KEYS_SCHEMA,
      `UPDATE kletia_api_keys SET
         previous_key_hash = CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE key_hash END,
         previous_expires_at = $6::timestamptz,
         key_hash = $3, last4 = $4, rotated_at = $5
       WHERE id = $1 AND COALESCE(project_id, id) = $2 AND revoked_at IS NULL AND tier = 'developer'
       RETURNING ${KEY_COLUMNS}`,
      [id, projectId, keyHash, last4, rotatedAt, previousExpiresAt],
    );
    const row = result.rows[0];
    return row ? recordFromRow(row) : null;
  }

  async revoke(id: string, projectId: string, revokedAt: string): Promise<RevokeOutcome> {
    const result = await dbQuery<{ was_revoked: boolean }>(
      API_KEYS_SCHEMA,
      `WITH target AS (
         SELECT id, revoked_at FROM kletia_api_keys WHERE id = $1 AND COALESCE(project_id, id) = $2 FOR UPDATE
       )
       UPDATE kletia_api_keys AS k SET revoked_at = COALESCE(k.revoked_at, $3), previous_key_hash = NULL, previous_expires_at = NULL
       FROM target WHERE k.id = target.id
       RETURNING target.revoked_at IS NOT NULL AS was_revoked`,
      [id, projectId, revokedAt],
    );
    const row = result.rows[0];
    if (!row) return "missing";
    return row.was_revoked ? "already_revoked" : "revoked";
  }

  async revokeSubtree(id: string, projectId: string, revokedAt: string): Promise<SubtreeRevocation> {
    // One statement (policy design §8.2): the subject and every key whose lineage holds it.
    const result = await dbQuery<{ id: string; was_revoked: boolean }>(
      API_KEYS_SCHEMA,
      `WITH target AS (
         SELECT id, revoked_at FROM kletia_api_keys
         WHERE (id = $1 OR $1 = ANY(lineage)) AND COALESCE(project_id, id) = $2 FOR UPDATE
       )
       UPDATE kletia_api_keys AS k SET revoked_at = COALESCE(k.revoked_at, $3), previous_key_hash = NULL, previous_expires_at = NULL
       FROM target WHERE k.id = target.id
       RETURNING k.id, target.revoked_at IS NOT NULL AS was_revoked`,
      [id, projectId, revokedAt],
    );
    const subject = result.rows.find((row) => row.id === id);
    if (!subject) return { outcome: "missing", cascade: [] };
    return {
      outcome: subject.was_revoked ? "already_revoked" : "revoked",
      cascade: result.rows.filter((row) => !row.was_revoked).map((row) => row.id),
    };
  }

  async setExpiry(id: string, projectId: string, expiresAt: string | null): Promise<ApiKeyRecord | null> {
    const result = await dbQuery<ApiKeyRow>(
      API_KEYS_SCHEMA,
      `UPDATE kletia_api_keys SET expires_at = $3::timestamptz
       WHERE id = $1 AND COALESCE(project_id, id) = $2 AND revoked_at IS NULL
       RETURNING ${KEY_COLUMNS}`,
      [id, projectId, expiresAt],
    );
    const row = result.rows[0];
    return row ? recordFromRow(row) : null;
  }

  async touch(lastUsed: ReadonlyMap<string, string>): Promise<void> {
    if (lastUsed.size === 0) return;
    await dbQuery(
      API_KEYS_SCHEMA,
      `UPDATE kletia_api_keys AS k SET last_used_at = GREATEST(COALESCE(k.last_used_at, v.at), v.at)
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::timestamptz[]) AS at) AS v
       WHERE k.id = v.id`,
      [[...lastUsed.keys()], [...lastUsed.values()]],
    );
  }
}

let keyStore: ApiKeyStore | null = null;

export function apiKeyStore(): ApiKeyStore {
  keyStore ??= platformDatabaseUrl() ? new PostgresApiKeyStore() : new MemoryApiKeyStore();
  return keyStore;
}

export function apiKeyStoreKind(): "memory" | "postgres" {
  return apiKeyStore().kind;
}

/* ---------------------------------------------------------- operator keys */

interface OperatorKey {
  readonly id: string;
  readonly name: string;
}

let operatorKeys: ReadonlyMap<string, OperatorKey> | null = null;

/** Hashes KLETIA_OPERATOR_API_KEYS once. Keys shorter than 24 characters are ignored with a warning. */
export function loadOperatorKeys(): ReadonlyMap<string, OperatorKey> {
  if (operatorKeys) return operatorKeys;
  const map = new Map<string, OperatorKey>();
  const raw = (process.env.KLETIA_OPERATOR_API_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let ignored = 0;
  for (const key of raw) {
    if (key.length < MIN_OPERATOR_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/u.test(key)) {
      ignored += 1;
      continue;
    }
    const hash = sha256Hex(key);
    map.set(hash, { id: `op_${hash.slice(0, 16)}`, name: `operator-${map.size + 1}` });
  }
  if (ignored > 0) {
    console.warn(`[platform] ignored ${ignored} KLETIA_OPERATOR_API_KEYS entr${ignored === 1 ? "y" : "ies"} (need ${MIN_OPERATOR_KEY_LENGTH}-${MAX_KEY_LENGTH} characters, no spaces).`);
  }
  operatorKeys = map;
  return operatorKeys;
}

/* ------------------------------------------------------------- issuance */

export function parseKeyRequest(body: unknown): { name: string } {
  const name = isRecord(body) && typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw invalidRequest("Provide { \"name\": \"…\" } with 1-64 printable characters.", [
      { path: "name", message: "Required, 1-64 printable characters." },
    ]);
  }
  return { name };
}

/** A fresh developer secret and its stored forms. */
export function newDeveloperSecret(): { readonly key: string; readonly hash: string; readonly last4: string } {
  const key = `${DEVELOPER_KEY_PREFIX}${randomBase62(32)}`;
  return { key, hash: sha256Hex(key), last4: key.slice(-4) };
}

/** A fresh agent secret (`kl_agt_`, recognisable in logs and secret scanners) and its stored forms. */
export function newAgentSecret(): { readonly key: string; readonly hash: string; readonly last4: string } {
  const key = `${AGENT_KEY_PREFIX}${randomBase62(32)}`;
  return { key, hash: sha256Hex(key), last4: key.slice(-4) };
}

/** A new secret of the same kind as the key it replaces. */
export function newSecretFor(record: Pick<ApiKeyRecord, "kind">): { readonly key: string; readonly hash: string; readonly last4: string } {
  return keyKindOf(record) === "agent" ? newAgentSecret() : newDeveloperSecret();
}

export interface IssuedAgentKey extends IssuedApiKey {
  readonly kind: "agent";
  readonly parentId: string;
  readonly lineage: readonly string[];
  readonly depth: number;
  readonly expiresAt: string;
}

/**
 * Issues an agent key under `parent` (the caller checked the parent's
 * project, liveness, depth and expiry). Refuses (409 AGENT_KEY_LIMIT_REACHED)
 * when the project already holds `maxActiveAgents` active agent keys.
 */
export async function issueAgentKey(
  name: string,
  parent: Pick<ApiKeyRecord, "id" | "projectId" | "lineage">,
  expiresAt: string,
  maxActiveAgents: number,
  now = Date.now(),
): Promise<IssuedAgentKey> {
  const secret = newAgentSecret();
  const id = `key_${randomHex(12)}`;
  const lineage = [...(parent.lineage ?? []), parent.id];
  const record: ApiKeyRecord = {
    id,
    name,
    tier: "developer",
    createdAt: new Date(now).toISOString(),
    revokedAt: null,
    projectId: parent.projectId,
    last4: secret.last4,
    rotatedAt: null,
    previousExpiresAt: null,
    lastUsedAt: null,
    kind: "agent",
    parentId: parent.id,
    lineage,
    expiresAt,
  };
  await apiKeyStore().insertAgent(record, secret.hash, maxActiveAgents, now);
  return { id, name, tier: "developer", createdAt: record.createdAt, key: secret.key, kind: "agent", parentId: parent.id, lineage, depth: lineage.length, expiresAt };
}

/**
 * Issues a developer key. Without `project` it starts a new project; with one
 * it joins it, refusing when the project already holds `project.maxActive`
 * active keys.
 */
export async function issueDeveloperKey(name: string, project?: { readonly id: string; readonly maxActive: number }): Promise<IssuedApiKey> {
  const secret = newDeveloperSecret();
  const id = `key_${randomHex(12)}`;
  const record: ApiKeyRecord = {
    id,
    name,
    tier: "developer",
    createdAt: new Date().toISOString(),
    revokedAt: null,
    projectId: project?.id ?? id,
    last4: secret.last4,
    rotatedAt: null,
    previousExpiresAt: null,
    lastUsedAt: null,
  };
  await apiKeyStore().insert(record, secret.hash, project?.maxActive);
  return { id: record.id, name: record.name, tier: record.tier, createdAt: record.createdAt, key: secret.key };
}

/* --------------------------------------------------------------- lookup */

interface CachedLookup {
  readonly match: ApiKeyMatch;
  readonly expiresAt: number;
}

/** How long a verified key is trusted without re-reading the store (bounds cross-instance revocation latency). */
export const KEY_CACHE_TTL_MS = 15_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_CACHED = 10_000;
/** Issued keys (valid or revoked). */
const lookupCache = new Map<string, CachedLookup>();
/** Key id -> hashes cached for it, so rotation and revocation purge this instance at once. */
const cachedHashesById = new Map<string, Set<string>>();
/** Unknown keys -> expiry, kept apart so random keys cannot evict issued ones. */
const unknownKeys = new Map<string, number>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheMatch(keyHash: string, match: ApiKeyMatch, now: number): void {
  const graceEnd = match.viaPrevious && match.record.previousExpiresAt ? Date.parse(match.record.previousExpiresAt) : Number.POSITIVE_INFINITY;
  // An expiring key is re-read when it expires (ancestors: within the cache TTL).
  const keyEnd = match.record.expiresAt ? Date.parse(match.record.expiresAt) : Number.POSITIVE_INFINITY;
  remember(lookupCache, keyHash, { match, expiresAt: Math.min(now + KEY_CACHE_TTL_MS, graceEnd, keyEnd) });
  let hashes = cachedHashesById.get(match.record.id);
  if (!hashes) {
    hashes = new Set();
    remember(cachedHashesById, match.record.id, hashes);
  }
  hashes.add(keyHash);
  // Hashes evicted from the lookup cache are dropped from the index lazily.
  for (const hash of hashes) if (!lookupCache.has(hash)) hashes.delete(hash);
}

/** Drops every cached verification of a key on this instance (after rotation or revocation). */
export function forgetCachedKey(id: string): void {
  for (const hash of cachedHashesById.get(id) ?? []) lookupCache.delete(hash);
  cachedHashesById.delete(id);
  revocationCache.delete(id);
}

/** Key id -> whether it is revoked, for webhook routing (same TTL as verified keys). */
const revocationCache = new Map<string, { readonly revoked: boolean; readonly expiresAt: number }>();

/**
 * Whether the key with this id was revoked. Operator and unknown ids are not.
 * Revocation is seen at once on the instance that handled it and within 15 s
 * elsewhere; a store failure throws (callers fail closed).
 */
export async function isKeyRevoked(id: string): Promise<boolean> {
  const now = Date.now();
  const cached = revocationCache.get(id);
  if (cached && cached.expiresAt > now) return cached.revoked;
  const revoked = Boolean((await apiKeyStore().findById(id))?.revokedAt);
  remember(revocationCache, id, { revoked, expiresAt: now + KEY_CACHE_TTL_MS });
  return revoked;
}

/*
 * Store lookups for uncached developer keys, per client IP and 1-minute
 * window, at the public tier limit. The budget is taken before the store is
 * queried and given back when the key turns out to be valid, so cache hits and
 * valid keys cost nothing while unknown keys (or a failing store) cannot push
 * more than the limit of queries per IP into the shared pool.
 */
const LOOKUP_WINDOW_MS = 60_000;

interface LookupBudget {
  used: number;
  readonly windowStart: number;
}

const lookupBudgets = new Map<string, LookupBudget>();

/** Takes one lookup from the client's budget; throws 429 when it is spent. */
function reserveLookup(client: string, now: number): LookupBudget {
  let budget = lookupBudgets.get(client);
  if (!budget || now - budget.windowStart >= LOOKUP_WINDOW_MS) {
    budget = { used: 0, windowStart: now };
    remember(lookupBudgets, client, budget);
  }
  if (budget.used >= TIER_LIMITS.public) {
    const seconds = Math.max(1, Math.ceil((budget.windowStart + LOOKUP_WINDOW_MS - now) / 1000));
    throw new HttpError(429, "RATE_LIMITED", `Too many unrecognised API keys from this address. Retry in ${seconds}s.`, {
      headers: { "Retry-After": String(seconds) },
    });
  }
  budget.used += 1;
  return budget;
}

async function findDeveloperKey(keyHash: string, client: string, now: number): Promise<ApiKeyMatch | null> {
  const cached = lookupCache.get(keyHash);
  if (cached && cached.expiresAt > now) return cached.match;
  const unknownUntil = unknownKeys.get(keyHash);
  if (unknownUntil !== undefined && unknownUntil > now) return null;
  const budget = reserveLookup(client, now);
  const match = await apiKeyStore().findByHash(keyHash, now);
  if (match) {
    if (!match.record.revokedAt) budget.used = Math.max(0, budget.used - 1);
    unknownKeys.delete(keyHash);
    cacheMatch(keyHash, match, now);
  } else {
    lookupCache.delete(keyHash);
    remember(unknownKeys, keyHash, now + NEGATIVE_TTL_MS);
  }
  return match;
}

function invalidKey(message = "The API key is invalid or revoked."): HttpError {
  return new HttpError(401, "INVALID_API_KEY", message);
}

/** Extracts the presented credential. Returns null when none was sent; throws 401 on a malformed header. */
function presentedKey(authorization: string | undefined, headerKey: string | undefined): string | null {
  let bearer: string | null = null;
  if (authorization !== undefined) {
    const match = /^Bearer[ ]+([^\s]+)[ ]*$/iu.exec(authorization);
    if (!match?.[1]) {
      throw new HttpError(401, "INVALID_AUTHORIZATION", "Authorization must be \"Bearer <api key>\".");
    }
    bearer = match[1];
  }
  const direct = headerKey?.trim() || null;
  if (bearer && direct && bearer !== direct) {
    throw new HttpError(401, "INVALID_AUTHORIZATION", "Authorization and X-Kletia-Key carry different keys.");
  }
  const key = bearer ?? direct;
  if (key !== null && key.length > MAX_KEY_LENGTH) throw invalidKey();
  return key;
}

/**
 * Resolves the caller's tier. Never responds itself: a failed credential is
 * recorded on the request and rejected by `enforceAuthentication` after the
 * rate limiter has counted it against the caller's IP. An uncached key is
 * looked up in the store only while the IP has lookup budget left (429
 * otherwise), so throttled requests never reach Postgres.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const key = presentedKey(req.get("authorization"), req.get("x-kletia-key"));
      if (key === null) return;
      const hash = sha256Hex(key);
      const operator = loadOperatorKeys().get(hash);
      if (operator) {
        setAuth(req, { tier: "operator", keyId: operator.id });
        return;
      }
      const agentKey = AGENT_KEY_PATTERN.test(key);
      if (!DEVELOPER_KEY_PATTERN.test(key) && !agentKey) {
        setAuth(req, { tier: "public", rejection: invalidKey() });
        return;
      }
      const now = Date.now();
      const match = await findDeveloperKey(hash, clientIp(req), now);
      if (!match || match.record.revokedAt) {
        setAuth(req, { tier: "public", rejection: invalidKey() });
        return;
      }
      const { record } = match;
      // A key whose own expiry passed, or whose ancestor is revoked or expired, never authenticates.
      if (match.active === false || !keyLive(record, now) || (keyKindOf(record) === "agent") !== agentKey) {
        setAuth(req, { tier: "public", rejection: invalidKey(record.expiresAt && Date.parse(record.expiresAt) <= now ? "The API key expired." : undefined) });
        return;
      }
      const kind = keyKindOf(record);
      setAuth(req, {
        tier: record.tier,
        keyId: record.id,
        projectId: record.projectId,
        secretHash: hash,
        keyKind: kind,
        ...(kind === "agent" ? { lineage: [...(record.lineage ?? [])] } : {}),
        ...(match.viaPrevious ? { viaPreviousSecret: true as const } : {}),
      });
    } catch (error) {
      setAuth(req, {
        tier: "public",
        rejection: error instanceof HttpError || error instanceof PlatformError
          ? error
          : new PlatformError("STORE_UNAVAILABLE", "API key verification is temporarily unavailable.", 503),
      });
    }
  })().then(() => next(), next);
};

/** Rejects requests whose credential failed (runs after the rate limiter). */
export const enforceAuthentication: RequestHandler = (req, res, next) => {
  const { rejection } = authOf(req);
  if (rejection) {
    sendError(req, res, rejection);
    return;
  }
  next();
};

/** Route guard: developer or operator key required. */
export const requireApiKey: RequestHandler = (req, res, next) => {
  const auth = authOf(req);
  if (auth.tier === "public" || !auth.keyId) {
    sendError(
      req,
      res,
      new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key. Issue one with POST /v1/keys and send it as Authorization: Bearer <key>."),
    );
    return;
  }
  next();
};
