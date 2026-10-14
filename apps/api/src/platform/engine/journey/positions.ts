/**
 * Venue positions of an account (journey design §6.7, engine side): what it
 * holds at every listed venue of a network with a position token (Aave and
 * SparkLend aTokens, Compound V3 balances, ERC-4626 shares (Morpho, Spark
 * Savings, Fluid, Yearn), Moonwell mTokens, Jupiter Lend jlTokens), valued
 * in the underlying with the rate used and priced through the preview pricer.
 *
 * Each read goes through the venue adapter's `positionOf` (the reads it
 * already makes for "withdraw all"). Kamino obligations are a follow-up
 * (design §12): Kamino venues are listed as unavailable. A venue whose read
 * fails, or whose adapter has no position reader, is reported in
 * `unavailable`: unknown is never an empty position.
 */
import {
  CHAINS,
  fromBaseUnits,
  isPreviewAccount,
  parseAccountId,
  YIELD_VENUES,
  type AccountId,
  type NetworkKey,
  type VenuePosition,
  type YieldVenue,
} from "@kletia/core";
import { toPlatformError } from "../../errors.js";
import { activeProtocolAdapters } from "../adapters/registry.js";
import { isEvmLendingVenue, readLendingMetrics } from "../adapters/lending/metrics.js";
import { quoteAsset } from "../preview/pricer.js";

/** Per-venue read timeout and the whole listing's deadline. */
const POSITION_READ_MS = 4_000;
const POSITIONS_DEADLINE_MS = 6_000;

export interface VenuePositionsResult {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly positions: readonly VenuePosition[];
  /** Venues that could not be read (RPC trouble, no position reader yet, Kamino obligations). */
  readonly unavailable: readonly { readonly venue: string; readonly code: string; readonly message: string }[];
  readonly observedAt: string;
}

export interface VenuePositionOptions {
  /** Only these registry venue ids (default: every venue of the network with a position token). */
  readonly venues?: readonly string[];
  readonly deadlineMs?: number;
}

function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("The position read timed out."), { code: "RPC_TIMEOUT" })), Math.max(1, ms));
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Venues of `network` that hold positions as a token (Kamino obligations excluded). */
export function positionVenues(network: NetworkKey): YieldVenue[] {
  return YIELD_VENUES.filter((venue) => venue.network === network && "receipt" in venue);
}

/** Fills USD (underlying price), APY and exit-bounded withdrawable amounts the adapter left open. */
async function enrich(position: VenuePosition, venue: YieldVenue): Promise<VenuePosition> {
  const [price, metrics] = await Promise.all([
    quoteAsset(position.underlying.asset).catch(() => null),
    position.apy === null && isEvmLendingVenue(venue) ? readLendingMetrics(venue.id).catch(() => null) : Promise.resolve(null),
  ]);
  const usd = price ? Math.round((Number(position.underlying.amount) / 10 ** position.underlying.decimals) * price.usd * 100) / 100 : null;
  let withdrawableNow = position.withdrawableNow;
  if (withdrawableNow === null && metrics?.exitLiquidity) {
    const exit = BigInt(metrics.exitLiquidity.amount);
    const value = BigInt(position.underlying.amount);
    const units = exit < value ? exit : value;
    withdrawableNow = { ...position.underlying, amount: units.toString(), formatted: fromBaseUnits(units, position.underlying.decimals) };
  }
  return { ...position, usd: position.usd ?? usd, apy: position.apy ?? metrics?.supplyApy ?? null, withdrawableNow };
}

/**
 * Positions of `account` on `network` (read-only). Preview (demo) accounts
 * are never read. Venues are read in parallel, each under its own timeout.
 */
export async function readVenuePositions(account: AccountId, network: NetworkKey, options: VenuePositionOptions = {}): Promise<VenuePositionsResult> {
  const observedAt = new Date().toISOString();
  const parsed = parseAccountId(account);
  const chain = CHAINS[network];
  if (!parsed || parsed.chain.namespace !== chain.namespace) {
    return { account, network, positions: [], unavailable: [{ venue: "*", code: "ACCOUNT_INVALID", message: `The account is not on ${chain.name}'s VM.` }], observedAt };
  }
  if (isPreviewAccount(account)) return { account, network, positions: [], unavailable: [], observedAt };
  const owner = parseAccountId(`${chain.id}:${parsed.address}`);
  if (!owner) return { account, network, positions: [], unavailable: [{ venue: "*", code: "ACCOUNT_INVALID", message: "The account could not be read." }], observedAt };
  const wanted = options.venues ? new Set(options.venues) : null;
  const venues = positionVenues(network).filter((venue) => !wanted || wanted.has(venue.id));
  const kamino = YIELD_VENUES.filter((venue) => venue.network === network && venue.kind === "kamino-reserve" && (!wanted || wanted.has(venue.id)));
  const deadline = Date.now() + (options.deadlineMs ?? POSITIONS_DEADLINE_MS);
  const adapters = activeProtocolAdapters();
  const results = await Promise.allSettled(venues.map(async (venue) => {
    const adapter = adapters.find((candidate) => candidate.protocols.includes(venue.protocol));
    if (!adapter?.positionOf) throw Object.assign(new Error(`Position reads are not available for ${venue.name} yet.`), { code: "POSITION_UNAVAILABLE" });
    const position = await withDeadline(adapter.positionOf(venue, owner), Math.min(POSITION_READ_MS, deadline - Date.now()));
    return position ? withDeadline(enrich(position, venue), Math.max(1, deadline - Date.now())).catch(() => position) : null;
  }));
  const positions: VenuePosition[] = [];
  const unavailable: { venue: string; code: string; message: string }[] = kamino.map((venue) => ({
    venue: venue.id, code: "POSITION_UNAVAILABLE", message: `${venue.name} positions are held in Kamino obligations, which are not listed yet.`,
  }));
  results.forEach((result, index) => {
    const venue = venues[index] as YieldVenue;
    if (result.status === "fulfilled") {
      if (result.value) positions.push(result.value);
      return;
    }
    const reason = result.reason as { code?: unknown; message?: unknown };
    const error = typeof reason?.code === "string" && reason.code === "POSITION_UNAVAILABLE"
      ? { code: reason.code, message: String(reason.message) }
      : toPlatformError(result.reason);
    unavailable.push({ venue: venue.id, code: error.code, message: error.message });
  });
  return { account, network, positions, unavailable, observedAt };
}
