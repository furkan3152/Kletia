/**
 * Shapes of the data API (`/v1/data/*`, docs/platform/data.md), shared by
 * the API, the SDK and the dashboard, and its CSV export. Every value
 * says where it comes from (`source`) and when it was read (`asOf`); a value
 * that is unknown is null with a `reason`, never zero.
 */
import type { AccountId, AssetId } from "./caip.js";
import type { NetworkKey } from "./chains.js";
import type { JourneyValueSource } from "./journey.js";
import type { ProtocolId } from "./protocols.js";

/**
 * Where a value comes from: a price source of the portfolio (`usd-par`,
 * `jupiter`, `chainlink`, `pyth`, `venue-rate`, `testnet`, `unpriced`), an on-chain read through a
 * venue adapter (`adapter`), a lending pool's own oracle (`aave-oracle`),
 * the venue rate reader (`lending-metrics`), the health probe
 * (`health-probe`), this API's own readings (`snapshot`) or its stores
 * (`kletia`).
 */
export type DataSource =
  | JourneyValueSource
  | "adapter"
  | "aave-oracle"
  | "lending-metrics"
  | "health-probe"
  | "snapshot"
  | "kletia";

/** A USD amount with its provenance; `usd` null means unknown (see `reason`). */
export interface DataUsdValue {
  readonly usd: number | null;
  readonly source: DataSource;
  /** ISO time of the reading; null when nothing was read. */
  readonly asOf: string | null;
  readonly reason?: string;
}

export type DataLane = "production" | "testnet";

/** The wallets a request reads: EVM and Solana addresses, on one lane. */
export interface DataWalletSet {
  readonly evm: readonly string[];
  readonly solana: readonly string[];
  readonly lane: DataLane;
  /** One CAIP-10 account per (address, network of the lane its VM runs). */
  readonly accounts: readonly AccountId[];
}

export interface DataHolding {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly asset: AssetId;
  readonly symbol: string;
  readonly amount: string;
  readonly formatted: string;
  readonly value: DataUsdValue;
}

export type DataPositionKind = "supply" | "vault" | "borrow" | "staking";

export interface DataPosition {
  /** YIELD_VENUES id, the pool or Comet for a debt, or `<network>:<protocol>:<symbol>` for a staking token. */
  readonly id: string;
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly protocol: ProtocolId | null;
  readonly name: string;
  readonly kind: DataPositionKind;
  readonly symbol: string;
  /** Underlying amount (formatted); null when only a USD value is known (Aave debt in the pool's base currency). */
  readonly amount: string | null;
  /** Debts are positive USD here and subtracted from the total. */
  readonly value: DataUsdValue;
  /** Supply APY as a fraction; null when unread. */
  readonly apy: number | null;
  /** Staking tokens sit in the wallet: their value is already counted with the holdings. */
  readonly inWallet: boolean;
}

export type LendingHealthStatus = "ok" | "warning" | "critical" | "no-debt" | "unknown";

/** Below these health factors a lending account is flagged (Aave liquidates below 1). */
export const LENDING_HEALTH_THRESHOLDS = Object.freeze({ warning: 1.5, critical: 1.1 });

export interface LendingHealth {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly protocol: ProtocolId;
  /** Pool, Comet or market the reading is for. */
  readonly market: string;
  /** Null when there is no debt or it could not be read (see `reason`). */
  readonly healthFactor: number | null;
  readonly status: LendingHealthStatus;
  readonly source: DataSource;
  readonly asOf: string | null;
  readonly reason?: string;
}

export interface DataAllocationSlice {
  readonly key: string;
  readonly label: string;
  readonly usd: number;
  /** Share of the priced gross value (0..1). */
  readonly share: number;
}

export interface DataAllocation {
  readonly byNetwork: readonly DataAllocationSlice[];
  readonly byAsset: readonly DataAllocationSlice[];
  readonly byProtocol: readonly DataAllocationSlice[];
}

export interface DataFailure {
  /** Account, venue or market that could not be read. */
  readonly subject: string;
  readonly code: string;
  readonly message: string;
}

export interface DataPortfolioTotals {
  /** Wallet holdings plus venue positions minus debt (priced parts only). */
  readonly net: DataUsdValue;
  readonly wallet: DataUsdValue;
  readonly positions: DataUsdValue;
  readonly debt: DataUsdValue;
  /** Holdings and positions with an amount but no price. */
  readonly unpriced: number;
  /** False when something was unpriced or could not be read: the totals cover the known part only. */
  readonly complete: boolean;
}

/** A change of the net value against an earlier reading of this API (an estimate, never realised PnL). */
export interface DataValueChange {
  readonly usd: number | null;
  /** Fraction of the earlier value; null when unknown or the earlier value was 0. */
  readonly pct: number | null;
  /** ISO time of the earlier reading. */
  readonly since: string | null;
  readonly source: "snapshot";
  readonly estimate: true;
  readonly reason?: string;
}

export interface DataPortfolio {
  readonly wallets: { readonly evm: readonly string[]; readonly solana: readonly string[]; readonly lane: DataLane };
  readonly accounts: readonly AccountId[];
  readonly totals: DataPortfolioTotals;
  readonly change24h: DataValueChange;
  /** Net value now against the first reading this API instance took of the same wallets. */
  readonly pnl: DataValueChange;
  readonly allocation: DataAllocation;
  readonly holdings: readonly DataHolding[];
  readonly positions: readonly DataPosition[];
  readonly health: readonly LendingHealth[];
  readonly failures: readonly DataFailure[];
  readonly asOf: string;
}

