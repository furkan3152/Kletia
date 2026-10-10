/**
 * Contract registrations ("bring your own contract", design round4/contracts):
 * integrators register their own EVM contracts (ABI actions) and Solana
 * Actions endpoints (program allowlists) under their API key, and intents
 * created with that key can call them.
 *
 * This module holds the store (memory, or Postgres `kletia_contracts`,
 * `kletia_contract_revisions` and `kletia_contract_spend` when
 * KLETIA_DATABASE_URL is set), the registration pipeline, the handlers of
 * /v1/contracts, the contract webhook events, and the engine's
 * `ContractDirectory` (installed by the router like the name resolvers).
 *
 * Fund safety rules enforced here (the engine enforces the per-step ones):
 * - The definition is validated statically by @kletia/core
 *   (`validateContractDefinition`): forbidden functions, argument and event
 *   bindings, reserved names and aliases, deny lists. The normalised
 *   definition is what is stored and hashed.
 * - On-chain identity is pinned at registration (code hash, proxy
 *   implementation; Solana program data, deploy slot, upgrade authority);
 *   not-deployed targets, EIP-7702 delegated accounts and proxies that cannot
 *   be pinned (or that Sourcify resolves differently) are refused.
 * - Mainnet registrations and security-relevant revisions activate only after
 *   KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS (default 900) and announce
 *   themselves with `contract.registered`; integrator names that use a
 *   reserved brand also wait for domain verification.
 * - A registration is usable only by its owning key, or by keys of the same
 *   project when `visibility: "project"`; foreign and unknown ids are
 *   indistinguishable (404 CONTRACT_NOT_FOUND here, CONTRACT_UNKNOWN when
 *   planning). The calling key, registration owner and their ancestors must
 *   remain live and unexpired; the directory checks them again at prepare.
 * - Any anomaly the engine reports (pins changed, outcome mismatch, program
 *   changed) suspends the registration until the integrator re-verifies; an
 *   operator suspension can only be lifted by an operator.
 * - Kill switch KLETIA_CONTRACTS_ENABLED=false: registration, tests, planning
 *   and preparing return 503 CONTRACTS_DISABLED; verification of submitted
 *   steps continues.
 */
import { createHash } from "node:crypto";
import {
  CHAINS,
  CONTRACT_ID_PATTERN,
  CONTRACT_LIMITS,
  NETWORK_KEYS,
  canonicalJson,
  classifyAbiFunction,
  contractSecurityFields,
  contractTarget,
  deniedTargetReason,
  functionSelector,
  isSecurityRelevantChange,
  parseAccountId,
  reservedIntegratorName,
  resolveChain,
  validateContractDefinition,
  isEvmAddress,
  isSolanaAddress,
  type AbiFunctionClassification,
  type AbiFunctionItem,
  type ContractAbiItem,
  type ContractActionView,
  type ContractDefinition,
  type ContractEventData,
  type ContractEventType,
  type ContractInspection,
  type ContractPins,
  type ContractStatus,
  type ContractTestRequest,
  type ContractTestResult,
  type ContractVerification,
  type ContractView,
  type ContractVisibility,
  type ContractVm,
  type EvmContractDefinition,
  type KletiaEvent,
  type NetworkKey,
  type SolanaActionDefinition,
  type SolanaActionMetadata,
} from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../errors.js";
import {
  buildEvent,
  configureContractDirectory,
  contractDirectory,
  isEvmNetwork,
  proxyRefusalReason,
  type ActionTransport,
  type ContractDirectory,
  type ContractPhrase,
  type EvmNetworkKey,
  type RegisteredContract,
  type SolanaNetworkKey,
} from "../index.js";
import { isSolanaNetworkKey } from "../../networks/solana/index.js";
import { createActionTransport } from "./actionTransport.js";
import { apiKeyStore, keyLive, loadOperatorKeys } from "./auth.js";
import {
  activationDelaySeconds,
  comparePins,
  configuredDenylist,
  contractChecks,
  contractEngine,
  contractsEnabled,
  keyDailyMaxUsd,
  RISK_REFUSAL_SCORE,
  type EvmInspection,
} from "./contractChecks.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";
import { randomHex } from "./secrets.js";

/* ================================================================== clock */

let clock: () => number = () => Date.now();

/** Replaces the clock of contract activation and caps (tests); `null` restores Date.now. */
export function configureContractClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

