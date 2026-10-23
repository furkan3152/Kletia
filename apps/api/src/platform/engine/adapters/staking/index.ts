/**
 * EVM liquid staking on Ethereum: Lido (wstETH), Rocket Pool (rETH),
 * ether.fi (weETH), and Stader (ETHx), Mantle (mETH) and Frax
 * Ether (sfrxETH), Kelp (rsETH) and Renzo (ezETH), plus the
 * wallet LST positions reader.
 */
import type { ParsedAccountId, VenuePosition } from "@kletia/core";
import { readStakingPositions, type StakingVenue } from "./common.js";
import { etherfiVenue } from "./etherfi.js";
import { fraxVenue } from "./frax.js";
import { kelpVenue } from "./kelp.js";
import { lidoVenue } from "./lido.js";
import { mantleVenue } from "./mantle.js";
import { renzoVenue } from "./renzo.js";
import { rocketPoolVenue } from "./rocketPool.js";
import { staderVenue } from "./stader.js";

export { createStakingAdapter, noUnstakeWarning, STAKE_TOLERANCE_BPS, type StakingVenue } from "./common.js";
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
