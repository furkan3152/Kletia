/**
 * Multi-venue auction for cross-network steps and same-network swaps or
 * stakes with several candidate venues (design B.1, B.2). Every candidate
 * plans the same action in parallel; quotes are ranked by the route score
 * of routing/score.ts (expected value delivered after gas, fees, time,
 * signatures, venue risk and the non-fill cost of solver-filled legs), never
 * by the guaranteed floor alone (RC2). Floors decide eligibility:
 *
 * - the quoted output asset is the requested one;
 * - the floor is within the request's slippage of the expected output;
 * - extra costs can be priced (with the output's or input's price, the
 *   native price or the oracle; RC3);
 * - the estimate is within `maxSeconds`.
 *
 * Preferred protocols (`constraints.preferProtocols`) win whenever one of
 * them is eligible. A wrap or unwrap of the gas asset on its own network is
 * never auctioned: the wrap venue alone serves it (D10).
 *
 * Mechanics (B.2): a per-venue hard timeout (6 s, never beyond the request's
 * remaining budget, routing/deadline.ts); a soft deadline (2.5 s) after which
 * ranking proceeds once a complete quote has arrived, pending venues being
 * listed as "did not answer in time"; one retry of a 429 that asks to wait at
 * most 1 s when more than 2 s of budget remain; the circuit breaker of
 * routing/venueStats.ts (transport errors, 5xx, 429 and timeouts only) skips
 * a failing venue while another candidate remains; identical concurrent
 * requests share one provider call (full request key, routing/quoteCache.ts).
 * The result carries a snapshot of every score input (I9).
 *
 * A sole candidate has no per-venue timeout (only the request budget) and is
 * kept despite unpriced costs, a slow estimate under the default limit or a
 * floor looser than the default slippage (each with a warning); the
 * caller's own `maxSeconds` or `maxSlippageBps` still refuses it. A leg
 * planned with gas on arrival admits only venues that deliver it.
 * POST /v1/quotes ranks with the same functions.
 */
import {
  CHAINS,
  fromBaseUnits,
  getProtocol,
  type AssetAmount,
  type ProtocolId,
  type RoutePreference,
  type RouteScore,
} from "@kletia/core";
import { PlatformError, toPlatformError } from "../errors.js";
import { effectiveProtocol } from "./adapters/registry.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "./adapters/types.js";
import { assetFromRef, sameAsset, type ResolvedAsset } from "./assets.js";
import { budgetMs, raceBudget, remainingMs } from "./routing/deadline.js";
import { coalescedPlan, isNeutralAccount, neutralPrescreenAction, rememberPrescreen, recallPrescreen } from "./routing/quoteCache.js";
import {
  amountUsd,
  cancelGasUsd,
  extraCostsOutUnits,
  extraCostsUsd,
  floorWithinSlippage,
  legGasUsd,
  nonFillCostUsd,
  rankingGasPrice,
  readAssetUsd,
  readGasPriceWei,
  readNativeUsd,
  scoreLeg,
  selectRoute,
  wholeUnits,
  type RankEntry,
} from "./routing/score.js";
import { recordQuote, shouldSkipVenue } from "./routing/venueStats.js";

/** Default `constraints.maxSeconds`: slower routes win only when the caller opts in. */
export const DEFAULT_MAX_SECONDS = 600;
/** Hard per-venue planning timeout inside an auction (a single candidate has none). */
export const VENUE_QUOTE_TIMEOUT_MS = 6_000;
/** After this long, ranking proceeds once a complete quote has arrived (D6). */
export const SOFT_DEADLINE_MS = 2_500;
/** A 429 is retried once when it asks to wait at most this long ... */
const RETRY_AFTER_MAX_SECONDS = 1;
/** ... and more than this much of the request budget remains. */
const RETRY_MIN_BUDGET_MS = 2_000;

let venueQuoteTimeoutMs = VENUE_QUOTE_TIMEOUT_MS;
let softDeadlineMs = SOFT_DEADLINE_MS;

/** Overrides the per-venue quote timeout (tests, embedders); `null` restores the default. */
export function configureVenueQuoteTimeout(timeoutMs: number | null): void {
  venueQuoteTimeoutMs = timeoutMs === null ? VENUE_QUOTE_TIMEOUT_MS : Math.max(1, Math.floor(timeoutMs));
}

/** Overrides the soft deadline (tests); `null` restores the default. */
export function configureAuctionSoftDeadline(ms: number | null): void {
  softDeadlineMs = ms === null ? SOFT_DEADLINE_MS : Math.max(0, Math.floor(ms));
}

export interface AuctionOptions {
  readonly maxSeconds: number;
  /** True when the caller set `constraints.maxSeconds` (slow quotes are then refused, never kept). */
  readonly explicitMaxSeconds: boolean;
  readonly prefer: readonly ProtocolId[];
  readonly timeoutMs?: number;
  /** True when the caller set `constraints.maxSlippageBps` (a looser floor is then refused, never kept). */
  readonly explicitSlippage?: boolean;
  /** `constraints.routePreference` (default "value"). */
  readonly preference?: RoutePreference;
  /**
   * Pre-screen mode (composer): cached quotes of the last 10 s rank as
   * estimates, and the top two are re-quoted fresh before the choice; the
   * winner is always fresh.
   */
  readonly prescreen?: boolean;
  /** Collects every provider request this auction sends (also when it refuses), for `providersContacted`. */
  readonly contacts?: QuoteContact[];
}

