/**
 * Venue reliability and fill statistics (design B.1, B.2; red-team D1, D7,
 * D12). In memory, per instance (accepted risk AR4: they reset on deploy and
 * priors apply until they are rebuilt). Ranking inputs only: nothing here
 * makes an ineligible quote eligible.
 *
 * - Quotes, per (venue, network pair), rolling 15 minutes: latency p50/p95,
 *   failures, 429s. The circuit breaker counts only transport errors, HTTP
 *   5xx, 429 and timeouts (D7); unsupported pairs, amounts below a minimum and
 *   other business refusals never count. 5 consecutive counted failures, or
 *   more than half of at least 6 attempts in 2 minutes, open it for 30 s; then
 *   one trial request is let through (half-open): a success closes it, a
 *   counted failure opens it again.
 * - Fills, from verified settlements: per (venue, kind, network pair, log10
 *   USD bucket) the last 50 shortfalls against the quoted expected output
 *   (the haircut, a USD-weighted median clipped to 0-50 bps, D12); per
 *   (venue, network pair) the last 200 orders of solver-filled legs (the fill
 *   rate, prior 0.98).
 *
 * Replay tests freeze the statistics (`freezeVenueStats`) so a recorded
 * snapshot scores the same way twice (I9).
 */
import type { IntentActionKind, NetworkKey, ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";

export const STATS_WINDOW_MS = 15 * 60_000;
export const BREAKER_WINDOW_MS = 2 * 60_000;
export const BREAKER_CONSECUTIVE = 5;
export const BREAKER_MIN_ATTEMPTS = 6;
export const BREAKER_OPEN_MS = 30_000;
/** Verified fills a size bucket needs before its measured haircut replaces the prior (and claimed floors are no longer discounted). */
export const MEASURED_FILLS = 50;
/** Orders kept per (venue, network pair) for the fill rate. */
export const FILL_RATE_ORDERS = 200;
/** Prior fill rate of a solver-filled leg. */
export const PRIOR_FILL_RATE = 0.98;
/** Weight of the prior, in orders (the measured rate takes over as orders accumulate). */
const PRIOR_WEIGHT_ORDERS = 20;
export const MAX_HAIRCUT_BPS = 50;
const MAX_ATTEMPTS_PER_PAIR = 500;

/** Haircut priors until a bucket is measured (D12): on-chain-floor venues and same-asset solver bridges 0, solver-filled swaps 3 bps. */
export const HAIRCUT_PRIOR_BPS = Object.freeze({ onchain: 0, sameAssetBridge: 0, solverSwap: 3 });

export type QuoteOutcome = "ok" | "business" | "counted";

interface Attempt {
  readonly at: number;
  readonly ms: number;
  readonly outcome: QuoteOutcome;
  readonly rateLimited: boolean;
}

interface Breaker {
  consecutive: number;
  openUntil: number;
  /** A half-open trial is in flight. */
  trial: boolean;
}

interface Fill {
  readonly shortfallBps: number;
  readonly usd: number;
}

const attempts = new Map<string, Attempt[]>();
const breakers = new Map<string, Breaker>();
const fills = new Map<string, Fill[]>();
const orders = new Map<string, boolean[]>();
let frozen = false;

export function pairKey(venue: ProtocolId, network: NetworkKey, destination: NetworkKey): string {
  return `${venue}|${network}>${destination}`;
}

/** log10 USD size bucket ("u" when the size is unknown). */
export function sizeBucket(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) return "u";
  return String(Math.max(0, Math.floor(Math.log10(usd))));
}

function fillKey(venue: ProtocolId, kind: IntentActionKind, network: NetworkKey, destination: NetworkKey, usd: number | null): string {
  return `${pairKey(venue, network, destination)}|${kind}|${sizeBucket(usd)}`;
}

/**
 * True for the failures the breaker counts (D7): transport errors and HTTP
 * 5xx (`<PROVIDER>_UNAVAILABLE` with a 5xx status, unreadable or oversized
 * responses), 429 (PROVIDER_RATE_LIMITED) and timeouts. Business refusals
 * (4xx: unsupported pair, amount too small, a quote that failed Kletia's
 * checks) never count.
 */
