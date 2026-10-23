/**
 * Earn ranking: which venue an unnamed deposit uses and which provider an
 * unnamed stake uses.
 *
 * Venues. Every venue of the asset on the network is ranked before any list is
 * shortened, on its smoothed rate (the venue's realised rate over about 7
 * days), never on the instantaneous rate alone:
 *
 *   score = (smoothedApy - holdingPenalty(tier)) * amountUsd * 30/365 - gasUsd
 *
 * A venue takes part in the comparison ("compared") only when
 *   - its tier is eligible: core and curated; extended only when the person
 *     named the protocol; testnet venues on the testnet lane;
 *   - it is not paused, frozen or full (capacity);
 *   - its smoothed rate and its TVL were read;
 *   - its TVL reaches the tier's floor (core $50M, curated $10M, extended $2M);
 *   - its current rate is within 2x of its smoothed rate either way (a rate
 *     spiked for an hour by a donation or an incentive is dropped).
 * A venue that fails a check is listed with the reason, never ranked as zero.
 * The only venue left, or the default venue of a protocol the person named,
 * stays usable without a comparison (it is chosen because it is the only one
 * or because it was named, not by rate); the result says so.
 *
 * Preferences: "safest" ranks by tier first; "yield" ranks by the raw smoothed
 * rate over core and curated only. A migration ("move my aave usdc to the best
 * yield") excludes its source venue and must beat it by more than the gas of
 * switching over 30 days (`migrationVerdict`).
 *
 * Stakes. Providers of the input asset are ranked on the smoothed growth of
 * their token's own rate (net of the protocol fee) minus the holding penalty;
 * a provider whose rate was not read keeps Kletia's default order.
 *
 * Ranking only orders eligible candidates: it never makes an ineligible venue
 * eligible, never changes the asset, amount, network or a named venue, and
 * every number is advisory (adapters re-read what they gate on). Reads are
 * read-only and bounded (1.5 s by default); nothing is signed or sent.
 */
import {
  CHAINS,
  protocolTier,
  riskAdjustedApy,
  TVL_FLOOR_USD,
  type NetworkKey,
  type ProtocolId,
  type ProtocolTier,
  type YieldVenue,
} from "@kletia/core";
import { defaultProvider, REGISTRY_STAKE_PROVIDERS, STAKE_PROVIDERS, venueCandidates, type StakeProvider } from "../clarify/catalog.js";
import { readStakeMetrics, readVenueReading, SNAPSHOT_LIMITS, type SnapshotApy, type StakeMetricsReading } from "./snapshot.js";

/* ------------------------------------------------------------------ types */

export type YieldPreference = "safest" | "yield";

export interface RankedYieldVenue {
  readonly venue: YieldVenue;
  /** The venue's current supply rate (fraction); null when unread. */
  readonly apy: number | null;
  /** Its realised rate over about 7 days (fraction); null when unread. */
  readonly smoothedApy: number | null;
  /** The smoothed rate net of the tier's holding penalty; null when the smoothed rate is unknown. */
  readonly adjustedApy: number | null;
  readonly tvlUsd: number | null;
  readonly tier: ProtocolTier;
  /** False: paused, frozen or full; null: capacity not read. */
  readonly capacityOk: boolean | null;
  /** True when the venue took part in the rate comparison (or is usable as the only or named venue; see `why`). */
  readonly compared: boolean;
  /** Why it ranks where it does, in Kletia's words (no vendor names). */
  readonly why: string;
}

export interface RankedStakeProvider {
  /** Clarify provider id (the `provider` a stake action carries). */
  readonly provider: string;
  /** The liquid-staking token (or SOL for native staking). */
  readonly lst: string;
  /** Smoothed growth of the token's rate (fraction), net of the protocol fee; null when unread. */
  readonly apy: number | null;
  readonly adjustedApy: number | null;
  readonly tier: ProtocolTier;
  readonly why: string;
}

/** The reading of one venue the ranking needs (a snapshot APY entry has every field). */
export type YieldReading = Pick<SnapshotApy, "status" | "apy" | "smoothedApy" | "tvlUsd" | "capRemaining" | "paused" | "frozen">;

