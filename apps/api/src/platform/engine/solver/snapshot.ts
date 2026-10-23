/**
 * The solver's snapshot (intent engine v2 §4.1): what the person holds,
 * which positions they have, what their assets are worth and what the
 * candidate venues pay, read once per turn for a list of Goals.
 *
 * - Holdings. A goal that names a network and an asset is read through
 *   `holdings.readFacts` (its per-turn budget: 8 balance reads). A goal
 *   with no source network, and consolidate / rebalance goals, sweep the
 *   person's accounts on every network of the lane(s) concerned through
 *   the portfolio reader (`readAccountPortfolios`: its 15 s cache), at most
 *   4 accounts at a time, under one deadline (`GOAL_LIMITS.sweepDeadlineMs`).
 * - Positions: only for exit goals and goals that spend from a position,
 *   on at most 2 networks (`readVenuePositions`).
 * - Prices: the preview pricer (`quoteAsset`: stablecoins at par, natives,
 *   Solana mints, oracle-priced listed assets). Each price keeps its source
 *   and reading time; one read more than `GOAL_LIMITS.priceMaxAgeMs` ago is
 *   read again, and a market reading (Jupiter, par) that is still older
 *   than that is reported `stale` (consumers use `usablePrice`, which never
 *   returns it). Oracle readings (`chainlink`) carry the feed's update time,
 *   which the Rule Book's pricer already holds to the feed heartbeat, so
 *   they are judged by when they were fetched. A missing price is absent,
 *   never guessed.
 * - APY: for earn goals, every candidate venue of the asset on the chosen
 *   network (WP8: no cut before the ranking; at most SNAPSHOT_LIMITS.apyVenues
 *   as a safety bound), read in parallel, each bounded by 1.5 s and cached
 *   60 s. Each reading carries the current rate and, seam S8 (D11), the
 *   venue's smoothed 7-day rate and its TVL, which `solver/yieldRank.ts`
 *   ranks on. A missing APY is null.
 *
 * Unknown is never zero: a failed, skipped, late or over-budget read is
 * `unknown` with a reason; preview (demo) accounts are never read. Every
 * read is read-only; nothing is signed or sent. Nothing here is stored in
 * the thread.
 */
import {
  CHAINS,
  GOAL_LIMITS,
  NETWORK_KEYS,
  YIELD_VENUES,
  assetsForNetwork,
  findAssetBySymbol,
  fromBaseUnits,
  isPreviewAccount,
  parseAccountId,
  type AccountId,
  type AssetId,
  type AssetSel,
  type Goal,
  type JourneyValueSource,
  type JourneyVenueFacts,
  type NetworkKey,
  type NetworkLane,
  type ParsedAccountId,
  type ProtocolId,
  type YieldVenue,
} from "@kletia/core";
import { accountForNetwork } from "../accounts.js";
import { MAX_BALANCE_READS, readFacts, type FactNeed, type WalletFacts } from "../holdings.js";
import { defaultVenueReader } from "../journey/facts.js";
import { positionVenues, readVenuePositions, type VenuePositionOptions, type VenuePositionsResult } from "../journey/positions.js";
import { PORTFOLIO_BATCH_LIMITS, readAccountPortfolios, type AccountPortfolios, type PortfolioOptions } from "../portfolio.js";
import { quoteAsset, type PriceQuoteView } from "../preview/pricer.js";
import { isEvmLendingVenue, readLendingMetrics } from "../adapters/lending/metrics.js";
import { listStakingMetrics } from "../adapters/staking/index.js";
import { capabilityGraph, nodeMatchesAsset, type GraphNode } from "./graph.js";
import { RISK_ORDER } from "./risk.js";

/* ------------------------------------------------------------------ types */

export type SnapshotStatus = "known" | "unknown";

/** Why a value is unknown. */
export type UnknownReason =
  /** The read failed (RPC trouble, a reader error). */
  | "read-failed"
  /** The read did not finish before the snapshot's deadline. */
  | "deadline"
  /** Preview (demo) accounts are never read. */
  | "preview"
  /** No own account can be used on that network (none of that VM, or several). */
  | "no-account"
  /** The turn's read budget was spent. */
  | "budget"
  /** The sweep read the network but did not list the asset (a zero balance and a failed token read look the same). */
  | "not-reported"
  /** The snapshot was asked not to read (`reads: "none"`) or the position network was beyond the 2-network cap. */
  | "not-read";

export interface SnapshotHolding {
  readonly network: NetworkKey;
  /** CAIP-19 id; null when the asset could not be identified. */
  readonly asset: AssetId | null;
  readonly symbol: string;
  readonly decimals: number | null;
  readonly status: SnapshotStatus;
  /** Base units (known only). */
  readonly units?: string;
  /** Decimal amount (known only). */
  readonly formatted?: string;
  /** Advisory USD value; null when unpriced or unknown (never 0 for unknown). */
  readonly usd: number | null;
  /** Which read produced it: an exact balance read, or the portfolio sweep. */
  readonly source: "facts" | "sweep";
  readonly reason?: UnknownReason;
}

