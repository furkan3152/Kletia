import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  erc20Abi,
  getAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { ParsedIntent } from "../shared/ai/parser.js";
import {
  isNetworkTargetAllowed,
  NETWORKS,
  NETWORK_CLIENTS,
  type NetworkId,
} from "../shared/config/networks.js";
import { getAcrossBridgeRoutes } from "../networks/base/bridge/across.js";
import {
  buildBaseMcpX402Plan,
  preflightExplicitBaseX402GetPrompt,
  type BaseX402ChallengeEvidence,
} from "../networks/base/intent/x402.js";
import { executeArbitrumEngine } from "../networks/arbitrum/engine.js";
import { ARBITRUM_TOKENS } from "../networks/arbitrum/contracts.js";
import { TOKENS } from "../networks/base/contracts.js";
import { resolveIntentEntities } from "../shared/assets/resolver.js";
import { createVerifiedIntentResultEnvelope } from "../shared/intent/responseEnvelope.js";
import { getAcrossGasAcquisitionRoute } from "./acrossSwap.js";
import { resolveConfiguredBaseSwapExecution } from "../networks/base/config/intentRouterV2Environment.js";
import { executeBaseIntentV2Swap } from "../networks/base/intent/routerV2Integration.js";

export type WorkflowStepStatus =
  | "planned"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "filled"
  | "ready"
  | "failed"
  | "refunded"
  | "indeterminate";

export interface WorkflowSemanticStep {
  readonly id: string;
  readonly order: number;
  readonly action: string;
  readonly network: "base" | "arbitrum";
  readonly chainId: 8453 | 42161;
  readonly tokenIn?: string;
  readonly tokenOut?: string;
  readonly amount: string;
  readonly amountSource?: "explicit" | "wallet_balance" | "previous_output";
  readonly protocol?: string;
  readonly destinationChain?: string;
  readonly objective?: string;
  readonly url?: string;
  readonly method?: "GET";
  readonly maxPayment?: string;
  readonly dependsOn: readonly string[];
  readonly status: WorkflowStepStatus;
  readonly expectedOutputAtomic?: string;
  readonly actualOutputAtomic?: string;
  readonly outputTokenAddress?: Address;
  readonly execution?: {
    readonly target: Address;
    readonly calldataHash: Hex;
    readonly value: string;
    readonly quoteExpiresAt: number;
  };
  readonly payment?: {
    readonly asset: Address;
    readonly payTo: Address;
    readonly amountAtomic: string;
    readonly requestUrl: string;
    readonly observedAt: string;
  };
  readonly txHash?: Hex;
  readonly fillTxHash?: Hex;
  readonly authorizationNonce?: Hex;
  readonly readResult?: {
    readonly kind: "borrow_capacity";
    readonly protocolId: "aave-v3";
    readonly asset: string;
    readonly safeAmountAtomic: string;
    readonly safeAmount: string;
    readonly targetHealthFactor: string;
    readonly observedAtBlock: string;
    readonly mockData: false;
  };
}

export interface WorkflowPlanV1 {
  readonly version: 1;
  readonly workflowId: string;
  readonly requestId: string;
  readonly userAddress: Address;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly objective: "risk_adjusted_net_return";
  readonly atomicity: {
    readonly sameChain: "wallet_batch_when_verified";
    readonly crossChain: "staged_checkpointed_no_global_rollback";
  };
  readonly hardPolicies: {
    readonly minimumHealthFactor: "1.5";
    readonly requiresPerStepWalletApproval: true;
    readonly mockDataAllowed: false;
  };
  readonly currentStepIndex: number;
  readonly steps: readonly WorkflowSemanticStep[];
}

type MutableWorkflowPlan = Omit<WorkflowPlanV1, "steps" | "currentStepIndex"> & {
  currentStepIndex: number;
  steps: WorkflowSemanticStep[];
};

// Cross-chain fills can legitimately take longer than an individual route quote.
// The workflow remains resumable for one day, while every executable step keeps
// its own much shorter quote deadline and must be refreshed before signing.
const WORKFLOW_TTL_MS = 24 * 60 * 60 * 1_000;
const ACROSS_STATUS_URL = "https://app.across.to/api/deposit/status";
const MAX_STATUS_BYTES = 32 * 1_024;
const developmentSecret = randomBytes(32).toString("hex");

