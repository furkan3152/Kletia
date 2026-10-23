/**
 * Plan size and fee sanity.
 *
 * - Caps per plan, counted after expansion (composites, multi-source, dust):
 *   8 wallet signatures and 12 venue auctions. Above them planning fails
 *   with PLAN_TOO_LARGE and `details { signatures, auctions, moves[] }`
 *   (the decision layer turns it into a question that lists the
 *   moves). The planner counts signatures exactly; auctions are counted as
 *   they start, so an oversized plan stops before it fans out further.
 * - Fee sanity: for a request written as text without `maxFeeUsd`, gas plus
 *   fees above 5 % of the USD value moved fails with FEE_LIMIT_EXCEEDED and
 *   `details { feeUsd, valueUsd, cheaperShapes[] }` (the decision layer
 *   asks FEE_HIGH). An explicit `maxFeeUsd` replaces the 5 % rule; structured
 *   `actions[]` keep today's `maxFeeUsd` semantics.
 */
import { PlatformError } from "../../errors.js";

export const MAX_PLAN_SIGNATURES = 8;
export const MAX_PLAN_AUCTIONS = 12;
/** Fees above this share of the value moved need an explicit `maxFeeUsd`. */
export const FEE_SANITY_SHARE = 0.05;

/** Counts the auctions of one plan and refuses the one past the cap. */
export class PlanBudget {
  auctions = 0;
  readonly moves: string[] = [];

  /** Call before starting an auction; throws PLAN_TOO_LARGE once the cap would be passed. */
  startAuction(move: string): void {
    if (this.auctions >= MAX_PLAN_AUCTIONS) {
      throw planTooLarge({ signatures: null, auctions: this.auctions + 1, moves: [...this.moves, move] });
    }
    this.auctions += 1;
  }
}

export function planTooLarge(input: { readonly signatures: number | null; readonly auctions: number; readonly moves: readonly string[] }): PlatformError {
  const parts = [
    ...(input.signatures !== null && input.signatures > MAX_PLAN_SIGNATURES ? [`${input.signatures} wallet signatures (at most ${MAX_PLAN_SIGNATURES})`] : []),
    ...(input.auctions > MAX_PLAN_AUCTIONS ? [`${input.auctions} venue auctions (at most ${MAX_PLAN_AUCTIONS})`] : []),
  ];
  return new PlatformError(
    "PLAN_TOO_LARGE",
    `This plan needs ${parts.join(" and ") || "more than one plan allows"}. Split it into smaller requests.`,
    422,
    [],
    [],
    {
      signatures: input.signatures,
      auctions: input.auctions,
      moves: input.moves.slice(0, 16).map((move) => move.slice(0, 120)),
    },
  );
}

/** Throws PLAN_TOO_LARGE when a planned intent needs more wallet signatures than one plan allows. */
export function assertSignatureCap(signatures: number, auctions: number, moves: readonly string[]): void {
  if (signatures > MAX_PLAN_SIGNATURES) throw planTooLarge({ signatures, auctions, moves });
}

export interface FeeSanityInput {
  /** Gas plus fees of the plan in USD (known parts). */
  readonly feeUsd: number;
  /** USD value moved into the plan (inputs that do not come from a previous step). */
  readonly valueUsd: number | null;
  /** Cheaper shapes the planner knows (empty until the composer compares shapes). */
  readonly cheaperShapes?: readonly string[];
}

/**
 * FEE_LIMIT_EXCEEDED when the known fees exceed 5 % of the value moved;
 * nothing when the value is unknown (the rule needs both sides).
 */
export function assertFeeSanity(input: FeeSanityInput): void {
  const value = input.valueUsd;
  if (value === null || !Number.isFinite(value) || value <= 0 || !Number.isFinite(input.feeUsd)) return;
  if (input.feeUsd <= value * FEE_SANITY_SHARE) return;
  const share = ((input.feeUsd / value) * 100).toFixed(1);
  throw new PlatformError(
    "FEE_LIMIT_EXCEEDED",
    `Estimated network and venue fees are $${input.feeUsd.toFixed(2)}, ${share} % of the $${value.toFixed(2)} moved (above 5 %). Move a larger amount, or set constraints.maxFeeUsd to plan anyway.`,
    422,
    [{ path: "constraints.maxFeeUsd", message: "Fees above 5 % of the value moved." }],
    [],
    {
      feeUsd: Math.round(input.feeUsd * 100) / 100,
      valueUsd: Math.round(value * 100) / 100,
      cheaperShapes: [...(input.cheaperShapes ?? [])].slice(0, 3),
    },
  );
}