export interface SnapshotPosition {
  /** YIELD_VENUES id. */
  readonly venue: string;
  readonly network: NetworkKey;
  readonly protocol: ProtocolId;
  /** The venue's underlying symbol. */
  readonly symbol: string;
  readonly status: SnapshotStatus;
  /** Underlying base units ("0": read, no position). */
  readonly units?: string;
  readonly formatted?: string;
  readonly decimals?: number;
  readonly usd: number | null;
  readonly apy: number | null;
  /** Underlying that can leave now, decimal; null when unknown. */
  readonly withdrawableNow?: string | null;
  readonly reason?: UnknownReason;
}

export interface SnapshotPrice {
  readonly asset: AssetId;
  readonly usd: number;
  readonly source: JourneyValueSource;
  /** Unix ms of the source's reading (an oracle's update time). */
  readonly at: number;
  /** Unix ms the snapshot fetched it. */
  readonly readAt: number;
  /** A market reading older than `GOAL_LIMITS.priceMaxAgeMs` even after a fresh read: never used to convert an amount. */
  readonly stale: boolean;
}

export interface SnapshotApy {
  /** YIELD_VENUES id. */
  readonly venue: string;
  readonly network: NetworkKey;
  readonly protocol: ProtocolId;
  readonly status: SnapshotStatus;
  /** Supply APY as a fraction (0.041 = 4.1%); null when the venue does not report one. */
  readonly apy: number | null;
  /** The venue's realised rate over about 7 days (seam S8, D11); null when unreadable (never ranked as zero). */
  readonly smoothedApy: number | null;
  /** Window of `smoothedApy` in seconds; null when none was read. */
  readonly apyWindowSeconds: number | null;
  /** USD value supplied to the venue (TVL); null when unreadable. */
  readonly tvlUsd: number | null;
  /** Underlying base units that still fit under the venue's supply cap; null = no cap or unknown. */
  readonly capRemaining: string | null;
  readonly paused: boolean;
  readonly frozen: boolean;
  /** ISO time of the reading. */
  readonly at: string | null;
  readonly reason?: UnknownReason;
}

/** The smoothed rate and size of a venue (seam S8), read next to its current rate. */
export interface VenueMetricsReading {
  readonly smoothedApy: number | null;
  readonly apyWindowSeconds: number | null;
  readonly tvlUsd: number | null;
}

/** The smoothed rate and size of a liquid-staking token (seam S8). */
export interface StakeMetricsReading {
  /** Staking protocol id (registry). */
  readonly provider: string;
  readonly network: NetworkKey;
  /** The liquid-staking token's symbol. */
  readonly lst: string;
  readonly smoothedApy: number | null;
  readonly tvlUsd: number | null;
}

export interface SweepReport {
  /** `complete`: every network read; `partial`: some failed or were late; `skipped`: no sweep was needed or allowed. */
  readonly status: "complete" | "partial" | "skipped";
  /** Networks the sweep read successfully. */
  readonly networks: readonly NetworkKey[];
  readonly failures: readonly { readonly network: NetworkKey; readonly reason: UnknownReason }[];
  /** Highest number of account reads in flight at once. */
  readonly peakConcurrency: number;
  readonly ms: number;
}

export interface Snapshot {
  readonly accounts: readonly AccountId[];
  /** ISO time the snapshot was taken. */
  readonly observedAt: string;
  readonly holdings: readonly SnapshotHolding[];
  readonly positions: readonly SnapshotPosition[];
  /** Networks whose positions were read (at most 2). */
  readonly positionNetworks: readonly NetworkKey[];
  readonly prices: ReadonlyMap<AssetId, SnapshotPrice>;
  /** Candidate venues of earn goals, by YIELD_VENUES id. */
  readonly apy: ReadonlyMap<string, SnapshotApy>;
  /** S8 readings of the liquid-staking tokens, per input asset, for earn goals that may stake it (absent: not read). */
  readonly stakes?: ReadonlyMap<"SOL" | "ETH", readonly StakeMetricsReading[]>;
  readonly sweep: SweepReport;
}

export interface SnapshotBudget {
  /** Exact balance reads (capped at holdings.MAX_BALANCE_READS). */
  readonly balances?: number;
  /** Overall deadline in ms (default and cap: GOAL_LIMITS.sweepDeadlineMs). */
  readonly deadlineMs?: number;
  /** `none`: read nothing (every value unknown). */
  readonly reads?: "live" | "none";
  /** Unix ms used as "now" for price ages (tests). */
  readonly now?: number;
}

/** The reads, replaceable in tests (`configureSnapshotReaders`). Every reader is read-only. */
export interface SnapshotReaders {
  facts(accounts: readonly AccountId[], needs: readonly FactNeed[], budget: { balances: number; names: number; deadlineMs: number }): Promise<WalletFacts>;
  /** One account's portfolio (the sweep calls it per account, at most 4 at a time). */
  portfolio(account: AccountId, options: PortfolioOptions): Promise<AccountPortfolios>;
  positions(account: AccountId, network: NetworkKey, options: VenuePositionOptions): Promise<VenuePositionsResult>;
  venue(venue: YieldVenue): Promise<JourneyVenueFacts>;
  /** A venue's smoothed rate and TVL (seam S8). */
  metrics(venue: YieldVenue): Promise<VenueMetricsReading>;
  /** Smoothed rates and TVL of the liquid-staking tokens of an input asset (seam S8); [] when none are read. */
  stakes(input: "SOL" | "ETH"): Promise<readonly StakeMetricsReading[]>;
  price(asset: AssetId): Promise<PriceQuoteView | null>;
}