export interface YieldRankQuery {
  readonly network: NetworkKey;
  readonly symbol: string;
  readonly amountUsd?: number;
  readonly prefer?: YieldPreference;
  /** A protocol the person named: only its venues; its vaults are ranked by the same score. */
  readonly protocol?: ProtocolId;
  /** Venues left out entirely (a migration's source). */
  readonly excludeVenueIds?: readonly string[];
  readonly deadlineMs?: number;
}

/** Limits of the earn ranking. */
export const YIELD_RANK = Object.freeze({
  /** A current rate more than this factor away from the smoothed rate (either way) drops the venue. */
  maxDeviation: 2,
  /** Days of yield the score counts. */
  days: 30,
  /**
   * Default bound of the reads (1.5 s): the snapshot's own bound, read when used, because snapshot.ts and
   * this module import each other through the decision layer and a module entered from snapshot.ts first would
   * otherwise read SNAPSHOT_LIMITS before it is initialised.
   */
  get deadlineMs(): number {
    return SNAPSHOT_LIMITS.apyReadMs;
  },
});

/* ---------------------------------------------------------------- helpers */

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const millions = (usd: number) => `$${Math.round(usd / 1_000_000).toLocaleString("en-US")}M`;
const TIER_RANK: readonly ProtocolTier[] = ["core", "curated", "extended", "testnet"];

function tierAllowed(tier: ProtocolTier, network: NetworkKey, named: boolean): boolean {
  if (CHAINS[network].environment === "testnet") return true;
  if (tier === "testnet") return false;
  return tier === "core" || tier === "curated" || named;
}

/** Deposit capacity from a reading: false when paused, frozen (includes full) or the cap is used up; null when unread. */
export function capacityOf(reading: YieldReading | null | undefined): boolean | null {
  if (!reading || reading.status !== "known") return null;
  return !(reading.paused || reading.frozen || reading.capRemaining === "0");
}

/** True when the current rate is more than YIELD_RANK.maxDeviation away from the smoothed rate (either way). */
export function apyDeviates(apy: number | null, smoothed: number): boolean {
  if (apy === null) return false;
  if (smoothed <= 0) return apy > 0;
  return apy > smoothed * YIELD_RANK.maxDeviation || apy < smoothed / YIELD_RANK.maxDeviation;
}

/**
 * The smoothed rate of one venue when it passes the comparison checks on its
 * own (capacity, smoothed rate and TVL read, TVL floor of its tier, current
 * rate within 2x), else null: the rate the goal solver's route search counts
 * (never the instantaneous rate).
 */
export function comparableApy(reading: YieldReading | null | undefined, tier: ProtocolTier): number | null {
  if (!reading || reading.status !== "known" || capacityOf(reading) === false) return null;
  const { smoothedApy, tvlUsd } = reading;
  if (smoothedApy === null || tvlUsd === null || tvlUsd < TVL_FLOOR_USD[tier] || apyDeviates(reading.apy, smoothedApy)) return null;
  return smoothedApy;
}

/** Entries usable without a comparison (the only venue, a named protocol's default): compared, but not by rate. */
const UNRATED = new WeakSet<RankedYieldVenue>();

/** True when `entry` won its place on its 7-day rate (not as the only or the named default venue). */
export function rankedByRate(entry: RankedYieldVenue): boolean {
  return entry.compared && !UNRATED.has(entry);
}

interface Scored {
  readonly entry: RankedYieldVenue;
  readonly order: number;
  readonly score: number | null;
}

/* ------------------------------------------------------------ the ranking */

/**
 * Ranks `candidates` (registry order) with their readings, best first:
 * compared venues by score, then the others in tier and registry order.
 * Pure: reads only its arguments. `gasUsd` prices entering a venue (0 when
 * omitted: venues on one network differ little).
 */