export function contractNow(): number {
  return clock();
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** A strictly later timestamp than `previous` (optimistic concurrency token). */
function nextTimestamp(previous: string, now: number): string {
  const before = Date.parse(previous);
  return iso(Number.isFinite(before) && before >= now ? before + 1 : now);
}

/* ================================================================= events */

export type ContractEvent = KletiaEvent<ContractEventType>;

const listeners = new Set<(event: ContractEvent) => void>();

/** Subscribes to contract lifecycle events (webhook dispatch). Returns an unsubscribe function. */
export function subscribeContractEvents(listener: (event: ContractEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(type: ContractEventType, record: ContractRecord, revision: number, reason?: string): void {
  const data: ContractEventData = {
    contractId: record.id,
    ownerKeyId: record.ownerKeyId,
    network: record.network,
    target: record.target,
    revision,
    ...(reason ? { reason } : {}),
  };
  const event = buildEvent(type, data) as ContractEvent;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("[platform] contract event listener failed:", error instanceof Error ? error.message : error);
    }
  }
}

/* ================================================================== model */

export type StoredContractStatus = ContractStatus | "deleted";

/** Suspension reasons set by the platform; operator suspensions are stored as `operator: <reason>`. */
const LIFTABLE_SUSPENSIONS = new Set(["pins_changed", "program_changed", "outcome_mismatch", "domain_unverified"]);
const OPERATOR_PREFIX = "operator: ";

export interface ContractRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly projectId: string | null;
  readonly vm: ContractVm;
  readonly network: NetworkKey;
  /** Lower-case contract address (EVM) or the Solana Actions origin. */
  readonly target: string;
  readonly status: StoredContractStatus;
  /** Visibility of the revision intents use (the active one, else the first). */
  readonly visibility: ContractVisibility;
  /** Latest revision number. */
  readonly revision: number;
  readonly activeRevision: number | null;
  readonly pendingRevision: number | null;
  readonly activatesAt: string | null;
  readonly suspendedReason: string | null;
  readonly verification: ContractVerification;
  /** Solana Actions metadata per entry id (recorded at registration). */
  readonly metadata: Readonly<Record<string, SolanaActionMetadata>>;
  readonly pinsCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContractRevision {
  readonly contractId: string;
  readonly revision: number;
  /** Normalised definition (`validateContractDefinition`). */
  readonly definition: ContractDefinition;
  readonly definitionHash: string;
  readonly pins: ContractPins;
  readonly createdAt: string;
}

export interface ContractEntry {
  readonly record: ContractRecord;
  /** The active revision; null while the first revision waits for activation. */
  readonly active: ContractRevision | null;
  /** The revision waiting for activation, if any. */
  readonly pending: ContractRevision | null;
}

export interface RevisionSummary {
  readonly revision: number;
  readonly definitionHash: string;
  readonly createdAt: string;
}

/** sha256 hex of the canonical security-relevant fields (same value as core `contractDefinitionHash`). */
export function definitionHashOf(definition: ContractDefinition): string {
  return createHash("sha256").update(canonicalJson(contractSecurityFields(definition)), "utf8").digest("hex");
}

function latestRevision(entry: ContractEntry): ContractRevision {
  const revision = entry.pending ?? entry.active;
  if (!revision) throw new Error(`Contract ${entry.record.id} has no revision.`);
  return revision;
}

/** The revision intents plan and prepare with: the active one, else the first (pending) one. */
function usedRevision(entry: ContractEntry): ContractRevision {
  const revision = entry.active ?? entry.pending;
  if (!revision) throw new Error(`Contract ${entry.record.id} has no revision.`);
  return revision;
}

function isOperatorSuspension(record: ContractRecord): boolean {
  return record.status === "suspended" && (record.suspendedReason ?? "").startsWith(OPERATOR_PREFIX);
}

/* ============================================================ store errors */

function contractNotFound(): HttpError {
  return new HttpError(404, "CONTRACT_NOT_FOUND", "Contract registration not found.");
}

function contractExists(): PlatformError {
  return new PlatformError("CONTRACT_EXISTS", "This key already registered this address (or origin) on this network. Change it with PATCH /v1/contracts/{id}.", 409);
}

function contractLimitReached(max: number): PlatformError {
  return new PlatformError("CONTRACT_LIMIT_REACHED", `An API key holds at most ${max} contract registrations. Delete one with DELETE /v1/contracts/{id} first.`, 409);
}

/** The registration changed under a read-modify-write; the caller re-reads (never leaves the module as-is). */
class ConcurrentChange extends PlatformError {
  constructor() {
    super("STORE_UNAVAILABLE", "The registration is being changed concurrently. Read it again and retry.", 503);
  }
}

function contractsDisabled(): PlatformError {
  return new PlatformError("CONTRACTS_DISABLED", "Custom contracts are disabled on this deployment.", 503);
}

export function assertContractsEnabled(): void {
  if (!contractsEnabled()) throw contractsDisabled();
}

/* ================================================================== store */

export interface ContractStore {
  readonly kind: "memory" | "postgres";
  /**
   * Inserts a registration with its first revision. Refuses 409 CONTRACT_EXISTS
   * when the owner already holds a (not deleted) registration of the same
   * target on the network, 409 CONTRACT_LIMIT_REACHED at `maxPerOwner`.
   */
  create(record: ContractRecord, revision: ContractRevision, maxPerOwner: number): Promise<void>;
  /** One registration (deleted ones included) with its active and pending revisions. */
  get(id: string): Promise<ContractEntry | null>;
  /** Not-deleted registrations of `ownerKeyId`, plus project-visible ones of `projectId` (other keys). At most 200. */
  listVisible(ownerKeyId: string, projectId: string | null): Promise<ContractEntry[]>;
  /** Registrations whose pending revision is due (`activatesAt` <= now), oldest first. */
  listDue(now: string, limit: number): Promise<ContractEntry[]>;
  /** Active and pending registrations, least recently pin-checked first. */
  listForWatch(limit: number): Promise<ContractEntry[]>;
  /**
   * Replaces the record when its stored `updatedAt` equals `expectedUpdatedAt`
   * (false otherwise), inserting a new revision and/or replacing the
   * definition of an existing one in the same transaction.
   */
  update(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions?: { readonly insert?: ContractRevision; readonly replace?: ContractRevision },
  ): Promise<boolean>;
  /** Revision numbers, hashes and creation times, newest first. */
  history(id: string, limit: number): Promise<RevisionSummary[]>;
  /** Registrations of one owner (not deleted), and how many are suspended. */
  counts(ownerKeyId: string): Promise<{ readonly registered: number; readonly suspended: number }>;
  /** Adds priced notional for `day` unless the total would exceed `capUsd`; false when refused. */
  addSpend(ownerKeyId: string, day: string, usd: number, capUsd: number): Promise<boolean>;
  spend(ownerKeyId: string, day: string): Promise<{ readonly usd: number; readonly prepared: number }>;
}

interface MemoryContract {
  record: ContractRecord;
  readonly revisions: Map<number, ContractRevision>;
}

export class MemoryContractStore implements ContractStore {
  readonly kind = "memory" as const;
  private readonly contracts = new Map<string, MemoryContract>();
  private readonly spends = new Map<string, { usd: number; prepared: number }>();

  constructor(private readonly maxContracts = 10_000) {}

  private entry(item: MemoryContract): ContractEntry {
    const { record } = item;
    return {
      record,
      active: record.activeRevision === null ? null : (item.revisions.get(record.activeRevision) ?? null),
      pending: record.pendingRevision === null ? null : (item.revisions.get(record.pendingRevision) ?? null),
    };
  }

  async create(record: ContractRecord, revision: ContractRevision, maxPerOwner: number): Promise<void> {
    const owned = [...this.contracts.values()].filter((item) => item.record.ownerKeyId === record.ownerKeyId && item.record.status !== "deleted");
    if (owned.some((item) => item.record.network === record.network && item.record.target === record.target)) throw contractExists();
    if (owned.length >= maxPerOwner) throw contractLimitReached(maxPerOwner);
    if (this.contracts.has(record.id)) throw new ConcurrentChange();
    this.contracts.set(record.id, { record, revisions: new Map([[revision.revision, revision]]) });
    while (this.contracts.size > this.maxContracts) {
      const oldest = this.contracts.keys().next().value;
      if (oldest === undefined) break;
      this.contracts.delete(oldest);
    }
  }

  async get(id: string): Promise<ContractEntry | null> {
    const item = this.contracts.get(id);
    return item ? this.entry(item) : null;
  }

  async listVisible(ownerKeyId: string, projectId: string | null): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) =>
        record.status !== "deleted" &&
        (record.ownerKeyId === ownerKeyId || (projectId !== null && record.projectId === projectId && record.visibility === "project")),
      )
      .sort((a, b) => (a.record.createdAt < b.record.createdAt ? -1 : a.record.createdAt > b.record.createdAt ? 1 : 0))
      .slice(0, 200)
      .map((item) => this.entry(item));
  }

  async listDue(now: string, limit: number): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) => record.status !== "deleted" && record.pendingRevision !== null && record.activatesAt !== null && record.activatesAt <= now)
      .sort((a, b) => ((a.record.activatesAt ?? "") < (b.record.activatesAt ?? "") ? -1 : 1))
      .slice(0, limit)
      .map((item) => this.entry(item));
  }

  async listForWatch(limit: number): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) => record.status === "active" || record.status === "pending")
      .sort((a, b) => {
        const left = a.record.pinsCheckedAt ?? "";
        const right = b.record.pinsCheckedAt ?? "";
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .slice(0, limit)
      .map((item) => this.entry(item));
  }

  async update(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions: { readonly insert?: ContractRevision; readonly replace?: ContractRevision } = {},
  ): Promise<boolean> {
    const item = this.contracts.get(record.id);
    if (!item || item.record.updatedAt !== expectedUpdatedAt) return false;
    if (revisions.insert && item.revisions.has(revisions.insert.revision)) return false;
    if (revisions.replace && !item.revisions.has(revisions.replace.revision)) return false;
    if (revisions.insert) item.revisions.set(revisions.insert.revision, revisions.insert);
    if (revisions.replace) item.revisions.set(revisions.replace.revision, revisions.replace);
    item.record = record;
    return true;
  }

  async history(id: string, limit: number): Promise<RevisionSummary[]> {
    const item = this.contracts.get(id);
    if (!item) return [];
    return [...item.revisions.values()]
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit)
      .map((revision) => ({ revision: revision.revision, definitionHash: revision.definitionHash, createdAt: revision.createdAt }));
  }

  async counts(ownerKeyId: string): Promise<{ registered: number; suspended: number }> {
    let registered = 0;
    let suspended = 0;
    for (const { record } of this.contracts.values()) {
      if (record.ownerKeyId !== ownerKeyId || record.status === "deleted") continue;
      registered += 1;
      if (record.status === "suspended") suspended += 1;
    }
    return { registered, suspended };
  }

  async addSpend(ownerKeyId: string, day: string, usd: number, capUsd: number): Promise<boolean> {
    const key = `${ownerKeyId}\u0000${day}`;
    const current = this.spends.get(key) ?? { usd: 0, prepared: 0 };
    if (current.usd + usd > capUsd) return false;
    this.spends.set(key, { usd: current.usd + usd, prepared: current.prepared + 1 });
    while (this.spends.size > 50_000) {
      const oldest = this.spends.keys().next().value;
      if (oldest === undefined) break;
      this.spends.delete(oldest);
    }
    return true;
  }

  async spend(ownerKeyId: string, day: string): Promise<{ usd: number; prepared: number }> {
    return this.spends.get(`${ownerKeyId}\u0000${day}`) ?? { usd: 0, prepared: 0 };
  }
}

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