/** Limits of one snapshot. */
export const SNAPSHOT_LIMITS = Object.freeze({
  sweepConcurrency: PORTFOLIO_BATCH_LIMITS.concurrency,
  sweepAccounts: PORTFOLIO_BATCH_LIMITS.maxAccounts,
  positionNetworks: 2,
  /** Safety bound on the venues read for one asset (Base USDC lists about a dozen). */
  apyVenues: 24,
  apyReadMs: 1_500,
  apyTtlMs: 60_000,
  priceReads: 24,
});

const DEFAULT_READERS: SnapshotReaders = {
  facts: (accounts, needs, budget) => readFacts(accounts, needs, budget),
  portfolio: (account, options) => readAccountPortfolios([account], options),
  positions: (account, network, options) => readVenuePositions(account, network, options),
  venue: (venue) => defaultVenueReader(venue),
  metrics: (venue) => defaultMetricsReader(venue),
  stakes: (input) => defaultStakesReader(input),
  price: (asset) => quoteAsset(asset),
};

const NO_METRICS: VenueMetricsReading = Object.freeze({ smoothedApy: null, apyWindowSeconds: null, tvlUsd: null });

/** EVM lending venues expose S8 metrics (cached a minute by the adapters); other venues read none (never compared on rate). */
async function defaultMetricsReader(venue: YieldVenue): Promise<VenueMetricsReading> {
  if (!isEvmLendingVenue(venue)) return NO_METRICS;
  const metrics = await readLendingMetrics(venue.id);
  return { smoothedApy: metrics.smoothedApy, apyWindowSeconds: metrics.apyWindowSeconds ?? null, tvlUsd: metrics.tvlUsd };
}

/** Ethereum liquid-staking tokens expose S8 metrics; Solana stake pools read none yet (the default provider stays). */
async function defaultStakesReader(input: "SOL" | "ETH"): Promise<readonly StakeMetricsReading[]> {
  if (input !== "ETH") return [];
  // One listing in flight at a time, kept a minute: a read that outlives a turn's bound serves the next turn.
  const now = Date.now();
  if (!stakeListing || now - stakeListing.at > SNAPSHOT_LIMITS.apyTtlMs) {
    const value = listStakingMetrics().then((listing) =>
      listing.map((entry) => ({ provider: entry.provider, network: entry.network, lst: entry.lst, smoothedApy: entry.smoothedApy, tvlUsd: entry.tvlUsd })));
    stakeListing = { value, at: now };
    value.catch(() => {
      if (stakeListing?.value === value) stakeListing = null;
    });
  }
  return stakeListing.value;
}
let stakeListing: { readonly value: Promise<readonly StakeMetricsReading[]>; readonly at: number } | null = null;

let readers: SnapshotReaders = DEFAULT_READERS;
const priceMemo = new Map<AssetId, SnapshotPrice>();
const apyMemo = new Map<string, { readonly value: SnapshotApy; readonly readAt: number }>();
const stakeMemo = new Map<string, { readonly value: readonly StakeMetricsReading[]; readonly readAt: number }>();

/**
 * Replaces some or all reads (tests); null restores the defaults. Clears the
 * snapshot's caches. Replacing the venue reads without the S8 readers
 * (`metrics`, `stakes`) leaves those unread (no smoothed rate, no TVL), so a
 * test world never mixes in live reads.
 */
export function configureSnapshotReaders(next: Partial<SnapshotReaders> | null): void {
  if (next === null) readers = DEFAULT_READERS;
  else {
    const offline: Partial<SnapshotReaders> = next.venue
      ? { metrics: async () => NO_METRICS, stakes: async () => [] }
      : {};
    readers = { ...DEFAULT_READERS, ...offline, ...next };
  }
  resetSnapshotCaches();
}

/** Replaces some reads on top of the current ones (tests: S8 metrics beside an installed fixture wallet). Clears the caches. */
export function extendSnapshotReaders(next: Partial<SnapshotReaders>): void {
  readers = { ...readers, ...next };
  resetSnapshotCaches();
}

/** Forgets memoised prices, APYs and stake metrics (tests). */
export function resetSnapshotCaches(): void {
  priceMemo.clear();
  apyMemo.clear();
  stakeMemo.clear();
}

/* ---------------------------------------------------------------- helpers */

const upper = (value: string) => value.trim().toUpperCase();
const holdingKey = (network: NetworkKey, symbol: string) => `${network}|${upper(symbol)}`;

class DeadlineError extends Error {}

function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  read.catch(() => undefined);
  if (ms <= 0) return Promise.reject(new DeadlineError("deadline"));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError("deadline")), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const failureReason = (error: unknown): UnknownReason => (error instanceof DeadlineError ? "deadline" : "read-failed");

/** Symbols a selection names on `network` (a class expands to the listed assets of that class). */
export function selectionSymbols(network: NetworkKey, selection: AssetSel): string[] {
  if ("symbol" in selection) {
    const listed = findAssetBySymbol(network, selection.symbol);
    return [listed?.symbol ?? selection.symbol.trim()];
  }
  const graph = capabilityGraph();
  return assetsForNetwork(network)
    .map((asset) => graph.nodes.get(`${network}|${asset.id}|wallet`))
    .filter((node): node is GraphNode => node !== undefined && nodeMatchesAsset(node, selection))
    .map((node) => node.symbol);
}

