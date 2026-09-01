import { computeWorkflowPlanCoreSha256, openWorkflowPlanV2 } from "../v2/compiler.js";
import type { WorkflowPlanV2, WorkflowV2Status } from "../v2/types.js";
import { deriveRouteBoundWorkflowRootV3 } from "../v3/compiler.js";
import { computeWorkflowV2TerminalReceiptSha256 } from "../v3/executionSync.js";
import type { WorkflowPlanV4 } from "./types.js";

const ACTION_BINDINGS = [
  { action: "cctp_approve", operation: "approve", chain: "arc_testnet" },
  { action: "cctp_burn", operation: "bridge", chain: "arc_testnet" },
  { action: "cctp_attestation", operation: "attestation", chain: "arc_testnet" },
  { action: "cctp_mint", operation: "cctp_mint", chain: "arbitrum_sepolia" },
  { action: "aave_approve", operation: "approve", chain: "arbitrum_sepolia" },
  { action: "aave_supply", operation: "supply", chain: "arbitrum_sepolia" },
  { action: "borrow_capacity", operation: "borrow_capacity", chain: "arbitrum_sepolia" },
] as const;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function progressStatus(plan: WorkflowPlanV2): WorkflowPlanV4["executionHandoff"]["progressStatus"] {
  const active = plan.steps[plan.currentStepIndex];
  if (plan.terminalReceipt) return "completed";
  if (active?.status === "failed") return "failed";
  if (active?.status === "indeterminate") return "indeterminate";
  if (active?.status === "recovery_required") return "recovery_required";
  if (active?.status === "refunded") return "refunded";
  return plan.steps.some((step) => step.status === "confirmed" || step.status === "filled")
    ? "in_progress"
    : "not_started";
}

function mappedStatus(status: WorkflowV2Status) {
  if (status === "filled") return "confirmed" as const;
  if (status === "attesting") return "attesting" as const;
  return status;
}

function assertExecutorBinding(parent: WorkflowPlanV4, executor: WorkflowPlanV2): void {
  const handoff = parent.executionHandoff;
  const route = parent.routes.find((candidate) => candidate.id === parent.selectedRouteId);
  const bound = executor.parentWorkflowV4;
  if (
    handoff.status !== "bound" || handoff.executor !== "workflow_v2" ||
    !handoff.parentPlanHashAtHandoff || !handoff.executorWorkflowId ||
    !handoff.executorPlanCoreSha256 || !handoff.executorExpiresAt ||
    !route || route.id !== "arc-arbitrum-direct-cctp" ||
    !bound || bound.schemaVersion !== "kletia_workflow_v4_execution_parent_v1" ||
    executor.workflowId !== handoff.executorWorkflowId ||
    executor.environmentLane !== "testnet" || executor.selectedRoute !== "direct_cctp" ||
    executor.policyAnchor.mode !== "local_manifest" ||
    bound.workflowId !== parent.workflowId ||
    bound.workflowRoot !== deriveRouteBoundWorkflowRootV3(parent.compatibility.plan, route.id) ||
    bound.planHashAtHandoff !== handoff.parentPlanHashAtHandoff ||
    bound.expiresAt !== handoff.executorExpiresAt || executor.expiresAt !== handoff.executorExpiresAt ||
    bound.controlPlaneContractId !== parent.controlPlane.contractId ||
    bound.controlPlaneTransactionHash !== parent.controlPlane.commitment.transactionHash ||
    bound.controlPlaneNonce !== parent.controlPlane.commitment.nonce ||
    bound.policyProofPublicInputsHash !== parent.policy.proofBinding.publicInputsHash ||
    bound.externalExecutionTruthProvenByStellar !== false ||
    computeWorkflowPlanCoreSha256(executor) !== executor.authorizationBoundary.planCoreSha256 ||
    route.steps.length !== executor.steps.length ||
    executor.steps.some((step, index) => {
      const expected = ACTION_BINDINGS[index];
      const parentStep = route.steps[index];
      return !expected || !parentStep || step.action !== expected.action ||
        step.network !== expected.chain || parentStep.operation !== expected.operation ||
        parentStep.chain.key !== expected.chain ||
        (step.target !== undefined && parentStep.target !== step.target);
    })
  ) {
    throw controlled(
      "WORKFLOW_V4_EXECUTION_SYNC_BINDING_MISMATCH",
      "The executor token did not preserve its exact V4 parent, policy, route and checkpoint bindings.",
    );
  }
}

export function synchronizeWorkflowExecutionV4(
  parent: WorkflowPlanV4,
  workflowTokenV2: unknown,
): { readonly plan: WorkflowPlanV4; readonly executorPlan: WorkflowPlanV2 } {
  const executor = openWorkflowPlanV2(workflowTokenV2);
  assertExecutorBinding(parent, executor);
  const previous = parent.executionHandoff;
  const confirmedCheckpointCount = executor.steps.filter(
    (step) => step.status === "confirmed" || step.status === "filled",
  ).length;
  const status = progressStatus(executor);
  const terminalReceiptSha256 = executor.terminalReceipt?.receiptSha256 ?? null;
  if (
    confirmedCheckpointCount < previous.confirmedCheckpointCount ||
    previous.totalCheckpointCount !== executor.steps.length ||
    (previous.terminalReceiptSha256 !== null && previous.terminalReceiptSha256 !== terminalReceiptSha256) ||
    (status === "completed" && (
      confirmedCheckpointCount !== executor.steps.length ||
      !executor.manifestAuthorization ||
      terminalReceiptSha256 !== computeWorkflowV2TerminalReceiptSha256(executor)
    ))
  ) {
    throw controlled(
      "WORKFLOW_V4_EXECUTION_SYNC_REGRESSION",
      "Executor progress was older than durable V4 state or its terminal receipt was inconsistent.",
    );
  }
  const route = parent.routes.find((candidate) => candidate.id === parent.selectedRouteId)!;
  const steps = route.steps.map((step, index) => ({
    ...step,
    status: mappedStatus(executor.steps[index]!.status),
  }));
  const currentAction = status === "completed"
    ? null
    : executor.steps[executor.currentStepIndex]?.action ?? null;
  const currentBinding = currentAction
    ? ACTION_BINDINGS.find((candidate) => candidate.action === currentAction)
    : null;
  const currentStepId = currentBinding
    ? steps.find((step) => step.operation === currentBinding.operation && step.chain.key === currentBinding.chain)?.id ?? null
    : null;
  const lastSyncedAt = executor.terminalReceipt?.generatedAt ??
    [...executor.steps].reverse().find((step) => step.result)?.result?.observedAt ??
    new Date(executor.authorizationRefreshedAt ?? executor.createdAt).toISOString();
  return {
    executorPlan: executor,
    plan: {
      ...parent,
      routes: parent.routes.map((candidate) => candidate.id === route.id ? { ...candidate, steps } : candidate),
      currentStepId,
      executionHandoff: {
        ...previous,
        progressStatus: status,
        confirmedCheckpointCount,
        currentAction,
        terminalReceiptSha256,
        lastSyncedAt,
      },
      executionGate: {
        signable: false,
        status: "reviewed_executor_bound",
        reasons: [status === "completed"
          ? "Every reviewed financial checkpoint is confirmed; separate Stellar receipt-root finalization is still required."
          : "The parent-bound executor is active; only its current exact checkpoint may request a wallet action."],
      },
    },
  };
}