export interface DataPositions {
  readonly accounts: readonly AccountId[];
  readonly positions: readonly DataPosition[];
  readonly health: readonly LendingHealth[];
  readonly failures: readonly DataFailure[];
  readonly asOf: string;
}

export type DataHistoryKind = "intent" | "receipt" | "link";

export interface DataHistoryEntry {
  readonly kind: DataHistoryKind;
  readonly id: string;
  /** ISO time the object was created (a receipt: issued). */
  readonly at: string;
  readonly status: string;
  readonly title: string;
  readonly networks: readonly NetworkKey[];
  /** The intent a receipt belongs to, or a link's last intent; null otherwise. */
  readonly intentId: string | null;
  readonly source: "kletia";
}

export interface DataHistory {
  readonly entries: readonly DataHistoryEntry[];
  /** True when a wallet filter was applied (only intents planned for those wallets). */
  readonly filtered: boolean;
  readonly asOf: string;
}

export interface DataYieldRow {
  readonly venue: string;
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly name: string;
  readonly asset: string;
  /** Supply APY as a fraction; null when unread (see `reason`). */
  readonly apy: number | null;
  /** `rate`: current supply rate; `share-price`: realised share-price growth; `unavailable`. */
  readonly apyBasis: "rate" | "share-price" | "unavailable";
  /** Underlying supplied (formatted); null when unread. */
  readonly supplied: string | null;
  readonly utilization: number | null;
  /** Kletia can plan a deposit into it. */
  readonly executable: boolean;
  /** A desk sentence that deposits into the venue, with an amount placeholder to fill in. */
  readonly depositText: string;
  readonly source: DataSource;
  readonly asOf: string | null;
  readonly reason?: string;
}

export interface DataYields {
  readonly yields: readonly DataYieldRow[];
  readonly failures: readonly DataFailure[];
  readonly asOf: string;
}

export interface DataPriceRow {
  readonly symbol: string;
  readonly network: NetworkKey | null;
  readonly asset: AssetId | null;
  readonly value: DataUsdValue;
}

export interface DataPrices {
  readonly prices: readonly DataPriceRow[];
  readonly asOf: string;
}

export interface DataNetworkStatus {
  readonly network: NetworkKey;
  readonly name: string;
  readonly environment: "mainnet" | "testnet";
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly height: string | null;
  readonly source: "health-probe";
  readonly asOf: string;
}

/** Rolling quote statistics of one bridge or route venue between two networks. */
export interface DataRouteStats {
  readonly venue: ProtocolId;
  readonly network: NetworkKey;
  readonly destination: NetworkKey;
  readonly attempts: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly failureRate: number;
  readonly rateLimited: number;
  readonly breaker: "closed" | "open" | "half-open";
}

export interface DataMarketStatus {
  readonly networks: readonly DataNetworkStatus[];
  /** Null when this API build records no route statistics (see `routesReason`). */
  readonly routes: readonly DataRouteStats[] | null;
  readonly routesReason?: string;
  readonly asOf: string;
}

/* ------------------------------------------------------------------ CSV */

/**
 * CSV export of data API tables (RFC 4180): comma separated, CRLF line ends,
 * a header row, every cell quoted when it holds a comma, quote, CR or LF
 * (quotes doubled). Text cells that a spreadsheet would run as a formula
 * (starting with =, +, -, @, tab or CR) are prefixed with an apostrophe;
 * numbers are written as numbers. Unknown values are empty cells, never 0.
 */
export type DataCsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/u;

export function dataCsvCell(value: DataCsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function toDataCsv(header: readonly string[], rows: readonly (readonly DataCsvCell[])[]): string {
  return [header, ...rows].map((row) => row.map(dataCsvCell).join(",")).join("\r\n") + "\r\n";
}

export type DataExportDataset = "holdings" | "positions" | "history";
export const DATA_EXPORT_DATASETS: readonly DataExportDataset[] = Object.freeze(["holdings", "positions", "history"]);

export function dataHoldingsCsv(portfolio: Pick<DataPortfolio, "holdings">): string {
  return toDataCsv(
    ["account", "network", "asset", "symbol", "amount", "usd", "source", "as_of", "reason"],
    portfolio.holdings.map((holding) => [holding.account, holding.network, holding.asset, holding.symbol, holding.formatted, holding.value.usd, holding.value.source, holding.value.asOf, holding.value.reason]),
  );
}

export function dataPositionsCsv(positions: Pick<DataPositions, "positions">): string {
  return toDataCsv(
    ["account", "network", "protocol", "position", "kind", "symbol", "amount", "usd", "apy", "in_wallet", "source", "as_of", "reason"],
    positions.positions.map((position) => [
      position.account, position.network, position.protocol, position.name, position.kind, position.symbol, position.amount,
      position.value.usd, position.apy, position.inWallet, position.value.source, position.value.asOf, position.value.reason,
    ]),
  );
}

export function dataHistoryCsv(history: Pick<DataHistory, "entries">): string {
  return toDataCsv(
    ["at", "kind", "id", "status", "title", "networks", "intent_id"],
    history.entries.map((entry) => [entry.at, entry.kind, entry.id, entry.status, entry.title, entry.networks.join(" "), entry.intentId]),
  );
}
