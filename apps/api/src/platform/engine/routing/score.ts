/**
 * One score for every route choice. For a candidate route r,
 * all values in USD at quote time:
 *
 *   value(r) = expectedEff(r) * priceOut * (1 - haircut(r))   what is expected to arrive
 *            - (1 - P_fill(r)) * nonFillCost(r)              solver-filled legs only
 *            - gasUsd(r)                                     every transaction incl. approvals, Solana fees
 *            - extraCostsUsd(r)                              fees paid on top (DLN's fixed fee), priced
 *            - lambdaT * seconds(r)                          time to a usable output
 *            - lambdaS * (signatures(r) - 1)                 each extra wallet signature
 *            - strandCost(r)                                 composites: a later leg may fail after a fill
 *            - riskTransit(r)                                venue tier (@kletia/core risk.ts)
 *
 * - expectedEff: the quoted expected output for legs with an on-chain floor;
 *   for a claimed floor (a solver's promise checked after settlement)
 *   `expected - 0.5 * (expected - floor)` until the size bucket holds 50
 *   verified fills.
 * - P_fill weighs what a non-fill costs, never the whole output: an unfilled
 *   solver order is refunded (Across, Relay) or cancellable (DLN), so the
 *   person keeps the input and loses source gas, any cancel gas on the
 *   destination and the time the funds are locked. P_fill is 1 for atomic
 *   legs (a revert costs gas only, already in gasUsd).
 * - haircut: measured per (venue, kind, network pair, size bucket) by
 *   routing/venueStats.ts; priors 0 bps for on-chain floors and same-asset
 *   solver bridges, 3 bps for solver-filled swaps.
 *
 * Eligibility comes first and is never bought by value: the quoted output
 * asset is the requested one, the floor is within the request's slippage of
 * the expected output (floors decide eligibility and are shown; they no
 * longer decide ranking), extra costs can be priced, the time limit
 * holds. Selection: preferred protocols first; then the highest value; a
 * route with more signatures than the best single-signature route must beat
 * it by max($0.50, 3 bps of the input); ties within max($0.05, 0.5 bps) go to
 * fewer signatures, fewer seconds, an on-chain floor, then candidate order
 * (deterministic, I9). "Signatures" in the margin rule are the route's
 * signed legs (composites need 2-3); approvals are priced through gas and
 * lambdaS and break ties.
 *
 * When neither the output nor the input can be priced in USD, routes are
 * compared in output units (extra costs converted exactly when they are in
 * the output asset, through the quote's own rate when they are in the input
 * asset, else the route is unpriced) and the USD terms are left out for every
 * candidate alike.
 */
import {
  CHAINS,
  fromBaseUnits,
  protocolTier,
  transitRiskUsd,
  type AssetAmount,
  type IntentActionKind,
  type NetworkKey,
  type ProtocolId,
  type ProtocolTier,
  type RoutePreference,
  type RouteScore,
} from "@kletia/core";
import { assetFromRef, isUsdStablecoin, sameAsset, type ResolvedAsset } from "../assets.js";
import { estimateEvmFee, estimateSolanaFee, evmOperationsFor, gasPriceFrom, readFeeFacts, SOLANA_PRIORITY_LAMPORTS } from "../journey/fees.js";
import { activePriceReader, nativeUsdPrice, solanaMintUsdPrice } from "../prices.js";
import { budgetMs } from "./deadline.js";
import { fillRate, haircut, HAIRCUT_PRIOR_BPS, MEASURED_FILLS } from "./venueStats.js";

/** USD per second of waiting for a usable output (x5 when the caller prefers the fastest route). */
export const LAMBDA_T_USD_PER_SECOND = 0.002;
export const FASTEST_LAMBDA_T_FACTOR = 5;
/** USD per extra wallet signature. */
export const LAMBDA_S_USD = 0.1;
/** Share of the gap between a claimed floor and the expected output that is not credited. */
export const CLAIMED_FLOOR_DISCOUNT = 0.5;
/** A multi-signature route must beat the best single-signature route by this much. */
export const MULTI_SIGNATURE_MARGIN = Object.freeze({ minUsd: 0.5, bps: 3 });
/** Values within this much of each other tie. */
export const TIE_MARGIN = Object.freeze({ minUsd: 0.05, bps: 0.5 });
/** Rounding tolerance of the floor eligibility check (bps of the expected output, plus one base unit). */
export const FLOOR_TOLERANCE_BPS = 1;
/** Smallest strand cost of a dependent leg after a crossing. */
export const STRAND_MIN_USD = 0.25;
/**
 * Time a non-filled solver order keeps the funds before the person can act
 * again, valued at lambdaT. Capped at 10 minutes: after a refund the person
 * re-plans, and longer waits do not depend on which venue was picked.
 */
