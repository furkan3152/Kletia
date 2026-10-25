/**
 * Sealed workflow tokens: signing, opening and validating a plan.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress } from "viem";
import {
  ARC_CONTRACTS,
  isNetworkTargetAllowed,
  NETWORKS,
  type NetworkId,
} from "../../shared/config/networks.js";
import { ARBITRUM_TOKENS } from "../../networks/arbitrum/contracts.js";
import { TOKENS } from "../../networks/base/contracts.js";
import {
  decodeCanonicalBase64Url,
} from "../../shared/security/canonicalBase64Url.js";
import { workflowActionAllowed, type WorkflowPlanV1 } from "./plan.js";

// Cross-chain fills can legitimately take longer than an individual route quote.
// The workflow remains resumable for one day, while every executable step keeps
// its own much shorter quote deadline and must be refreshed before signing.
export const WORKFLOW_TTL_MS = 24 * 60 * 60 * 1_000;
export const ACROSS_STATUS_URL = "https://app.across.to/api/deposit/status";
export const MAX_STATUS_BYTES = 32 * 1_024;
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

export function controlled(code: string, message: string, statusCode = 400): Error {
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
    supplied = decodeCanonicalBase64Url(suppliedSignature);
  } catch {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token is invalid.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw controlled("WORKFLOW_TOKEN_INVALID", "Workflow token signature is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8"));
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
    const stepNetwork = String(step.network) as NetworkId;
    const knownNetwork = ["base", "arc", "arbitrum"].includes(stepNetwork);
    const expectedChainId = knownNetwork ? NETWORKS[stepNetwork].chainId : undefined;
    const actionNetworkValid = knownNetwork && workflowActionAllowed(stepNetwork, step.action);
    if (
      step.id !== `step-${index + 1}` ||
      step.order !== index + 1 ||
      !knownNetwork ||
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
            : step.network === "arc"
              ? symbol === "KLET" ? ARC_CONTRACTS.Token : undefined
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
