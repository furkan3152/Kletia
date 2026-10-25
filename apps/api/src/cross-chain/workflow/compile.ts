/**
 * Compiles a workflow and prepares the next executable step on Base, Arc
 * or Arbitrum.
 */
import { randomUUID } from "node:crypto";
import { erc20Abi, getAddress, type Address } from "viem";
import type { ParsedIntent } from "../../shared/ai/parser.js";
import {
  ARC_CONTRACTS,
  NETWORK_CLIENTS,
  type NetworkId,
} from "../../shared/config/networks.js";
import type {
  BaseX402ChallengeEvidence,
} from "../../networks/base/intent/x402.js";
import { executeArbitrumEngine } from "../../networks/arbitrum/engine.js";
import { executeArcEngine } from "../../networks/arc/engine.js";
import { ARBITRUM_TOKENS } from "../../networks/arbitrum/contracts.js";
import { resolveIntentEntities } from "../../shared/assets/resolver.js";
import {
  createVerifiedIntentResultEnvelope,
} from "../../shared/intent/responseEnvelope.js";
import type {
  MutableWorkflowPlan,
  WorkflowPlanV1,
  WorkflowSemanticStep,
} from "./plan.js";
import { controlled, sealWorkflowPlan, WORKFLOW_TTL_MS } from "./token.js";
import { normalizeWorkflowSteps } from "./normalize.js";
import {
  bindCurrentExecution,
  bindCurrentPayment,
  compileBaseBridgeResult,
  compileBaseSwapResult,
  compileDataPurchaseResult,
  compileGasAcquisitionResult,
  stampRoute,
} from "./compileSteps.js";
import { readAcrossStatus } from "./verify.js";

export async function compileWorkflow(
  intent: ParsedIntent,
  userAddressInput: string,
  requestId: string,
  originalPrompt = "",
  baseX402Challenge?: BaseX402ChallengeEvidence,
  activeNetwork: NetworkId = "base",
) {
  const userAddress = getAddress(userAddressInput);
  const steps = normalizeWorkflowSteps(intent, activeNetwork);
  const first = steps[0];
  if (activeNetwork === "arc" || activeNetwork === "arbitrum") {
    const plan: MutableWorkflowPlan = {
      version: 1,
      workflowId: randomUUID(),
      requestId,
      userAddress,
      createdAt: Date.now(),
      expiresAt: Date.now() + WORKFLOW_TTL_MS,
      objective: "risk_adjusted_net_return",
      atomicity: {
        sameChain: "wallet_batch_when_verified",
        crossChain: "staged_checkpointed_no_global_rollback",
      },
      hardPolicies: {
        minimumHealthFactor: "1.5",
        requiresPerStepWalletApproval: true,
        mockDataAllowed: false,
      },
      currentStepIndex: 0,
      steps,
    };
    const execution = await prepareWorkflowExecution(plan, first, userAddress);
    if (!execution || typeof execution !== "object" || "readOnlyResult" in execution) {
      throw controlled(
        "WORKFLOW_ENTRY_UNSUPPORTED",
        "A staged workflow must begin with a reviewed value-moving action.",
        409,
      );
    }
    return {
      ...(execution as Record<string, any>),
      action: "workflow",
      actionType: first.action,
      executionKind: "workflow_plan_v1",
      winnerMessage:
        `Step 1 of ${steps.length} is ready. Each later step is prepared only after the preceding onchain receipt is verified.`,
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
    };
  }
  if (
    first.action !== "swap" &&
    first.action !== "bridge" &&
    first.action !== "data_purchase" &&
    first.action !== "gas_acquire"
  ) {
    throw controlled(
      "WORKFLOW_ENTRY_UNSUPPORTED",
      "The workflow must start with an explicit Base swap, data purchase, Base-to-Arbitrum bridge, or capped gas acquisition.",
    );
  }
  const initial = first.action === "data_purchase"
    ? await compileDataPurchaseResult(
        first,
        userAddress,
        requestId,
        originalPrompt,
        baseX402Challenge,
      )
    : first.action === "gas_acquire"
      ? await compileGasAcquisitionResult(first, userAddress, requestId)
      : first.action === "swap"
        ? await compileBaseSwapResult(first, userAddress, requestId)
        : await compileBaseBridgeResult(first, userAddress, requestId);
  if (first.action === "swap" || first.action === "bridge" || first.action === "gas_acquire") {
    steps[0] = {
      ...steps[0],
      expectedOutputAtomic: (initial as { expectedOutputAtomic: string }).expectedOutputAtomic,
      ...("outputTokenAddress" in initial
        ? { outputTokenAddress: getAddress(String(initial.outputTokenAddress)) }
        : {}),
    };
  }
  const rawResult = first.action === "data_purchase"
    ? (initial as Awaited<ReturnType<typeof compileDataPurchaseResult>>).result
    : (initial as { rawResult: Record<string, any> }).rawResult;
  const plan: MutableWorkflowPlan = {
    version: 1,
    workflowId: randomUUID(),
    requestId,
    userAddress,
    createdAt: Date.now(),
    expiresAt: Date.now() + WORKFLOW_TTL_MS,
    objective: "risk_adjusted_net_return",
    atomicity: {
      sameChain: "wallet_batch_when_verified",
      crossChain: "staged_checkpointed_no_global_rollback",
    },
    hardPolicies: {
      minimumHealthFactor: "1.5",
      requiresPerStepWalletApproval: true,
      mockDataAllowed: false,
    },
    currentStepIndex: 0,
    steps,
  };
  if (first.action === "data_purchase") {
    bindCurrentPayment(
      plan,
      (initial as Awaited<ReturnType<typeof compileDataPurchaseResult>>).challenge,
    );
  } else {
    bindCurrentExecution(plan, rawResult);
  }
  return {
    ...rawResult,
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
  };
}