export const NON_FILL_LOCK_SECONDS = 600;
/** Gas of a deBridge DLN cancel on the destination (typical, x1.5 headroom like the journey's estimates). */
const DLN_CANCEL_GAS = 150_000n;
/** Budget of the facts a score reads (gas price, USD prices); a late fact uses its fallback. */
export const SCORE_FACTS_DEADLINE_MS = 1_500;

/**
 * Wei per gas used for ranking when `eth_gasPrice` cannot be read: upper
 * bounds of recent prices, the same for every candidate on the network, so
 * relative costs still rank.
 */
const FALLBACK_GAS_PRICE_WEI: Readonly<Partial<Record<NetworkKey, bigint>>> = Object.freeze({
  ethereum: 20_000_000_000n,
  base: 100_000_000n,
  optimism: 100_000_000n,
  arbitrum: 500_000_000n,
  polygon: 800_000_000_000n,
  arc: 300_000_000_000n,
  "arbitrum-sepolia": 500_000_000n,
});

/* -------------------------------------------------------------------- facts */

/** Live facts a score reads. Every reader returns null when it does not know. */
export interface ScoreFacts {
  /** Wei per gas on an EVM network (null for Solana and when unknown). */
  gasPriceWei(network: NetworkKey): Promise<bigint | null>;
  /** USD per whole native gas token. */
  nativeUsd(network: NetworkKey): Promise<number | null>;
  /** USD per whole token of an asset. */
  assetUsd(asset: ResolvedAsset): Promise<number | null>;
}

async function defaultAssetUsd(asset: ResolvedAsset): Promise<number | null> {
  if (CHAINS[asset.network].environment === "testnet") return isUsdStablecoin(asset) ? 1 : 0;
  if (isUsdStablecoin(asset)) return 1;
  if (asset.isNative) return nativeUsdPrice(asset.network);
  if (CHAINS[asset.network].vm === "svm" && asset.address) return solanaMintUsdPrice(asset.address);
  // An installed price reader replaces the oracle reads too (the same seam the preview pricer honours).
  const reader = activePriceReader();
  if (reader) {
    try {
      const quote = await reader.quote(asset.symbol, asset.network);
      return quote && Number.isFinite(quote.usd) && quote.usd >= 0 ? quote.usd : null;
    } catch {
      return null;
    }
  }
  try {
    // The conservative oracle the swap price band already uses (Chainlink, derived LST prices).
    const { policyPrice, quoteUsdNumber } = await import("../policy/pricing.js");
    const quote = await policyPrice({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network: asset.network });
    return quote ? quoteUsdNumber(quote) : null;
  } catch {
    return null;
  }
}

const DEFAULT_FACTS: ScoreFacts = {
  async gasPriceWei(network) {
    if (CHAINS[network].vm !== "evm") return null;
    const facts = await readFeeFacts([network], { deadlineMs: Math.max(1, budgetMs(SCORE_FACTS_DEADLINE_MS)) });
    return gasPriceFrom(facts, network);
  },
  nativeUsd: (network) => nativeUsdPrice(network),
  assetUsd: defaultAssetUsd,
};

let facts: ScoreFacts = DEFAULT_FACTS;

/** Replaces the score's fact readers (tests, replay); `null` restores the live readers. */
export function configureScoreFacts(next: Partial<ScoreFacts> | null): void {
  facts = next === null ? DEFAULT_FACTS : { ...DEFAULT_FACTS, ...next };
}

/** A fact read within `ms` (null when late or failed). */
async function bounded<T>(read: () => Promise<T | null>, ms: number = SCORE_FACTS_DEADLINE_MS): Promise<T | null> {
  const limit = budgetMs(ms);
  if (limit <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), limit);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function readGasPriceWei(network: NetworkKey): Promise<bigint | null> {
  return bounded(() => facts.gasPriceWei(network));
}

export function readNativeUsd(network: NetworkKey): Promise<number | null> {
  return bounded(() => facts.nativeUsd(network));
}

