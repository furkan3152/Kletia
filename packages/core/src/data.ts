/**
 * Shapes of the data API (`/v1/data/*`, docs/platform/data.md), shared by
 * the API, the SDK and the dashboard, and its CSV export. Every value
 * says where it comes from (`source`) and when it was read (`asOf`); a value
 * that is unknown is null with a `reason`, never zero.
 */
import type { AccountId, AssetId } from "./caip.js";
import type { NetworkKey } from "./chains.js";
import type { JourneyValueSource } from "./journey.js";
import type { PerpsPosition } from "./perps.js";
import type { PolymarketWallet, PolymarketWalletKind, PredictionPosition } from "./predictions.js";
import type { ProtocolId } from "./protocols.js";

/**
 * Where a value comes from: a price source of the portfolio (`usd-par`,
 * `jupiter`, `chainlink`, `pyth`, `venue-rate`, `testnet`, `unpriced`), an on-chain read through a
 * venue adapter (`adapter`), a lending pool's own oracle (`aave-oracle`),
 * the venue rate reader (`lending-metrics`), the health probe
 * (`health-probe`), this API's own readings (`snapshot`) or its stores
 * (`kletia`), Kamino's API (`kamino-api`), a history provider (`etherscan`,
 * `alchemy`, `helius`, `solana-rpc`), a historical price source
 * (`defillama`, `coingecko`) or the FIFO cost-basis estimate (`fifo`).
 */
export type DataSource =
  | JourneyValueSource
  | "adapter"
  | "aave-oracle"
  | "lending-metrics"
  | "health-probe"
  | "snapshot"
  | "kletia"
  | "kamino-api"
  | DataTxProvider
  | DataHistoricalPriceSource
  | "fifo";

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
  /** With `extras=true`: perps, open orders, automations and agent spend. */
  readonly extras?: DataCoverageExtras;
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

/* ------------------------------------------------------ on-chain history */

/** What a wallet transaction did, read from its transfers and the contracts it touched. */
export type DataTxKind =
  | "send"
  | "receive"
  | "swap"
  | "bridge-out"
  | "bridge-in"
  | "deposit"
  | "withdraw"
  | "stake"
  | "unstake"
  | "borrow"
  | "repay"
  | "approve"
  | "perp"
  | "order"
  | "prediction"
  | "contract-call"
  | "failed"
  | "unknown";

export const DATA_TX_KINDS: readonly DataTxKind[] = Object.freeze([
  "send", "receive", "swap", "bridge-out", "bridge-in", "deposit", "withdraw", "stake", "unstake",
  "borrow", "repay", "approve", "perp", "order", "prediction", "contract-call", "failed", "unknown",
]);

/** History providers: Etherscan V2, Alchemy transfers, Helius enhanced transactions, plain Solana RPC. */
export type DataTxProvider = "etherscan" | "alchemy" | "helius" | "solana-rpc";

/** Historical USD prices: DefiLlama's coins API (keyless) or CoinGecko (with a key). */
export type DataHistoricalPriceSource = "defillama" | "coingecko";

/** A token of a transfer. `address` null is the network's gas asset. */
export interface DataTxAsset {
  readonly symbol: string;
  /** Contract (EVM) or mint (Solana); null for the gas asset. */
  readonly address: string | null;
  readonly decimals: number | null;
  /** Kletia's asset id when the token is listed; unlisted tokens keep the provider's symbol (it may be spam). */
  readonly id: AssetId | null;
}

export interface DataTxLeg {
  readonly asset: DataTxAsset;
  /** Decimal amount; null when the token's decimals are unknown. */
  readonly amount: string | null;
  readonly direction: "in" | "out";
  /** USD value at the transaction's time; null when no historical price was found (see `reason`). */
  readonly usdAtTime: number | null;
  readonly priceSource: DataHistoricalPriceSource | null;
  readonly reason?: string;
}

export interface DataTxFee {
  readonly asset: DataTxAsset;
  readonly amount: string;
  readonly usd: number | null;
  readonly reason?: string;
}

/** The protocol a transaction touched, from Kletia's protocol registry. */
export interface DataTxProtocol {
  readonly id: ProtocolId | null;
  readonly label: string;
  /** The registry role of the matched contract or program (`spoke-pool`, `program` ...). */
  readonly role: string | null;
}

export interface DataTransaction {
  /** `<network>:<hash or signature>` (EVM hashes lower-cased). */
  readonly id: string;
  readonly network: NetworkKey;
  /** Transaction hash (EVM) or signature (Solana). */
  readonly hash: string;
  /** The wallet of the set this row is about. */
  readonly account: AccountId;
  readonly time: string;
  readonly block: number | null;
  readonly kind: DataTxKind;
  readonly status: "success" | "failed";
  readonly legs: readonly DataTxLeg[];
  /** Paid by this wallet; null when someone else paid (a received transfer). */
  readonly fee: DataTxFee | null;
  /** The other side of a plain transfer, or the contract called. */
  readonly counterparty: string | null;
  /** Null when no registry contract or program matched. */
  readonly protocol: DataTxProtocol | null;
  /** Method name or selector the provider reports, when it reports one. */
  readonly method: string | null;
  /** The Kletia intent this transaction was a step of, when the caller may see that intent. */
  readonly kletiaIntentId: string | null;
  readonly kletiaReceiptId: string | null;
  readonly source: DataTxProvider;
  readonly explorerUrl: string;
}

