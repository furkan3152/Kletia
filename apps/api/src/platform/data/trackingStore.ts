/**
 * Storage of tracked wallet sets (docs/platform/data.md, "Tracking"): the
 * registrations, their value snapshots and a cache of their classified
 * transactions. In memory (bounded maps) or Postgres when
 * KLETIA_DATABASE_URL is set (lazy DDL through the HTTP layer's pool, like
 * automations).
 *
 * - An address belongs to at most one tracked set (`member` is unique), so
 *   one wallet's sign-in can never read another person's set.
 * - Snapshots are keyed `(set, bucket)`: `h:<YYYY-MM-DDTHH>` (the first
 *   reading of the hour wins, kept 8 days) and `d:<YYYY-MM-DD>` (the latest
 *   reading of the day, kept). Writing the same bucket twice is harmless, so
 *   two snapshot runners never duplicate a point.
 * - Deleting a set deletes its snapshots and cached transactions.
 */
import type { DataLane, DataSnapshotPoint, DataTransaction } from "@kletia/core";
import { PlatformError } from "../errors.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../http/db.js";

export interface TrackingRecord {
  readonly id: string;
  /** `wallet:<evm|solana>:<address>` of the wallet that opted in. */
  readonly ownerRef: string;
  readonly lane: DataLane;
  readonly evm: readonly string[];
  readonly solana: readonly string[];
  readonly createdAt: string;
  readonly lastSnapshotAt: string | null;
}

export type WalletKind = "evm" | "solana";

export interface SnapshotWrite {
  readonly trackingId: string;
  readonly at: string;
  readonly usd: number;
  readonly complete: boolean;
}

export interface DataTrackingStore {
  readonly kind: "memory" | "postgres";
  /** Inserts the set; 409 DATA_WALLET_TRACKED when one of its addresses is already in another set. */
  create(record: TrackingRecord): Promise<void>;
  get(id: string): Promise<TrackingRecord | null>;
  /** The set `address` belongs to. */
  byMember(kind: WalletKind, address: string): Promise<TrackingRecord | null>;
  /** Adds an address (409 when tracked elsewhere); returns the updated set. */
  addWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord>;
  removeWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord | null>;
  delete(id: string): Promise<boolean>;
  /** Sets least recently snapshotted first. */
  listForSnapshot(limit: number): Promise<TrackingRecord[]>;
  /** Writes the hour (first wins) and day (latest wins) points of a reading. */
  writeSnapshot(write: SnapshotWrite): Promise<void>;
  /** Points of one resolution since `since`, oldest first. */
  snapshots(trackingId: string, resolution: "h" | "d", since: string | null): Promise<DataSnapshotPoint[]>;
  pruneHourly(before: string): Promise<void>;
  cacheTransactions(trackingId: string, transactions: readonly DataTransaction[]): Promise<void>;
  /** Cached transactions, newest first. */
  cachedTransactions(trackingId: string, limit: number): Promise<DataTransaction[]>;
}

export const TRACKING_LIMITS = Object.freeze({ cachedTransactions: 20_000, hourlyRetentionDays: 8 });

export function memberKey(kind: WalletKind, address: string): string {
  return `${kind}:${kind === "evm" ? address.toLowerCase() : address}`;
}

export function walletTracked(): PlatformError {
  return new PlatformError("DATA_WALLET_TRACKED", "This wallet is already tracked in another wallet set. Remove it there first.", 409);
}

export function hourBucket(at: string): string {
  return `h:${at.slice(0, 13)}`;
}

export function dayBucket(at: string): string {
  return `d:${at.slice(0, 10)}`;
}

/* ================================================================= memory */

export class MemoryDataTrackingStore implements DataTrackingStore {
  readonly kind = "memory" as const;
  private readonly sets = new Map<string, TrackingRecord>();
  private readonly members = new Map<string, string>();
  private readonly points = new Map<string, Map<string, DataSnapshotPoint>>();
  private readonly txs = new Map<string, Map<string, DataTransaction>>();

  constructor(private readonly maxSets = 5_000) {}

  async create(record: TrackingRecord): Promise<void> {
    const keys = [...record.evm.map((address) => memberKey("evm", address)), ...record.solana.map((address) => memberKey("solana", address))];
    if (keys.some((key) => this.members.has(key))) throw walletTracked();
    if (this.sets.size >= this.maxSets) throw new PlatformError("DATA_TRACKING_FULL", "Tracking is full on this instance. Try again later.", 503);
    this.sets.set(record.id, record);
    for (const key of keys) this.members.set(key, record.id);
  }

  async get(id: string): Promise<TrackingRecord | null> {
    return this.sets.get(id) ?? null;
  }