export function readAssetUsd(asset: ResolvedAsset): Promise<number | null> {
  return bounded(async () => {
    if (CHAINS[asset.network].environment === "testnet") return isUsdStablecoin(asset) ? 1 : 0;
    if (isUsdStablecoin(asset)) return 1;
    return facts.assetUsd(asset);
  });
}

/** The gas price used for ranking: the live one, else the network's fallback upper bound. */
export function rankingGasPrice(network: NetworkKey, live: bigint | null): bigint | null {
  if (CHAINS[network].vm !== "evm") return null;
  return live ?? FALLBACK_GAS_PRICE_WEI[network] ?? 20_000_000_000n;
}

/* ---------------------------------------------------------------- gas terms */

/**
 * USD of the transactions a leg signs on its source network: approvals
 * only when the quote counted one (the adapter read the allowance), the
 * main call by kind and venue (journey/fees.ts), Solana signatures and
 * priority fees. Null when the native price is unknown.
 */
export function legGasUsd(input: {
  readonly network: NetworkKey;
  readonly kind: IntentActionKind;
  readonly venue: ProtocolId;
  readonly nativeInput: boolean;
  readonly transactions: number;
  readonly gasPriceWei: bigint | null;
  readonly nativeUsd: number | null;
}): number | null {
  if (input.nativeUsd === null) return null;
  const chain = CHAINS[input.network];
  if (chain.vm === "svm") {
    const fee = estimateSolanaFee({ network: input.network, signatures: Math.max(1, input.transactions), priorityLamports: input.kind === "transfer" ? 0n : SOLANA_PRIORITY_LAMPORTS });
    return Number(fromBaseUnits(fee.amount ?? "0", 9)) * input.nativeUsd;
  }
  let operations = evmOperationsFor(input.kind, input.venue, { nativeInput: input.nativeInput });
  // The adapter read the allowance: no approval transaction when it counted fewer transactions.
  if (operations[0] === "approve" && input.transactions < operations.length) operations = operations.slice(1);
  const fee = estimateEvmFee({ network: input.network, gasPriceWei: input.gasPriceWei, operations });
  if (fee.amount === null) return null;
  return Number(fromBaseUnits(fee.amount, chain.nativeAsset.decimals)) * input.nativeUsd;
}

/** USD of a DLN cancel on the destination (the order authority signs it there). */
export function cancelGasUsd(network: NetworkKey, gasPriceWei: bigint | null, nativeUsd: number | null): number {
  if (nativeUsd === null) return 0;
  if (CHAINS[network].vm === "svm") return Number(fromBaseUnits(estimateSolanaFee({ network, signatures: 1, priorityLamports: SOLANA_PRIORITY_LAMPORTS }).amount ?? "0", 9)) * nativeUsd;
  const price = rankingGasPrice(network, gasPriceWei);
  if (price === null) return 0;
  return Number(fromBaseUnits(((DLN_CANCEL_GAS * 3n) / 2n) * price, CHAINS[network].nativeAsset.decimals)) * nativeUsd;
}

/**
 * Strand cost of one dependent leg after a crossing: max($0.25,
 * amountUsd x carrier volatility over the expected delay x leg failure
 * rate). Volatility is 0 for stablecoin carriers.
 */
export function strandCostUsd(amountUsd: number, volatilityOverDelay: number, legFailureRate: number): number {
  const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  return Math.max(STRAND_MIN_USD, amount * Math.max(0, volatilityOverDelay) * Math.max(0, legFailureRate));
}

/* ------------------------------------------------------------------ scoring */

/** Legs a solver fills after the source transaction (cross-network venues except CCTP's attested mint). */
export function isSolverFilled(venue: ProtocolId, network: NetworkKey, destination: NetworkKey): boolean {
  return network !== destination && venue !== "cctp-v2";
}

/** The haircut prior of a leg until its bucket is measured. */
export function haircutPriorBps(input: { readonly floor: "onchain" | "claimed"; readonly solverFilled: boolean; readonly sameAssetGroup: boolean; readonly kind: IntentActionKind }): number {
  if (input.floor === "onchain") return HAIRCUT_PRIOR_BPS.onchain;
  if (input.solverFilled && input.sameAssetGroup) return HAIRCUT_PRIOR_BPS.sameAssetBridge;
  if (input.kind === "swap" || input.kind === "bridge") return HAIRCUT_PRIOR_BPS.solverSwap;
  return 0;
}

