import { describe, expect, it } from "vitest";
import { isWorkflowPlanV1, isWorkflowToken } from "./workflowBoundary";
import type { WorkflowPlanV1 } from "../types";

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

  it("accepts a capped Base gas acquisition step but rejects it on Arbitrum", () => {
    const gasPlan = structuredClone(plan) as WorkflowPlanV1;
    gasPlan.steps[0] = {
      ...gasPlan.steps[0],
      action: "gas_acquire",
      amount: "0.00001",
      tokenOut: "ETH",
      maxPayment: "0.03",
      destinationChain: "arbitrum",
    };
    expect(isWorkflowPlanV1(gasPlan, { requestId, userAddress: owner, nowMs: now })).toBe(true);
    gasPlan.steps[0].network = "arbitrum";
    gasPlan.steps[0].chainId = 42161;
    expect(isWorkflowPlanV1(gasPlan, { requestId, userAddress: owner, nowMs: now })).toBe(false);
  });

  it("requires an exact sealed payment binding for a data purchase", () => {
    const purchasePlan = structuredClone(plan) as WorkflowPlanV1;
    purchasePlan.steps[0] = {
      ...purchasePlan.steps[0],
      action: "data_purchase",
      amount: "0.0085",
      url: "https://example.com/report",
      method: "GET",
      maxPayment: "0.0085",
      payment: {
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x2222222222222222222222222222222222222222",
        amountAtomic: "8500",
        requestUrl: "https://example.com/report",
        observedAt: new Date(now).toISOString(),
      },
    };
    expect(isWorkflowPlanV1(purchasePlan, { requestId, userAddress: owner, nowMs: now })).toBe(true);
    purchasePlan.steps[0].payment!.requestUrl = "https://evil.example/report";
    expect(isWorkflowPlanV1(purchasePlan, { requestId, userAddress: owner, nowMs: now })).toBe(false);
  });
});