export type ExclusionReason = "slow" | "unpriced" | "asset" | "floor";

export interface VenueQuote {
  readonly adapter: ProtocolAdapter;
  readonly protocol: ProtocolId;
  readonly planned: PlannedStep;
  /** Guaranteed output minus extra costs, in output base units; null when the extra costs are unpriced. */
  readonly netMinimum: bigint | null;
  /** Why the quote cannot win; absent when eligible. */
  readonly excluded?: ExclusionReason;
  /** Slower than the time limit, whatever else excludes it (an explicit limit refuses every slow quote). */
  readonly slow: boolean;
  /** Ranking value: USD (B.1), or output units when neither side can be priced. */
  readonly value: number;
  /** The route score (USD terms; zeros in units mode). */
  readonly score: RouteScore;
  readonly haircutBps: number;
  readonly pFill: number;
  /**
   * USD expected to arrive before costs (expectedEff x (1 - haircut) x price;
   * B.1's first term), or null in units mode. `arrivingUsd - value` is what
   * the leg costs; the composer (routing/composer.ts) chains it across legs.
   */
  readonly arrivingUsd: number | null;
  /** A cached pre-screen quote scaled to this amount: ranked, never planned. */
  readonly estimate?: true;
}

export interface VenueFailure {
  readonly adapter: ProtocolAdapter;
  readonly protocol: ProtocolId;
  readonly error: PlatformError;
  /** Still pending at the soft deadline ("did not answer in time"). */
  readonly cut?: true;
  /** Skipped by the circuit breaker (not asked). */
  readonly skipped?: true;
}

/** Every score input of one auction (I9): the plan record keeps it in `interpretation.routes[].snapshot`. */
export interface AuctionSnapshot {
  readonly quotes: readonly { readonly venue: ProtocolId; readonly id?: string; readonly expected: string; readonly minimum: string; readonly at: number; readonly estimate?: true }[];
  readonly cutByDeadline: readonly ProtocolId[];
  readonly breakerSkipped: readonly ProtocolId[];
  readonly haircutsBps: Readonly<Record<string, number>>;
  /** Gas facts: `<network>` wei per gas used for ranking, `<network>:usd` its native price. */
  readonly gas: Readonly<Record<string, string>>;
  /** Fill rates used for solver-filled venues (P_fill). */
  readonly fillRates: Readonly<Record<string, number>>;
  /** USD prices per whole token used: `in`, `out` (absent when unknown). */
  readonly prices: Readonly<Record<string, number>>;
  readonly mode: "usd" | "units";
}

/** A provider that received a quote request, and whether it carried the person's account. */
export interface QuoteContact {
  readonly protocol: ProtocolId;
  readonly sawAccount: boolean;
}

export interface AuctionResult {
  readonly winner: VenueQuote;
  /** Every other quote, best first. */
  readonly losers: readonly VenueQuote[];
  readonly failures: readonly VenueFailure[];
  readonly warnings: readonly string[];
  readonly snapshot: AuctionSnapshot;
  readonly contacted: readonly QuoteContact[];
  /** USD value of the input, when priced. */
  readonly inputUsd: number | null;
}

/* ------------------------------------------------------------ net minimum */

/**
 * The quote's guaranteed output net of extra costs, in output base units.
 * Extra costs in the output asset subtract exactly; others are converted
 * through USD prices (the output's own price when the quote gives none) and
 * rounded against the venue. Null when a cost cannot be priced.
 */
export async function netMinimumOutput(
  planned: Pick<PlannedStep, "minimumOutput" | "extraCosts">,
  outputPrice?: number | null,
): Promise<bigint | null> {
  const minimum = BigInt(planned.minimumOutput.amount);
  const costs = planned.extraCosts ?? [];
  if (costs.length === 0) return minimum;
  let output: ResolvedAsset;
  try {
    output = assetFromRef(planned.minimumOutput);
  } catch {
    return null;
  }
  let total = 0n;
  let price: number | null | undefined = outputPrice ?? undefined;
  for (const cost of costs) {
    if (!/^\d+$/u.test(cost.amount)) return null;
    if (sameAsset(cost, planned.minimumOutput)) {
      total += BigInt(cost.amount);
      continue;
    }
    price ??= unitPriceOf(planned.minimumOutput) ?? (await readAssetUsd(output));
    const usd = await extraCostsUsd([cost], { asset: output, price }, { asset: output, price });
    if (price === null || price <= 0 || usd === null) return null;
    const units = Math.ceil((usd / price) * 10 ** planned.minimumOutput.decimals);
    if (!Number.isFinite(units)) return null;
    total += BigInt(units);
  }
  return minimum - total;
}

