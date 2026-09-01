import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { Pool, type PoolClient, type PoolConfig } from "pg";

const connectionString =
  process.env.STELLAR_EVENT_ARCHIVE_DATABASE_URL?.trim() || "";
const sqlitePath =
  process.env.NODE_ENV === "production" || connectionString
    ? ""
    : process.env.STELLAR_EVENT_ARCHIVE_SQLITE_PATH?.trim() ||
      process.env.WORKFLOW_V2_SQLITE_PATH?.trim() ||
      ".kletia/workflow-v2.sqlite";

export const STELLAR_EVENT_ARCHIVE_ENABLED =
  connectionString.length > 0 || sqlitePath.length > 0;

let pool: Pool | null = null;
let postgresInitialized: Promise<void> | null = null;
let sqlite: DatabaseSync | null = null;
let sqliteInitialized = false;

function archiveError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), {
    code: "STELLAR_EVENT_ARCHIVE_UNAVAILABLE",
    statusCode: 503,
  });
}

function archiveConflict(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), {
    code: "STELLAR_EVENT_ARCHIVE_CONFLICT",
    statusCode: 409,
  });
}

function rethrowArchiveFailure(error: unknown, fallbackMessage: string): never {
  if ((error as { code?: unknown })?.code === "STELLAR_EVENT_ARCHIVE_CONFLICT") {
    throw error;
  }
  throw archiveError(fallbackMessage, error);
}

function poolConfig(): PoolConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  return {
    connectionString,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(sslMode === "require" || sslMode === "verify-full"
      ? { ssl: { rejectUnauthorized: sslMode === "verify-full" } }
      : {}),
  };
}

function archivePool(): Pool {
  if (!connectionString) {
    throw archiveError("The Stellar event archive database is not configured.");
  }
  pool ??= new Pool(poolConfig());
  return pool;
}

function archiveSqlite(): DatabaseSync {
  if (!sqlitePath) {
    throw archiveError("The Stellar event archive is not configured.");
  }
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
    throw archiveError("The Stellar event archive must use a durable SQLite file.");
  }
  if (!sqlite) {
    const absolutePath = resolve(sqlitePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(absolutePath), 0o700);
    sqlite = new DatabaseSync(absolutePath);
    chmodSync(absolutePath, 0o600);
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }
  return sqlite;
}

async function ensureSchema(): Promise<void> {
  if (!STELLAR_EVENT_ARCHIVE_ENABLED) return;
  if (connectionString) {
    postgresInitialized ??= archivePool()
      .query(`
        CREATE TABLE IF NOT EXISTS stellar_archived_transactions (
          network TEXT NOT NULL CHECK (network = 'stellar_testnet'),
          transaction_hash CHAR(64) NOT NULL,
          ledger_sequence BIGINT NOT NULL CHECK (ledger_sequence > 0),
          event_count INTEGER NOT NULL CHECK (event_count > 0),
          event_set_sha256 CHAR(64) NOT NULL,
          ledger_closed_at TIMESTAMPTZ,
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (network, transaction_hash)
        );
        CREATE TABLE IF NOT EXISTS stellar_contract_events (
          network TEXT NOT NULL CHECK (network = 'stellar_testnet'),
          transaction_hash CHAR(64) NOT NULL,
          event_index INTEGER NOT NULL CHECK (event_index >= 0),
          ledger_sequence BIGINT NOT NULL CHECK (ledger_sequence > 0),
          contract_id VARCHAR(56) NOT NULL,
          event_xdr TEXT NOT NULL,
          ledger_closed_at TIMESTAMPTZ,
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (network, transaction_hash, event_index)
        );
        CREATE INDEX IF NOT EXISTS stellar_contract_events_contract_ledger_idx
          ON stellar_contract_events (network, contract_id, ledger_sequence, event_index);
      `)
      .then(() => undefined)
      .catch((error) => {
        postgresInitialized = null;
        throw archiveError("The Stellar event archive schema is unavailable.", error);
      });
    return postgresInitialized;
  }
  if (!sqliteInitialized) {
    try {
      archiveSqlite().exec(`
        CREATE TABLE IF NOT EXISTS stellar_archived_transactions (
          network TEXT NOT NULL CHECK (network = 'stellar_testnet'),
          transaction_hash TEXT NOT NULL CHECK (length(transaction_hash) = 64),
          ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence > 0),
          event_count INTEGER NOT NULL CHECK (event_count > 0),
          event_set_sha256 TEXT NOT NULL CHECK (length(event_set_sha256) = 64),
          ledger_closed_at TEXT,
          archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (network, transaction_hash)
        );
        CREATE TABLE IF NOT EXISTS stellar_contract_events (
          network TEXT NOT NULL CHECK (network = 'stellar_testnet'),
          transaction_hash TEXT NOT NULL CHECK (length(transaction_hash) = 64),
          event_index INTEGER NOT NULL CHECK (event_index >= 0),
          ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence > 0),
          contract_id TEXT NOT NULL CHECK (length(contract_id) = 56),
          event_xdr TEXT NOT NULL,
          ledger_closed_at TEXT,
          archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (network, transaction_hash, event_index)
        );
        CREATE INDEX IF NOT EXISTS stellar_contract_events_contract_ledger_idx
          ON stellar_contract_events (network, contract_id, ledger_sequence, event_index);
      `);
      sqliteInitialized = true;
    } catch (error) {
      throw archiveError("The Stellar SQLite event archive schema is unavailable.", error);
    }
  }
}