export function isCountedFailure(error: unknown): boolean {
  if (!(error instanceof PlatformError)) return true;
  if (error.code === "PROVIDER_RATE_LIMITED" || error.code === "VENUE_TIMEOUT") return true;
  if (error.code === "PROVIDER_INVALID_JSON" || error.code === "PROVIDER_RESPONSE_TOO_LARGE") return true;
  return error.status >= 500 && /_UNAVAILABLE$/u.test(error.code);
}

function prune(list: Attempt[], now: number): Attempt[] {
  const kept = list.filter((attempt) => now - attempt.at <= STATS_WINDOW_MS);
  return kept.length > MAX_ATTEMPTS_PER_PAIR ? kept.slice(-MAX_ATTEMPTS_PER_PAIR) : kept;
}

function breakerOf(key: string): Breaker {
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = { consecutive: 0, openUntil: 0, trial: false };
    breakers.set(key, breaker);
  }
  return breaker;
}

/** Records one quote attempt (latency and outcome) and moves the breaker. */
export function recordQuote(
  venue: ProtocolId,
  network: NetworkKey,
  destination: NetworkKey,
  result: { readonly ms: number; readonly error?: unknown },
  now: number = Date.now(),
): void {
  if (frozen) return;
  const key = pairKey(venue, network, destination);
  const outcome: QuoteOutcome = result.error === undefined ? "ok" : isCountedFailure(result.error) ? "counted" : "business";
  const rateLimited = result.error instanceof PlatformError && result.error.code === "PROVIDER_RATE_LIMITED";
  const list = prune(attempts.get(key) ?? [], now);
  list.push({ at: now, ms: Math.max(0, result.ms), outcome, rateLimited });
  attempts.set(key, list);
  const breaker = breakerOf(key);
  breaker.trial = false;
  if (outcome !== "counted") {
    // Reachable (a quote or a business refusal): the venue answers; close the breaker.
    breaker.consecutive = 0;
    breaker.openUntil = 0;
    return;
  }
  breaker.consecutive += 1;
  const recent = list.filter((attempt) => now - attempt.at <= BREAKER_WINDOW_MS);
  const counted = recent.filter((attempt) => attempt.outcome === "counted").length;
  const ratioTrips = recent.length >= BREAKER_MIN_ATTEMPTS && counted * 2 > recent.length;
  if (breaker.consecutive >= BREAKER_CONSECUTIVE || ratioTrips || breaker.openUntil > 0) {
    // A failed half-open trial (openUntil already set and passed) opens it again.
    breaker.openUntil = now + BREAKER_OPEN_MS;
  }
}

export type BreakerState = "closed" | "open" | "half-open";

export function breakerState(venue: ProtocolId, network: NetworkKey, destination: NetworkKey, now: number = Date.now()): BreakerState {
  const breaker = breakers.get(pairKey(venue, network, destination));
  if (!breaker || breaker.openUntil === 0) return "closed";
  return now < breaker.openUntil ? "open" : "half-open";
}

/**
 * Whether an auction should skip this venue now: open breakers are skipped;
 * a half-open breaker lets one trial through at a time.
 */
export function shouldSkipVenue(venue: ProtocolId, network: NetworkKey, destination: NetworkKey, now: number = Date.now()): boolean {
  const state = breakerState(venue, network, destination, now);
  if (state === "closed") return false;
  if (state === "open") return true;
  const breaker = breakerOf(pairKey(venue, network, destination));
  if (breaker.trial) return true;
  if (!frozen) breaker.trial = true;
  return false;
}

