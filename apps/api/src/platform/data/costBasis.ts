/**
 * FIFO cost basis over a wallet set's read history (an estimate, labelled
 * so everywhere):
 *
 * - acquisitions: tokens received from someone outside the set, and the
 *   incoming side of swaps and order fills, at their USD value at the time;
 * - disposals: tokens sent to someone outside the set, the outgoing side of
 *   swaps and order fills, and the fees the wallets paid, at their USD value
 *   at the time; each takes the oldest open lots first;
 * - moves that keep the asset (transfers between the set's own wallets,
 *   bridges, deposits, withdrawals, staking, loans, perps and prediction
 *   collateral) neither acquire nor dispose: their lots stay open.
 *
 * Assets are pooled across networks by their cross-network group (USDC on
 * Base and on Solana are one pool); unlisted tokens by network and address.
 * A lot or disposal without a price at the time makes its cost unknown
 * (null), never 0; a disposal larger than the open lots (bought before the
 * read history) makes the realized result unknown.
 */
import { findAssetByAddress, getAsset, type DataPnlAsset, type DataTransaction, type DataTxKind, type DataTxLeg } from "@kletia/core";

interface Lot {
  quantity: number;
  /** USD per unit; null when unknown. */
  unitCost: number | null;
}

interface Pool {
  readonly key: string;
  readonly symbol: string;
  readonly lots: Lot[];
  realized: number;
  realizedKnown: boolean;
  reason: string | null;
}

const TRADES: ReadonlySet<DataTxKind> = new Set(["swap", "order"]);
const EPSILON = 1e-12;

/** The pool an asset belongs to: listed assets by cross-network group or symbol, others by network and address. */
export function costBasisKey(tx: Pick<DataTransaction, "network">, asset: DataTxLeg["asset"]): { key: string; symbol: string } {
  const listed = asset.id ? getAsset(asset.id) : asset.address ? findAssetByAddress(tx.network, asset.address) : null;
  if (listed) return { key: (listed.group ?? listed.symbol).toUpperCase(), symbol: listed.group ?? listed.symbol };
  if (asset.address === null) return { key: asset.symbol.toUpperCase(), symbol: asset.symbol };
  return { key: `${tx.network}:${asset.address}`, symbol: asset.symbol };
}

function poolOf(pools: Map<string, Pool>, tx: DataTransaction, asset: DataTxLeg["asset"]): Pool {
  const { key, symbol } = costBasisKey(tx, asset);
  let pool = pools.get(key);
  if (!pool) {
    pool = { key, symbol, lots: [], realized: 0, realizedKnown: true, reason: null };
    pools.set(key, pool);
  }
  return pool;
}

function acquire(pool: Pool, quantity: number, usd: number | null): void {
  if (!(quantity > 0)) return;
  pool.lots.push({ quantity, unitCost: usd === null ? null : usd / quantity });
}

function dispose(pool: Pool, quantity: number, proceeds: number | null, counts: boolean): void {
  let left = quantity;
  let cost: number | null = 0;
  while (left > EPSILON && pool.lots.length > 0) {
    const lot = pool.lots[0]!;
    const take = Math.min(lot.quantity, left);
    cost = cost === null || lot.unitCost === null ? null : cost + take * lot.unitCost;
    lot.quantity -= take;
    left -= take;
    if (lot.quantity <= EPSILON) pool.lots.shift();
  }
  if (!counts) return;
  if (left > EPSILON * Math.max(1, quantity)) {
    pool.realizedKnown = false;
    pool.reason = "More was disposed of than the read history acquired (bought before it): the realized result is unknown.";
  } else if (cost === null || proceeds === null) {
    pool.realizedKnown = false;
    pool.reason = "A price at the time is missing for this asset: the realized result is unknown.";
  } else {
    pool.realized += proceeds - cost;
  }
}

const amountOf = (leg: Pick<DataTxLeg, "amount">) => (leg.amount === null ? null : Number(leg.amount));

/**
 * FIFO pools of the transactions (any order; sorted oldest first here).
 * `own` tells the set's own addresses; disposals before `since` consume lots
 * but are not counted as realized in the period.
 */
export function fifoCostBasis(transactions: readonly DataTransaction[], own: (address: string) => boolean, since: number | null): Map<string, Pool> {
  const pools = new Map<string, Pool>();
  const ordered = [...transactions].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id));
  for (const tx of ordered) {
    if (tx.status !== "success") continue;
    const counts = since === null || Date.parse(tx.time) >= since;
    const external = tx.counterparty === null || !own(tx.counterparty);
    const legs = TRADES.has(tx.kind) || ((tx.kind === "send" || tx.kind === "receive") && external) ? tx.legs : [];
    for (const leg of legs) {
      const quantity = amountOf(leg);
      const pool = poolOf(pools, tx, leg.asset);
      if (quantity === null) {
        pool.realizedKnown = false;
        pool.reason = "A transfer amount is unknown for this asset.";
        continue;
      }
      if (leg.direction === "in") acquire(pool, quantity, leg.usdAtTime);
      else dispose(pool, quantity, leg.usdAtTime, counts);
    }
    if (tx.fee) {
      const quantity = Number(tx.fee.amount);
      if (quantity > 0) dispose(poolOf(pools, tx, tx.fee.asset), quantity, tx.fee.usd, counts);
    }
  }
  return pools;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** The pools as rows, with the open lots valued at `priceNow` (USD per unit, null when unknown). */
export function pnlRows(pools: ReadonlyMap<string, Pool>, priceNow: (key: string) => number | null): DataPnlAsset[] {
  return [...pools.values()]
    .map((pool): DataPnlAsset => {
      const open = pool.lots.reduce((sum, lot) => sum + lot.quantity, 0);
      const costKnown = pool.lots.every((lot) => lot.unitCost !== null);
      const cost = costKnown ? pool.lots.reduce((sum, lot) => sum + lot.quantity * (lot.unitCost ?? 0), 0) : null;
      const price = open > EPSILON ? priceNow(pool.key) : null;
      const current = open > EPSILON ? (price === null ? null : open * price) : 0;
      const unrealized = current === null || cost === null ? null : current - cost;
      const reason = pool.reason ?? (cost === null ? "An open lot has no price at the time it was acquired." : current === null ? "No current price for this asset." : undefined);
      return {
        key: pool.key,
        symbol: pool.symbol,
        openQuantity: Number(open.toPrecision(12)),
        costBasisUsd: cost === null ? null : cents(cost),
        realizedUsd: pool.realizedKnown ? cents(pool.realized) : null,
        unrealizedUsd: unrealized === null ? null : cents(unrealized),
        currentUsd: current === null ? null : cents(current),
        ...(reason ? { reason } : {}),
      };
    })
    .sort((a, b) => Math.abs(b.currentUsd ?? 0) - Math.abs(a.currentUsd ?? 0) || a.key.localeCompare(b.key));
}
