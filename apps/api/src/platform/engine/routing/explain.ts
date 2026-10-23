/**
 * Kletia's own explanations of composed routes (design B.5, D.1; seam S4):
 * one `interpretation.routes[]` entry per crossing the composer compared,
 * with the chosen shape and venues, its score, the other shapes (scored, or
 * why they were excluded), up to three alternatives that re-plan with a
 * constraint, and the snapshot of every score input of every leg (I9).
 * Templates only; a model never writes these.
 *
 * Minimums are worded by how they are enforced (D1): "guaranteed minimum
 * (enforced on-chain)" when every leg's floor is on-chain, else "quoted
 * minimum".
 */
import { fromBaseUnits, getProtocol, type IntentConstraints, type ProtocolId, type RouteChoice, type RouteScore } from "@kletia/core";
import type { AuctionResult } from "../auction.js";
import type { RecordedSnapshot } from "./snapshot.js";
import type { ShapeEvaluation } from "./composer.js";

const MAX_REASON = 200;
const MAX_COMPARED = 6;
const MAX_ALTERNATIVES = 3;

function venueName(protocol: ProtocolId): string {
  return getProtocol(protocol)?.name ?? protocol;
}

function seconds(value: number): string {
  return value >= 120 ? `${Math.round(value / 60)} min` : `${value} s`;
}

