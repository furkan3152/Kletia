/**
 * Multi-venue auction for cross-network steps. Every candidate venue plans
 * the same action in parallel (each with its own timeout); quotes are ranked
 * by net guaranteed output:
 *
 *   net = minimumOutput - extraCosts (converted into output units)
 *
 * then by fewer estimated seconds, then by fewer wallet transactions, then by
 * preference order. A venue is not eligible when its quote is slower than
 * `maxSeconds`, delivers another asset than the route's output, or carries
 * extra costs that cannot be priced (never guessed). Preferred protocols
 * (`constraints.preferProtocols`) win whenever one of them is eligible.
 * POST /v1/quotes ranks routes with the same comparator.
 */
import { fromBaseUnits, getProtocol, type AssetAmount, type ProtocolId } from "@kletia/core";
import { PlatformError, toPlatformError } from "../errors.js";
import { effectiveProtocol } from "./adapters/registry.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "./adapters/types.js";
import { assetFromRef, isUsdStablecoin, sameAsset } from "./assets.js";
import { nativeUsdPrice } from "./prices.js";

/** Default `constraints.maxSeconds`: slower routes win only when the caller opts in. */
export const DEFAULT_MAX_SECONDS = 600;
/** Per-venue planning timeout inside an auction (a single candidate is never timed out). */
export const VENUE_QUOTE_TIMEOUT_MS = 8_000;

let venueQuoteTimeoutMs = VENUE_QUOTE_TIMEOUT_MS;

/** Overrides the per-venue quote timeout (tests, embedders); `null` restores the default. */
export function configureVenueQuoteTimeout(timeoutMs: number | null): void {
  venueQuoteTimeoutMs = timeoutMs === null ? VENUE_QUOTE_TIMEOUT_MS : Math.max(1, Math.floor(timeoutMs));
}

export interface AuctionOptions {
  readonly maxSeconds: number;
  /** True when the caller set `constraints.maxSeconds` (slow quotes are then refused, never kept). */
  readonly explicitMaxSeconds: boolean;
  readonly prefer: readonly ProtocolId[];
  readonly timeoutMs?: number;
}

export interface VenueQuote {
  readonly adapter: ProtocolAdapter;
  readonly protocol: ProtocolId;
  readonly planned: PlannedStep;
  /** Guaranteed output minus extra costs, in output base units; null when the extra costs are unpriced. */
  readonly netMinimum: bigint | null;
  /** Why the quote cannot win; absent when eligible. */
  readonly excluded?: "slow" | "unpriced" | "asset";
  /** Slower than the time limit, whatever else excludes it (an explicit limit refuses every slow quote). */
  readonly slow: boolean;
}

export interface VenueFailure {
  readonly adapter: ProtocolAdapter;
  readonly protocol: ProtocolId;
  readonly error: PlatformError;
}

export interface AuctionResult {
  readonly winner: VenueQuote;
  /** Every other quote, best first. */
  readonly losers: readonly VenueQuote[];
  readonly failures: readonly VenueFailure[];
  readonly warnings: readonly string[];
}

/** USD value of an amount: its own `usd`, 1:1 for USD stablecoins, or the native price. */
async function usdValue(amount: AssetAmount): Promise<number | null> {
  if (amount.usd !== undefined && Number.isFinite(amount.usd)) return amount.usd;
  let asset;
  try {
    asset = assetFromRef(amount);
  } catch {
    return null;
  }
  const units = Number(amount.formatted);
  if (!Number.isFinite(units)) return null;
  if (isUsdStablecoin(asset)) return units;
  if (asset.isNative) {
    const price = await nativeUsdPrice(asset.network);
    return price === null || price <= 0 ? null : units * price;
  }
  return null;
}

/** USD price of one whole output token, or null. */
async function unitPrice(amount: AssetAmount): Promise<number | null> {
  if (amount.amount === "0") return null;
  const value = await usdValue(amount);
  const units = Number(amount.formatted);
  return value === null || !(units > 0) ? null : value / units;
}

