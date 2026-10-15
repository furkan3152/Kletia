/**
 * Postgres admin store (schema "admin", lazy DDL through dbQuery). Every
 * database error becomes 503 ADMIN_STORE_UNAVAILABLE without details.
 */
import type {
  AdminAuditEntry,
  AdminDeploymentRecord,
  AdminEvmNetwork,
  AdminNetworkProfile,
  AdminSafeProposal,
  AdminWalletKind,
} from "@kletia/core";
import type pg from "pg";
import { dbQuery } from "../../platform/http/db.js";
import { randomHex } from "../../platform/http/secrets.js";
import { AdminHttpError } from "../http/errors.js";
import type {
  AdminAuditInput,
  AdminDeploymentFilter,
  AdminFeeScanRecord,
  AdminNonceRecord,
  AdminProposalFilter,
  AdminSessionRecord,
  AdminStore,
} from "./types.js";

export const ADMIN_SCHEMA = {
  name: "admin",
  ddl: `
CREATE TABLE IF NOT EXISTS admin_nonces (
  nonce_hash text PRIMARY KEY, wallet_kind text NOT NULL CHECK (wallet_kind IN ('evm','solana')),
  address text NOT NULL, chain_id integer,
  origin text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('login','confirm')),
  message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash text PRIMARY KEY, wallet_kind text NOT NULL CHECK (wallet_kind IN ('evm','solana')),
  address text NOT NULL, chain_id integer, origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS admin_sessions_address ON admin_sessions (address);
CREATE TABLE IF NOT EXISTS admin_audit (
  id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), address text,
  action text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('ok','denied','error')),
  target jsonb NOT NULL DEFAULT '{}'::jsonb, request_id text NOT NULL, ip_hash text);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at DESC);
CREATE TABLE IF NOT EXISTS admin_deployments (
  id text PRIMARY KEY, target_id text NOT NULL, network text NOT NULL, chain_id integer NOT NULL,
  contract_id text NOT NULL, instance text, address text NOT NULL, tx_hash text NOT NULL,
  block bigint NOT NULL, deployer text NOT NULL, constructor_args jsonb NOT NULL,
  owner_kind text NOT NULL, expected_owner text, artifact_id text NOT NULL,
  artifact_masked_runtime_hash text NOT NULL, onchain_codehash text NOT NULL,
  checks jsonb NOT NULL, status text NOT NULL, notes text NOT NULL DEFAULT '',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address), UNIQUE (chain_id, tx_hash));
CREATE TABLE IF NOT EXISTS admin_network_profiles (
  network text PRIMARY KEY, owner text, guardian text, treasury text,
  eoa_owner_acknowledged boolean NOT NULL DEFAULT false,
  updated_by text, updated_at timestamptz);
CREATE TABLE IF NOT EXISTS admin_safe_proposals (
  id text PRIMARY KEY, network text NOT NULL, safe text NOT NULL, to_address text NOT NULL,
  value text NOT NULL, data text NOT NULL, nonce text NOT NULL, safe_tx_hash text NOT NULL,
  description text NOT NULL, action_id text, decoded jsonb, threshold integer NOT NULL,
  owners jsonb NOT NULL, signatures jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL, executed_tx_hash text, created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (network, safe_tx_hash));
CREATE TABLE IF NOT EXISTS admin_fee_scans (
  key text PRIMARY KEY, network text NOT NULL, address text NOT NULL,
  scanned_through_block bigint NOT NULL, totals jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
`,
} as const;

type Row = Record<string, unknown>;

async function query<R extends pg.QueryResultRow = Row>(text: string, values: readonly unknown[]): Promise<pg.QueryResult<R>> {
  return dbQuery<R>(ADMIN_SCHEMA, text, values);
}

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function nonceFrom(row: Row): AdminNonceRecord {
  return {
    nonceHash: String(row.nonce_hash), walletKind: row.wallet_kind as AdminWalletKind, address: String(row.address),
    chainId: nullableNumber(row.chain_id), origin: String(row.origin), purpose: row.purpose as AdminNonceRecord["purpose"],
    message: String(row.message), createdAt: date(row.created_at), expiresAt: date(row.expires_at),
  };
}

function sessionFrom(row: Row): AdminSessionRecord {
  return {
    idHash: String(row.id_hash), walletKind: row.wallet_kind as AdminWalletKind, address: String(row.address),
    chainId: nullableNumber(row.chain_id), origin: String(row.origin), createdAt: date(row.created_at),
    lastSeenAt: date(row.last_seen_at), expiresAt: date(row.expires_at),
  };
}

