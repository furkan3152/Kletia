/**
 * The assistant's narrow view of the data API (docs/platform/assistant.md).
 * The answering engine reads only through this port. `dataApiPort` adapts the
 * data service's typed functions (data/api.ts): portfolio and positions with
 * their extras (perps, open orders, automations, prediction positions), the
 * on-chain transaction history, FIFO PnL and value snapshots, each read under
 * one `DataScope`:
 *
 * - an API key: the addresses it names (an agent key's narrowed to the
 *   accounts its rule book pins), links only to its own intents;
 * - a desk wallet session: its tracked set; with tracking off, history and
 *   PnL answer that tracking must be turned on, and say where.
 *
 * Shapes follow packages/core/src/data.ts: every value carries `source` and
 * `asOf`, unknown values are null with a `reason`, never zero, and the
 * accounts whose history could not be read come back as coverage entries
 * (with the environment variables that would enable them), never as "nothing
 * happened". `AssistantDataReader` is the seam the eval fills with recorded
 * fixtures.
 */
import {
  CHAINS,
  type AccountId,
  type AssistantTxKind,
  type DataPnl,
  type DataPnlPeriod,
  type DataPortfolio,
  type DataPositions,
  type DataPrices,
  type DataSnapshotRange,
  type DataSnapshotSeries,
  type DataSource,
  type DataTransaction,
  type DataTransactionPage,
  type DataTxCoverage,
  type DataTxKind,
  type DataTxQuery,
  type DataUsdValue,
  type DataWalletSet,
  type DataYields,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import {
  pnl as readPnl,
  positions as readPositions,
  readDataPortfolio,
  readDataPrices,
  readDataYields,
  snapshots as readSnapshots,
  transactions as readTransactions,
  type DataScope,
} from "../data/index.js";

/** Holdings, positions, totals, allocation, health and the value estimates of a wallet set. */
export type AssistantSummary = Pick<DataPortfolio, "accounts" | "totals" | "change24h" | "pnl" | "allocation" | "holdings" | "positions" | "health" | "failures" | "asOf">;

/** A USD value with its provenance, as DataUsdValue, where a value read straight from the chain says so. */
export interface AssistantUsdValue extends Omit<DataUsdValue, "source"> {
  readonly source: DataSource | "chain";
}

export interface AssistantTxLeg {
  readonly symbol: string;
  /** Formatted decimal amount; null when the token's decimals are unknown. */
  readonly amount: string | null;
  /** USD at the transaction's time; null when no price was found. */
  readonly usd: number | null;
}

/** One transaction of the wallet set (a row of the desk's History). */
export interface AssistantTransaction {
  /** The data API's id, `<network>:<hash>`: the History row it links to. */
  readonly id: string;
  /** ISO time it was confirmed. */
  readonly at: string;
  readonly kind: AssistantTxKind;
  /** The data API's own kind (`bridge-out`, `receive`, `contract-call` ...). */
  readonly detail: DataTxKind;
  readonly account: AccountId;
  readonly network: NetworkKey;
  /** Where a bridge delivered: the network of an arrival (`bridge-in`); null when the chain does not say (a departure). */
  readonly destination: NetworkKey | null;
  readonly protocol: ProtocolId | null;
  readonly protocolLabel: string | null;
  readonly status: "confirmed" | "failed";
  readonly sent: readonly AssistantTxLeg[];
  readonly received: readonly AssistantTxLeg[];
  /** Network fee this wallet paid, in USD; null when someone else paid (a received transfer, a relayed arrival). */
  readonly fee: AssistantUsdValue | null;
  readonly hash: string;
  readonly kletiaIntentId: string | null;
  readonly source: "chain";
}

export interface TransactionQuery {
  readonly from?: string | null;
  /** Exclusive. */
  readonly to?: string;
}

export interface AssistantTransactions {
  readonly transactions: readonly AssistantTransaction[];
  /** "chain": the wallets' on-chain history (see `unread`); "none": nothing could be read (see `reason`). */
  readonly coverage: "chain" | "none";
  /** False when some account was not read in full, or the window held more rows than one answer reads. */
  readonly complete: boolean;
  /** Accounts whose history was not read in full, with why and the variables that would enable them. */
  readonly unread: readonly DataTxCoverage[];
  /** True when only the newest rows of the window were read (`HISTORY_READ.pages` pages). */
  readonly truncated: boolean;
  readonly reason?: string;
  readonly asOf: string;
}

export interface PnlQuery {
  readonly from?: string | null;
  readonly to?: string;
  readonly by: "asset" | "position";
}

/** The result of one asset (or position) over a window; `earned` is yield or rewards received. */
export interface AssistantPnlRow {
  readonly key: string;
  readonly label: string;
  readonly symbol: string | null;
  readonly network: NetworkKey | null;
  readonly protocol: ProtocolId | null;
  /** Position kind ("staking", "supply", ...) for `by: "position"`; null for assets. */
  readonly kind: string | null;
  /** Realized in the window plus unrealized on what is still held; null when either part is unknown. */
  readonly change: AssistantUsdValue;
  readonly realizedUsd: number | null;
  readonly unrealizedUsd: number | null;
  /** Unrealized against the open lots' cost, when nothing was realized; null otherwise. */
  readonly pct: number | null;
  readonly earned: AssistantUsdValue | null;
}

export interface AssistantPnl {
  readonly rows: readonly AssistantPnlRow[];
  /** Realized plus unrealized over the window (FIFO), or null when unknown (see `reason`). */
  readonly total: AssistantUsdValue;
  readonly realizedUsd: number | null;
  readonly unrealizedUsd: number | null;
  /** The value change of a tracked set over the same span, from its readings (deposits and withdrawals count too). */
  readonly valueChange: AssistantUsdValue | null;
  /** The span the numbers cover ("the last 30 days", "all time"): the data API's nearest period at or above the window asked. */
  readonly covered: string | null;
  /** False when `covered` is wider than the window asked, or the window ended in the past. */
  readonly exact: boolean;
  readonly complete: boolean;
  readonly unread: readonly DataTxCoverage[];
  /** True: an estimate from readings and prices, never tax-grade. */
  readonly estimate: true;
  readonly reason?: string;
  readonly asOf: string;
}

export interface AssistantSnapshots {
  readonly points: readonly { readonly at: string; readonly usd: number }[];
  readonly source: "snapshot";
  readonly reason?: string;
  readonly asOf: string;
}

export interface AssistantDataPort {
  summary(set: DataWalletSet): Promise<AssistantSummary>;
  transactions(set: DataWalletSet, query: TransactionQuery): Promise<AssistantTransactions>;
  pnl(set: DataWalletSet, query: PnlQuery): Promise<AssistantPnl>;
  /** Positions, debts and health; with `extras`, perps, open orders, automations and prediction positions too. */
  positions(set: DataWalletSet, options?: { readonly extras?: boolean }): Promise<DataPositions>;
  snapshots(set: DataWalletSet): Promise<AssistantSnapshots>;
  yields(filter: { readonly network?: NetworkKey; readonly asset?: string; readonly lane: DataWalletSet["lane"] }): Promise<DataYields>;
  prices(symbols: readonly string[], lane: DataWalletSet["lane"]): Promise<DataPrices>;
}

/* ------------------------------------------------------------ reader */

/** The data API reads behind the port (data/api.ts); the eval passes recorded fixtures instead. */
export interface AssistantDataReader {
  portfolio(set: DataWalletSet): Promise<DataPortfolio>;
  positions(scope: DataScope, options: { readonly extras: boolean }): Promise<DataPositions>;
  transactions(scope: DataScope, query: DataTxQuery): Promise<DataTransactionPage>;
  pnl(scope: DataScope, query: { readonly period: DataPnlPeriod }): Promise<DataPnl>;
  snapshots(scope: DataScope, query: { readonly range: DataSnapshotRange }): Promise<DataSnapshotSeries>;
  yields(filter: { readonly network?: NetworkKey; readonly asset?: string; readonly lane: DataWalletSet["lane"] }): Promise<DataYields>;
  prices(symbols: readonly string[], lane: DataWalletSet["lane"]): Promise<DataPrices>;
}

export const dataApiReader: AssistantDataReader = {
  portfolio: (set) => readDataPortfolio(set),
  positions: (scope, options) => readPositions(scope, options),
  transactions: (scope, query) => readTransactions(scope, query),
  pnl: (scope, query) => readPnl(scope, query),
  snapshots: (scope, query) => readSnapshots(scope, query),
  yields: (filter) => readDataYields(filter),
  prices: (symbols, lane) => readDataPrices(symbols, { lane }),
};

/** Whose data the port reads: the scope, and whether its history may be read (a desk session needs tracking on). */
export interface HistoryAccess {
  readonly scope: DataScope;
  readonly history: "open" | "tracking-off";
}

/** How far one answer reads back: pages of the data API's largest page. */
export const HISTORY_READ = Object.freeze({ pages: 4, pageSize: 100 });

/** The desk step that turns tracking on, said wherever history is needed. */
export const TRACKING_OFF =
  "Tracking is off for this wallet, so its transaction history and results are not read. Turn it on in the desk: Portfolio, then History, then \"Turn on tracking\" (one wallet sign-in, no funds move).";
const POSITION_EARNINGS = "Rewards and interest earned per position are not read yet: positions show their current APY, and results are computed by asset from the transaction history.";

/* ------------------------------------------------------------ mapping */

const KIND: Readonly<Record<DataTxKind, AssistantTxKind>> = {
  send: "transfer", receive: "transfer", swap: "swap", "bridge-out": "bridge", "bridge-in": "bridge", deposit: "deposit", withdraw: "withdraw",
  stake: "stake", unstake: "unstake", borrow: "borrow", repay: "repay", approve: "approve", perp: "perp", order: "order", prediction: "prediction",
  "contract-call": "other", failed: "failed", unknown: "other",
};

function kindOf(tx: DataTransaction): AssistantTxKind {
  const kind = KIND[tx.kind];
  return kind === "other" && tx.method !== null && /^claim/iu.test(tx.method) ? "claim" : kind;
}

/** Providers that never report fees (Alchemy transfers): a missing fee there is unknown, not someone else's. */
function feeOf(tx: DataTransaction, provider: DataTxCoverage["provider"] | undefined): AssistantUsdValue | null {
  if (tx.fee) return { usd: tx.fee.usd, source: "chain", asOf: tx.time, ...(tx.fee.reason ? { reason: tx.fee.reason } : {}) };
  if (provider === "alchemy" && tx.kind !== "receive" && tx.kind !== "bridge-in") {
    return { usd: null, source: "chain", asOf: tx.time, reason: "Alchemy does not report fees; ETHERSCAN_API_KEY on the API reads them." };
  }
  return null;
}

export function assistantTransaction(tx: DataTransaction, provider?: DataTxCoverage["provider"]): AssistantTransaction {
  const leg = (direction: "in" | "out") => tx.legs.filter((entry) => entry.direction === direction).map((entry) => ({ symbol: entry.asset.symbol, amount: entry.amount, usd: entry.usdAtTime }));
  return {
    id: tx.id,
    at: tx.time,
    kind: kindOf(tx),
    detail: tx.kind,
    account: tx.account,
    network: tx.network,
    destination: tx.kind === "bridge-in" ? tx.network : null,
    protocol: tx.protocol?.id ?? null,
    protocolLabel: tx.protocol?.label ?? null,
    status: tx.status === "failed" ? "failed" : "confirmed",
    sent: leg("out"),
    received: leg("in"),
    fee: feeOf(tx, provider),
    hash: tx.hash,
    kletiaIntentId: tx.kletiaIntentId,
    source: "chain",
  };
}

const DAY_MS = 86_400_000;
const PERIODS: readonly { readonly period: DataPnlPeriod; readonly ms: number | null; readonly label: string; readonly range: DataSnapshotRange }[] = [
  { period: "24h", ms: DAY_MS, label: "the last 24 hours", range: "24h" },
  { period: "7d", ms: 7 * DAY_MS, label: "the last 7 days", range: "7d" },
  { period: "30d", ms: 30 * DAY_MS, label: "the last 30 days", range: "30d" },
  { period: "all", ms: null, label: "all time", range: "all" },
];

/** The data API's smallest period that covers a window from `from` to now, and whether it is that window exactly. */
export function periodFor(from: string | null | undefined, to: string | undefined, now: number): { readonly period: DataPnlPeriod; readonly label: string; readonly range: DataSnapshotRange; readonly exact: boolean } {
  const start = from ? Date.parse(from) : null;
  const span = start === null ? null : now - start;
  const entry = PERIODS.find((candidate) => span !== null && candidate.ms !== null && candidate.ms >= span - 60_000) ?? PERIODS[PERIODS.length - 1]!;
  const endsNow = !to || Date.parse(to) >= now - 60_000;
  const exact = endsNow && (entry.ms === null ? start === null : span !== null && Math.abs(entry.ms - span) <= 60_000);
  return { period: entry.period, label: entry.label, range: entry.range, exact };
}

const sum = (values: readonly number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

function networkOfKey(key: string): NetworkKey | null {
  const prefix = key.includes(":") ? key.slice(0, key.indexOf(":")) : null;
  return prefix && prefix in CHAINS ? (prefix as NetworkKey) : null;
}

/* ------------------------------------------------------------ adapter */

/**
 * The data API behind the port, for one caller. `now` is the clock windows
 * were resolved against (the eval pins it).
 */
export function dataApiPort(access: HistoryAccess, reader: AssistantDataReader = dataApiReader, now: () => number = Date.now): AssistantDataPort {
  const { scope } = access;
  const off = access.history === "tracking-off";
  return {
    summary: (set) => reader.portfolio(set),
    positions: (_set, options) => reader.positions(scope, { extras: options?.extras === true }),
    async transactions(_set, query) {
      const asOf = new Date(now()).toISOString();
      if (off) return { transactions: [], coverage: "none", complete: false, unread: [], truncated: false, reason: TRACKING_OFF, asOf };
      const rows: DataTransaction[] = [];
      let coverage: readonly DataTxCoverage[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < HISTORY_READ.pages; page += 1) {
        const read: DataTransactionPage = await reader.transactions(scope, { limit: HISTORY_READ.pageSize, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(cursor ? { cursor } : {}) });
        rows.push(...read.transactions);
        coverage = read.coverage;
        cursor = read.cursor;
        if (!cursor) break;
      }
      const providers = new Map(coverage.map((entry) => [entry.account, entry.provider]));
      const unread = coverage.filter((entry) => entry.status !== "ok");
      const transactions = rows
        .filter((tx) => (!query.from || tx.time >= query.from) && (!query.to || tx.time < query.to))
        .map((tx) => assistantTransaction(tx, providers.get(tx.account)))
        .sort((a, b) => b.at.localeCompare(a.at));
      const nothing = coverage.length > 0 && coverage.every((entry) => entry.provider === null || entry.status === "failed");
      return {
        transactions,
        coverage: nothing && transactions.length === 0 ? "none" : "chain",
        complete: unread.length === 0 && cursor === null,
        unread,
        truncated: cursor !== null,
        ...(nothing && transactions.length === 0 ? { reason: "No account of these wallets could have its history read." } : {}),
        asOf,
      };
    },
    async pnl(_set, query) {
      const asOf = new Date(now()).toISOString();
      const blank = (reason: string, unread: readonly DataTxCoverage[] = []): AssistantPnl => ({
        rows: [], total: { usd: null, source: "snapshot", asOf: null, reason }, realizedUsd: null, unrealizedUsd: null, valueChange: null, covered: null, exact: false, complete: false, unread, estimate: true, reason, asOf,
      });
      if (off) return blank(TRACKING_OFF);
      const span = periodFor(query.from, query.to, now());
      const [read, series] = await Promise.all([reader.pnl(scope, { period: span.period }), reader.snapshots(scope, { range: span.range }).catch(() => null)]);
      const unread = read.coverage.filter((entry) => entry.status !== "ok");
      const valueChange = series?.change ? { usd: series.change.usd, source: "snapshot" as const, asOf: series.asOf } : null;
      if (query.by === "position") return { ...blank(POSITION_EARNINGS, unread), covered: span.label, exact: span.exact, valueChange };
      const rows: AssistantPnlRow[] = read.assets.map((asset) => {
        const change = asset.realizedUsd !== null && asset.unrealizedUsd !== null ? Math.round((asset.realizedUsd + asset.unrealizedUsd) * 100) / 100 : null;
        const pct = asset.realizedUsd === 0 && asset.unrealizedUsd !== null && asset.costBasisUsd ? asset.unrealizedUsd / asset.costBasisUsd : null;
        return {
          key: asset.key,
          label: asset.symbol,
          symbol: asset.symbol,
          network: networkOfKey(asset.key),
          protocol: null,
          kind: null,
          change: { usd: change, source: "snapshot", asOf: read.asOf, ...(change === null ? { reason: asset.reason ?? "A cost or price of this asset is unknown." } : {}) },
          realizedUsd: asset.realizedUsd,
          unrealizedUsd: asset.unrealizedUsd,
          pct,
          earned: null,
        };
      });
      const empty = read.assets.length === 0;
      const reason = empty ? (unread.length > 0 ? "No history could be read to compute results from." : "No buys, sells or transfers of priced assets were found in the history read.") : undefined;
      return {
        rows,
        total: empty && unread.length > 0
          ? { usd: null, source: "snapshot", asOf: read.asOf, reason: reason as string }
          : { usd: sum([read.totals.realizedUsd, read.totals.unrealizedUsd]), source: "snapshot", asOf: read.asOf },
        realizedUsd: read.totals.realizedUsd,
        unrealizedUsd: read.totals.unrealizedUsd,
        valueChange,
        covered: span.label,
        exact: span.exact,
        complete: read.totals.complete,
        unread,
        estimate: true,
        ...(reason ? { reason } : {}),
        asOf: read.asOf,
      };
    },
    async snapshots() {
      const asOf = new Date(now()).toISOString();
      if (off) return { points: [], source: "snapshot", reason: TRACKING_OFF, asOf };
      const series = await reader.snapshots(scope, { range: "30d" });
      return { points: series.points.map((point) => ({ at: point.at, usd: point.usd })), source: "snapshot", ...(series.reason ? { reason: series.reason } : {}), asOf: series.asOf };
    },
    yields: (filter) => reader.yields(filter),
    prices: (symbols, lane) => reader.prices(symbols, lane),
  };
}

/** Coverage entries as gap lines, accounts named by `labelOf` and the variables a deployment would set. */
export function coverageGaps(unread: readonly DataTxCoverage[], labelOf: (account: string) => string): string[] {
  const lines = new Map<string, string[]>();
  for (const entry of unread) {
    const what = entry.status === "not-configured"
      ? `history is not read: the API needs ${(entry.env ?? []).join(" or ") || "a history provider"} set`
      : entry.status === "unsupported" ? "no history provider Kletia uses covers this network"
        : entry.status === "partial" ? `only part of the history was read${entry.reason ? ` (${entry.reason.replace(/\.$/u, "")})` : ""}`
          : "the history could not be read right now";
    const list = lines.get(what) ?? [];
    list.push(labelOf(entry.account));
    lines.set(what, list);
  }
  return [...lines.entries()].map(([what, accounts]) => `${accounts.length > 3 ? `${accounts.slice(0, 3).join(", ")} and ${accounts.length - 3} more` : accounts.join(", ")}: ${what}.`);
}