  async byMember(kind: WalletKind, address: string): Promise<TrackingRecord | null> {
    const id = this.members.get(memberKey(kind, address));
    return id ? (this.sets.get(id) ?? null) : null;
  }

  async addWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord> {
    const current = this.sets.get(id);
    if (!current) throw new PlatformError("DATA_NOT_TRACKED", "This wallet set is not tracked.", 404);
    const key = memberKey(kind, address);
    const holder = this.members.get(key);
    if (holder === id) return current;
    if (holder) throw walletTracked();
    const next = { ...current, [kind]: [...current[kind], address] };
    this.sets.set(id, next);
    this.members.set(key, id);
    return next;
  }

  async removeWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord | null> {
    const current = this.sets.get(id);
    if (!current) return null;
    const key = memberKey(kind, address);
    const next = { ...current, [kind]: current[kind].filter((entry) => memberKey(kind, entry) !== key) };
    this.sets.set(id, next);
    this.members.delete(key);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const current = this.sets.get(id);
    if (!current) return false;
    for (const [key, holder] of this.members) if (holder === id) this.members.delete(key);
    this.sets.delete(id);
    this.points.delete(id);
    this.txs.delete(id);
    return true;
  }

  async listForSnapshot(limit: number): Promise<TrackingRecord[]> {
    return [...this.sets.values()].sort((a, b) => (a.lastSnapshotAt ?? "").localeCompare(b.lastSnapshotAt ?? "")).slice(0, limit);
  }

  async writeSnapshot(write: SnapshotWrite): Promise<void> {
    const set = this.sets.get(write.trackingId);
    if (!set) return;
    const points = this.points.get(write.trackingId) ?? new Map<string, DataSnapshotPoint>();
    this.points.set(write.trackingId, points);
    const point = { at: write.at, usd: write.usd, complete: write.complete };
    if (!points.has(hourBucket(write.at))) points.set(hourBucket(write.at), point);
    points.set(dayBucket(write.at), point);
    this.sets.set(set.id, { ...set, lastSnapshotAt: write.at });
  }

