/**
 * Realized and unrealized PnL estimates of a wallet set by asset
 * (`GET /v1/data/pnl`): FIFO cost basis (costBasis.ts) over the read
 * history, valued now with the portfolio's prices. The history read is
 * capped (`PNL_LIMITS.pages` pages of the newest transactions; a tracked set
 * adds its cached transactions), so `totals.complete` is false whenever
 * older history or an account was left unread.
 */
import { getAsset, type DataPnl, type DataPnlPeriod, type DataPortfolio, type DataTransaction, type DataTxCoverage, type DataWalletSet } from "@kletia/core";
import { quoteAsset } from "../engine/preview/pricer.js";
import { costBasisKey, fifoCostBasis, pnlRows } from "./costBasis.js";
import { readDataPortfolio } from "./service.js";
import { dataTrackingStore, type TrackingRecord } from "./trackingStore.js";
import { readTransactionPage, TRANSACTION_LIMITS, type DataViewer } from "./transactions.js";
import { inWalletSet } from "./wallets.js";

export const PNL_LIMITS = Object.freeze({ pages: 3 });

const PERIOD_MS: Readonly<Record<DataPnlPeriod, number | null>> = Object.freeze({ "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null });

export interface HistoryRead {
  readonly transactions: readonly DataTransaction[];
  readonly coverage: readonly DataTxCoverage[];
  /** False when older history was left unread (the page cap) or an account failed. */
  readonly complete: boolean;
}

/** The newest history of the set (and a tracked set's cache), deduplicated. */
export async function readRecentHistory(set: DataWalletSet, viewer: DataViewer, tracking: TrackingRecord | null, pagesCap: number = PNL_LIMITS.pages): Promise<HistoryRead> {
  const seen = new Map<string, DataTransaction>();
  let cursor: string | undefined;
  let coverage: readonly DataTxCoverage[] = [];
  let complete = true;
  for (let page = 0; page < pagesCap; page += 1) {
    const result = await readTransactionPage(set, { limit: TRANSACTION_LIMITS.maxLimit, ...(cursor ? { cursor } : {}) }, viewer);
    for (const tx of result.transactions) seen.set(`${tx.account}|${tx.id}`, tx);
    coverage = result.coverage;
    if (!result.cursor) break;
    cursor = result.cursor;
    if (page === pagesCap - 1) complete = false;
  }
  if (tracking) {
    const store = dataTrackingStore();
    await store.cacheTransactions(tracking.id, [...seen.values()]).catch(() => undefined);
    for (const tx of await store.cachedTransactions(tracking.id, 5_000).catch(() => [] as DataTransaction[])) {
      if (!seen.has(`${tx.account}|${tx.id}`)) seen.set(`${tx.account}|${tx.id}`, tx);
    }
  }
  if (coverage.some((entry) => entry.status !== "ok")) complete = false;
  return { transactions: [...seen.values()], coverage, complete };
}

/** USD per unit now, by cost-basis key: the portfolio's holdings first, else a quote of an asset seen in the history. */
async function pricesNow(portfolio: Pick<DataPortfolio, "holdings"> | null, transactions: readonly DataTransaction[]): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  for (const holding of portfolio?.holdings ?? []) {
    const amount = Number(holding.formatted);
    if (holding.value.usd === null || !(amount > 0)) continue;
    const key = costBasisKey({ network: holding.network }, { symbol: holding.symbol, address: getAsset(holding.asset)?.address ?? null, decimals: null, id: holding.asset }).key;
    if (!prices.has(key)) prices.set(key, holding.value.usd / amount);
  }
  const missing = new Map<string, string>();
  for (const tx of transactions) {
    for (const asset of [...tx.legs.map((leg) => leg.asset), ...(tx.fee ? [tx.fee.asset] : [])]) {
      const key = costBasisKey(tx, asset).key;
      if (!prices.has(key) && asset.id && !missing.has(key)) missing.set(key, asset.id);
    }
  }
  await Promise.all([...missing.entries()].map(async ([key, id]) => {
    const quote = await quoteAsset(id as Parameters<typeof quoteAsset>[0]);
    prices.set(key, quote?.usd ?? null);
  }));
  return prices;
}

export async function readPnl(set: DataWalletSet, viewer: DataViewer, period: DataPnlPeriod, tracking: TrackingRecord | null, now = Date.now()): Promise<DataPnl> {
  const [history, portfolio] = await Promise.all([readRecentHistory(set, viewer, tracking), readDataPortfolio(set).catch(() => null)]);
  return pnlFromHistory(set, history, portfolio, period, now);
}

/** The PnL of a history already read, valued with the portfolio's prices (null portfolio: quotes only). */
export async function pnlFromHistory(set: Pick<DataWalletSet, "evm" | "solana">, history: HistoryRead, portfolio: Pick<DataPortfolio, "holdings"> | null, period: DataPnlPeriod, now = Date.now()): Promise<DataPnl> {
  const span = PERIOD_MS[period];
  const since = span === null ? null : now - span;
  const pools = fifoCostBasis(history.transactions, (address) => inWalletSet(set, address), since);
  const prices = await pricesNow(portfolio, history.transactions);
  const assets = pnlRows(pools, (key) => prices.get(key) ?? null);
  const known = (values: readonly (number | null)[]) => values.every((value) => value !== null);
  const sum = (values: readonly (number | null)[]) => Math.round(values.reduce<number>((total, value) => total + (value ?? 0), 0) * 100) / 100;
  return {
    period,
    since: since === null ? null : new Date(since).toISOString(),
    method: "fifo",
    estimate: true,
    assets,
    totals: {
      realizedUsd: sum(assets.map((asset) => asset.realizedUsd)),
      unrealizedUsd: sum(assets.map((asset) => asset.unrealizedUsd)),
      complete: history.complete && known(assets.map((asset) => asset.realizedUsd)) && known(assets.map((asset) => asset.unrealizedUsd)),
    },
    coverage: history.coverage,
    source: "fifo",
    asOf: new Date(now).toISOString(),
  };
}
