/**
 * The example route printed on the home page (hero ticket, stubs, final call
 * to action). Venue names are read from the @kletia/core registry, so a
 * renamed venue is renamed here too. Every sentence below is one the v1
 * grammar accepts (each opens in Studio).
 */
import { getProtocol, type ProtocolId } from "@kletia/core";

import { LINES, type TicketLeg } from "../../site/art";

function venue(id: ProtocolId): string {
  return getProtocol(id)?.name ?? id;
}

export const HERO_INTENT = "bridge 50 USDC from base to solana then swap half to JitoSOL";
export const HERO_SERIAL = "7F3A-C21E";
export const HERO_FROM = LINES.base;
export const HERO_TO = LINES.solana;

/** The two legs of the hero route; `done` marks which ones were seen on-chain. */
export function heroLegs(done: readonly [boolean, boolean]): TicketLeg[] {
  return [
    { verb: "Bridge", detail: `50 USDC, ${LINES.base.name} → ${LINES.solana.name}`, via: venue("relay"), done: done[0] },
    { verb: "Swap", detail: "25 USDC → JitoSOL", via: venue("jupiter"), done: done[1] },
  ];
}

export const DRY_RUN_INTENT = "bridge 25 USDC from base to solana";
export const DRY_RUN_SERIAL = "0000-0001";
export const DRY_RUN_LEGS: readonly TicketLeg[] = [
  { verb: "Bridge", detail: `25 USDC, ${LINES.base.name} → ${LINES.solana.name}`, via: venue("cctp-v2"), done: false },
];
