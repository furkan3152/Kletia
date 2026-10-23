/**
 * Exact delivery. The engine is exact-input, so "the recipient receives the
 * stated amount T" is met by inverse quoting: guess the input, plan it, read
 * the delivering leg's guaranteed minimum m, rescale, at most three runs.
 *
 *   x0 = ceil(T x 10^4 / (10^4 - 30))         (same token family: 1:1 plus 30 bps)
 *   accept x0 when m0 >= T and the surplus is <= 50 bps
 *   x1 = ceil(x0 x T / m0 x (1 + 2 bps));      accept when m1 >= T
 *   x2 = ceil(x1 x T / m1 x (1 + 5 bps));      accept when m2 >= T, else unquotable
 *
 * Each run is a real plan whose check reports m and rejects a short (or a
 * too generous first) candidate before anything is stored, so the accepted
 * run is the plan. Runs 2 and 3 reuse the first run's route: every leg is
 * pinned to the venue (and every crossing to the shape) run 1 chose, and only
 * amounts are re-quoted (`RoutePin`, read by the planner through the async
 * context). Used by `receiveExact` payments (planner.ts) and by intent links'
 * "receive at least" sizing (links/deliver.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { linkDeliverAccepts, linkDeliverFirstGuess, linkDeliverRescale, LINK_LIMITS, type ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";

/** Runs of the sizing loop (the first guess plus two rescales). */
export const EXACT_DELIVERY_RUNS = LINK_LIMITS.deliverMaxRuns;

/* ------------------------------------------------------------- route pin */

/**
 * The route of the first sizing run: the venue each leg used and the shape
 * each composed crossing took, keyed by leg (networks and exact assets, never
 * amounts). Run 1 records; runs 2-3 replay.
 */
export class RoutePin {
  private readonly venues = new Map<string, ProtocolId>();
  private readonly shapes = new Map<string, string>();
  mode: "record" | "replay" = "record";

  /** Records (run 1) the venue a leg used. */
  recordVenue(key: string, protocol: ProtocolId): void {
    if (this.mode === "record" && !this.venues.has(key)) this.venues.set(key, protocol);
  }

  /** The venue to reuse for a leg (runs 2-3), if run 1 recorded one. */
  venue(key: string): ProtocolId | undefined {
    return this.mode === "replay" ? this.venues.get(key) : undefined;
  }

  /** Records (run 1) the shape a composed crossing took. */
  recordShape(key: string, shape: string): void {
    if (this.mode === "record" && !this.shapes.has(key)) this.shapes.set(key, shape);
  }

  /** The shape to reuse for a crossing (runs 2-3). */
  shape(key: string): string | undefined {
    return this.mode === "replay" ? this.shapes.get(key) : undefined;
  }

  /** Legs recorded so far (tests and diagnostics). */
  get recordedVenues(): ReadonlyMap<string, ProtocolId> {
    return this.venues;
  }

  get recordedShapes(): ReadonlyMap<string, string> {
    return this.shapes;
  }
}

const pins = new AsyncLocalStorage<RoutePin>();

/** The route pin of the current sizing run, if any. */
export function currentRoutePin(): RoutePin | null {
  return pins.getStore() ?? null;
}

/** Runs `task` with `pin` as the current route pin. */
export function withRoutePin<T>(pin: RoutePin, task: () => Promise<T>): Promise<T> {
  return pins.run(pin, task);
}

/** The pin key of one leg: networks and exact asset ids. */
export function legPinKey(leg: { readonly kind: string; readonly network: string; readonly destinationNetwork: string; readonly input: { readonly id: string }; readonly output: { readonly id: string } }): string {
  return `${leg.kind}:${leg.network}>${leg.destinationNetwork}:${leg.input.id.toLowerCase()}>${leg.output.id.toLowerCase()}`;
}

/* ---------------------------------------------------------------- sizing */

/** Thrown by a run's check: this candidate does not deliver acceptably (nothing was stored). */
export class DeliveryCandidateRejected extends PlatformError {
  readonly minimumUnits: bigint;
  readonly inputUnits: bigint;

