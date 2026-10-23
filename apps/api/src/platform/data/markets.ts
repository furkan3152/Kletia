/**
 * Market and protocol data of the data API, read-only and advisory:
 *
 * - Yields: every venue in YIELD_VENUES on the lane, EVM lending venues
 *   through the venue rate reader (`readLendingMetrics`, cached a minute),
 *   Solana venues (Jupiter Lend, Kamino) through their adapter's
 *   `venueCapacity`. A venue whose rate cannot be read is listed with a null
 *   APY and the reason, never dropped and never 0.
 * - Prices: listed assets by symbol through the preview pricer (stablecoins
 *   at par, Jupiter, Chainlink), with source and reading time.
 * - Status: the health probe of every network, and route statistics when a
 *   source is installed (`configureRouteStatsSource`); without one the
 *   routes are null with the reason.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  YIELD_VENUES,
  type DataFailure,
  type DataLane,
  type DataMarketStatus,
  type DataPriceRow,
  type DataPrices,
  type DataRouteStats,
  type DataYieldRow,
  type DataYields,
  type NetworkKey,
  type YieldVenue,
} from "@kletia/core";
import { activeProtocolAdapters } from "../engine/adapters/registry.js";
import { isEvmLendingVenue, readLendingMetrics } from "../engine/adapters/lending/metrics.js";
import { listedAsset } from "../engine/holdings.js";
import { quoteAsset } from "../engine/preview/pricer.js";
import { PlatformError, toPlatformError } from "../errors.js";
import { readPlatformHealth } from "../http/health.js";

const CAPACITY_READ_MS = 4_000;

/** Prices listed when a request names no symbols. */
export const DEFAULT_PRICE_SYMBOLS: readonly string[] = Object.freeze(["ETH", "SOL", "POL", "cbBTC", "wstETH", "USDC", "USDT"]);
export const MAX_PRICE_SYMBOLS = 20;

export interface YieldFilter {
  readonly lane?: DataLane;
  readonly network?: NetworkKey;
  /** Underlying symbol (case-insensitive). */
  readonly asset?: string;
}

/** The desk sentence that deposits into `venue`, with an amount placeholder the composer selects. */
export function depositText(venue: Pick<YieldVenue, "asset" | "name" | "network">): string {
  return `Deposit [EDIT AMOUNT] ${venue.asset} into ${venue.name} on ${CHAINS[venue.network].name}`;
}

function laneOf(network: NetworkKey): DataLane {
  return CHAINS[network].lane === "testnet" ? "testnet" : "production";
}

export function yieldVenues(filter: YieldFilter): YieldVenue[] {
  const lane = filter.lane ?? "production";
  const asset = filter.asset?.toUpperCase();
  return YIELD_VENUES.filter((venue) =>
    laneOf(venue.network) === lane &&
    (!filter.network || venue.network === filter.network) &&
    (!asset || venue.asset.toUpperCase() === asset));
}

function withTimeout<T>(read: Promise<T>, ms: number): Promise<T> {
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError("RPC_TIMEOUT", "The venue read timed out.", 504)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function baseRow(venue: YieldVenue): Pick<DataYieldRow, "venue" | "protocol" | "network" | "name" | "asset" | "executable" | "depositText"> {
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network: venue.network,
    name: venue.name,
    asset: venue.asset,
    executable: venue.actions.includes("deposit"),
    depositText: depositText(venue),
  };
}

async function readYield(venue: YieldVenue): Promise<DataYieldRow> {
  if (isEvmLendingVenue(venue)) {
    const metrics = await readLendingMetrics(venue.id);
    return {
      ...baseRow(venue),
      apy: metrics.supplyApy,
      apyBasis: metrics.apySource,
      supplied: metrics.totalSupplied?.formatted ?? null,
      utilization: metrics.utilization,
      source: "lending-metrics",
      asOf: metrics.observedAt,
      ...(metrics.supplyApy === null ? { reason: "The venue's rate could not be read." } : {}),
    };
  }
  const adapter = activeProtocolAdapters().find((candidate) => candidate.protocols.includes(venue.protocol));
  if (!adapter?.venueCapacity) {
    return { ...baseRow(venue), apy: null, apyBasis: "unavailable", supplied: null, utilization: null, source: "adapter", asOf: null, reason: "Kletia does not read this venue's rate yet." };
  }
  const capacity = await withTimeout(adapter.venueCapacity(venue), CAPACITY_READ_MS);
  const apy = capacity.apy ?? null;
  return {
    ...baseRow(venue),
    apy,
    apyBasis: apy === null ? "unavailable" : "rate",
    supplied: null,
    utilization: capacity.utilization ?? null,
    source: "adapter",
    asOf: capacity.observedAt,
    ...(apy === null ? { reason: "The venue's rate could not be read." } : {}),
  };
}