  async snapshots(trackingId: string, resolution: "h" | "d", since: string | null): Promise<DataSnapshotPoint[]> {
    const points = this.points.get(trackingId);
    if (!points) return [];
    return [...points.entries()]
      .filter(([bucket, point]) => bucket.startsWith(`${resolution}:`) && (since === null || point.at >= since))
      .map(([, point]) => point)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async pruneHourly(before: string): Promise<void> {
    for (const points of this.points.values()) {
      for (const [bucket, point] of points) if (bucket.startsWith("h:") && point.at < before) points.delete(bucket);
    }
  }

  async cacheTransactions(trackingId: string, transactions: readonly DataTransaction[]): Promise<void> {
    if (!this.sets.has(trackingId)) return;
    const cached = this.txs.get(trackingId) ?? new Map<string, DataTransaction>();
    this.txs.set(trackingId, cached);
    for (const tx of transactions) cached.set(`${tx.account}|${tx.id}`, tx);
    if (cached.size > TRACKING_LIMITS.cachedTransactions) {
      const oldest = [...cached.entries()].sort((a, b) => a[1].time.localeCompare(b[1].time)).slice(0, cached.size - TRACKING_LIMITS.cachedTransactions);
      for (const [key] of oldest) cached.delete(key);
    }
  }

  async cachedTransactions(trackingId: string, limit: number): Promise<DataTransaction[]> {
    return [...(this.txs.get(trackingId)?.values() ?? [])].sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
  }
}

/* =============================================================== postgres */

const SCHEMA = {
  name: "kletia_data_tracking",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_data_tracking (
  id text PRIMARY KEY,
  owner_ref text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('production', 'testnet')),
  evm jsonb NOT NULL DEFAULT '[]',
  solana jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_snapshot_at timestamptz
);
CREATE INDEX IF NOT EXISTS kletia_data_tracking_snapshot_idx ON kletia_data_tracking (last_snapshot_at NULLS FIRST);
CREATE TABLE IF NOT EXISTS kletia_data_tracking_members (
  member text PRIMARY KEY,
  tracking_id text NOT NULL REFERENCES kletia_data_tracking (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS kletia_data_tracking_members_set_idx ON kletia_data_tracking_members (tracking_id);
CREATE TABLE IF NOT EXISTS kletia_data_snapshots (
  tracking_id text NOT NULL REFERENCES kletia_data_tracking (id) ON DELETE CASCADE,
  bucket text NOT NULL,
  at timestamptz NOT NULL,
  usd double precision NOT NULL,
  complete boolean NOT NULL,
  PRIMARY KEY (tracking_id, bucket)
);
CREATE TABLE IF NOT EXISTS kletia_data_transactions (
  tracking_id text NOT NULL REFERENCES kletia_data_tracking (id) ON DELETE CASCADE,
  tx_key text NOT NULL,
  at timestamptz NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (tracking_id, tx_key)
);
CREATE INDEX IF NOT EXISTS kletia_data_transactions_time_idx ON kletia_data_transactions (tracking_id, at DESC);`,
} as const;

const COLUMNS = "id, owner_ref, lane, evm, solana, created_at, last_snapshot_at";

interface TrackingRow {
  id: string;
  owner_ref: string;
  lane: DataLane;
  evm: string[];
  solana: string[];
  created_at: Date;
  last_snapshot_at: Date | null;
}

function fromRow(row: TrackingRow): TrackingRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    lane: row.lane,
    evm: row.evm,
    solana: row.solana,
    createdAt: row.created_at.toISOString(),
    lastSnapshotAt: row.last_snapshot_at?.toISOString() ?? null,
  };
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export class PostgresDataTrackingStore implements DataTrackingStore {
  readonly kind = "postgres" as const;

  async create(record: TrackingRecord): Promise<void> {
    const members = [...record.evm.map((address) => memberKey("evm", address)), ...record.solana.map((address) => memberKey("solana", address))];
    await dbTransaction(SCHEMA, async (client) => {
      await client.query(`INSERT INTO kletia_data_tracking (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, NULL)`, [
        record.id, record.ownerRef, record.lane, JSON.stringify(record.evm), JSON.stringify(record.solana), record.createdAt,
      ]);
      try {
        for (const member of members) await client.query("INSERT INTO kletia_data_tracking_members (member, tracking_id) VALUES ($1, $2)", [member, record.id]);
      } catch (error) {
        if (isUniqueViolation(error)) throw walletTracked();
        throw error;
      }
    });
  }

  async get(id: string): Promise<TrackingRecord | null> {
    const result = await dbQuery<TrackingRow>(SCHEMA, `SELECT ${COLUMNS} FROM kletia_data_tracking WHERE id = $1`, [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async byMember(kind: WalletKind, address: string): Promise<TrackingRecord | null> {
    const result = await dbQuery<TrackingRow>(
      SCHEMA,
      `SELECT t.id, t.owner_ref, t.lane, t.evm, t.solana, t.created_at, t.last_snapshot_at FROM kletia_data_tracking t JOIN kletia_data_tracking_members m ON m.tracking_id = t.id WHERE m.member = $1`,
      [memberKey(kind, address)],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async addWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord> {
    return dbTransaction(SCHEMA, async (client) => {
      const current = await client.query<TrackingRow>(`SELECT ${COLUMNS} FROM kletia_data_tracking WHERE id = $1 FOR UPDATE`, [id]);
      const row = current.rows[0];
      if (!row) throw new PlatformError("DATA_NOT_TRACKED", "This wallet set is not tracked.", 404);
      const record = fromRow(row);
      const key = memberKey(kind, address);
      if (record[kind].some((entry) => memberKey(kind, entry) === key)) return record;
      try {
        await client.query("INSERT INTO kletia_data_tracking_members (member, tracking_id) VALUES ($1, $2)", [key, id]);
      } catch (error) {
        if (isUniqueViolation(error)) throw walletTracked();
        throw error;
      }
      const next = [...record[kind], address];
      await client.query(`UPDATE kletia_data_tracking SET ${kind} = $2 WHERE id = $1`, [id, JSON.stringify(next)]);
      return { ...record, [kind]: next };
    });
  }

  async removeWallet(id: string, kind: WalletKind, address: string): Promise<TrackingRecord | null> {
    return dbTransaction(SCHEMA, async (client) => {
      const current = await client.query<TrackingRow>(`SELECT ${COLUMNS} FROM kletia_data_tracking WHERE id = $1 FOR UPDATE`, [id]);
      const row = current.rows[0];
      if (!row) return null;
      const record = fromRow(row);
      const key = memberKey(kind, address);
      const next = record[kind].filter((entry) => memberKey(kind, entry) !== key);
      await client.query("DELETE FROM kletia_data_tracking_members WHERE member = $1 AND tracking_id = $2", [key, id]);
      await client.query(`UPDATE kletia_data_tracking SET ${kind} = $2 WHERE id = $1`, [id, JSON.stringify(next)]);
      return { ...record, [kind]: next };
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await dbQuery(SCHEMA, "DELETE FROM kletia_data_tracking WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listForSnapshot(limit: number): Promise<TrackingRecord[]> {
    const result = await dbQuery<TrackingRow>(SCHEMA, `SELECT ${COLUMNS} FROM kletia_data_tracking ORDER BY last_snapshot_at NULLS FIRST LIMIT $1`, [limit]);
    return result.rows.map(fromRow);
  }

  async writeSnapshot(write: SnapshotWrite): Promise<void> {
    await dbTransaction(SCHEMA, async (client) => {
      const values = [write.trackingId, write.at, write.usd, write.complete];
      // The set may have been deleted meanwhile: the foreign key then refuses the point, which is fine.
      const exists = await client.query("SELECT 1 FROM kletia_data_tracking WHERE id = $1 FOR UPDATE", [write.trackingId]);
      if (exists.rowCount === 0) return;
      await client.query("INSERT INTO kletia_data_snapshots (tracking_id, bucket, at, usd, complete) VALUES ($1, $5, $2, $3, $4) ON CONFLICT DO NOTHING", [...values, hourBucket(write.at)]);
      await client.query(
        "INSERT INTO kletia_data_snapshots (tracking_id, bucket, at, usd, complete) VALUES ($1, $5, $2, $3, $4) ON CONFLICT (tracking_id, bucket) DO UPDATE SET at = EXCLUDED.at, usd = EXCLUDED.usd, complete = EXCLUDED.complete WHERE kletia_data_snapshots.at <= EXCLUDED.at",
        [...values, dayBucket(write.at)],
      );
      await client.query("UPDATE kletia_data_tracking SET last_snapshot_at = GREATEST(COALESCE(last_snapshot_at, $2), $2) WHERE id = $1", [write.trackingId, write.at]);
    });
  }

  async snapshots(trackingId: string, resolution: "h" | "d", since: string | null): Promise<DataSnapshotPoint[]> {
    const result = await dbQuery<{ at: Date; usd: number; complete: boolean }>(
      SCHEMA,
      "SELECT at, usd, complete FROM kletia_data_snapshots WHERE tracking_id = $1 AND bucket LIKE $2 AND ($3::timestamptz IS NULL OR at >= $3) ORDER BY at",
      [trackingId, `${resolution}:%`, since],
    );
    return result.rows.map((row) => ({ at: row.at.toISOString(), usd: Number(row.usd), complete: row.complete }));
  }

  async pruneHourly(before: string): Promise<void> {
    await dbQuery(SCHEMA, "DELETE FROM kletia_data_snapshots WHERE bucket LIKE 'h:%' AND at < $1", [before]);
  }

  async cacheTransactions(trackingId: string, transactions: readonly DataTransaction[]): Promise<void> {
    if (transactions.length === 0) return;
    await dbTransaction(SCHEMA, async (client) => {
      const exists = await client.query("SELECT 1 FROM kletia_data_tracking WHERE id = $1", [trackingId]);
      if (exists.rowCount === 0) return;
      for (const tx of transactions) {
        await client.query(
          "INSERT INTO kletia_data_transactions (tracking_id, tx_key, at, body) VALUES ($1, $2, $3, $4) ON CONFLICT (tracking_id, tx_key) DO UPDATE SET body = EXCLUDED.body",
          [trackingId, `${tx.account}|${tx.id}`, tx.time, JSON.stringify(tx)],
        );
      }
      await client.query(
        "DELETE FROM kletia_data_transactions WHERE tracking_id = $1 AND tx_key IN (SELECT tx_key FROM kletia_data_transactions WHERE tracking_id = $1 ORDER BY at DESC OFFSET $2)",
        [trackingId, TRACKING_LIMITS.cachedTransactions],
      );
    });
  }

  async cachedTransactions(trackingId: string, limit: number): Promise<DataTransaction[]> {
    const result = await dbQuery<{ body: DataTransaction }>(SCHEMA, "SELECT body FROM kletia_data_transactions WHERE tracking_id = $1 ORDER BY at DESC LIMIT $2", [trackingId, limit]);
    return result.rows.map((row) => row.body);
  }

  /** Runs `task` only while this process holds the snapshot lock (one runner across replicas). */
  async withLeaderLock(task: () => Promise<void>): Promise<boolean> {
    return dbTransaction(SCHEMA, async (client) => {
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('kletia_data_snapshots', 0)) AS locked");
      if (locked.rows[0]?.locked !== true) return false;
      await task();
      return true;
    });
  }
}

let store: DataTrackingStore | null = null;

export function dataTrackingStore(): DataTrackingStore {
  store ??= platformDatabaseUrl() ? new PostgresDataTrackingStore() : new MemoryDataTrackingStore();
  return store;
}

/** Replaces the store (tests); null re-selects by KLETIA_DATABASE_URL on next use. */
export function configureDataTrackingStore(custom: DataTrackingStore | null): void {
  store = custom;
}
