/**
 * Route composer (design C.2): compares the shapes of one crossing leg
 * X on A -> Y on B with the B.1 score and picks the one to plan.
 *
 * Pre-screen: every shape's legs are quoted in parallel (leg 1 with the real
 * amount; later legs with the amount estimated from prices, or chained from
 * the previous leg's expected output when a price is unknown). Each leg runs
 * the venue auction in pre-screen mode (neutral address where the quote does
 * not depend on the account, 10 s cache, the top two re-quoted fresh), so
 * at most a handful of provider calls per leg.
 *
 * A composite's value chains its legs: what the last leg is expected to
 * deliver, scaled through every earlier leg's expected output, minus every
 * leg's costs (gas, fees, time, venue risk, non-fill), one `lambdaS` per extra
 * signed leg and a strand cost per leg that runs after the crossing (D5). Its
 * minimum is the chained floor: each leg's minimum carried through the next.
 *
 * Eligibility: every leg has an eligible winner; the whole route fits the
 * time limit; a shape that swaps on arrival needs gas on B (or a planned
 * top-up); composites need USD prices (they are never compared in units).
 * Selection: B.1 (`selectRoute`): a route with more signed legs than the best
 * single-leg route must beat it by max($0.50, 3 bps of the input); ties go
 * to fewer signatures, fewer seconds, on-chain floors, then shape order.
 *
 * The composer never plans: the planner plans the chosen shape's legs for
 * real, in order, each funded by the previous leg's minimum.
 */
import type { RoutePreference, RouteScore } from "@kletia/core";
import { toPlatformError, type PlatformError } from "../../errors.js";
import type { AuctionResult } from "../auction.js";
import { isUsdStablecoin, type ResolvedAsset } from "../assets.js";
import { remainingMs } from "./deadline.js";
import { LAMBDA_S_USD, selectRoute, strandCostUsd, wholeUnits, type RankEntry } from "./score.js";
import { swapsOnArrival, type LegSpec, type ShapeCandidate } from "./shapes.js";
import { PRIOR_FILL_RATE } from "./venueStats.js";

/** Composites are pre-screened only while this much of the request budget remains (C.6). */
export const COMPOSER_MIN_BUDGET_MS = 5_000;
/** The runner-up is planned instead only while this much budget remains (C.2 step 3). */
export const RUNNER_UP_MIN_BUDGET_MS = 4_000;
/** The planned winner may fall this far below the runner-up's value before the runner-up is planned (bps of the input). */
export const RUNNER_UP_SWITCH_BPS = 10;
/** A composite's pre-screen waits at most this long (the hard per-venue cap, B.2) ... */
export const COMPOSITE_PRESCREEN_MS = 6_000;
/** ... and always leaves this much of the request budget to plan the chosen shape for real. */
export const PLAN_RESERVE_MS = 4_000;
/** Carrier volatility over a crossing's delay for non-stablecoin carriers (strand cost, D5). */
const CARRIER_VOLATILITY = 0.002;

/** Quotes one leg (an auction, pre-screen mode) for `amount` base units of its input. */
export type LegQuoter = (leg: LegSpec, amount: bigint, index: number) => Promise<AuctionResult>;

export interface ComposeRequest {
  readonly candidates: readonly ShapeCandidate[];
  /** Base units of the crossing's input. */
  readonly amount: bigint;
  readonly quote: LegQuoter;
  readonly preference: RoutePreference;
  /** Longest acceptable total time (constraints.maxSeconds or the default). */
  readonly maxSeconds: number;
  /** Gas on the destination for shapes that swap on arrival: enough, short (known) or unknown. */
  readonly arrivalGas: "ok" | "short" | "unknown";
  /** USD per whole token (null: unknown). */
  readonly priceOf: (asset: ResolvedAsset) => Promise<number | null>;
}