function needsSweep(goal: Goal): boolean {
  if (goal.spend.amount?.t === "previous") return false;
  return goal.kind === "consolidate" || goal.kind === "rebalance" || goal.spend.from?.network === undefined;
}

function needsPositions(goal: Goal): boolean {
  return goal.kind === "exit" || goal.spend.from?.custody.kind === "position";
}

function isEarn(goal: Goal): boolean {
  return goal.kind === "earn" || goal.want.at?.custody.kind === "venue";
}

/** Lanes the goals concern: those of the networks they name, else production. */
function lanesOf(goals: readonly Goal[]): Set<NetworkLane> {
  const lanes = new Set<NetworkLane>();
  for (const goal of goals) {
    for (const network of [goal.spend.from?.network, goal.want.at?.network]) if (network) lanes.add(CHAINS[network].lane);
  }
  if (lanes.size === 0) lanes.add("production");
  return lanes;
}

/** The own account to read on `network`, or why there is none. */
function ownAccount(parsed: readonly ParsedAccountId[], network: NetworkKey): { account: AccountId } | { reason: UnknownReason } | null {
  const namespace = CHAINS[network].namespace;
  if (!parsed.some((account) => account.chain.namespace === namespace)) return null;
  try {
    const account = accountForNetwork(parsed, network);
    return isPreviewAccount(account.id) ? { reason: "preview" } : { account: account.id };
  } catch {
    return { reason: "no-account" };
  }
}

/* ------------------------------------------------------------------ reads */

interface Collected {
  readonly holdings: Map<string, SnapshotHolding>;
}

/**
 * Records a holding: known beats unknown, and an exact read beats the
 * sweep (the exact read and the sweep run in parallel, in either order).
 */
function put(collected: Collected, entry: SnapshotHolding): void {
  const key = holdingKey(entry.network, entry.symbol);
  const existing = collected.holdings.get(key);
  if (!existing) {
    collected.holdings.set(key, entry);
    return;
  }
  const known = entry.status === "known";
  const existingKnown = existing.status === "known";
  if ((known && !existingKnown) || (known === existingKnown && entry.source === "facts" && existing.source === "sweep")) {
    collected.holdings.set(key, entry);
  }
}

async function readExact(accounts: readonly AccountId[], goals: readonly Goal[], budget: number, deadlineMs: number, collected: Collected): Promise<void> {
  const pairs: { network: NetworkKey; symbol: string }[] = [];
  const add = (network: NetworkKey | undefined, selection: AssetSel | undefined) => {
    if (!network || !selection) return;
    for (const symbol of selectionSymbols(network, selection)) pairs.push({ network, symbol });
  };
  // Spent assets first (they decide funds questions), then wanted ones, then the gas asset of each source network.
  for (const goal of goals) add(goal.spend.from?.network, goal.spend.asset);
  for (const goal of goals) add(goal.want.at?.network, goal.want.asset);
  for (const goal of goals) add(goal.spend.from?.network, { class: "gas" });
  const seen = new Set<string>();
  const unique = pairs.filter((pair) => {
    const key = holdingKey(pair.network, pair.symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return;
  const readable = unique.slice(0, budget);
  for (const pair of unique.slice(budget)) {
    put(collected, {
      network: pair.network, asset: findAssetBySymbol(pair.network, pair.symbol)?.id ?? null, symbol: pair.symbol, decimals: null,
      status: "unknown", usd: null, source: "facts", reason: "budget",
    });
  }
  if (readable.length === 0) return;
  const needs: FactNeed[] = readable.map((pair) => ({ kind: "balance", network: pair.network, asset: pair.symbol }));
  let facts: WalletFacts | null = null;
  let reason: UnknownReason = "read-failed";
  try {
    facts = await withDeadline(readers.facts(accounts, needs, { balances: readable.length, names: 0, deadlineMs }), deadlineMs);
  } catch (error) {
    reason = failureReason(error);
  }
  readable.forEach((pair, index) => {
    const fact = facts?.balances[index];
    const listed = findAssetBySymbol(pair.network, pair.symbol);
    const known = fact?.status === "known" && fact.amount !== undefined && fact.decimals !== null;
    const note = fact?.reason?.toLowerCase() ?? "";
    const factReason: UnknownReason = !fact
      ? reason
      : note.includes("budget") ? "budget" : note.includes("preview") ? "preview" : fact.status === "skipped" ? "no-account" : "read-failed";
    put(collected, known
      ? {
          network: pair.network, asset: fact.asset ?? listed?.id ?? null, symbol: listed?.symbol ?? pair.symbol, decimals: fact.decimals,
          status: "known", units: fact.amount as string, formatted: fromBaseUnits(BigInt(fact.amount as string), fact.decimals as number),
          usd: null, source: "facts",
        }
      : {
          network: pair.network, asset: fact?.asset ?? listed?.id ?? null, symbol: listed?.symbol ?? pair.symbol, decimals: fact?.decimals ?? listed?.decimals ?? null,
          status: "unknown", usd: null, source: "facts", reason: factReason,
        });
  });
}

async function sweepAccounts(parsed: readonly ParsedAccountId[], lanes: ReadonlySet<NetworkLane>, deadlineAt: number, collected: Collected): Promise<SweepReport> {
  const started = Date.now();
  const targets: { network: NetworkKey; account: AccountId }[] = [];
  const failures: { network: NetworkKey; reason: UnknownReason }[] = [];
  for (const network of NETWORK_KEYS) {
    if (!lanes.has(CHAINS[network].lane)) continue;
    const own = ownAccount(parsed, network);
    if (own === null) continue;
    if ("reason" in own) failures.push({ network, reason: own.reason });
    else if (targets.length < SNAPSHOT_LIMITS.sweepAccounts) targets.push({ network, account: own.account });
  }
  const swept: NetworkKey[] = [];
  let inFlight = 0;
  let peak = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next] as { network: NetworkKey; account: AccountId };
      next += 1;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        failures.push({ network: target.network, reason: "deadline" });
        continue;
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const result = await withDeadline(readers.portfolio(target.account, {}), remaining);
        const portfolio = result.portfolios[0];
        if (!portfolio) throw new Error(result.failures[0]?.message ?? "no portfolio");
        swept.push(target.network);
        const reported = new Set<string>();
        for (const holding of portfolio.holdings) {
          reported.add(upper(holding.symbol));
          put(collected, {
            network: target.network, asset: holding.asset, symbol: holding.symbol, decimals: holding.decimals, status: "known",
            units: holding.amount, formatted: holding.formatted, usd: holding.usd, source: "sweep",
          });
        }
        for (const asset of assetsForNetwork(target.network)) {
          if (reported.has(upper(asset.symbol))) continue;
          put(collected, {
            network: target.network, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, status: "unknown", usd: null, source: "sweep", reason: "not-reported",
          });
        }
      } catch (error) {
        failures.push({ network: target.network, reason: failureReason(error) });
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_LIMITS.sweepConcurrency, targets.length) }, worker));
  // Networks that failed: their listed assets are unknown (never zero).
  for (const failure of failures) {
    for (const asset of assetsForNetwork(failure.network)) {
      put(collected, {
        network: failure.network, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, status: "unknown", usd: null, source: "sweep", reason: failure.reason,
      });
    }
  }
  return {
    status: failures.length === 0 ? "complete" : "partial",
    networks: NETWORK_KEYS.filter((network) => swept.includes(network)),
    failures,
    peakConcurrency: peak,
    ms: Date.now() - started,
  };
}