/** Venue yields of the lane, best APY first (unread rates last, in registry order). */
export async function readYields(filter: YieldFilter = {}): Promise<DataYields> {
  const venues = yieldVenues(filter);
  const results = await Promise.allSettled(venues.map(readYield));
  const yields: DataYieldRow[] = [];
  const failures: DataFailure[] = [];
  results.forEach((result, index) => {
    const venue = venues[index] as YieldVenue;
    if (result.status === "fulfilled") {
      yields.push(result.value);
      return;
    }
    const error = toPlatformError(result.reason);
    failures.push({ subject: venue.id, code: error.code, message: error.message });
    yields.push({ ...baseRow(venue), apy: null, apyBasis: "unavailable", supplied: null, utilization: null, source: "adapter", asOf: null, reason: `The venue could not be read (${error.code}).` });
  });
  const order = new Map(venues.map((venue, index) => [venue.id, index]));
  yields.sort((a, b) => {
    if ((a.apy === null) !== (b.apy === null)) return a.apy === null ? 1 : -1;
    if (a.apy !== null && b.apy !== null && a.apy !== b.apy) return b.apy - a.apy;
    return (order.get(a.venue) ?? 0) - (order.get(b.venue) ?? 0);
  });
  return { yields, failures, asOf: new Date().toISOString() };
}

/** The first network of `lane` (registry order) that lists `symbol`, or `network` when given. */
function priceTarget(symbol: string, network: NetworkKey | undefined, lane: DataLane) {
  const networks = network ? [network] : NETWORK_KEYS.filter((key) => laneOf(key) === lane);
  for (const key of networks) {
    const asset = listedAsset(key, symbol);
    if (asset) return { network: key, asset };
  }
  return null;
}

/** USD prices of `symbols` (default: DEFAULT_PRICE_SYMBOLS), each with its source and reading time. */
export async function readPrices(symbols: readonly string[] = DEFAULT_PRICE_SYMBOLS, options: { readonly network?: NetworkKey; readonly lane?: DataLane } = {}): Promise<DataPrices> {
  const rows = await Promise.all(symbols.map(async (symbol): Promise<DataPriceRow> => {
    const target = priceTarget(symbol, options.network, options.lane ?? "production");
    if (!target) return { symbol, network: options.network ?? null, asset: null, value: { usd: null, source: "unpriced", asOf: null, reason: "The asset is not listed on these networks." } };
    const quote = await quoteAsset(target.asset.id);
    return {
      symbol: target.asset.symbol,
      network: target.network,
      asset: target.asset.id,
      value: quote
        ? { usd: quote.usd, source: quote.source, asOf: quote.at }
        : { usd: null, source: "unpriced", asOf: null, reason: "No price source answered." },
    };
  }));
  return { prices: rows, asOf: new Date().toISOString() };
}

/** Route statistics (bridges and aggregators per network pair). Returns null when none are recorded. */
export type RouteStatsSource = () => readonly DataRouteStats[] | null | Promise<readonly DataRouteStats[] | null>;

let routeStatsSource: RouteStatsSource | null = null;

/** Installs the route statistics source (null removes it). */
export function configureRouteStatsSource(source: RouteStatsSource | null): void {
  routeStatsSource = source;
}

/** Network status from the health probe, plus route statistics when a source is installed. */
export async function readMarketStatus(): Promise<DataMarketStatus> {
  const [health, routes] = await Promise.all([
    readPlatformHealth(),
    routeStatsSource ? Promise.resolve(routeStatsSource()).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    networks: health.networks.map((network) => ({
      network: network.network,
      name: network.name,
      environment: network.environment,
      ok: network.ok,
      latencyMs: network.latencyMs,
      height: network.height ?? null,
      source: "health-probe",
      asOf: health.time,
    })),
    routes: routes ? [...routes] : null,
    ...(routes ? {} : { routesReason: routeStatsSource ? "Route statistics could not be read." : "This API build records no route statistics yet." }),
    asOf: new Date().toISOString(),
  };
}