/** USD per whole token implied by an amount's own `usd`, or null. */
function unitPriceOf(amount: AssetAmount): number | null {
  if (amount.usd === undefined || !Number.isFinite(amount.usd) || amount.amount === "0") return null;
  const units = wholeUnits(amount.amount, amount.decimals);
  return units > 0 ? amount.usd / units : null;
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/* ---------------------------------------------------------------- display */

function preferenceIndex(prefer: readonly ProtocolId[], protocol: ProtocolId): number {
  const index = prefer.indexOf(protocol);
  return index === -1 ? prefer.length : index;
}

/**
 * Orders quotes best first by their ranking value (exact ordering, no tie
 * margins): eligible before excluded, preferred first, then value, fewer
 * signatures, fewer seconds, on-chain floors, candidate order. The winner
 * itself comes from `selectRoute` (margins and the multi-signature rule).
 */
export function compareQuotes(a: VenueQuote, b: VenueQuote, prefer: readonly ProtocolId[], order: readonly ProtocolAdapter[]): number {
  const eligible = Number(a.excluded !== undefined) - Number(b.excluded !== undefined);
  if (eligible !== 0) return eligible;
  const preferred = Number(preferenceIndex(prefer, a.protocol) === prefer.length) - Number(preferenceIndex(prefer, b.protocol) === prefer.length);
  if (preferred !== 0) return preferred;
  if (a.value !== b.value) return b.value > a.value ? 1 : -1;
  if (a.planned.transactionCount !== b.planned.transactionCount) return a.planned.transactionCount - b.planned.transactionCount;
  if (a.planned.estimatedSeconds !== b.planned.estimatedSeconds) return a.planned.estimatedSeconds - b.planned.estimatedSeconds;
  const floor = (quote: VenueQuote) => (quote.planned.floor === "onchain" ? 0 : 1);
  if (floor(a) !== floor(b)) return floor(a) - floor(b);
  return order.indexOf(a.adapter) - order.indexOf(b.adapter);
}

function minutes(seconds: number): string {
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
}

/** One-line description of a quote for evidence and warnings. */
export function describeQuote(quote: VenueQuote): string {
  const minimum = quote.planned.minimumOutput;
  const expected = quote.planned.expectedOutput;
  const name = getProtocol(quote.protocol)?.name ?? quote.adapter.label;
  const net = quote.netMinimum !== null && (quote.planned.extraCosts?.length ?? 0) > 0
    ? ` (net ${fromBaseUnits(quote.netMinimum < 0n ? 0n : quote.netMinimum, minimum.decimals)} after ${quote.planned.extraCosts?.map((cost) => `${cost.formatted} ${cost.symbol}`).join(" + ")})`
    : "";
  const kind = quote.planned.floor === "onchain" ? "guaranteed" : "quoted minimum";
  const value = quote.score.valueUsd !== 0 || quote.score.expectedUsd !== 0 ? `, value $${quote.score.valueUsd.toFixed(2)}` : "";
  const estimate = quote.estimate ? " (estimate)" : "";
  return `${name}: ${expected.formatted} ${expected.symbol} expected, ${minimum.formatted} ${minimum.symbol} ${kind}${net}${value}, ~${minutes(quote.planned.estimatedSeconds)}, ${quote.planned.transactionCount} transaction(s)${estimate}`;
}

const EXCLUSION_REASON: Readonly<Record<ExclusionReason, string>> = {
  slow: "slower than the time limit",
  unpriced: "its extra costs could not be priced",
  asset: "it delivers a different asset",
  floor: "its minimum is looser than the slippage limit",
};

export function exclusionReason(quote: VenueQuote): string | null {
  return quote.excluded ? EXCLUSION_REASON[quote.excluded] : null;
}

/* ------------------------------------------------------------- quoting */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSeconds(error: unknown): number | null {
  const seconds = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
}

/**
 * One venue's plan: coalesced with identical concurrent requests, one retry
 * of a short 429 when the budget allows, statistics recorded (latency,
 * counted failures for the breaker).
 */
async function quoteVenue(adapter: ProtocolAdapter, action: AdapterAction, protocol: ProtocolId): Promise<PlannedStep> {
  const started = Date.now();
  const record = (error?: unknown) => recordQuote(protocol, action.network, action.destinationNetwork, { ms: Date.now() - started, ...(error !== undefined ? { error } : {}) });
  try {
    let planned: PlannedStep;
    try {
      planned = await coalescedPlan(adapter, action);
    } catch (error) {
      const platform = toPlatformError(error);
      const wait = retryAfterSeconds(error);
      if (platform.code !== "PROVIDER_RATE_LIMITED" || wait === null || wait > RETRY_AFTER_MAX_SECONDS || remainingMs() <= RETRY_MIN_BUDGET_MS) throw error;
      await sleep(wait * 1000);
      planned = await coalescedPlan(adapter, action);
    }
    record();
    return planned;
  } catch (error) {
    record(error);
    throw error;
  }
}

interface Outcome {
  readonly adapter: ProtocolAdapter;
  readonly protocol: ProtocolId;
  readonly action: AdapterAction;
  readonly planned?: PlannedStep;
  readonly error?: PlatformError;
  readonly cut?: true;
  readonly estimate?: true;
  readonly at: number;
}

/**
 * Quotes `candidates` in parallel under the hard and soft deadlines. A sole
 * candidate waits for its own adapter (within the request budget).
 */
async function collect(candidates: readonly { readonly adapter: ProtocolAdapter; readonly action: AdapterAction }[], route: AdapterAction, options: AuctionOptions): Promise<Outcome[]> {
  const single = candidates.length === 1;
  const hardMs = options.timeoutMs ?? venueQuoteTimeoutMs;
  // Dense on purpose: `every` / `some` skip the holes of a sparse array.
  const outcomes: (Outcome | undefined)[] = Array.from({ length: candidates.length }, () => undefined);
  let release: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let softPassed = single;
  const complete = (outcome: Outcome | undefined) => outcome?.planned !== undefined && sameAsset(outcome.planned.minimumOutput, route.output);
  const check = () => {
    if (outcomes.every((outcome) => outcome !== undefined)) release();
    else if (softPassed && outcomes.some(complete)) release();
  };
  candidates.forEach(({ adapter, action }, index) => {
    const protocol = effectiveProtocol(adapter, action);
    const label = adapter.label;
    const timeout = () => new PlatformError("VENUE_TIMEOUT", `${label} did not quote within ${Math.round(hardMs / 1000)} s.`, 504);
    const running = quoteVenue(adapter, action, protocol);
    const limited = single ? raceBudget(running, Number.POSITIVE_INFINITY, timeout) : raceBudget(running, hardMs, timeout);
    limited.then(
      (planned) => {
        outcomes[index] ??= { adapter, protocol, action, planned, at: Date.now() };
        check();
      },
      (error: unknown) => {
        outcomes[index] ??= { adapter, protocol, action, error: toPlatformError(error), at: Date.now() };
        check();
      },
    );
  });
  const softTimer = single ? undefined : setTimeout(() => {
    softPassed = true;
    check();
  }, Math.max(0, Math.min(softDeadlineMs, budgetMs(softDeadlineMs))));
  try {
    await done;
  } finally {
    if (softTimer) clearTimeout(softTimer);
  }
  return candidates.map(({ adapter, action }, index) => outcomes[index] ?? {
    adapter,
    protocol: effectiveProtocol(adapter, action),
    action,
    error: new PlatformError("VENUE_TIMEOUT", `${adapter.label} did not answer in time.`, 504),
    cut: true,
    at: Date.now(),
  });
}

/* -------------------------------------------------------------- scoring */

interface ScoreFactsRead {
  readonly priceIn: number | null;
  readonly priceOut: number | null;
  readonly gasPriceWei: bigint | null;
  readonly nativeUsd: number | null;
  readonly destinationGasPriceWei: bigint | null;
  readonly destinationNativeUsd: number | null;
}

async function readScoreFacts(action: AdapterAction, needDestination: boolean): Promise<ScoreFactsRead> {
  const cross = action.network !== action.destinationNetwork;
  const sameIo = sameAsset(action.input, action.output);
  const [priceIn, priceOut, gasPriceWei, nativeUsd, destinationGasPriceWei, destinationNativeUsd] = await Promise.all([
    readAssetUsd(action.input),
    sameIo ? Promise.resolve<number | null>(null) : readAssetUsd(action.output),
    readGasPriceWei(action.network),
    readNativeUsd(action.network),
    cross && needDestination ? readGasPriceWei(action.destinationNetwork) : Promise.resolve(null),
    cross && needDestination ? readNativeUsd(action.destinationNetwork) : Promise.resolve(null),
  ]);
  return { priceIn, priceOut: sameIo ? priceIn : priceOut, gasPriceWei, nativeUsd, destinationGasPriceWei, destinationNativeUsd };
}

interface ScoredSet {
  readonly quotes: VenueQuote[];
  readonly inputUsd: number | null;
  readonly priceIn: number | null;
  readonly priceOut: number | null;
  readonly mode: "usd" | "units";
  readonly gas: Record<string, string>;
}

/** Scores every planned outcome against the action (B.1 terms and eligibility). */
async function scoreOutcomes(outcomes: readonly Outcome[], action: AdapterAction, options: AuctionOptions, factsRead: ScoreFactsRead): Promise<ScoredSet> {
  const planned = outcomes.filter((outcome): outcome is Outcome & { planned: PlannedStep } => outcome.planned !== undefined);
  const amount = wholeUnits(action.amount, action.input.decimals);
  // Prices: the facts first, then what the quotes state, then the output implied by the input and the best quote.
  const priceIn = factsRead.priceIn ?? median(planned.map(({ planned: step }) => unitPriceOf(step.input) ?? Number.NaN));
  const inputUsd = priceIn !== null && amount > 0 ? amount * priceIn : null;
  const asked = planned.filter(({ planned: step }) => sameAsset(step.minimumOutput, action.output));
  const quotedOut = median(asked.map(({ planned: step }) => unitPriceOf(step.expectedOutput) ?? Number.NaN));
  const bestExpected = asked.reduce((best, { planned: step }) => Math.max(best, wholeUnits(step.expectedOutput.amount, step.expectedOutput.decimals)), 0);
  const impliedOut = inputUsd !== null && bestExpected > 0 ? inputUsd / bestExpected : null;
  const priceOut = factsRead.priceOut ?? quotedOut ?? impliedOut;
  const mode: "usd" | "units" = priceOut === null ? "units" : "usd";
  const preference = options.preference ?? "value";
  const slippageBps = action.slippageBps;
  const liveGas = factsRead.gasPriceWei;
  const gasPrice = rankingGasPrice(action.network, liveGas);
  const gas: Record<string, string> = {};
  if (gasPrice !== null) gas[action.network] = gasPrice.toString();
  if (factsRead.nativeUsd !== null) gas[`${action.network}:usd`] = String(factsRead.nativeUsd);
  if (factsRead.destinationGasPriceWei !== null) gas[action.destinationNetwork] = factsRead.destinationGasPriceWei.toString();
  if (factsRead.destinationNativeUsd !== null) gas[`${action.destinationNetwork}:usd`] = String(factsRead.destinationNativeUsd);
  const quotes: VenueQuote[] = [];
  for (const outcome of planned) {
    const step = outcome.planned;
    const assetOk = sameAsset(step.minimumOutput, action.output);
    const expected = BigInt(step.expectedOutput.amount);
    const minimum = BigInt(step.minimumOutput.amount);
    const costs = step.extraCosts ?? [];
    const outputAsset = action.output;
    const expectedUnits = wholeUnits(expected, step.expectedOutput.decimals);
    const minimumUnits = wholeUnits(minimum, step.minimumOutput.decimals);
    const costsUsd = costs.length === 0 ? 0 : await extraCostsUsd(costs, { asset: outputAsset, price: priceOut }, { asset: action.input, price: priceIn });
    const quoteRate = amount > 0 ? expectedUnits / amount : Number.NaN;
    const costsOut = costs.length === 0 ? 0 : extraCostsOutUnits(costs, outputAsset, action.input, quoteRate);
    const unpriced = costs.length > 0 && (mode === "usd" ? costsUsd === null : costsOut === null);
    const netMinimum = await netMinimumOutput(step, priceOut).catch(() => null);
    const slow = step.estimatedSeconds > options.maxSeconds;
    const floorOk = !assetOk || floorWithinSlippage(expected, minimum, slippageBps);
    const gasUsd = legGasUsd({
      network: action.network,
      kind: action.kind,
      venue: step.protocol,
      nativeInput: action.input.isNative,
      transactions: step.transactionCount,
      gasPriceWei: gasPrice,
      nativeUsd: factsRead.nativeUsd,
    }) ?? 0;
    const scored = scoreLeg({
      venue: step.protocol,
      kind: action.kind,
      network: action.network,
      destination: action.destinationNetwork,
      expectedUnits,
      minimumUnits,
      floor: step.floor ?? "claimed",
      priceOut,
      inputUsd,
      extraCostsUsd: costsUsd ?? 0,
      extraCostsOutUnits: costsOut ?? 0,
      gasUsd,
      seconds: step.estimatedSeconds,
      signatures: step.transactionCount,
      sameAssetGroup: action.input.group !== undefined && action.input.group === action.output.group,
      preference,
      nonFillCostUsd: nonFillCostUsd({
        venue: step.protocol,
        sourceGasUsd: gasUsd,
        destinationCancelUsd: cancelGasUsd(action.destinationNetwork, factsRead.destinationGasPriceWei, factsRead.destinationNativeUsd),
        preference,
      }),
      strandCostUsd: 0,
    });
    // D2: a declared fallback asset ranks the quote at the lower of the two values; an unpriceable one excludes it.
    const fallback = step.fallbackOutput && !sameAsset(step.fallbackOutput, outputAsset) ? await fallbackValue(step.fallbackOutput, scored, priceOut) : null;
    const fallbackOk = !step.fallbackOutput || sameAsset(step.fallbackOutput, outputAsset) || fallback !== null;
    const value = fallback !== null ? Math.min(scored.value, fallback) : scored.value;
    const excluded: ExclusionReason | undefined = !assetOk || !fallbackOk ? "asset" : unpriced ? "unpriced" : !floorOk ? "floor" : slow ? "slow" : undefined;
    quotes.push({
      adapter: outcome.adapter,
      protocol: outcome.protocol,
      planned: step,
      netMinimum,
      slow,
      value,
      score: { ...scored.score, ...(value !== scored.value ? { valueUsd: Math.round(value * 10_000) / 10_000 } : {}), ...(outcome.estimate ? { estimate: true as const } : {}) },
      haircutBps: scored.haircutBps,
      pFill: scored.pFill,
      arrivingUsd: scored.mode === "usd" && priceOut !== null ? scored.expectedEffUnits * (1 - scored.haircutBps / 10_000) * priceOut : null,
      ...(outcome.estimate ? { estimate: true as const } : {}),
      ...(excluded ? { excluded } : {}),
    });
  }
  return { quotes, inputUsd, priceIn, priceOut, mode, gas };
}

/**
 * The value of a quote if it delivers its declared fallback instead (D2):
 * the fallback's USD worth minus what the leg costs. Null when the fallback
 * or the leg cannot be priced in USD.
 */
async function fallbackValue(fallback: AssetAmount, scored: { readonly value: number; readonly mode: "usd" | "units"; readonly expectedEffUnits: number; readonly haircutBps: number }, priceOut: number | null): Promise<number | null> {
  if (scored.mode !== "usd" || priceOut === null || !/^\d+$/u.test(fallback.amount)) return null;
  let asset: ResolvedAsset;
  try {
    asset = assetFromRef(fallback);
  } catch {
    return null;
  }
  const price = fallback.usd !== undefined && Number.isFinite(fallback.usd) ? null : await readAssetUsd(asset);
  const usd = fallback.usd !== undefined && Number.isFinite(fallback.usd) ? fallback.usd : price === null ? null : wholeUnits(fallback.amount, fallback.decimals) * price;
  if (usd === null || !Number.isFinite(usd)) return null;
  const arriving = scored.expectedEffUnits * (1 - scored.haircutBps / 10_000) * priceOut;
  return usd - (arriving - scored.value);
}

function rankEntries(quotes: readonly VenueQuote[], options: AuctionOptions, order: readonly ProtocolAdapter[], mode: "usd" | "units"): RankEntry<VenueQuote>[] {
  return quotes.map((quote) => ({
    item: quote,
    value: quote.value,
    mode,
    eligible: quote.excluded === undefined,
    preferred: options.prefer.includes(quote.protocol),
    signatures: quote.planned.transactionCount,
    seconds: quote.planned.estimatedSeconds,
    onchainFloor: quote.planned.floor === "onchain",
    order: order.indexOf(quote.adapter),
    ...(quote.estimate ? { estimate: true } : {}),
  }));
}

/* ---------------------------------------------------------------- auction */

/** Candidates after the gas top-up filter, the wrap short-circuit and the breaker. */
function screenCandidates(offered: readonly ProtocolAdapter[], action: AdapterAction): { candidates: ProtocolAdapter[]; skipped: ProtocolAdapter[] } {
  let candidates = [...offered];
  // A leg with gas on arrival competes only among venues that deliver it (journey gas on arrival).
  if (action.gasTopupUsd !== undefined) {
    candidates = candidates.filter((adapter) => adapter.supportsGasTopup?.(action) === true);
    if (candidates.length === 0) {
      throw new PlatformError("GAS_TOPUP_UNAVAILABLE", "No venue can deliver gas with this leg (constraints.gasOnArrival).", 422);
    }
  }
  if (candidates.length === 0) throw new PlatformError("ROUTE_UNSUPPORTED", "No venue can serve this step.", 422);
  // Wrapping the gas asset is a 1:1 call on the canonical contract, never an auction (D10).
  const wrap = candidates.find((adapter) => effectiveProtocol(adapter, action) === "wrap");
  if (wrap) return { candidates: [wrap], skipped: [] };
  if (candidates.length === 1) return { candidates, skipped: [] };
  const now = Date.now();
  const open = candidates.filter((adapter) => shouldSkipVenue(effectiveProtocol(adapter, action), action.network, action.destinationNetwork, now));
  // The breaker never empties an auction: with every venue failing, they are all asked.
  if (open.length === 0 || open.length === candidates.length) return { candidates, skipped: [] };
  return { candidates: candidates.filter((adapter) => !open.includes(adapter)), skipped: open };
}

function contactOf(outcome: Outcome): QuoteContact {
  return { protocol: outcome.protocol, sawAccount: !isNeutralAccount(outcome.action.account) };
}

/** Everything one auction found, before a refusal is decided. */
interface AuctionCore {
  readonly candidates: readonly ProtocolAdapter[];
  readonly single: boolean;
  /** Every scored quote, the selected winner first (when one is eligible), then by value. */
  readonly quotes: readonly VenueQuote[];
  /** The eligible winner (B.1 selection), or null. */
  readonly winner: VenueQuote | null;
  readonly failures: readonly VenueFailure[];
  readonly snapshot: AuctionSnapshot;
  readonly contacted: readonly QuoteContact[];
  readonly inputUsd: number | null;
}

async function auctionCore(offered: readonly ProtocolAdapter[], action: AdapterAction, options: AuctionOptions): Promise<AuctionCore> {
  const { candidates, skipped } = screenCandidates(offered, action);
  const single = candidates.length === 1;
  const facts = readScoreFacts(action, candidates.some((adapter) => effectiveProtocol(adapter, action) === "debridge-dln"));
  facts.catch(() => undefined);

  // Pre-screen mode (composer, F1, E1): a cached quote of the last 10 s ranks as an estimate instead of being
  // asked again, and a venue whose quote does not depend on the account is asked with the neutral address;
  // both are estimates until the top two are re-quoted with the person's own request below.
  const prescreen = options.prescreen === true && !single;
  const neutral = new Map<ProtocolAdapter, AdapterAction>();
  const cached = new Map<ProtocolAdapter, PlannedStep>();
  if (prescreen) {
    for (const adapter of candidates) {
      const stand = neutralPrescreenAction(adapter, action);
      if (stand) neutral.set(adapter, stand);
      const hit = (stand ? recallPrescreen(adapter, stand) : null) ?? recallPrescreen(adapter, action);
      if (hit) cached.set(adapter, hit);
    }
  }
  const asked = candidates.filter((adapter) => !cached.has(adapter)).map((adapter) => ({ adapter, action: neutral.get(adapter) ?? action }));
  const quoted: Outcome[] = asked.length > 0 ? await collect(asked, action, options) : [];
  options.contacts?.push(...quoted.map(contactOf));
  let outcomes: Outcome[] = quoted.map((outcome) => (outcome.action === action ? outcome : { ...outcome, estimate: true as const }));
  for (const [adapter, planned] of cached) {
    outcomes.push({ adapter, protocol: effectiveProtocol(adapter, action), action, planned, estimate: true, at: Date.now() });
  }
  const factsRead = await facts;
  let scored = await scoreOutcomes(outcomes, action, options, factsRead);
  const select = (quotes: readonly VenueQuote[]) => selectRoute(rankEntries(quotes, options, candidates, scored.mode), {
    inputUsd: scored.inputUsd,
    preference: options.preference ?? "value",
  });

  // The top two are always fresh before the choice; the winner is never an estimate.
  for (let round = 0; round < candidates.length && scored.quotes.some((quote) => quote.estimate); round += 1) {
    const asIfFresh = scored.quotes.map((quote): VenueQuote => {
      const { estimate: _estimate, ...rest } = quote;
      return rest;
    });
    const top = select(asIfFresh).ordered.slice(0, 2).map((entry) => entry.item.adapter);
    const stale = scored.quotes.filter((quote) => quote.estimate && top.includes(quote.adapter));
    if (stale.length === 0) break;
    const requoted = await collect(stale.map((quote) => ({ adapter: quote.adapter, action })), action, options);
    options.contacts?.push(...requoted.map(contactOf));
    quoted.push(...requoted);
    outcomes = [...outcomes.filter((outcome) => !stale.some((quote) => quote.adapter === outcome.adapter)), ...requoted];
    scored = await scoreOutcomes(outcomes, action, options, factsRead);
  }

  // Every quote actually received fills the pre-screen cache under its own request (neutral or the person's).
  for (const outcome of quoted) {
    if (outcome.planned) rememberPrescreen(outcome.adapter, outcome.action, outcome.planned);
  }
  const freshOutcomes = outcomes.filter((outcome) => !outcome.estimate);
  const failures: VenueFailure[] = [
    ...freshOutcomes
      .filter((outcome) => outcome.error !== undefined)
      .map((outcome): VenueFailure => ({ adapter: outcome.adapter, protocol: outcome.protocol, error: outcome.error as PlatformError, ...(outcome.cut ? { cut: true as const } : {}) })),
    ...skipped.map((adapter): VenueFailure => ({
      adapter,
      protocol: effectiveProtocol(adapter, action),
      error: new PlatformError("PROVIDER_UNAVAILABLE", `${adapter.label} is failing right now and was skipped.`, 502),
      skipped: true,
    })),
  ];
  // A leg asked to carry a top-up and quoted without one is never kept (it would arrive without gas).
  const quotes = scored.quotes.filter((quote) => {
    if (action.gasTopupUsd === undefined || quote.planned.gasTopup || quote.estimate) return true;
    failures.push({
      adapter: quote.adapter,
      protocol: quote.protocol,
      error: new PlatformError("PROVIDER_TRANSACTION_INVALID", `${quote.adapter.label} quoted the leg without the gas top-up it was asked for.`, 502),
    });
    return false;
  });
  const { winner, ordered } = select(quotes);
  const snapshot: AuctionSnapshot = {
    quotes: quotes.map((quote) => ({
      venue: quote.protocol,
      ...(quote.planned.quoteId && !quote.estimate ? { id: quote.planned.quoteId } : {}),
      expected: quote.planned.expectedOutput.amount,
      minimum: quote.planned.minimumOutput.amount,
      at: outcomes.find((outcome) => outcome.adapter === quote.adapter)?.at ?? Date.now(),
      ...(quote.estimate ? { estimate: true as const } : {}),
    })),
    cutByDeadline: failures.filter((failure) => failure.cut).map((failure) => failure.protocol),
    breakerSkipped: failures.filter((failure) => failure.skipped).map((failure) => failure.protocol),
    haircutsBps: Object.fromEntries(quotes.map((quote) => [quote.protocol, quote.haircutBps])),
    gas: scored.gas,
    fillRates: Object.fromEntries(quotes.filter((quote) => quote.pFill < 1).map((quote) => [quote.protocol, Math.round(quote.pFill * 10_000) / 10_000])),
    prices: {
      ...(scored.priceIn !== null ? { in: scored.priceIn } : {}),
      ...(scored.priceOut !== null ? { out: scored.priceOut } : {}),
    },
    mode: scored.mode,
  };
  return {
    candidates,
    single,
    quotes: ordered.map((entry) => entry.item),
    winner: winner?.item ?? null,
    failures,
    snapshot,
    contacted: quoted.map(contactOf),
    inputUsd: scored.inputUsd,
  };
}

/**
 * Plans `action` with every candidate and picks the winner (B.1, B.2).
 * Refuses when nothing may win: ROUTE_TOO_SLOW (the caller's maxSeconds),
 * ROUTE_UNPRICED, ROUTE_UNSUPPORTED (other asset, or every floor looser than
 * the caller's maxSlippageBps), else the first venue's own error.
 */
export async function runVenueAuction(
  offered: readonly ProtocolAdapter[],
  action: AdapterAction,
  options: AuctionOptions,
): Promise<AuctionResult> {
  const core = await auctionCore(offered, action, options);
  const warnings: string[] = [];
  const winner = core.winner ?? fallbackWinner(core.quotes.filter((quote) => !quote.estimate), core.single, options, action, warnings);
  if (!winner) throw auctionRefusal(core.quotes, core.failures, options, action);
  return {
    winner,
    losers: core.quotes.filter((quote) => quote !== winner),
    failures: core.failures,
    warnings,
    snapshot: core.snapshot,
    contacted: core.contacted,
    inputUsd: core.inputUsd,
  };
}

/**
 * The winner when nothing is eligible: a sole venue is kept despite unpriced
 * costs, a slow estimate (default limit) or a floor looser than the default
 * slippage; in an auction only a slow or floor-loose quote may still win.
 * The caller's own maxSeconds / maxSlippageBps always refuse.
 */
function fallbackWinner(quotes: readonly VenueQuote[], single: boolean, options: AuctionOptions, action: AdapterAction, warnings: string[]): VenueQuote | null {
  const kept = quotes
    .filter((quote) => quote.excluded !== "asset" && !(options.explicitMaxSeconds && quote.slow) && !(options.explicitSlippage && quote.excluded === "floor"))
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const winner = single ? kept[0] : kept.find((quote) => quote.excluded === "slow" || quote.excluded === "floor");
  if (!winner) return null;
  if (winner.slow) {
    warnings.push(`Settlement is estimated at ~${minutes(winner.planned.estimatedSeconds)}, above the default ${minutes(options.maxSeconds)}; no faster venue quoted this route.`);
  }
  if (winner.excluded === "unpriced") warnings.push("The venue's extra costs could not be priced in the output asset.");
  if (winner.excluded === "floor") {
    const minimum = winner.planned.minimumOutput;
    warnings.push(`${getProtocol(winner.protocol)?.name ?? winner.adapter.label} guarantees at least ${minimum.formatted} ${minimum.symbol}, a looser minimum than the ${action.slippageBps} bps slippage limit; no venue quoted a tighter one.`);
  }
  return winner;
}

function auctionRefusal(quotes: readonly VenueQuote[], failures: readonly VenueFailure[], options: AuctionOptions, action: AdapterAction): PlatformError {
  const slow = quotes.filter((quote) => quote.slow && quote.excluded !== "asset");
  if (slow.length > 0 && options.explicitMaxSeconds) {
    return new PlatformError(
      "ROUTE_TOO_SLOW",
      `Every venue needs longer than constraints.maxSeconds (${options.maxSeconds} s): ${slow.map(describeQuote).join("; ")}.`,
      422,
      [{ path: "constraints.maxSeconds", message: "No route settles in time." }],
    );
  }
  if (quotes.some((quote) => quote.excluded === "unpriced")) {
    return new PlatformError("ROUTE_UNPRICED", "No venue quoted this route with costs Kletia can price.", 422);
  }
  if (quotes.some((quote) => quote.excluded === "floor") && options.explicitSlippage) {
    return new PlatformError(
      "ROUTE_UNSUPPORTED",
      `Every venue's guaranteed minimum is looser than constraints.maxSlippageBps (${action.slippageBps} bps).`,
      422,
      [{ path: "constraints.maxSlippageBps", message: "No venue guarantees this slippage." }],
    );
  }
  if (quotes.some((quote) => quote.excluded === "asset")) {
    return new PlatformError("ROUTE_UNSUPPORTED", "The venues quoted a different output asset than requested.", 422);
  }
  const asked = failures.filter((failure) => !failure.skipped && !failure.cut);
  return asked[0]?.error ?? failures[0]?.error ?? new PlatformError("ROUTE_UNSUPPORTED", "No venue can serve this step.", 422);
}

/* ---------------------------------------------------- POST /v1/quotes view */

export interface QuoteCollection {
  /** Every quote, best first (the auction's own order). */
  readonly quotes: readonly VenueQuote[];
  readonly failures: readonly VenueFailure[];
  /** The best route as the auction picks it; a lone route is best unless it delivers another asset or breaks the caller's own limits. */
  readonly best: VenueQuote | null;
}

/**
 * Every route for one movement, ranked like the auction (POST /v1/quotes):
 * the same collection, scoring and selection; nothing is refused, excluded
 * routes are listed with their reason. Throws only when no venue quoted.
 */
export async function collectRankedQuotes(offered: readonly ProtocolAdapter[], action: AdapterAction, options: AuctionOptions): Promise<QuoteCollection> {
  const core = await auctionCore(offered, action, options);
  if (core.quotes.length === 0) throw core.failures[0]?.error ?? new PlatformError("ROUTE_UNSUPPORTED", "No venue can serve this step.", 422);
  const lone = core.quotes.length === 1 ? fallbackWinner(core.quotes, true, options, action, []) : null;
  return { quotes: core.quotes, failures: core.failures, best: core.winner ?? lone };
}
