/**
 * Static cost model of the capability graph's edges: expected seconds,
 * venue fee in basis points of the value moved, a flat venue fee in USD
 * and the smallest sensible amount, per protocol, with a default per step
 * kind. Network gas is not here: an edge carries its EVM operations
 * (`journey/fees.evmOperationsFor`) and the search prices them with live
 * gas facts (`estimateStepFee`).
 *
 * These numbers only order candidates. The planner's auction prices the
 * chosen route for real (quotes, simulations), so a stale entry can change
 * which route is shown first, never what is signed. Keyed by `ProtocolId`:
 * the protocols task extends the table without touching the search; an
 * unlisted protocol takes its kind's default.
 */
import { CHAINS, type NetworkKey, type ProtocolId } from "@kletia/core";

/** The step kinds the capability graph has edges for (integrator call / action steps are not routes). */
export const EDGE_KINDS = Object.freeze(["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] as const);
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface EdgeCost {
  /** Expected seconds from signing to the output being spendable (destination fill for bridges). */
  readonly estSeconds: number;
  /** Venue fee as basis points of the value moved (DEX pool fee, bridge relayer fee). */
  readonly feeBps: number;
  /** Flat venue fee in USD on top of `feeBps` (deBridge's fixed fee); 0 when none. */
  readonly fixedUsd: number;
  /** Below this USD value the venue is unlikely to fill or the fees dominate (advisory). */
  readonly minimumUsd: number;
}

type CostEntry = Partial<EdgeCost>;

/** Defaults per step kind (venue time excluding the network's own confirmation). */
const KIND_DEFAULTS: Readonly<Record<EdgeKind, EdgeCost>> = Object.freeze({
  swap: { estSeconds: 0, feeBps: 30, fixedUsd: 0, minimumUsd: 0 },
  bridge: { estSeconds: 60, feeBps: 20, fixedUsd: 0, minimumUsd: 5 },
  transfer: { estSeconds: 0, feeBps: 0, fixedUsd: 0, minimumUsd: 0 },
  stake: { estSeconds: 0, feeBps: 0, fixedUsd: 0, minimumUsd: 0 },
  deposit: { estSeconds: 0, feeBps: 0, fixedUsd: 0, minimumUsd: 0 },
  withdraw: { estSeconds: 0, feeBps: 0, fixedUsd: 0, minimumUsd: 0 },
});

/**
 * Per protocol and kind. Bridge figures are typical fills of each venue's
 * public quotes for a few hundred USD (relayer fee plus spread), rounded up.
 */
const PROTOCOL_COSTS: Readonly<Partial<Record<ProtocolId, Partial<Record<EdgeKind, CostEntry>>>>> = Object.freeze({
  // Bridges
  across: { bridge: { estSeconds: 10, feeBps: 6, minimumUsd: 2 } },
  relay: { bridge: { estSeconds: 15, feeBps: 10, minimumUsd: 1 }, swap: { estSeconds: 15, feeBps: 35 } },
  "cctp-v2": { bridge: { estSeconds: 30, feeBps: 2, minimumUsd: 1 } },
  lifi: { bridge: { estSeconds: 90, feeBps: 30, minimumUsd: 5 } },
  "debridge-dln": { bridge: { estSeconds: 30, feeBps: 8, fixedUsd: 2, minimumUsd: 10 } },
  // DEXs and aggregators (pool fee tiers: the common 0.05-0.30% band)
  "uniswap-v3": { swap: { feeBps: 30 } },
  "pancakeswap-v3": { swap: { feeBps: 30 } },
  camelot: { swap: { feeBps: 30 } },
  curve: { swap: { feeBps: 4 } },
  aerodrome: { swap: { feeBps: 30 } },
  velodrome: { swap: { feeBps: 30 } },
  jupiter: { swap: { feeBps: 20 }, stake: { feeBps: 10 } },
  raydium: { swap: { feeBps: 25 } },
  orca: { swap: { feeBps: 30 } },
  meteora: { swap: { feeBps: 30 } },
  // Liquid staking: deposit fees of the pools (mint at the pool rate)
  jito: { stake: { feeBps: 10 } },
  marinade: { stake: { feeBps: 0 } },
  sanctum: { stake: { feeBps: 10 } },
  "solana-stake": { stake: { estSeconds: 2 * 24 * 3600 } },
  lido: { stake: { feeBps: 0 } },
  "rocket-pool": { stake: { feeBps: 5 } },
  etherfi: { stake: { feeBps: 0 } },
});

/** Seconds until a transaction on `network` is confirmed enough to spend its output. */
export function confirmationSeconds(network: NetworkKey): number {
  const chain = CHAINS[network];
  if (chain.vm === "svm") return 2;
  return network === "ethereum" ? 15 : 4;
}

/** The cost of one edge of `kind` executed by `protocol` from `network`. */
export function edgeCost(kind: EdgeKind, protocol: ProtocolId, network: NetworkKey): EdgeCost {
  const base = KIND_DEFAULTS[kind];
  const entry = PROTOCOL_COSTS[protocol]?.[kind] ?? {};
  const merged: EdgeCost = { ...base, ...entry };
  return Object.freeze({ ...merged, estSeconds: merged.estSeconds + confirmationSeconds(network) });
}

/** The venue fee of an edge on `valueUsd` moved (bps share plus the flat part), in USD. */
export function venueFeeUsd(cost: Pick<EdgeCost, "feeBps" | "fixedUsd">, valueUsd: number): number {
  return (Math.max(0, valueUsd) * cost.feeBps) / 10_000 + cost.fixedUsd;
}
