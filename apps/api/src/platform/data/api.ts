/**
 * The data service as typed functions, for the HTTP routes and for other
 * packages (an AI portfolio assistant imports these from
 * `apps/api/src/platform/data/index.js`). Every function takes a
 * `DataScope`: whose wallets, who reads (which Kletia intents rows may link
 * to, whose automations and agent spend are listed) and the tracked set, if
 * any. Build one with `walletScope` (addresses given: public on-chain data)
 * or `sessionScope` (a desk wallet session: its tracked set only).
 *
 *   summary(scope)                     -> DataSummary
 *   transactions(scope, query)         -> DataTransactionPage
 *   transaction(scope, id)             -> DataTransaction
 *   pnl(scope, { period })             -> DataPnl
 *   positions(scope, { extras })       -> DataPositions (with extras)
 *   snapshots(scope, { range })        -> DataSnapshotSeries
 *
 * All reads are read-only and cached as their endpoints document.
 */
import type {
  AutomationOwner,
  DataPnl,
  DataPnlPeriod,
  DataPositions,
  DataSnapshotRange,
  DataSnapshotSeries,
  DataSummary,
  DataTransaction,
  DataTransactionPage,
  DataTxQuery,
  DataWalletSet,
} from "@kletia/core";
import type { AuthContext } from "../http/context.js";
import { readExtras } from "./extras.js";
import { pnlFromHistory, readPnl, readRecentHistory } from "./pnl.js";
import { readDataPortfolio, readDataPositions } from "./service.js";
import { buildSummary } from "./summary.js";
import { snapshotSeries, trackedWalletSet, trackingOf } from "./tracking.js";
import { dataTrackingStore, type TrackingRecord } from "./trackingStore.js";
import { readTransaction, readTransactionPage, type DataViewer } from "./transactions.js";
import { parseWalletSet } from "./wallets.js";

export interface DataScope {
  readonly wallets: DataWalletSet;
  readonly viewer: DataViewer;
  /** The tracked set the wallets are (snapshots, transaction cache), or null. */
  readonly tracking: TrackingRecord | null;
  /** Owner of automations to list; null for public reads. */
  readonly automationOwner: AutomationOwner | null;
  /** The API key's auth, for its agent keys' spend; null otherwise. */
  readonly keyAuth: AuthContext | null;
}

/** A scope over addresses the caller names (`?evm=&solana=&lane=`); an API key links only its own intents. */
export function walletScope(query: { readonly evm?: string; readonly solana?: string; readonly lane?: string }, auth: AuthContext | null): DataScope {
  const keyId = auth?.keyId;
  return {
    wallets: parseWalletSet(query),
    viewer: keyId ? { kind: "key", keyId } : { kind: "public" },
    tracking: null,
    automationOwner: keyId ? { kind: "key", keyId, projectId: auth?.projectId ?? null } : null,
    keyAuth: keyId ? auth : null,
  };
}

/** The tracked set of a signed-in desk wallet, or null when it is not tracked. */
export async function sessionScope(wallet: { readonly walletKind: "evm" | "solana"; readonly address: string }): Promise<DataScope | null> {
  const tracking = await trackingOf(wallet, dataTrackingStore());
  if (!tracking) return null;
  return {
    wallets: trackedWalletSet(tracking),
    viewer: { kind: "wallet" },
    tracking,
    automationOwner: { kind: "wallet", walletKind: wallet.walletKind, address: wallet.address },
    keyAuth: null,
  };
}

export async function transactions(scope: DataScope, query: DataTxQuery = {}): Promise<DataTransactionPage> {
  const page = await readTransactionPage(scope.wallets, query, scope.viewer);
  if (scope.tracking) await dataTrackingStore().cacheTransactions(scope.tracking.id, page.transactions).catch(() => undefined);
  return page;
}

export function transaction(scope: DataScope, id: string): Promise<DataTransaction> {
  return readTransaction(scope.wallets, id, scope.viewer);
}

export function pnl(scope: DataScope, query: { readonly period?: DataPnlPeriod } = {}): Promise<DataPnl> {
  return readPnl(scope.wallets, scope.viewer, query.period ?? "all", scope.tracking);
}

export async function positions(scope: DataScope, options: { readonly extras?: boolean } = {}): Promise<DataPositions> {
  const [base, extras] = await Promise.all([
    readDataPositions(scope.wallets),
    options.extras ? readExtras(scope.wallets, { automationOwner: scope.automationOwner, keyAuth: scope.keyAuth }) : Promise.resolve(undefined),
  ]);
  return extras ? { ...base, extras } : base;
}

export function snapshots(scope: DataScope, query: { readonly range?: DataSnapshotRange } = {}): Promise<DataSnapshotSeries> {
  return snapshotSeries(scope.tracking, query.range ?? "30d");
}

/** Portfolio, perps, the newest history (one page round) and its PnL, folded into one object. */
export async function summary(scope: DataScope): Promise<DataSummary> {
  const [portfolio, extras, history] = await Promise.all([
    readDataPortfolio(scope.wallets),
    readExtras(scope.wallets, { automationOwner: scope.automationOwner, keyAuth: scope.keyAuth }).catch(() => null),
    readRecentHistory(scope.wallets, scope.viewer, scope.tracking, 1).catch(() => null),
  ]);
  const estimate = history ? await pnlFromHistory(scope.wallets, history, portfolio, "all").catch(() => null) : null;
  return buildSummary({ portfolio, extras, history, pnl: estimate });
}