export interface VenueQuoteStats {
  readonly attempts: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** Counted failures over attempts (0 without attempts). */
  readonly failureRate: number;
  readonly rateLimited: number;
  readonly breaker: BreakerState;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Rolling 15-minute quote statistics of one (venue, network pair). */
export function venueQuoteStats(venue: ProtocolId, network: NetworkKey, destination: NetworkKey, now: number = Date.now()): VenueQuoteStats {
  const list = (attempts.get(pairKey(venue, network, destination)) ?? []).filter((attempt) => now - attempt.at <= STATS_WINDOW_MS);
  const latencies = list.filter((attempt) => attempt.outcome === "ok").map((attempt) => attempt.ms).sort((a, b) => a - b);
  return {
    attempts: list.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    failureRate: list.length === 0 ? 0 : list.filter((attempt) => attempt.outcome === "counted").length / list.length,
    rateLimited: list.filter((attempt) => attempt.rateLimited).length,
    breaker: breakerState(venue, network, destination, now),
  };
}

/* ------------------------------------------------------------------ fills */

export interface FillRecord {
  readonly venue: ProtocolId;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly destination: NetworkKey;
  /** USD size of the leg (its input value); null when unknown. */
  readonly usd: number | null;
  /** Quoted expected output and what the venue delivered, in output base units. */
  readonly expected: bigint;
  readonly actual: bigint;
}

/** Records a verified fill (settlement or verify of a planned leg). */
export function recordFill(record: FillRecord): void {
  if (frozen || record.expected <= 0n || record.actual < 0n) return;
  const shortfall = record.actual >= record.expected ? 0 : Number(((record.expected - record.actual) * 1_000_000n) / record.expected) / 100;
  const key = fillKey(record.venue, record.kind, record.network, record.destination, record.usd);
  const list = fills.get(key) ?? [];
  list.push({ shortfallBps: Math.min(10_000, Math.max(0, shortfall)), usd: record.usd !== null && record.usd > 0 ? record.usd : 1 });
  fills.set(key, list.slice(-MEASURED_FILLS));
}

/** Records the end of a solver-filled order: filled, or not filled (refunded, expired, cancelled). */
export function recordOrder(venue: ProtocolId, network: NetworkKey, destination: NetworkKey, filled: boolean): void {
  if (frozen) return;
  const key = pairKey(venue, network, destination);
  const list = orders.get(key) ?? [];
  list.push(filled);
  orders.set(key, list.slice(-FILL_RATE_ORDERS));
}

/** USD-weighted median of shortfalls (bps). */
function weightedMedian(entries: readonly Fill[]): number {
  const sorted = [...entries].sort((a, b) => a.shortfallBps - b.shortfallBps);
  const total = sorted.reduce((sum, entry) => sum + entry.usd, 0);
  let seen = 0;
  for (const entry of sorted) {
    seen += entry.usd;
    if (seen * 2 >= total) return entry.shortfallBps;
  }
  return sorted.at(-1)?.shortfallBps ?? 0;
}

export interface HaircutReading {
  readonly bps: number;
  /** Verified fills in the bucket (at most MEASURED_FILLS kept). */
  readonly fills: number;
  /** True once the bucket holds MEASURED_FILLS fills: the measured value replaces the prior. */
  readonly measured: boolean;
}

/**
 * Haircut of a (venue, kind, network pair, size bucket): the USD-weighted
 * median shortfall of the last 50 verified fills, clipped to 0-50 bps, or
 * `priorBps` until the bucket is measured.
 */
export function haircut(
  venue: ProtocolId,
  kind: IntentActionKind,
  network: NetworkKey,
  destination: NetworkKey,
  usd: number | null,
  priorBps: number,
): HaircutReading {
  const list = fills.get(fillKey(venue, kind, network, destination, usd)) ?? [];
  if (list.length < MEASURED_FILLS) return { bps: priorBps, fills: list.length, measured: false };
  return { bps: Math.min(MAX_HAIRCUT_BPS, Math.max(0, weightedMedian(list))), fills: list.length, measured: true };
}

export interface FillRateReading {
  readonly rate: number;
  readonly orders: number;
}

/** Fill rate of a solver-filled (venue, network pair): the last 200 orders, blended with the 0.98 prior. */
export function fillRate(venue: ProtocolId, network: NetworkKey, destination: NetworkKey): FillRateReading {
  const list = orders.get(pairKey(venue, network, destination)) ?? [];
  const filled = list.filter(Boolean).length;
  const rate = (filled + PRIOR_FILL_RATE * PRIOR_WEIGHT_ORDERS) / (list.length + PRIOR_WEIGHT_ORDERS);
  return { rate: Math.min(1, Math.max(0, rate)), orders: list.length };
}

/* --------------------------------------------------------------- test seams */

/** Forgets every statistic and unfreezes (tests). */
export function resetVenueStats(): void {
  attempts.clear();
  breakers.clear();
  fills.clear();
  orders.clear();
  frozen = false;
}

/** Freezes the statistics: records are ignored and trials are not consumed (replay tests, I9). */
export function freezeVenueStats(value: boolean): void {
  frozen = value;
}
