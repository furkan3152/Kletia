/**
 * Per-key usage: GET /v1/usage?window=24h|7d.
 *
 * Every request made with an API key is counted when its response finishes,
 * by (key, hour, "<METHOD> <route template>", status class). Counts are
 * aggregated in process and flushed every 30 seconds (memory, or Postgres
 * `kletia_api_usage` with additive upserts, so several instances sum up).
 * Hosts that never start the background flusher (serverless) flush after
 * each request instead. The flusher also records each key's last use, at
 * most once a minute.
 *
 * The report adds the caller's live rate-limit window from this process's
 * limiter, the intents the key created in the window, by status, and its
 * custom contract activity (registrations, suspensions, and today's prepared
 * custom contract steps with their priced notional, UTC day) and its receipts
 * (issued in the window, waiting, active shares).
 */
import type { Request, RequestHandler } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { getIntentStore, listIntents } from "../index.js";
import { apiKeyStore, type KeyTier } from "./auth.js";
import { contractUsage, type ContractUsage } from "./contracts.js";
import { authOf, invalidRequest, queryParam } from "./context.js";
import { dbQuery, platformDatabaseUrl } from "./db.js";
import { TIER_LIMITS } from "./limits.js";
import { receiptStore } from "./receipts/store.js";

export const USAGE_FLUSH_INTERVAL_MS = 30_000;
const LAST_USED_INTERVAL_MS = 60_000;
const RETENTION_MS = 8 * 86_400_000;
const MAX_PENDING_ROWS = 50_000;
const HOUR_MS = 3_600_000;

export const USAGE_WINDOWS = { "24h": 24, "7d": 168 } as const;
export type UsageWindow = keyof typeof USAGE_WINDOWS;

export interface UsageRow {
  readonly keyId: string;
  /** Start of the hour, ISO. */
  readonly hour: string;
  /** "<METHOD> <route template>", e.g. "POST /intents/:id/cancel". */
  readonly route: string;
  readonly statusClass: string;
  readonly count: number;
}

/* ----------------------------------------------------------------- store */

export interface UsageStore {
  readonly kind: "memory" | "postgres";
  /** Adds counts (rows with the same key, hour, route and class are summed). */
  add(rows: readonly UsageRow[]): Promise<void>;
  read(keyId: string, sinceHour: string): Promise<UsageRow[]>;
  prune(beforeHour: string): Promise<void>;
}

function rowId(row: Pick<UsageRow, "keyId" | "hour" | "route" | "statusClass">): string {
  return `${row.keyId}\t${row.hour}\t${row.route}\t${row.statusClass}`;
}

export class MemoryUsageStore implements UsageStore {
  readonly kind = "memory" as const;
  private readonly rows = new Map<string, UsageRow>();

  constructor(private readonly maxRows = 200_000) {}

