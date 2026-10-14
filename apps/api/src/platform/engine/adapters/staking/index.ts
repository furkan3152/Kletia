/**
 * EVM liquid staking on Ethereum: Lido (wstETH), Rocket Pool (rETH) and
 * ether.fi (weETH), plus the wallet LST positions reader.
 */
import type { ParsedAccountId, VenuePosition } from "@kletia/core";
import { readStakingPositions, type StakingVenue } from "./common.js";
import { etherfiVenue } from "./etherfi.js";
import { lidoVenue } from "./lido.js";
import { rocketPoolVenue } from "./rocketPool.js";

export { createStakingAdapter, noUnstakeWarning, STAKE_TOLERANCE_BPS, type StakingVenue } from "./common.js";
export { etherfiAdapter, etherfiVenue } from "./etherfi.js";
export { lidoAdapter, lidoVenue } from "./lido.js";
export { rocketPoolAdapter, rocketPoolVenue } from "./rocketPool.js";

export const STAKING_VENUES: readonly StakingVenue[] = Object.freeze([lidoVenue, rocketPoolVenue, etherfiVenue]);

/** wstETH, rETH and weETH the owner holds on Ethereum, valued in ETH (journey positions). */
export function readLstPositions(owner: ParsedAccountId): Promise<VenuePosition[]> {
  return readStakingPositions(STAKING_VENUES, owner);
}