export interface ShapeEvaluation {
  readonly candidate: ShapeCandidate;
  /** Candidate order (shape enumeration order; the last tie-break). */
  readonly order: number;
  /** One auction per leg, in order (absent when a leg could not be quoted). */
  readonly legs: readonly AuctionResult[];
  /** Ranking value in USD (B.1), or null when not comparable. */
  readonly value: number | null;
  readonly score: RouteScore | null;
  /** Why the shape cannot win. */
  readonly excluded?: string;
  /** The failure of the leg that could not be quoted. */
  readonly error?: PlatformError;
  /** USD value of the input. */
  readonly inputUsd: number | null;
  /** Expected and chained-minimum output of the whole route, base units of the final output. */
  readonly expected: bigint | null;
  readonly minimum: bigint | null;
}

export interface ComposeResult {
  /** The shape to plan, or null when no shape is eligible. */
  readonly winner: ShapeEvaluation | null;
  /** Every shape, the winner first, then eligible by value, then excluded. */
  readonly ranked: readonly ShapeEvaluation[];
}

function legCost(result: AuctionResult): number | null {
  const winner = result.winner;
  if (winner.arrivingUsd === null) return null;
  return winner.arrivingUsd - winner.value;
}

/** Ratio of one leg's expected (or minimum) output to the next leg's quoted input, in the carrier's base units. */
function ratio(previousOut: string, nextIn: string): number {
  const next = BigInt(nextIn);
  if (next <= 0n) return 0;
  return Number(BigInt(previousOut)) / Number(next);
}

/** Scales base units by a ratio (rounded down: the conservative side). */
function scaleUnits(units: string, factor: number): bigint {
  if (!Number.isFinite(factor) || factor <= 0) return 0n;
  const scaled = Math.floor(Number(BigInt(units)) * factor);
  return Number.isFinite(scaled) && scaled > 0 ? BigInt(scaled) : 0n;
}

/**
 * Value and score of a shape from its legs' auctions (B.1, chained). Pure;
 * exported for tests and for the planner's re-scoring of the real plan.
 */
export function chainLegs(
  candidate: Pick<ShapeCandidate, "legs" | "carrier">,
  legs: readonly AuctionResult[],
  options: { readonly inputUsd: number | null },
): { readonly value: number | null; readonly score: RouteScore | null; readonly expected: bigint; readonly minimum: bigint } {
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) return { value: null, score: null, expected: 0n, minimum: 0n };
  let expectedChain = 1;
  let minimumChain = 1;
  for (let index = 1; index < legs.length; index += 1) {
    const previous = (legs[index - 1] as AuctionResult).winner.planned;
    const current = (legs[index] as AuctionResult).winner.planned;
    expectedChain *= ratio(previous.expectedOutput.amount, current.input.amount);
    minimumChain *= ratio(previous.minimumOutput.amount, current.input.amount);
  }
  const final = last.winner.planned;
  const expected = scaleUnits(final.expectedOutput.amount, expectedChain);
  const minimum = scaleUnits(final.minimumOutput.amount, minimumChain);
  const scores = legs.map((leg) => leg.winner.score);
  const seconds = scores.reduce((total, score) => total + score.seconds, 0);
  const signatures = legs.reduce((total, leg) => total + leg.winner.planned.transactionCount, 0);
  const minimumKind = legs.every((leg) => leg.winner.planned.floor === "onchain") ? "onchain" as const : "claimed" as const;
  const costs = legs.map(legCost);
  const arriving = last.winner.arrivingUsd;
  if (arriving === null || costs.some((cost) => cost === null)) {
    return { value: null, score: null, expected, minimum };
  }
  // Legs after the crossing can fail after the fill (D5): a strand cost each.
  const crossingIndex = candidate.legs.findIndex((leg) => leg.input.network !== leg.output.network);
  const carrier = crossingIndex >= 0 ? candidate.legs[crossingIndex]?.output : undefined;
  const after = crossingIndex >= 0 ? candidate.legs.length - 1 - crossingIndex : 0;
  const volatility = carrier && !isUsdStablecoin(carrier) ? CARRIER_VOLATILITY : 0;
  const strand = after * strandCostUsd(options.inputUsd ?? 0, volatility, 1 - PRIOR_FILL_RATE);
  const extraLegs = legs.length - 1;
  const value = arriving * expectedChain - (costs as number[]).reduce((total, cost) => total + cost, 0) - LAMBDA_S_USD * extraLegs - strand;
  const priceOut = last.snapshot.prices.out ?? null;
  const round = (amount: number) => Math.round(amount * 10_000) / 10_000;
  const score: RouteScore = {
    valueUsd: round(value),
    expectedUsd: round((scores[scores.length - 1]?.expectedUsd ?? 0) * expectedChain),
    minimumUsd: priceOut !== null ? round(wholeUnits(minimum, final.minimumOutput.decimals) * priceOut) : round((scores[scores.length - 1]?.minimumUsd ?? 0) * minimumChain),
    minimumKind,
    gasUsd: round(scores.reduce((total, score) => total + score.gasUsd, 0)),
    feesUsd: round(scores.reduce((total, score) => total + score.feesUsd, 0)),
    seconds,
    signatures,
    riskUsd: round(scores.reduce((total, score) => total + score.riskUsd, 0)),
    ...(legs.length > 1 ? { estimate: true as const } : {}),
  };
  return { value, score, expected, minimum };
}