/** What one candidate leg brings to the score (resolved numbers; see `scoreLeg`). */
export interface ScoreInputs {
  readonly venue: ProtocolId;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly destination: NetworkKey;
  /** Quoted expected and guaranteed output, in whole tokens. */
  readonly expectedUnits: number;
  readonly minimumUnits: number;
  readonly floor: "onchain" | "claimed";
  /** USD per whole output token; null: units mode. */
  readonly priceOut: number | null;
  /** USD value of the input (size bucket, bps margins, transit risk). */
  readonly inputUsd: number | null;
  /** Extra costs in USD (USD mode) and in output units (units mode). */
  readonly extraCostsUsd: number;
  readonly extraCostsOutUnits: number;
  readonly gasUsd: number;
  readonly seconds: number;
  readonly signatures: number;
  readonly sameAssetGroup: boolean;
  readonly preference: RoutePreference;
  /** USD of what a non-fill costs (source gas, cancel gas, lock time); ignored for atomic legs. */
  readonly nonFillCostUsd: number;
  readonly strandCostUsd: number;
}

export interface ScoredLeg {
  /** Ranking value: USD in USD mode, output units in units mode. */
  readonly value: number;
  readonly mode: "usd" | "units";
  readonly expectedEffUnits: number;
  readonly haircutBps: number;
  readonly haircutMeasured: boolean;
  readonly pFill: number;
  readonly claimedDiscounted: boolean;
  readonly score: RouteScore;
}

function round(value: number, places = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Scores one leg. Pure given the inputs and the venue statistics. */
export function scoreLeg(inputs: ScoreInputs): ScoredLeg {
  const solverFilled = isSolverFilled(inputs.venue, inputs.network, inputs.destination);
  const prior = haircutPriorBps({ floor: inputs.floor, solverFilled, sameAssetGroup: inputs.sameAssetGroup, kind: inputs.kind });
  const cut = haircut(inputs.venue, inputs.kind, inputs.network, inputs.destination, inputs.inputUsd, prior);
  const claimedDiscounted = inputs.floor === "claimed" && cut.fills < MEASURED_FILLS && inputs.minimumUnits < inputs.expectedUnits;
  const expectedEff = claimedDiscounted
    ? inputs.expectedUnits - CLAIMED_FLOOR_DISCOUNT * (inputs.expectedUnits - inputs.minimumUnits)
    : inputs.expectedUnits;
  const arriving = expectedEff * (1 - cut.bps / 10_000);
  const pFill = solverFilled ? fillRate(inputs.venue, inputs.network, inputs.destination).rate : 1;
  const tier: ProtocolTier = protocolTier(inputs.venue, inputs.network);
  const riskUsd = inputs.inputUsd === null ? 0 : transitRiskUsd(tier, inputs.inputUsd);
  const lambdaT = LAMBDA_T_USD_PER_SECOND * (inputs.preference === "fastest" ? FASTEST_LAMBDA_T_FACTOR : 1);
  const seconds = Math.max(0, inputs.seconds);
  const signatures = Math.max(1, inputs.signatures);
  if (inputs.priceOut === null) {
    const value = arriving - inputs.extraCostsOutUnits;
    return {
      value,
      mode: "units",
      expectedEffUnits: expectedEff,
      haircutBps: cut.bps,
      haircutMeasured: cut.measured,
      pFill,
      claimedDiscounted,
      score: {
        valueUsd: 0,
        expectedUsd: 0,
        minimumUsd: 0,
        minimumKind: inputs.floor,
        gasUsd: 0,
        feesUsd: 0,
        seconds,
        signatures,
        riskUsd: 0,
      },
    };
  }
  const price = inputs.priceOut;
  const nonFill = solverFilled ? (1 - pFill) * inputs.nonFillCostUsd : 0;
  const value = arriving * price
    - nonFill
    - inputs.gasUsd
    - inputs.extraCostsUsd
    - lambdaT * seconds
    - LAMBDA_S_USD * (signatures - 1)
    - inputs.strandCostUsd
    - riskUsd;
  return {
    value,
    mode: "usd",
    expectedEffUnits: expectedEff,
    haircutBps: cut.bps,
    haircutMeasured: cut.measured,
    pFill,
    claimedDiscounted,
    score: {
      valueUsd: round(value, 4),
      expectedUsd: round(inputs.expectedUnits * price, 4),
      minimumUsd: round(inputs.minimumUnits * price, 4),
      minimumKind: inputs.floor,
      gasUsd: round(inputs.gasUsd, 4),
      feesUsd: round(inputs.extraCostsUsd, 4),
      seconds,
      signatures,
      riskUsd: round(riskUsd, 4),
    },
  };
}

/* ------------------------------------------------------------- eligibility */

/**
 * True when the guaranteed floor is within the request's slippage of the
 * expected output (`minimum >= expected * (1 - slippage)`, with one bps and
 * one base unit of rounding tolerance). A tighter floor is fine.
 */
export function floorWithinSlippage(expected: bigint, minimum: bigint, slippageBps: number): boolean {
  if (expected <= 0n) return minimum >= 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))) + FLOOR_TOLERANCE_BPS);
  const floor = (expected * (10_000n - (bps > 10_000n ? 10_000n : bps))) / 10_000n;
  return minimum + 1n >= floor;
}

