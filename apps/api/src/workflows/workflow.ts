import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  getAddress,
  keccak256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import type { ParsedIntent } from "../ai/parser.js";
import {
  isNetworkTargetAllowed,
  NETWORKS,
  NETWORK_CLIENTS,
  type NetworkId,
} from "../config/networks.js";
import { getAcrossBridgeRoutes } from "../networks/base/bridge/across.js";
import { executeArbitrumEngine } from "../networks/arbitrum/engine.js";
import { ARBITRUM_TOKENS } from "../networks/arbitrum/contracts.js";
import { TOKENS } from "../networks/base/contracts.js";
import { resolveIntentEntities } from "../assets/resolver.js";
import { createVerifiedIntentResultEnvelope } from "../intent/responseEnvelope.js";

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
  readonly protocol?: string;
  readonly destinationChain?: string;
  readonly objective?: string;
  readonly dependsOn: readonly string[];
  readonly status: WorkflowStepStatus;
  readonly expectedOutputAtomic?: string;
  readonly execution?: {
    readonly target: Address;
    readonly calldataHash: Hex;
    readonly value: string;
    readonly quoteExpiresAt: number;
  };
  readonly txHash?: Hex;
  readonly fillTxHash?: Hex;
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
    if (
      step.id !== `step-${index + 1}` ||
      step.order !== index + 1 ||
      (step.network !== "base" && step.network !== "arbitrum") ||
      step.chainId !== expectedChainId ||
      !Array.isArray(step.dependsOn) ||
      (index === 0
        ? step.dependsOn.length !== 0
        : step.dependsOn.length !== 1 || step.dependsOn[0] !== `step-${index}`)
    ) {
      throw controlled("WORKFLOW_PLAN_INVALID", "Workflow step graph is invalid.");
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
  });
}

