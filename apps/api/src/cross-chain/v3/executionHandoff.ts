import { getAddress } from "viem";

import {
  compileWorkflowPlanV2,
  rebindWorkflowPlanAuthorization,
  sealWorkflowPlanV2,
} from "../v2/compiler.js";
import { findIntentScenario } from "../v2/intentGrammar.js";
import type { ParsedWorkflowGoalV2 } from "../v2/parser.js";
import { readWorkflowRouteMetrics } from "../v2/quotes.js";
import type { WorkflowPlanV2 } from "../v2/types.js";
import { readArbitrumSepoliaBorrowCapacity } from "../../networks/arbitrum-sepolia/service.js";
import { workflowPlanV3Hash } from "./compiler.js";
import type { WorkflowPlanV3 } from "./types.js";

const ARC_TO_ARBITRUM_SCENARIO_ID =
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
const HASH_PATTERN = /^0x[a-f\d]{64}$/u;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function evmWallet(plan: WorkflowPlanV3, chainId: 5_042_002 | 421_614): `0x${string}` {
  const binding = plan.walletBindings.find(
    (candidate) => candidate.family === "evm" && candidate.chainId === chainId,
  );
  if (!binding || binding.family !== "evm") {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_WALLET_MISSING",
      `The eip155:${chainId} wallet is not sealed in the parent workflow.`,
    );
  }
  return getAddress(binding.address);
}

function privateCommitment(
  plan: WorkflowPlanV3,
  field: "amount" | "recipient",
): `0x${string}` {
  const binding = plan.intent.privateBindings.find(
    (candidate) => candidate.field === field,
  );
  if (
    !binding ||
    binding.disclosureLevel !== "public_execution" ||
    !HASH_PATTERN.test(binding.commitment)
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_PRIVATE_BINDING_MISSING",
      `The ${field} commitment is not sealed for explicit public execution.`,
    );
  }
  return binding.commitment;
}

function assertExactHandoffBoundary(plan: WorkflowPlanV3) {
  const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
  const currentStep = route?.steps.find((candidate) => candidate.id === plan.currentStepId);
  if (
    plan.lane !== "testnet" ||
    plan.expiresAt <= Date.now() ||
    plan.selectedRouteId !== "arc-arbitrum-direct-cctp" ||
    !route ||
    !route.available ||
    !route.hydration ||
    route.hydration.status !== "live_quote_bound" ||
    !route.metrics.amountDependentCostsComplete ||
    route.metrics.estimatedApyBps === null ||
    plan.controlPlane.proofBinding.status !== "bound" ||
    plan.controlPlane.commitment.status !== "confirmed" ||
    plan.controlPlane.receiptRegistry.status !== "confirmed" ||
    !plan.controlPlane.commitment.transactionHash ||
    !plan.controlPlane.receiptRegistry.transactionHash ||
    !currentStep ||
    currentStep.operation !== "approve" ||
    currentStep.chain.key !== "arc_testnet" ||
    currentStep.protocol !== "circle-cctp-v2" ||
    currentStep.status !== "awaiting_signature" ||
    currentStep.executionReadiness !== "ready" ||
    plan.compatibility !== undefined
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_HANDOFF_NOT_READY",
      "The V3 workflow is not at its fresh, proof-bound and registry-confirmed financial handoff boundary.",
    );
  }
  return route;
}

function executionGoal(plan: WorkflowPlanV3): ParsedWorkflowGoalV2 {
  const scenario = findIntentScenario(ARC_TO_ARBITRUM_SCENARIO_ID);
  if (!scenario || scenario.executionReadiness !== "executable") {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_SCENARIO_UNAVAILABLE",
      "The reviewed Arc to Arbitrum Sepolia executor scenario is unavailable.",
      503,
    );
  }
  const includeBorrowCapacity = plan.intent.legs.some(
    (leg) => leg.operation === "borrow_capacity",
  );
  const toggles = {
    stellarPolicyCenter: false,
    includeBorrowCapacity,
  } as const;
  return {
    isComplete: true,
    semanticGoal: plan.intent.semanticGoal,
    scenarioId: scenario.id,
    scenario,
    toggles,
    sourceNetwork: scenario.sourceNetwork,
    destinationNetwork: scenario.destinationNetwork,
    asset: scenario.asset,
    targetProtocol: scenario.targetProtocol,
    targetAction: scenario.targetAction,
    privateFieldIsolation: true,
    ledgerConfidentialityRequested: false,
    includeBorrowCapacity,
    stellarPolicyCenter: false,
  };
}

function constrainExecutorToParent(
  plan: WorkflowPlanV2,
  parent: WorkflowPlanV3,
): WorkflowPlanV2 {
  const parentPlanHash = workflowPlanV3Hash(parent);
  const expiresAt = Math.min(plan.expiresAt, parent.expiresAt);
  return rebindWorkflowPlanAuthorization({
    ...plan,
    expiresAt,
    steps: plan.steps.map((step) =>
      step.deadline === undefined
        ? step
        : { ...step, deadline: Math.min(step.deadline, expiresAt) },
    ),
    parentWorkflowV3: {
      schemaVersion: "kletia_workflow_v3_execution_parent_v1",
      workflowId: parent.workflowId,
      workflowRoot: parent.controlPlane.workflowRoot,
      planHashAtHandoff: parentPlanHash,
      expiresAt,
      controlPlaneTransactionHash:
        parent.controlPlane.commitment.transactionHash!,
      receiptRegistryTransactionHash:
        parent.controlPlane.receiptRegistry.transactionHash!,
      externalExecutionTruthProvenByStellar: false,
    },
  });
}