/**
 * The quote's guaranteed output net of extra costs, in output base units.
 * Extra costs in the output asset subtract exactly; others are converted
 * through USD prices and rounded against the venue. Null when a cost cannot
 * be priced.
 */
export async function netMinimumOutput(planned: Pick<PlannedStep, "minimumOutput" | "extraCosts">): Promise<bigint | null> {
  const minimum = BigInt(planned.minimumOutput.amount);
  const costs = planned.extraCosts ?? [];
  if (costs.length === 0) return minimum;
  let total = 0n;
  let price: number | null | undefined;
  for (const cost of costs) {
    if (!/^\d+$/u.test(cost.amount)) return null;
    if (sameAsset(cost, planned.minimumOutput)) {
      total += BigInt(cost.amount);
      continue;
    }
    price ??= await unitPrice(planned.minimumOutput);
    const usd = await usdValue(cost);
    if (price === null || usd === null) return null;
    const units = Math.ceil((usd / price) * 10 ** planned.minimumOutput.decimals);
    if (!Number.isFinite(units)) return null;
    total += BigInt(units);
  }
  return minimum - total;
}

function preferenceIndex(prefer: readonly ProtocolId[], protocol: ProtocolId): number {
  const index = prefer.indexOf(protocol);
  return index === -1 ? prefer.length : index;
}

/**
 * Orders quotes best first: eligible before excluded, preferred tier first,
 * then net guaranteed output, seconds, transactions and candidate order.
 */