/** Networks whose positions to read (at most 2): the named source network, else registry order within the lanes. */
function positionTargets(goals: readonly Goal[], lanes: ReadonlySet<NetworkLane>): { networks: NetworkKey[]; protocols: Set<ProtocolId> | null; symbols: Set<string> | null } {
  const named: NetworkKey[] = [];
  const protocols = new Set<ProtocolId>();
  const symbols = new Set<string>();
  let anyProtocol = false;
  let anySymbol = false;
  for (const goal of goals.filter(needsPositions)) {
    if (goal.spend.from?.network) named.push(goal.spend.from.network);
    const custody = goal.spend.from?.custody;
    const protocol = custody && custody.kind !== "wallet" ? custody.protocol : undefined;
    if (protocol) protocols.add(protocol);
    else anyProtocol = true;
    if (goal.spend.asset && "symbol" in goal.spend.asset) symbols.add(upper(goal.spend.asset.symbol));
    else anySymbol = true;
  }
  const protocolFilter = anyProtocol || protocols.size === 0 ? null : protocols;
  const symbolFilter = anySymbol || symbols.size === 0 ? null : symbols;
  const candidates = named.length > 0
    ? [...new Set(named)]
    : NETWORK_KEYS.filter((network) => lanes.has(CHAINS[network].lane) && venuesFor(network, protocolFilter, symbolFilter).length > 0);
  return { networks: candidates, protocols: protocolFilter, symbols: symbolFilter };
}

/** Venues of `network` with a readable position (token receipts and Kamino reserves), narrowed by protocol and symbol. */
function venuesFor(network: NetworkKey, protocols: Set<ProtocolId> | null, symbols: Set<string> | null): YieldVenue[] {
  const kamino = YIELD_VENUES.filter((venue) => venue.network === network && venue.kind === "kamino-reserve");
  return [...positionVenues(network), ...kamino].filter((venue) =>
    (!protocols || protocols.has(venue.protocol)) && (!symbols || symbols.has(upper(venue.asset))));
}