export interface ArchivedStellarEventInput {
  readonly contractId: string;
  readonly eventXdr: string;
}

interface StoredTransactionHeader {
  readonly ledger_sequence: number | string;
  readonly event_count: number | string;
  readonly event_set_sha256: string;
  readonly ledger_closed_at: string | null;
  readonly archived_at: string;
}

interface StoredEventRow {
  readonly event_index: number;
  readonly ledger_sequence: number | string;
  readonly contract_id: string;
  readonly event_xdr: string;
  readonly ledger_closed_at: string | null;
  readonly archived_at: string;
}

function canonicalEvent(input: ArchivedStellarEventInput): ArchivedStellarEventInput {
  if (!StrKey.isValidContract(input.contractId)) {
    throw archiveConflict("An archived Stellar event contract ID is invalid.");
  }
  if (
    typeof input.eventXdr !== "string" ||
    input.eventXdr.length === 0 ||
    input.eventXdr.length > 1_000_000
  ) {
    throw archiveConflict("An archived Stellar event XDR value is invalid.");
  }
  let decoded: xdr.ContractEvent;
  try {
    decoded = xdr.ContractEvent.fromXdr(input.eventXdr, "base64");
  } catch (error) {
    throw archiveConflict("An archived Stellar event XDR value could not be decoded.", error);
  }
  if (decoded.contractId === null) {
    throw archiveConflict("An archived Stellar event has no contract identity.");
  }
  const embeddedContractId = StrKey.encodeContract(
    Buffer.from(decoded.contractId.value),
  );
  if (embeddedContractId !== input.contractId) {
    throw archiveConflict(
      "An archived Stellar event contract ID does not match its XDR payload.",
    );
  }
  return {
    contractId: embeddedContractId,
    eventXdr: decoded.toXdr("base64"),
  };
}

