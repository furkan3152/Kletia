/**
 * Per-step results: data purchases, Base bridges and swaps, gas
 * acquisition, and binding the current execution or payment.
 */
import {
  erc20Abi,
  getAddress,
  keccak256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import type { ParsedIntent } from "../../shared/ai/parser.js";
import {
  NETWORKS,
  NETWORK_CLIENTS,
  type NetworkId,
} from "../../shared/config/networks.js";
import { getAcrossBridgeRoutes } from "../../networks/base/bridge/across.js";
import {
  buildBaseMcpX402Plan,
  preflightExplicitBaseX402GetPrompt,
  type BaseX402ChallengeEvidence,
} from "../../networks/base/intent/x402.js";
import { ARBITRUM_TOKENS } from "../../networks/arbitrum/contracts.js";
import { TOKENS } from "../../networks/base/contracts.js";
import { resolveIntentEntities } from "../../shared/assets/resolver.js";
import {
  createVerifiedIntentResultEnvelope,
} from "../../shared/intent/responseEnvelope.js";
import { getAcrossGasAcquisitionRoute } from "../acrossSwap.js";
import {
  resolveConfiguredBaseSwapExecution,
} from "../../networks/base/config/intentRouterV2Environment.js";
import {
  executeBaseIntentV2Swap,
} from "../../networks/base/intent/routerV2Integration.js";
import type { MutableWorkflowPlan, WorkflowSemanticStep } from "./plan.js";
import { controlled } from "./token.js";

export function stampRoute(
  rawResult: Record<string, any>,
  network: NetworkId,
  action: string,
  requestId: string,
  userAddress: Address,
) {
  const chainId = NETWORKS[network].chainId;
  const expiresAt = Number(rawResult.quoteExpiresAt);
  const routes = (Array.isArray(rawResult.allRoutes) ? rawResult.allRoutes : []).map(
    (route: Record<string, any>) => ({
      ...route,
      action,
      network,
      chainId,
      requestId,
      userAddress,
      quoteExpiresAt: Number(route.quoteExpiresAt || expiresAt),
    }),
  );
  return {
    ...rawResult,
    action,
    actionType: action,
    network,
    chainId,
    requestId,
    userAddress,
    allRoutes: routes,
  };
}

export function bindCurrentExecution(
  plan: MutableWorkflowPlan,
  result: Record<string, any>,
) {
  const route = result.allRoutes?.[0];
  if (!route || typeof route.router !== "string" || typeof route.calldata !== "string") {
    throw controlled("WORKFLOW_EXECUTION_INVALID", "Workflow step did not produce a bounded route.", 502);
  }
  const current = plan.steps[plan.currentStepIndex];
  plan.steps[plan.currentStepIndex] = {
    ...current,
    status: "awaiting_signature",
    execution: {
      target: getAddress(route.router),
      calldataHash: keccak256(route.calldata as Hex),
      value: String(route.value || "0"),
      quoteExpiresAt: Number(route.quoteExpiresAt),
    },
  };
}

export function bindCurrentPayment(
  plan: MutableWorkflowPlan,
  evidence: BaseX402ChallengeEvidence,
) {
  const current = plan.steps[plan.currentStepIndex];
  plan.steps[plan.currentStepIndex] = {
    ...current,
    url: evidence.requestUrl,
    status: "awaiting_signature",
    execution: undefined,
    payment: {
      asset: getAddress(evidence.asset),
      payTo: getAddress(evidence.payTo),
      amountAtomic: evidence.amountAtomic,
      requestUrl: evidence.requestUrl,
      observedAt: evidence.observedAt,
    },
  };
}

export async function compileDataPurchaseResult(
  step: WorkflowSemanticStep,
  userAddress: Address,
  requestId: string,
  sourcePrompt?: string,
  suppliedChallenge?: BaseX402ChallengeEvidence,
) {
  const prompt =
    sourcePrompt?.trim() ||
    `Call ${step.url} with x402 on Base using GET and pay at most ${step.maxPayment} USDC`;
  const challenge =
    suppliedChallenge ||
    (await preflightExplicitBaseX402GetPrompt(prompt, userAddress));
  if (!challenge) {
    throw controlled(
      "WORKFLOW_X402_CHALLENGE_REQUIRED",
      "The workflow data purchase requires a fresh verified x402 challenge.",
      409,
    );
  }
  const intent: ParsedIntent = {
    isComplete: true,
    action: "x402_request",
    message: `Preparing workflow data purchase ${step.order}.`,
    amount: "0",
    url: step.url,
    method: "GET",
    maxPayment: step.maxPayment,
    durationInDays: 0,
    slippage: "1",
  };
  const raw = buildBaseMcpX402Plan(
    intent,
    requestId,
    prompt,
    challenge,
    userAddress,
  ) as Record<string, any>;
  return {
    result: {
      ...raw,
      action: "workflow",
      actionType: "workflow",
      executionKind: "workflow_plan_v1",
      network: "base",
      chainId: NETWORKS.base.chainId,
      requestId,
      userAddress,
    },
    challenge,
  };
}

export async function compileBaseBridgeResult(
  step: WorkflowSemanticStep,
  userAddress: Address,
  requestId: string,
  previous?: WorkflowSemanticStep,
) {
  const symbol = String(step.tokenIn || "").toUpperCase() as "USDC" | "WETH";
  const decimals = symbol === "USDC" ? 6 : 18;
  const tokenAddress = getAddress(TOKENS[symbol]);
  let amount: bigint;
  if (step.amountSource === "previous_output") {
    const previousAmount = previous?.actualOutputAtomic || previous?.expectedOutputAtomic;
    if (!previousAmount || !/^\d+$/u.test(previousAmount)) {
      throw controlled("WORKFLOW_PREVIOUS_OUTPUT_REQUIRED", "The preceding verified output is not available for this bridge quote.", 409);
    }
    if (previous?.outputTokenAddress && getAddress(previous.outputTokenAddress) !== tokenAddress) {
      throw controlled("WORKFLOW_PREVIOUS_ASSET_MISMATCH", "The preceding output token does not match the bridge input token.", 409);
    }
    amount = BigInt(previousAmount);
  } else if (String(step.amount).toUpperCase() === "MAX") {
    amount = await NETWORK_CLIENTS.base.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [userAddress],
    });
  } else {
    amount = parseUnits(step.amount, decimals);
  }
  if (amount <= 0n) {
    throw controlled("WORKFLOW_AMOUNT_REQUIRED", "Bridge amount must be positive.");
  }
  const bridgeRoutes = await getAcrossBridgeRoutes(
    tokenAddress,
    symbol,
    amount,
    "arbitrum",
    userAddress,
    decimals,
    false,
  );
  const bridge = bridgeRoutes[0] as Record<string, any>;
  if (!/^\d+$/u.test(String(bridge.outputAmountAtomic || ""))) {
    throw controlled(
      "WORKFLOW_BRIDGE_QUOTE_INVALID",
      "Across did not return a bounded destination amount.",
      502,
    );
  }
  const rawResult = stampRoute(
    {
      status: "success",
      executionKind: "workflow_plan_v1",
      winner: bridge.name,
      winnerMessage:
        "A staged Base-to-Arbitrum workflow is ready. Cross-chain settlement is checkpointed and is not globally atomic.",
      expectedOutput: bridge.expectedOutput,
      routePath: bridge.routePath,
      targetContract: bridge.router,
      calldata: bridge.calldata,
      value: bridge.value,
      amountInWei: amount.toString(),
      tokenInAddress: tokenAddress,
      isNativeIn: false,
      approvals: [{
        token: tokenAddress,
        spender: bridge.router,
        amount: amount.toString(),
        symbol,
        required: true,
      }],
      allRoutes: [{
        ...bridge,
        approvals: [{
          token: tokenAddress,
          spender: bridge.router,
          amount: amount.toString(),
          symbol,
          required: true,
        }],
        approvalPolicy: "explicit",
        primaryTokenAddress: tokenAddress,
        primaryAmountInWei: amount.toString(),
        simulationStatus: "deferred_until_approval",
      }],
      quoteExpiresAt: bridge.quoteExpiresAt,
    },
    "base",
    "workflow",
    requestId,
    userAddress,
  );
  return {
    rawResult,
    expectedOutputAtomic: String(bridge.outputAmountAtomic),
    outputTokenAddress: symbol === "USDC"
      ? ARBITRUM_TOKENS.USDC.address
      : ARBITRUM_TOKENS.WETH.address,
  };
}

