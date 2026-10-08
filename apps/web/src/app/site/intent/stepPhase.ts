import type { IntentGraph, IntentStep } from "@kletia/core";

import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import type { BadgeTone } from "../ui/Badge";

/** What a person sees for a step while an intent executes. */
export type StepDisplayPhase =
  | "waiting"
  | "ready"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "settling"
  | "settled"
  | "failed"
  | "skipped"
  | "unconfirmed";

export const PHASE_PRESENTATION: Readonly<Record<StepDisplayPhase, { label: string; tone: BadgeTone }>> = {
  waiting: { label: "Waiting", tone: "neutral" },
  ready: { label: "Ready to sign", tone: "blue" },
  preparing: { label: "Preparing", tone: "blue" },
  awaiting_signature: { label: "Awaiting signature", tone: "yellow" },
  submitted: { label: "Submitted", tone: "purple" },
  settling: { label: "Settling", tone: "purple" },
  settled: { label: "Settled", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  skipped: { label: "Skipped", tone: "neutral" },
  unconfirmed: { label: "Checking", tone: "yellow" },
};

/** Combines the API status with what the browser is doing right now. */
export function stepDisplayPhase(step: IntentStep, local?: LocalStepPhase): StepDisplayPhase {
  if (local === "preparing") return "preparing";
  if (local === "signing") return "awaiting_signature";
  if (local === "confirming") return "submitted";
  switch (step.status) {
    case "pending":
      return "waiting";
    case "ready":
      return "ready";
    case "awaiting_signature":
      return "awaiting_signature";
    case "submitted":
      return "submitted";
    case "confirmed":
      return step.settlement?.kind === "cross-network" ? "settling" : "submitted";
    case "settling":
      return "settling";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "indeterminate":
      return "unconfirmed";
  }
}

/** The graph with local phases folded into step statuses (for IntentGraphView). */
export function withLocalPhases(
  intent: IntentGraph,
  phases: Readonly<Record<string, LocalStepPhase>>,
): IntentGraph {
  if (Object.keys(phases).length === 0) return intent;
  return {
    ...intent,
    // The API moves a planned intent to "executing" on prepare; show it as soon as the browser starts.
    status: intent.status === "planned" ? "executing" : intent.status,
    steps: intent.steps.map((step) => {
      const phase = phases[step.id];
      if (phase === "signing" && (step.status === "ready" || step.status === "awaiting_signature")) {
        return { ...step, status: "awaiting_signature" };
      }
      if (phase === "confirming" && (step.status === "ready" || step.status === "awaiting_signature")) {
        return { ...step, status: "submitted" };
      }
      return step;
    }),
  };
}

/** Wallet signatures still ahead (steps a wallet has not signed yet). */
export function remainingSignatures(intent: IntentGraph): number {
  return intent.steps.filter(
    (step) =>
      step.mode === "wallet" &&
      (step.status === "pending" || step.status === "ready" || step.status === "awaiting_signature"),
  ).length;
}