async function readPositions(
  parsed: readonly ParsedAccountId[],
  goals: readonly Goal[],
  lanes: ReadonlySet<NetworkLane>,
  deadlineAt: number,
): Promise<{ positions: SnapshotPosition[]; networks: NetworkKey[] }> {
  if (!goals.some(needsPositions)) return { positions: [], networks: [] };
  const { networks, protocols, symbols } = positionTargets(goals, lanes);
  const read = networks.slice(0, SNAPSHOT_LIMITS.positionNetworks);
  const positions: SnapshotPosition[] = [];
  const unknown = (venue: YieldVenue, reason: UnknownReason): SnapshotPosition => ({
    venue: venue.id, network: venue.network, protocol: venue.protocol, symbol: venue.asset, status: "unknown", usd: null, apy: null, reason,
  });
  // Networks past the cap stay unknown (the solver asks rather than assume no position).
  for (const network of networks.slice(SNAPSHOT_LIMITS.positionNetworks)) {
    for (const venue of venuesFor(network, protocols, symbols)) positions.push(unknown(venue, "not-read"));
  }
  const results = await Promise.all(read.map(async (network) => {
    const venues = venuesFor(network, protocols, symbols);
    const own = ownAccount(parsed, network);
    if (own === null || "reason" in own) {
      return venues.map((venue) => unknown(venue, own === null ? "no-account" : own.reason));
    }
    try {
      const remaining = deadlineAt - Date.now();
      const result = await withDeadline(readers.positions(own.account, network, { venues: venues.map((venue) => venue.id), deadlineMs: Math.max(1, remaining) }), remaining);
      const failed = new Set(result.unavailable.map((entry) => entry.venue));
      return venues.map((venue): SnapshotPosition => {
        if (failed.has(venue.id) || failed.has("*")) return unknown(venue, "read-failed");
        const held = result.positions.find((position) => position.venue === venue.id);
        if (!held) {
          return { venue: venue.id, network, protocol: venue.protocol, symbol: venue.asset, status: "known", units: "0", formatted: "0", usd: 0, apy: null };
        }
        return {
          venue: venue.id, network, protocol: venue.protocol, symbol: held.underlying.symbol, status: "known",
          units: held.underlying.amount, formatted: fromBaseUnits(BigInt(held.underlying.amount), held.underlying.decimals), decimals: held.underlying.decimals,
          usd: held.usd, apy: held.apy, withdrawableNow: held.withdrawableNow?.formatted ?? null,
        };
      });
    } catch (error) {
      return venues.map((venue) => unknown(venue, failureReason(error)));
    }
  }));
  for (const list of results) positions.push(...list);
  return { positions, networks: read };
}

async function readPrice(asset: AssetId, now: number, deadlineAt: number): Promise<SnapshotPrice | null> {
  const memo = priceMemo.get(asset);
  if (memo && !memo.stale && now - memo.readAt <= GOAL_LIMITS.priceMaxAgeMs) return memo;
  try {
    const quote = await withDeadline(readers.price(asset), deadlineAt - Date.now());
    if (!quote || !Number.isFinite(quote.usd) || quote.usd < 0 || quote.source === "unpriced") return null;
    const parsed = Date.parse(quote.at);
    const at = Number.isFinite(parsed) ? parsed : now;
    // Oracle readings are held to their feed heartbeat by the pricer; market readings to priceMaxAgeMs.
    const stale = quote.source !== "chainlink" && now - at > GOAL_LIMITS.priceMaxAgeMs;
    const price: SnapshotPrice = { asset, usd: quote.usd, source: quote.source, at, readAt: now, stale };
    priceMemo.set(asset, price);
    return price;
  } catch {
    return null;
  }
}

/**
 * Candidate venues of earn goals: every deposit target of the asset on the
 * chosen network (WP8: no cut before the ranking), safest tier first, then
 * registry order; at most SNAPSHOT_LIMITS.apyVenues in all.
 */
function apyCandidates(goals: readonly Goal[], holdings: ReadonlyMap<string, SnapshotHolding>): YieldVenue[] {
  const graph = capabilityGraph();
  const out: YieldVenue[] = [];
  for (const goal of goals.filter(isEarn)) {
    const selection = goal.spend.asset ?? goal.want.asset;
    if (!selection) continue;
    let network = goal.want.at?.network ?? goal.spend.from?.network;
    if (!network) {
      // The network holding the most of the asset (known USD values only).
      let best: { network: NetworkKey; usd: number } | null = null;
      for (const holding of holdings.values()) {
        if (holding.status !== "known" || holding.usd === null || holding.usd <= 0) continue;
        if (!selectionSymbols(holding.network, selection).some((symbol) => upper(symbol) === upper(holding.symbol))) continue;
        if (!best || holding.usd > best.usd) best = { network: holding.network, usd: holding.usd };
      }
      network = best?.network;
    }
    if (!network) continue;
    const custody = goal.want.at?.custody;
    const venues: { venue: YieldVenue; tier: number; order: number }[] = [];
    YIELD_VENUES.forEach((venue, order) => {
      if (venue.network !== network) return;
      if (custody?.kind === "venue" && custody.protocol && custody.protocol !== venue.protocol) return;
      const node = [...graph.nodes.values()].find((entry) => entry.custody.kind === "venue" && entry.custody.venueId === venue.id);
      if (!node || !nodeMatchesAsset(node, selection)) return;
      const deposit = graph.edgesTo(node.id).find((edge) => edge.kind === "deposit");
      if (!deposit) return;
      venues.push({ venue, tier: RISK_ORDER.indexOf(deposit.risk), order });
    });
    venues.sort((a, b) => a.tier - b.tier || a.order - b.order);
    for (const { venue } of venues) {
      if (out.length >= SNAPSHOT_LIMITS.apyVenues) return out;
      if (!out.includes(venue)) out.push(venue);
    }
  }
  return out;
}