export async function compileBaseSwapResult(
  step: WorkflowSemanticStep,
  userAddress: Address,
  requestId: string,
) {
  const configured = resolveConfiguredBaseSwapExecution(process.env);
  if (configured.mode !== "intent_v2") {
    throw controlled(
      "WORKFLOW_BASE_SWAP_V2_REQUIRED",
      "Multi-step Base swaps require the attested Kletia Intent Router V2 path; the simple legacy swap path remains available outside workflows.",
      503,
    );
  }
  const swapIntent: ParsedIntent = {
    isComplete: true,
    action: "swap",
    message: `Preparing Base workflow swap ${step.order}.`,
    amount: step.amount,
    tokenIn: step.tokenIn,
    tokenOut: step.tokenOut,
    protocol: step.protocol,
    objective: "best_output",
    riskTolerance: "balanced",
    allowMultiStep: true,
    durationInDays: 0,
    slippage: "1",
  };
  const resolution = await resolveIntentEntities(swapIntent, {
    network: "base",
    userAddress,
    originalPrompt: `swap ${step.amount} ${step.tokenIn} to ${step.tokenOut} on Base`,
    requestId,
  });
  if (resolution.status !== "resolved") {
    throw controlled("WORKFLOW_ENTITY_CLARIFICATION_REQUIRED", "The Base swap requires explicit reviewed assets.", 409);
  }
  const raw = await executeBaseIntentV2Swap(
    resolution.intent,
    userAddress,
    configured,
  ) as Record<string, any>;
  const stamped = stampRoute(raw, "base", "swap", requestId, userAddress);
  const execution = createVerifiedIntentResultEnvelope(
    stamped,
    "base",
    requestId,
    userAddress,
    resolution.evidence,
  ) as Record<string, any>;
  const route = execution.allRoutes?.[0] as Record<string, any> | undefined;
  const minimum = String(route?.economics?.netMinimumAmountOut || "");
  const outputAddress = route?.intent?.tokenOut || execution.tokenOutAddress;
  if (!/^\d+$/u.test(minimum) || !outputAddress) {
    throw controlled("WORKFLOW_SWAP_OUTPUT_INVALID", "The Base swap did not expose a bounded net output.", 502);
  }
  return {
    rawResult: {
      ...execution,
      action: "workflow",
      actionType: "swap",
      executionKind: "workflow_plan_v1",
    },
    expectedOutputAtomic: minimum,
    outputTokenAddress: getAddress(outputAddress),
  };
}