/** Base units of `to` worth `amount` of `from` at USD prices (null when a price is unknown). */
async function estimateAmount(amount: bigint, from: ResolvedAsset, to: ResolvedAsset, priceOf: ComposeRequest["priceOf"]): Promise<bigint | null> {
  const [inPrice, outPrice] = await Promise.all([priceOf(from), priceOf(to)]);
  if (inPrice === null || outPrice === null || inPrice <= 0 || outPrice <= 0) return null;
  const usd = wholeUnits(amount, from.decimals) * inPrice;
  const units = Math.floor((usd / outPrice) * 10 ** to.decimals);
  return Number.isFinite(units) && units > 0 ? BigInt(units) : null;
}

/** Quotes every leg of one shape: in parallel when prices give every later leg's amount, else chained. */
async function quoteShape(candidate: ShapeCandidate, request: ComposeRequest): Promise<AuctionResult[]> {
  const legs = candidate.legs;
  const first = legs[0] as LegSpec;
  const estimates = await Promise.all(legs.map((leg, index) => (index === 0 ? Promise.resolve(request.amount) : estimateAmount(request.amount, first.input, leg.input, request.priceOf))));
  if (estimates.every((estimate) => estimate !== null)) {
    return Promise.all(legs.map((leg, index) => request.quote(leg, estimates[index] as bigint, index)));
  }
  const results: AuctionResult[] = [];
  let amount = request.amount;
  for (const [index, leg] of legs.entries()) {
    const result = await request.quote(leg, amount, index);
    results.push(result);
    amount = BigInt(result.winner.planned.expectedOutput.amount);
  }
  return results;
}

/** Evaluates one shape: quotes, chains and checks eligibility. Never throws. */
async function evaluate(candidate: ShapeCandidate, order: number, request: ComposeRequest): Promise<ShapeEvaluation> {
  let legs: AuctionResult[];
  try {
    legs = await quoteShape(candidate, request);
  } catch (error) {
    const platform = toPlatformError(error);
    return { candidate, order, legs: [], value: null, score: null, excluded: `could not quote (${platform.code})`, error: platform, inputUsd: null, expected: null, minimum: null };
  }
  const inputUsd = legs[0]?.inputUsd ?? null;
  const chained = chainLegs(candidate, legs, { inputUsd });
  const base = { candidate, order, legs, value: chained.value, score: chained.score, inputUsd, expected: chained.expected, minimum: chained.minimum };
  if (legs.length > 1 && chained.value === null) return { ...base, excluded: "could not be priced" };
  if (legs.length > 1 && chained.score && chained.score.seconds > request.maxSeconds) return { ...base, excluded: "slower than the time limit" };
  if (legs.length > 1 && swapsOnArrival(candidate) && request.arrivalGas !== "ok") {
    const network = candidate.legs.find((leg) => leg.input.network !== leg.output.network)?.output.network;
    return { ...base, excluded: request.arrivalGas === "short" ? `needs gas on ${network ?? "the destination"}` : `gas on ${network ?? "the destination"} could not be read` };
  }
  if (chained.minimum <= 0n) return { ...base, excluded: "guarantees nothing" };
  return base;
}

