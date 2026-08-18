import { describe, expect, it } from "vitest";
import { isWorkflowPlanV1, isWorkflowToken } from "./workflowBoundary";

const owner = "0x1111111111111111111111111111111111111111";
const requestId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000_000;
const plan = {
  version: 1 as const,
  workflowId: "22222222-2222-4222-8222-222222222222",
  requestId,
  userAddress: owner,
  createdAt: now - 1_000,
  expiresAt: now + 60_000,
  objective: "risk_adjusted_net_return" as const,
  atomicity: {
    sameChain: "wallet_batch_when_verified" as const,
    crossChain: "staged_checkpointed_no_global_rollback" as const,
  },
  hardPolicies: {
    minimumHealthFactor: "1.5" as const,
    requiresPerStepWalletApproval: true as const,
    mockDataAllowed: false as const,
  },
  currentStepIndex: 0,
  steps: [
    { id: "step-1", order: 1, action: "bridge", network: "base" as const, chainId: 8453 as const, amount: "10", tokenIn: "USDC", dependsOn: [], status: "awaiting_signature" as const, expectedOutputAtomic: "9900000" },
    { id: "step-2", order: 2, action: "lend", network: "arbitrum" as const, chainId: 42161 as const, amount: "MAX", tokenIn: "USDC", dependsOn: ["step-1"], status: "planned" as const },
  ],
};

describe("WorkflowPlanV1 boundary", () => {
  it("accepts exact wallet, graph, network and expiry binding", () => {
    expect(isWorkflowPlanV1(plan, { requestId, userAddress: owner, nowMs: now })).toBe(true);
  });

  it("rejects cross-network target mutation", () => {
    const mutated = structuredClone(plan);
    mutated.steps[1].chainId = 8453 as 42161;
    expect(isWorkflowPlanV1(mutated, { requestId, userAddress: owner, nowMs: now })).toBe(false);
  });

  it("accepts only bounded opaque HMAC token shape", () => {
    expect(isWorkflowToken(`${"a".repeat(80)}.${"b".repeat(43)}`)).toBe(true);
    expect(isWorkflowToken("not-a-token")).toBe(false);
  });
});