export function compareQuotes(a: VenueQuote, b: VenueQuote, prefer: readonly ProtocolId[], order: readonly ProtocolAdapter[]): number {
  const eligible = Number(a.excluded !== undefined) - Number(b.excluded !== undefined);
  if (eligible !== 0) return eligible;
  const preferred = Number(preferenceIndex(prefer, a.protocol) === prefer.length) - Number(preferenceIndex(prefer, b.protocol) === prefer.length);
  if (preferred !== 0) return preferred;
  const netA = a.netMinimum ?? -1n;
  const netB = b.netMinimum ?? -1n;
  if (netA !== netB) return netA > netB ? -1 : 1;
  if (a.planned.estimatedSeconds !== b.planned.estimatedSeconds) return a.planned.estimatedSeconds - b.planned.estimatedSeconds;
  if (a.planned.transactionCount !== b.planned.transactionCount) return a.planned.transactionCount - b.planned.transactionCount;
  return order.indexOf(a.adapter) - order.indexOf(b.adapter);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PlatformError("VENUE_TIMEOUT", `${label} did not quote within ${Math.round(timeoutMs / 1000)} s.`, 504)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Builds the ranked view of one plan result (eligibility and net output). */
export async function venueQuote(adapter: ProtocolAdapter, action: AdapterAction, planned: PlannedStep, maxSeconds: number): Promise<VenueQuote> {
  const protocol = planned.protocol;
  const netMinimum = await netMinimumOutput(planned).catch(() => null);
  const slow = planned.estimatedSeconds > maxSeconds;
  const excluded = !sameAsset(planned.minimumOutput, action.output)
    ? "asset" as const
    : (planned.extraCosts?.length ?? 0) > 0 && netMinimum === null
      ? "unpriced" as const
      : slow
        ? "slow" as const
        : undefined;
  return { adapter, protocol, planned, netMinimum, slow, ...(excluded ? { excluded } : {}) };
}

function minutes(seconds: number): string {
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
}

/** One-line description of a quote for evidence and warnings. */
export function describeQuote(quote: VenueQuote): string {
  const minimum = quote.planned.minimumOutput;
  const name = getProtocol(quote.protocol)?.name ?? quote.adapter.label;
  const net = quote.netMinimum !== null && (quote.planned.extraCosts?.length ?? 0) > 0
    ? ` (net ${fromBaseUnits(quote.netMinimum < 0n ? 0n : quote.netMinimum, minimum.decimals)} after ${quote.planned.extraCosts?.map((cost) => `${cost.formatted} ${cost.symbol}`).join(" + ")})`
    : "";
  return `${name}: ${minimum.formatted} ${minimum.symbol} guaranteed${net}, ~${minutes(quote.planned.estimatedSeconds)}, ${quote.planned.transactionCount} transaction(s)`;
}

const EXCLUSION_REASON: Readonly<Record<NonNullable<VenueQuote["excluded"]>, string>> = {
  slow: "slower than the time limit",
  unpriced: "its extra costs could not be priced",
  asset: "it delivers a different asset",
};

export function exclusionReason(quote: VenueQuote): string | null {
  return quote.excluded ? EXCLUSION_REASON[quote.excluded] : null;
}

/**
 * Plans `action` with every candidate and picks the winner. With a single
 * candidate there is no auction (and no timeout); the caller's own time limit
 * still applies, and a quote for another asset is never kept.
 */
export async function runVenueAuction(
  candidates: readonly ProtocolAdapter[],
  action: AdapterAction,
  options: AuctionOptions,
): Promise<AuctionResult> {
  if (candidates.length === 0) throw new PlatformError("ROUTE_UNSUPPORTED", "No venue can serve this step.", 422);
  const timeoutMs = options.timeoutMs ?? venueQuoteTimeoutMs;
  const single = candidates.length === 1;
  const settled = await Promise.allSettled(
    candidates.map((adapter) =>
      single ? adapter.plan(action) : withTimeout(adapter.plan(action), timeoutMs, adapter.label)),
  );
  const quotes: VenueQuote[] = [];
  const failures: VenueFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const adapter = candidates[index] as ProtocolAdapter;
    if (result.status === "rejected") {
      failures.push({ adapter, protocol: effectiveProtocol(adapter, action), error: toPlatformError(result.reason) });
      continue;
    }
    quotes.push(await venueQuote(adapter, action, result.value, options.maxSeconds));
  }
  quotes.sort((a, b) => compareQuotes(a, b, options.prefer, candidates));
  const warnings: string[] = [];
  let winner = quotes.find((quote) => quote.excluded === undefined);
  if (!winner) {
    // The caller's own time limit refuses every slower quote, whatever else also excludes it.
    const kept = quotes.filter((quote) => quote.excluded !== "asset" && !(options.explicitMaxSeconds && quote.slow));
    // A sole venue is kept despite unpriced costs; in an auction only a slow quote (under the default limit) may still win.
    winner = single ? kept[0] : kept.find((quote) => quote.excluded === "slow");
    const slow = quotes.filter((quote) => quote.slow && quote.excluded !== "asset");
    if (!winner && slow.length > 0 && options.explicitMaxSeconds) {
      throw new PlatformError(
        "ROUTE_TOO_SLOW",
        `Every venue needs longer than constraints.maxSeconds (${options.maxSeconds} s): ${slow.map(describeQuote).join("; ")}.`,
        422,
        [{ path: "constraints.maxSeconds", message: "No route settles in time." }],
      );
    }
    if (winner?.slow) {
      warnings.push(`Settlement is estimated at ~${minutes(winner.planned.estimatedSeconds)}, above the default ${minutes(options.maxSeconds)}; no faster venue quoted this route.`);
    }
    if (winner?.excluded === "unpriced") warnings.push("The venue's extra costs could not be priced in the output asset.");
  }
  if (!winner) {
    if (quotes.some((quote) => quote.excluded === "unpriced")) {
      throw new PlatformError("ROUTE_UNPRICED", "No venue quoted this route with costs Kletia can price.", 422);
    }
    if (quotes.some((quote) => quote.excluded === "asset")) {
      throw new PlatformError("ROUTE_UNSUPPORTED", "The venues quoted a different output asset than requested.", 422);
    }
    throw failures[0]?.error ?? new PlatformError("ROUTE_UNSUPPORTED", "No venue can serve this step.", 422);
  }
  const selected = winner;
  return { winner: selected, losers: quotes.filter((quote) => quote !== selected), failures, warnings };
}