/* --------------------------------------------------------------- selection */

export interface RankEntry<T> {
  readonly item: T;
  readonly value: number;
  readonly mode: "usd" | "units";
  readonly eligible: boolean;
  readonly preferred: boolean;
  readonly signatures: number;
  /**
   * Wallet-signed legs of the route (1 for a single venue; 2-3 for a
   * composite). The multi-signature margin compares legs, not approvals:
   * an approval costs its gas and lambdaS, but does not make a route a
   * composite.
   */
  readonly legs?: number;
  readonly seconds: number;
  readonly onchainFloor: boolean;
  /** Candidate order (registry / preference order): the last tie-break. */
  readonly order: number;
  /** Never chosen as the winner (a cached pre-screen estimate). */
  readonly estimate?: boolean;
}

function exactOrder<T>(a: RankEntry<T>, b: RankEntry<T>, preference: RoutePreference): number {
  if (preference === "fewest-signatures" && a.signatures !== b.signatures) return a.signatures - b.signatures;
  if (a.value !== b.value) return b.value > a.value ? 1 : -1;
  if (a.signatures !== b.signatures) return a.signatures - b.signatures;
  if (a.seconds !== b.seconds) return a.seconds - b.seconds;
  if (a.onchainFloor !== b.onchainFloor) return a.onchainFloor ? -1 : 1;
  return a.order - b.order;
}

function margin(top: number, mode: "usd" | "units", inputUsd: number | null, spec: { readonly minUsd: number; readonly bps: number }): number {
  if (mode === "units") return (Math.abs(top) * spec.bps) / 10_000;
  const base = inputUsd !== null && Number.isFinite(inputUsd) && inputUsd > 0 ? inputUsd : Math.abs(top);
  return Math.max(spec.minUsd, (base * spec.bps) / 10_000);
}

/**
 * Orders candidates and picks the winner. Eligible before excluded; within the
 * eligible ones a preferred protocol wins whenever one is eligible; then value
 * with the multi-signature margin and the tie rule. Returns the winner (null
 * when nothing eligible) and every entry, winner first, then by value.
 */
export function selectRoute<T>(
  entries: readonly RankEntry<T>[],
  options: { readonly inputUsd: number | null; readonly preference?: RoutePreference } = { inputUsd: null },
): { readonly winner: RankEntry<T> | null; readonly ordered: readonly RankEntry<T>[] } {
  const preference = options.preference ?? "value";
  const byOrder = (a: RankEntry<T>, b: RankEntry<T>) => exactOrder(a, b, preference);
  const eligible = entries.filter((entry) => entry.eligible && !entry.estimate);
  const preferred = eligible.filter((entry) => entry.preferred);
  const pool = [...(preferred.length > 0 ? preferred : eligible)].sort(byOrder);
  let winner: RankEntry<T> | null = pool[0] ?? null;
  if (winner && preference !== "fewest-signatures") {
    const mode = winner.mode;
    // A route with more signed legs than the best single-leg route must beat it clearly.
    const legs = (entry: RankEntry<T>) => entry.legs ?? 1;
    const single = pool.find((entry) => legs(entry) === 1);
    if (single && legs(winner) > 1 && winner.value - single.value < margin(winner.value, mode, options.inputUsd, MULTI_SIGNATURE_MARGIN)) {
      winner = single;
    }
    // Ties: fewer signatures, then fewer seconds, then an on-chain floor, then candidate order.
    const anchor = winner;
    const tie = margin(anchor.value, mode, options.inputUsd, TIE_MARGIN);
    const tied = pool.filter((entry) => Math.abs(entry.value - anchor.value) <= tie && entry.signatures <= anchor.signatures);
    winner = [...tied].sort((a, b) =>
      a.signatures - b.signatures || a.seconds - b.seconds || Number(b.onchainFloor) - Number(a.onchainFloor) || a.order - b.order)[0] ?? anchor;
  }
  const rest = entries.filter((entry) => entry !== winner);
  const preferredFirst = (a: RankEntry<T>, b: RankEntry<T>) => Number(b.preferred) - Number(a.preferred) || byOrder(a, b);
  const ordered = [
    ...(winner ? [winner] : []),
    ...rest.filter((entry) => entry.eligible && !entry.estimate).sort(preferredFirst),
    ...rest.filter((entry) => entry.eligible && entry.estimate).sort(byOrder),
    ...rest.filter((entry) => !entry.eligible).sort(byOrder),
  ];
  return { winner, ordered };
}

