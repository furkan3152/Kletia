/**
 * Intent link storage (links design §10): links, use rows and daily
 * counters, in memory (bounded maps; synchronous read-check-write gives the
 * same atomicity as the session store) or Postgres (lazy DDL).
 *
 * Uses: a link intent reserves one use at its first prepare (`used < maxUses`
 * and the per-account count under the limit, in one transaction serialised
 * per link), the first submit consumes it, and an intent that ends without a
 * submit releases it. A use consumed after its release (an EVM payload
 * broadcast after the intent expired) is counted again and flagged as
 * overflow: Kletia never refuses on-chain facts.
 *
 * Analytics rows hold additive integers only: no address, IP, user agent or
 * cookie column exists (the per-account limit stores a per-link salted
 * hash, only for links that set `perAccount`).
 */
import type { LinkDefinition, LinkMetric, LinkPins } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";

export type StoredLinkStatus = "pending" | "active" | "paused" | "suspended" | "deleted";

export interface LinkPublisherRecord {
  readonly name: string;
  readonly website?: string;
  readonly domain?: string;
  readonly domainVerified: boolean;
  readonly checkedAt?: string;
}

/** Events the watcher emits once per state (stored so instances agree). */
export interface LinkFlags {
  readonly expiredAnnounced?: boolean;
  readonly exhaustedAnnounced?: boolean;
}

export interface LinkRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly projectId: string | null;
  readonly status: StoredLinkStatus;
  readonly revision: number;
  readonly definition: LinkDefinition;
  readonly pins: LinkPins;
  readonly publisher: LinkPublisherRecord;
  readonly maxUses: number | null;
  /** Reserved + consumed uses. */
  readonly used: number;
  readonly expiresAt: string;
  readonly activatesAt: string | null;
  readonly blinkApprovedAt: string | null;
  readonly pausedReason: string | null;
  readonly suspendedReason: string | null;
  readonly flags: LinkFlags;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LinkUseState = "reserved" | "consumed" | "released";

export interface LinkUse {
  readonly linkId: string;
  readonly intentId: string;
  readonly state: LinkUseState;
  /** sha256(linkId ":" lower(source account)); only when the link sets perAccount. */
  readonly accountHash: string | null;
  /** `network:asset` of the funding choice. */
  readonly source: string;
  readonly reservedAt: string;
  readonly updatedAt: string;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly use: LinkUse; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: "exhausted" | "account_limit" | "inactive" };

export interface ReserveInput {
  readonly linkId: string;
  readonly intentId: string;
  readonly accountHash: string | null;
  readonly source: string;
  readonly perAccountMax: number | null;
  readonly now: number;
}

export interface LinkStatRow {
  readonly linkId: string;
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly metric: LinkMetric | "volumeUsdMicros";
  readonly dimension: string;
  readonly count: number;
  readonly usdMicros: number;
}

export interface LinkStore {
  readonly kind: "memory" | "postgres";
  /** Inserts unless the owner already holds `maxActive` live links (409 LINK_LIMIT_REACHED). */
  create(record: LinkRecord, maxActive: number, now: number): Promise<void>;
  get(id: string): Promise<LinkRecord | null>;
  /** Newest first. */
  listByOwner(ownerKeyId: string, options: { readonly status?: StoredLinkStatus; readonly limit: number }): Promise<LinkRecord[]>;
  /** Optimistic write: false when the stored `updatedAt` moved since the caller read it. */
  update(next: LinkRecord, expectedUpdatedAt: string): Promise<boolean>;
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  /** First submit: reserved (or released: overflow) → consumed. */
  consume(linkId: string, intentId: string, now: number): Promise<{ readonly changed: boolean; readonly overflow: boolean }>;
  /** Reserved → released (the intent ended without a submit); false when nothing changed. */
  release(linkId: string, intentId: string, now: number): Promise<boolean>;
  use(linkId: string, intentId: string): Promise<LinkUse | null>;
  /** Non-released uses of one account hash. */
  accountUses(linkId: string, accountHash: string): Promise<number>;
  /** Reservations older than `before` (sweeper). */
  staleReservations(before: string, limit: number): Promise<LinkUse[]>;
  /** Links the watcher looks at: pending, not yet announced as expired / exhausted, or due a domain check. */
  listForWatch(now: number, domainCheckBefore: string, limit: number): Promise<LinkRecord[]>;
  addStats(rows: readonly LinkStatRow[]): Promise<void>;
  readStats(linkId: string, sinceDay: string): Promise<LinkStatRow[]>;
  /** Use rows of links expired before `usesBefore`, stats rows before `statsBefore`. */
  prune(usesBefore: string, statsBefore: string): Promise<void>;
}

