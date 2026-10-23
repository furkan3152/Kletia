/**
 * The data API's reads (docs/platform/data.md), composed from the engine's
 * existing readers and cached briefly per wallet set or filter:
 *
 * - portfolio and positions: one read of every account of the wallet set
 *   (`readAccountPortfolios` with venue positions, 4 at a time) plus the
 *   lending debt and health reads, cached 15 s per wallet set;
 * - yields 60 s, prices 30 s, status 15 s.
 *
 * The 24-hour change and the PnL estimate compare the net value with this
 * instance's earlier readings (snapshots.ts). A reading is kept only when no
 * account or market failed to read (known gaps such as Kamino obligations,
 * which never change between readings, do not block it).
 */
import {
  getYieldVenue,
  type DataLane,
  type DataMarketStatus,
  type DataPortfolio,
  type DataPositions,
  type DataPrices,
  type DataWalletSet,
  type DataYields,
  type NetworkKey,
} from "@kletia/core";
import { readAccountPortfolios } from "../engine/portfolio.js";
import { allocationOf, holdingsOf, readFailures, stakingPositions, totalsOf, venuePositions } from "./aggregate.js";
import { readLendingAccounts } from "./lending.js";
import { readMarketStatus, readPrices, readYields, type YieldFilter } from "./markets.js";
import { recordValue, valueChanges, walletSetKey } from "./snapshots.js";

export const DATA_CACHE_TTL_MS = Object.freeze({ portfolio: 15_000, yields: 60_000, prices: 30_000, status: 15_000 });
const CACHE_ENTRIES = 1_000;

/** Failure codes of permanent gaps (a reader Kletia does not have yet), not of reads that went wrong. */
const KNOWN_GAPS: ReadonlySet<string> = new Set(["POSITION_UNAVAILABLE"]);

const cache = new Map<string, { readonly value: Promise<unknown>; readonly at: number }>();

/** Forgets cached reads (tests). */
export function resetDataCache(): void {
  cache.clear();
}

/** A shared read per key within `ttlMs`; a failed read is not kept. */
function cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = read();
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  value.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

async function buildPortfolio(set: DataWalletSet): Promise<DataPortfolio> {
  const [batch, lending] = await Promise.all([readAccountPortfolios(set.accounts, { positions: true }), readLendingAccounts(set.accounts)]);
  const asOf = new Date().toISOString();
  const holdings = holdingsOf(batch.portfolios);
  const positions = [
    ...batch.portfolios.flatMap((portfolio) => venuePositions(portfolio.account, portfolio.positions ?? [], (venue) => getYieldVenue(venue)?.kind ?? null)),
    ...stakingPositions(holdings),
    ...lending.debts,
  ];
  const failures = readFailures(batch.portfolios, batch.failures, lending);
  const totals = totalsOf(holdings, positions, failures, asOf);
  const key = walletSetKey(set);
  const { change24h, pnl } = valueChanges(key, totals.net.usd);
  if (totals.net.usd !== null && failures.every((failure) => KNOWN_GAPS.has(failure.code))) recordValue(key, totals.net.usd);
  return {
    wallets: { evm: set.evm, solana: set.solana, lane: set.lane },
    accounts: set.accounts,
    totals,
    change24h,
    pnl,
    allocation: allocationOf(holdings, positions),
    holdings,
    positions,
    health: lending.health,
    failures,
    asOf,
  };
}

/** Everything the wallet set holds, valued, with allocation, health and the value estimates. */
export function readDataPortfolio(set: DataWalletSet): Promise<DataPortfolio> {
  return cached(`portfolio|${walletSetKey(set)}`, DATA_CACHE_TTL_MS.portfolio, () => buildPortfolio(set));
}

/** Positions, debts and health of the wallet set (the same read as the portfolio). */
export async function readDataPositions(set: DataWalletSet): Promise<DataPositions> {
  const portfolio = await readDataPortfolio(set);
  return { accounts: portfolio.accounts, positions: portfolio.positions, health: portfolio.health, failures: portfolio.failures, asOf: portfolio.asOf };
}

export function readDataYields(filter: YieldFilter): Promise<DataYields> {
  return cached(`yields|${filter.lane ?? "production"}|${filter.network ?? ""}|${filter.asset?.toUpperCase() ?? ""}`, DATA_CACHE_TTL_MS.yields, () => readYields(filter));
}

export function readDataPrices(symbols: readonly string[] | undefined, options: { readonly network?: NetworkKey; readonly lane?: DataLane }): Promise<DataPrices> {
  const key = `prices|${options.lane ?? "production"}|${options.network ?? ""}|${(symbols ?? []).join(",").toUpperCase()}`;
  return cached(key, DATA_CACHE_TTL_MS.prices, () => readPrices(symbols, options));
}

export function readDataStatus(): Promise<DataMarketStatus> {
  return cached("status", DATA_CACHE_TTL_MS.status, () => readMarketStatus());
}
