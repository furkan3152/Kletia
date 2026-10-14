/**
 * Pure formatting for the journey map: the map's layout for 1 to 6 stops,
 * ETA and countdown text, custody stamps, how each leg is drawn, where the
 * money is in one sentence ("99.95 USDC in your Base wallet") and what the
 * flow's live region says when the money arrives.
 *
 * The copy of stops, legs and notices comes from `@kletia/widget/review`
 * (`journeyModel`), so every host prints the same words; this module only
 * shapes it for the Interchange art. Type-only imports: node --test loads it.
 */
import type { CustodyState, Journey, JourneyCertainty, JourneyFacts, NetworkKey, StepStatus } from "@kletia/core";
import type { JourneyLegView, JourneyModel, JourneyStopView } from "@kletia/widget/review";

/* ----------------------------------------------------------------- layout */

/** Container width from which the map runs horizontally. */
export const JOURNEY_HORIZONTAL_MIN_PX = 720;
/** Narrowest station card in a horizontal row; more stops need a wider container. */
export const JOURNEY_STATION_MIN_PX = 150;
/** More stops than this always run vertically (the strip pattern). */
export const JOURNEY_MAX_HORIZONTAL_STOPS = 6;

export type JourneyOrientation = "horizontal" | "vertical";

export interface JourneyLayout {
  readonly orientation: JourneyOrientation;
  /** Grid columns of the horizontal map (one per stop); 1 when vertical. */
  readonly columns: number;
}

/** The container width from which `stops` stations fit in one row; null when they never do. */
export function horizontalFrom(stops: number): number | null {
  if (!Number.isInteger(stops) || stops < 1 || stops > JOURNEY_MAX_HORIZONTAL_STOPS) return null;
  return Math.max(JOURNEY_HORIZONTAL_MIN_PX, stops * JOURNEY_STATION_MIN_PX);
}

/**
 * Horizontal from 720 px of container width while every station card keeps
 * at least 150 px (so 6 stops need 900 px), vertical below and for longer
 * journeys. Unknown widths (no measurement yet) are vertical: it never
 * overflows a phone.
 */
export function journeyLayout(stops: number, width: number | null | undefined): JourneyLayout {
  const from = horizontalFrom(stops);
  if (from === null || typeof width !== "number" || !Number.isFinite(width) || width < from) {
    return { orientation: "vertical", columns: 1 };
  }
  return { orientation: "horizontal", columns: stops };
}

/* ------------------------------------------------------------------- time */

/** "about 20 s", "about 3 min", "about 1 h 5 min"; null for anything that is not a duration. */
export function etaText(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  return minutes > 0 && minutes < 60 ? `about ${hours} h ${minutes} min` : `about ${hours} h`;
}

/**
 * A leg is overdue once it took half again its expected time, and at least
 * 30 s more (short legs jitter). Unknown expectations are never overdue.
 */
export function isOverdue(startedAtMs: number | null | undefined, expectedSeconds: number | null | undefined, nowMs: number): boolean {
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return false;
  if (typeof expectedSeconds !== "number" || !Number.isFinite(expectedSeconds) || expectedSeconds <= 0) return false;
  const elapsed = (nowMs - startedAtMs) / 1000;
  return elapsed > Math.max(expectedSeconds * 1.5, expectedSeconds + 30);
}

/** The live line under a moving leg: "about 12 s left", "arriving now", or "taking longer than usual". */
export function countdownText(remainingSeconds: number | null | undefined, overdue: boolean): string | null {
  if (overdue) return "taking longer than usual";
  if (typeof remainingSeconds !== "number" || !Number.isFinite(remainingSeconds)) return null;
  if (remainingSeconds <= 0) return "arriving now";
  return `${etaText(remainingSeconds)} left`;
}

/* ---------------------------------------------------------------- custody */

/** Stamps printed on a station card: who holds the money there, in two words at most. */
export const CUSTODY_STAMPS: Readonly<Record<CustodyState, string>> = Object.freeze({
  wallet: "Wallet",
  venue: "At the venue",
  provider: "In transit",
  "refund-due": "Refund due",
  "third-party": "Paid out",
  unknown: "Unknown",
});

/** The custody stamp of a stop ("At Aave V3" for a named venue). */
export function custodyStamp(custody: CustodyState, venueName?: string | null): string {
  if (custody === "venue" && venueName) return `At ${venueName}`.slice(0, 40);
  return CUSTODY_STAMPS[custody] ?? CUSTODY_STAMPS.unknown;
}

/* ------------------------------------------------------------------- legs */

const IN_TRANSIT: ReadonlySet<StepStatus> = new Set<StepStatus>(["submitted", "confirmed", "settling", "indeterminate"]);
const DONE: ReadonlySet<StepStatus> = new Set<StepStatus>(["settled", "skipped", "failed"]);

export interface LegDrawing {
  /** Cross-network legs are an interchange transfer (dashed until they arrive); same-network legs a solid line. */
  readonly style: "transfer" | "line";
  readonly dashed: boolean;
  /** Solana segments run on the SVM gauge (sleepers). */
  readonly gauge: "svm" | "standard";
  /** The train marker sits on this leg (the money is moving through it). */
  readonly moving: boolean;
  readonly done: boolean;
}