export async function compileGasAcquisitionResult(
  step: WorkflowSemanticStep,
  userAddress: Address,
  requestId: string,
) {
  if (!step.maxPayment) {
    throw controlled(
      "WORKFLOW_GAS_CAP_REQUIRED",
      "An explicit maximum Base USDC spend is required for gas acquisition.",
    );
  }
  const route = await getAcrossGasAcquisitionRoute({
    outputEth: step.amount,
    maxUsdc: step.maxPayment,
    userAddress,
  });
  const rawResult = stampRoute(
    {
      status: "success",
      executionKind: "workflow_plan_v1",
      winner: route.name,
      winnerMessage:
        "Exact-output Arbitrum gas acquisition is ready. The displayed Base USDC cap is enforced before wallet approval.",
      expectedOutput: route.expectedOutput,
      routePath: route.routePath,
      targetContract: route.router,
      calldata: route.calldata,
      value: route.value,
      amountInWei: route.maxInputAmountAtomic,
      tokenInAddress: route.inputTokenAddress,
      isNativeIn: false,
      approvals: [{
        token: route.approval.token,
        spender: route.approval.spender,
        amount: route.approval.amount,
        symbol: "USDC",
        required: true,
      }],
      allRoutes: [{
        ...route,
        approvals: [{
          token: route.approval.token,
          spender: route.approval.spender,
          amount: route.approval.amount,
          symbol: "USDC",
          required: true,
        }],
        approvalPolicy: "explicit_exact_cap",
        primaryTokenAddress: route.inputTokenAddress,
        primaryAmountInWei: route.maxInputAmountAtomic,
        simulationStatus: "deferred_until_approval",
      }],
      quoteExpiresAt: route.quoteExpiresAt,
    },
    "base",
    "workflow",
    requestId,
    userAddress,
  );
  return { rawResult, expectedOutputAtomic: route.outputAmountAtomic };
}