export function rankYieldReadings(
  q: Omit<YieldRankQuery, "deadlineMs" | "symbol">,
  candidates: readonly YieldVenue[],
  readingOf: (venue: YieldVenue) => YieldReading | null | undefined,
  gasUsd: (venue: YieldVenue) => number = () => 0,
): RankedYieldVenue[] {
  const exclude = new Set(q.excludeVenueIds ?? []);
  const named = q.protocol !== undefined;
  const pool = candidates.filter((venue) => venue.network === q.network && !exclude.has(venue.id) && (!q.protocol || venue.protocol === q.protocol));
  const amountUsd = q.amountUsd !== undefined && Number.isFinite(q.amountUsd) && q.amountUsd > 0 ? q.amountUsd : null;
  const scored: Scored[] = pool.map((venue, order) => {
    const tier = protocolTier(venue.protocol as ProtocolId, venue.network);
    // A venue whose tier is not eligible is never read.
    const reading = tierAllowed(tier, venue.network, named) ? readingOf(venue) : null;
    const known = reading && reading.status === "known" ? reading : null;
    const apy = known?.apy ?? null;
    const smoothedApy = known?.smoothedApy ?? null;
    const tvlUsd = known?.tvlUsd ?? null;
    const adjustedApy = riskAdjustedApy(tier, smoothedApy);
    const capacityOk = capacityOf(reading);
    const row = (compared: boolean, why: string): RankedYieldVenue => ({ venue, apy, smoothedApy, adjustedApy, tvlUsd, tier, capacityOk, compared, why });
    const out = (why: string): Scored => ({ entry: row(false, why), order, score: null });
    if (!tierAllowed(tier, venue.network, named)) {
      return out(tier === "extended" ? "Extended-tier venue: used only when you name it." : "Testnet venue: not used with real funds.");
    }
    if (!known) return out("Its rate could not be read in time.");
    if (capacityOk === false) return out(known.paused ? "Paused right now." : "Not taking new deposits right now (full or frozen).");
    if (smoothedApy === null) return out("Its 7-day rate could not be read, so it was not compared.");
    if (tvlUsd === null) return out("Its size (TVL) could not be read, so it was not compared.");
    const floor = TVL_FLOOR_USD[tier];
    if (tvlUsd < floor) return out(`Holds ${millions(tvlUsd)}, under the ${millions(floor)} floor for ${tier} venues.`);
    if (apyDeviates(apy, smoothedApy)) {
      return out(`Its current rate (${percent(apy as number)}) is more than ${YIELD_RANK.maxDeviation}x away from its 7-day rate (${percent(smoothedApy)}).`);
    }
    const base = q.prefer === "yield" ? smoothedApy : (adjustedApy as number);
    const score = amountUsd !== null ? (base * amountUsd * YIELD_RANK.days) / 365 - gasUsd(venue) : base;
    const why = q.prefer === "yield"
      ? `7-day rate ${percent(smoothedApy)} (${tier}).`
      : `7-day rate ${percent(smoothedApy)}${tier === "core" ? "" : `, ${percent(adjustedApy as number)} after the ${tier}-tier risk allowance`}.`;
    return { entry: row(true, why), order, score };
  });

  const compared = scored.filter((entry) => entry.score !== null);
  // The only usable venue, or a named protocol's default venue, stays usable without a comparison (not by rate).
  if (compared.length === 0) {
    const usable = scored.filter((entry) =>
      entry.entry.capacityOk !== false && tierAllowed(entry.entry.tier, entry.entry.venue.network, named) &&
      !(entry.entry.smoothedApy !== null && apyDeviates(entry.entry.apy, entry.entry.smoothedApy)));
    const eligible = scored.filter((entry) => tierAllowed(entry.entry.tier, entry.entry.venue.network, named));
    const only = eligible.length === 1 && usable.length === 1 ? usable[0] : undefined;
    const fallback = only ?? (named ? usable[0] : undefined);
    if (fallback) {
      const why = only
        ? `The only venue for this; ${fallback.entry.why.charAt(0).toLowerCase()}${fallback.entry.why.slice(1)}`
        : `The default venue of the protocol you named; vault rates could not be compared.`;
      const index = scored.indexOf(fallback);
      const entry: RankedYieldVenue = { ...fallback.entry, compared: true, why };
      UNRATED.add(entry);
      scored[index] = { ...fallback, entry, score: Number.NEGATIVE_INFINITY };
    }
  }
  const tierRank = (tier: ProtocolTier) => TIER_RANK.indexOf(tier);
  return scored
    .sort((a, b) => {
      if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
      if (a.score !== null && b.score !== null) {
        if (q.prefer === "safest" && a.entry.tier !== b.entry.tier) return tierRank(a.entry.tier) - tierRank(b.entry.tier);
        if (Math.abs(a.score - b.score) > 1e-12) return b.score - a.score;
      }
      return tierRank(a.entry.tier) - tierRank(b.entry.tier) || a.order - b.order;
    })
    .map((entry) => entry.entry);
}

