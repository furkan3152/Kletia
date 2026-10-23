/**
 * Storage of sub-agent requests (docs/platform/subagents.md): one row per
 * request, its owner-wallet challenge (only the nonce's SHA-256 and the exact
 * message) and its claim token's SHA-256. No secret is ever stored: the
 * minted key's secret is set at claim time and returned once.
 *
 * Every state change is one conditional write (`from` statuses), so a
 * request is decided, minted and claimed by a single winner. Postgres
 * (`kletia_subagent_requests`) with KLETIA_DATABASE_URL; memory otherwise
 * (one instance only).
 */
import type { AccountWalletKind, PolicyDocument, SubagentDecision, SubagentRequestStatus } from "@kletia/core";
import type pg from "pg";
import { PlatformError } from "../../errors.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";

export type SubagentDecider =
  | { readonly kind: "wallet"; readonly walletKind: AccountWalletKind; readonly address: string }
  | { readonly kind: "key"; readonly keyId: string };

export interface SubagentChallenge {
  readonly nonceHash: string;
  /** The exact text the wallet signs. */
  readonly message: string;
  readonly origin: string;
  readonly walletKind: AccountWalletKind;
  /** Stored form: lower-case EVM address or base58 Solana address. */
  readonly address: string;
  readonly chainId: number | null;
  readonly decision: SubagentDecision;
  readonly expiresAt: string;
}

export interface SubagentRequestRecord {
  /** `sar_…` */
  readonly id: string;
  /** Raw project id (`key_…`). */
  readonly projectId: string;
  readonly parentKeyId: string;
  readonly name: string;
  readonly purpose: string;
  /** The rule book to mint (permissions written out). */
  readonly policy: PolicyDocument;
  readonly policyHash: string;
  readonly keyExpiresAt: string;
  readonly status: SubagentRequestStatus;
  readonly createdAt: string;
  /** When an open request lapses. */
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: SubagentDecider | null;
  readonly childKeyId: string | null;
  readonly claimTokenHash: string;
  readonly claimedAt: string | null;
  readonly challenge: SubagentChallenge | null;
  /** Why a request was cancelled or lapsed (`parent_inactive`, `parent_narrowed`, `claim_window`, `mint_failed`). */
  readonly reason: string | null;
}

export type SubagentPatch = Partial<Pick<SubagentRequestRecord, "decidedAt" | "decidedBy" | "childKeyId" | "claimedAt" | "reason">>;

export interface SubagentRequestStore {
  readonly kind: "memory" | "postgres";
  /** Inserts a pending request unless the parent already has `maxOpen` open ones (SUBAGENT_LIMIT_REACHED). Serialised per parent. */
  create(record: SubagentRequestRecord, maxOpen: number): Promise<void>;
  get(id: string): Promise<SubagentRequestRecord | null>;
  /** Requests of these parents (null: the whole project), newest first. */
  list(projectId: string, parentKeyIds: readonly string[] | null, limit: number): Promise<SubagentRequestRecord[]>;
  /** Open requests of these projects (pending, not lapsed at `now`). */
  countPending(projectIds: readonly string[], now: number): Promise<number>;
  /** Sets the challenge of a pending request (replacing any earlier one); false when it is not pending. */
  setChallenge(id: string, challenge: SubagentChallenge): Promise<boolean>;
  /** Clears and returns the challenge when its nonce matches, it is unexpired and the request is pending; else null. Single use. */
  consumeChallenge(id: string, nonceHash: string, now: number): Promise<SubagentChallenge | null>;
  /** Moves a request whose status is one of `from` to `to` with `patch`; the new record, or null when another write won. */
  transition(id: string, from: readonly SubagentRequestStatus[], to: SubagentRequestStatus, patch: SubagentPatch): Promise<SubagentRequestRecord | null>;
}

export function subagentLimitReached(message: string): PlatformError {
  return new PlatformError("SUBAGENT_LIMIT_REACHED", message, 409);
}

const openLimitMessage = (max: number) => `A parent has at most ${max} open sub-agent requests; wait for a decision first.`;

/* ================================================================ memory */

export class MemorySubagentRequestStore implements SubagentRequestStore {
  readonly kind = "memory" as const;
  private readonly byId = new Map<string, SubagentRequestRecord>();

  constructor(private readonly maxRecords = 10_000) {}