let store: ContractStore | null = null;

export function contractStore(): ContractStore {
  store ??= platformDatabaseUrl() ? new PostgresContractStore() : new MemoryContractStore();
  return store;
}

/** Replaces the store (tests); `null` re-selects by KLETIA_DATABASE_URL on next use. */
export function configureContractStore(custom: ContractStore | null): void {
  store = custom;
}

export function contractStoreKind(): "memory" | "postgres" {
  return contractStore().kind;
}

/* ============================================================ key context */

const PROJECT_CACHE_MS = 15_000;
const projects = new Map<string, { readonly projectId: string | null; readonly expiresAt: number }>();

/** Project of a key id (null for operator and unknown keys), cached 15 s like verified keys. */
async function projectOf(keyId: string): Promise<string | null> {
  const now = Date.now();
  const cached = projects.get(keyId);
  if (cached && cached.expiresAt > now) return cached.projectId;
  const projectId = (await apiKeyStore().findById(keyId))?.projectId ?? null;
  projects.delete(keyId);
  projects.set(keyId, { projectId, expiresAt: now + PROJECT_CACHE_MS });
  while (projects.size > 20_000) {
    const oldest = projects.keys().next().value;
    if (oldest === undefined) break;
    projects.delete(oldest);
  }
  return projectId;
}

/** The AuthContext of a key id outside an HTTP request (MCP tools), with its project. */
export async function keyContext(tier: AuthContext["tier"], keyId: string): Promise<AuthContext> {
  const projectId = await projectOf(keyId);
  return { tier, keyId, ...(projectId ? { projectId } : {}) };
}

interface Caller {
  readonly keyId: string;
  readonly projectId: string | null;
}

function reader(auth: AuthContext): Caller {
  if (!auth.keyId) throw new HttpError(401, "API_KEY_REQUIRED", "Contract registrations require an API key.");
  return { keyId: auth.keyId, projectId: auth.projectId ?? null };
}

/** Changing registrations requires the key's current secret (same rule as key management). */
function writer(auth: AuthContext): Caller {
  const caller = reader(auth);
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Register and change contracts with the current secret.", 403);
  }
  return caller;
}

/** Whether `caller` may read and use a registration (owner, or project-visible in the caller's project). */
function visibleTo(record: ContractRecord, caller: Caller): boolean {
  if (record.status === "deleted") return false;
  if (record.ownerKeyId === caller.keyId) return true;
  return record.visibility === "project" && record.projectId !== null && record.projectId === caller.projectId;
}

/* ============================================================ activation */

function needsDomain(definition: ContractDefinition): boolean {
  return reservedIntegratorName(definition.integrator.name) !== null;
}

/** The record after its pending revision activates, or null when it cannot activate yet. */
function activated(entry: ContractEntry, now: number): ContractRecord | null {
  const { record, pending } = entry;
  if (record.status === "deleted" || !pending || record.pendingRevision === null || record.activatesAt === null) return null;
  if (Date.parse(record.activatesAt) > now) return null;
  if (needsDomain(pending.definition) && !record.verification.domain.verified) return null;
  const lift = record.status === "pending" || (record.status === "suspended" && LIFTABLE_SUSPENSIONS.has(record.suspendedReason ?? ""));
  return {
    ...record,
    status: lift ? "active" : record.status,
    suspendedReason: lift ? null : record.suspendedReason,
    activeRevision: record.pendingRevision,
    pendingRevision: null,
    activatesAt: null,
    visibility: pending.definition.visibility ?? "private",
    updatedAt: nextTimestamp(record.updatedAt, now),
  };
}

/** Activates a due pending revision (exactly one instance wins and emits the events). Returns the fresh entry. */
async function settle(entry: ContractEntry): Promise<ContractEntry> {
  const now = clock();
  const next = activated(entry, now);
  if (!next) return entry;
  if (!(await contractStore().update(next, entry.record.updatedAt))) return (await contractStore().get(entry.record.id)) ?? entry;
  const revision = next.activeRevision ?? next.revision;
  if (next.status === "active") publish("contract.activated", next, revision);
  if (entry.record.status === "suspended" && next.status === "active") publish("contract.reactivated", next, revision);
  return { record: next, active: entry.pending, pending: null };
}

/** Activates every due pending revision (watcher); returns how many activated. */
export async function activateDueContracts(limit = 200): Promise<number> {
  let count = 0;
  for (const entry of await contractStore().listDue(iso(clock()), limit)) {
    const settled = await settle(entry);
    if (settled.record.activeRevision !== entry.record.activeRevision) count += 1;
  }
  return count;
}

/** Re-reads an entry until a read-modify-write lands (optimistic concurrency, bounded). */
async function mutate(
  id: string,
  change: (entry: ContractEntry) => Promise<{ record: ContractRecord; insert?: ContractRevision; replace?: ContractRevision } | null>,
): Promise<{ before: ContractEntry; after: ContractEntry } | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await contractStore().get(id);
    if (!current) return null;
    const entry = await settle(current);
    const next = await change(entry);
    if (!next) return { before: entry, after: entry };
    if (await contractStore().update(next.record, entry.record.updatedAt, { ...(next.insert ? { insert: next.insert } : {}), ...(next.replace ? { replace: next.replace } : {}) })) {
      const after = await contractStore().get(id);
      return { before: entry, after: after ?? entry };
    }
  }
  throw new ConcurrentChange();
}

/** Suspends a registration (idempotent; the first reason is kept). Emits `contract.suspended` once. */
export async function suspendContract(id: string, reason: string, detail?: string): Promise<ContractEntry | null> {
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted" || entry.record.status === "suspended") return null;
    return { record: { ...entry.record, status: "suspended", suspendedReason: reason, updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) return null;
  if (result.before.record.status !== "suspended" && result.after.record.status === "suspended") {
    if (detail) console.warn(`[platform] contract ${id} suspended (${reason}): ${detail.slice(0, 300)}`);
    publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, reason);
  }
  return result.after;
}

/* ============================================================ validation */

