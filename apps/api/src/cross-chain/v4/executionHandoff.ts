import { getAddress } from "viem";

import { readArbitrumSepoliaBorrowCapacity } from "../../networks/arbitrum-sepolia/service.js";
import {
  compileWorkflowPlanV2,
  rebindWorkflowPlanAuthorization,
  sealWorkflowPlanV2,
} from "../v2/compiler.js";
import { findIntentScenario } from "../v2/intentGrammar.js";
import type { ParsedWorkflowGoalV2 } from "../v2/parser.js";
import { readWorkflowRouteMetrics } from "../v2/quotes.js";
import type { WorkflowPlanV2 } from "../v2/types.js";
import { deriveRouteBoundWorkflowRootV3 } from "../v3/compiler.js";
import { workflowPlanV4Hash } from "./compiler.js";
import type { WorkflowPlanV4 } from "./types.js";

const SCENARIO_ID = "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
const HASH_PATTERN = /^0x[a-f\d]{64}$/u;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function evmWallet(plan: WorkflowPlanV4, chainId: 5_042_002 | 421_614): `0x${string}` {
  const binding = plan.walletBindings.find(
    (candidate) => candidate.family === "evm" && candidate.chainId === chainId,
  );
  if (!binding || binding.family !== "evm") {
    throw controlled("WORKFLOW_V4_EXECUTOR_WALLET_MISSING", `The eip155:${chainId} wallet is not sealed.`);
  }
  return getAddress(binding.address);
}

function privateCommitment(plan: WorkflowPlanV4, field: "amount" | "recipient"): `0x${string}` {
  const binding = plan.intent.privateBindings.find((candidate) => candidate.field === field);
  const disclosure = plan.intent.privacyBudget.fields[field] ?? plan.intent.privacyBudget.defaultLevel;
  if (!binding || disclosure !== "public_execution" || !HASH_PATTERN.test(binding.commitment)) {
    throw controlled(
      "WORKFLOW_V4_EXECUTOR_PRIVATE_BINDING_MISSING",
      `The ${field} commitment is not sealed for explicit public execution.`,
    );
  }
  return binding.commitment;
}

function exactBoundary(plan: WorkflowPlanV4) {
  const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
  const binding = plan.policy.proofBinding;
  const commitment = plan.controlPlane.commitment;
  if (
    plan.lane !== "testnet" ||
    plan.expiresAt <= Date.now() ||
    plan.selectedRouteId !== "arc-arbitrum-direct-cctp" ||
    !route || !route.available ||
    route.hydration?.status !== "live_quote_bound" ||
    !route.metrics.amountDependentCostsComplete ||
    binding.status !== "bound" || !binding.publicInputsHash ||
    commitment.status !== "confirmed" || !plan.controlPlane.contractId ||
    !commitment.transactionHash || !commitment.nonce ||
    plan.executionHandoff.status !== "not_bound"
  ) {
    throw controlled(
      "WORKFLOW_V4_EXECUTOR_HANDOFF_NOT_READY",
      "The canonical workflow is not at its fresh, proof-bound, Stellar-committed and live-quoted executor boundary.",
    );
  }
  return { route, binding, commitment };
}