function normalizeWorkflowSteps(intent: ParsedIntent): WorkflowSemanticStep[] {
  if (!intent.workflowSteps || intent.workflowSteps.length < 2) {
    throw controlled(
      "WORKFLOW_STEPS_REQUIRED",
      "A multi-step workflow requires at least two explicitly ordered actions.",
    );
  }
  return intent.workflowSteps.map((step, index) => {
    const network: "base" | "arc" | "arbitrum" =
      step.network || (step.action === "bridge" ? "base" : "arbitrum");
    if (network === "arc") {
      throw controlled(
        "WORKFLOW_NETWORK_UNSUPPORTED",
        "Arc Testnet cannot be mixed with Base/Arbitrum Mainnet capital workflows.",
      );
    }
    if (step.action === "x402_request" || step.action === "gas_acquire") {
      throw controlled(
        "WORKFLOW_STEP_REQUIRES_EXPLICIT_PLAN",
        `${step.action} must be requested and reviewed as its own explicit paid step in the current MVP.`,
      );
    }
    if (step.action === "bridge") {
      if (
        network !== "base" ||
        step.destinationChain !== "arbitrum" ||
        String(step.tokenIn || "").toUpperCase() !== "USDC"
      ) {
        throw controlled(
          "WORKFLOW_BRIDGE_UNSUPPORTED",
          "The MVP workflow bridge is restricted to native USDC from Base to Arbitrum through Across.",
        );
      }
    } else if (network !== "arbitrum") {
      throw controlled(
        "WORKFLOW_STEP_NETWORK_INVALID",
        `${step.action} must execute on Arbitrum after the bridge step.`,
      );
    }
    if (!step.amount) {
      throw controlled("WORKFLOW_AMOUNT_REQUIRED", `Amount is missing for ${step.action}.`);
    }
    return {
      id: `step-${index + 1}`,
      order: index + 1,
      action: step.action,
      network,
      chainId: NETWORKS[network].chainId as 8453 | 42161,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: step.amount,
      protocol: step.protocol,
      destinationChain: step.destinationChain,
      objective: step.objective,
      dependsOn: index === 0 ? [] : [`step-${index}`],
      status: index === 0 ? "awaiting_signature" : "planned",
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

export async function compileWorkflow(
  intent: ParsedIntent,
  userAddressInput: string,
  requestId: string,
) {
  const userAddress = getAddress(userAddressInput);
  const steps = normalizeWorkflowSteps(intent);
  const first = steps[0];
  if (first.action !== "bridge") {
    throw controlled(
      "WORKFLOW_ENTRY_UNSUPPORTED",
      "The current cross-chain MVP must start with an explicit Base-to-Arbitrum USDC bridge.",
    );
  }
  const amount = parseUnits(first.amount, 6);
  if (amount <= 0n) throw controlled("WORKFLOW_AMOUNT_REQUIRED", "Bridge amount must be positive.");
  const bridgeRoutes = await getAcrossBridgeRoutes(
    TOKENS.USDC,
    "USDC",
    amount,
    "arbitrum",
    userAddress,
    6,
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
  steps[0] = {
    ...steps[0],
    expectedOutputAtomic: String(bridge.outputAmountAtomic),
  };
  const rawResult = stampRoute(
    {
      status: "success",
      winner: bridge.name,
      winnerMessage:
        "A staged Base-to-Arbitrum workflow is ready. Cross-chain settlement is checkpointed and is not globally atomic.",
      expectedOutput: bridge.expectedOutput,
      routePath: bridge.routePath,
      targetContract: bridge.router,
      calldata: bridge.calldata,
      value: bridge.value,
      amountInWei: amount.toString(),
      tokenInAddress: TOKENS.USDC,
      isNativeIn: false,
      approvals: [{
        token: TOKENS.USDC,
        spender: bridge.router,
        amount: amount.toString(),
        symbol: "USDC",
        required: true,
      }],
      allRoutes: [{
        ...bridge,
        approvals: [{
          token: TOKENS.USDC,
          spender: bridge.router,
          amount: amount.toString(),
          symbol: "USDC",
          required: true,
        }],
        approvalPolicy: "explicit",
        primaryTokenAddress: TOKENS.USDC,
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
  bindCurrentExecution(plan, rawResult);
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
}

async function compileArbitrumStep(
  step: WorkflowSemanticStep,
  plan: WorkflowPlanV1,
) {
  let amount = step.amount;
  if (amount.toUpperCase() === "MAX") {
    const previous = plan.steps[step.order - 2];
    if (previous.action === "bridge") {
      const bridgeTx = previous.txHash;
      if (!bridgeTx) throw controlled("WORKFLOW_BRIDGE_EVIDENCE_MISSING", "Bridge output proof is missing.");
      const status = await readAcrossStatus(bridgeTx);
      if (status.status !== "filled") {
        throw controlled("WORKFLOW_BRIDGE_NOT_FILLED", "Across has not confirmed the destination fill yet.", 409);
      }
      const expectedOutputAtomic = previous.expectedOutputAtomic;
      if (!expectedOutputAtomic || !/^\d+$/u.test(expectedOutputAtomic)) {
        throw controlled(
          "WORKFLOW_BRIDGE_OUTPUT_INVALID",
          "The sealed bridge output amount is missing.",
          409,
        );
      }
      const balance = await NETWORK_CLIENTS.arbitrum.readContract({
        address: ARBITRUM_TOKENS.USDC.address,
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
      amount = expectedOutputAtomic;
      amount = formatAtomic(amount, 6);
    }
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
    await verifyTransaction(current.network, txHash, current, userAddress);
    plan.steps[plan.currentStepIndex] = { ...current, status: "confirmed", txHash };
  }
  const confirmed = plan.steps[plan.currentStepIndex];
  if (!txHash) {
    throw controlled("WORKFLOW_TX_REQUIRED", "The current workflow step has not been submitted.");
  }

  if (confirmed.action === "bridge") {
    const status = await readAcrossStatus(txHash);
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
    plan.steps[plan.currentStepIndex] = {
      ...confirmed,
      status: "filled",
      txHash,
      fillTxHash: status.fillTxHash,
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
  const prepared = await compileArbitrumStep(next, plan);
  const resolution = await resolveIntentEntities(prepared.intent, {
    network: "arbitrum",
    userAddress,
    originalPrompt: [next.action, next.amount, next.tokenIn, next.tokenOut]
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
  const stamped = stampRoute(
    prepared.raw,
    "arbitrum",
    next.action,
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
  return {
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
    execution,
    message: `Workflow step ${next.order} is ready for explicit Arbitrum wallet approval.`,
  };
}
