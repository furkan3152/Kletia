/**
 * Postgres contract store (kletia_contracts, kletia_contract_revisions,
 * kletia_contract_spend).
 */
import {
  NETWORK_KEYS,
  type ContractDefinition,
  type ContractPins,
  type ContractVerification,
  type NetworkKey,
  type SolanaActionMetadata,
} from "@kletia/core";
import { isRecord } from "../context.js";
import { dbQuery, dbTransaction } from "../db.js";
import { iso } from "./events.js";
import {
  ConcurrentChange,
  type ContractEntry,
  contractExists,
  contractLimitReached,
  type ContractRecord,
  type ContractRevision,
  type ContractStore,
  type RevisionSummary,
  type StoredContractStatus,
} from "./records.js";

const CONTRACTS_SCHEMA = {
  name: "kletia_contracts",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_contracts (
  id text PRIMARY KEY,
  owner_key_id text NOT NULL,
  project_id text,
  vm text NOT NULL CHECK (vm IN ('evm','svm')),
  network text NOT NULL,
  target text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','suspended','deleted')),
  visibility text NOT NULL CHECK (visibility IN ('private','project')),
  revision integer NOT NULL DEFAULT 1,
  active_revision integer,
  pending_revision integer,
  activates_at timestamptz,
  suspended_reason text,
  verification jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  pins_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kletia_contracts_owner_target_idx
  ON kletia_contracts (owner_key_id, network, target) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS kletia_contracts_owner_idx ON kletia_contracts (owner_key_id, created_at);
CREATE INDEX IF NOT EXISTS kletia_contracts_project_idx ON kletia_contracts (project_id) WHERE visibility = 'project' AND status <> 'deleted';
CREATE INDEX IF NOT EXISTS kletia_contracts_watch_idx ON kletia_contracts (pins_checked_at) WHERE status IN ('active','pending');
CREATE INDEX IF NOT EXISTS kletia_contracts_due_idx ON kletia_contracts (activates_at) WHERE pending_revision IS NOT NULL;
CREATE TABLE IF NOT EXISTS kletia_contract_revisions (
  contract_id text NOT NULL REFERENCES kletia_contracts(id),
  revision integer NOT NULL,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  pins jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, revision)
);
CREATE TABLE IF NOT EXISTS kletia_contract_spend (
  owner_key_id text NOT NULL,
  day date NOT NULL,
  usd numeric NOT NULL DEFAULT 0,
  prepared integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_key_id, day)
);`,
} as const;

interface ContractRow {
  id: string;
  owner_key_id: string;
  project_id: string | null;
  vm: string;
  network: string;
  target: string;
  status: string;
  visibility: string;
  revision: number;
  active_revision: number | null;
  pending_revision: number | null;
  activates_at: Date | string | null;
  suspended_reason: string | null;
  verification: unknown;
  metadata: unknown;
  pins_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  a_definition: unknown;
  a_hash: string | null;
  a_pins: unknown;
  a_created: Date | string | null;
  p_definition: unknown;
  p_hash: string | null;
  p_pins: unknown;
  p_created: Date | string | null;
}

const SELECT_ENTRY = `
SELECT c.*,
  a.definition AS a_definition, a.definition_hash AS a_hash, a.pins AS a_pins, a.created_at AS a_created,
  p.definition AS p_definition, p.definition_hash AS p_hash, p.pins AS p_pins, p.created_at AS p_created