function executionGoal(plan: WorkflowPlanV4): ParsedWorkflowGoalV2 {
  const scenario = findIntentScenario(SCENARIO_ID);
  if (!scenario || scenario.executionReadiness !== "executable") {
    throw controlled("WORKFLOW_V4_EXECUTOR_SCENARIO_UNAVAILABLE", "The reviewed executor scenario is unavailable.", 503);
  }
  const includeBorrowCapacity = plan.intent.legs.some((leg) => leg.operation === "borrow_capacity");
  return {
    isComplete: true,
    semanticGoal: plan.intent.semanticGoal,
    scenarioId: scenario.id,
    scenario,
    toggles: { stellarPolicyCenter: false, includeBorrowCapacity },
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

export interface WorkflowExecutionHandoffDependenciesV4 {
  readonly readRouteMetrics: typeof readWorkflowRouteMetrics;
  readonly readBorrowCapacity: typeof readArbitrumSepoliaBorrowCapacity;
}

const DEFAULT_DEPENDENCIES: WorkflowExecutionHandoffDependenciesV4 = {
  readRouteMetrics: readWorkflowRouteMetrics,
  readBorrowCapacity: readArbitrumSepoliaBorrowCapacity,
};

export async function bindReviewedWorkflowV2ExecutorV4(
  plan: WorkflowPlanV4,
  dependencies: WorkflowExecutionHandoffDependenciesV4 = DEFAULT_DEPENDENCIES,
): Promise<{
  readonly plan: WorkflowPlanV4;
  readonly handoff: {
    readonly executionKind: "workflow_plan_v2";
    readonly workflowPlan: WorkflowPlanV2;
    readonly workflowToken: string;
    readonly parentPlanHash: `0x${string}`;
    readonly externalExecutionTruthProvenByStellar: false;
  };
}> {
  const { route, binding, commitment } = exactBoundary(plan);
  const amountCommitment = privateCommitment(plan, "amount");
  const recipientCommitment = privateCommitment(plan, "recipient");
  if (route.hydration!.amountCommitment !== amountCommitment) {
    throw controlled("WORKFLOW_V4_EXECUTOR_AMOUNT_BINDING_MISMATCH", "The quote changed its protected amount binding.");
  }
  const arcAddress = evmWallet(plan, 5_042_002);
  const arbitrumAddress = evmWallet(plan, 421_614);
  const aave = await dependencies.readBorrowCapacity(arbitrumAddress);
  const metrics = await dependencies.readRouteMetrics(aave.supplyApyBps, "direct_only");
  const quoteExpiresAt = metrics.direct.quoteExpiresAt;
  const standardFeeBps = metrics.direct.cctpLegs[0]?.standardFeeBps;
  if (
    quoteExpiresAt <= Date.now() || standardFeeBps === undefined ||
    !Number.isFinite(standardFeeBps) || standardFeeBps < 0 || standardFeeBps > 10_000
  ) {
    throw controlled("WORKFLOW_V4_EXECUTOR_QUOTE_STALE", "A fresh official Circle fee quote is required.", 503);
  }
  const compiled = compileWorkflowPlanV2({
    requestId: plan.requestId,
    goal: executionGoal(plan),
    amountCommitment,
    recipientCommitment,
    routePreference: "direct_cctp",
    privacyBudgetPreset: "deterministic_only_public_execution",
    policyAnchorMode: "local_manifest",
    arcAddress,
    arbitrumSepoliaAddress: arbitrumAddress,
    routeMetrics: {
      direct: {
        observedAt: metrics.direct.observedAt,
        quoteExpiresAt,
        cctpStandardFeeBps: standardFeeBps,
        cctpHops: 1,
        cctpLegs: [{ sourceDomain: 26, destinationDomain: 3, standardFeeBps }],
        aaveSupplyApyBps: aave.supplyApyBps,
        sources: metrics.direct.sources,
      },
    },
  });
  const parentPlanHash = workflowPlanV4Hash(plan);
  const expiresAt = Math.min(compiled.expiresAt, plan.expiresAt);
  const executor = rebindWorkflowPlanAuthorization({
    ...compiled,
    expiresAt,
    steps: compiled.steps.map((step) =>
      step.deadline === undefined ? step : { ...step, deadline: Math.min(step.deadline, expiresAt) }),
    parentWorkflowV4: {
      schemaVersion: "kletia_workflow_v4_execution_parent_v1",
      workflowId: plan.workflowId,
      workflowRoot: deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, route.id),
      planHashAtHandoff: parentPlanHash,
      expiresAt,
      controlPlaneContractId: plan.controlPlane.contractId!,
      controlPlaneTransactionHash: commitment.transactionHash!,
      controlPlaneNonce: commitment.nonce!,
      policyProofPublicInputsHash: binding.publicInputsHash!,
      externalExecutionTruthProvenByStellar: false,
    },
  });
  if (
    executor.selectedRoute !== "direct_cctp" ||
    executor.privacy.amountCommitment !== amountCommitment ||
    executor.privacy.recipientCommitment !== recipientCommitment ||
    executor.parentWorkflowV4?.workflowId !== plan.workflowId
  ) {
    throw controlled("WORKFLOW_V4_EXECUTOR_BINDING_MISMATCH", "The executor changed a sealed parent binding.", 503);
  }
  const boundAt = new Date().toISOString();
  const next: WorkflowPlanV4 = {
    ...plan,
    executionHandoff: {
      status: "bound",
      executor: "workflow_v2",
      executorWorkflowId: executor.workflowId,
      parentPlanHashAtHandoff: parentPlanHash,
      executorPlanCoreSha256: executor.authorizationBoundary.planCoreSha256,
      executorExpiresAt: executor.expiresAt,
      boundAt,
      progressStatus: "not_started",
      confirmedCheckpointCount: 0,
      totalCheckpointCount: executor.steps.length,
      currentAction: executor.steps[executor.currentStepIndex]?.action ?? null,
      terminalReceiptSha256: null,
      lastSyncedAt: null,
    },
    executionGate: {
      signable: false,
      status: "reviewed_executor_bound",
      reasons: ["The exact WorkflowPlanV2 executor is parent-bound; its manifest and every financial checkpoint still require the execution wallet's approval."],
    },
  };
  return {
    plan: next,
    handoff: {
      executionKind: "workflow_plan_v2",
      workflowPlan: executor,
      workflowToken: sealWorkflowPlanV2(executor),
      parentPlanHash,
      externalExecutionTruthProvenByStellar: false,
    },
  };
}