/**
 * Every venue of `symbol` on `network` ranked for a deposit,
 * best first; the first entry with `compared: true` is the pick. Reads each
 * candidate's rate, smoothed rate, TVL and capacity in parallel within
 * `deadlineMs` (default 1.5 s); a late read is listed as not compared.
 */
export async function rankYieldVenues(q: YieldRankQuery): Promise<readonly RankedYieldVenue[]> {
  const candidates = venueCandidates(q.network, "deposit", q.symbol).slice(0, SNAPSHOT_LIMITS.apyVenues);
  const now = Date.now();
  const deadlineMs = q.deadlineMs ?? YIELD_RANK.deadlineMs;
  const readings = new Map<string, SnapshotApy>();
  await Promise.all(candidates
    .filter((venue) => !(q.excludeVenueIds ?? []).includes(venue.id) && (!q.protocol || venue.protocol === q.protocol))
    .map(async (venue) => readings.set(venue.id, await readVenueReading(venue, now, deadlineMs))));
  return rankYieldReadings(q, candidates, (venue) => readings.get(venue.id));
}

/* -------------------------------------------------------------- migration */

export type MigrationVerdict =
  | { readonly move: true; readonly target: RankedYieldVenue; readonly gainUsd: number | null; readonly why: string }
  | { readonly move: false; readonly reason: "not-better" | "not-compared"; readonly target?: RankedYieldVenue; readonly why: string };

/**
 * Whether moving a position from `source` to the best other venue is worth
 * it: the target must be compared, and its risk-adjusted rate
 * gain over 30 days on `amountUsd` must exceed `switchingGasUsd`. An unknown
 * source rate cannot be beaten on record (not-compared); an unknown amount
 * needs a strictly positive gain.
 */
export function migrationVerdict(input: {
  readonly ranked: readonly RankedYieldVenue[];
  readonly source: YieldVenue;
  readonly sourceReading: YieldReading | null | undefined;
  readonly amountUsd: number | null;
  readonly switchingGasUsd: number;
}): MigrationVerdict {
  const target = input.ranked.find((entry) => rankedByRate(entry) && entry.venue.id !== input.source.id && entry.adjustedApy !== null);
  const label = (venue: YieldVenue) => venue.name;
  if (!target) return { move: false, reason: "not-compared", why: "No other venue's 7-day rate could be compared." };
  const reading = input.sourceReading && input.sourceReading.status === "known" ? input.sourceReading : null;
  const sourceTier = protocolTier(input.source.protocol as ProtocolId, input.source.network);
  const sourceAdjusted = reading?.smoothedApy !== null && reading?.smoothedApy !== undefined ? riskAdjustedApy(sourceTier, reading.smoothedApy) : null;
  if (sourceAdjusted === null) {
    return { move: false, reason: "not-compared", target, why: `The 7-day rate of ${label(input.source)} could not be read, so Kletia cannot tell whether ${label(target.venue)} pays more.` };
  }
  const gain = (target.adjustedApy as number) - sourceAdjusted;
  const amount = input.amountUsd !== null && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null;
  const gainUsd = amount === null ? null : (gain * amount * YIELD_RANK.days) / 365;
  const worth = gain > 0 && (gainUsd === null || gainUsd > input.switchingGasUsd);
  if (!worth) {
    return {
      move: false, reason: "not-better", target,
      why: gain <= 0
        ? `${label(input.source)} already pays the best rate Kletia can compare (${percent(sourceAdjusted)} vs ${percent(target.adjustedApy as number)} at ${label(target.venue)}, after risk).`
        : `${label(target.venue)} pays ${percent(gain)} more after risk, about $${(gainUsd as number).toFixed(2)} over 30 days, which does not cover the gas of switching (about $${input.switchingGasUsd.toFixed(2)}).`,
    };
  }
  return { move: true, target, gainUsd, why: `${label(target.venue)} pays ${percent(gain)} more than ${label(input.source)} after risk.` };
}

/* ----------------------------------------------------------------- stakes */

