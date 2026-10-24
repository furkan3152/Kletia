/**
 * Tracking (docs/platform/data.md): a desk user opts a wallet set into
 * value snapshots and a transaction cache. Every wallet of the set is proven
 * by its own wallet sign-in (the developer account session, SIWE or SIWS):
 * the session's wallet, plus any other wallet whose session token the
 * request also presents (signed in at the same origin). Nothing is tracked
 * without that.
 *
 * The snapshot job (`startDataSnapshotJob`, leader-only with Postgres like
 * the automation evaluator) reads each tracked set's portfolio at most once
 * an hour and writes the hour and day points; reading a set twice in one
 * hour, or two runners at once, never adds a point (trackingStore.ts).
 */
import { randomBytes } from "node:crypto";
import {
  DATA_SNAPSHOT_RANGES,
  type DataLane,
  type DataPortfolio,
  type DataSnapshotPoint,
  type DataSnapshotRange,
  type DataSnapshotSeries,
  type DataTracking,
  type DataWalletSet,
} from "@kletia/core";
import { PlatformError } from "../errors.js";
import { resolveAccountSession, type AccountSessionContext } from "../http/accounts/auth.js";
import { readDataPortfolio } from "./service.js";
import { dataTrackingStore, PostgresDataTrackingStore, TRACKING_LIMITS, type DataTrackingStore, type TrackingRecord, type WalletKind } from "./trackingStore.js";
import { laneAccounts, WALLET_LIMITS } from "./wallets.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PASS_LIMIT = 500;

export function trackingView(record: TrackingRecord): DataTracking {
  return { id: record.id, wallets: { evm: record.evm, solana: record.solana }, lane: record.lane, createdAt: record.createdAt, lastSnapshotAt: record.lastSnapshotAt };
}

/** The tracked set as the wallet set the data reads take. */
export function trackedWalletSet(record: TrackingRecord): DataWalletSet {
  return { evm: record.evm, solana: record.solana, lane: record.lane, accounts: laneAccounts(record.evm, record.solana, record.lane) };
}

export async function trackingOf(wallet: AccountSessionContext["wallet"], store: DataTrackingStore = dataTrackingStore()): Promise<TrackingRecord | null> {
  return store.byMember(wallet.walletKind, wallet.address);
}

/** Wallets proven by extra session tokens (same origin, live); an unknown or expired token is refused. */
async function provenWallets(tokens: readonly string[], origin: string): Promise<AccountSessionContext["wallet"][]> {
  const wallets: AccountSessionContext["wallet"][] = [];
  for (const token of tokens) {
    const session = await resolveAccountSession(token, origin);
    if (!session) throw new PlatformError("DATA_PROOF_INVALID", "A wallet proof is unknown, expired or from another site. Sign in with that wallet again.", 401);
    wallets.push(session.wallet);
  }
  return wallets;
}

function overLimit(record: Pick<TrackingRecord, "evm" | "solana">): boolean {
  return record.evm.length > WALLET_LIMITS.evm || record.solana.length > WALLET_LIMITS.solana;
}

/**
 * Opts in: creates the set of the session wallet (and the proven wallets),
 * or adds the proven wallets to the set the session wallet is in.
 */
export async function startTracking(
  session: AccountSessionContext["wallet"],
  input: { readonly lane: DataLane; readonly proofs: readonly string[]; readonly origin: string },
  store: DataTrackingStore = dataTrackingStore(),
  now = new Date(),
): Promise<TrackingRecord> {
  const wallets = [session, ...(await provenWallets(input.proofs, input.origin))];
  let record = await store.byMember(session.walletKind, session.address);
  if (!record) {
    const kinds = (kind: WalletKind) => [...new Set(wallets.filter((wallet) => wallet.walletKind === kind).map((wallet) => wallet.address))];
    const draft: TrackingRecord = {
      id: `trk_${randomBytes(12).toString("hex")}`,
      ownerRef: `wallet:${session.walletKind}:${session.address}`,
      lane: input.lane,
      evm: kinds("evm"),
      solana: kinds("solana"),
      createdAt: now.toISOString(),
      lastSnapshotAt: null,
    };
    if (overLimit(draft)) throw new PlatformError("DATA_TRACKING_LIMIT", `A tracked set holds at most ${WALLET_LIMITS.evm} EVM and ${WALLET_LIMITS.solana} Solana wallets.`, 422);
    await store.create(draft);
    return draft;
  }
  for (const wallet of wallets.slice(1)) {
    const already = record[wallet.walletKind].some((address) => (wallet.walletKind === "evm" ? address.toLowerCase() === wallet.address.toLowerCase() : address === wallet.address));
    if (already) continue;
    if (overLimit({ ...record, [wallet.walletKind]: [...record[wallet.walletKind], wallet.address] })) {
      throw new PlatformError("DATA_TRACKING_LIMIT", `A tracked set holds at most ${WALLET_LIMITS.evm} EVM and ${WALLET_LIMITS.solana} Solana wallets.`, 422);
    }
    record = await store.addWallet(record.id, wallet.walletKind, wallet.address);
  }
  return record;
}