function issuesOf(result: { readonly issues: readonly { readonly path: string; readonly message: string }[] }): PlatformIssue[] {
  return result.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** Maps the core validator's result to the API error; codes are literal so the catalog drift test sees them. */
function definitionError(result: { readonly code: string; readonly issues: readonly { readonly code: string; readonly path: string; readonly message: string }[] }): PlatformError {
  const issues = issuesOf(result);
  const first = result.issues.find((issue) => issue.code === result.code) ?? result.issues[0];
  const detail = first ? ` ${first.path ? `${first.path}: ` : ""}${first.message}` : "";
  switch (result.code) {
    case "CONTRACT_DENIED":
      return new PlatformError("CONTRACT_DENIED", `This contract or program cannot be registered.${detail}`, 422, issues);
    case "CONTRACT_FUNCTION_FORBIDDEN":
      return new PlatformError("CONTRACT_FUNCTION_FORBIDDEN", `The definition includes a function that can never be registered.${detail}`, 422, issues);
    case "CONTRACT_ARGUMENT_FORBIDDEN":
      return new PlatformError("CONTRACT_ARGUMENT_FORBIDDEN", `The definition includes an argument type that can never be registered.${detail}`, 422, issues);
    case "PROGRAM_NOT_ALLOWED":
      return new PlatformError("PROGRAM_NOT_ALLOWED", `A program cannot be allowlisted.${detail}`, 422, issues);
    case "ACTION_URL_FORBIDDEN":
      return new PlatformError("ACTION_URL_FORBIDDEN", `An action URL is refused.${detail}`, 422, issues);
    case "CONTRACT_BINDING_INVALID":
      return new PlatformError("CONTRACT_BINDING_INVALID", `An argument or event binding is invalid.${detail}`, 422, issues);
    default:
      return new PlatformError("CONTRACT_DEFINITION_INVALID", `The contract definition is invalid.${detail}`, 400, issues);
  }
}

/** Static validation with the deployment's deny lists; returns the normalised definition. */
export function validateDefinition(input: unknown): ContractDefinition {
  const result = validateContractDefinition(input, { denylist: configuredDenylist() });
  if (!result.ok) throw definitionError(result);
  return result.value;
}

function phrasePairs(definition: ContractDefinition): Map<string, string> {
  const pairs = new Map<string, string>();
  definition.actions.forEach((action, index) => {
    for (const verb of action.phrases?.verbs ?? []) {
      (action.phrases?.aliases ?? []).forEach((alias, aliasIndex) => {
        pairs.set(`${verb}\u0000${alias}`, `actions[${index}].phrases.aliases[${aliasIndex}]`);
      });
    }
  });
  return pairs;
}

/**
 * A key's registrations on one network may not share a (verb, alias) pair, or
 * "deposit into acme" would be ambiguous (the static validator only checks
 * inside one registration). Project-visible registrations of the project count.
 */
async function assertPhrasesFree(caller: Caller, definition: ContractDefinition, selfId: string | null): Promise<void> {
  const pairs = phrasePairs(definition);
  if (pairs.size === 0) return;
  for (const entry of await contractStore().listVisible(caller.keyId, caller.projectId)) {
    if (entry.record.id === selfId || entry.record.network !== definition.network) continue;
    for (const revision of [entry.active, entry.pending]) {
      if (!revision) continue;
      for (const key of phrasePairs(revision.definition).keys()) {
        const path = pairs.get(key);
        if (path === undefined) continue;
        const [verb, alias] = key.split("\u0000");
        const message = `"${verb} … ${alias}" is already used by ${entry.record.id} on ${definition.network}. Use another alias or verb.`;
        throw new PlatformError("CONTRACT_DEFINITION_INVALID", `The contract definition is invalid. ${path}: ${message}`, 400, [{ path, message }]);
      }
    }
  }
}

/* ================================================================ pinning */

function evmNetwork(network: NetworkKey): EvmNetworkKey {
  if (!isEvmNetwork(network)) throw invalidRequest(`${network} is not an EVM network.`, [{ path: "network", message: "Not an EVM network." }]);
  return network;
}

function solanaNetwork(network: NetworkKey): SolanaNetworkKey {
  if (!isSolanaNetworkKey(network)) throw invalidRequest(`${network} is not a Solana network.`, [{ path: "network", message: "Not a Solana network." }]);
  return network;
}

interface Pinned {
  readonly pins: ContractPins;
  readonly verification: Omit<ContractVerification, "domain">;
  readonly metadata: Record<string, SolanaActionMetadata>;
}

async function pinEvm(definition: EvmContractDefinition): Promise<Pinned> {
  const network = evmNetwork(definition.network);
  const inspection: EvmInspection = await contractEngine().inspectEvmContract(network, definition.address, definition.addresses ?? []);
  if (inspection.eip7702) {
    throw new PlatformError("CONTRACT_DELEGATED_EOA", "This address is an EIP-7702 delegated account: its code can be swapped at any time, so it cannot be registered.", 422, [
      { path: "address", message: "EIP-7702 delegated account." },
    ]);
  }
  if (inspection.codeSize <= 0) {
    throw new PlatformError("CONTRACT_NOT_DEPLOYED", `No contract code at ${definition.address} on ${CHAINS[network].name}.`, 422, [
      { path: "address", message: "No deployed code." },
    ]);
  }
  const pins = inspection.pins;
  for (const [index, entry] of (definition.addresses ?? []).entries()) {
    const pinned = pins.addresses.find((pin) => pin.label === entry.label && pin.address.toLowerCase() === entry.address.toLowerCase());
    if (inspection.proxyHints.includes(`${entry.label}:eip7702-delegation`)) {
      throw new PlatformError("CONTRACT_DELEGATED_EOA", `${entry.address} (${entry.label}) is an EIP-7702 delegated account.`, 422, [
        { path: `addresses[${index}].address`, message: "EIP-7702 delegated account." },
      ]);
    }
    if (!pinned || pinned.codeSize <= 0 || inspection.proxyHints.includes(`${entry.label}:not-deployed`)) {
      throw new PlatformError("CONTRACT_NOT_DEPLOYED", `No contract code at ${entry.address} (${entry.label}).`, 422, [
        { path: `addresses[${index}].address`, message: "No deployed code." },
      ]);
    }
  }
  const unsupported = proxyRefusalReason(inspection);
  if (unsupported) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", `This proxy cannot be pinned: ${unsupported}`, 422, [
      { path: "address", message: "Unsupported proxy pattern." },
    ]);
  }
  const checks = contractChecks();
  const [sourcify, implementation, risk] = await Promise.all([
    checks.sourcify(network, definition.address),
    pins.proxy ? checks.sourcify(network, pins.proxy.implementation) : Promise.resolve(null),
    checks.risk(network, definition.address),
  ]);
  // Sourcify's proxy resolution is an independent cross-check of the pinned proxy.
  if (sourcify.proxy?.isProxy && !pins.proxy) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", `Sourcify resolves this contract as a ${sourcify.proxy.proxyType ?? "proxy"} that Kletia cannot pin.`, 422, [
      { path: "address", message: "Unsupported proxy pattern." },
    ]);
  }
  if (pins.proxy && sourcify.proxy?.isProxy && sourcify.proxy.implementations.length > 0 && !sourcify.proxy.implementations.includes(pins.proxy.implementation.toLowerCase())) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", "Sourcify's proxy resolution disagrees with the implementation read on-chain; registration refused.", 422, [
      { path: "address", message: "Proxy resolution mismatch." },
    ]);
  }
  if (risk?.score !== null && risk?.score !== undefined && risk.score > RISK_REFUSAL_SCORE) {
    throw new PlatformError("CONTRACT_DENIED", `Address risk screening scored this contract ${risk.score}/100; registration refused.`, 422, [
      { path: "address", message: "High risk score." },
    ]);
  }
  return {
    pins,
    verification: { source: sourcify.verification, implementationSource: implementation?.verification ?? null, risk },
    metadata: {},
  };
}

async function pinSolana(definition: SolanaActionDefinition): Promise<Pinned> {
  const network = solanaNetwork(definition.network);
  await contractChecks().actionOrigin(definition.origin);
  const engine = contractEngine();
  const pins = await engine.readSolanaProgramPins(network, definition.programs);
  for (const [index, program] of definition.programs.entries()) {
    if (!pins.some((pin) => pin.program === program)) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `Program ${program} could not be pinned (not an executable program account).`, 422, [
        { path: `programs[${index}]`, message: "Not an executable program." },
      ]);
    }
  }
  const transport = directoryTransport();
  const metadata: Record<string, SolanaActionMetadata> = {};
  for (const action of definition.actions) {
    metadata[action.id] = await engine.fetchSolanaActionMetadata(transport, action.href, network);
  }
  const programs = await Promise.all(definition.programs.map((program) => contractChecks().ottersec(program)));
  return { pins, verification: { programs, risk: null }, metadata };
}