function workflowSecret(): string {
  const configured = process.env.WORKFLOW_SIGNING_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV !== "production") return developmentSecret;
  throw Object.assign(
    new Error("WORKFLOW_SIGNING_SECRET is required for production workflows."),
    { code: "WORKFLOW_CONFIGURATION_REQUIRED", statusCode: 503 },
  );
}

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function encodePlan(plan: WorkflowPlanV1): string {
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
}

export function sealWorkflowPlan(plan: WorkflowPlanV1): string {
  const payload = encodePlan(plan);
  const signature = createHmac("sha256", workflowSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function openWorkflowToken(token: unknown): WorkflowPlanV1 {
  if (typeof token !== "string" || token.length < 80 || token.length > 32_000) {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token is invalid.");
  }
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token is invalid.");
  }
  const expected = createHmac("sha256", workflowSecret())
    .update(payload)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token is invalid.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token signature is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token payload is invalid.");
  }
  assertWorkflowPlan(parsed);
  if (parsed.expiresAt <= Date.now()) {
    throw controlled("WORKFLOW_EXPIRED", "Workflow expired and must be re-planned.", 409);
  }
  return parsed;
}

export function assertWorkflowPlan(value: unknown): asserts value is WorkflowPlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("WORKFLOW_PLAN_INVALID", "Workflow plan is invalid.");
  }
  const plan = value as WorkflowPlanV1;
  if (
    plan.version !== 1 ||
    typeof plan.workflowId !== "string" ||
    typeof plan.requestId !== "string" ||
    typeof plan.createdAt !== "number" ||
    typeof plan.expiresAt !== "number" ||
    plan.expiresAt <= plan.createdAt ||
    plan.expiresAt - plan.createdAt > WORKFLOW_TTL_MS ||
    plan.objective !== "risk_adjusted_net_return" ||
    plan.atomicity?.sameChain !== "wallet_batch_when_verified" ||
    plan.atomicity?.crossChain !== "staged_checkpointed_no_global_rollback" ||
    plan.hardPolicies?.minimumHealthFactor !== "1.5" ||
    plan.hardPolicies?.requiresPerStepWalletApproval !== true ||
    plan.hardPolicies?.mockDataAllowed !== false ||
    !Array.isArray(plan.steps) ||
    plan.steps.length < 2 ||
    plan.steps.length > 8 ||
    !Number.isInteger(plan.currentStepIndex) ||
    plan.currentStepIndex < 0 ||
    plan.currentStepIndex >= plan.steps.length
  ) {
    throw controlled("WORKFLOW_PLAN_INVALID", "Workflow plan boundaries are invalid.");
  }
  try {
    getAddress(plan.userAddress);
  } catch {
    throw controlled("WORKFLOW_PLAN_INVALID", "Workflow wallet is invalid.");
  }
  plan.steps.forEach((step, index) => {
    const expectedChainId = step.network === "base"
      ? NETWORKS.base.chainId
      : step.network === "arbitrum"
        ? NETWORKS.arbitrum.chainId
        : undefined;
    const actionNetworkValid =
      (step.network === "base" &&
        (step.action === "swap" ||
          step.action === "bridge" ||
          step.action === "data_purchase" ||
          step.action === "gas_acquire")) ||
      (step.network === "arbitrum" &&
        step.action !== "bridge" &&
        step.action !== "data_purchase" &&
        step.action !== "gas_acquire");
    if (
      step.id !== `step-${index + 1}` ||
      step.order !== index + 1 ||
      (step.network !== "base" && step.network !== "arbitrum") ||
      !actionNetworkValid ||
      step.chainId !== expectedChainId ||
      !Array.isArray(step.dependsOn) ||
      (index === 0
        ? step.dependsOn.length !== 0
        : step.dependsOn.length !== 1 || step.dependsOn[0] !== `step-${index}`)
    ) {
      throw controlled("WORKFLOW_PLAN_INVALID", "Workflow step graph is invalid.");
    }
    if (
      typeof step.amount !== "string" ||
      step.amount.length === 0 ||
      (step.amountSource !== undefined &&
        !["explicit", "wallet_balance", "previous_output"].includes(step.amountSource)) ||
      (step.action === "data_purchase" && index !== 0) ||
      (step.action === "borrow_capacity" && index !== plan.steps.length - 1) ||
      (step.action === "bridge" &&
        (step.destinationChain !== "arbitrum" ||
          !["USDC", "WETH"].includes(step.tokenIn?.toUpperCase() || ""))) ||
      (step.action === "gas_acquire" &&
        (step.destinationChain !== "arbitrum" ||
          step.tokenIn?.toUpperCase() !== "USDC" ||
          step.tokenOut?.toUpperCase() !== "ETH" ||
          !step.maxPayment ||
          !/^\d+(?:\.\d{1,6})?$/u.test(step.maxPayment)))
    ) {
      throw controlled(
        "WORKFLOW_PLAN_INVALID",
        "Workflow step semantics are invalid.",
      );
    }
    if (step.execution) {
      const execution = step.execution;
      if (
        !isNetworkTargetAllowed(step.network, execution.target, step.action) ||
        !/^0x[0-9a-f]{64}$/iu.test(execution.calldataHash) ||
        !/^\d+$/u.test(execution.value) ||
        !Number.isSafeInteger(execution.quoteExpiresAt) ||
        execution.quoteExpiresAt <= plan.createdAt ||
        execution.quoteExpiresAt > plan.expiresAt
      ) {
        throw controlled(
          "WORKFLOW_PLAN_INVALID",
          "Workflow execution binding is invalid.",
        );
      }
    }
    if (step.payment) {
      const payment = step.payment;
      let addressBindingValid = false;
      try {
        addressBindingValid =
          getAddress(payment.asset) === getAddress(TOKENS.USDC) &&
          getAddress(payment.payTo) !== getAddress("0x0000000000000000000000000000000000000000");
      } catch {
        addressBindingValid = false;
      }
      if (
        step.action !== "data_purchase" ||
        step.network !== "base" ||
        !addressBindingValid ||
        !/^\d+$/u.test(payment.amountAtomic) ||
        BigInt(payment.amountAtomic) <= 0n ||
        typeof payment.requestUrl !== "string" ||
        !payment.requestUrl.startsWith("https://") ||
        payment.requestUrl !== step.url ||
        step.method !== "GET" ||
        !Number.isFinite(Date.parse(payment.observedAt))
      ) {
        throw controlled(
          "WORKFLOW_PLAN_INVALID",
          "Workflow payment binding is invalid.",
        );
      }
    }
    if (step.action === "data_purchase" && !step.payment) {
      throw controlled(
        "WORKFLOW_PLAN_INVALID",
        "Workflow data purchase is missing its sealed payment binding.",
      );
    }
    if (step.outputTokenAddress) {
      try {
        const actual = getAddress(step.outputTokenAddress);
        const symbol = String(
          step.action === "bridge" ? step.tokenIn : step.tokenOut,
        ).toUpperCase();
        const expected = step.action === "bridge"
          ? ARBITRUM_TOKENS[symbol as keyof typeof ARBITRUM_TOKENS]?.address
          : step.network === "base"
            ? TOKENS[symbol]
            : ARBITRUM_TOKENS[symbol as keyof typeof ARBITRUM_TOKENS]?.address;
        if (!expected || getAddress(expected) !== actual) {
          throw new Error("output mismatch");
        }
      } catch {
        throw controlled("WORKFLOW_PLAN_INVALID", "Workflow output token binding is invalid.");
      }
    }
    if (
      (step.actualOutputAtomic !== undefined && !/^\d+$/u.test(step.actualOutputAtomic)) ||
      (step.readResult !== undefined &&
        (step.action !== "borrow_capacity" ||
          step.readResult.kind !== "borrow_capacity" ||
          step.readResult.protocolId !== "aave-v3" ||
          !/^\d+$/u.test(step.readResult.safeAmountAtomic) ||
          step.readResult.mockData !== false))
    ) {
      throw controlled("WORKFLOW_PLAN_INVALID", "Workflow result evidence is invalid.");
    }
  });
}