/** How one leg is drawn, from its network pair and status. */
export function legDrawing(leg: { readonly crossNetwork: boolean; readonly status: string }, network: NetworkKey | null, svm: (network: NetworkKey) => boolean): LegDrawing {
  const status = leg.status.replace(/ /gu, "_") as StepStatus;
  const moving = IN_TRANSIT.has(status);
  const done = DONE.has(status);
  return {
    style: leg.crossNetwork ? "transfer" : "line",
    dashed: leg.crossNetwork && !done,
    gauge: network && svm(network) ? "svm" : "standard",
    moving,
    done,
  };
}

/* ------------------------------------------------------------ where it is */

function rawStop(journey: Pick<Journey, "stops"> | null | undefined, stopId: string) {
  return journey?.stops.find((stop) => stop.id === stopId) ?? null;
}

/**
 * Where a stop is, as the end of a sentence: "in your Base wallet", "at Aave
 * V3 USDC on Base", "with Relay (in transit)", "paid to vitalik.eth on Base".
 * `own` is the core stop's `holder.own` (only the user's own wallet is "your").
 */
export function placeOf(stop: Pick<JourneyStopView, "custody" | "networkName" | "holderLabel">, own: boolean): string {
  const holder = stop.holderLabel;
  switch (stop.custody) {
    case "wallet":
      return own ? `in your ${stop.networkName} wallet` : `in ${holder} on ${stop.networkName}`;
    case "venue":
      return `at ${holder} on ${stop.networkName}`;
    case "provider":
      return `with ${holder}`;
    case "refund-due":
      return `due back as a refund on ${stop.networkName}`;
    case "third-party":
      return `paid to ${holder} on ${stop.networkName}`;
    default:
      return `somewhere Kletia cannot confirm on ${stop.networkName}`;
  }
}

export interface MoneyLine {
  readonly stopId: string;
  /** "99.95 USDC in your Base wallet". */
  readonly sentence: string;
  readonly amount: string;
  readonly usd: string | null;
  readonly certainty: JourneyCertainty;
  /** "observed on-chain", read before the sentence. */
  readonly spoken: string;
  /** Shortened account (full value in `account`), when the stop has one. */
  readonly accountShort: string | null;
  readonly account: string | null;
}

/**
 * "Where your money is now": one line per holding of the stops the
 * model's outcome names, as plain sentences. Empty while the journey
 * neither ended nor waits for a decision.
 */
export function whereMoneyIs(journey: Pick<Journey, "stops"> | null | undefined, model: Pick<JourneyModel, "outcome" | "stops">): MoneyLine[] {
  if (!model.outcome) return [];
  const lines: MoneyLine[] = [];
  const seen = new Set<string>();
  for (const line of model.outcome.lines) {
    const stop = model.stops.find((entry) => entry.id === line.stopId);
    if (!stop) continue;
    const own = rawStop(journey, stop.id)?.holder.own === true;
    const sentence = `${line.amount} ${placeOf(stop, own)}`;
    const key = `${stop.id}|${sentence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      stopId: stop.id,
      sentence,
      amount: line.amount,
      usd: line.usd,
      certainty: line.certainty,
      spoken: line.certaintyInfo.spoken,
      accountShort: stop.accountShort,
      account: stop.account,
    });
  }
  return lines;
}

/* ------------------------------------------------------------- live region */

function hereStop(model: Pick<JourneyModel, "stops">): JourneyStopView | null {
  return model.stops.find((stop) => stop.here) ?? null;
}

/**
 * What the flow's live region says when the journey moved on: the
 * money arrived at a new stop, or a blocker appeared during
 * execution. Null when nothing worth announcing changed (the same
 * stop, the same blockers), so polls never repeat themselves.
 */
export function journeyAnnouncement(
  previous: Pick<JourneyModel, "stops" | "blockers"> | null,
  next: Pick<JourneyModel, "stops" | "blockers">,
  journey: Pick<Journey, "stops"> | null = null,
): string | null {
  if (!previous) return null;
  const known = new Set(previous.blockers.map((blocker) => blocker.id));
  const fresh = next.blockers.find((blocker) => !known.has(blocker.id));
  if (fresh) return `Kletia needs an answer before the next signature: ${fresh.title}`;
  const before = hereStop(previous);
  const now = hereStop(next);
  if (!now || now.id === before?.id) return null;
  if (now.kind === "transit") return `In transit on ${now.networkName}: ${now.holderLabel} holds it.`;
  const holding = now.holdings[0];
  const own = rawStop(journey, now.id)?.holder.own === true;
  return holding ? `Arrived: ${holding.expected} ${placeOf(now, own)}.` : `Arrived on ${now.networkName}.`;
}

/** The leg after which a stop comes (for the station card's "→ leg 2" mark). */
export function legLeaving(stopId: string, legs: readonly Pick<JourneyLegView, "from" | "number">[]): number | null {
  return legs.find((leg) => leg.from === stopId)?.number ?? null;
}

/* ------------------------------------------------------------- indicative */

/**
 * Facts for an indicative itinerary (the link page): nothing read, no
 * prices, so the journey shows the route, custody and refund paths and
 * says that gas is checked once the visitor's wallets are connected,
 * never a balance it did not read.
 */
export function indicativeFacts(at: string): JourneyFacts {
  return {
    at,
    reads: "none",
    native: {},
    gasPrice: {},
    solanaRent: null,
    tokenAccounts: {},
    prices: {},
    venues: {},
    policy: null,
    allowances: [],
    fees: {},
    exitFees: {},
    gasOptions: {},
    funding: {},
  };
}