function eventSetDigest(input: {
  transactionHash: string;
  ledgerSequence: number;
  events: readonly ArchivedStellarEventInput[];
}): string {
  return createHash("sha256")
    .update("KLETIA_STELLAR_EVENT_SET_V1\0", "utf8")
    .update(
      JSON.stringify({
        transactionHash: input.transactionHash,
        ledgerSequence: input.ledgerSequence,
        events: input.events.map((event, eventIndex) => ({
          eventIndex,
          contractId: event.contractId,
          eventXdr: event.eventXdr,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

function assertStoredEventSet(input: {
  transactionHash: string;
  header: StoredTransactionHeader | undefined;
  rows: readonly StoredEventRow[];
}): void {
  const { header, rows } = input;
  if (!header) {
    throw archiveConflict("The Stellar archive transaction header is missing.");
  }
  const ledgerSequence = Number(header.ledger_sequence);
  const eventCount = Number(header.event_count);
  if (
    !Number.isSafeInteger(ledgerSequence) ||
    ledgerSequence <= 0 ||
    !Number.isSafeInteger(eventCount) ||
    eventCount <= 0 ||
    rows.length !== eventCount
  ) {
    throw archiveConflict("The Stellar archive contains an incomplete transaction event set.");
  }
  const events = rows.map((row, expectedIndex) => {
    if (
      row.event_index !== expectedIndex ||
      Number(row.ledger_sequence) !== ledgerSequence
    ) {
      throw archiveConflict("The Stellar archive event order or ledger binding is inconsistent.");
    }
    return canonicalEvent({ contractId: row.contract_id, eventXdr: row.event_xdr });
  });
  const digest = eventSetDigest({
    transactionHash: input.transactionHash,
    ledgerSequence,
    events,
  });
  if (
    !/^[a-f0-9]{64}$/u.test(header.event_set_sha256) ||
    digest !== header.event_set_sha256
  ) {
    throw archiveConflict(
      "The Stellar archive event-set digest does not match its immutable header.",
    );
  }
}

function assertHeaderMatches(input: {
  header: StoredTransactionHeader | undefined;
  ledgerSequence: number;
  eventCount: number;
  eventSetSha256: string;
}): void {
  if (
    !input.header ||
    Number(input.header.ledger_sequence) !== input.ledgerSequence ||
    Number(input.header.event_count) !== input.eventCount ||
    input.header.event_set_sha256 !== input.eventSetSha256
  ) {
    throw archiveConflict(
      "The Stellar transaction hash is already bound to different archive evidence.",
    );
  }
}

export async function archiveVerifiedStellarTransaction(input: {
  transactionHash: string;
  ledgerSequence: number;
  ledgerClosedAt?: string;
  events: readonly ArchivedStellarEventInput[];
}): Promise<void> {
  if (!STELLAR_EVENT_ARCHIVE_ENABLED) return;
  if (!/^[a-f0-9]{64}$/u.test(input.transactionHash)) {
    throw archiveConflict("The verified Stellar transaction hash is invalid.");
  }
  if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) {
    throw archiveConflict("The verified Stellar ledger sequence is invalid.");
  }
  if (input.events.length === 0 || input.events.length > 1_024) {
    throw archiveConflict("A verified Stellar transaction has an invalid event count.");
  }
  const events = input.events.map(canonicalEvent);
  const eventSetSha256 = eventSetDigest({
    transactionHash: input.transactionHash,
    ledgerSequence: input.ledgerSequence,
    events,
  });
  const ledgerClosedAt = input.ledgerClosedAt?.trim() || null;
  if (ledgerClosedAt !== null && Number.isNaN(Date.parse(ledgerClosedAt))) {
    throw archiveConflict("The verified Stellar ledger close time is invalid.");
  }
  await ensureSchema();

  if (!connectionString) {
    const database = archiveSqlite();
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        INSERT INTO stellar_archived_transactions
          (network, transaction_hash, ledger_sequence, event_count, event_set_sha256, ledger_closed_at)
        VALUES ('stellar_testnet', ?, ?, ?, ?, ?)
        ON CONFLICT (network, transaction_hash) DO NOTHING
      `).run(
        input.transactionHash,
        input.ledgerSequence,
        events.length,
        eventSetSha256,
        ledgerClosedAt,
      );
      const header = database.prepare(`
        SELECT ledger_sequence, event_count, event_set_sha256, ledger_closed_at, archived_at
          FROM stellar_archived_transactions
         WHERE network = 'stellar_testnet' AND transaction_hash = ?
      `).get(input.transactionHash) as StoredTransactionHeader | undefined;
      assertHeaderMatches({
        header,
        ledgerSequence: input.ledgerSequence,
        eventCount: events.length,
        eventSetSha256,
      });
      const statement = database.prepare(`
        INSERT INTO stellar_contract_events
          (network, transaction_hash, event_index, ledger_sequence, contract_id, event_xdr, ledger_closed_at)
        VALUES ('stellar_testnet', ?, ?, ?, ?, ?, ?)
        ON CONFLICT (network, transaction_hash, event_index) DO NOTHING
      `);
      for (const [eventIndex, event] of events.entries()) {
        statement.run(
          input.transactionHash,
          eventIndex,
          input.ledgerSequence,
          event.contractId,
          event.eventXdr,
          ledgerClosedAt,
        );
      }
      const rows = database.prepare(`
        SELECT event_index, ledger_sequence, contract_id, event_xdr, ledger_closed_at, archived_at
          FROM stellar_contract_events
         WHERE network = 'stellar_testnet' AND transaction_hash = ?
         ORDER BY event_index ASC
      `).all(input.transactionHash) as unknown as StoredEventRow[];
      assertStoredEventSet({ transactionHash: input.transactionHash, header, rows });
      database.exec("COMMIT");
      return;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may have failed before BEGIN acquired the write lock.
      }
      rethrowArchiveFailure(
        error,
        "The verified Stellar events could not be archived in SQLite.",
      );
    }
  }

  const client = await archivePool().connect().catch((error) => {
    throw archiveError("The Stellar event archive could not be reached.", error);
  });
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO stellar_archived_transactions
        (network, transaction_hash, ledger_sequence, event_count, event_set_sha256, ledger_closed_at)
       VALUES ('stellar_testnet', $1, $2, $3, $4, $5)
       ON CONFLICT (network, transaction_hash) DO NOTHING`,
      [
        input.transactionHash,
        input.ledgerSequence,
        events.length,
        eventSetSha256,
        ledgerClosedAt,
      ],
    );
    const headerResult = await client.query<StoredTransactionHeader>(
      `SELECT ledger_sequence::text, event_count::text, event_set_sha256,
              ledger_closed_at::text, archived_at::text
         FROM stellar_archived_transactions
        WHERE network = 'stellar_testnet' AND transaction_hash = $1
        FOR UPDATE`,
      [input.transactionHash],
    );
    const header = headerResult.rows[0];
    assertHeaderMatches({
      header,
      ledgerSequence: input.ledgerSequence,
      eventCount: events.length,
      eventSetSha256,
    });
    for (const [eventIndex, event] of events.entries()) {
      await client.query(
        `INSERT INTO stellar_contract_events
          (network, transaction_hash, event_index, ledger_sequence, contract_id, event_xdr, ledger_closed_at)
         VALUES ('stellar_testnet', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (network, transaction_hash, event_index) DO NOTHING`,
        [
          input.transactionHash,
          eventIndex,
          input.ledgerSequence,
          event.contractId,
          event.eventXdr,
          ledgerClosedAt,
        ],
      );
    }
    const rowsResult = await client.query<StoredEventRow>(
      `SELECT event_index, ledger_sequence::text, contract_id, event_xdr,
              ledger_closed_at::text, archived_at::text
         FROM stellar_contract_events
        WHERE network = 'stellar_testnet' AND transaction_hash = $1
        ORDER BY event_index ASC`,
      [input.transactionHash],
    );
    assertStoredEventSet({
      transactionHash: input.transactionHash,
      header,
      rows: rowsResult.rows,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    rethrowArchiveFailure(error, "The verified Stellar events could not be archived.");
  } finally {
    client.release();
  }
}

export async function readStellarEventArchiveStatus() {
  if (!STELLAR_EVENT_ARCHIVE_ENABLED) {
    return {
      enabled: false,
      status: "not_configured" as const,
      eventCount: "0",
      transactionCount: "0",
      oldestVerifiedTransactionLedger: null,
      newestVerifiedTransactionLedger: null,
      ingestedThroughObservedLedger: null,
      completenessModel: "verified_workflow_transactions_only" as const,
      contiguousLedgerIngestionGuaranteed: false as const,
      cryptographicCompletenessGuaranteed: false as const,
    };
  }
  await ensureSchema();
  if (!connectionString) {
    const row = archiveSqlite().prepare(`
      SELECT
        COALESCE(SUM(event_count), 0) AS event_count,
        COUNT(*) AS transaction_count,
        MIN(ledger_sequence) AS oldest_ledger,
        MAX(ledger_sequence) AS newest_ledger
      FROM stellar_archived_transactions
      WHERE network = 'stellar_testnet'
    `).get() as
      | {
          event_count: number;
          transaction_count: number;
          oldest_ledger: number | null;
          newest_ledger: number | null;
        }
      | undefined;
    return {
      enabled: true,
      status: "ready" as const,
      backend: "sqlite" as const,
      eventCount: String(row?.event_count || 0),
      transactionCount: String(row?.transaction_count || 0),
      oldestVerifiedTransactionLedger:
        row?.oldest_ledger == null ? null : String(row.oldest_ledger),
      newestVerifiedTransactionLedger:
        row?.newest_ledger == null ? null : String(row.newest_ledger),
      // This archive records exact verified workflow transactions, not every
      // ledger. A maximum ledger must never be advertised as an ingestion cursor.
      ingestedThroughObservedLedger: null,
      completenessModel: "verified_workflow_transactions_only" as const,
      contiguousLedgerIngestionGuaranteed: false as const,
      cryptographicCompletenessGuaranteed: false as const,
    };
  }
  const result = await archivePool().query<{
    event_count: string;
    transaction_count: string;
    oldest_ledger: string | null;
    newest_ledger: string | null;
  }>(`
    SELECT
      COALESCE(SUM(event_count), 0)::text AS event_count,
      COUNT(*)::text AS transaction_count,
      MIN(ledger_sequence)::text AS oldest_ledger,
      MAX(ledger_sequence)::text AS newest_ledger
    FROM stellar_archived_transactions
    WHERE network = 'stellar_testnet'
  `);
  const row = result.rows[0];
  return {
    enabled: true,
    status: "ready" as const,
    backend: "postgresql" as const,
    eventCount: row?.event_count || "0",
    transactionCount: row?.transaction_count || "0",
    oldestVerifiedTransactionLedger: row?.oldest_ledger || null,
    newestVerifiedTransactionLedger: row?.newest_ledger || null,
    ingestedThroughObservedLedger: null,
    completenessModel: "verified_workflow_transactions_only" as const,
    contiguousLedgerIngestionGuaranteed: false as const,
    cryptographicCompletenessGuaranteed: false as const,
  };
}

export type StellarArchiveCoverage =
  | "not_configured"
  | "empty"
  | "rpc_overlaps_archive"
  | "unrecoverable_gap"
  | "indeterminate";

export interface StellarArchiveCoverageReport {
  readonly schemaVersion: "kletia_stellar_archive_coverage_v1";
  readonly coverage: StellarArchiveCoverage;
  readonly archiveNewestLedger: string | null;
  readonly rpcOldestLedger: string | null;
  readonly rpcLatestLedger: string | null;
  readonly historyReconstructable: boolean;
  readonly reason: string;
  readonly contiguousLedgerIngestionGuaranteed: false;
  readonly cryptographicCompletenessGuaranteed: false;
}

/**
 * This archive is an immutable cache of transactions Kletia already verified;
 * it is not a continuous Stellar ledger indexer. Consequently an overlap
 * between its newest transaction and the RPC retention window cannot prove
 * account-history completeness. Recovery stays fail-closed until an expected
 * transaction list or a gap-free ingestion cursor is supplied by a future
 * recovery protocol.
 */
export async function readStellarArchiveCoverage(input: {
  rpcOldestLedger: number | string | null | undefined;
  rpcLatestLedger: number | string | null | undefined;
}): Promise<StellarArchiveCoverageReport> {
  const base = {
    schemaVersion: "kletia_stellar_archive_coverage_v1" as const,
    cryptographicCompletenessGuaranteed: false as const,
    contiguousLedgerIngestionGuaranteed: false as const,
    rpcOldestLedger:
      input.rpcOldestLedger == null ? null : String(input.rpcOldestLedger),
    rpcLatestLedger:
      input.rpcLatestLedger == null ? null : String(input.rpcLatestLedger),
  };
  if (!STELLAR_EVENT_ARCHIVE_ENABLED) {
    return {
      ...base,
      coverage: "not_configured",
      archiveNewestLedger: null,
      historyReconstructable: false,
      reason:
        "No durable event archive is configured, so clean-device recovery cannot claim complete history.",
    };
  }
  const status = await readStellarEventArchiveStatus();
  const archiveNewestLedger = status.newestVerifiedTransactionLedger;
  if (archiveNewestLedger === null) {
    return {
      ...base,
      coverage: "empty",
      archiveNewestLedger: null,
      historyReconstructable: false,
      reason:
        "The archive holds no complete verified transaction event set.",
    };
  }
  const newest = Number(archiveNewestLedger);
  const oldestRetained = Number(base.rpcOldestLedger);
  if (!Number.isSafeInteger(newest) || !Number.isSafeInteger(oldestRetained)) {
    return {
      ...base,
      coverage: "indeterminate",
      archiveNewestLedger,
      historyReconstructable: false,
      reason:
        "The archive or Stellar RPC retention boundary was unreadable, so coverage remains indeterminate.",
    };
  }
  if (newest < oldestRetained - 1) {
    return {
      ...base,
      coverage: "unrecoverable_gap",
      archiveNewestLedger,
      historyReconstructable: false,
      reason: `Stellar RPC has discarded ledgers ${newest + 1} to ${oldestRetained - 1}; this workflow-only archive has no complete ledger cursor for that span.`,
    };
  }
  return {
    ...base,
    coverage: "indeterminate",
    archiveNewestLedger,
    historyReconstructable: false,
    reason:
      "The archive overlaps Stellar RPC, but it stores only verified workflow transactions and cannot prove that every recovery-relevant event was ingested.",
  };
}

function sqliteArchivedTransaction(transactionHash: string): {
  header: StoredTransactionHeader | undefined;
  rows: StoredEventRow[];
} {
  const database = archiveSqlite();
  const header = database.prepare(`
    SELECT ledger_sequence, event_count, event_set_sha256, ledger_closed_at, archived_at
      FROM stellar_archived_transactions
     WHERE network = 'stellar_testnet' AND transaction_hash = ?
  `).get(transactionHash) as StoredTransactionHeader | undefined;
  const rows = database.prepare(`
    SELECT event_index, ledger_sequence, contract_id, event_xdr,
           ledger_closed_at, archived_at
      FROM stellar_contract_events
     WHERE network = 'stellar_testnet' AND transaction_hash = ?
     ORDER BY event_index ASC
  `).all(transactionHash) as unknown as StoredEventRow[];
  return { header, rows };
}

async function postgresArchivedTransaction(
  client: Pool | PoolClient,
  transactionHash: string,
): Promise<{ header: StoredTransactionHeader | undefined; rows: StoredEventRow[] }> {
  const [headerResult, rowsResult] = await Promise.all([
    client.query<StoredTransactionHeader>(
      `SELECT ledger_sequence::text, event_count::text, event_set_sha256,
              ledger_closed_at::text, archived_at::text
         FROM stellar_archived_transactions
        WHERE network = 'stellar_testnet' AND transaction_hash = $1`,
      [transactionHash],
    ),
    client.query<StoredEventRow>(
      `SELECT event_index, ledger_sequence::text, contract_id, event_xdr,
              ledger_closed_at::text, archived_at::text
         FROM stellar_contract_events
        WHERE network = 'stellar_testnet' AND transaction_hash = $1
        ORDER BY event_index ASC`,
      [transactionHash],
    ),
  ]);
  return { header: headerResult.rows[0], rows: rowsResult.rows };
}

export async function readArchivedTransactionEvents(hashInput: unknown) {
  const transactionHash = String(hashInput ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(transactionHash)) {
    throw Object.assign(new Error("A Stellar transaction hash is required."), {
      code: "STELLAR_TRANSACTION_HASH_INVALID",
      statusCode: 400,
    });
  }
  if (!STELLAR_EVENT_ARCHIVE_ENABLED) {
    throw archiveError("The Stellar event archive database is not configured.");
  }
  await ensureSchema();
  const stored = connectionString
    ? await postgresArchivedTransaction(archivePool(), transactionHash)
    : sqliteArchivedTransaction(transactionHash);
  if (!stored.header) {
    if (stored.rows.length > 0) {
      throw archiveConflict(
        "The Stellar archive contains orphaned events without an immutable transaction header.",
      );
    }
    throw Object.assign(
      new Error("The Stellar transaction is not present in the verified archive."),
      { code: "STELLAR_ARCHIVE_TRANSACTION_NOT_FOUND", statusCode: 404 },
    );
  }
  assertStoredEventSet({
    transactionHash,
    header: stored.header,
    rows: stored.rows,
  });
  return {
    schemaVersion: "kletia_stellar_event_archive_v1" as const,
    network: "stellar_testnet" as const,
    transactionHash,
    ledgerSequence: String(stored.header.ledger_sequence),
    expectedEventCount: String(stored.header.event_count),
    eventSetSha256: stored.header.event_set_sha256,
    transactionContractEventSetComplete: true as const,
    events: stored.rows.map((row) => ({
      eventIndex: row.event_index,
      ledgerSequence: String(row.ledger_sequence),
      contractId: row.contract_id,
      eventXdr: row.event_xdr,
      ledgerClosedAt: row.ledger_closed_at,
      archivedAt: row.archived_at,
    })),
    completenessModel: "exact_verified_transaction_contract_event_set" as const,
    contiguousLedgerIngestionGuaranteed: false as const,
    cryptographicCompletenessGuaranteed: false as const,
  };
}