export function linkLimitReached(max: number): PlatformError {
  return new PlatformError("LINK_LIMIT_REACHED", `A key holds at most ${max} active links. Delete some or let them expire first.`, 409);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** Live: not deleted and not expired (counts against the per-key cap). */
function live(record: LinkRecord, now: number): boolean {
  return record.status !== "deleted" && Date.parse(record.expiresAt) > now;
}

/* ================================================================= memory */

export class MemoryLinkStore implements LinkStore {
  readonly kind = "memory" as const;
  private readonly links = new Map<string, LinkRecord>();
  private readonly uses = new Map<string, LinkUse>();
  private readonly stats = new Map<string, LinkStatRow>();

  constructor(private readonly maxLinks = 20_000, private readonly maxUses = 200_000) {}

  async create(record: LinkRecord, maxActive: number, now: number): Promise<void> {
    let active = 0;
    for (const link of this.links.values()) if (link.ownerKeyId === record.ownerKeyId && live(link, now)) active += 1;
    if (active >= maxActive) throw linkLimitReached(maxActive);
    this.links.set(record.id, record);
    while (this.links.size > this.maxLinks) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
  }

  async get(id: string): Promise<LinkRecord | null> {
    return this.links.get(id) ?? null;
  }

  async listByOwner(ownerKeyId: string, options: { readonly status?: StoredLinkStatus; readonly limit: number }): Promise<LinkRecord[]> {
    return [...this.links.values()]
      .filter((record) => record.ownerKeyId === ownerKeyId && (options.status ? record.status === options.status : record.status !== "deleted"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  async update(next: LinkRecord, expectedUpdatedAt: string): Promise<boolean> {
    const current = this.links.get(next.id);
    if (!current || current.updatedAt !== expectedUpdatedAt) return false;
    // `used` belongs to reservations (reserve / consume / release), never to a definition write.
    this.links.set(next.id, { ...next, used: current.used });
    return true;
  }

  private useKey(linkId: string, intentId: string): string {
    return `${linkId}|${intentId}`;
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    // Synchronous from here: concurrent reservations in this process cannot both pass.
    const key = this.useKey(input.linkId, input.intentId);
    const existing = this.uses.get(key);
    if (existing && existing.state !== "released") return { ok: true, use: existing, replayed: true };
    const link = this.links.get(input.linkId);
    if (!link || link.status !== "active" || Date.parse(link.expiresAt) <= input.now || (link.activatesAt !== null && Date.parse(link.activatesAt) > input.now)) {
      return { ok: false, reason: "inactive" };
    }
    if (input.perAccountMax !== null && input.accountHash !== null) {
      let count = 0;
      for (const use of this.uses.values()) if (use.linkId === input.linkId && use.accountHash === input.accountHash && use.state !== "released") count += 1;
      if (count >= input.perAccountMax) return { ok: false, reason: "account_limit" };
    }
    if (link.maxUses !== null && link.used >= link.maxUses) return { ok: false, reason: "exhausted" };
    this.links.set(link.id, { ...link, used: link.used + 1 });
    const use: LinkUse = {
      linkId: input.linkId,
      intentId: input.intentId,
      state: "reserved",
      accountHash: input.accountHash,
      source: input.source,
      reservedAt: iso(input.now),
      updatedAt: iso(input.now),
    };
    this.uses.set(key, use);
    while (this.uses.size > this.maxUses) {
      const oldest = this.uses.keys().next().value;
      if (oldest === undefined) break;
      this.uses.delete(oldest);
    }
    return { ok: true, use, replayed: false };
  }

  async consume(linkId: string, intentId: string, now: number): Promise<{ readonly changed: boolean; readonly overflow: boolean }> {
    const key = this.useKey(linkId, intentId);
    const existing = this.uses.get(key);
    if (existing?.state === "consumed") return { changed: false, overflow: false };
    const overflow = existing?.state === "released";
    if (!existing || overflow) {
      const link = this.links.get(linkId);
      if (link) this.links.set(linkId, { ...link, used: link.used + 1 });
    }
    this.uses.set(key, {
      linkId,
      intentId,
      state: "consumed",
      accountHash: existing?.accountHash ?? null,
      source: existing?.source ?? "",
      reservedAt: existing?.reservedAt ?? iso(now),
      updatedAt: iso(now),
    });
    return { changed: true, overflow };
  }

  async release(linkId: string, intentId: string, now: number): Promise<boolean> {
    const key = this.useKey(linkId, intentId);
    const existing = this.uses.get(key);
    if (!existing || existing.state !== "reserved") return false;
    this.uses.set(key, { ...existing, state: "released", updatedAt: iso(now) });
    const link = this.links.get(linkId);
    if (link && link.used > 0) this.links.set(linkId, { ...link, used: link.used - 1 });
    return true;
  }

  async use(linkId: string, intentId: string): Promise<LinkUse | null> {
    return this.uses.get(this.useKey(linkId, intentId)) ?? null;
  }

  async accountUses(linkId: string, accountHash: string): Promise<number> {
    let count = 0;
    for (const use of this.uses.values()) if (use.linkId === linkId && use.accountHash === accountHash && use.state !== "released") count += 1;
    return count;
  }

  async staleReservations(before: string, limit: number): Promise<LinkUse[]> {
    return [...this.uses.values()].filter((use) => use.state === "reserved" && use.reservedAt < before).slice(0, limit);
  }

  async listForWatch(now: number, domainCheckBefore: string, limit: number): Promise<LinkRecord[]> {
    return [...this.links.values()]
      .filter((link) => link.status !== "deleted" && (
        link.status === "pending" ||
        (Date.parse(link.expiresAt) <= now && !link.flags.expiredAnnounced) ||
        (link.maxUses !== null && link.used >= link.maxUses && !link.flags.exhaustedAnnounced) ||
        (link.publisher.website !== undefined && (link.publisher.checkedAt ?? "") < domainCheckBefore && Date.parse(link.expiresAt) > now)))
      .slice(0, limit);
  }

  private statKey(row: Pick<LinkStatRow, "linkId" | "day" | "metric" | "dimension">): string {
    return `${row.linkId}|${row.day}|${row.metric}|${row.dimension}`;
  }

  async addStats(rows: readonly LinkStatRow[]): Promise<void> {
    for (const row of rows) {
      const key = this.statKey(row);
      const known = this.stats.get(key);
      this.stats.set(key, known ? { ...known, count: known.count + row.count, usdMicros: known.usdMicros + row.usdMicros } : row);
    }
  }

  async readStats(linkId: string, sinceDay: string): Promise<LinkStatRow[]> {
    return [...this.stats.values()].filter((row) => row.linkId === linkId && row.day >= sinceDay);
  }

  async prune(usesBefore: string, statsBefore: string): Promise<void> {
    for (const [key, use] of this.uses) {
      const link = this.links.get(use.linkId);
      if (!link || link.expiresAt < usesBefore) this.uses.delete(key);
    }
    for (const [key, row] of this.stats) if (row.day < statsBefore.slice(0, 10)) this.stats.delete(key);
  }
}

/* =============================================================== postgres */

const LINKS_SCHEMA = {
  name: "kletia_links",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_links (
  id text PRIMARY KEY,
  owner_key_id text NOT NULL,
  project_id text,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'suspended', 'deleted')),
  revision integer NOT NULL DEFAULT 1,
  definition jsonb NOT NULL,
  pins jsonb NOT NULL,
  publisher jsonb NOT NULL,
  max_uses integer,
  used integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  activates_at timestamptz,
  blink_approved_at timestamptz,
  paused_reason text,
  suspended_reason text,
  flags jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_links_owner_idx ON kletia_links (owner_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_links_watch_idx ON kletia_links (status, activates_at, expires_at);
CREATE TABLE IF NOT EXISTS kletia_link_uses (
  link_id text NOT NULL REFERENCES kletia_links(id),
  intent_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  account_hash text,
  source text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, intent_id)
);
CREATE INDEX IF NOT EXISTS kletia_link_uses_account_idx ON kletia_link_uses (link_id, account_hash) WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS kletia_link_uses_sweep_idx ON kletia_link_uses (reserved_at) WHERE state = 'reserved';
CREATE TABLE IF NOT EXISTS kletia_link_stats (
  link_id text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL,
  dimension text NOT NULL DEFAULT '',
  count bigint NOT NULL DEFAULT 0,
  usd_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day, metric, dimension)
);`,
} as const;

const LINK_COLUMNS = "id, owner_key_id, project_id, status, revision, definition, pins, publisher, max_uses, used, expires_at, activates_at, blink_approved_at, paused_reason, suspended_reason, flags, created_at, updated_at";

interface LinkRow {
  id: string;
  owner_key_id: string;
  project_id: string | null;
  status: string;
  revision: number;
  definition: unknown;
  pins: unknown;
  publisher: unknown;
  max_uses: number | null;
  used: number;
  expires_at: Date | string;
  activates_at: Date | string | null;
  blink_approved_at: Date | string | null;
  paused_reason: string | null;
  suspended_reason: string | null;
  flags: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoOf(value);
}

const STATUSES: readonly StoredLinkStatus[] = ["pending", "active", "paused", "suspended", "deleted"];

function linkFromRow(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    ownerKeyId: row.owner_key_id,
    projectId: row.project_id,
    // An unknown stored status reads as suspended: never usable by accident.
    status: STATUSES.includes(row.status as StoredLinkStatus) ? (row.status as StoredLinkStatus) : "suspended",
    revision: row.revision,
    definition: row.definition as LinkDefinition,
    pins: row.pins as LinkPins,
    publisher: row.publisher as LinkPublisherRecord,
    maxUses: row.max_uses,
    used: row.used,
    expiresAt: isoOf(row.expires_at),
    activatesAt: isoOrNull(row.activates_at),
    blinkApprovedAt: isoOrNull(row.blink_approved_at),
    pausedReason: row.paused_reason,
    suspendedReason: row.suspended_reason,
    flags: (row.flags ?? {}) as LinkFlags,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

interface UseRow {
  link_id: string;
  intent_id: string;
  state: string;
  account_hash: string | null;
  source: string;
  reserved_at: Date | string;
  updated_at: Date | string;
}

function useFromRow(row: UseRow): LinkUse {
  return {
    linkId: row.link_id,
    intentId: row.intent_id,
    state: row.state === "consumed" ? "consumed" : row.state === "released" ? "released" : "reserved",
    accountHash: row.account_hash,
    source: row.source,
    reservedAt: isoOf(row.reserved_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function linkValues(record: LinkRecord): unknown[] {
  return [
    record.id, record.ownerKeyId, record.projectId, record.status, record.revision, JSON.stringify(record.definition), JSON.stringify(record.pins),
    JSON.stringify(record.publisher), record.maxUses, record.used, record.expiresAt, record.activatesAt, record.blinkApprovedAt, record.pausedReason,
    record.suspendedReason, JSON.stringify(record.flags), record.createdAt, record.updatedAt,
  ];
}

export class PostgresLinkStore implements LinkStore {
  readonly kind = "postgres" as const;

  async create(record: LinkRecord, maxActive: number, now: number): Promise<void> {
    const inserted = await dbTransaction(LINKS_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_links:${record.ownerKeyId}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_links WHERE owner_key_id = $1 AND status <> 'deleted' AND expires_at > $2",
        [record.ownerKeyId, iso(now)],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxActive) return false;
      await client.query(
        `INSERT INTO kletia_links (${LINK_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
        linkValues(record),
      );
      return true;
    });
    if (!inserted) throw linkLimitReached(maxActive);
  }

  async get(id: string): Promise<LinkRecord | null> {
    const result = await dbQuery<LinkRow>(LINKS_SCHEMA, `SELECT ${LINK_COLUMNS} FROM kletia_links WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? linkFromRow(row) : null;
  }

  async listByOwner(ownerKeyId: string, options: { readonly status?: StoredLinkStatus; readonly limit: number }): Promise<LinkRecord[]> {
    const result = await dbQuery<LinkRow>(
      LINKS_SCHEMA,
      options.status
        ? `SELECT ${LINK_COLUMNS} FROM kletia_links WHERE owner_key_id = $1 AND status = $3 ORDER BY created_at DESC LIMIT $2`
        : `SELECT ${LINK_COLUMNS} FROM kletia_links WHERE owner_key_id = $1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT $2`,
      options.status ? [ownerKeyId, options.limit, options.status] : [ownerKeyId, options.limit],
    );
    return result.rows.map(linkFromRow);
  }

  async update(next: LinkRecord, expectedUpdatedAt: string): Promise<boolean> {
    // `used` belongs to reservations (reserve / consume / release), never to a definition write.
    const result = await dbQuery(
      LINKS_SCHEMA,
      `UPDATE kletia_links SET status = $2, revision = $3, definition = $4::jsonb, pins = $5::jsonb, publisher = $6::jsonb, max_uses = $7,
         expires_at = $8, activates_at = $9, blink_approved_at = $10, paused_reason = $11, suspended_reason = $12, flags = $13::jsonb, updated_at = $14
       WHERE id = $1 AND updated_at = $15`,
      [
        next.id, next.status, next.revision, JSON.stringify(next.definition), JSON.stringify(next.pins), JSON.stringify(next.publisher), next.maxUses,
        next.expiresAt, next.activatesAt, next.blinkApprovedAt, next.pausedReason, next.suspendedReason, JSON.stringify(next.flags), next.updatedAt, expectedUpdatedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    return dbTransaction(LINKS_SCHEMA, async (client) => {
      // One reservation of a link at a time: maxUses and the per-account count hold across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_link_uses:${input.linkId}`]);
      const existing = await client.query<UseRow>("SELECT * FROM kletia_link_uses WHERE link_id = $1 AND intent_id = $2", [input.linkId, input.intentId]);
      const known = existing.rows[0];
      if (known && known.state !== "released") return { ok: true, use: useFromRow(known), replayed: true } as const;
      if (input.perAccountMax !== null && input.accountHash !== null) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM kletia_link_uses WHERE link_id = $1 AND account_hash = $2 AND state <> 'released'",
          [input.linkId, input.accountHash],
        );
        if (Number(count.rows[0]?.count ?? "0") >= input.perAccountMax) return { ok: false, reason: "account_limit" } as const;
      }
      const at = iso(input.now);
      const updated = await client.query<{ used: number }>(
        `UPDATE kletia_links SET used = used + 1, updated_at = updated_at
         WHERE id = $1 AND status = 'active' AND expires_at > $2 AND (activates_at IS NULL OR activates_at <= $2)
           AND (max_uses IS NULL OR used < max_uses)
         RETURNING used`,
        [input.linkId, at],
      );
      if (updated.rowCount !== 1) {
        const link = await client.query<{ status: string; max_uses: number | null; used: number; expires_at: Date; activates_at: Date | null }>(
          "SELECT status, max_uses, used, expires_at, activates_at FROM kletia_links WHERE id = $1",
          [input.linkId],
        );
        const row = link.rows[0];
        const exhausted = row && row.status === "active" && row.max_uses !== null && row.used >= row.max_uses && row.expires_at.getTime() > input.now;
        return { ok: false, reason: exhausted ? "exhausted" : "inactive" } as const;
      }
      const inserted = await client.query<UseRow>(
        `INSERT INTO kletia_link_uses (link_id, intent_id, state, account_hash, source, reserved_at, updated_at)
         VALUES ($1, $2, 'reserved', $3, $4, $5, $5)
         ON CONFLICT (link_id, intent_id) DO UPDATE SET state = 'reserved', reserved_at = EXCLUDED.reserved_at, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.linkId, input.intentId, input.accountHash, input.source, at],
      );
      return { ok: true, use: useFromRow(inserted.rows[0] as UseRow), replayed: false } as const;
    });
  }

  async consume(linkId: string, intentId: string, now: number): Promise<{ readonly changed: boolean; readonly overflow: boolean }> {
    return dbTransaction(LINKS_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_link_uses:${linkId}`]);
      const existing = await client.query<{ state: string }>("SELECT state FROM kletia_link_uses WHERE link_id = $1 AND intent_id = $2", [linkId, intentId]);
      const state = existing.rows[0]?.state;
      if (state === "consumed") return { changed: false, overflow: false };
      const at = iso(now);
      if (state === undefined) {
        const link = await client.query("SELECT 1 FROM kletia_links WHERE id = $1", [linkId]);
        if (link.rowCount !== 1) return { changed: false, overflow: false };
        await client.query(
          "INSERT INTO kletia_link_uses (link_id, intent_id, state, source, reserved_at, updated_at) VALUES ($1, $2, 'consumed', '', $3, $3)",
          [linkId, intentId, at],
        );
      } else {
        await client.query("UPDATE kletia_link_uses SET state = 'consumed', updated_at = $3 WHERE link_id = $1 AND intent_id = $2", [linkId, intentId, at]);
      }
      if (state === undefined || state === "released") await client.query("UPDATE kletia_links SET used = used + 1 WHERE id = $1", [linkId]);
      return { changed: true, overflow: state === "released" };
    });
  }

  async release(linkId: string, intentId: string, now: number): Promise<boolean> {
    return dbTransaction(LINKS_SCHEMA, async (client) => {
      const released = await client.query(
        "UPDATE kletia_link_uses SET state = 'released', updated_at = $3 WHERE link_id = $1 AND intent_id = $2 AND state = 'reserved' RETURNING 1",
        [linkId, intentId, iso(now)],
      );
      if (released.rowCount !== 1) return false;
      await client.query("UPDATE kletia_links SET used = used - 1 WHERE id = $1 AND used > 0", [linkId]);
      return true;
    });
  }

  async use(linkId: string, intentId: string): Promise<LinkUse | null> {
    const result = await dbQuery<UseRow>(LINKS_SCHEMA, "SELECT * FROM kletia_link_uses WHERE link_id = $1 AND intent_id = $2", [linkId, intentId]);
    const row = result.rows[0];
    return row ? useFromRow(row) : null;
  }

  async accountUses(linkId: string, accountHash: string): Promise<number> {
    const result = await dbQuery<{ count: string }>(
      LINKS_SCHEMA,
      "SELECT count(*)::text AS count FROM kletia_link_uses WHERE link_id = $1 AND account_hash = $2 AND state <> 'released'",
      [linkId, accountHash],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async staleReservations(before: string, limit: number): Promise<LinkUse[]> {
    const result = await dbQuery<UseRow>(
      LINKS_SCHEMA,
      "SELECT * FROM kletia_link_uses WHERE state = 'reserved' AND reserved_at < $1 ORDER BY reserved_at LIMIT $2",
      [before, limit],
    );
    return result.rows.map(useFromRow);
  }

  async listForWatch(now: number, domainCheckBefore: string, limit: number): Promise<LinkRecord[]> {
    const result = await dbQuery<LinkRow>(
      LINKS_SCHEMA,
      `SELECT ${LINK_COLUMNS} FROM kletia_links
       WHERE status <> 'deleted' AND (
         status = 'pending'
         OR (expires_at <= $1 AND NOT COALESCE((flags->>'expiredAnnounced')::boolean, false))
         OR (max_uses IS NOT NULL AND used >= max_uses AND NOT COALESCE((flags->>'exhaustedAnnounced')::boolean, false))
         OR (publisher ? 'website' AND COALESCE(publisher->>'checkedAt', '') < $2 AND expires_at > $1)
       )
       ORDER BY updated_at LIMIT $3`,
      [iso(now), domainCheckBefore, limit],
    );
    return result.rows.map(linkFromRow);
  }

  async addStats(input: readonly LinkStatRow[]): Promise<void> {
    // One row per key: ON CONFLICT DO UPDATE cannot touch a row twice in one statement.
    const merged = new Map<string, LinkStatRow>();
    for (const row of input) {
      const key = `${row.linkId}|${row.day}|${row.metric}|${row.dimension}`;
      const known = merged.get(key);
      merged.set(key, known ? { ...known, count: known.count + row.count, usdMicros: known.usdMicros + row.usdMicros } : row);
    }
    const rows = [...merged.values()];
    if (rows.length === 0) return;
    await dbQuery(
      LINKS_SCHEMA,
      `INSERT INTO kletia_link_stats (link_id, day, metric, dimension, count, usd_micros)
       SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::text[], $5::bigint[], $6::bigint[])
       ON CONFLICT (link_id, day, metric, dimension) DO UPDATE SET
         count = kletia_link_stats.count + EXCLUDED.count,
         usd_micros = kletia_link_stats.usd_micros + EXCLUDED.usd_micros`,
      [
        rows.map((row) => row.linkId), rows.map((row) => row.day), rows.map((row) => row.metric), rows.map((row) => row.dimension),
        rows.map((row) => row.count), rows.map((row) => row.usdMicros),
      ],
    );
  }

  async readStats(linkId: string, sinceDay: string): Promise<LinkStatRow[]> {
    const result = await dbQuery<{ link_id: string; day: Date | string; metric: string; dimension: string; count: string; usd_micros: string }>(
      LINKS_SCHEMA,
      "SELECT link_id, day::text AS day, metric, dimension, count::text AS count, usd_micros::text AS usd_micros FROM kletia_link_stats WHERE link_id = $1 AND day >= $2",
      [linkId, sinceDay],
    );
    return result.rows.map((row) => ({
      linkId: row.link_id,
      day: (row.day instanceof Date ? row.day.toISOString() : String(row.day)).slice(0, 10),
      metric: row.metric as LinkStatRow["metric"],
      dimension: row.dimension,
      count: Number(row.count),
      usdMicros: Number(row.usd_micros),
    }));
  }

  async prune(usesBefore: string, statsBefore: string): Promise<void> {
    await dbQuery(LINKS_SCHEMA, "DELETE FROM kletia_link_uses u USING kletia_links l WHERE u.link_id = l.id AND l.expires_at < $1", [usesBefore]);
    await dbQuery(LINKS_SCHEMA, "DELETE FROM kletia_link_stats WHERE day < $1", [statsBefore.slice(0, 10)]);
  }
}

let store: LinkStore | null = null;

export function linkStore(): LinkStore {
  store ??= platformDatabaseUrl() ? new PostgresLinkStore() : new MemoryLinkStore();
  return store;
}

/** Replaces the store (tests); null re-selects by KLETIA_DATABASE_URL on next use. */
export function configureLinkStore(custom: LinkStore | null): void {
  store = custom;
}

export function linkStoreKind(): "memory" | "postgres" {
  return linkStore().kind;
}