/** How completely one account's history could be read. */
export interface DataTxCoverage {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly provider: DataTxProvider | null;
  /** `partial`: the page cap or a provider limit stopped early; `not-configured`: no provider key for this network. */
  readonly status: "ok" | "partial" | "not-configured" | "unsupported" | "failed";
  readonly reason?: string;
  /** Environment variables that would enable or improve this account's history. */
  readonly env?: readonly string[];
}

export interface DataTxQuery {
  readonly network?: NetworkKey;
  readonly kind?: DataTxKind;
  /** Symbol (case-insensitive) or token address / mint. */
  readonly asset?: string;
  /** Protocol id or label (case-insensitive). */
  readonly protocol?: string;
  /** ISO times, inclusive. */
  readonly from?: string;
  readonly to?: string;
  readonly kletiaOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DataTransactionPage {
  readonly transactions: readonly DataTransaction[];
  /** Opaque; pass it back as `cursor` for older rows. Null when every account's history ran out. */
  readonly cursor: string | null;
  readonly coverage: readonly DataTxCoverage[];
  readonly asOf: string;
}

/* ------------------------------------------------------------ cost basis */

export type DataPnlPeriod = "24h" | "7d" | "30d" | "all";
export const DATA_PNL_PERIODS: readonly DataPnlPeriod[] = Object.freeze(["24h", "7d", "30d", "all"]);

/** FIFO cost basis of one asset over the read history (an estimate). */
export interface DataPnlAsset {
  /** Cross-network group (`USDC`, `ETH`) or symbol of a listed asset, `<network>:<address>` for unlisted tokens. */
  readonly key: string;
  readonly symbol: string;
  /** Units still held according to the history (acquired minus disposed). */
  readonly openQuantity: number;
  /** Cost of the open lots; null when a lot's price at the time is unknown. */
  readonly costBasisUsd: number | null;
  /** Realized in the period; null when a disposed lot had no known cost or proceeds. */
  readonly realizedUsd: number | null;
  /** Value of the open lots now minus their cost; null when either is unknown (see `reason`). */
  readonly unrealizedUsd: number | null;
  readonly currentUsd: number | null;
  readonly reason?: string;
}

export interface DataPnl {
  readonly period: DataPnlPeriod;
  readonly since: string | null;
  readonly method: "fifo";
  readonly estimate: true;
  readonly assets: readonly DataPnlAsset[];
  /** Sums of the known parts; `complete` false when any part was unknown or some history was unread. */
  readonly totals: { readonly realizedUsd: number; readonly unrealizedUsd: number; readonly complete: boolean };
  readonly coverage: readonly DataTxCoverage[];
  readonly source: "fifo";
  readonly asOf: string;
}

/* ------------------------------------------------------------- snapshots */

export type DataSnapshotRange = "24h" | "7d" | "30d" | "all";
export const DATA_SNAPSHOT_RANGES: readonly DataSnapshotRange[] = Object.freeze(["24h", "7d", "30d", "all"]);

export interface DataSnapshotPoint {
  readonly at: string;
  readonly usd: number;
  /** False when some account or market was unread at that time (the value covers the known part). */
  readonly complete: boolean;
}

export interface DataSnapshotSeries {
  readonly range: DataSnapshotRange;
  /** Oldest first: hourly for 24h and 7d, daily for 30d and all. */
  readonly points: readonly DataSnapshotPoint[];
  /** Last point against the first; null with fewer than two points. */
  readonly change: { readonly usd: number; readonly pct: number | null } | null;
  /** True when the wallets are tracked (the snapshot job reads tracked sets only). */
  readonly tracked: boolean;
  readonly reason?: string;
  readonly source: "snapshot";
  readonly asOf: string;
}

/* -------------------------------------------------------------- tracking */

/** A wallet set the user opted into tracking, each wallet proven by its own sign-in. */
export interface DataTracking {
  readonly id: string;
  readonly wallets: { readonly evm: readonly string[]; readonly solana: readonly string[] };
  readonly lane: DataLane;
  readonly createdAt: string;
  readonly lastSnapshotAt: string | null;
}

/* ------------------------------------------------------------- coverage */

/** Rows the portfolio read does not cover, with why they may be missing. */
export interface DataSection<T> {
  readonly rows: readonly T[];
  /** Null when everything was read; otherwise why rows are missing. */
  readonly reason: string | null;
  readonly source: "perps" | "orders" | "automations" | "policy" | "predictions";
  readonly asOf: string | null;
}

export interface DataPerpRow extends PerpsPosition {
  readonly account: AccountId;
}

/** A prediction-market position (Polymarket) of one of the set's EVM wallets or of its Polymarket wallet, as the venue's data API reports it. */
export interface DataPredictionRow extends PredictionPosition {
  /** The set's EVM wallet (on Polygon) the position belongs to. */
  readonly account: AccountId;
  /** Who holds the shares: the account itself, or its Polymarket wallet of that kind (`holder` is its address). */
  readonly holderKind: "account" | PolymarketWalletKind;
}

/** A Polymarket wallet found for one of the set's EVM wallets (derived, then checked on Polygon). */
export interface DataPredictionWallet extends Pick<PolymarketWallet, "address" | "kind" | "owner" | "tradable" | "onProfile" | "balances"> {
  readonly account: AccountId;
}

export interface DataOrderRow {
  readonly id: string;
  readonly protocol: string;
  readonly network: NetworkKey;
  readonly owner: string;
  readonly status: string;
  readonly sell: { readonly symbol: string; readonly amount: string };
  readonly buy: { readonly symbol: string; readonly amount: string } | null;
  readonly createdAt: string | null;
}

export interface DataAutomationRow {
  readonly id: string;
  readonly label: string | null;
  readonly trigger: string;
  readonly status: string;
  readonly runs: number;
  readonly spentUsd: string;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface DataAgentSpendRow {
  readonly keyId: string;
  readonly name: string;
  readonly kind: string;
  readonly dayUsd: string;
  readonly weekUsd: string;
}

/** Perps, open native orders, automations, sub-agent spend and prediction-market positions of the caller. */
export interface DataCoverageExtras {
  readonly perps: DataSection<DataPerpRow>;
  readonly orders: DataSection<DataOrderRow>;
  readonly automations: DataSection<DataAutomationRow>;
  readonly agentSpend: DataSection<DataAgentSpendRow>;
  readonly predictions: DataSection<DataPredictionRow>;
  /** The Polymarket wallets whose positions `predictions` includes. */
  readonly predictionWallets: readonly DataPredictionWallet[];
}

/* --------------------------------------------------------------- summary */

export interface DataRiskFlag {
  readonly flag: "LOW_HEALTH" | "LIQUIDATABLE" | "PERP_NEAR_LIQUIDATION" | "CONCENTRATION" | "UNPRICED" | "UNREAD" | "HISTORY_INCOMPLETE";
  readonly severity: "info" | "warning" | "critical";
  readonly subject: string;
  readonly message: string;
}

/** One compact object about a wallet set for an assistant; every number says where it comes from. */
export interface DataSummary {
  readonly wallets: { readonly evm: readonly string[]; readonly solana: readonly string[]; readonly lane: DataLane };
  readonly totals: { readonly netUsd: number | null; readonly walletUsd: number | null; readonly positionsUsd: number | null; readonly debtUsd: number | null; readonly complete: boolean };
  readonly change24h: DataValueChange;
  /** The five largest slices of each. */
  readonly allocation: { readonly byNetwork: readonly DataAllocationSlice[]; readonly byAsset: readonly DataAllocationSlice[] };
  readonly topPositions: readonly { readonly name: string; readonly network: NetworkKey; readonly kind: DataPositionKind; readonly usd: number | null }[];
  readonly perps: { readonly open: number; readonly unrealizedPnlUsd: number | null };
  readonly risks: readonly DataRiskFlag[];
  /** Counts of the read history (the first pages only: `complete` false when more was left unread). */
  readonly activity: { readonly last24h: number; readonly last7d: number; readonly last30d: number; readonly byKind: Readonly<Partial<Record<DataTxKind, number>>>; readonly complete: boolean };
  readonly pnl: { readonly realizedUsd: number | null; readonly unrealizedUsd: number | null; readonly estimate: true; readonly reason?: string };
  /** Every source a number above came from. */
  readonly sources: readonly string[];
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

export type DataExportDataset = "holdings" | "positions" | "history" | "transactions";
export const DATA_EXPORT_DATASETS: readonly DataExportDataset[] = Object.freeze(["holdings", "positions", "history", "transactions"]);

/** One row per leg; a transaction without legs is one row with empty leg cells. */
export function dataTransactionsCsv(page: Pick<DataTransactionPage, "transactions">): string {
  return toDataCsv(
    ["time", "network", "hash", "account", "kind", "status", "direction", "symbol", "token", "amount", "usd_at_time", "fee", "fee_symbol", "fee_usd", "protocol", "counterparty", "kletia_intent_id", "source"],
    page.transactions.flatMap((tx) => {
      const head: DataCsvCell[] = [tx.time, tx.network, tx.hash, tx.account, tx.kind, tx.status];
      const tail: DataCsvCell[] = [tx.fee?.amount, tx.fee?.asset.symbol, tx.fee?.usd, tx.protocol?.label, tx.counterparty, tx.kletiaIntentId, tx.source];
      if (tx.legs.length === 0) return [[...head, null, null, null, null, null, ...tail]];
      return tx.legs.map((leg) => [...head, leg.direction, leg.asset.symbol, leg.asset.address ?? "native", leg.amount, leg.usdAtTime, ...tail]);
    }),
  );
}

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