async function compileArcStep(
  step: WorkflowSemanticStep,
  plan: WorkflowPlanV1,
) {
  let amount = step.amount;
  if (step.amountSource === "previous_output") {
    const previous = plan.steps[step.order - 2];
    const previousOutput = previous?.actualOutputAtomic || previous?.expectedOutputAtomic;
    if (!previousOutput || !/^\d+$/u.test(previousOutput)) {
      throw controlled(
        "WORKFLOW_PREVIOUS_OUTPUT_INVALID",
        "The preceding Arc step has no verified token output to consume.",
        409,
      );
    }
    if (
      String(step.tokenIn || "").toUpperCase() !== "KLET" ||
      !previous.outputTokenAddress ||
      getAddress(previous.outputTokenAddress) !== getAddress(ARC_CONTRACTS.Token)
    ) {
      throw controlled(
        "WORKFLOW_PREVIOUS_ASSET_MISMATCH",
        "The preceding Arc output is not the exact KLET input required by this step.",
        409,
      );
    }
    const balance = await NETWORK_CLIENTS.arc.readContract({
      address: ARC_CONTRACTS.Token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [plan.userAddress],
    });
    if (balance < BigInt(previousOutput)) {
      throw controlled(
        "WORKFLOW_DESTINATION_BALANCE_INSUFFICIENT",
        "The Arc wallet balance does not cover the preceding verified KLET output.",
        409,
      );
    }
    amount = formatAtomic(previousOutput, 18);
  }
  const intent: ParsedIntent = {
    isComplete: true,
    action: step.action,
    message: `Preparing Arc workflow step ${step.order}.`,
    amount,
    tokenIn: step.tokenIn,
    tokenOut: step.tokenOut,
    protocol: step.protocol,
    objective: step.objective as ParsedIntent["objective"],
    riskTolerance: "balanced",
    durationInDays: 0,
    slippage: "1",
  };
  const resolution = await resolveIntentEntities(intent, {
    network: "arc",
    userAddress: plan.userAddress,
    originalPrompt: `${step.action} ${amount} ${step.tokenIn || ""} ${step.tokenOut || ""}`,
    requestId: plan.requestId,
  });
  if (resolution.status !== "resolved") {
    throw controlled(
      "WORKFLOW_ENTITY_CLARIFICATION_REQUIRED",
      `Arc workflow step ${step.order} requires an explicit reviewed asset selection.`,
      409,
    );
  }
  const raw = await executeArcEngine(
    resolution.intent,
    plan.userAddress,
    "",
    plan.requestId,
  ) as Record<string, any>;
  const quoteExpiresAt = Date.now() + 60_000;
  const stamped = stampRoute(
    {
      ...raw,
      quoteExpiresAt,
      allRoutes: (raw.allRoutes || []).map((route: Record<string, any>) => ({
        ...route,
        quoteExpiresAt,
      })),
    },
    "arc",
    step.action,
    plan.requestId,
    plan.userAddress,
  );
  const execution = createVerifiedIntentResultEnvelope(
    stamped,
    "arc",
    plan.requestId,
    plan.userAddress,
    resolution.evidence,
  ) as Record<string, any>;
  return {
    execution,
    expectedOutputAtomic:
      typeof raw.expectedOutputAtomic === "string"
        ? raw.expectedOutputAtomic
        : undefined,
    outputTokenAddress:
      typeof raw.outputTokenAddress === "string"
        ? getAddress(raw.outputTokenAddress)
        : undefined,
  };
}

