/**
 * Deliver sizing for intent links (intent-links design §3.5). The engine is
 * exact-input, so "the recipient receives at least T" is met by inverse
 * quoting the funding bridge: guess the input, plan it, read the bridge
 * step's guaranteed minimum m, rescale, at most three plan runs.
 *
 *   x0 = ceil(T × 10⁴ / (10⁴ − 30))        (same USD group: 1:1 plus 30 bps)
 *   accept x0 when m0 ≥ T and the surplus is ≤ 50 bps
 *   x1 = ceil(x0 × T / m0 × (1 + 2 bps));  accept when m1 ≥ T
 *   x2 = ceil(x1 × T / m1 × (1 + 5 bps));  accept when m2 ≥ T, else LINK_DELIVERY_UNQUOTABLE
 *
 * Each run is a real plan whose `verifyPlan` hook reports m and rejects a
 * short (or too generous first) candidate before anything is stored, so the
 * run that is accepted is the intent. The accepted input is cached 20 s per
 * (link definition, source network, asset) and becomes the next first guess.
 */
import { LINK_LIMITS, linkDeliverAccepts, linkDeliverFirstGuess, linkDeliverRescale } from "@kletia/core";
import { PlatformError } from "../../errors.js";

/** Thrown from a plan's verify hook: this candidate does not deliver acceptably (nothing was stored). */
export class DeliverCandidateRejected extends PlatformError {
  readonly minimumUnits: bigint;
  readonly inputUnits: bigint;

  constructor(minimumUnits: bigint, inputUnits: bigint) {
    super("LINK_DELIVERY_UNQUOTABLE", "The candidate input does not deliver the fixed amount.", 502);
    this.name = "DeliverCandidateRejected";
    this.minimumUnits = minimumUnits;
    this.inputUnits = inputUnits;
  }
}

export interface DeliverSizingInput<T> {
  /** Cache key: link definition hash, source network and asset. */
  readonly key: string;
  /** T: base units of the delivered asset. */
  readonly targetUnits: bigint;
  readonly targetDecimals: number;
  /** Decimals of the funding asset. */
  readonly inputDecimals: number;
  /**
   * Plans one candidate input (funding base units). The plan must call
   * `check(m)` with the bridge step's guaranteed minimum (delivered base
   * units) before storing anything; `check` throws to reject the candidate.
   */
  readonly plan: (inputUnits: bigint, check: (minimumUnits: bigint) => void) => Promise<T>;
  /** Unix ms (cache clock). */
  readonly now?: number;
}

export interface DeliverSizingResult<T> {
  readonly value: T;
  readonly inputUnits: bigint;
  readonly minimumUnits: bigint;
  /** Plan runs used (1-3). */
  readonly runs: number;
  /** The first guess came from the 20 s cache. */
  readonly cached: boolean;
}

const CACHE_MS = LINK_LIMITS.quoteCacheSeconds * 1000;
const MAX_CACHED = 5_000;
const sized = new Map<string, { readonly inputUnits: bigint; readonly targetUnits: bigint; readonly expiresAt: number }>();

/** Clears cached deliver inputs (tests). */
export function resetDeliverSizing(): void {
  sized.clear();
}

function unquotable(detail: string): PlatformError {
  return new PlatformError(
    "LINK_DELIVERY_UNQUOTABLE",
    `No quote delivered at least the fixed amount within ${LINK_LIMITS.deliverMaxRuns} tries (${detail}). Retry shortly, or start from another network.`,
    502,
  );
}

/** Runs the §3.5 sizing loop; the accepted run's value is returned (a stored intent when the plan stores). */
export async function sizeDelivery<T>(input: DeliverSizingInput<T>): Promise<DeliverSizingResult<T>> {
  const target = input.targetUnits;
  if (target <= 0n) throw unquotable("the fixed amount is zero");
  const now = input.now ?? Date.now();
  for (const [key, entry] of sized) if (entry.expiresAt <= now) sized.delete(key);
  const cachedEntry = sized.get(input.key);
  const cached = cachedEntry !== undefined && cachedEntry.targetUnits === target;
  let inputUnits = cached ? (cachedEntry as { inputUnits: bigint }).inputUnits : linkDeliverFirstGuess(target, input.targetDecimals, input.inputDecimals);
  let lastMinimum: bigint | null = null;
  for (let run = 1; run <= LINK_LIMITS.deliverMaxRuns; run += 1) {
    const candidate = inputUnits;
    const seen: { minimum: bigint | null } = { minimum: null };
    const check = (minimumUnits: bigint) => {
      seen.minimum = minimumUnits;
      // The first guess must also not overpay by more than 50 bps; later runs only need to deliver.
      const ok = run === 1 ? linkDeliverAccepts(minimumUnits, target) : minimumUnits >= target;
      if (!ok) throw new DeliverCandidateRejected(minimumUnits, candidate);
    };
    try {
      const value = await input.plan(candidate, check);
      const observed = seen.minimum;
      if (observed === null) throw unquotable("the plan reported no guaranteed minimum");
      sized.delete(input.key);
      sized.set(input.key, { inputUnits: candidate, targetUnits: target, expiresAt: now + CACHE_MS });
      while (sized.size > MAX_CACHED) {
        const oldest = sized.keys().next().value;
        if (oldest === undefined) break;
        sized.delete(oldest);
      }
      return { value, inputUnits: candidate, minimumUnits: observed, runs: run, cached };
    } catch (error) {
      if (!(error instanceof DeliverCandidateRejected)) throw error;
      lastMinimum = error.minimumUnits;
    }
    if (lastMinimum === null || lastMinimum <= 0n) throw unquotable("the route guarantees nothing");
    if (run === LINK_LIMITS.deliverMaxRuns) break;
    const margin = run === 1 ? LINK_LIMITS.deliverSecondMarginBps : LINK_LIMITS.deliverThirdMarginBps;
    inputUnits = linkDeliverRescale(candidate, target, lastMinimum, margin);
  }
  sized.delete(input.key);
  throw unquotable(lastMinimum === null ? "no quote" : `best guaranteed ${lastMinimum} of ${target} base units`);
}