/* ------------------------------------------------------------------ helpers */

/** Whole tokens of a base-unit amount (a number; ranking precision). */
export function wholeUnits(amount: bigint | string, decimals: number): number {
  return Number(fromBaseUnits(BigInt(amount), decimals));
}

/** USD of an amount: its own `usd`, else a price per whole token, else null. */
export function amountUsd(amount: AssetAmount, pricePerToken: number | null): number | null {
  if (amount.usd !== undefined && Number.isFinite(amount.usd)) return amount.usd;
  if (pricePerToken === null) return null;
  return wholeUnits(amount.amount, amount.decimals) * pricePerToken;
}

/**
 * USD of each extra cost of a quote: its own `usd`, the output or input
 * price when it is in one of those assets, else the asset's price. Null when
 * any cost stays unpriced.
 */
export async function extraCostsUsd(
  costs: readonly AssetAmount[],
  output: { readonly asset: ResolvedAsset; readonly price: number | null },
  input: { readonly asset: ResolvedAsset; readonly price: number | null },
): Promise<number | null> {
  let total = 0;
  for (const cost of costs) {
    if (!/^\d+$/u.test(cost.amount)) return null;
    let usd: number | null = cost.usd !== undefined && Number.isFinite(cost.usd) ? cost.usd : null;
    if (usd === null && sameAsset(cost, output.asset)) usd = amountUsd(cost, output.price);
    if (usd === null && sameAsset(cost, input.asset)) usd = amountUsd(cost, input.price);
    if (usd === null) {
      let asset: ResolvedAsset;
      try {
        asset = assetFromRef(cost);
      } catch {
        return null;
      }
      usd = amountUsd(cost, await readAssetUsd(asset));
    }
    if (usd === null || !Number.isFinite(usd)) return null;
    total += usd;
  }
  return total;
}

/**
 * Extra costs in output units for units mode: exact when in the output
 * asset, through the quote's own rate (expected / input) when in the input
 * asset; null when any cost is in a third asset.
 */
export function extraCostsOutUnits(
  costs: readonly AssetAmount[],
  output: ResolvedAsset,
  input: ResolvedAsset,
  quoteRate: number,
): number | null {
  let total = 0;
  for (const cost of costs) {
    if (!/^\d+$/u.test(cost.amount)) return null;
    const units = wholeUnits(cost.amount, cost.decimals);
    if (sameAsset(cost, output)) total += units;
    else if (sameAsset(cost, input) && Number.isFinite(quoteRate)) total += units * quoteRate;
    else return null;
  }
  return total;
}

/** The tier a venue is charged for (testnet networks carry no cost). */
export function venueTier(venue: ProtocolId, network: NetworkKey): ProtocolTier {
  return protocolTier(venue, network);
}

/** USD of what a solver order's non-fill costs: source gas again, cancel gas on the destination (DLN), the lock time. */
export function nonFillCostUsd(input: {
  readonly venue: ProtocolId;
  readonly sourceGasUsd: number;
  readonly destinationCancelUsd: number;
  readonly preference: RoutePreference;
}): number {
  const lambdaT = LAMBDA_T_USD_PER_SECOND * (input.preference === "fastest" ? FASTEST_LAMBDA_T_FACTOR : 1);
  const cancel = input.venue === "debridge-dln" ? input.destinationCancelUsd : 0;
  return Math.max(0, input.sourceGasUsd) + Math.max(0, cancel) + lambdaT * NON_FILL_LOCK_SECONDS;
}