  async add(rows: readonly UsageRow[]): Promise<void> {
    for (const row of rows) {
      const id = rowId(row);
      const existing = this.rows.get(id);
      this.rows.delete(id);
      this.rows.set(id, { ...row, count: (existing?.count ?? 0) + row.count });
    }
    while (this.rows.size > this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }

  async read(keyId: string, sinceHour: string): Promise<UsageRow[]> {
    return [...this.rows.values()].filter((row) => row.keyId === keyId && row.hour >= sinceHour);
  }

  async prune(beforeHour: string): Promise<void> {
    for (const [id, row] of this.rows) if (row.hour < beforeHour) this.rows.delete(id);
  }
}

const USAGE_SCHEMA = {
  name: "kletia_api_usage",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_api_usage (
  key_id text NOT NULL,
  hour timestamptz NOT NULL,
  route text NOT NULL,
  status_class text NOT NULL,
  count bigint NOT NULL,
  PRIMARY KEY (key_id, hour, route, status_class)
);
CREATE INDEX IF NOT EXISTS kletia_api_usage_hour_idx ON kletia_api_usage (hour);`,
} as const;

export class PostgresUsageStore implements UsageStore {
  readonly kind = "postgres" as const;

  async add(rows: readonly UsageRow[]): Promise<void> {
    for (let start = 0; start < rows.length; start += 500) {
      const batch = rows.slice(start, start + 500);
      await dbQuery(
        USAGE_SCHEMA,
        `INSERT INTO kletia_api_usage (key_id, hour, route, status_class, count)
         SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::bigint[])
         ON CONFLICT (key_id, hour, route, status_class) DO UPDATE SET count = kletia_api_usage.count + EXCLUDED.count`,
        [batch.map((row) => row.keyId), batch.map((row) => row.hour), batch.map((row) => row.route), batch.map((row) => row.statusClass), batch.map((row) => row.count)],
      );
    }
  }

  async read(keyId: string, sinceHour: string): Promise<UsageRow[]> {
    const result = await dbQuery<{ hour: Date | string; route: string; status_class: string; count: string }>(
      USAGE_SCHEMA,
      "SELECT hour, route, status_class, count::text AS count FROM kletia_api_usage WHERE key_id = $1 AND hour >= $2",
      [keyId, sinceHour],
    );
    return result.rows.map((row) => ({
      keyId,
      hour: new Date(row.hour).toISOString(),
      route: row.route,
      statusClass: row.status_class,
      count: Number(row.count),
    }));
  }

  async prune(beforeHour: string): Promise<void> {
    await dbQuery(USAGE_SCHEMA, "DELETE FROM kletia_api_usage WHERE hour < $1", [beforeHour]);
  }
}

let store: UsageStore | null = null;

export function usageStore(): UsageStore {
  store ??= platformDatabaseUrl() ? new PostgresUsageStore() : new MemoryUsageStore();
  return store;
}

/* -------------------------------------------------------------- counting */

const pending = new Map<string, UsageRow>();
const lastUsed = new Map<string, string>();
let lastUsedFlushAt = 0;
let flusher: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let immediateFlush = false;

function hourOf(time: number): string {
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
}

function routeTemplate(req: Request): string {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  return `${req.method} ${typeof path === "string" ? path : "(unmatched)"}`;
}

/** Counts one finished keyed request. */
export function countRequest(keyId: string, route: string, status: number, now = Date.now()): void {
  const row = { keyId, hour: hourOf(now), route: route.slice(0, 120), statusClass: `${Math.floor(status / 100)}xx` };
  const id = rowId(row);
  if (!pending.has(id) && pending.size >= MAX_PENDING_ROWS) return;
  pending.set(id, { ...row, count: (pending.get(id)?.count ?? 0) + 1 });
  lastUsed.set(keyId, new Date(now).toISOString());
  if (!flusher && !immediateFlush) {
    // No background flusher (serverless): write after this request, coalescing bursts.
    immediateFlush = true;
    setImmediate(() => {
      immediateFlush = false;
      void flushUsage();
    });
  }
}

/** Counts every request made with a valid API key, once its response finishes. */
export const usageCounter: RequestHandler = (req, res, next) => {
  res.on("finish", () => {
    const auth = authOf(req);
    if (auth.keyId && !auth.rejection) countRequest(auth.keyId, routeTemplate(req), res.statusCode);
  });
  next();
};

async function writeUsage(now: number): Promise<void> {
  // Bounded rounds: rows counted meanwhile wait for the next flush.
  for (let round = 0; round < 10 && pending.size > 0; round += 1) {
    const rows = [...pending.values()];
    pending.clear();
    try {
      await usageStore().add(rows);
    } catch (error) {
      console.warn(`[platform] usage flush failed; ${rows.length} counters dropped:`, error instanceof Error ? error.message : error);
    }
  }
  if (lastUsed.size > 0 && now - lastUsedFlushAt >= LAST_USED_INTERVAL_MS) {
    lastUsedFlushAt = now;
    const touched = new Map(lastUsed);
    lastUsed.clear();
    await apiKeyStore()
      .touch(touched)
      .catch((error: unknown) => {
        console.warn("[platform] key last-used update failed:", error instanceof Error ? error.message : error);
      });
  }
}

/** Writes pending counts (and, at most once a minute, last-used times). Concurrent calls share one flush; never throws. */
export function flushUsage(now = Date.now()): Promise<void> {
  // Deferred with then() so `flushing` is assigned before the flush can finish and clear it.
  flushing ??= Promise.resolve()
    .then(() => writeUsage(now))
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/** Starts the 30 s flusher and daily pruning (long-running hosts). Returns a stop function. */
export function startUsageFlusher(intervalMs = USAGE_FLUSH_INTERVAL_MS): () => void {
  if (flusher) clearInterval(flusher);
  let lastPrune = 0;
  const timer = setInterval(() => {
    void flushUsage();
    const now = Date.now();
    if (now - lastPrune >= 24 * HOUR_MS) {
      lastPrune = now;
      usageStore()
        .prune(hourOf(now - RETENTION_MS))
        .catch((error: unknown) => {
          console.warn("[platform] usage prune failed:", error instanceof Error ? error.message : error);
        });
    }
  }, intervalMs);
  timer.unref?.();
  flusher = timer;
  return () => {
    clearInterval(timer);
    if (flusher === timer) flusher = null;
    void flushUsage();
  };
}

/* ---------------------------------------------------------------- report */

export interface UsageReport {
  readonly keyId: string;
  readonly tier: KeyTier;
  readonly window: UsageWindow;
  readonly since: string;
  readonly generatedAt: string;
  readonly rateLimit: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null; readonly windowSeconds: number };
  readonly totals: { readonly requests: number; readonly byStatusClass: Readonly<Record<string, number>> };
  readonly byRoute: readonly { readonly route: string; readonly requests: number; readonly byStatusClass: Readonly<Record<string, number>> }[];
  readonly series: readonly { readonly hour: string; readonly requests: number }[];
  readonly intents: { readonly created: number; readonly byStatus: Readonly<Record<string, number>> };
  readonly contracts: ContractUsage;
  /** Receipts of the key's intents: issued in the window, intents waiting for one, active shares. */
  readonly receipts: { readonly issued: number; readonly pending: number; readonly sharesActive: number };
}

export function parseUsageWindow(req: Request): UsageWindow {
  const value = queryParam(req, "window", 8) ?? "24h";
  if (value !== "24h" && value !== "7d") {
    throw invalidRequest("window must be 24h or 7d.", [{ path: "window", message: "Expected 24h or 7d." }]);
  }
  return value;
}

async function intentCounts(keyId: string, since: string): Promise<Record<string, number>> {
  const intents = getIntentStore();
  if (intents.countByOwner) return intents.countByOwner(keyId, since);
  // Stores without the counter: the most recent 200 intents.
  const counts: Record<string, number> = {};
  for (const intent of await listIntents(keyId, 200)) {
    if (intent.createdAt >= since) counts[intent.status] = (counts[intent.status] ?? 0) + 1;
  }
  return counts;
}

export async function usageReport(
  auth: { readonly keyId: string; readonly tier: KeyTier },
  window: UsageWindow,
  limiter?: Pick<RateLimitRequestHandler, "getKey">,
): Promise<UsageReport> {
  const now = Date.now();
  const hours = USAGE_WINDOWS[window];
  const firstHour = Math.floor(now / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS;
  const since = new Date(firstHour).toISOString();
  // Write everything counted so far, including rows that arrived while an earlier flush was running
  // (bounded: under constant traffic newer rows simply appear in the next report).
  for (let round = 0; round < 3; round += 1) {
    await flushUsage(now);
    if (pending.size === 0) break;
  }
  const rows = await usageStore().read(auth.keyId, since);

  const byStatusClass: Record<string, number> = {};
  const routes = new Map<string, { requests: number; byStatusClass: Record<string, number> }>();
  const series = new Map<string, number>();
  for (let index = 0; index < hours; index += 1) series.set(new Date(firstHour + index * HOUR_MS).toISOString(), 0);
  let requests = 0;
  for (const row of rows) {
    requests += row.count;
    byStatusClass[row.statusClass] = (byStatusClass[row.statusClass] ?? 0) + row.count;
    const route = routes.get(row.route) ?? { requests: 0, byStatusClass: {} };
    route.requests += row.count;
    route.byStatusClass[row.statusClass] = (route.byStatusClass[row.statusClass] ?? 0) + row.count;
    routes.set(row.route, route);
    if (series.has(row.hour)) series.set(row.hour, (series.get(row.hour) ?? 0) + row.count);
  }

  const limit = TIER_LIMITS[auth.tier];
  let hits = 0;
  let resetAt: string | null = null;
  try {
    const info = await limiter?.getKey(`key:${auth.keyId}`);
    hits = info?.totalHits ?? 0;
    resetAt = info?.resetTime ? info.resetTime.toISOString() : null;
  } catch {
    // A limiter store without reads reports the full allowance.
  }

  const intents = await intentCounts(auth.keyId, since);
  const contracts = await contractUsage(auth.keyId);
  const receipts = await receiptStore().ownerCounts(auth.keyId, since, new Date(now).toISOString());
  return {
    keyId: auth.keyId,
    tier: auth.tier,
    window,
    since,
    generatedAt: new Date(now).toISOString(),
    rateLimit: { limit, remaining: Math.max(0, limit - hits), resetAt, windowSeconds: 60 },
    totals: { requests, byStatusClass },
    byRoute: [...routes.entries()]
      .map(([route, entry]) => ({ route, ...entry }))
      .sort((a, b) => b.requests - a.requests || (a.route < b.route ? -1 : 1)),
    series: [...series.entries()].map(([hour, count]) => ({ hour, requests: count })),
    intents: { created: Object.values(intents).reduce((sum, count) => sum + count, 0), byStatus: intents },
    contracts,
    receipts,
  };
}