async function readApy(venue: YieldVenue, now: number, deadlineAt: number): Promise<SnapshotApy> {
  const memo = apyMemo.get(venue.id);
  if (memo && now - memo.readAt <= SNAPSHOT_LIMITS.apyTtlMs) return memo.value;
  const base = { venue: venue.id, network: venue.network, protocol: venue.protocol };
  const budget = Math.min(SNAPSHOT_LIMITS.apyReadMs, deadlineAt - Date.now());
  // S8 metrics are read beside the venue's facts under the same bound; a late or failed metrics read is unknown, never zero.
  // A metrics read that ran out of time is not memoised: the adapters keep reading and cache it for the next turn.
  let metricsLate = false;
  const metricsRead = withDeadline(readers.metrics(venue), budget).catch((error: unknown) => {
    metricsLate = error instanceof DeadlineError;
    return NO_METRICS;
  });
  try {
    const [facts, metrics] = await Promise.all([withDeadline(readers.venue(venue), budget), metricsRead]);
    // A venue that cannot take a new deposit now (over 99% borrowed, cap full) reads as frozen: no rate wins it the pick.
    const full = (typeof facts.utilization === "number" && facts.utilization >= 0.99) || facts.capRemaining === "0";
    const apy = typeof facts.apy === "number" && Number.isFinite(facts.apy) && !full ? facts.apy : null;
    const value: SnapshotApy = {
      ...base, status: "known", apy, ...finiteMetrics(metrics), capRemaining: facts.capRemaining,
      paused: facts.paused, frozen: facts.frozen || full, at: facts.at,
    };
    if (!metricsLate) apyMemo.set(venue.id, { value, readAt: now });
    return value;
  } catch (error) {
    return { ...base, status: "unknown", apy: null, ...NO_METRICS, capRemaining: null, paused: false, frozen: false, at: null, reason: failureReason(error) };
  }
}

/** Metrics with every non-finite or negative number as unknown (a reader's garbage is never ranked). */
function finiteMetrics(metrics: VenueMetricsReading): VenueMetricsReading {
  const rate = (value: number | null) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 10 ? value : null);
  const positive = (value: number | null) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  return { smoothedApy: rate(metrics.smoothedApy), apyWindowSeconds: positive(metrics.apyWindowSeconds), tvlUsd: positive(metrics.tvlUsd) };
}

/* ----------------------------------------------------------------- entry */

/**
 * Reads what the solver needs for `goals` on behalf of `accounts`, within
 * `budget`. Never throws for a failed read: what could not be read is
 * `unknown` with a reason.
 */
export async function readSnapshot(accounts: readonly AccountId[], goals: readonly Goal[], budget: SnapshotBudget = {}): Promise<Snapshot> {
  const now = budget.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const deadlineMs = Math.max(1, Math.min(GOAL_LIMITS.sweepDeadlineMs, budget.deadlineMs ?? GOAL_LIMITS.sweepDeadlineMs));
  const deadlineAt = Date.now() + deadlineMs;
  const skipped: SweepReport = { status: "skipped", networks: [], failures: [], peakConcurrency: 0, ms: 0 };
  if (budget.reads === "none" || goals.length === 0) {
    return Object.freeze({ accounts, observedAt, holdings: [], positions: [], positionNetworks: [], prices: new Map(), apy: new Map(), sweep: skipped });
  }
  const parsed = accounts.map((account) => parseAccountId(account)).filter((account): account is ParsedAccountId => account !== null);
  const lanes = lanesOf(goals);
  const collected: Collected = { holdings: new Map() };
  const balanceBudget = Math.max(0, Math.min(MAX_BALANCE_READS, budget.balances ?? MAX_BALANCE_READS));

  // Stage 1: exact balances, the sweep and positions, in parallel. An exact read always wins over the sweep's entry.
  const [, sweep, positions] = await Promise.all([
    readExact(accounts, goals, balanceBudget, deadlineMs, collected),
    goals.some(needsSweep) ? sweepAccounts(parsed, lanes, deadlineAt, collected) : Promise.resolve(skipped),
    readPositions(parsed, goals, lanes, deadlineAt),
  ]);

  // Stage 2: prices of what is held and named, and APYs of earn candidates, within what is left of the deadline.
  const priced = new Set<AssetId>();
  for (const holding of collected.holdings.values()) {
    if (holding.asset && holding.status === "known" && holding.units !== "0") priced.add(holding.asset);
  }
  for (const goal of goals) {
    for (const [network, selection] of [[goal.spend.from?.network, goal.spend.asset], [goal.want.at?.network, goal.want.asset]] as const) {
      if (!network || !selection) continue;
      for (const symbol of selectionSymbols(network, selection)) {
        const listed = findAssetBySymbol(network, symbol);
        if (listed) priced.add(listed.id);
      }
    }
  }
  const priceList = [...priced].slice(0, SNAPSHOT_LIMITS.priceReads);
  const stakeInputs = stakeInputsOf(goals);
  const [priceResults, apyResults, stakeResults] = await Promise.all([
    Promise.all(priceList.map((asset) => readPrice(asset, now, deadlineAt))),
    Promise.all(apyCandidates(goals, collected.holdings).map((venue) => readApy(venue, now, deadlineAt))),
    Promise.all(stakeInputs.map(async (input) => [input, await readStakeMetrics(input, now, deadlineAt - Date.now())] as const)),
  ]);
  const prices = new Map<AssetId, SnapshotPrice>();
  priceResults.forEach((price) => {
    if (price) prices.set(price.asset, price);
  });
  // Exact reads carry no USD: value them with a usable price.
  for (const [key, holding] of collected.holdings) {
    if (holding.status !== "known" || holding.usd !== null || !holding.asset || holding.formatted === undefined) continue;
    const price = prices.get(holding.asset);
    if (price && !price.stale) collected.holdings.set(key, { ...holding, usd: Math.round(Number(holding.formatted) * price.usd * 100) / 100 });
  }
  const apy = new Map<string, SnapshotApy>(apyResults.map((entry) => [entry.venue, entry]));
  return Object.freeze({
    accounts,
    observedAt,
    holdings: Object.freeze([...collected.holdings.values()]),
    positions: Object.freeze(positions.positions),
    positionNetworks: Object.freeze(positions.networks),
    prices,
    apy,
    ...(stakeResults.length > 0 ? { stakes: new Map(stakeResults) } : {}),
    sweep,
  });
}