  constructor(minimumUnits: bigint, inputUnits: bigint, code = "LINK_DELIVERY_UNQUOTABLE") {
    super(code, "The candidate input does not deliver the stated amount.", 502);
    this.name = "DeliveryCandidateRejected";
    this.minimumUnits = minimumUnits;
    this.inputUnits = inputUnits;
  }
}

export interface ExactDeliveryInput<T> {
  /** T: base units the recipient must receive. */
  readonly targetUnits: bigint;
  readonly targetDecimals: number;
  /** Decimals of the funding asset. */
  readonly inputDecimals: number;
  /** First guess (e.g. a cached earlier answer); default x0 above. */
  readonly firstGuess?: bigint;
  /**
   * Plans one candidate input. The plan calls `check(m)` with the delivering
   * leg's guaranteed minimum before storing anything; `check` throws to
   * reject the candidate. Runs 2-3 run under the first run's route pin.
   */
  readonly plan: (inputUnits: bigint, check: (minimumUnits: bigint) => void, run: number) => Promise<T>;
  /** The refusal when no run delivers T (`last`: the best minimum seen and its input). */
  readonly unquotable: (detail: string, last: { readonly minimumUnits: bigint; readonly inputUnits: bigint } | null) => PlatformError;
  /** Pin runs 2-3 to run 1's route (default true). */
  readonly pinRoute?: boolean;
}

export interface ExactDeliveryResult<T> {
  readonly value: T;
  readonly inputUnits: bigint;
  readonly minimumUnits: bigint;
  /** Runs used (1-3). */
  readonly runs: number;
  /** The route the runs shared (venues and shapes of run 1). */
  readonly pin: RoutePin;
}

/** Runs the sizing loop; the accepted run's value is returned. */
export async function sizeExactDelivery<T>(input: ExactDeliveryInput<T>): Promise<ExactDeliveryResult<T>> {
  const target = input.targetUnits;
  if (target <= 0n) throw input.unquotable("the stated amount is zero", null);
  const pin = new RoutePin();
  const pinRoute = input.pinRoute !== false;
  let inputUnits = input.firstGuess ?? linkDeliverFirstGuess(target, input.targetDecimals, input.inputDecimals);
  let last: { minimumUnits: bigint; inputUnits: bigint } | null = null;
  for (let run = 1; run <= EXACT_DELIVERY_RUNS; run += 1) {
    const candidate = inputUnits;
    const seen: { minimum: bigint | null } = { minimum: null };
    const check = (minimumUnits: bigint) => {
      seen.minimum = minimumUnits;
      // The first guess must also not overpay by more than 50 bps; later runs only need to deliver.
      const ok = run === 1 ? linkDeliverAccepts(minimumUnits, target) : minimumUnits >= target;
      if (!ok) throw new DeliveryCandidateRejected(minimumUnits, candidate);
    };
    if (run > 1 && pinRoute) pin.mode = "replay";
    try {
      const value = await withRoutePin(pin, () => input.plan(candidate, check, run));
      if (seen.minimum === null) throw input.unquotable("the plan reported no guaranteed minimum", last);
      return { value, inputUnits: candidate, minimumUnits: seen.minimum, runs: run, pin };
    } catch (error) {
      if (!(error instanceof DeliveryCandidateRejected)) throw error;
      last = { minimumUnits: error.minimumUnits, inputUnits: candidate };
    }
    if (last.minimumUnits <= 0n) throw input.unquotable("the route guarantees nothing", last);
    if (run === EXACT_DELIVERY_RUNS) break;
    const margin = run === 1 ? LINK_LIMITS.deliverSecondMarginBps : LINK_LIMITS.deliverThirdMarginBps;
    inputUnits = linkDeliverRescale(candidate, target, last.minimumUnits, margin);
  }
  throw input.unquotable(last === null ? "no quote" : `best guaranteed ${last.minimumUnits} of ${target} base units`, last);
}