function money(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

function steps(count: number): string {
  return count === 1 ? "one step" : `${count} steps`;
}

/** "Relay" for a single leg, "Uniswap V3, Across, Jupiter" for a composite. */
export function shapeVenues(evaluation: Pick<ShapeEvaluation, "legs">): ProtocolId[] {
  return evaluation.legs.map((leg) => leg.winner.protocol);
}

function describe(evaluation: ShapeEvaluation): string {
  const venues = shapeVenues(evaluation).map(venueName);
  const carrier = evaluation.candidate.carrier && evaluation.candidate.carrier !== "input" ? `via ${evaluation.candidate.carrier}` : null;
  if (evaluation.candidate.legs.length === 1) return venues[0] ?? evaluation.candidate.label;
  if (evaluation.candidate.asWritten) return `as written (${venues.join(", ")})`;
  return `${carrier ?? "composite"} (${venues.join(", ")})`;
}

function minimumWords(score: RouteScore): string {
  return score.minimumKind === "onchain" ? "guaranteed minimum (enforced on-chain)" : "quoted minimum";
}

/** The chained minimum as shown ("99.62 USDC quoted minimum"). */
function minimumText(evaluation: ShapeEvaluation, minimum: bigint | null): string {
  const last = evaluation.legs[evaluation.legs.length - 1]?.winner.planned.minimumOutput;
  if (!last || minimum === null || !evaluation.score) return "";
  return `${fromBaseUnits(minimum, last.decimals)} ${last.symbol} ${minimumWords(evaluation.score)}`;
}

/** Kletia's template for why a shape won (<= 200 characters). */
export function compositeReason(winner: ShapeEvaluation, runnerUp: ShapeEvaluation | undefined, minimum: bigint | null): string {
  const legs = winner.candidate.legs.length;
  const head = legs === 1 ? `${describe(winner)} in one step` : `${capital(describe(winner))} in ${steps(legs)}`;
  const floor = minimumText(winner, minimum);
  if (!runnerUp || runnerUp.value === null || winner.value === null || !winner.score || !runnerUp.score) {
    return `${head}${floor ? `; ${floor}` : ""}.`.slice(0, MAX_REASON);
  }
  const delta = winner.value - runnerUp.value;
  const other = `${describe(runnerUp)} in ${steps(runnerUp.candidate.legs.length)}`;
  const value = delta >= 0.005 ? `delivers about ${money(delta)} more than ${other} after costs` : `ties ${other} on value after costs`;
  const time = `about ${seconds(winner.score.seconds)} instead of ${seconds(runnerUp.score.seconds)}`;
  const signatures = winner.score.signatures !== runnerUp.score.signatures ? `; ${winner.score.signatures} signatures instead of ${runnerUp.score.signatures}` : "";
  return `${head}: ${value}; ${time}${signatures}${floor ? `; ${floor}` : ""}.`.slice(0, MAX_REASON);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Every leg's snapshot merged into one (quotes in leg order; haircuts and fill rates keyed `<leg>:<venue>`). */
export function mergedSnapshot(legs: readonly AuctionResult[]): RecordedSnapshot {
  const quotes: RecordedSnapshot["quotes"][number][] = [];
  const cut = new Set<ProtocolId>();
  const skipped = new Set<ProtocolId>();
  const haircuts: Record<string, number> = {};
  const fills: Record<string, number> = {};
  const prices: Record<string, number> = {};
  const gas: Record<string, string> = {};
  let mode: "usd" | "units" = "usd";
  legs.forEach((leg, index) => {
    const snapshot = leg.snapshot;
    for (const { estimate: _estimate, ...quote } of snapshot.quotes) quotes.push(quote);
    snapshot.cutByDeadline.forEach((venue) => cut.add(venue));
    snapshot.breakerSkipped.forEach((venue) => skipped.add(venue));
    for (const [venue, bps] of Object.entries(snapshot.haircutsBps)) haircuts[legs.length === 1 ? venue : `${index + 1}:${venue}`] = bps;
    for (const [venue, rate] of Object.entries(snapshot.fillRates)) fills[legs.length === 1 ? venue : `${index + 1}:${venue}`] = rate;
    for (const [key, price] of Object.entries(snapshot.prices)) prices[legs.length === 1 ? key : `${index + 1}:${key}`] = price;
    Object.assign(gas, snapshot.gas);
    if (snapshot.mode === "units") mode = "units";
  });
  return { quotes, cutByDeadline: [...cut], breakerSkipped: [...skipped], haircutsBps: haircuts, gas, fillRates: fills, prices, mode };
}

/** Re-plans with a constraint (at most three): one step, fastest. */
function alternatives(winner: ShapeEvaluation, ranked: readonly ShapeEvaluation[]): RouteChoice["alternatives"] {
  const out: { id: string; label: string; detail: string; constraints: Partial<IntentConstraints> }[] = [];
  const single = ranked.find((evaluation) => evaluation !== winner && evaluation.candidate.legs.length === 1 && evaluation.excluded === undefined);
  if (winner.candidate.legs.length > 1 && single) {
    out.push({ id: "single", label: "One step", detail: `${describe(single)}: one signature`.slice(0, 120), constraints: { routeShapes: "single" } });
  }
  const fastest = [...ranked].filter((evaluation) => evaluation.excluded === undefined && evaluation.score).sort((a, b) => (a.score?.seconds ?? 0) - (b.score?.seconds ?? 0))[0];
  if (fastest && fastest !== winner && fastest.score && winner.score && fastest.score.seconds < winner.score.seconds) {
    out.push({ id: "fastest", label: "Fastest", detail: `${describe(fastest)}: about ${seconds(fastest.score.seconds)}`.slice(0, 120), constraints: { routePreference: "fastest" } });
  }
  return out.slice(0, MAX_ALTERNATIVES);
}

/**
 * The `interpretation.routes[]` entry of a composed crossing: `stepIds` are
 * the plan's steps that carry it; `real` is the planned route's own score and
 * chained minimum when it was planned for real (else the pre-screen's).
 */
export function compositeRouteChoice(
  stepIds: readonly string[],
  winner: ShapeEvaluation,
  ranked: readonly ShapeEvaluation[],
  real?: { readonly score: RouteScore; readonly minimum: bigint | null },
): RouteChoice {
  const runnerUp = ranked.find((evaluation) => evaluation !== winner && evaluation.excluded === undefined && evaluation.value !== null);
  const score = real?.score ?? (winner.score as RouteScore);
  const scored: ShapeEvaluation = { ...winner, score };
  const compared = ranked
    .filter((evaluation) => evaluation !== winner)
    .map((evaluation) => ({
      label: capital(describe(evaluation)).slice(0, 80),
      ...(evaluation.excluded === undefined && evaluation.score ? { score: evaluation.score } : { excluded: evaluation.excluded ?? "not eligible" }),
    }))
    .slice(0, MAX_COMPARED);
  const carrier = winner.candidate.carrier && winner.candidate.carrier !== "input"
    ? winner.candidate.carrier
    : winner.candidate.legs.length > 1 ? winner.candidate.legs.find((leg) => leg.input.network !== leg.output.network)?.input.symbol : undefined;
  return {
    steps: [...stepIds],
    shape: winner.candidate.shape,
    ...(carrier ? { carrier } : {}),
    venues: shapeVenues(winner),
    score,
    reason: compositeReason(scored, runnerUp, real?.minimum ?? winner.minimum),
    compared,
    alternatives: alternatives(winner, ranked),
    snapshot: mergedSnapshot(winner.legs),
  };
}
