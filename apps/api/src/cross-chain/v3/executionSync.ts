import {
  computeWorkflowPlanCoreSha256,
  openWorkflowPlanV2,
} from "../v2/compiler.js";
import type {
  WorkflowPlanV2,
  WorkflowV2Status,
} from "../v2/types.js";
import type {
  WorkflowPlanV3,
  WorkflowStepStatusV3,
  WorkflowV2ExecutorActionV3,
} from "./types.js";

const HASH_PATTERN = /^0x[a-f\d]{64}$/u;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonicalReceiptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReceiptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalReceiptValue(entry)]),
    );
  }
  return value;
}

export function computeWorkflowV2TerminalReceiptSha256(plan: WorkflowPlanV2): `0x${string}` | null {
  const terminal = plan.terminalReceipt;
  if (!terminal || !plan.manifestAuthorization) return null;
  const payload = {
    schemaVersion: "kletia_execution_receipt_v1" as const,
    workflowId: plan.workflowId,
    workflowBindingHash: plan.manifestAuthorization.manifestSha256,
    planCoreSha256: plan.authorizationBoundary.planCoreSha256,
    status: "confirmed" as const,
    generatedAt: terminal.generatedAt,
    crossChainAtomicity: plan.policies.crossChainAtomicity,
    privateValuesExcludedFromAiPlanning: true as const,
    manifestAuthorization: plan.manifestAuthorization,
    privacyBudget: plan.privacy.privacyBudget,
    disclosureDiff: plan.privacy.disclosureDiff,
    verificationModel: {
      kind: "evidence_bound_application_receipt_sha256" as const,
      recomputeReceiptHash: true as const,
      verifyUnderlyingChainEvidence: true as const,
      kletiaSignaturePresent: false as const,
      onchainAnchorPresent: false as const,
      limitation:
        "The receipt is tamper-evident and bound to verified checkpoint evidence; its SHA-256 value is not a Kletia signature or an independent proof of external-chain consensus.",
    },
    checkpoints: plan.steps.map((step) => ({
      stepId: step.id,
      action: step.action,
      network: step.network,
      status: step.status,
      target: step.target,
      binding: step.binding,
      evidenceRequired: step.evidenceRequired,
      result: step.result,
    })),
  };
  return `0x${createHash("sha256")
    .update(JSON.stringify(canonicalReceiptValue(payload)))
    .digest("hex")}`;
}

const ACTION_BINDINGS: ReadonlyArray<{
  readonly action: WorkflowV2ExecutorActionV3;
  readonly operation: string;
  readonly chain: "arc_testnet" | "arbitrum_sepolia";
}> = [
  { action: "cctp_approve", operation: "approve", chain: "arc_testnet" },
  { action: "cctp_burn", operation: "bridge", chain: "arc_testnet" },
  { action: "cctp_attestation", operation: "attestation", chain: "arc_testnet" },
  { action: "cctp_mint", operation: "cctp_mint", chain: "arbitrum_sepolia" },
  { action: "aave_approve", operation: "approve", chain: "arbitrum_sepolia" },
  { action: "aave_supply", operation: "supply", chain: "arbitrum_sepolia" },
  { action: "borrow_capacity", operation: "borrow_capacity", chain: "arbitrum_sepolia" },
];

function mappedStatus(status: WorkflowV2Status): WorkflowStepStatusV3 {
  if (status === "filled") return "confirmed";
  if (status === "attesting") return "attesting";
  return status;
}

function executorAction(value: WorkflowPlanV2["steps"][number]["action"] | undefined): WorkflowV2ExecutorActionV3 | null {
  return ACTION_BINDINGS.some((candidate) => candidate.action === value)
    ? value as WorkflowV2ExecutorActionV3
    : null;
}

function progressStatus(plan: WorkflowPlanV2): NonNullable<WorkflowPlanV3["compatibility"]>["status"] {
  const active = plan.steps[plan.currentStepIndex];
  if (plan.terminalReceipt) return "completed";
  if (active?.status === "failed") return "failed";
  if (active?.status === "indeterminate") return "indeterminate";
  if (active?.status === "recovery_required") return "recovery_required";
  if (active?.status === "refunded") return "refunded";
  return plan.steps.some((step) => step.status === "confirmed" || step.status === "filled")
    ? "in_progress"
    : "bound";
}

function assertExecutorBinding(parent: WorkflowPlanV3, executor: WorkflowPlanV2): void {
  const compatibility = parent.compatibility;
  const route = parent.routes.find((candidate) => candidate.id === parent.selectedRouteId);
  const v3Financial = route?.steps.filter((step) =>
    step.operation !== "control_plane_commit" &&
    step.operation !== "receipt_registry_commit" &&
    step.operation !== "receipt_registry_finalize" &&
    step.operation !== "control_plane_finalize"
  );
  if (
    !compatibility ||
    compatibility.engine !== "workflow_v2" ||
    compatibility.routeId !== "arc-arbitrum-direct-cctp" ||
    parent.selectedRouteId !== compatibility.routeId ||
    parent.controlPlane.externalExecutionTruthProven !== false ||
    executor.workflowId !== compatibility.workflowId ||
    executor.selectedRoute !== "direct_cctp" ||
    executor.policyAnchor.mode !== "local_manifest" ||
    executor.environmentLane !== "testnet" ||
    executor.parentWorkflowV3?.schemaVersion !== "kletia_workflow_v3_execution_parent_v1" ||
    executor.parentWorkflowV3.workflowId !== parent.workflowId ||
    executor.parentWorkflowV3.workflowRoot !== parent.controlPlane.workflowRoot ||
    executor.parentWorkflowV3.planHashAtHandoff !== compatibility.parentPlanHash ||
    executor.parentWorkflowV3.expiresAt !== parent.expiresAt ||
    executor.parentWorkflowV3.controlPlaneTransactionHash !==
      parent.controlPlane.commitment.transactionHash ||
    executor.parentWorkflowV3.receiptRegistryTransactionHash !==
      parent.controlPlane.receiptRegistry.transactionHash ||
    executor.parentWorkflowV3.externalExecutionTruthProvenByStellar !== false ||
    executor.privacy.amountCommitment !== compatibility.amountCommitment ||
    executor.privacy.recipientCommitment !== compatibility.recipientCommitment ||
    computeWorkflowPlanCoreSha256(executor) !==
      executor.authorizationBoundary.planCoreSha256 ||
    !v3Financial ||
    v3Financial.length !== executor.steps.length ||
    executor.steps.some((step, index) => {
      const expected = ACTION_BINDINGS[index];
      const v3 = v3Financial[index];
      return !expected || !v3 || step.action !== expected.action ||
        step.network !== expected.chain || v3.operation !== expected.operation ||
        v3.chain.key !== expected.chain ||
        (step.target !== undefined && v3.target !== step.target);
    })
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTION_SYNC_BINDING_MISMATCH",
      "The reviewed executor token did not preserve its exact V3 parent, route, wallet and checkpoint bindings.",
    );
  }
}