export function normalizeWorkflowSteps(intent: ParsedIntent): WorkflowSemanticStep[] {
  if (!intent.workflowSteps || intent.workflowSteps.length < 2) {
    throw controlled(
      "WORKFLOW_STEPS_REQUIRED",
      "A multi-step workflow requires at least two explicitly ordered actions.",
    );
  }
  const requested = intent.workflowSteps.map((step) => ({ ...step }));
  const bridgeIndex = requested.findIndex((step) => step.action === "bridge");
  const normalized = requested.map((step, index) => {
    const normalizeDeFiAsset = (value: string | undefined) =>
      String(value || "").trim().toUpperCase() === "ETH" ? "WETH" : value;
    const inferredBaseSwap =
      step.action === "swap" && bridgeIndex >= 0 && index < bridgeIndex;
    return {
      ...step,
      network: step.network ||
        (step.action === "bridge" ||
        step.action === "gas_acquire" ||
        step.action === "x402_request" ||
        step.action === "data_purchase" ||
        inferredBaseSwap
          ? "base"
          : "arbitrum"),
      tokenIn:
        step.action === "gas_acquire" ? step.tokenIn : normalizeDeFiAsset(step.tokenIn),
      tokenOut:
        step.action === "gas_acquire" ? step.tokenOut : normalizeDeFiAsset(step.tokenOut),
    };
  });

  // If the selected lending representation differs from the Across output,
  // insert a deterministic Arbitrum swap. This is based on adjacent asset
  // identities, not on a hard-coded prompt sentence.
  const normalizedBridgeIndex = normalized.findIndex((step) => step.action === "bridge");
  if (normalizedBridgeIndex >= 0) {
    const bridge = normalized[normalizedBridgeIndex];
    const nextFinancialIndex = normalized.findIndex(
      (step, index) =>
        index > normalizedBridgeIndex &&
        step.network === "arbitrum" &&
        ["lend", "withdraw", "borrow", "borrow_capacity", "repay"].includes(step.action),
    );
    const target = nextFinancialIndex >= 0 ? normalized[nextFinancialIndex].tokenIn : undefined;
    const bridgeAsset = String(bridge.tokenIn || "").toUpperCase();
    if (
      target &&
      bridgeAsset &&
      String(target).toUpperCase() !== bridgeAsset &&
      !normalized.slice(normalizedBridgeIndex + 1, nextFinancialIndex).some(
        (step) => step.action === "swap" &&
          String(step.tokenOut || "").toUpperCase() === String(target).toUpperCase(),
      )
    ) {
      normalized.splice(normalizedBridgeIndex + 1, 0, {
        action: "swap",
        network: "arbitrum",
        tokenIn: bridgeAsset,
        tokenOut: String(target).toUpperCase(),
        amount: "MAX",
        amountSource: "previous_output",
        objective: "best_output",
        protocol: "uniswap-v3",
      });
    }
  }
  if (normalized.length > 8) {
    throw controlled("WORKFLOW_STEP_LIMIT", "The expanded workflow exceeds the eight-step safety limit.");
  }

  return normalized.map((step, index) => {
    const network: "base" | "arc" | "arbitrum" =
      step.network as "base" | "arc" | "arbitrum";
    if (network === "arc") {
      throw controlled(
        "WORKFLOW_NETWORK_UNSUPPORTED",
        "Arc Testnet cannot be mixed with Base/Arbitrum Mainnet capital workflows.",
      );
    }
    const action = step.action === "x402_request" ? "data_purchase" : step.action;
    if (action === "data_purchase") {
      if (
        index !== 0 ||
        network !== "base" ||
        !step.url ||
        step.method !== "GET" ||
        !step.maxPayment
      ) {
        throw controlled(
          "WORKFLOW_DATA_PURCHASE_INVALID",
          "A workflow data purchase must be the first Base step with an explicit HTTPS URL, GET method, and USDC cap.",
        );
      }
    }
    if (action === "gas_acquire") {
      if (
        network !== "base" ||
        String(step.tokenIn || "").toUpperCase() !== "USDC" ||
        String(step.tokenOut || "").toUpperCase() !== "ETH" ||
        step.destinationChain !== "arbitrum" ||
        !step.amount ||
        !step.maxPayment
      ) {
        throw controlled(
          "WORKFLOW_GAS_ACQUISITION_INVALID",
          "Gas acquisition requires Base USDC, an exact Arbitrum ETH output, and an explicit maximum USDC spend.",
        );
      }
    } else if (action === "bridge") {
      if (
        network !== "base" ||
        step.destinationChain !== "arbitrum" ||
        !["USDC", "WETH"].includes(String(step.tokenIn || "").toUpperCase())
      ) {
        throw controlled(
          "WORKFLOW_BRIDGE_UNSUPPORTED",
          "The workflow bridge supports reviewed Base USDC or WETH routes to Arbitrum through Across.",
        );
      }
    } else if (action === "swap" && network === "base") {
      if (
        !step.tokenIn ||
        !step.tokenOut ||
        !["USDC", "WETH"].includes(String(step.tokenOut).toUpperCase())
      ) {
        throw controlled(
          "WORKFLOW_SWAP_ASSETS_REQUIRED",
          "The Base cross-chain swap requires explicit input and a reviewed USDC or WETH bridge output.",
        );
      }
    } else if (action !== "data_purchase" && network !== "arbitrum") {
      throw controlled(
        "WORKFLOW_STEP_NETWORK_INVALID",
        `${step.action} must execute on Arbitrum after the bridge step.`,
      );
    }
    if (!step.amount && action !== "data_purchase" && action !== "borrow_capacity") {
      throw controlled("WORKFLOW_AMOUNT_REQUIRED", `Amount is missing for ${action}.`);
    }
    const previous = index > 0 ? normalized[index - 1] : undefined;
    const consumesPreviousOutput =
      previous !== undefined &&
      String(previous.tokenOut || previous.tokenIn || "").toUpperCase() ===
        String(step.tokenIn || "").toUpperCase() &&
      (String(step.amount || "").toUpperCase() === "MAX" ||
        (step.amountSource === undefined && previous.action === "swap"));
    const amountSource = step.amountSource ||
      (consumesPreviousOutput
        ? "previous_output"
        : String(step.amount || "").toUpperCase() === "MAX"
          ? "wallet_balance"
          : "explicit");
    return {
      id: `step-${index + 1}`,
      order: index + 1,
      action,
      network,
      chainId: NETWORKS[network].chainId as 8453 | 42161,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: step.amount || step.maxPayment || "0",
      amountSource,
      protocol: step.protocol,
      destinationChain: step.destinationChain,
      objective: step.objective,
      url: step.url,
      method: step.method,
      maxPayment: step.maxPayment,
      dependsOn: index === 0 ? [] : [`step-${index}`],
      status: index === 0 && action !== "borrow_capacity" ? "awaiting_signature" : "planned",
    };
  });
}

