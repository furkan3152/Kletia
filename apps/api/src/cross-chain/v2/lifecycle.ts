/**
 * WorkflowLifecycleV1 — deterministic failure classification.
 *
 * The release doctrine separates `submitted`, `confirmed`, `failed`,
 * `indeterminate` and `recovery_required`. Before this module the first three
 * were produced by real code paths while the last two only existed in the type
 * union, so the doctrine was a claim rather than a behaviour.
 *
 * Every checkpoint failure is now classified into exactly one terminal or
 * recoverable lifecycle state, written into the sealed plan, and re-sealed so
 * the browser observes the same state the server decided. Two invariants hold:
 *
 *  1. No silent retry. A retryable classification never resubmits anything; it
 *     only records that an explicit, user-signed retry is permitted.
 *  2. A step that reached `failed` or `recovery_required` can never be advanced
 *     again with the same sealed plan. Recovery is an explicit, separate act.
 *
 * Limitation stated plainly: classification reads the error surface of our own
 * verifiers. It cannot prove that an unobserved transaction does not exist on
 * chain — that is precisely why the unresolved case is `indeterminate` and not
 * `failed`.
 */

import { rebindWorkflowPlanAuthorization } from "./compiler.js";
import type { WorkflowPlanV2, WorkflowV2Status, WorkflowV2Step } from "./types.js";

export type WorkflowLifecycleOutcome =
  | "failed"
  | "indeterminate"
  | "recovery_required";

export interface WorkflowLifecycleClassificationV1 {
  readonly schemaVersion: "kletia_workflow_lifecycle_v1";
  readonly status: WorkflowLifecycleOutcome;
  readonly code: string;
  /** An explicit, re-signed retry is permitted. Never an automatic resubmit. */
  readonly retryable: boolean;
  readonly silentRetryAllowed: false;
  readonly reason: string;
  readonly operatorAction: string;
}

/**
 * Unresolved outcomes. The chain may or may not have accepted the work, so the
 * only honest answer is "not known yet". Retry is allowed but must be explicit.
 */
const INDETERMINATE_CODES: ReadonlySet<string> = new Set([
  "WORKFLOW_STELLAR_TRANSACTION_UNAVAILABLE",
  "STELLAR_OPERATION_UNAVAILABLE",
  "CCTP_ATTESTATION_UNAVAILABLE",
  "CCTP_ATTESTATION_PENDING",
  "CCTP_FEE_QUOTE_EXPIRED",
  "WORKFLOW_AUTHORIZATION_EXPIRED",
  "STELLAR_PROTOCOL_MANIFEST_UNREADABLE",
]);

/**
 * Outcomes where evidence exists somewhere but this sealed plan can no longer
 * bind it. Retrying the same step cannot help; the user must run recovery.
 */
const RECOVERY_REQUIRED_CODES: ReadonlySet<string> = new Set([
  "PRIVATE_AMOUNT_COMMITMENT_MISMATCH",
  "PRIVATE_AMOUNT_OPENING_INVALID",
  "PRIVATE_RECIPIENT_OPENING_INVALID",
  "PRIVATE_RECIPIENT_COMMITMENT_MISMATCH",
  "CCTP_SOURCE_EVIDENCE_MISSING",
  "CCTP_BURN_FEE_EVIDENCE_MISSING",
  "WORKFLOW_ROUTE_EVIDENCE_MISSING",
  "STELLAR_ARCHIVE_UNRECOVERABLE_GAP",
  "STELLAR_EVENT_ARCHIVE_CONFLICT",
  "STELLAR_CCTP_PAYOUT_EVIDENCE_MISSING",
  "STELLAR_CCTP_PAYOUT_MISMATCH",
]);

const LIFECYCLE_REASON: Readonly<Record<WorkflowLifecycleOutcome, string>> = {
  failed:
    "A deterministic boundary rejected this checkpoint, so the step cannot be confirmed.",
  indeterminate:
    "The checkpoint outcome could not be observed, so it is neither confirmed nor known to have failed.",
  recovery_required:
    "Checkpoint evidence could not be bound to this sealed plan, so explicit recovery is required.",
};

const LIFECYCLE_OPERATOR_ACTION: Readonly<
  Record<WorkflowLifecycleOutcome, string>
> = {
  failed:
    "Inspect the rejected evidence and compile a new plan; this sealed plan will not advance.",
  indeterminate:
    "Re-observe the checkpoint and retry explicitly. Nothing is resubmitted automatically.",
  recovery_required:
    "Run workflow recovery with the encrypted bundle before attempting this step again.",
};

function errorCode(error: unknown): string {
  const candidate = (error as { code?: unknown })?.code;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : "WORKFLOW_CHECKPOINT_UNCLASSIFIED";
}

function errorStatusCode(error: unknown): number | null {
  const candidate = (error as { statusCode?: unknown })?.statusCode;
  return Number.isInteger(candidate) ? Number(candidate) : null;
}