FROM kletia_contracts c
LEFT JOIN kletia_contract_revisions a ON a.contract_id = c.id AND a.revision = c.active_revision
LEFT JOIN kletia_contract_revisions p ON p.contract_id = c.id AND p.revision = c.pending_revision`;

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function entryFromRow(row: ContractRow): ContractEntry | null {
  if ((row.vm !== "evm" && row.vm !== "svm") || !NETWORK_KEYS.includes(row.network as NetworkKey)) return null;
  const status = row.status as StoredContractStatus;
  const verification = (isRecord(row.verification) ? row.verification : { domain: { verified: false, checkedAt: null } }) as unknown as ContractVerification;
  const record: ContractRecord = {
    id: row.id,
    ownerKeyId: row.owner_key_id,
    projectId: row.project_id,
    vm: row.vm,
    network: row.network as NetworkKey,
    target: row.target,
    status,
    visibility: row.visibility === "project" ? "project" : "private",
    revision: row.revision,
    activeRevision: row.active_revision,
    pendingRevision: row.pending_revision,
    activatesAt: isoOf(row.activates_at),
    suspendedReason: row.suspended_reason,
    verification,
    metadata: (isRecord(row.metadata) ? row.metadata : {}) as Record<string, SolanaActionMetadata>,
    pinsCheckedAt: isoOf(row.pins_checked_at),
    createdAt: isoOf(row.created_at) ?? iso(0),
    updatedAt: isoOf(row.updated_at) ?? iso(0),
  };
  const revision = (number: number | null, definition: unknown, hash: string | null, pins: unknown, created: Date | string | null): ContractRevision | null =>
    number === null || !isRecord(definition) || hash === null
      ? null
      : { contractId: row.id, revision: number, definition: definition as unknown as ContractDefinition, definitionHash: hash, pins: pins as ContractPins, createdAt: isoOf(created) ?? iso(0) };
  return {
    record,
    active: revision(row.active_revision, row.a_definition, row.a_hash, row.a_pins, row.a_created),
    pending: revision(row.pending_revision, row.p_definition, row.p_hash, row.p_pins, row.p_created),
  };
}

function entries(rows: readonly ContractRow[]): ContractEntry[] {
  return rows.map(entryFromRow).filter((entry): entry is ContractEntry => entry !== null);
}

const RECORD_COLUMNS = [
  "id",
  "owner_key_id",
  "project_id",
  "vm",
  "network",
  "target",
  "status",
  "visibility",
  "revision",
  "active_revision",
  "pending_revision",
  "activates_at",
  "suspended_reason",
  "verification",
  "metadata",
  "pins_checked_at",
  "created_at",
  "updated_at",
] as const;

function recordValues(record: ContractRecord): unknown[] {
  return [
    record.id,
    record.ownerKeyId,
    record.projectId,
    record.vm,
    record.network,
    record.target,
    record.status,
    record.visibility,
    record.revision,
    record.activeRevision,
    record.pendingRevision,
    record.activatesAt,
    record.suspendedReason,
    JSON.stringify(record.verification),
    JSON.stringify(record.metadata),
    record.pinsCheckedAt,
    record.createdAt,
    record.updatedAt,
  ];
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

export class PostgresContractStore implements ContractStore {
  readonly kind = "postgres" as const;

  async create(record: ContractRecord, revision: ContractRevision, maxPerOwner: number): Promise<void> {
    await dbTransaction(CONTRACTS_SCHEMA, async (client) => {
      // Serialise registrations per owner so the per-key cap holds across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_contracts:${record.ownerKeyId}`]);
      const existing = await client.query<{ count: string; same: string }>(
        `SELECT count(*)::text AS count, count(*) FILTER (WHERE network = $2 AND target = $3)::text AS same
         FROM kletia_contracts WHERE owner_key_id = $1 AND status <> 'deleted'`,
        [record.ownerKeyId, record.network, record.target],
      );
      if (Number(existing.rows[0]?.same ?? "0") > 0) throw contractExists();
      if (Number(existing.rows[0]?.count ?? "0") >= maxPerOwner) throw contractLimitReached(maxPerOwner);
      const placeholders = RECORD_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
      try {
        await client.query(`INSERT INTO kletia_contracts (${RECORD_COLUMNS.join(", ")}) VALUES (${placeholders})`, recordValues(record));
      } catch (error) {
        if (isUniqueViolation(error)) throw contractExists();
        throw error;
      }
      await client.query(
        `INSERT INTO kletia_contract_revisions (contract_id, revision, definition, definition_hash, pins, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6)`,
        [revision.contractId, revision.revision, JSON.stringify(revision.definition), revision.definitionHash, JSON.stringify(revision.pins), revision.createdAt],
      );
    });
  }

  async get(id: string): Promise<ContractEntry | null> {
    const result = await dbQuery<ContractRow>(CONTRACTS_SCHEMA, `${SELECT_ENTRY} WHERE c.id = $1`, [id]);
    return entries(result.rows)[0] ?? null;
  }

  async listVisible(ownerKeyId: string, projectId: string | null): Promise<ContractEntry[]> {
    const result = await dbQuery<ContractRow>(
      CONTRACTS_SCHEMA,
      `${SELECT_ENTRY}
       WHERE c.status <> 'deleted' AND (c.owner_key_id = $1 OR ($2::text IS NOT NULL AND c.project_id = $2 AND c.visibility = 'project'))
       ORDER BY c.created_at ASC LIMIT 200`,
      [ownerKeyId, projectId],
    );
    return entries(result.rows);
  }

  async listDue(now: string, limit: number): Promise<ContractEntry[]> {
    const result = await dbQuery<ContractRow>(
      CONTRACTS_SCHEMA,
      `${SELECT_ENTRY}
       WHERE c.status <> 'deleted' AND c.pending_revision IS NOT NULL AND c.activates_at <= $1
       ORDER BY c.activates_at ASC LIMIT $2`,
      [now, limit],
    );
    return entries(result.rows);
  }

  async listForWatch(limit: number): Promise<ContractEntry[]> {
    const result = await dbQuery<ContractRow>(
      CONTRACTS_SCHEMA,
      `${SELECT_ENTRY} WHERE c.status IN ('active','pending') ORDER BY c.pins_checked_at ASC NULLS FIRST LIMIT $1`,
      [limit],
    );
    return entries(result.rows);
  }

  async update(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions: { readonly insert?: ContractRevision; readonly replace?: ContractRevision } = {},
  ): Promise<boolean> {
    try {
      return await this.updateInTransaction(record, expectedUpdatedAt, revisions);
    } catch (error) {
      if (error instanceof ConcurrentChange) return false;
      throw error;
    }
  }

  private updateInTransaction(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions: { readonly insert?: ContractRevision; readonly replace?: ContractRevision },
  ): Promise<boolean> {
    return dbTransaction(CONTRACTS_SCHEMA, async (client) => {
      const assignments = RECORD_COLUMNS.slice(1).map((column, index) => `${column} = $${index + 2}`).join(", ");
      const updated = await client.query(
        `UPDATE kletia_contracts SET ${assignments} WHERE id = $1 AND updated_at = $${RECORD_COLUMNS.length + 1}::timestamptz`,
        [...recordValues(record), expectedUpdatedAt],
      );
      if (updated.rowCount !== 1) return false;
      if (revisions.insert) {
        const inserted = await client.query(
          `INSERT INTO kletia_contract_revisions (contract_id, revision, definition, definition_hash, pins, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6) ON CONFLICT DO NOTHING`,
          [record.id, revisions.insert.revision, JSON.stringify(revisions.insert.definition), revisions.insert.definitionHash, JSON.stringify(revisions.insert.pins), revisions.insert.createdAt],
        );
        if (inserted.rowCount !== 1) throw new ConcurrentChange();
      }
      if (revisions.replace) {
        // Only labels and phrases change in place: the hash (security-relevant fields) must stay the same.
        const replaced = await client.query(
          `UPDATE kletia_contract_revisions SET definition = $3::jsonb
           WHERE contract_id = $1 AND revision = $2 AND definition_hash = $4`,
          [record.id, revisions.replace.revision, JSON.stringify(revisions.replace.definition), revisions.replace.definitionHash],
        );
        if (replaced.rowCount !== 1) throw new ConcurrentChange();
      }
      return true;
    });
  }

  async history(id: string, limit: number): Promise<RevisionSummary[]> {
    const result = await dbQuery<{ revision: number; definition_hash: string; created_at: Date | string }>(
      CONTRACTS_SCHEMA,
      "SELECT revision, definition_hash, created_at FROM kletia_contract_revisions WHERE contract_id = $1 ORDER BY revision DESC LIMIT $2",
      [id, limit],
    );
    return result.rows.map((row) => ({ revision: row.revision, definitionHash: row.definition_hash, createdAt: isoOf(row.created_at) ?? iso(0) }));
  }

  async counts(ownerKeyId: string): Promise<{ registered: number; suspended: number }> {
    const result = await dbQuery<{ registered: string; suspended: string }>(
      CONTRACTS_SCHEMA,
      `SELECT count(*)::text AS registered, count(*) FILTER (WHERE status = 'suspended')::text AS suspended
       FROM kletia_contracts WHERE owner_key_id = $1 AND status <> 'deleted'`,
      [ownerKeyId],
    );
    return { registered: Number(result.rows[0]?.registered ?? "0"), suspended: Number(result.rows[0]?.suspended ?? "0") };
  }

  async addSpend(ownerKeyId: string, day: string, usd: number, capUsd: number): Promise<boolean> {
    if (usd > capUsd) return false;
    const result = await dbQuery(
      CONTRACTS_SCHEMA,
      `INSERT INTO kletia_contract_spend AS s (owner_key_id, day, usd, prepared) VALUES ($1, $2::date, $3::numeric, 1)
       ON CONFLICT (owner_key_id, day) DO UPDATE SET usd = s.usd + EXCLUDED.usd, prepared = s.prepared + 1
       WHERE s.usd + EXCLUDED.usd <= $4::numeric`,
      [ownerKeyId, day, usd.toFixed(2), capUsd.toFixed(2)],
    );
    return result.rowCount === 1;
  }

  async spend(ownerKeyId: string, day: string): Promise<{ usd: number; prepared: number }> {
    const result = await dbQuery<{ usd: string; prepared: number }>(
      CONTRACTS_SCHEMA,
      "SELECT usd::text AS usd, prepared FROM kletia_contract_spend WHERE owner_key_id = $1 AND day = $2::date",
      [ownerKeyId, day],
    );
    const row = result.rows[0];
    return row ? { usd: Number(row.usd), prepared: row.prepared } : { usd: 0, prepared: 0 };
  }
}
