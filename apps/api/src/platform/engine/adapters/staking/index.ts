/**
 * EVM liquid staking on Ethereum: Lido (wstETH), Rocket Pool (rETH),
 * ether.fi (weETH), and Stader (ETHx), Mantle (mETH) and Frax
 * Ether (sfrxETH), Kelp (rsETH) and Renzo (ezETH), plus the
 * wallet LST positions reader.
 */
import type { ParsedAccountId, VenuePosition } from "@kletia/core";
import { readStakingMetrics, readStakingPositions, type StakingMetrics, type StakingVenue } from "./common.js";
import { etherfiVenue } from "./etherfi.js";
import { fraxVenue } from "./frax.js";
import { kelpVenue } from "./kelp.js";
import { lidoVenue } from "./lido.js";
import { mantleVenue } from "./mantle.js";
import { renzoVenue } from "./renzo.js";
import { rocketPoolVenue } from "./rocketPool.js";
import { staderVenue } from "./stader.js";

export { createStakingAdapter, noUnstakeWarning, readStakingMetrics, STAKE_TOLERANCE_BPS, type StakingMetrics, type StakingVenue } from "./common.js";
export { etherfiAdapter, etherfiVenue } from "./etherfi.js";
export { fraxAdapter, fraxVenue } from "./frax.js";
export { kelpAdapter, kelpVenue } from "./kelp.js";
export { lidoAdapter, lidoVenue } from "./lido.js";
export { mantleAdapter, mantleVenue } from "./mantle.js";
export { renzoAdapter, renzoVenue } from "./renzo.js";
export { rocketPoolAdapter, rocketPoolVenue } from "./rocketPool.js";
export { staderAdapter, staderVenue } from "./stader.js";

export const STAKING_VENUES: readonly StakingVenue[] = Object.freeze([lidoVenue, rocketPoolVenue, etherfiVenue, staderVenue, mantleVenue, fraxVenue, kelpVenue, renzoVenue]);

/** wstETH, rETH, weETH, ETHx, mETH, sfrxETH, rsETH and ezETH the owner holds on Ethereum, valued in ETH (journey positions). */
export function readLstPositions(owner: ParsedAccountId): Promise<VenuePosition[]> {
  return readStakingPositions(STAKING_VENUES, owner);
}

/**
 * Smoothed APY and TVL of every EVM liquid-staking token: the
 * input of "stake my ETH" without a named provider. A token whose reads fail
 * is listed with nulls, never left out.
 */
export function listStakingMetrics(): Promise<StakingMetrics[]> {
  return Promise.all(STAKING_VENUES.map((venue) => readStakingMetrics(venue).catch((): StakingMetrics => ({
    provider: venue.protocol,
    network: "ethereum",
    lst: venue.symbol,
    smoothedApy: null,
    apyWindowSeconds: null,
    tvlUsd: null,
    observedAt: new Date().toISOString(),
  }))));
}