  async create(record: SubagentRequestRecord, maxOpen: number): Promise<void> {
    const open = [...this.byId.values()].filter((entry) => entry.parentKeyId === record.parentKeyId && entry.status === "pending" && Date.parse(entry.expiresAt) > Date.parse(record.createdAt));
    if (open.length >= maxOpen) throw subagentLimitReached(openLimitMessage(maxOpen));
    this.byId.set(record.id, record);
    while (this.byId.size > this.maxRecords) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  async get(id: string): Promise<SubagentRequestRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async list(projectId: string, parentKeyIds: readonly string[] | null, limit: number): Promise<SubagentRequestRecord[]> {
    return [...this.byId.values()]
      .filter((record) => record.projectId === projectId && (parentKeyIds === null || parentKeyIds.includes(record.parentKeyId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async countPending(projectIds: readonly string[], now: number): Promise<number> {
    return [...this.byId.values()].filter((record) => projectIds.includes(record.projectId) && record.status === "pending" && Date.parse(record.expiresAt) > now).length;
  }

  async setChallenge(id: string, challenge: SubagentChallenge): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.status !== "pending") return false;
    this.byId.set(id, { ...record, challenge });
    return true;
  }

  async consumeChallenge(id: string, nonceHash: string, now: number): Promise<SubagentChallenge | null> {
    const record = this.byId.get(id);
    const challenge = record?.challenge;
    if (!record || !challenge || record.status !== "pending" || challenge.nonceHash !== nonceHash || Date.parse(challenge.expiresAt) <= now) return null;
    this.byId.set(id, { ...record, challenge: null });
    return challenge;
  }

  async transition(id: string, from: readonly SubagentRequestStatus[], to: SubagentRequestStatus, patch: SubagentPatch): Promise<SubagentRequestRecord | null> {
    const record = this.byId.get(id);
    if (!record || !from.includes(record.status)) return null;
    const next: SubagentRequestRecord = { ...record, ...patch, status: to, ...(to === "pending" ? {} : { challenge: null }) };
    this.byId.set(id, next);
    return next;
  }
}

/* =============================================================== postgres */

const SUBAGENTS_SCHEMA = {
  name: "kletia_subagent_requests",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_subagent_requests (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_key_id text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  policy jsonb NOT NULL,
  policy_hash text NOT NULL,
  key_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'claimed', 'denied', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by jsonb,
  child_key_id text,
  claim_token_hash text NOT NULL,
  claimed_at timestamptz,
  challenge jsonb,
  reason text
);
CREATE INDEX IF NOT EXISTS kletia_subagent_requests_parent_idx ON kletia_subagent_requests (parent_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_subagent_requests_project_idx ON kletia_subagent_requests (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_subagent_requests_pending_idx ON kletia_subagent_requests (project_id) WHERE status = 'pending';`,
} as const;

interface SubagentRow {
  id: string;
  project_id: string;
  parent_key_id: string;
  name: string;
  purpose: string;
  policy: PolicyDocument;
  policy_hash: string;
  key_expires_at: Date | string;
  status: SubagentRequestStatus;
  created_at: Date | string;
  expires_at: Date | string;
  decided_at: Date | string | null;
  decided_by: SubagentDecider | null;
  child_key_id: string | null;
  claim_token_hash: string;
  claimed_at: Date | string | null;
  challenge: SubagentChallenge | null;
  reason: string | null;
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

function fromRow(row: SubagentRow): SubagentRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    parentKeyId: row.parent_key_id,
    name: row.name,
    purpose: row.purpose,
    policy: row.policy,
    policyHash: row.policy_hash,
    keyExpiresAt: iso(row.key_expires_at),
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    decidedAt: isoOrNull(row.decided_at),
    decidedBy: row.decided_by,
    childKeyId: row.child_key_id,
    claimTokenHash: row.claim_token_hash,
    claimedAt: isoOrNull(row.claimed_at),
    challenge: row.challenge,
    reason: row.reason,
  };
}

export class PostgresSubagentRequestStore implements SubagentRequestStore {
  readonly kind = "postgres" as const;

  async create(record: SubagentRequestRecord, maxOpen: number): Promise<void> {
    await dbTransaction(SUBAGENTS_SCHEMA, async (client: Pick<pg.PoolClient, "query">) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_subagent:${record.parentKeyId}`]);
      const open = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_subagent_requests WHERE parent_key_id = $1 AND status = 'pending' AND expires_at > $2",
        [record.parentKeyId, record.createdAt],
      );
      if (Number(open.rows[0]?.count ?? 0) >= maxOpen) throw subagentLimitReached(openLimitMessage(maxOpen));
      await client.query(
        `INSERT INTO kletia_subagent_requests (id, project_id, parent_key_id, name, purpose, policy, policy_hash, key_expires_at, status, created_at, expires_at, claim_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'pending', $9, $10, $11)`,
        [record.id, record.projectId, record.parentKeyId, record.name, record.purpose, JSON.stringify(record.policy), record.policyHash, record.keyExpiresAt, record.createdAt, record.expiresAt, record.claimTokenHash],
      );
    });
  }

  async get(id: string): Promise<SubagentRequestRecord | null> {
    const result = await dbQuery<SubagentRow>(SUBAGENTS_SCHEMA, "SELECT * FROM kletia_subagent_requests WHERE id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async list(projectId: string, parentKeyIds: readonly string[] | null, limit: number): Promise<SubagentRequestRecord[]> {
    const result = await dbQuery<SubagentRow>(
      SUBAGENTS_SCHEMA,
      `SELECT * FROM kletia_subagent_requests WHERE project_id = $1 AND ($2::text[] IS NULL OR parent_key_id = ANY($2::text[]))
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, parentKeyIds === null ? null : [...parentKeyIds], limit],
    );
    return result.rows.map(fromRow);
  }

  async countPending(projectIds: readonly string[], now: number): Promise<number> {
    if (projectIds.length === 0) return 0;
    const result = await dbQuery<{ count: string }>(
      SUBAGENTS_SCHEMA,
      "SELECT count(*)::text AS count FROM kletia_subagent_requests WHERE project_id = ANY($1::text[]) AND status = 'pending' AND expires_at > $2",
      [[...projectIds], new Date(now).toISOString()],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async setChallenge(id: string, challenge: SubagentChallenge): Promise<boolean> {
    const result = await dbQuery(SUBAGENTS_SCHEMA, "UPDATE kletia_subagent_requests SET challenge = $2::jsonb WHERE id = $1 AND status = 'pending'", [id, JSON.stringify(challenge)]);
    return (result.rowCount ?? 0) > 0;
  }

  async consumeChallenge(id: string, nonceHash: string, now: number): Promise<SubagentChallenge | null> {
    // The returned row is the one before the update (FROM the locked old row).
    const result = await dbQuery<{ challenge: SubagentChallenge }>(
      SUBAGENTS_SCHEMA,
      `UPDATE kletia_subagent_requests AS target SET challenge = NULL
       FROM (SELECT id, challenge FROM kletia_subagent_requests WHERE id = $1 FOR UPDATE) AS old
       WHERE target.id = old.id AND target.status = 'pending' AND old.challenge->>'nonceHash' = $2 AND (old.challenge->>'expiresAt')::timestamptz > $3
       RETURNING old.challenge`,
      [id, nonceHash, new Date(now).toISOString()],
    );
    return result.rows[0]?.challenge ?? null;
  }

  async transition(id: string, from: readonly SubagentRequestStatus[], to: SubagentRequestStatus, patch: SubagentPatch): Promise<SubagentRequestRecord | null> {
    const result = await dbQuery<SubagentRow>(
      SUBAGENTS_SCHEMA,
      `UPDATE kletia_subagent_requests SET status = $3,
         decided_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE decided_at END,
         decided_by = CASE WHEN $6::boolean THEN $7::jsonb ELSE decided_by END,
         child_key_id = CASE WHEN $8::boolean THEN $9 ELSE child_key_id END,
         claimed_at = CASE WHEN $10::boolean THEN $11::timestamptz ELSE claimed_at END,
         reason = CASE WHEN $12::boolean THEN $13 ELSE reason END,
         challenge = CASE WHEN $3 = 'pending' THEN challenge ELSE NULL END
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [
        id, [...from], to,
        "decidedAt" in patch, patch.decidedAt ?? null,
        "decidedBy" in patch, patch.decidedBy === undefined || patch.decidedBy === null ? null : JSON.stringify(patch.decidedBy),
        "childKeyId" in patch, patch.childKeyId ?? null,
        "claimedAt" in patch, patch.claimedAt ?? null,
        "reason" in patch, patch.reason ?? null,
      ],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
}

/* ================================================================ selection */

let store: SubagentRequestStore | null = null;

export function subagentRequestStore(): SubagentRequestStore {
  store ??= platformDatabaseUrl() ? new PostgresSubagentRequestStore() : new MemorySubagentRequestStore();
  return store;
}
