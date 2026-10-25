/**
 * The last check before a wallet is asked to sign a step: a step whose
 * transaction is already recorded is never offered for a signature again.
 * "Recorded" is either the API's word (the step was submitted or moved past
 * signing) or a hash this tab kept that the API has not accepted yet. The
 * execution hook checks the step again (a fresh read of the intent) before
 * it asks, and once more right before the wallet prompt opens.
 *
 * Pure (node --test loads it).
 */
import type { IntentStep, StepStatus } from "@kletia/core";

/** Step states that mean the wallet already sent the step's transaction. */
const SENT: ReadonlySet<StepStatus> = new Set<StepStatus>(["submitted", "confirmed", "settling", "indeterminate", "settled"]);

export type GuardedStep = Pick<IntentStep, "id" | "title" | "status">;

function shortReference(reference: string): string {
  return reference.length > 14 ? `${reference.slice(0, 8)}…${reference.slice(-4)}` : reference;
}

/**
 * Why Kletia refuses to ask the wallet to sign `step`, or null when it may.
 * `recorded`: transaction references this tab holds for the step that the
 * API has not accepted (they are submitted, never signed over).
 */
export function signingRefusal(step: GuardedStep, recorded: readonly string[] = []): string | null {
  if (SENT.has(step.status)) {
    return `Kletia will not ask your wallet to sign “${step.title}” again: its transaction was already sent. Nothing new was requested.`;
  }
  const first = recorded[0];
  if (first) {
    return `Kletia will not ask your wallet to sign “${step.title}” again: this tab already recorded its transaction ${shortReference(first)}. Resume to check it on-chain; nothing new was requested.`;
  }
  return null;
}
