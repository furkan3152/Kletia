/**
 * Moves confirms (intent design A.3 moves row, red-team C10): one goal that
 * expands into more than one move (deliver-all, a multi-holding relocate or
 * consolidation, exit-all, a dust sweep, a rebalance), a target amount Kletia
 * computed that moves more than half of what one network holds by USD (the
 * solver marks the step), or a payment of a whole holding (or a share of it)
 * to someone else is confirmed with every move listed and its amount, never
 * planned on a chip.
 *
 * Pure: every function reads only its arguments.
 */
import type { NetworkKey } from "@kletia/core";
import type { ResolvedAction, WorkStep } from "../clarify/types.js";

/** Where an action comes from (analysis layout): a state step, and whether it is a goal step's expansion. */
export interface MoveOrigin {
  readonly step: number;
  readonly goal: boolean;
}

export type MovesReason =
  | { readonly kind: "several"; readonly step: number; readonly moves: number }
  | { readonly kind: "computed"; readonly action: number; readonly network: NetworkKey; readonly symbol: string }
  | { readonly kind: "holding-to-third-party"; readonly action: number; readonly recipient: string };

/**
 * Why the plan needs a moves confirm, or null. `steps` are the expanded
 * steps the actions were resolved from (same indices), `origins` where each
 * came from, `balance` the known balance of an asset on a network.
 */
export function movesReason(input: {
  readonly actions: readonly ResolvedAction[];
  readonly steps: readonly (WorkStep | undefined)[];
  readonly origins: readonly (MoveOrigin | undefined)[];
  readonly thirdParty: (action: ResolvedAction) => boolean;
  readonly balance: (network: NetworkKey, symbol: string) => string | undefined;
}): MovesReason | null {
  const { actions, steps, origins } = input;
  // One goal, several independent moves (each source's first step spends a holding, not the previous output).
  const perGoal = new Map<number, number>();
  actions.forEach((_action, index) => {
    const origin = origins[index];
    const step = steps[index];
    if (!origin?.goal || !step || step.amount?.v.t === "previous") return;
    perGoal.set(origin.step, (perGoal.get(origin.step) ?? 0) + 1);
  });
  for (const [step, moves] of perGoal) if (moves > 1) return { kind: "several", step, moves };
  for (const [index, action] of actions.entries()) {
    const step = steps[index];
    const amount = step?.amount;
    // A payment of a whole holding or a share of it to someone else (I13): confirmed with the amount.
    if (input.thirdParty(action) && amount && amount.by !== "answer" && amount.v.t === "balance") {
      return { kind: "holding-to-third-party", action: index, recipient: action.recipient ?? "" };
    }
    // A target amount Kletia computed that moves more than half of what the network holds (the solver marks it).
    if ((step as (WorkStep & { movesMajority?: true }) | undefined)?.movesMajority) {
      return { kind: "computed", action: index, network: action.network, symbol: action.from };
    }
  }
  return null;
}