function pin(definition: ContractDefinition): Promise<Pinned> {
  return definition.vm === "evm" ? pinEvm(definition) : pinSolana(definition);
}


/* ================================================================== views */

export interface ContractViewOptions {
  /** Owner views carry the ABI, addresses, programs and payees. */
  readonly owner: boolean;
  readonly history?: readonly RevisionSummary[];
}

export type ContractViewWithHistory = ContractView & { readonly revisions?: readonly RevisionSummary[] };

function actionViews(definition: ContractDefinition, metadata: Readonly<Record<string, SolanaActionMetadata>>): ContractActionView[] {
  if (definition.vm === "evm") return definition.actions.map((action) => ({ ...action, selector: functionSelector(action.function) }));
  return definition.actions.map((action) => ({ ...action, metadata: metadata[action.id] ?? null }));
}

/** API view of a registration. The fields describe the latest revision (`revision`); intents use `activeRevision`. */
export function contractView(entry: ContractEntry, options: ContractViewOptions): ContractViewWithHistory {
  const { record } = entry;
  const latest = latestRevision(entry);
  const definition = latest.definition;
  return {
    id: record.id,
    vm: record.vm,
    network: record.network,
    ...(definition.vm === "evm" ? { address: definition.address } : { origin: definition.origin }),
    integrator: { ...definition.integrator, domainVerified: record.verification.domain.verified },
    visibility: record.visibility,
    status: record.status === "deleted" ? "suspended" : record.status,
    revision: latest.revision,
    activeRevision: record.activeRevision,
    pendingRevision: record.pendingRevision,
    activatesAt: record.activatesAt,
    definitionHash: latest.definitionHash,
    pins: latest.pins,
    verification: record.verification,
    actions: actionViews(definition, record.metadata),
    ...(options.owner && definition.vm === "evm"
      ? { abi: definition.abi, ...(definition.addresses ? { addresses: definition.addresses } : {}) }
      : {}),
    ...(options.owner && definition.vm === "svm"
      ? { programs: definition.programs, ...(definition.payees ? { payees: definition.payees } : {}) }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    suspendedReason: record.suspendedReason,
    ...(options.history ? { revisions: options.history } : {}),
  };
}

/** The engine's view of a registration: the revision intents use (active, else the first pending one). */
export function registeredContract(entry: ContractEntry, revision: ContractRevision = usedRevision(entry)): RegisteredContract {
  const { record } = entry;
  return {
    id: record.id,
    ownerKeyId: record.ownerKeyId,
    projectId: record.projectId,
    status: record.status === "deleted" ? "suspended" : record.status,
    activeRevision: record.activeRevision,
    activatesAt: record.activatesAt,
    definition: revision.definition,
    definitionHash: revision.definitionHash,
    pins: revision.pins,
    verification: record.verification,
    createdAt: record.createdAt,
  };
}

/* =============================================================== handlers */

const DOMAIN_UNCHECKED = { verified: false, checkedAt: null } as const;

/** POST /v1/contracts. */
export async function registerContract(auth: AuthContext, body: unknown): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  const definition = validateDefinition(body);
  const network = definition.network;
  const target = contractTarget(definition);
  // Cheap refusals before any network work (the store re-checks both atomically).
  const visible = await contractStore().listVisible(caller.keyId, caller.projectId);
  const owned = visible.filter((entry) => entry.record.ownerKeyId === caller.keyId);
  if (owned.some((entry) => entry.record.network === network && entry.record.target === target)) throw contractExists();
  if (owned.length >= CONTRACT_LIMITS.registrationsPerKey) throw contractLimitReached(CONTRACT_LIMITS.registrationsPerKey);
  await assertPhrasesFree(caller, definition, null);

  const pinned = await pin(definition);
  const now = clock();
  const id = `ct_${randomHex(12)}`;
  const createdAt = iso(now);
  const revision: ContractRevision = {
    contractId: id,
    revision: 1,
    definition,
    definitionHash: definitionHashOf(definition),
    pins: pinned.pins,
    createdAt,
  };
  const pendingRecord: ContractRecord = {
    id,
    ownerKeyId: caller.keyId,
    projectId: caller.projectId,
    vm: definition.vm,
    network,
    target,
    status: "pending",
    visibility: definition.visibility ?? "private",
    revision: 1,
    activeRevision: null,
    pendingRevision: 1,
    activatesAt: iso(now + activationDelaySeconds(network) * 1000),
    suspendedReason: null,
    verification: { ...pinned.verification, domain: DOMAIN_UNCHECKED },
    metadata: pinned.metadata,
    pinsCheckedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  const pendingEntry: ContractEntry = { record: pendingRecord, active: null, pending: revision };
  // Testnets (no delay) activate at once, unless a reserved brand name still needs its domain verified.
  const immediate = activated(pendingEntry, now);
  const record = immediate ?? pendingRecord;
  await contractStore().create(record, revision, CONTRACT_LIMITS.registrationsPerKey);
  publish("contract.registered", record, 1);
  if (record.status === "active") publish("contract.activated", record, 1);
  return contractView(immediate ? { record, active: revision, pending: null } : pendingEntry, { owner: true });
}

async function visibleEntry(caller: Caller, id: string): Promise<ContractEntry> {
  const entry = await contractStore().get(id);
  if (!entry || !visibleTo(entry.record, caller)) throw contractNotFound();
  return settle(entry);
}

async function ownedEntry(caller: Caller, id: string): Promise<ContractEntry> {
  const entry = await contractStore().get(id);
  if (!entry || entry.record.status === "deleted" || entry.record.ownerKeyId !== caller.keyId) throw contractNotFound();
  return settle(entry);
}

export interface ContractListFilter {
  readonly network?: NetworkKey;
  readonly vm?: ContractVm;
  readonly status?: ContractStatus;
}

export function parseContractListFilter(query: { network?: string; vm?: string; status?: string }): ContractListFilter {
  const filter: { network?: NetworkKey; vm?: ContractVm; status?: ContractStatus } = {};
  if (query.network) {
    const chain = resolveChain(query.network);
    if (!chain) throw invalidRequest(`Unknown network "${query.network.slice(0, 40)}".`, [{ path: "network", message: "Unknown network." }]);
    filter.network = chain.key;
  }
  if (query.vm) {
    if (query.vm !== "evm" && query.vm !== "svm") throw invalidRequest("vm must be evm or svm.", [{ path: "vm", message: "Expected evm or svm." }]);
    filter.vm = query.vm;
  }
  if (query.status) {
    if (query.status !== "pending" && query.status !== "active" && query.status !== "suspended") {
      throw invalidRequest("status must be pending, active or suspended.", [{ path: "status", message: "Expected pending, active or suspended." }]);
    }
    filter.status = query.status;
  }
  return filter;
}

/** GET /v1/contracts: the caller's registrations and the project-visible ones of its project. */
export async function listContracts(auth: AuthContext, filter: ContractListFilter = {}): Promise<ContractViewWithHistory[]> {
  const caller = reader(auth);
  const out: ContractViewWithHistory[] = [];
  for (const raw of await contractStore().listVisible(caller.keyId, caller.projectId)) {
    const entry = await settle(raw);
    const { record } = entry;
    if (filter.network && record.network !== filter.network) continue;
    if (filter.vm && record.vm !== filter.vm) continue;
    if (filter.status && record.status !== filter.status) continue;
    out.push(contractView(entry, { owner: record.ownerKeyId === caller.keyId }));
  }
  return out;
}

/** GET /v1/contracts/{id}: owners also get the ABI and the revision history. */
export async function getContract(auth: AuthContext, id: string): Promise<ContractViewWithHistory> {
  const caller = reader(auth);
  const entry = await visibleEntry(caller, id);
  const owner = entry.record.ownerKeyId === caller.keyId;
  return contractView(entry, { owner, ...(owner ? { history: await contractStore().history(id, 20) } : {}) });
}

const IMMUTABLE_FIELDS = ["vm", "network", "address", "origin"] as const;

/** PATCH /v1/contracts/{id}: a partial definition merged onto the latest revision (`null` removes an optional field). */
export async function updateContract(auth: AuthContext, id: string, body: unknown): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  if (!isRecord(body) || Object.keys(body).length === 0) {
    throw invalidRequest("Body must be a non-empty partial contract definition, e.g. { \"actions\": [...] }.", [{ path: "", message: "Expected an object with fields to change." }]);
  }
  const entry = await ownedEntry(caller, id);
  const latest = latestRevision(entry);
  const current = latest.definition as unknown as Record<string, unknown>;
  for (const field of IMMUTABLE_FIELDS) {
    if (field in body && canonicalJson(body[field]) !== canonicalJson(current[field])) {
      throw new PlatformError("CONTRACT_DEFINITION_INVALID", `${field} cannot change; register a new contract instead.`, 400, [{ path: field, message: "Immutable." }]);
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const next = validateDefinition(merged);
  await assertPhrasesFree(caller, next, id);

  if (!isSecurityRelevantChange(latest.definition, next)) {
    // Labels and phrases change in place: same revision, same hash, no activation delay.
    const replaced: ContractRevision = { ...latest, definition: next };
    if (definitionHashOf(next) !== latest.definitionHash) throw new Error("Non-security change altered the definition hash.");
    const result = await mutate(id, async (fresh) => {
      if (latestRevision(fresh).revision !== latest.revision) throw new ConcurrentChange();
      return { record: { ...fresh.record, updatedAt: nextTimestamp(fresh.record.updatedAt, clock()) }, replace: replaced };
    });
    if (!result) throw contractNotFound();
    return contractView(result.after, { owner: true });
  }

  const pinned = await pin(next);
  const websiteChanged = (next.integrator.website ?? null) !== (latest.definition.integrator.website ?? null);
  const result = await mutate(id, async (fresh) => {
    if (fresh.record.ownerKeyId !== caller.keyId || fresh.record.status === "deleted") throw contractNotFound();
    return newRevision(fresh, next, pinned, websiteChanged);
  });
  if (!result) throw contractNotFound();
  return announceRevision(result.before, result.after);
}

/** A new revision N+1 (pending on mainnet; on testnets it activates at once). */
function newRevision(
  entry: ContractEntry,
  definition: ContractDefinition,
  pinned: Pinned,
  resetDomain: boolean,
  suspend?: string,
): { record: ContractRecord; insert: ContractRevision } {
  const now = clock();
  const number = entry.record.revision + 1;
  const revision: ContractRevision = {
    contractId: entry.record.id,
    revision: number,
    definition,
    definitionHash: definitionHashOf(definition),
    pins: pinned.pins,
    createdAt: iso(now),
  };
  const base = entry.record;
  const pendingRecord: ContractRecord = {
    ...base,
    status: suspend && base.status === "active" ? "suspended" : base.status,
    suspendedReason: suspend && base.status === "active" ? suspend : base.suspendedReason,
    revision: number,
    pendingRevision: number,
    // A pending first revision stays first: its replacement waits the full delay again.
    activatesAt: iso(now + activationDelaySeconds(base.network) * 1000),
    verification: {
      ...base.verification,
      ...pinned.verification,
      domain: resetDomain ? DOMAIN_UNCHECKED : base.verification.domain,
    },
    metadata: Object.keys(pinned.metadata).length > 0 ? pinned.metadata : base.metadata,
    pinsCheckedAt: iso(now),
    updatedAt: nextTimestamp(base.updatedAt, now),
  };
  const immediate = activated({ record: pendingRecord, active: entry.active, pending: revision }, now);
  return { record: immediate ?? pendingRecord, insert: revision };
}

/** Webhooks for a new revision: `contract.registered`, then activation (and reactivation) when immediate. */
function announceRevision(before: ContractEntry, after: ContractEntry): ContractViewWithHistory {
  const { record } = after;
  if (before.record.status !== "suspended" && record.status === "suspended") {
    publish("contract.suspended", record, before.record.activeRevision ?? before.record.revision, record.suspendedReason ?? undefined);
  }
  publish("contract.registered", record, record.revision);
  if (record.activeRevision === record.revision) {
    if (record.status === "active") publish("contract.activated", record, record.revision);
    if (before.record.status === "suspended" && record.status === "active") publish("contract.reactivated", record, record.revision);
  }
  return contractView(after, { owner: true });
}

/** DELETE /v1/contracts/{id}: soft delete (idempotent for the owner). */
export async function deleteContract(auth: AuthContext, id: string): Promise<void> {
  const caller = writer(auth);
  const existing = await contractStore().get(id);
  if (!existing || existing.record.ownerKeyId !== caller.keyId) throw contractNotFound();
  if (existing.record.status === "deleted") return;
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted") return null;
    return { record: { ...entry.record, status: "deleted", updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) throw contractNotFound();
}

/** POST /v1/contracts/{id}/reverify: fresh pins and checks; a new revision when pins changed or to lift a suspension. */
export async function reverifyContract(auth: AuthContext, id: string): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  const entry = await ownedEntry(caller, id);
  if (isOperatorSuspension(entry.record)) {
    throw new PlatformError("CONTRACT_SUSPENDED", "This registration was suspended by the operator and cannot be re-verified by the integrator.", 409);
  }
  const latest = latestRevision(entry);
  const pinned = await pin(latest.definition);
  const website = latest.definition.integrator.website;
  const domainVerified = await contractChecks().domain(website, id);
  const domain = { verified: domainVerified, checkedAt: iso(clock()) };
  const changed = comparePins(latest.pins, pinned.pins);
  const suspendedForPins = entry.record.status === "suspended" && entry.record.suspendedReason !== "domain_unverified";
  const result = await mutate(id, async (fresh) => {
    if (fresh.record.status === "deleted") throw contractNotFound();
    if (isOperatorSuspension(fresh.record)) {
      throw new PlatformError("CONTRACT_SUSPENDED", "This registration was suspended by the operator and cannot be re-verified by the integrator.", 409);
    }
    const withDomain: ContractEntry = { ...fresh, record: { ...fresh.record, verification: { ...fresh.record.verification, domain } } };
    if (changed !== null || suspendedForPins) {
      const reason = fresh.record.vm === "evm" ? "pins_changed" : "program_changed";
      return newRevision(withDomain, latestRevision(fresh).definition, pinned, false, changed !== null ? reason : undefined);
    }
    // Same code: refresh verification; a domain-only suspension lifts once the domain verifies again.
    const lift = fresh.record.status === "suspended" && fresh.record.suspendedReason === "domain_unverified" && domain.verified;
    return {
      record: {
        ...withDomain.record,
        verification: { ...withDomain.record.verification, ...pinned.verification, domain },
        ...(lift ? { status: "active" as const, suspendedReason: null } : {}),
        pinsCheckedAt: iso(clock()),
        updatedAt: nextTimestamp(fresh.record.updatedAt, clock()),
      },
    };
  });
  if (!result) throw contractNotFound();
  if (result.after.record.revision !== result.before.record.revision) return announceRevision(result.before, result.after);
  if (result.before.record.status === "suspended" && result.after.record.status === "active") {
    publish("contract.reactivated", result.after.record, result.after.record.activeRevision ?? result.after.record.revision);
  }
  // A verified domain may let a pending revision activate now.
  return contractView(await settle(result.after), { owner: true });
}

/** POST /v1/contracts/{id}/suspend (operator): suspends any registration. */
export async function operatorSuspend(auth: AuthContext, id: string, body: unknown): Promise<ContractViewWithHistory> {
  if (auth.tier !== "operator") throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an operator API key.");
  const raw = isRecord(body) && typeof body.reason === "string" ? body.reason.replace(/\s+/gu, " ").trim() : "";
  if (!raw || raw.length > 200 || /[\p{Cc}\p{Cf}]/u.test(raw)) {
    throw invalidRequest("Body must be { \"reason\": \"…\" } with 1-200 printable characters.", [{ path: "reason", message: "Required, 1-200 printable characters." }]);
  }
  const existing = await contractStore().get(id);
  if (!existing || existing.record.status === "deleted") throw contractNotFound();
  const reason = `${OPERATOR_PREFIX}${raw}`;
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted") throw contractNotFound();
    if (isOperatorSuspension(entry.record)) return null;
    return { record: { ...entry.record, status: "suspended", suspendedReason: reason, updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) throw contractNotFound();
  if (!isOperatorSuspension(result.before.record) && isOperatorSuspension(result.after.record)) {
    publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, reason);
  }
  return contractView(result.after, { owner: false });
}

/** POST /v1/contracts/{id}/test: the plan + prepare pipeline as a dry run (never stored). */
export async function testContract(auth: AuthContext, id: string, request: ContractTestRequest): Promise<ContractTestResult> {
  assertContractsEnabled();
  const caller = reader(auth);
  const entry = await visibleEntry(caller, id);
  // The owner tests the latest revision (also while it is pending); other keys the one intents use.
  const revision = entry.record.ownerKeyId === caller.keyId ? latestRevision(entry) : usedRevision(entry);
  if (!revision.definition.actions.some((action) => action.id === request.entry)) {
    throw new PlatformError("CONTRACT_ACTION_UNKNOWN", `No action "${request.entry}" in this registration.`, 422, [{ path: "entry", message: "Unknown action id." }]);
  }
  const account = parseAccountId(request.account);
  if (!account || account.chain.key !== entry.record.network) {
    throw invalidRequest(`account must be a CAIP-10 account on ${entry.record.network}.`, [{ path: "account", message: "Wrong network." }]);
  }
  return contractEngine().testContractAction(registeredContract(entry, revision), request);
}

/* ================================================================ inspect */

function evmFunctions(abi: readonly ContractAbiItem[] | null): AbiFunctionClassification[] {
  if (!abi) return [];
  const out: AbiFunctionClassification[] = [];
  for (const item of abi) {
    if (!isRecord(item) || item.type !== "function" || typeof item.name !== "string" || !Array.isArray(item.inputs)) continue;
    try {
      out.push(classifyAbiFunction(item as unknown as AbiFunctionItem));
    } catch {
      // Malformed ABI entries from the provider are skipped.
    }
    if (out.length >= 200) break;
  }
  return out;
}

/** GET /v1/contracts/inspect: what registration would pin and allow (wizard helper; nothing is stored). */
export async function inspectContract(query: { network?: string; address?: string; programs?: string }): Promise<ContractInspection> {
  assertContractsEnabled();
  const chain = query.network ? resolveChain(query.network) : null;
  if (!chain) throw invalidRequest("network is required: a network key, CAIP-2 id or EVM chain id.", [{ path: "network", message: "Required." }]);
  const network = chain.key;
  const denylist = configuredDenylist();
  if (chain.vm === "evm") {
    const address = query.address ?? "";
    if (!isEvmAddress(address)) throw invalidRequest("address must be a 0x-prefixed 20-byte address.", [{ path: "address", message: "Invalid EVM address." }]);
    const denied = deniedTargetReason(network, address, denylist);
    const inspection = await contractEngine().inspectEvmContract(evmNetwork(network), address);
    const deployed = inspection.codeSize > 0 && !inspection.eip7702;
    const checks = contractChecks();
    const source = await checks.sourcify(network, address, true);
    const implementation = deployed && inspection.pins.proxy ? await checks.sourcify(network, inspection.pins.proxy.implementation, true) : null;
    const abi = implementation?.abi ?? source.abi;
    return {
      vm: "evm",
      network,
      address,
      deployed,
      codeSize: inspection.codeSize,
      eip7702: inspection.eip7702,
      denied,
      pins: deployed ? inspection.pins : null,
      verification: { source: source.verification, implementationSource: implementation?.verification ?? null },
      abi,
      functions: evmFunctions(abi),
    };
  }
  const programs = (query.programs ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (programs.length === 0 || programs.length > CONTRACT_LIMITS.programs || programs.some((program) => !isSolanaAddress(program))) {
    throw invalidRequest(`programs must list 1-${CONTRACT_LIMITS.programs} base58 program ids, comma separated.`, [{ path: "programs", message: "Invalid program list." }]);
  }
  const engine = contractEngine();
  const solana = solanaNetwork(network);
  const views = await Promise.all(
    [...new Set(programs)].map(async (program) => {
      const [pin, verification] = await Promise.all([
        engine.readSolanaProgramPins(solana, [program]).then((pins) => pins[0] ?? null).catch(() => null),
        contractChecks().ottersec(program),
      ]);
      return { program, pin, denied: deniedTargetReason(network, program, denylist), verification };
    }),
  );
  return { vm: "svm", network, programs: views };
}

/* ============================================================== directory */

let transport: ActionTransport | null = null;

function directoryTransport(): ActionTransport {
  transport ??= createActionTransport();
  return transport;
}

type ContractKeyScope = { readonly projectId: string | null };

/** Fresh key and lineage state: capability-based prepares must also stop after revocation or expiry. */
async function liveContractScope(keyId: string): Promise<ContractKeyScope | null> {
  if ([...loadOperatorKeys().values()].some((key) => key.id === keyId)) return { projectId: null };
  const keys = apiKeyStore();
  const key = await keys.findById(keyId);
  const now = Date.now();
  if (!key || !keyLive(key, now)) return null;
  const lineage = key.lineage ?? [];
  if (lineage.length > 0) {
    const ancestors = new Map((await keys.findMany(lineage)).map((ancestor) => [ancestor.id, ancestor]));
    if (!lineage.every((id) => {
      const ancestor = ancestors.get(id);
      return ancestor && ancestor.projectId === key.projectId && keyLive(ancestor, now);
    })) return null;
  }
  return { projectId: key.projectId };
}

type ContractScopeReader = (keyId: string) => Promise<ContractKeyScope | null>;

async function ownerUsable(record: ContractRecord, ownerKeyId: string, scopeOf: ContractScopeReader = liveContractScope): Promise<boolean> {
  if (record.status === "deleted") return false;
  const caller = await scopeOf(ownerKeyId);
  if (!caller) return false;
  if (record.ownerKeyId === ownerKeyId) return caller.projectId === record.projectId;
  if (record.visibility !== "project" || record.projectId === null || caller.projectId !== record.projectId) return false;
  const owner = await scopeOf(record.ownerKeyId);
  return owner !== null && owner.projectId === record.projectId;
}

async function usableEntries(ownerKeyId: string): Promise<ContractEntry[]> {
  // Share fresh reads within this operation, without a TTL that could keep revoked keys usable.
  const scopes = new Map<string, Promise<ContractKeyScope | null>>();
  const scopeOf: ContractScopeReader = (id) => {
    let pending = scopes.get(id);
    if (!pending) {
      pending = liveContractScope(id);
      scopes.set(id, pending);
    }
    return pending;
  };
  const caller = await scopeOf(ownerKeyId);
  if (!caller) return [];
  const out: ContractEntry[] = [];
  for (const raw of await contractStore().listVisible(ownerKeyId, caller.projectId)) {
    if (await ownerUsable(raw.record, ownerKeyId, scopeOf)) out.push(await settle(raw));
  }
  return out;
}

function today(): string {
  return iso(clock()).slice(0, 10);
}

/** The `ContractDirectory` the engine plans, prepares and verifies with. */
export function createContractDirectory(): ContractDirectory {
  return {
    async resolve(ownerKeyId: string, reference: string, network?: NetworkKey): Promise<RegisteredContract | null> {
      assertContractsEnabled();
      const wanted = reference.trim();
      if (CONTRACT_ID_PATTERN.test(wanted)) {
        const raw = await contractStore().get(wanted);
        if (!raw || !(await ownerUsable(raw.record, ownerKeyId))) return null;
        return registeredContract(await settle(raw));
      }
      const alias = wanted.toLowerCase().replace(/\s+/gu, " ");
      const matches = (await usableEntries(ownerKeyId)).filter((entry) => {
        if (network && entry.record.network !== network) return false;
        return usedRevision(entry).definition.actions.some((action) => (action.phrases?.aliases ?? []).includes(alias));
      });
      // Ambiguous aliases resolve to nothing; the grammar disambiguates by network first.
      return matches.length === 1 && matches[0] ? registeredContract(matches[0]) : null;
    },

    async phrases(ownerKeyId: string): Promise<readonly ContractPhrase[]> {
      if (!contractsEnabled()) return [];
      const out: ContractPhrase[] = [];
      for (const entry of await usableEntries(ownerKeyId)) {
        for (const action of usedRevision(entry).definition.actions) {
          if (!action.phrases || action.phrases.verbs.length === 0) continue;
          out.push({
            contract: entry.record.id,
            entry: action.id,
            network: entry.record.network,
            vm: entry.record.vm,
            verbs: action.phrases.verbs,
            aliases: action.phrases.aliases,
            spends: action.input !== undefined,
          });
        }
      }
      return out;
    },

    async current(id: string): Promise<RegisteredContract | null> {
      if (!CONTRACT_ID_PATTERN.test(id)) return null;
      const raw = await contractStore().get(id);
      if (!raw || raw.record.status === "deleted") return null;
      return registeredContract(await settle(raw));
    },

    async usableBy(id: string, ownerKeyId: string): Promise<boolean> {
      assertContractsEnabled();
      if (!CONTRACT_ID_PATTERN.test(id)) return false;
      const raw = await contractStore().get(id);
      return raw !== null && (await ownerUsable(raw.record, ownerKeyId));
    },

    denied(network: NetworkKey, target: string): string | null {
      return deniedTargetReason(network, target, configuredDenylist());
    },

    async reportAnomaly(id: string, reason: "pins_changed" | "outcome_mismatch" | "program_changed", detail: string): Promise<void> {
      await suspendContract(id, reason, detail);
    },

    async recordSpend(ownerKeyId: string, usd: number): Promise<void> {
      assertContractsEnabled();
      if (!Number.isFinite(usd) || usd < 0) return;
      const cap = keyDailyMaxUsd();
      if (!(await contractStore().addSpend(ownerKeyId, today(), usd, cap))) {
        throw new PlatformError(
          "CONTRACT_SPEND_LIMIT",
          `This key reached its daily notional cap of $${cap.toLocaleString("en-US")} for custom contract steps (UTC day). Retry tomorrow or ask the operator for a higher cap.`,
          422,
        );
      }
    },

    get actionTransport(): ActionTransport {
      return directoryTransport();
    },
  };
}

/**
 * Installs the directory into the engine (called by createPlatformRouter).
 * Idempotent, and it never replaces a directory an embedder or a test
 * installed (`configurePlatform({ contracts })`).
 */
export function installContractDirectory(): void {
  if (contractDirectory() !== null) return;
  configureContractDirectory(createContractDirectory());
}

/* ================================================================== usage */

export interface ContractUsage {
  readonly registered: number;
  readonly suspended: number;
  readonly preparedToday: number;
  readonly notionalTodayUsd: number;
}

/** The `contracts` block of GET /v1/usage. */
export async function contractUsage(keyId: string): Promise<ContractUsage> {
  const [counts, spend] = await Promise.all([contractStore().counts(keyId), contractStore().spend(keyId, today())]);
  return { registered: counts.registered, suspended: counts.suspended, preparedToday: spend.prepared, notionalTodayUsd: Math.round(spend.usd * 100) / 100 };
}

/* ====================================================== watcher internals */

export interface WatchOutcome {
  readonly id: string;
  readonly result: "unchanged" | "suspended" | "error";
  readonly detail?: string;
}

/** Re-reads one registration's pins (watcher): a difference suspends it. Never throws. */
export async function watchContract(entry: ContractEntry): Promise<WatchOutcome> {
  const { record } = entry;
  const revision = usedRevision(entry);
  try {
    let current: ContractPins;
    if (record.vm === "evm") {
      const definition = revision.definition as EvmContractDefinition;
      const inspection = await contractEngine().inspectEvmContract(evmNetwork(record.network), definition.address, definition.addresses ?? []);
      if (inspection.eip7702 || inspection.codeSize <= 0) {
        await suspendContract(record.id, "pins_changed", inspection.eip7702 ? "now an EIP-7702 delegated account" : "code removed");
        return { id: record.id, result: "suspended", detail: "code removed or delegated" };
      }
      current = inspection.pins;
    } else {
      current = await contractEngine().readSolanaProgramPins(solanaNetwork(record.network), (revision.definition as SolanaActionDefinition).programs);
    }
    const diff = comparePins(revision.pins, current);
    if (diff !== null) {
      await suspendContract(record.id, record.vm === "evm" ? "pins_changed" : "program_changed", diff);
      return { id: record.id, result: "suspended", detail: diff };
    }
    await mutate(record.id, async (fresh) =>
      fresh.record.status === "deleted"
        ? null
        : { record: { ...fresh.record, pinsCheckedAt: iso(clock()), updatedAt: nextTimestamp(fresh.record.updatedAt, clock()) } },
    );
    return { id: record.id, result: "unchanged" };
  } catch (error) {
    return { id: record.id, result: "error", detail: error instanceof Error ? error.message.slice(0, 120) : "check failed" };
  }
}

/** Re-checks the domain file of one registration (watcher, daily). A reserved brand that loses it is suspended. Never throws. */
export async function watchDomain(entry: ContractEntry): Promise<boolean | null> {
  const { record } = entry;
  const definition = usedRevision(entry).definition;
  try {
    const verified = await contractChecks().domain(definition.integrator.website, record.id);
    const domain = { verified, checkedAt: iso(clock()) };
    const result = await mutate(record.id, async (fresh) => {
      if (fresh.record.status === "deleted") return null;
      const lose = needsDomain(usedRevision(fresh).definition) && fresh.record.verification.domain.verified && !verified && fresh.record.status === "active";
      return {
        record: {
          ...fresh.record,
          verification: { ...fresh.record.verification, domain },
          ...(lose ? { status: "suspended" as const, suspendedReason: "domain_unverified" } : {}),
          updatedAt: nextTimestamp(fresh.record.updatedAt, clock()),
        },
      };
    });
    if (result && result.before.record.status !== "suspended" && result.after.record.status === "suspended") {
      publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, "domain_unverified");
    }
    if (result) await settle(result.after);
    return verified;
  } catch {
    return null;
  }
}

/** Registrations due for a pin check (watcher). */
export function contractsToWatch(limit: number): Promise<ContractEntry[]> {
  return contractStore().listForWatch(limit);
}