export function synchronizeWorkflowExecutionV3(
  parent: WorkflowPlanV3,
  workflowTokenV2: unknown,
): { readonly plan: WorkflowPlanV3; readonly executorPlan: WorkflowPlanV2 } {
  const executor = openWorkflowPlanV2(workflowTokenV2);
  assertExecutorBinding(parent, executor);
  const compatibility = parent.compatibility!;
  const confirmedCheckpointCount = executor.steps.filter(
    (step) => step.status === "confirmed" || step.status === "filled",
  ).length;
  const status = progressStatus(executor);
  const terminalReceiptSha256 = executor.terminalReceipt?.receiptSha256 ?? null;
  const expectedReceiptSha256 = computeWorkflowV2TerminalReceiptSha256(executor);
  const allConfirmed = confirmedCheckpointCount === executor.steps.length;
  if (
    (status === "completed") !== Boolean(executor.terminalReceipt) ||
    (status === "completed" && (
      !allConfirmed || !executor.manifestAuthorization ||
      terminalReceiptSha256 !== expectedReceiptSha256
    )) ||
    (executor.terminalReceipt && (
      executor.terminalReceipt.checkpointCount !== executor.steps.length ||
      executor.terminalReceipt.executorPlanCoreSha256 !==
        executor.authorizationBoundary.planCoreSha256 ||
      executor.terminalReceipt.externalExecutionTruthProvenByStellar !== false ||
      !HASH_PATTERN.test(executor.terminalReceipt.receiptSha256)
    )) ||
    confirmedCheckpointCount < compatibility.confirmedCheckpointCount ||
    (confirmedCheckpointCount === compatibility.confirmedCheckpointCount &&
      compatibility.status !== "bound" && compatibility.status !== status) ||
    (compatibility.terminalReceiptSha256 !== null &&
      compatibility.terminalReceiptSha256 !== terminalReceiptSha256)
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTION_SYNC_REGRESSION",
      "The executor progress was incomplete, terminally inconsistent or older than the durable V3 state.",
    );
  }

  const route = parent.routes.find((candidate) => candidate.id === compatibility.routeId)!;
  let executorIndex = 0;
  const steps = route.steps.map((step) => {
    if (
      step.operation === "control_plane_commit" ||
      step.operation === "receipt_registry_commit"
    ) return step;
    if (
      step.operation === "receipt_registry_finalize" ||
      step.operation === "control_plane_finalize"
    ) {
      if (status !== "completed") return { ...step, status: "planned" as const };
      return step.operation === "receipt_registry_finalize"
        ? { ...step, status: "awaiting_signature" as const }
        : { ...step, status: "planned" as const };
    }
    const source = executor.steps[executorIndex++];
    if (!source) {
      throw controlled(
        "WORKFLOW_V3_EXECUTION_SYNC_STEP_MISMATCH",
        "The executor progress did not contain every sealed financial checkpoint.",
      );
    }
    return { ...step, status: mappedStatus(source.status) };
  });
  const routes = parent.routes.map((candidate) =>
    candidate.id === route.id ? { ...candidate, steps } : candidate,
  );
  const currentStepId = status === "completed"
    ? steps.find((step) => step.operation === "receipt_registry_finalize")?.id ?? null
    : steps.find((step) => {
        const executorStep = executor.steps[executor.currentStepIndex];
        const binding = executorStep
          ? ACTION_BINDINGS.find((candidate) => candidate.action === executorStep.action)
          : undefined;
        return Boolean(binding && step.operation === binding.operation && step.chain.key === binding.chain);
      })?.id ?? null;
  const updatedAt = executor.terminalReceipt?.generatedAt ??
    [...executor.steps].reverse().find((step) => step.result)?.result?.observedAt ??
    new Date(executor.authorizationRefreshedAt ?? executor.createdAt).toISOString();
  return {
    executorPlan: executor,
    plan: {
      ...parent,
      routes,
      currentStepId,
      compatibility: {
        ...compatibility,
        latestPlanCoreSha256: executor.authorizationBoundary.planCoreSha256,
        confirmedCheckpointCount,
        totalCheckpointCount: executor.steps.length,
        currentAction: status === "completed"
          ? null
          : executorAction(executor.steps[executor.currentStepIndex]?.action),
        terminalReceiptSha256,
        updatedAt,
        status,
      },
    },
  };
}
import { createHash } from "node:crypto";
