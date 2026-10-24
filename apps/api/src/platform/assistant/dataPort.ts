/**
 * The assistant's narrow view of the dashboard data (docs/platform/assistant.md).
 * The answering engine reads only through this port, so the data service
 * behind it can grow (on-chain transaction history, realised PnL, value
 * snapshots) without the engine changing. Shapes follow packages/core/src/data.ts:
 * every value carries `source` and `asOf`, unknown values are null with a
 * `reason`, never zero.
 *
 * `dataServicePort` adapts today's data service (data/: portfolio, positions,
 * Kletia history, yields, prices). What it cannot read yet it returns as
 * unknown with the reason, never as an empty "nothing happened".
 */
import {
  parseAccountId,
  type AccountId,
  type AssistantTxKind,
  type DataPortfolio,
  type DataPositions,
  type DataPrices,
  type DataSource,
  type DataUsdValue,
  type DataWalletSet,
  type DataYields,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { readDataPortfolio, readDataPositions, readDataPrices, readDataYields } from "../data/index.js";
import { listIntents } from "../engine/service.js";

/** Holdings, positions, totals, allocation, health and the value estimates of a wallet set. */
export type AssistantSummary = Pick<DataPortfolio, "accounts" | "totals" | "change24h" | "pnl" | "allocation" | "holdings" | "positions" | "health" | "failures" | "asOf">;

/** A USD value with its provenance, as DataUsdValue, where a value read straight from the chain says so. */
export interface AssistantUsdValue extends Omit<DataUsdValue, "source"> {
  readonly source: DataSource | "chain";
}

export interface AssistantTxLeg {
  readonly symbol: string;
  /** Formatted decimal amount. */
  readonly amount: string;
  readonly usd: number | null;
}

/** One transaction of the wallet set. */
export interface AssistantTransaction {
  readonly id: string;
  /** ISO time it was confirmed (or created, while pending). */
  readonly at: string;
  readonly kind: AssistantTxKind;
  readonly account: AccountId;
  readonly network: NetworkKey;
  /** Where a bridge delivers; null otherwise. */
  readonly destination: NetworkKey | null;
  readonly protocol: ProtocolId | null;
  readonly status: "confirmed" | "failed" | "pending";
  readonly sent: readonly AssistantTxLeg[];
  readonly received: readonly AssistantTxLeg[];
  /** Network and venue fees paid, in USD. */
  readonly fee: AssistantUsdValue;
  /** Transaction hash or signature; null when none is known. */
  readonly hash: string | null;
  readonly source: DataSource | "chain";
}

export interface TransactionQuery {
  readonly from?: string | null;
  readonly to?: string;
  readonly limit?: number;
}

export interface AssistantTransactions {
  readonly transactions: readonly AssistantTransaction[];
  /** "chain": every transaction of the wallets; "kletia": only those Kletia planned for this caller. */
  readonly coverage: "chain" | "kletia" | "none";
  /** False when the history may miss transactions in the window (see `reason`). */
  readonly complete: boolean;
  readonly reason?: string;
  readonly asOf: string;
}

export interface PnlQuery {
  readonly from?: string | null;
  readonly to?: string;
  readonly by: "asset" | "position";
}

/** The change of one asset's or position's value over a window; `earned` is yield or rewards received. */
export interface AssistantPnlRow {
  readonly key: string;
  readonly label: string;
  readonly symbol: string | null;
  readonly network: NetworkKey | null;
  readonly protocol: ProtocolId | null;
  /** Position kind ("staking", "supply", ...) for `by: "position"`; null for assets. */
  readonly kind: string | null;
  readonly change: AssistantUsdValue;
  /** Fraction of the start value; null when unknown. */
  readonly pct: number | null;
  readonly earned: AssistantUsdValue | null;
}

export interface AssistantPnl {
  readonly rows: readonly AssistantPnlRow[];
  /** Net value change of the whole wallet set over the window. */
  readonly total: AssistantUsdValue;
  /** True: an estimate from readings and prices, never tax-grade realised PnL. */
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
  positions(set: DataWalletSet): Promise<DataPositions>;
  snapshots(set: DataWalletSet): Promise<AssistantSnapshots>;
  yields(filter: { readonly network?: NetworkKey; readonly asset?: string; readonly lane: DataWalletSet["lane"] }): Promise<DataYields>;
  prices(symbols: readonly string[], lane: DataWalletSet["lane"]): Promise<DataPrices>;
}

/* ------------------------------------------------------------ adapter */

const HISTORY_GAP = "On-chain transaction history is not connected yet: only transactions Kletia planned for this API key are known.";
const NO_HISTORY = "On-chain transaction history is not connected yet, and a wallet session has no Kletia activity to list.";
const PNL_GAP = "Per-asset and per-position results need transaction history and past prices, which are not connected yet.";

const STEP_KIND: Readonly<Partial<Record<IntentStep["kind"], AssistantTxKind>>> = {
  swap: "swap", transfer: "transfer", bridge: "bridge", stake: "stake", unstake: "unstake", deposit: "deposit", withdraw: "withdraw",
};
const DONE = new Set(["confirmed", "settled"]);

function inSet(set: DataWalletSet, account: AccountId): boolean {
  const parsed = parseAccountId(account);
  return parsed !== null && (set.solana.includes(parsed.address) || set.evm.some((evm) => evm.toLowerCase() === parsed.address.toLowerCase()));
}

function leg(amount: IntentStep["input"]): AssistantTxLeg[] {
  return amount ? [{ symbol: amount.symbol, amount: amount.formatted, usd: amount.usd ?? null }] : [];
}

/** The executed steps of a Kletia intent as transactions (steps with a reference only). */
export function intentTransactions(intent: IntentGraph, set: DataWalletSet): AssistantTransaction[] {
  return intent.steps
    .filter((step) => (step.references?.length ?? 0) > 0 && inSet(set, step.account))
    .map((step) => ({
      id: `${intent.id}:${step.id}`,
      at: intent.updatedAt,
      kind: STEP_KIND[step.kind] ?? "other",
      account: step.account,
      network: step.network,
      destination: step.settlement?.destinationNetwork ?? null,
      protocol: step.protocol,
      status: DONE.has(step.status) ? "confirmed" : step.status === "failed" ? "failed" : "pending",
      sent: leg(step.input),
      received: leg(step.actualOutput ?? step.expectedOutput),
      fee: { usd: step.feesUsd ?? null, source: "kletia", asOf: intent.updatedAt, ...(step.feesUsd === undefined ? { reason: "No fee estimate was recorded for this step." } : {}) },
      hash: step.references?.at(-1) ?? null,
      source: "kletia",
    }));
}

/**
 * Today's data service behind the port. `keyId` is the calling API key (its
 * Kletia intents are the only transaction history known today); a desk
 * wallet session has none.
 */
export function dataServicePort(keyId: string | null): AssistantDataPort {
  return {
    summary: (set) => readDataPortfolio(set),
    positions: (set) => readDataPositions(set),
    async transactions(set, query) {
      const asOf = new Date().toISOString();
      if (!keyId) return { transactions: [], coverage: "none", complete: false, reason: NO_HISTORY, asOf };
      const intents = await listIntents(keyId, 100);
      const transactions = intents
        .flatMap((intent) => intentTransactions(intent, set))
        .filter((tx) => (!query.from || tx.at >= query.from) && (!query.to || tx.at < query.to))
        .sort((a, b) => b.at.localeCompare(a.at));
      return { transactions: transactions.slice(0, query.limit ?? 200), coverage: "kletia", complete: false, reason: HISTORY_GAP, asOf };
    },
    async pnl(set) {
      const portfolio = await readDataPortfolio(set);
      return {
        rows: [],
        total: { usd: portfolio.pnl.usd, source: "snapshot", asOf: portfolio.pnl.since, ...(portfolio.pnl.reason ? { reason: portfolio.pnl.reason } : {}) },
        estimate: true,
        reason: PNL_GAP,
        asOf: portfolio.asOf,
      };
    },
    async snapshots(set) {
      const portfolio = await readDataPortfolio(set);
      const points = portfolio.pnl.since && portfolio.pnl.usd !== null && portfolio.totals.net.usd !== null
        ? [{ at: portfolio.pnl.since, usd: portfolio.totals.net.usd - portfolio.pnl.usd }, { at: portfolio.asOf, usd: portfolio.totals.net.usd }]
        : [];
      return { points, source: "snapshot", ...(points.length === 0 ? { reason: "No earlier reading of these wallets is kept yet." } : {}), asOf: portfolio.asOf };
    },
    yields: (filter) => readDataYields(filter),
    prices: (symbols, lane) => readDataPrices(symbols, { lane }),
  };
}