function auditFrom(row: Row): AdminAuditEntry {
  return {
    id: String(row.id), at: iso(row.at), address: row.address === null ? null : String(row.address), action: String(row.action),
    outcome: row.outcome as AdminAuditEntry["outcome"], target: (row.target ?? {}) as Record<string, string>, requestId: String(row.request_id),
  };
}

function deploymentFrom(row: Row): AdminDeploymentRecord {
  const base: AdminDeploymentRecord = {
    id: String(row.id), targetId: String(row.target_id), network: row.network as AdminEvmNetwork, chainId: Number(row.chain_id),
    contractId: row.contract_id as AdminDeploymentRecord["contractId"], address: String(row.address), txHash: String(row.tx_hash),
    block: String(row.block), deployer: String(row.deployer), constructorArgs: row.constructor_args as Record<string, string>,
    ownerKind: row.owner_kind as AdminDeploymentRecord["ownerKind"], expectedOwner: row.expected_owner === null ? null : String(row.expected_owner),
    artifactId: String(row.artifact_id), artifactMaskedRuntimeHash: String(row.artifact_masked_runtime_hash),
    onchainCodehash: String(row.onchain_codehash), checks: row.checks as AdminDeploymentRecord["checks"],
    status: row.status as AdminDeploymentRecord["status"], wired: false, notes: String(row.notes ?? ""),
    createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
  return row.instance ? { ...base, instance: String(row.instance) } : base;
}

function profileFrom(row: Row): AdminNetworkProfile {
  return {
    network: row.network as AdminEvmNetwork,
    owner: row.owner === null ? null : String(row.owner), guardian: row.guardian === null ? null : String(row.guardian),
    treasury: row.treasury === null ? null : String(row.treasury), eoaOwnerAcknowledged: Boolean(row.eoa_owner_acknowledged),
    updatedBy: row.updated_by === null ? null : String(row.updated_by), updatedAt: row.updated_at === null ? null : iso(row.updated_at),
  };
}

function proposalFrom(row: Row): AdminSafeProposal {
  return {
    id: String(row.id), network: row.network as AdminEvmNetwork, safe: String(row.safe), to: String(row.to_address),
    value: String(row.value), data: String(row.data), operation: 0, nonce: String(row.nonce), safeTxHash: String(row.safe_tx_hash),
    description: String(row.description), actionId: row.action_id === null ? null : String(row.action_id),
    decoded: (row.decoded ?? null) as AdminSafeProposal["decoded"], threshold: Number(row.threshold),
    owners: row.owners as string[], signatures: row.signatures as AdminSafeProposal["signatures"],
    status: row.status as AdminSafeProposal["status"], executedTxHash: row.executed_tx_hash === null ? null : String(row.executed_tx_hash),
    createdBy: String(row.created_by), createdAt: iso(row.created_at),
  };
}

export class PostgresAdminStore implements AdminStore {
  readonly kind = "postgres" as const;

  async createNonce(record: AdminNonceRecord): Promise<void> {
    await query(
      `INSERT INTO admin_nonces (nonce_hash, wallet_kind, address, chain_id, origin, purpose, message, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [record.nonceHash, record.walletKind, record.address, record.chainId, record.origin, record.purpose, record.message, record.createdAt, record.expiresAt],
    );
  }

  async consumeNonce(nonceHash: string, now: Date): Promise<AdminNonceRecord | null> {
    const result = await query(
      `UPDATE admin_nonces SET used_at = $2 WHERE nonce_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *`,
      [nonceHash, now],
    );
    const row = result.rows[0];
    return row ? nonceFrom(row) : null;
  }

  async pruneNonces(now: Date): Promise<void> {
    await query(`DELETE FROM admin_nonces WHERE expires_at < $1`, [new Date(now.getTime() - 60 * 60 * 1000)]);
  }

  async createSession(record: AdminSessionRecord): Promise<void> {
    await query(
      `INSERT INTO admin_sessions (id_hash, wallet_kind, address, chain_id, origin, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [record.idHash, record.walletKind, record.address, record.chainId, record.origin, record.createdAt, record.lastSeenAt, record.expiresAt],
    );
  }

  async getSession(idHash: string): Promise<AdminSessionRecord | null> {
    const row = (await query(`SELECT * FROM admin_sessions WHERE id_hash = $1`, [idHash])).rows[0];
    return row ? sessionFrom(row) : null;
  }

  async touchSession(idHash: string, at: Date): Promise<void> {
    await query(`UPDATE admin_sessions SET last_seen_at = $2 WHERE id_hash = $1`, [idHash, at]);
  }

  async deleteSession(idHash: string): Promise<void> {
    await query(`DELETE FROM admin_sessions WHERE id_hash = $1`, [idHash]);
  }

  async deleteSessionsOf(walletKind: AdminWalletKind, address: string): Promise<void> {
    await query(`DELETE FROM admin_sessions WHERE wallet_kind = $1 AND address = $2`, [walletKind, address]);
  }

  async writeAudit(input: AdminAuditInput, at: Date): Promise<AdminAuditEntry> {
    const row = (await query(
      `INSERT INTO admin_audit (id, at, address, action, outcome, target, request_id, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
      [`aud_${randomHex(12)}`, at, input.address, input.action, input.outcome, JSON.stringify(input.target), input.requestId, input.ipHash],
    )).rows[0];
    if (!row) throw new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "Admin storage is temporarily unavailable.");
    return auditFrom(row);
  }

  async listAudit(limit: number, before: Date | null): Promise<AdminAuditEntry[]> {
    const result = before
      ? await query(`SELECT * FROM admin_audit WHERE at < $1 ORDER BY at DESC, id DESC LIMIT $2`, [before, limit])
      : await query(`SELECT * FROM admin_audit ORDER BY at DESC, id DESC LIMIT $1`, [limit]);
    return result.rows.map(auditFrom);
  }

  async insertDeployment(record: AdminDeploymentRecord): Promise<void> {
    await dbInsertDeployment(record);
  }

  async updateDeployment(record: AdminDeploymentRecord): Promise<void> {
    await query(
      `UPDATE admin_deployments SET owner_kind = $2, expected_owner = $3, onchain_codehash = $4, checks = $5::jsonb,
         status = $6, notes = $7, updated_at = $8 WHERE id = $1`,
      [record.id, record.ownerKind, record.expectedOwner, record.onchainCodehash, JSON.stringify(record.checks), record.status, record.notes, new Date(record.updatedAt)],
    );
  }

  async getDeployment(id: string): Promise<AdminDeploymentRecord | null> {
    const row = (await query(`SELECT * FROM admin_deployments WHERE id = $1`, [id])).rows[0];
    return row ? deploymentFrom(row) : null;
  }

  async findDeploymentByTx(chainId: number, txHash: string): Promise<AdminDeploymentRecord | null> {
    const row = (await query(`SELECT * FROM admin_deployments WHERE chain_id = $1 AND tx_hash = $2`, [chainId, txHash.toLowerCase()])).rows[0];
    return row ? deploymentFrom(row) : null;
  }

  async findDeploymentByAddress(chainId: number, address: string): Promise<AdminDeploymentRecord | null> {
    const row = (await query(`SELECT * FROM admin_deployments WHERE chain_id = $1 AND lower(address) = $2`, [chainId, address.toLowerCase()])).rows[0];
    return row ? deploymentFrom(row) : null;
  }

  async listDeployments(filter: AdminDeploymentFilter): Promise<AdminDeploymentRecord[]> {
    const result = await query(
      `SELECT * FROM admin_deployments WHERE ($1::text IS NULL OR network = $1) AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT 500`,
      [filter.network ?? null, filter.status ?? null],
    );
    return result.rows.map(deploymentFrom);
  }

  async listProfiles(): Promise<AdminNetworkProfile[]> {
    return (await query(`SELECT * FROM admin_network_profiles`, [])).rows.map(profileFrom);
  }

  async putProfile(profile: AdminNetworkProfile): Promise<void> {
    await query(
      `INSERT INTO admin_network_profiles (network, owner, guardian, treasury, eoa_owner_acknowledged, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (network) DO UPDATE SET owner = EXCLUDED.owner, guardian = EXCLUDED.guardian, treasury = EXCLUDED.treasury,
         eoa_owner_acknowledged = EXCLUDED.eoa_owner_acknowledged, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [profile.network, profile.owner, profile.guardian, profile.treasury, profile.eoaOwnerAcknowledged, profile.updatedBy, profile.updatedAt ? new Date(profile.updatedAt) : null],
    );
  }

  async insertProposal(proposal: AdminSafeProposal): Promise<void> {
    const clash = await query(`SELECT 1 FROM admin_safe_proposals WHERE network = $1 AND safe_tx_hash = $2 LIMIT 1`, [proposal.network, proposal.safeTxHash]);
    if (clash.rows.length > 0) throw new AdminHttpError(409, "ADMIN_SAFE_NONCE_BUSY", "This Safe transaction is already proposed.");
    await query(
        `INSERT INTO admin_safe_proposals (id, network, safe, to_address, value, data, nonce, safe_tx_hash, description, action_id,
           decoded, threshold, owners, signatures, status, executed_tx_hash, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18)`,
        [proposal.id, proposal.network, proposal.safe, proposal.to, proposal.value, proposal.data, proposal.nonce, proposal.safeTxHash,
          proposal.description, proposal.actionId, proposal.decoded ? JSON.stringify(proposal.decoded) : null, proposal.threshold,
          JSON.stringify(proposal.owners), JSON.stringify(proposal.signatures), proposal.status, proposal.executedTxHash, proposal.createdBy,
          new Date(proposal.createdAt)],
      );
  }

  async updateProposal(proposal: AdminSafeProposal): Promise<void> {
    await query(
      `UPDATE admin_safe_proposals SET signatures = $2::jsonb, status = $3, executed_tx_hash = $4 WHERE id = $1`,
      [proposal.id, JSON.stringify(proposal.signatures), proposal.status, proposal.executedTxHash],
    );
  }

  async getProposal(id: string): Promise<AdminSafeProposal | null> {
    const row = (await query(`SELECT * FROM admin_safe_proposals WHERE id = $1`, [id])).rows[0];
    return row ? proposalFrom(row) : null;
  }

  async listProposals(filter: AdminProposalFilter): Promise<AdminSafeProposal[]> {
    const result = await query(
      `SELECT * FROM admin_safe_proposals WHERE ($1::text IS NULL OR network = $1) AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [filter.network ?? null, filter.status ?? null],
    );
    return result.rows.map(proposalFrom);
  }

  async getFeeScan(key: string): Promise<AdminFeeScanRecord | null> {
    const row = (await query(`SELECT * FROM admin_fee_scans WHERE key = $1`, [key])).rows[0];
    if (!row) return null;
    return {
      key: String(row.key), network: row.network as AdminEvmNetwork, address: String(row.address),
      scannedThroughBlock: BigInt(String(row.scanned_through_block)), totals: row.totals as Record<string, string>,
    };
  }

  async putFeeScan(record: AdminFeeScanRecord): Promise<void> {
    await query(
      `INSERT INTO admin_fee_scans (key, network, address, scanned_through_block, totals, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET scanned_through_block = EXCLUDED.scanned_through_block, totals = EXCLUDED.totals, updated_at = now()`,
      [record.key, record.network, record.address, record.scannedThroughBlock.toString(), JSON.stringify(record.totals)],
    );
  }
}

/**
 * Unique violations must surface as conflicts, but dbQuery maps every
 * database error to 503. Inserts therefore pre-check the unique keys and let
 * the constraint stay the final guard (a concurrent duplicate reads as 503).
 */
async function dbInsertDeployment(record: AdminDeploymentRecord): Promise<void> {
  const clash = await query(
    `SELECT 1 FROM admin_deployments WHERE chain_id = $1 AND (lower(address) = $2 OR tx_hash = $3) LIMIT 1`,
    [record.chainId, record.address.toLowerCase(), record.txHash.toLowerCase()],
  );
  if (clash.rows.length > 0) throw new AdminHttpError(409, "ADMIN_RECORD_CONFLICT", "A record for this address or transaction already exists.");
  await query(
    `INSERT INTO admin_deployments (id, target_id, network, chain_id, contract_id, instance, address, tx_hash, block, deployer,
       constructor_args, owner_kind, expected_owner, artifact_id, artifact_masked_runtime_hash, onchain_codehash, checks, status,
       notes, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22)`,
    [record.id, record.targetId, record.network, record.chainId, record.contractId, record.instance ?? null, record.address,
      record.txHash.toLowerCase(), record.block, record.deployer, JSON.stringify(record.constructorArgs), record.ownerKind,
      record.expectedOwner, record.artifactId, record.artifactMaskedRuntimeHash, record.onchainCodehash, JSON.stringify(record.checks),
      record.status, record.notes, record.createdBy, new Date(record.createdAt), new Date(record.updatedAt)],
  );
}
