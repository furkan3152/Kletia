import type { IntentGraph, IntentStep } from "@kletia/core";

import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import type { BadgeTone } from "../ui/Badge";
import { STATUS_TONE } from "./format.ts";

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
  | "unconfirmed"
  /** The run stopped before this step was signed (declined, stopped at a gate, failed while preparing). */
  | "not_signed"
  /** The run stopped while the wallet had this step's request and no outcome came back. */
  | "signature_unknown";

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
  not_signed: { label: "Not signed", tone: "neutral" },
  signature_unknown: { label: "Check your wallet", tone: "yellow" },
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

/** True when the API holds a reference for the step or moved it past signing. */
function stepHasSignature(step: IntentStep): boolean {
  return (step.references?.length ?? 0) > 0 || !["pending", "ready", "awaiting_signature", "failed", "skipped"].includes(step.status);
}

/**
 * A step's phase in the progress panel. While the run is live this is
 * `stepDisplayPhase`. Once it stopped without finishing (a declined
 * signature, a stop at a gate, a failure), a step the API still lists as
 * ready or awaiting a signature is shown as it is for the user: not signed,
 * or "check your wallet" when a request went out and no outcome came back.
 * Nothing reads "awaiting signature" when no wallet is asking.
 */
export function progressStepPhase(
  step: IntentStep,
  local: LocalStepPhase | undefined,
  { running, signatureUnknown }: { readonly running: boolean; readonly signatureUnknown: boolean },
): StepDisplayPhase {
  const phase = stepDisplayPhase(step, local);
  if (running) return phase;
  if ((phase === "ready" || phase === "awaiting_signature" || phase === "preparing") && !stepHasSignature(step)) {
    return signatureUnknown ? "signature_unknown" : "not_signed";
  }
  return phase;
}

/** `progressStepPhase` for every step of a run, from the execution hook's state. */
export function runPhaseOf(run: {
  readonly status: FlowStatus;
  readonly stepPhases: Readonly<Record<string, LocalStepPhase>>;
  readonly signatureUnknownStepIds: readonly string[];
}): (step: IntentStep) => StepDisplayPhase {
  const running = run.status === "executing";
  return (step) => progressStepPhase(step, run.stepPhases[step.id], { running, signatureUnknown: run.signatureUnknownStepIds.includes(step.id) });
}

/** The execution status of the hook driving the panel (mirrored: this module stays React-free). */
export type FlowStatus = "idle" | "planning" | "review" | "executing" | "paused" | "completed" | "failed" | "cancelled";

/**
 * The progress panel's status badge: the intent's own status while the run
 * is live or the intent is finished; otherwise what the run is doing now,
 * so the panel never says "executing" under a stopped or failed task.
 */
export function progressBadge(intent: Pick<IntentGraph, "status">, flow: FlowStatus): { label: string; tone: BadgeTone } {
  const finished = ["completed", "partially_completed", "failed", "expired", "cancelled"].includes(intent.status);
  if (!finished && flow === "failed") return { label: "Stopped", tone: "red" };
  if (!finished && flow === "paused") return { label: "Paused", tone: "yellow" };
  if (!finished && flow === "cancelled") return { label: "Cancelled", tone: "neutral" };
  return { label: intent.status.replace(/_/gu, " "), tone: STATUS_TONE[intent.status] ?? "neutral" };
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