function stampRoute(
  rawResult: Record<string, any>,
  network: "base" | "arbitrum",
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

function bindCurrentExecution(
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

function bindCurrentPayment(
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

async function compileDataPurchaseResult(
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

async function compileBaseBridgeResult(
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

async function compileBaseSwapResult(
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

async function compileGasAcquisitionResult(
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

export async function compileWorkflow(
  intent: ParsedIntent,
  userAddressInput: string,
  requestId: string,
  originalPrompt = "",
  baseX402Challenge?: BaseX402ChallengeEvidence,
) {
  const userAddress = getAddress(userAddressInput);
  const steps = normalizeWorkflowSteps(intent);
  const first = steps[0];
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

async function readAcrossStatus(transactionHash: Hex) {
  const apiKey = process.env.ACROSS_API_KEY?.trim();
  if (!apiKey) {
    throw controlled("ACROSS_CONFIGURATION_REQUIRED", "Across status verification is unavailable.", 503);
  }
  const url = new URL(ACROSS_STATUS_URL);
  url.searchParams.set("depositTxnRef", transactionHash);
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES) {
    throw controlled("ACROSS_STATUS_INVALID", "Across status response exceeded the safe limit.", 502);
  }
  let data: any;
  try { data = JSON.parse(raw); } catch {
    throw controlled("ACROSS_STATUS_INVALID", "Across status response was not valid JSON.", 502);
  }
  if (!response.ok) {
    if (response.status === 404) return { status: "pending" as const };
    throw controlled("ACROSS_STATUS_UNAVAILABLE", "Across status verification is temporarily unavailable.", 502);
  }
  if (
    !["pending", "received", "filled", "expired", "refunded"].includes(data.status) ||
    Number(data.originChainId) !== 8453 ||
    Number(data.destinationChainId) !== 42161 ||
    String(data.depositTxHash || data.depositTxnRef).toLowerCase() !== transactionHash.toLowerCase()
  ) {
    throw controlled("ACROSS_STATUS_INVALID", "Across status did not match the sealed workflow deposit.", 502);
  }
  const fillTxHash = typeof data.fillTx === "string" && /^0x[0-9a-f]{64}$/iu.test(data.fillTx)
    ? data.fillTx as Hex
    : undefined;
  return { status: data.status as "pending" | "received" | "filled" | "expired" | "refunded", fillTxHash };
}

async function verifyTransaction(
  network: "base" | "arbitrum",
  txHash: Hex,
  step: WorkflowSemanticStep,
  userAddress: Address,
) {
  const client = NETWORK_CLIENTS[network];
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    getAddress(transaction.from) !== userAddress ||
    !transaction.to ||
    !step.execution ||
    getAddress(transaction.to) !== getAddress(step.execution.target) ||
    keccak256(transaction.input) !== step.execution.calldataHash ||
    transaction.value.toString() !== step.execution.value
  ) {
    throw controlled(
      "WORKFLOW_RECEIPT_MISMATCH",
      "Transaction receipt does not match the sealed workflow step.",
      409,
    );
  }
  if (!step.outputTokenAddress) return undefined;
  return assertWorkflowTokenOutputReceipt({
    logs: receipt.logs,
    token: step.outputTokenAddress,
    recipient: userAddress,
    minimumAmountAtomic: step.expectedOutputAtomic || "1",
  });
}

const ERC20_TRANSFER_TOPIC = keccak256(
  toHex("Transfer(address,address,uint256)"),
);
const AUTHORIZATION_USED_TOPIC = keccak256(
  toHex("AuthorizationUsed(address,bytes32)"),
);

function topicAddress(topic: string | undefined): Address | null {
  if (!topic || !/^0x[0-9a-f]{64}$/iu.test(topic)) return null;
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

export function assertWorkflowTokenOutputReceipt(input: {
  readonly logs: ReadonlyArray<{
    readonly address: Address;
    readonly topics: readonly Hex[];
    readonly data: Hex;
  }>;
  readonly token: Address;
  readonly recipient: Address;
  readonly minimumAmountAtomic: string;
}): bigint {
  if (!/^\d+$/u.test(input.minimumAmountAtomic) || BigInt(input.minimumAmountAtomic) <= 0n) {
    throw controlled("WORKFLOW_OUTPUT_RECEIPT_MISMATCH", "The sealed minimum output is invalid.", 409);
  }
  const output = input.logs.reduce((total, log) => {
    if (
      getAddress(log.address) !== getAddress(input.token) ||
      log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase() ||
      topicAddress(log.topics[2]) !== getAddress(input.recipient) ||
      !/^0x[0-9a-f]{64}$/iu.test(log.data)
    ) return total;
    return total + BigInt(log.data);
  }, 0n);
  if (output < BigInt(input.minimumAmountAtomic)) {
    throw controlled(
      "WORKFLOW_OUTPUT_RECEIPT_MISMATCH",
      "The confirmed transaction did not deliver the sealed minimum output to the workflow wallet.",
      409,
    );
  }
  return output;
}

async function verifyDataPurchaseSettlement(
  txHash: Hex,
  step: WorkflowSemanticStep,
  userAddress: Address,
  authorizationNonceInput: unknown,
) {
  if (
    typeof authorizationNonceInput !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(authorizationNonceInput) ||
    !step.payment
  ) {
    throw controlled(
      "WORKFLOW_X402_NONCE_REQUIRED",
      "The exact x402 authorization nonce is required to advance this payment.",
      409,
    );
  }
  const authorizationNonce = authorizationNonceInput.toLowerCase() as Hex;
  const [transaction, receipt] = await Promise.all([
    NETWORK_CLIENTS.base.getTransaction({ hash: txHash }),
    NETWORK_CLIENTS.base.getTransactionReceipt({ hash: txHash }),
  ]);
  assertDataPurchaseReceiptEvidence({
    transactionTo: transaction.to,
    receipt,
    step,
    userAddress,
    authorizationNonce,
  });
  return authorizationNonce;
}

async function verifyAcrossDestinationOutput(
  step: WorkflowSemanticStep,
  fillTxHash: Hex,
  userAddress: Address,
): Promise<bigint> {
  if (!step.outputTokenAddress || !step.expectedOutputAtomic) {
    throw controlled("ACROSS_OUTPUT_BINDING_MISSING", "The Across destination output binding is missing.", 409);
  }
  const receipt = await NETWORK_CLIENTS.arbitrum.getTransactionReceipt({
    hash: fillTxHash,
  });
  if (receipt.status !== "success") {
    throw controlled("ACROSS_FILL_RECEIPT_MISMATCH", "The Across destination fill transaction reverted.", 409);
  }
  try {
    return assertWorkflowTokenOutputReceipt({
      logs: receipt.logs,
      token: step.outputTokenAddress,
      recipient: userAddress,
      minimumAmountAtomic: step.expectedOutputAtomic,
    });
  } catch {
    throw controlled(
      "ACROSS_FILL_RECEIPT_MISMATCH",
      "The Across fill did not deliver the sealed minimum token output to the workflow wallet.",
      409,
    );
  }
}

export function assertDataPurchaseReceiptEvidence(input: {
  readonly transactionTo: Address | null;
  readonly receipt: {
    readonly status: "success" | "reverted";
    readonly logs: ReadonlyArray<{
      readonly address: Address;
      readonly topics: readonly Hex[];
      readonly data: Hex;
    }>;
  };
  readonly step: WorkflowSemanticStep;
  readonly userAddress: Address;
  readonly authorizationNonce: Hex;
}) {
  const { transactionTo, receipt, step, userAddress, authorizationNonce } = input;
  if (
    !step.payment ||
    receipt.status !== "success" ||
    !transactionTo ||
    getAddress(transactionTo) !== getAddress(step.payment.asset)
  ) {
    throw controlled(
      "WORKFLOW_X402_RECEIPT_MISMATCH",
      "x402 settlement transaction did not target the sealed Base USDC contract.",
      409,
    );
  }
  const payment = step.payment;
  const transferMatched = receipt.logs.some((log) =>
    getAddress(log.address) === getAddress(payment.asset) &&
    log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase() &&
    topicAddress(log.topics[1]) === userAddress &&
    topicAddress(log.topics[2]) === getAddress(payment.payTo) &&
    /^0x[0-9a-f]{64}$/iu.test(log.data) &&
    BigInt(log.data) === BigInt(payment.amountAtomic),
  );
  const authorizationMatched = receipt.logs.some((log) =>
    getAddress(log.address) === getAddress(payment.asset) &&
    log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() &&
    topicAddress(log.topics[1]) === userAddress &&
    log.topics[2]?.toLowerCase() === authorizationNonce,
  );
  if (!transferMatched || !authorizationMatched) {
    throw controlled(
      "WORKFLOW_X402_RECEIPT_MISMATCH",
      "x402 settlement did not contain the exact Transfer and AuthorizationUsed nonce evidence.",
      409,
    );
  }
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

async function prepareWorkflowExecution(
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

export async function advanceWorkflow(input: {
  workflowToken: unknown;
  userAddress: unknown;
  txHash?: unknown;
  authorizationNonce?: unknown;
}) {
  const plan = openWorkflowToken(input.workflowToken) as MutableWorkflowPlan;
  let userAddress: Address;
  try { userAddress = getAddress(String(input.userAddress)); } catch {
    throw controlled("WORKFLOW_WALLET_INVALID", "Workflow wallet is invalid.");
  }
  if (userAddress !== getAddress(plan.userAddress)) {
    throw controlled("WORKFLOW_WALLET_MISMATCH", "Workflow belongs to a different wallet.", 409);
  }
  const current = plan.steps[plan.currentStepIndex];
  let txHash = current.txHash;
  if (input.txHash !== undefined) {
    if (typeof input.txHash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(input.txHash)) {
      throw controlled("WORKFLOW_TX_HASH_INVALID", "Transaction hash is invalid.");
    }
    txHash = input.txHash as Hex;
    if (current.action === "data_purchase") {
      const authorizationNonce = await verifyDataPurchaseSettlement(
        txHash,
        current,
        userAddress,
        input.authorizationNonce,
      );
      plan.steps[plan.currentStepIndex] = {
        ...current,
        status: "confirmed",
        txHash,
        authorizationNonce,
      };
    } else {
      const actualOutput = await verifyTransaction(
        current.network,
        txHash,
        current,
        userAddress,
      );
      plan.steps[plan.currentStepIndex] = {
        ...current,
        status: "confirmed",
        txHash,
        ...(actualOutput !== undefined
          ? { actualOutputAtomic: actualOutput.toString() }
          : {}),
      };
    }
  }
  const confirmed = plan.steps[plan.currentStepIndex];
  if (!txHash) {
    throw controlled("WORKFLOW_TX_REQUIRED", "The current workflow step has not been submitted.");
  }

  if (confirmed.action === "bridge" || confirmed.action === "gas_acquire") {
    let status: Awaited<ReturnType<typeof readAcrossStatus>>;
    try {
      status = await readAcrossStatus(txHash);
    } catch (error) {
      const candidate = error as { statusCode?: unknown };
      if (Number(candidate.statusCode) < 500) throw error;
      plan.steps[plan.currentStepIndex] = {
        ...confirmed,
        status: "indeterminate",
        txHash,
      };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        retryableStatusCheck: true,
        message:
          "The source transaction is confirmed, but Across lifecycle evidence is temporarily unavailable. No transaction was retried; refresh this checkpoint later.",
      };
    }
    if (status.status === "pending" || status.status === "received") {
      plan.steps[plan.currentStepIndex] = { ...confirmed, status: "submitted", txHash };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        message: "Across deposit is confirmed on Base and is still waiting for destination fill.",
      };
    }
    if (status.status === "expired" || status.status === "refunded") {
      plan.steps[plan.currentStepIndex] = {
        ...confirmed,
        status: status.status === "refunded" ? "refunded" : "failed",
        txHash,
      };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        message: status.status === "refunded"
          ? "Across reports that the deposit was refunded."
          : "Across reports that the deposit expired and is eligible for refund.",
      };
    }
    if (!status.fillTxHash) {
      throw controlled("ACROSS_FILL_EVIDENCE_MISSING", "Across reported filled without a destination transaction hash.", 502);
    }
    const actualOutput = confirmed.action === "bridge"
      ? await verifyAcrossDestinationOutput(
          confirmed,
          status.fillTxHash,
          userAddress,
        )
      : BigInt(confirmed.expectedOutputAtomic || "0");
    plan.steps[plan.currentStepIndex] = {
      ...confirmed,
      status: "filled",
      txHash,
      fillTxHash: status.fillTxHash,
      actualOutputAtomic: actualOutput.toString(),
    };
  } else {
    plan.steps[plan.currentStepIndex] = { ...confirmed, status: "confirmed", txHash };
  }

  const nextIndex = plan.currentStepIndex + 1;
  if (nextIndex >= plan.steps.length) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message: "Workflow completed with every submitted step verified onchain.",
    };
  }
  plan.currentStepIndex = nextIndex;
  const next = plan.steps[nextIndex];
  const execution = await prepareWorkflowExecution(plan, next, userAddress);
  if (
    execution &&
    typeof execution === "object" &&
    "readOnlyResult" in execution &&
    execution.readOnlyResult === true
  ) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message:
        typeof execution.message === "string"
          ? execution.message
          : "The final read-only workflow result is ready; no transaction was created.",
    };
  }
  return {
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
    execution,
    message: `Workflow step ${next.order} is ready for explicit ${NETWORKS[next.network].displayName} wallet approval.`,
  };
}

export async function resumeWorkflow(input: {
  workflowToken: unknown;
  userAddress: unknown;
}) {
  const plan = openWorkflowToken(input.workflowToken) as MutableWorkflowPlan;
  let userAddress: Address;
  try {
    userAddress = getAddress(String(input.userAddress));
  } catch {
    throw controlled("WORKFLOW_WALLET_INVALID", "Workflow wallet is invalid.");
  }
  if (userAddress !== getAddress(plan.userAddress)) {
    throw controlled(
      "WORKFLOW_WALLET_MISMATCH",
      "Workflow belongs to a different wallet.",
      409,
    );
  }
  const current = plan.steps[plan.currentStepIndex];
  if (current.txHash) {
    return advanceWorkflow({
      workflowToken: input.workflowToken,
      userAddress,
    });
  }
  if (current.status !== "awaiting_signature" && current.status !== "planned") {
    throw controlled(
      "WORKFLOW_RESUME_STATE_INVALID",
      "Workflow cannot be resumed from its current checkpoint.",
      409,
    );
  }
  const execution = await prepareWorkflowExecution(plan, current, userAddress);
  if (
    execution &&
    typeof execution === "object" &&
    "readOnlyResult" in execution &&
    execution.readOnlyResult === true
  ) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message:
        typeof execution.message === "string"
          ? execution.message
          : "The read-only workflow result is ready; no transaction was created.",
    };
  }
  return {
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
    execution,
    message: `Workflow step ${current.order} was re-quoted for explicit wallet approval.`,
  };
}