export interface WorkflowExecutionHandoffDependenciesV3 {
  readonly readRouteMetrics: typeof readWorkflowRouteMetrics;
  readonly readBorrowCapacity: typeof readArbitrumSepoliaBorrowCapacity;
}

const DEFAULT_DEPENDENCIES: WorkflowExecutionHandoffDependenciesV3 = {
  readRouteMetrics: readWorkflowRouteMetrics,
  readBorrowCapacity: readArbitrumSepoliaBorrowCapacity,
};

export async function bindReviewedWorkflowV2ExecutorV3(
  plan: WorkflowPlanV3,
  dependencies: WorkflowExecutionHandoffDependenciesV3 = DEFAULT_DEPENDENCIES,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly handoff: {
    readonly executionKind: "workflow_plan_v2";
    readonly workflowPlan: WorkflowPlanV2;
    readonly workflowToken: string;
    readonly parentPlanHash: `0x${string}`;
    readonly externalExecutionTruthProvenByStellar: false;
  };
}> {
  const route = assertExactHandoffBoundary(plan);
  const amountCommitment = privateCommitment(plan, "amount");
  const recipientCommitment = privateCommitment(plan, "recipient");
  if (route.hydration!.amountCommitment !== amountCommitment) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_AMOUNT_BINDING_MISMATCH",
      "The live route quote no longer matches the protected amount commitment.",
    );
  }
  const arcAddress = evmWallet(plan, 5_042_002);
  const arbitrumSepoliaAddress = evmWallet(plan, 421_614);
  // The selected policy/auction route is immutable. Circle fee evidence is
  // deliberately short-lived, so it is refreshed here and independently
  // sealed by the exact V2 execution manifest the user signs next.
  const aave = await dependencies.readBorrowCapacity(arbitrumSepoliaAddress);
  const liveMetrics = await dependencies.readRouteMetrics(
    aave.supplyApyBps,
    "direct_only",
  );
  const observedAt = liveMetrics.direct.observedAt;
  const quoteExpiresAt = liveMetrics.direct.quoteExpiresAt;
  const standardFeeBps = liveMetrics.direct.cctpLegs[0]?.standardFeeBps;
  if (
    quoteExpiresAt <= Date.now() ||
    standardFeeBps === undefined ||
    !Number.isFinite(standardFeeBps) ||
    standardFeeBps < 0 ||
    standardFeeBps > 10_000
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_QUOTE_STALE",
      "A fresh official Circle fee quote is required before the financial executor can be bound.",
      503,
    );
  }
  const aaveSupplyApyBps = aave.supplyApyBps;
  const compiled = compileWorkflowPlanV2({
    requestId: plan.requestId,
    goal: executionGoal(plan),
    amountCommitment,
    recipientCommitment,
    routePreference: "direct_cctp",
    privacyBudgetPreset: "deterministic_only_public_execution",
    policyAnchorMode: "local_manifest",
    arcAddress,
    arbitrumSepoliaAddress,
    routeMetrics: {
      direct: {
        observedAt,
        quoteExpiresAt,
        cctpStandardFeeBps: standardFeeBps,
        cctpHops: 1,
        cctpLegs: [{ sourceDomain: 26, destinationDomain: 3, standardFeeBps }],
        aaveSupplyApyBps,
        sources: liveMetrics.direct.sources,
      },
    },
  });
  const executor = constrainExecutorToParent(compiled, plan);
  if (
    executor.selectedRoute !== "direct_cctp" ||
    executor.policyAnchor.mode !== "local_manifest" ||
    executor.privacy.amountCommitment !== amountCommitment ||
    executor.privacy.recipientCommitment !== recipientCommitment ||
    executor.walletBindings.find((binding) => binding.id === "arc_wallet")?.address !== arcAddress ||
    executor.walletBindings.find((binding) => binding.id === "arbitrum_sepolia_wallet")?.address !== arbitrumSepoliaAddress ||
    executor.parentWorkflowV3?.workflowId !== plan.workflowId
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_BINDING_MISMATCH",
      "The reviewed V2 executor changed a wallet, route, commitment or parent binding.",
      503,
    );
  }
  const parentPlanHash = workflowPlanV3Hash(plan);
  const compatibility = {
    engine: "workflow_v2" as const,
    routeId: route.id,
    policyRouteHash: route.solverRouteHash,
    workflowId: executor.workflowId,
    parentPlanHash,
    planCoreSha256: executor.authorizationBoundary.planCoreSha256,
    executionEvidenceObservedAt: observedAt,
    executionQuoteExpiresAt: quoteExpiresAt,
    amountCommitment,
    recipientCommitment,
    latestPlanCoreSha256: executor.authorizationBoundary.planCoreSha256,
    confirmedCheckpointCount: 0,
    totalCheckpointCount: executor.steps.length,
    currentAction: "cctp_approve" as const,
    terminalReceiptSha256: null,
    updatedAt: new Date().toISOString(),
    status: "bound" as const,
  };
  return {
    plan: { ...plan, compatibility },
    handoff: {
      executionKind: "workflow_plan_v2",
      workflowPlan: executor,
      workflowToken: sealWorkflowPlanV2(executor),
      parentPlanHash,
      externalExecutionTruthProvenByStellar: false,
    },
  };
}