async function compileArbitrumStep(
  step: WorkflowSemanticStep,
  plan: WorkflowPlanV1,
) {
  let amount = step.amount;
  if (step.amountSource === "previous_output") {
    const previous = plan.steps[step.order - 2];
    if (previous.action === "bridge") {
      const bridgeTx = previous.txHash;
      if (!bridgeTx) throw controlled("WORKFLOW_BRIDGE_EVIDENCE_MISSING", "Bridge output proof is missing.");
      const status = await readAcrossStatus(bridgeTx);
      if (status.status !== "filled") {
        throw controlled("WORKFLOW_BRIDGE_NOT_FILLED", "Across has not confirmed the destination fill yet.", 409);
      }
    }
    const expectedOutputAtomic =
      previous.actualOutputAtomic || previous.expectedOutputAtomic;
    if (!expectedOutputAtomic || !/^\d+$/u.test(expectedOutputAtomic)) {
        throw controlled(
          "WORKFLOW_PREVIOUS_OUTPUT_INVALID",
          "The sealed preceding output amount is missing.",
          409,
        );
    }
    const inputAsset = String(step.tokenIn || "").toUpperCase() as keyof typeof ARBITRUM_TOKENS;
    const definition = ARBITRUM_TOKENS[inputAsset];
    if (!definition || definition.address === null) {
      throw controlled("WORKFLOW_DESTINATION_ASSET_INVALID", "The destination workflow asset must be a reviewed ERC-20 token.");
    }
    if (
      previous.outputTokenAddress &&
      getAddress(previous.outputTokenAddress) !== getAddress(definition.address)
    ) {
      throw controlled("WORKFLOW_PREVIOUS_ASSET_MISMATCH", "The preceding output token does not match this step input.", 409);
    }
    const balance = await NETWORK_CLIENTS.arbitrum.readContract({
        address: definition.address,
        abi: [{
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        }] as const,
        functionName: "balanceOf",
        args: [plan.userAddress],
      });
      if (balance < BigInt(expectedOutputAtomic)) {
        throw controlled(
          "WORKFLOW_DESTINATION_BALANCE_INSUFFICIENT",
          "The destination balance does not yet cover the sealed Across output.",
          409,
        );
      }
    amount = formatAtomic(expectedOutputAtomic, definition.decimals);
  }
  const intent: ParsedIntent = {
      isComplete: true,
      action: step.action,
      message: `Preparing workflow step ${step.order}.`,
      amount,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      protocol: step.protocol,
      objective: step.objective as ParsedIntent["objective"],
      riskTolerance: "balanced",
      durationInDays: 0,
      slippage: "1",
    };
  const raw = await executeArbitrumEngine(
    intent,
    plan.userAddress,
    "",
    plan.requestId,
  ) as Record<string, any>;
  return { raw, intent };
}