/** Input assets of earn goals that may stake (ETH, SOL; their liquid-staking classes). */
function stakeInputsOf(goals: readonly Goal[]): ("SOL" | "ETH")[] {
  const inputs = new Set<"SOL" | "ETH">();
  for (const goal of goals.filter(isEarn)) {
    for (const selection of [goal.spend.asset, goal.want.asset]) {
      if (!selection) continue;
      const words = "symbol" in selection ? [selection.symbol.toUpperCase()] : [selection.class];
      if (words.some((word) => word === "ETH" || word === "WETH" || word === "eth" || word === "eth-lst")) inputs.add("ETH");
      if (words.some((word) => word === "SOL" || word === "sol" || word === "sol-lst")) inputs.add("SOL");
    }
  }
  return [...inputs];
}

/* ---------------------------------------------------------------- lookups */

/** The holding of `symbol` on `network` (undefined: not read). */
export function holdingOf(snapshot: Snapshot, network: NetworkKey, symbol: string): SnapshotHolding | undefined {
  const listed = findAssetBySymbol(network, symbol);
  const wanted = upper(listed?.symbol ?? symbol);
  return snapshot.holdings.find((holding) => holding.network === network && upper(holding.symbol) === wanted);
}

/** A price fresh enough to convert amounts with, or null (missing or stale: ask, never guess). */
export function usablePrice(snapshot: Snapshot, asset: AssetId): SnapshotPrice | null {
  const price = snapshot.prices.get(asset);
  return price && !price.stale ? price : null;
}

/**
 * The supplied amount (decimal) of the person's `protocol` position in
 * `symbol` on `network`, or undefined when it is unknown: a venue that was
 * not read or failed, or more than one venue with a position (ambiguous).
 * A read that found no position gives "0".
 */
export function positionAmount(snapshot: Snapshot, network: NetworkKey, protocol: string, symbol: string): string | undefined {
  const wanted = upper(symbol);
  const listed = findAssetBySymbol(network, symbol);
  const matches = snapshot.positions.filter((position) =>
    position.network === network && position.protocol === protocol &&
    (upper(position.symbol) === wanted || (listed !== null && upper(position.symbol) === upper(listed.symbol))));
  if (matches.length === 0 || matches.some((position) => position.status !== "known")) return undefined;
  const held = matches.filter((position) => position.units !== undefined && BigInt(position.units) > 0n);
  if (held.length > 1) return undefined;
  return held[0]?.formatted ?? "0";
}

/**
 * One venue's supply APY outside a snapshot (the policy's venue-less
 * deposit, protocols design 3.6): the same reader, timeout and 60 s cache as
 * the snapshot's earn candidates. Never throws: unknown is null.
 */
export async function readVenueApy(venue: YieldVenue, now = Date.now()): Promise<number | null> {
  const value = await readApy(venue, now, Date.now() + SNAPSHOT_LIMITS.apyReadMs);
  return value.status === "known" && !value.paused && !value.frozen ? value.apy : null;
}

/**
 * One venue's full reading outside a snapshot (current rate, S8 smoothed
 * rate and TVL, pause and capacity), for the policy's venue-less deposit and
 * `rankYieldVenues`: the same readers, 1.5 s bound and 60 s cache as the
 * snapshot's earn candidates. Never throws: what failed is `unknown`.
 */
export function readVenueReading(venue: YieldVenue, now = Date.now(), deadlineMs: number = SNAPSHOT_LIMITS.apyReadMs): Promise<SnapshotApy> {
  return readApy(venue, now, Date.now() + Math.max(1, Math.min(SNAPSHOT_LIMITS.apyReadMs, deadlineMs)));
}

/**
 * Smoothed rates and TVL of the liquid-staking tokens of `input` (seam S8),
 * bounded like a venue read and cached 60 s. Never throws: a failed or late
 * read is [] (every provider then unrated, never zero).
 */
export async function readStakeMetrics(input: "SOL" | "ETH", now = Date.now(), deadlineMs: number = SNAPSHOT_LIMITS.apyReadMs): Promise<readonly StakeMetricsReading[]> {
  const memo = stakeMemo.get(input);
  if (memo && now - memo.readAt <= SNAPSHOT_LIMITS.apyTtlMs) return memo.value;
  try {
    const listing = await withDeadline(readers.stakes(input), Math.max(1, Math.min(SNAPSHOT_LIMITS.apyReadMs, deadlineMs)));
    const value = Object.freeze(listing.map((entry) => ({ ...entry, ...stakeFinite(entry) })));
    stakeMemo.set(input, { value, readAt: now });
    return value;
  } catch {
    return [];
  }
}

function stakeFinite(entry: StakeMetricsReading): Pick<StakeMetricsReading, "smoothedApy" | "tvlUsd"> {
  const { smoothedApy, tvlUsd } = finiteMetrics({ smoothedApy: entry.smoothedApy, apyWindowSeconds: null, tvlUsd: entry.tvlUsd });
  return { smoothedApy, tvlUsd };
}