export function classifyWorkflowLifecycleFailure(
  error: unknown,
): WorkflowLifecycleClassificationV1 {
  const code = errorCode(error);
  const statusCode = errorStatusCode(error);
  let status: WorkflowLifecycleOutcome;
  if (code === "WORKFLOW_V2_CHECKPOINT_STORE_UNAVAILABLE") {
    // The store distinguishes a reachability fault (503) from evidence that was
    // already consumed by a different checkpoint (409). Only the latter needs
    // recovery; the former is simply unobserved.
    status = statusCode === 409 ? "recovery_required" : "indeterminate";
  } else if (RECOVERY_REQUIRED_CODES.has(code)) {
    status = "recovery_required";
  } else if (INDETERMINATE_CODES.has(code)) {
    status = "indeterminate";
  } else if (code === "WORKFLOW_CHECKPOINT_UNCLASSIFIED" || statusCode === null || statusCode >= 500) {
    // An unrecognised or infrastructure-level fault is never reported as a
    // definite failure, because we did not observe a definite outcome.
    status = "indeterminate";
  } else {
    status = "failed";
  }
  return {
    schemaVersion: "kletia_workflow_lifecycle_v1",
    status,
    code,
    retryable: status === "indeterminate",
    silentRetryAllowed: false,
    reason: LIFECYCLE_REASON[status],
    operatorAction: LIFECYCLE_OPERATOR_ACTION[status],
  };
}

/**
 * Writes the classified lifecycle status onto the current step.
 *
 * Step status is deliberately excluded from the immutable plan core, so this
 * does not invalidate an existing manifest signature: the user authorised the
 * plan's economic bindings, not its observation history.
 */
export function applyWorkflowLifecycleStatus(
  plan: WorkflowPlanV2,
  classification: WorkflowLifecycleClassificationV1,
): WorkflowPlanV2 {
  const current = plan.steps[plan.currentStepIndex];
  // A post-checkpoint service failure can happen after the final transaction
  // was durably verified. Never rewrite that confirmed/filled checkpoint into
  // an error state: doing so would make already-consumed onchain evidence look
  // eligible for submission again. The lifecycle classification is still
  // returned alongside the re-sealed plan by the transport layer.
  if (current?.status === "confirmed" || current?.status === "filled") {
    return rebindWorkflowPlanAuthorization(plan);
  }
  const steps = plan.steps.map((step, index) =>
    index === plan.currentStepIndex
      ? { ...step, status: classification.status satisfies WorkflowV2Status }
      : step,
  );
  return rebindWorkflowPlanAuthorization({ ...plan, steps });
}

/**
 * Fail-closed gate: a step that already reached a non-retryable lifecycle state
 * must not be advanced again under the same sealed plan.
 */
export function assertWorkflowStepAdvanceable(plan: WorkflowPlanV2): void {
  const current: WorkflowV2Step | undefined = plan.steps[plan.currentStepIndex];
  if (!current) {
    throw Object.assign(new Error("The sealed workflow has no advanceable step."), {
      code: "WORKFLOW_STEP_MISSING",
      statusCode: 409,
    });
  }
  if (current.status === "failed") {
    throw Object.assign(
      new Error(
        "This checkpoint already failed deterministically. Compile a new plan instead of retrying.",
      ),
      { code: "WORKFLOW_STEP_FAILED", statusCode: 409 },
    );
  }
  if (current.status === "recovery_required") {
    throw Object.assign(
      new Error(
        "This checkpoint requires explicit recovery before it can be advanced again.",
      ),
      { code: "WORKFLOW_RECOVERY_REQUIRED", statusCode: 409 },
    );
  }
}

export interface WorkflowLifecycleFailure extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly lifecycle: WorkflowLifecycleClassificationV1;
  readonly workflowToken: string;
  readonly workflowPlan: WorkflowPlanV2;
}

/**
 * Classifies a checkpoint failure, records it in the sealed plan and returns an
 * error carrying both. The caller rethrows this so the transport layer can hand
 * the client a plan whose observable state matches the server's decision.
 */
export function sealWorkflowLifecycleFailure(
  plan: WorkflowPlanV2,
  error: unknown,
  seal: (plan: WorkflowPlanV2) => string,
): WorkflowLifecycleFailure {
  const lifecycle = classifyWorkflowLifecycleFailure(error);
  const nextPlan = applyWorkflowLifecycleStatus(plan, lifecycle);
  const statusCode = errorStatusCode(error) ?? 409;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : lifecycle.reason;
  return Object.assign(new Error(message, { cause: error }), {
    code: lifecycle.code,
    statusCode,
    lifecycle,
    workflowToken: seal(nextPlan),
    workflowPlan: nextPlan,
  }) as WorkflowLifecycleFailure;
}