export async function prepareWorkflowExecution(
  plan: MutableWorkflowPlan,
  step: WorkflowSemanticStep,
  userAddress: Address,
) {
  if (step.action === "data_purchase") {
    const prepared = await compileDataPurchaseResult(
      step,
      userAddress,
      plan.requestId,
    );
    bindCurrentPayment(plan, prepared.challenge);
    return prepared.result;
  }
  if (step.action === "swap" && step.network === "base") {
    const swap = await compileBaseSwapResult(step, userAddress, plan.requestId);
    plan.steps[plan.currentStepIndex] = {
      ...step,
      expectedOutputAtomic: swap.expectedOutputAtomic,
      outputTokenAddress: swap.outputTokenAddress,
    };
    bindCurrentExecution(plan, swap.rawResult);
    return swap.rawResult;
  }
  if (step.action === "bridge") {
    const bridge = await compileBaseBridgeResult(
      step,
      userAddress,
      plan.requestId,
      plan.currentStepIndex > 0 ? plan.steps[plan.currentStepIndex - 1] : undefined,
    );
    plan.steps[plan.currentStepIndex] = {
      ...step,
      expectedOutputAtomic: bridge.expectedOutputAtomic,
      outputTokenAddress: bridge.outputTokenAddress,
    };
    const intent: ParsedIntent = {
      isComplete: true,
      action: "workflow",
      message: `Re-quoting workflow step ${step.order}.`,
      amount: step.amount,
      tokenIn: step.tokenIn || "USDC",
      durationInDays: 0,
      slippage: "1",
    };
    const resolution = await resolveIntentEntities(intent, {
      network: "base",
      userAddress,
      originalPrompt: `workflow bridge ${step.amount} ${step.tokenIn || "USDC"}`,
      requestId: plan.requestId,
    });
    if (resolution.status !== "resolved") {
      throw controlled(
        "WORKFLOW_ENTITY_CLARIFICATION_REQUIRED",
        "The bridge step requires a new explicit asset selection.",
        409,
      );
    }
    const execution = createVerifiedIntentResultEnvelope(
      bridge.rawResult,
      "base",
      plan.requestId,
      userAddress,
      resolution.evidence,
    );
    bindCurrentExecution(plan, execution);
    return execution;
  }
  if (step.action === "gas_acquire") {
    const gas = await compileGasAcquisitionResult(step, userAddress, plan.requestId);
    plan.steps[plan.currentStepIndex] = {
      ...step,
      expectedOutputAtomic: gas.expectedOutputAtomic,
    };
    const intent: ParsedIntent = {
      isComplete: true,
      action: "workflow",
      message: `Re-quoting capped gas acquisition step ${step.order}.`,
      amount: step.amount,
      tokenIn: "USDC",
      tokenOut: "ETH",
      durationInDays: 0,
      slippage: "1",
    };
    const resolution = await resolveIntentEntities(intent, {
      network: "base",
      userAddress,
      originalPrompt: `acquire exactly ${step.amount} ETH gas on Arbitrum spending at most ${step.maxPayment} USDC`,
      requestId: plan.requestId,
    });
    if (resolution.status !== "resolved") {
      throw controlled(
        "WORKFLOW_ENTITY_CLARIFICATION_REQUIRED",
        "The gas acquisition step requires explicit USDC and ETH asset confirmation.",
        409,
      );
    }
    const execution = createVerifiedIntentResultEnvelope(
      gas.rawResult,
      "base",
      plan.requestId,
      userAddress,
      resolution.evidence,
    );
    bindCurrentExecution(plan, execution);
    return execution;
  }

  if (step.network === "arc") {
    const prepared = await compileArcStep(step, plan);
    plan.steps[plan.currentStepIndex] = {
      ...step,
      ...(prepared.expectedOutputAtomic
        ? { expectedOutputAtomic: prepared.expectedOutputAtomic }
        : {}),
      ...(prepared.outputTokenAddress
        ? { outputTokenAddress: prepared.outputTokenAddress }
        : {}),
    };
    bindCurrentExecution(plan, prepared.execution);
    return prepared.execution;
  }

  const prepared = await compileArbitrumStep(step, plan);
  const resolution = await resolveIntentEntities(prepared.intent, {
    network: "arbitrum",
    userAddress,
    originalPrompt: [step.action, step.amount, step.tokenIn, step.tokenOut]
      .filter(Boolean)
      .join(" "),
    requestId: plan.requestId,
  });
  if (resolution.status !== "resolved") {
    throw controlled(
      "WORKFLOW_ENTITY_CLARIFICATION_REQUIRED",
      "The next workflow step requires a new explicit asset selection.",
      409,
    );
  }
  if (step.action === "borrow_capacity") {
    const capacity = prepared.raw.borrowCapacity as Record<string, unknown> | undefined;
    if (
      prepared.raw.readOnly !== true ||
      !capacity ||
      capacity.policyVersion !== "kletia_aave_borrow_capacity_v1" ||
      capacity.protocolId !== "aave-v3" ||
      typeof capacity.asset !== "string" ||
      typeof capacity.safeAmountAtomic !== "string" ||
      !/^\d+$/u.test(capacity.safeAmountAtomic) ||
      typeof capacity.safeAmount !== "string" ||
      typeof capacity.targetHealthFactor !== "string" ||
      typeof capacity.observedAtBlock !== "string" ||
      capacity.mockData !== false
    ) {
      throw controlled("WORKFLOW_READ_RESULT_INVALID", "The live borrow-capacity result failed its strict boundary.", 502);
    }
    plan.steps[plan.currentStepIndex] = {
      ...step,
      status: "ready",
      execution: undefined,
      readResult: {
        kind: "borrow_capacity",
        protocolId: "aave-v3",
        asset: capacity.asset,
        safeAmountAtomic: capacity.safeAmountAtomic,
        safeAmount: capacity.safeAmount,
        targetHealthFactor: capacity.targetHealthFactor,
        observedAtBlock: capacity.observedAtBlock,
        mockData: false,
      },
    };
    return {
      readOnlyResult: true,
      message: prepared.raw.winnerMessage,
    };
  }
  if (step.action === "swap") {
    const minimum = String(prepared.raw.allRoutes?.[0]?.quoteEvidence?.minimumAmountOut || "");
    const outputSymbol = String(step.tokenOut || "").toUpperCase() as keyof typeof ARBITRUM_TOKENS;
    const output = ARBITRUM_TOKENS[outputSymbol];
    if (!/^\d+$/u.test(minimum) || !output || output.address === null) {
      throw controlled("WORKFLOW_SWAP_OUTPUT_INVALID", "The Arbitrum swap did not expose a bounded reviewed output.", 502);
    }
    plan.steps[plan.currentStepIndex] = {
      ...step,
      expectedOutputAtomic: minimum,
      outputTokenAddress: output.address,
    };
  }
  const stamped = stampRoute(
    prepared.raw,
    "arbitrum",
    step.action,
    plan.requestId,
    userAddress,
  );
  const execution = createVerifiedIntentResultEnvelope(
    stamped,
    "arbitrum",
    plan.requestId,
    userAddress,
    resolution.evidence,
  );
  bindCurrentExecution(plan, execution);
  return execution;
}

function formatAtomic(value: string, decimals: number): string {
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const integer = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}
