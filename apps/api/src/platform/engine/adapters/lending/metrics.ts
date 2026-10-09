/**
 * Read path for venue rates and sizes (APY, TVL, exit liquidity) of the EVM
 * lending venues in YIELD_VENUES, for quotes and discovery surfaces. Values
 * are read on-chain, cached briefly and advisory: no plan or prepare decision
 * depends on them (adapters re-read what they gate on).
 */
import { CHAINS, getYieldVenue, YIELD_VENUES, type NetworkKey, type ProtocolId } from "@kletia/core";
import { PlatformError, toPlatformError } from "../../../errors.js";
import { aaveMetrics } from "../aaveV3.js";
import type { EvmLendingVenue, LendingMetrics } from "./common.js";
import { compoundMetrics } from "./compoundV3.js";
import { morphoMetrics } from "./erc4626.js";
import { moonwellMetrics } from "./moonwell.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { readonly value: Promise<LendingMetrics>; readonly expiresAt: number }>();

export function isEvmLendingVenue(venue: { readonly kind: string; readonly network: NetworkKey }): venue is EvmLendingVenue {
  return ["aave-reserve", "comet", "erc4626", "ctoken"].includes(venue.kind) && CHAINS[venue.network].vm === "evm";
}

function read(venue: EvmLendingVenue): Promise<LendingMetrics> {
  switch (venue.kind) {
    case "aave-reserve":
      return aaveMetrics(venue);
    case "comet":
      return compoundMetrics(venue);
    case "erc4626":
      return morphoMetrics(venue);
    case "ctoken":
      return moonwellMetrics(venue);
  }
}

/** Metrics of one EVM lending venue (registry id), cached for a minute. */
export async function readLendingMetrics(venueId: string, now = Date.now()): Promise<LendingMetrics> {
  const venue = getYieldVenue(venueId);
  if (!venue || !isEvmLendingVenue(venue)) {
    throw new PlatformError("VENUE_UNKNOWN", `No EVM lending venue "${venueId.slice(0, 64)}" in the registry.`, 422);
  }
  const cached = cache.get(venue.id);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = read(venue);
  cache.set(venue.id, { value, expiresAt: now + CACHE_TTL_MS });
  value.catch(() => cache.delete(venue.id));
  return value;
}

export interface LendingMetricsListing {
  readonly venues: readonly LendingMetrics[];
  /** Venues whose reads failed (RPC down, registry pin no longer confirmed on-chain). */
  readonly unavailable: readonly { readonly venue: string; readonly code: string; readonly message: string }[];
}

/** Metrics of every EVM lending venue, optionally filtered by network and protocol. */
export async function listLendingMetrics(filter: { readonly network?: NetworkKey; readonly protocol?: ProtocolId } = {}): Promise<LendingMetricsListing> {
  const venues = YIELD_VENUES.filter((venue): venue is EvmLendingVenue =>
    isEvmLendingVenue(venue) &&
    venue.actions.length > 0 &&
    (!filter.network || venue.network === filter.network) &&
    (!filter.protocol || venue.protocol === filter.protocol));
  const results = await Promise.allSettled(venues.map((venue) => readLendingMetrics(venue.id)));
  const listing: LendingMetrics[] = [];
  const unavailable: { venue: string; code: string; message: string }[] = [];
  results.forEach((result, index) => {
    const venue = venues[index] as EvmLendingVenue;
    if (result.status === "fulfilled") listing.push(result.value);
    else {
      const error = toPlatformError(result.reason);
      unavailable.push({ venue: venue.id, code: error.code, message: error.message });
    }
  });
  return { venues: listing, unavailable };
}

/** Test seam: forget cached metrics. */
export function resetLendingMetricsCache(): void {
  cache.clear();
}
