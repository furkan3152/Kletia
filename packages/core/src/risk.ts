/**
 * Risk costs of a venue tier: what a route pays for moving value through a
 * venue of that tier (transit), what a deposit or stake gives up per year
 * for holding value there (holding), and the smallest total value locked a
 * venue of that tier needs before an unnamed "best yield" choice compares
 * it.
 *
 * Ranking inputs only: a penalty orders eligible candidates and never makes
 * an ineligible route or venue eligible. A venue the person named is honoured
 * whatever its tier. Testnet venues carry no cost (testnet capital has no
 * value and never shares a plan with mainnet funds).
 */
import type { ProtocolTier } from "./protocols.js";

/** Tiers from safest to least vetted. */
export const RISK_TIERS: readonly ProtocolTier[] = Object.freeze(["core", "curated", "extended", "testnet"] as const);

/** Transit cost of one leg through a venue of a tier: max(minUsd, bps of the value moved). */
export const TRANSIT_RISK: Readonly<Record<ProtocolTier, { readonly minUsd: number; readonly bps: number }>> = Object.freeze({
  core: Object.freeze({ minUsd: 0, bps: 0 }),
  curated: Object.freeze({ minUsd: 0.25, bps: 1 }),
  extended: Object.freeze({ minUsd: 1, bps: 5 }),
  testnet: Object.freeze({ minUsd: 0, bps: 0 }),
});

/** Holding penalty of a tier, in APY percentage points subtracted from a venue's rate before ranking. */
export const HOLDING_PENALTY_APY_POINTS: Readonly<Record<ProtocolTier, number>> = Object.freeze({
  core: 0,
  curated: 0.5,
  extended: 1.5,
  testnet: 0,
});

/** Smallest TVL (USD) a venue of a tier needs to be compared for an unnamed "best yield" choice. */
export const TVL_FLOOR_USD: Readonly<Record<ProtocolTier, number>> = Object.freeze({
  core: 50_000_000,
  curated: 10_000_000,
  extended: 2_000_000,
  testnet: 0,
});

/** USD a route is charged for moving `amountUsd` through one venue of `tier` (0 for a non-finite or negative amount). */
export function transitRiskUsd(tier: ProtocolTier, amountUsd: number): number {
  const cost = TRANSIT_RISK[tier];
  const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  return Math.max(cost.minUsd, (amount * cost.bps) / 10_000);
}

/**
 * A rate net of the tier's holding penalty, in the unit given: pass an APY as
 * a fraction (0.05) and get a fraction back. Null stays null (an unknown rate
 * is never ranked as zero).
 */
export function riskAdjustedApy(tier: ProtocolTier, apy: number | null): number | null {
  if (apy === null || !Number.isFinite(apy)) return null;
  return apy - HOLDING_PENALTY_APY_POINTS[tier] / 100;
}

/** The least safe of several tiers (a route is as risky as its riskiest venue); "core" for none. */
export function worstRiskTier(tiers: readonly ProtocolTier[]): ProtocolTier {
  return tiers.reduce<ProtocolTier>((worst, tier) => (RISK_TIERS.indexOf(tier) > RISK_TIERS.indexOf(worst) ? tier : worst), "core");
}
