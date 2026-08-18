import { getAddress, isAddress } from "viem";
import type { WorkflowPlanV1 } from "../types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_32_PATTERN = /^0x[0-9a-f]{64}$/iu;
const INTEGER_PATTERN = /^\d+$/u;
const STATUSES = new Set([
  "planned", "awaiting_signature", "submitted", "confirmed", "filled",
  "ready", "failed", "refunded", "indeterminate",
]);

export function isWorkflowPlanV1(
  value: unknown,
  expected: { requestId: string; userAddress: string; nowMs?: number },
): value is WorkflowPlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as WorkflowPlanV1;
  const now = expected.nowMs ?? Date.now();
  if (
    plan.version !== 1 ||
    !UUID_PATTERN.test(plan.workflowId) ||
    plan.requestId !== expected.requestId ||
    !isAddress(plan.userAddress) ||
    getAddress(plan.userAddress) !== getAddress(expected.userAddress) ||
    !Number.isSafeInteger(plan.createdAt) ||
    !Number.isSafeInteger(plan.expiresAt) ||
    plan.createdAt > now + 30_000 ||
    plan.expiresAt <= now ||
    plan.expiresAt - plan.createdAt > 24 * 60 * 60_000 ||
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
  ) return false;

  return plan.steps.every((step, index) => {
    const expectedNetwork = index === 0 ? "base" : "arbitrum";
    const expectedChainId = expectedNetwork === "base" ? 8453 : 42161;
    const execution = step.execution;
    return (
      step.id === `step-${index + 1}` &&
      step.order === index + 1 &&
      step.network === expectedNetwork &&
      step.chainId === expectedChainId &&
      typeof step.action === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(step.action) &&
      typeof step.amount === "string" &&
      step.amount.length > 0 &&
      STATUSES.has(step.status) &&
      Array.isArray(step.dependsOn) &&
      (index === 0
        ? step.dependsOn.length === 0
        : step.dependsOn.length === 1 && step.dependsOn[0] === `step-${index}`) &&
      (!step.expectedOutputAtomic || INTEGER_PATTERN.test(step.expectedOutputAtomic)) &&
      (!execution || (
        isAddress(execution.target) &&
        HEX_32_PATTERN.test(execution.calldataHash) &&
        INTEGER_PATTERN.test(execution.value) &&
        Number.isSafeInteger(execution.quoteExpiresAt)
      )) &&
      (!step.txHash || HEX_32_PATTERN.test(step.txHash)) &&
      (!step.fillTxHash || HEX_32_PATTERN.test(step.fillTxHash))
    );
  });
}

export function isWorkflowToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 80 && value.length <= 32_000 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
}
