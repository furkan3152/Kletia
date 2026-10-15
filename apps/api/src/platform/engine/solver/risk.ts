/**
 * Risk tiers of the capability graph's edges. The tier is the registry's
 * own (`protocolTier`: descriptor `tier`, `testnet` on a testnet network,
 * `extended` for anything the registry does not rate), so a protocol added
 * to the registry is rated with no change here.
 *
 * The search ranks with the penalties below (λr); ranking only orders
 * candidates, it never admits a route an adapter does not serve.
 */
import { protocolTier, type NetworkKey, type ProtocolId, type ProtocolTier } from "@kletia/core";

export type RiskTier = ProtocolTier;

/** Risk tiers from safest to least vetted (ties and "safest" preference read this order). */
export const RISK_ORDER: readonly RiskTier[] = Object.freeze(["core", "curated", "extended", "testnet"]);

/**
 * λr: USD a route is charged per edge of this tier when ranked. Testnet
 * edges carry no penalty: testnet capital has no value and never mixes with
 * mainnet routes (the lanes are disjoint graphs).
 */
export const RISK_PENALTY_USD: Readonly<Record<RiskTier, number>> = Object.freeze({
  core: 0,
  curated: 0.25,
  extended: 1,
  testnet: 0,
});

/** The risk tier of `protocol` on `network`. */
export function riskTier(protocol: ProtocolId, network: NetworkKey): RiskTier {
  return protocolTier(protocol, network);
}

/** The ranking penalty of a tier, in USD. */
export function riskPenaltyUsd(tier: RiskTier): number {
  return RISK_PENALTY_USD[tier];
}

/** The least safe of several tiers (a route is as risky as its riskiest edge). */
export function worstTier(tiers: readonly RiskTier[]): RiskTier {
  return tiers.reduce<RiskTier>((worst, tier) => (RISK_ORDER.indexOf(tier) > RISK_ORDER.indexOf(worst) ? tier : worst), "core");
}