/** Opts out: the set's creator deletes it with its snapshots and cache; another member only leaves it. */
export async function stopTracking(session: AccountSessionContext["wallet"], store: DataTrackingStore = dataTrackingStore()): Promise<{ readonly deleted: boolean }> {
  const record = await store.byMember(session.walletKind, session.address);
  if (!record) return { deleted: false };
  if (record.ownerRef === `wallet:${session.walletKind}:${session.address}`) return { deleted: await store.delete(record.id) };
  await store.removeWallet(record.id, session.walletKind, session.address);
  return { deleted: false };
}

/* --------------------------------------------------------------- series */

const RANGE_SPAN: Readonly<Record<DataSnapshotRange, number | null>> = Object.freeze({ "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, all: null });

export function isSnapshotRange(value: string): value is DataSnapshotRange {
  return (DATA_SNAPSHOT_RANGES as readonly string[]).includes(value);
}

function changeOf(points: readonly DataSnapshotPoint[]): DataSnapshotSeries["change"] {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return { usd: Math.round((last.usd - first.usd) * 100) / 100, pct: first.usd > 0 ? Math.round(((last.usd - first.usd) / first.usd) * 1e6) / 1e6 : null };
}

/** The value series of a tracked set (null: not tracked, an empty series with the reason). */
export async function snapshotSeries(record: TrackingRecord | null, range: DataSnapshotRange, store: DataTrackingStore = dataTrackingStore(), now = Date.now()): Promise<DataSnapshotSeries> {
  const asOf = new Date(now).toISOString();
  if (!record) {
    return { range, points: [], change: null, tracked: false, reason: "These wallets are not tracked: value history starts when a wallet owner turns tracking on.", source: "snapshot", asOf };
  }
  const span = RANGE_SPAN[range];
  const since = span === null ? null : new Date(now - span).toISOString();
  const points = await store.snapshots(record.id, range === "24h" || range === "7d" ? "h" : "d", since);
  return {
    range,
    points,
    change: changeOf(points),
    tracked: true,
    ...(points.length < 2 ? { reason: "Fewer than two readings in this range yet: the job reads tracked wallets once an hour." } : {}),
    source: "snapshot",
    asOf,
  };
}

/* ------------------------------------------------------------------ job */

export type PortfolioReader = (set: DataWalletSet) => Promise<Pick<DataPortfolio, "totals" | "asOf">>;

export interface SnapshotPassReport {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
}

/**
 * One pass: every tracked set not read this hour is read and, when its net
 * value is known, written as a point. A failed read writes nothing.
 */
export async function runSnapshotPass(now = Date.now(), store: DataTrackingStore = dataTrackingStore(), read: PortfolioReader = readDataPortfolio): Promise<SnapshotPassReport> {
  let readCount = 0;
  let written = 0;
  let skipped = 0;
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (const record of await store.listForSnapshot(PASS_LIMIT)) {
    if (record.lastSnapshotAt !== null && Date.parse(record.lastSnapshotAt) >= hour) {
      skipped += 1;
      continue;
    }
    readCount += 1;
    const portfolio = await read(trackedWalletSet(record)).catch((error: unknown) => {
      console.warn(`[platform] snapshot of ${record.id} failed:`, error instanceof Error ? error.message : error);
      return null;
    });
    const usd = portfolio?.totals.net.usd ?? null;
    if (portfolio === null || usd === null) continue;
    await store.writeSnapshot({ trackingId: record.id, at: new Date(now).toISOString(), usd, complete: portfolio.totals.complete });
    written += 1;
  }
  await store.pruneHourly(new Date(now - TRACKING_LIMITS.hourlyRetentionDays * DAY_MS).toISOString());
  return { read: readCount, written, skipped };
}

/** Starts the snapshot job every 10 minutes (leader-only with Postgres); returns a stop function. */
export function startDataSnapshotJob(intervalMs = 10 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const store = dataTrackingStore();
      const pass = async () => {
        await runSnapshotPass(Date.now(), store);
      };
      if (store instanceof PostgresDataTrackingStore) await store.withLeaderLock(pass);
      else await pass();
    } catch (error) {
      console.warn("[platform] data snapshot job failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
