/**
 * Net-value readings this API instance took of a wallet set, for the two
 * estimates the portfolio shows (both labelled as estimates, never realised
 * PnL; deposits and withdrawals move them too):
 *
 * - `change24h`: net value now against the reading closest to 24 hours ago
 *   (within 2 hours of it); unknown until such a reading exists.
 * - `pnl`: net value now against the first reading of the wallet set.
 *
 * Process memory only, keyed by a hash of the wallet set (no address is
 * stored): readings reset on restart and differ between instances. At most
 * one reading per 20 minutes and 80 per set are kept; at most 5,000 sets.
 */
import { createHash } from "node:crypto";
import type { DataValueChange, DataWalletSet } from "@kletia/core";

const MIN_GAP_MS = 20 * 60_000;
const MAX_READINGS = 80;
const MAX_SETS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
const DAY_TOLERANCE_MS = 2 * 60 * 60_000;

interface Reading {
  readonly at: number;
  readonly usd: number;
}

interface Series {
  readonly first: Reading;
  readonly readings: Reading[];
}

const series = new Map<string, Series>();

/** Forgets every reading (tests). */
export function resetValueSnapshots(): void {
  series.clear();
}

/** Stable key of a wallet set: lane plus sorted addresses (EVM lower-cased), hashed. */
export function walletSetKey(set: Pick<DataWalletSet, "evm" | "solana" | "lane">): string {
  const parts = [set.lane, ...set.evm.map((address) => `e:${address.toLowerCase()}`).sort(), ...set.solana.map((address) => `s:${address}`).sort()];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Records a complete net-value reading at `now` (incomplete totals are never recorded). */
export function recordValue(key: string, usd: number, now = Date.now()): void {
  if (!Number.isFinite(usd)) return;
  const existing = series.get(key);
  if (!existing) {
    series.set(key, { first: { at: now, usd }, readings: [{ at: now, usd }] });
    while (series.size > MAX_SETS) {
      const oldest = series.keys().next().value;
      if (oldest === undefined) break;
      series.delete(oldest);
    }
    return;
  }
  const last = existing.readings[existing.readings.length - 1];
  if (last && now - last.at < MIN_GAP_MS) return;
  existing.readings.push({ at: now, usd });
  if (existing.readings.length > MAX_READINGS) existing.readings.splice(0, existing.readings.length - MAX_READINGS);
}

function change(now: number, value: number | null, earlier: Reading | undefined, missing: string): DataValueChange {
  const base = { source: "snapshot" as const, estimate: true as const };
  if (value === null) return { ...base, usd: null, pct: null, since: earlier ? new Date(earlier.at).toISOString() : null, reason: "The current value is not known." };
  if (!earlier) return { ...base, usd: null, pct: null, since: null, reason: missing };
  const usd = Math.round((value - earlier.usd) * 100) / 100;
  return { ...base, usd, pct: earlier.usd > 0 ? Math.round(((value - earlier.usd) / earlier.usd) * 1e6) / 1e6 : null, since: new Date(earlier.at).toISOString() };
}

/** The reading closest to 24 hours before `now`, within two hours of it. */
function dayAgo(readings: readonly Reading[], now: number): Reading | undefined {
  let best: Reading | undefined;
  for (const reading of readings) {
    const distance = Math.abs(now - DAY_MS - reading.at);
    if (distance > DAY_TOLERANCE_MS) continue;
    if (!best || distance < Math.abs(now - DAY_MS - best.at)) best = reading;
  }
  return best;
}

/** The 24-hour change and the change since the first reading of `key`, for net value `value` (null: unknown). */
export function valueChanges(key: string, value: number | null, now = Date.now()): { change24h: DataValueChange; pnl: DataValueChange } {
  const entry = series.get(key);
  const first = entry && entry.first.at < now ? entry.first : undefined;
  return {
    change24h: change(now, value, entry ? dayAgo(entry.readings, now) : undefined, "No reading of these wallets from about 24 hours ago yet."),
    pnl: change(now, value, first, "This is the first reading of these wallets; the change starts from now."),
  };
}