/** Staking providers of `input` on `network`'s lane (clarify vocabulary), Kletia's default first. */
export function stakeProvidersOf(input: "SOL" | "ETH", network?: NetworkKey): StakeProvider[] {
  const all = [...STAKE_PROVIDERS, ...REGISTRY_STAKE_PROVIDERS].filter((provider) =>
    provider.input === input && (!network || provider.network === network) && CHAINS[provider.network].environment !== "testnet");
  const fallback = defaultProvider(input);
  return [...all.filter((provider) => provider.id === fallback.id), ...all.filter((provider) => provider.id !== fallback.id)];
}

/**
 * Ranks `providers` with their smoothed-rate readings, best first: providers whose
 * smoothed rate and TVL were read (TVL at the tier's floor or above) by the
 * risk-adjusted rate ("yield": raw rate; "safest": tier first), then the rest
 * in the given order. Pure.
 */
export function rankStakeReadings(
  providers: readonly StakeProvider[],
  readings: readonly StakeMetricsReading[],
  prefer?: YieldPreference,
): RankedStakeProvider[] {
  return stakeRows(providers, readings, prefer).map((row) => row.entry);
}

/** The best provider whose rate was compared, or undefined (then Kletia's default provider stays). */
export function bestRatedStake(
  providers: readonly StakeProvider[],
  readings: readonly StakeMetricsReading[],
  prefer?: YieldPreference,
): RankedStakeProvider | undefined {
  const first = stakeRows(providers, readings, prefer)[0];
  return first && first.score !== null ? first.entry : undefined;
}

function stakeRows(providers: readonly StakeProvider[], readings: readonly StakeMetricsReading[], prefer?: YieldPreference) {
  const rows = providers.map((provider, order) => {
    const reading = readings.find((entry) => entry.lst.toUpperCase() === provider.symbol.toUpperCase() && entry.network === provider.network);
    const tier = protocolTier(provider.id as ProtocolId, provider.network);
    const smoothed = reading?.smoothedApy ?? null;
    const adjustedApy = riskAdjustedApy(tier, smoothed);
    const base = { provider: provider.id, lst: provider.symbol, apy: smoothed, adjustedApy, tier };
    let rated = false;
    let why: string;
    if (smoothed === null) why = "Its 7-day rate could not be read; Kletia's default order applies.";
    else if (reading?.tvlUsd === null || reading?.tvlUsd === undefined) why = "Its size (TVL) could not be read, so it was not compared.";
    else if (reading.tvlUsd < TVL_FLOOR_USD[tier]) why = `Holds ${millions(reading.tvlUsd)}, under the ${millions(TVL_FLOOR_USD[tier])} floor for ${tier} providers.`;
    else if (tier === "extended" || tier === "testnet") why = "Extended-tier provider: used only when you name it.";
    else {
      rated = true;
      why = `7-day rate ${percent(smoothed)} net of its fee${tier === "core" || prefer === "yield" ? "" : `, ${percent(adjustedApy as number)} after the ${tier}-tier risk allowance`}.`;
    }
    const score = rated ? (prefer === "yield" ? smoothed as number : adjustedApy as number) : null;
    return { entry: { ...base, why } as RankedStakeProvider, order, score };
  });
  const tierRank = (tier: ProtocolTier) => TIER_RANK.indexOf(tier);
  return rows
    .sort((a, b) => {
      if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
      if (a.score !== null && b.score !== null) {
        if (prefer === "safest" && a.entry.tier !== b.entry.tier) return tierRank(a.entry.tier) - tierRank(b.entry.tier);
        if (Math.abs(a.score - b.score) > 1e-12) return b.score - a.score;
      }
      return a.order - b.order;
    });
}

/**
 * Staking providers of `input` ranked for an unnamed stake,
 * best first. `amountUsd` does not change the order (every provider takes
 * the same steps). Reads within `deadlineMs` (default 1.5 s); a provider
 * whose rate was not read keeps Kletia's default order.
 */
export async function rankStakeProviders(q: {
  network: NetworkKey;
  input: "SOL" | "ETH";
  amountUsd?: number;
  prefer?: YieldPreference;
  deadlineMs?: number;
}): Promise<readonly RankedStakeProvider[]> {
  const providers = stakeProvidersOf(q.input, q.network);
  if (providers.length === 0) return [];
  const readings = await readStakeMetrics(q.input, Date.now(), q.deadlineMs ?? YIELD_RANK.deadlineMs);
  return rankStakeReadings(providers, readings, q.prefer);
}