/**
 * Pre-screens every shape and picks the winner (B.1). Composites are
 * skipped when less than COMPOSER_MIN_BUDGET_MS of the request remains.
 */
export async function compareShapes(request: ComposeRequest): Promise<ComposeResult> {
  const enoughBudget = remainingMs() >= COMPOSER_MIN_BUDGET_MS;
  const candidates = request.candidates.filter((candidate) => candidate.legs.length === 1 || enoughBudget);
  const evaluations = await Promise.all(candidates.map((candidate) => {
    const order = request.candidates.indexOf(candidate);
    const running = evaluate(candidate, order, request);
    // Single-leg shapes are bounded by their own auction; a composite never holds the plan past its cap.
    return candidate.legs.length === 1 ? running : capped(running, candidate, order);
  }));
  // Composites are compared in USD only: when the single-leg route is ranked in units, they stay out.
  const singleUnits = evaluations.some((evaluation) => evaluation.candidate.legs.length === 1 && evaluation.legs[0]?.snapshot.mode === "units");
  const inputUsd = evaluations.find((evaluation) => evaluation.inputUsd !== null)?.inputUsd ?? null;
  const entries: RankEntry<ShapeEvaluation>[] = evaluations.map((evaluation) => {
    const single = evaluation.candidate.legs.length === 1;
    const winner = evaluation.legs[0]?.winner;
    const comparable = single ? winner !== undefined : evaluation.value !== null && !singleUnits;
    return {
      item: evaluation,
      value: single ? winner?.value ?? 0 : evaluation.value ?? 0,
      mode: single && evaluation.legs[0]?.snapshot.mode === "units" ? "units" : "usd",
      eligible: evaluation.excluded === undefined && comparable,
      preferred: false,
      signatures: evaluation.score?.signatures ?? winner?.planned.transactionCount ?? 1,
      legs: evaluation.candidate.legs.length,
      seconds: evaluation.score?.seconds ?? winner?.planned.estimatedSeconds ?? 0,
      onchainFloor: evaluation.score?.minimumKind === "onchain",
      order: evaluation.order,
    };
  });
  const { winner, ordered } = selectRoute(entries, { inputUsd, preference: request.preference });
  const ranked = ordered.map((entry) => (entry.eligible || entry.item.excluded ? entry.item : { ...entry.item, excluded: "could not be compared in USD" }));
  return { winner: winner?.item ?? null, ranked };
}

/** A composite's evaluation, cut as "did not answer in time" at its cap (C.6). */
async function capped(running: Promise<ShapeEvaluation>, candidate: ShapeCandidate, order: number): Promise<ShapeEvaluation> {
  const limit = Math.max(0, Math.min(COMPOSITE_PRESCREEN_MS, remainingMs() - PLAN_RESERVE_MS));
  let timer: NodeJS.Timeout | undefined;
  const cut: ShapeEvaluation = { candidate, order, legs: [], value: null, score: null, excluded: "did not answer in time", inputUsd: null, expected: null, minimum: null };
  try {
    return await Promise.race([
      running,
      new Promise<ShapeEvaluation>((resolve) => {
        timer = setTimeout(() => resolve(cut), limit);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * C.2 step 3: true when the planned winner's real value fell below the
 * runner-up's pre-screen value by more than RUNNER_UP_SWITCH_BPS of the input
 * and enough budget remains to plan the runner-up instead (once).
 */
export function shouldPlanRunnerUp(realValue: number | null, runnerUp: ShapeEvaluation | undefined, inputUsd: number | null): boolean {
  if (realValue === null || !runnerUp || runnerUp.value === null || runnerUp.excluded) return false;
  if (remainingMs() < RUNNER_UP_MIN_BUDGET_MS) return false;
  const margin = inputUsd !== null && inputUsd > 0 ? (inputUsd * RUNNER_UP_SWITCH_BPS) / 10_000 : 0;
  return realValue < runnerUp.value - margin;
}
