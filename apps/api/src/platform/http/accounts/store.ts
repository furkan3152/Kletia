/**
 * Storage of developer accounts: single-use sign-in nonces, sessions (only
 * the SHA-256 of a token is stored), project ownership (one wallet per
 * project) and the account audit log.
 *
 * Postgres (`kletia_account_nonces`, `kletia_account_sessions`,
 * `kletia_project_owners`, `kletia_account_audit`) when KLETIA_DATABASE_URL is
 * set; in memory otherwise, outside production only: in production without a
 * database every account route answers 503 STORE_UNAVAILABLE, because
 * ownership kept in memory would be lost on the next restart.
 */
import { type AccountActivityAction, type AccountActivityView, type AccountProjectSource, type AccountWalletKind } from "@kletia/core";
import type pg from "pg";
import { PlatformError } from "../../errors.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";
import { randomHex } from "../secrets.js";

export interface AccountNonceRecord {
  readonly nonceHash: string;
  readonly walletKind: AccountWalletKind;
  /** Stored form: lower-case EVM address, or the base58 Solana address. */
  readonly address: string;
  readonly chainId: number | null;
  readonly origin: string;
  readonly message: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AccountSessionRecord {
  readonly idHash: string;
  readonly walletKind: AccountWalletKind;
  readonly address: string;
  readonly chainId: number | null;
  readonly origin: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export interface ProjectOwnerRecord {
  /** Raw project id (`key_…`). */
  readonly projectId: string;
  readonly walletKind: AccountWalletKind;
  readonly address: string;
  readonly source: AccountProjectSource;
  readonly createdAt: string;
}

export type AccountAuditOutcome = "ok" | "denied" | "error";

export interface AccountAuditInput {
  readonly walletKind: AccountWalletKind | null;
  readonly address: string | null;
  readonly action: AccountActivityAction;
  readonly outcome: AccountAuditOutcome;
  readonly projectId: string | null;
  readonly keyId: string | null;
  readonly target: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly ipHash: string | null;
}

export interface ClaimResult {
  /** The project's owner after the call (this wallet, or the one that owned it already). */
  readonly owner: ProjectOwnerRecord;
  readonly inserted: boolean;
}

export interface AccountStore {
  readonly kind: "memory" | "postgres";
  createNonce(record: AccountNonceRecord): Promise<void>;
  /** Marks the nonce used and returns it, or null when unknown, used or expired. */
  consumeNonce(nonceHash: string, now: Date): Promise<AccountNonceRecord | null>;
  createSession(record: AccountSessionRecord): Promise<void>;
  getSession(idHash: string): Promise<AccountSessionRecord | null>;
  touchSession(idHash: string, at: Date): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  /**
   * Records `record` as the project's owner when it has none, refusing (409
   * PROJECT_LIMIT_REACHED) when the wallet already owns `maxPerWallet`
   * projects. Serialised per wallet and per project.
   */
  claimProject(record: ProjectOwnerRecord, maxPerWallet: number): Promise<ClaimResult>;
  ownerOf(projectId: string): Promise<ProjectOwnerRecord | null>;
  /** The wallet's projects, oldest first. */
  projectsOf(walletKind: AccountWalletKind, address: string): Promise<ProjectOwnerRecord[]>;
  /** Removes an ownership row (only used to undo a project whose creation failed). */
  releaseProject(projectId: string, walletKind: AccountWalletKind, address: string): Promise<void>;
  writeAudit(input: AccountAuditInput, at: Date): Promise<{ readonly id: string }>;
  /** The wallet's newest audit rows. */
  listAudit(walletKind: AccountWalletKind, address: string, limit: number): Promise<AccountActivityView[]>;
}

export function projectLimitReached(max: number): PlatformError {
  return new PlatformError("PROJECT_LIMIT_REACHED", `A wallet owns at most ${max} projects.`, 409);
}

function auditId(): string {
  return `aud_${randomHex(12)}`;
}

function projectScope(projectId: string | null): string | null {
  return projectId ? `prj_${projectId}` : null;
}

/* ================================================================ memory */

interface StoredNonce {
  readonly record: AccountNonceRecord;
  used: boolean;
}

interface StoredAudit extends AccountAuditInput {
  readonly id: string;
  readonly at: Date;
}

const MEMORY_MAX_NONCES = 10_000;
const MEMORY_MAX_SESSIONS = 10_000;
const MEMORY_MAX_AUDIT = 5_000;

function bound<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export class MemoryAccountStore implements AccountStore {
  readonly kind = "memory" as const;
  private readonly nonces = new Map<string, StoredNonce>();
  private readonly sessions = new Map<string, AccountSessionRecord>();
  private readonly owners = new Map<string, ProjectOwnerRecord>();
  private readonly audit: StoredAudit[] = [];
  /** Test hook: makes writeAudit fail like an unavailable database. */
  failAuditWrites = false;

  async createNonce(record: AccountNonceRecord): Promise<void> {
    if (this.nonces.has(record.nonceHash)) throw new PlatformError("STORE_UNAVAILABLE", "Nonce collision; request a new message.", 503);
    this.nonces.set(record.nonceHash, { record, used: false });
    bound(this.nonces, MEMORY_MAX_NONCES);
  }

  async consumeNonce(nonceHash: string, now: Date): Promise<AccountNonceRecord | null> {
    const stored = this.nonces.get(nonceHash);
    if (!stored || stored.used || stored.record.expiresAt.getTime() <= now.getTime()) return null;
    stored.used = true;
    return stored.record;
  }

  async createSession(record: AccountSessionRecord): Promise<void> {
    this.sessions.set(record.idHash, record);
    bound(this.sessions, MEMORY_MAX_SESSIONS);
  }

  async getSession(idHash: string): Promise<AccountSessionRecord | null> {
    return this.sessions.get(idHash) ?? null;
  }

  async touchSession(idHash: string, at: Date): Promise<void> {
    const record = this.sessions.get(idHash);
    if (record) this.sessions.set(idHash, { ...record, lastSeenAt: at });
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async claimProject(record: ProjectOwnerRecord, maxPerWallet: number): Promise<ClaimResult> {
    const existing = this.owners.get(record.projectId);
    if (existing) return { owner: existing, inserted: false };
    const owned = [...this.owners.values()].filter((owner) => owner.walletKind === record.walletKind && owner.address === record.address).length;
    if (owned >= maxPerWallet) throw projectLimitReached(maxPerWallet);
    this.owners.set(record.projectId, record);
    return { owner: record, inserted: true };
  }

  async ownerOf(projectId: string): Promise<ProjectOwnerRecord | null> {
    return this.owners.get(projectId) ?? null;
  }

  async projectsOf(walletKind: AccountWalletKind, address: string): Promise<ProjectOwnerRecord[]> {
    return [...this.owners.values()]
      .filter((owner) => owner.walletKind === walletKind && owner.address === address)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async releaseProject(projectId: string, walletKind: AccountWalletKind, address: string): Promise<void> {
    const owner = this.owners.get(projectId);
    if (owner && owner.walletKind === walletKind && owner.address === address) this.owners.delete(projectId);
  }

  async writeAudit(input: AccountAuditInput, at: Date): Promise<{ readonly id: string }> {
    if (this.failAuditWrites) throw new PlatformError("STORE_UNAVAILABLE", "Platform storage is temporarily unavailable.", 503);
    const id = auditId();
    this.audit.push({ ...input, id, at });
    if (this.audit.length > MEMORY_MAX_AUDIT) this.audit.splice(0, this.audit.length - MEMORY_MAX_AUDIT);
    return { id };
  }

  async listAudit(walletKind: AccountWalletKind, address: string, limit: number): Promise<AccountActivityView[]> {
    return this.audit
      .filter((row) => row.walletKind === walletKind && row.address === address)
      .slice(-limit)
      .reverse()
      .map((row) => ({ id: row.id, at: row.at.toISOString(), action: row.action, outcome: row.outcome, projectId: projectScope(row.projectId), keyId: row.keyId }));
  }

  /** Every audit row (tests). */
  auditRows(): readonly StoredAudit[] {
    return [...this.audit];
  }
}

/* ============================================================== postgres */

export const ACCOUNTS_SCHEMA = {
  name: "accounts",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_account_nonces (
  nonce_hash text PRIMARY KEY, wallet_kind text NOT NULL CHECK (wallet_kind IN ('evm','solana')),
  address text NOT NULL, chain_id integer, origin text NOT NULL, message text NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE INDEX IF NOT EXISTS kletia_account_nonces_expires ON kletia_account_nonces (expires_at);
CREATE TABLE IF NOT EXISTS kletia_account_sessions (
  id_hash text PRIMARY KEY, wallet_kind text NOT NULL CHECK (wallet_kind IN ('evm','solana')),
  address text NOT NULL, chain_id integer, origin text NOT NULL,
  created_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS kletia_account_sessions_expires ON kletia_account_sessions (expires_at);
CREATE TABLE IF NOT EXISTS kletia_project_owners (
  project_id text PRIMARY KEY, wallet_kind text NOT NULL CHECK (wallet_kind IN ('evm','solana')),
  address text NOT NULL, source text NOT NULL CHECK (source IN ('created','claimed')),
  created_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS kletia_project_owners_wallet ON kletia_project_owners (wallet_kind, address);
CREATE TABLE IF NOT EXISTS kletia_account_audit (
  id text PRIMARY KEY, at timestamptz NOT NULL, wallet_kind text, address text,
  action text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('ok','denied','error')),
  project_id text, key_id text, target jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text NOT NULL, ip_hash text);
CREATE INDEX IF NOT EXISTS kletia_account_audit_wallet ON kletia_account_audit (wallet_kind, address, at DESC);
`,
} as const;

type Row = Record<string, unknown>;

async function query<R extends pg.QueryResultRow = Row>(text: string, values: readonly unknown[]): Promise<pg.QueryResult<R>> {
  return dbQuery<R>(ACCOUNTS_SCHEMA, text, values);
}

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const walletKindOf = (value: unknown): AccountWalletKind => (value === "solana" ? "solana" : "evm");
const chainIdOf = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function nonceRow(row: Row): AccountNonceRecord {
  return {
    nonceHash: String(row.nonce_hash),
    walletKind: walletKindOf(row.wallet_kind),
    address: String(row.address),
    chainId: chainIdOf(row.chain_id),
    origin: String(row.origin),
    message: String(row.message),
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

function sessionRow(row: Row): AccountSessionRecord {
  return {
    idHash: String(row.id_hash),
    walletKind: walletKindOf(row.wallet_kind),
    address: String(row.address),
    chainId: chainIdOf(row.chain_id),
    origin: String(row.origin),
    createdAt: toDate(row.created_at),
    lastSeenAt: toDate(row.last_seen_at),
    expiresAt: toDate(row.expires_at),
  };
}

function ownerRow(row: Row): ProjectOwnerRecord {
  return {
    projectId: String(row.project_id),
    walletKind: walletKindOf(row.wallet_kind),
    address: String(row.address),
    source: row.source === "claimed" ? "claimed" : "created",
    createdAt: toDate(row.created_at).toISOString(),
  };
}

export class PostgresAccountStore implements AccountStore {
  readonly kind = "postgres" as const;

  async createNonce(record: AccountNonceRecord): Promise<void> {
    // Expired nonces go first (bounded by the index on expires_at).
    await query("DELETE FROM kletia_account_nonces WHERE expires_at < $1", [new Date(record.createdAt.getTime() - 60_000)]);
    const result = await query(
      `INSERT INTO kletia_account_nonces (nonce_hash, wallet_kind, address, chain_id, origin, message, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [record.nonceHash, record.walletKind, record.address, record.chainId, record.origin, record.message, record.createdAt, record.expiresAt],
    );
    if (result.rowCount !== 1) throw new PlatformError("STORE_UNAVAILABLE", "Nonce collision; request a new message.", 503);
  }

  async consumeNonce(nonceHash: string, now: Date): Promise<AccountNonceRecord | null> {
    const result = await query(
      "UPDATE kletia_account_nonces SET used_at = $2 WHERE nonce_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *",
      [nonceHash, now],
    );
    const row = result.rows[0];
    return row ? nonceRow(row) : null;
  }

  async createSession(record: AccountSessionRecord): Promise<void> {
    await query("DELETE FROM kletia_account_sessions WHERE expires_at < $1", [record.createdAt]);
    await query(
      `INSERT INTO kletia_account_sessions (id_hash, wallet_kind, address, chain_id, origin, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [record.idHash, record.walletKind, record.address, record.chainId, record.origin, record.createdAt, record.lastSeenAt, record.expiresAt],
    );
  }

  async getSession(idHash: string): Promise<AccountSessionRecord | null> {
    const result = await query("SELECT * FROM kletia_account_sessions WHERE id_hash = $1", [idHash]);
    const row = result.rows[0];
    return row ? sessionRow(row) : null;
  }

  async touchSession(idHash: string, at: Date): Promise<void> {
    await query("UPDATE kletia_account_sessions SET last_seen_at = GREATEST(last_seen_at, $2) WHERE id_hash = $1", [idHash, at]);
  }

  async deleteSession(idHash: string): Promise<void> {
    await query("DELETE FROM kletia_account_sessions WHERE id_hash = $1", [idHash]);
  }

  async claimProject(record: ProjectOwnerRecord, maxPerWallet: number): Promise<ClaimResult> {
    return dbTransaction(ACCOUNTS_SCHEMA, async (client) => {
      // One lock per wallet keeps its project cap; the primary key settles races on one project.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_project_owners:${record.walletKind}:${record.address}`]);
      const existing = await client.query<Row>("SELECT * FROM kletia_project_owners WHERE project_id = $1", [record.projectId]);
      if (existing.rows[0]) return { owner: ownerRow(existing.rows[0]), inserted: false };
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_project_owners WHERE wallet_kind = $1 AND address = $2",
        [record.walletKind, record.address],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxPerWallet) throw projectLimitReached(maxPerWallet);
      const inserted = await client.query(
        `INSERT INTO kletia_project_owners (project_id, wallet_kind, address, source, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id) DO NOTHING`,
        [record.projectId, record.walletKind, record.address, record.source, record.createdAt],
      );
      if (inserted.rowCount === 1) return { owner: record, inserted: true };
      const winner = await client.query<Row>("SELECT * FROM kletia_project_owners WHERE project_id = $1", [record.projectId]);
      if (!winner.rows[0]) throw new PlatformError("STORE_UNAVAILABLE", "Platform storage is temporarily unavailable.", 503);
      return { owner: ownerRow(winner.rows[0]), inserted: false };
    });
  }

  async ownerOf(projectId: string): Promise<ProjectOwnerRecord | null> {
    const result = await query("SELECT * FROM kletia_project_owners WHERE project_id = $1", [projectId]);
    const row = result.rows[0];
    return row ? ownerRow(row) : null;
  }

  async projectsOf(walletKind: AccountWalletKind, address: string): Promise<ProjectOwnerRecord[]> {
    const result = await query(
      "SELECT * FROM kletia_project_owners WHERE wallet_kind = $1 AND address = $2 ORDER BY created_at ASC, project_id ASC LIMIT 200",
      [walletKind, address],
    );
    return result.rows.map(ownerRow);
  }

  async releaseProject(projectId: string, walletKind: AccountWalletKind, address: string): Promise<void> {
    await query("DELETE FROM kletia_project_owners WHERE project_id = $1 AND wallet_kind = $2 AND address = $3", [projectId, walletKind, address]);
  }

  async writeAudit(input: AccountAuditInput, at: Date): Promise<{ readonly id: string }> {
    const id = auditId();
    await query(
      `INSERT INTO kletia_account_audit (id, at, wallet_kind, address, action, outcome, project_id, key_id, target, request_id, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [id, at, input.walletKind, input.address, input.action, input.outcome, input.projectId, input.keyId, JSON.stringify(input.target), input.requestId, input.ipHash],
    );
    return { id };
  }

  async listAudit(walletKind: AccountWalletKind, address: string, limit: number): Promise<AccountActivityView[]> {
    const result = await query(
      "SELECT id, at, action, outcome, project_id, key_id FROM kletia_account_audit WHERE wallet_kind = $1 AND address = $2 ORDER BY at DESC, id DESC LIMIT $3",
      [walletKind, address, limit],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      at: toDate(row.at).toISOString(),
      action: String(row.action) as AccountActivityAction,
      outcome: row.outcome === "denied" ? "denied" : row.outcome === "error" ? "error" : "ok",
      projectId: projectScope(row.project_id === null ? null : String(row.project_id)),
      keyId: row.key_id === null ? null : String(row.key_id),
    }));
  }
}

/* ============================================================= selection */

let store: AccountStore | null = null;

/** Postgres when configured; memory outside production; 503 in production without a database (fail closed). */
export function accountStore(): AccountStore {
  if (store) return store;
  if (platformDatabaseUrl()) store = new PostgresAccountStore();
  else if (process.env.NODE_ENV === "production") {
    throw new PlatformError("STORE_UNAVAILABLE", "Developer accounts need KLETIA_DATABASE_URL on this API.", 503);
  } else store = new MemoryAccountStore();
  return store;
}

/** Replaces the store (tests); null selects again from the environment on next use. */
export function setAccountStore(next: AccountStore | null): void {
  store = next;
}
