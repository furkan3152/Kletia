import { describe, expect, it } from "vitest";
import type { WorkflowPlanV1 } from "./workflow.js";
import {
  assertWorkflowPlan,
  openWorkflowToken,
  sealWorkflowPlan,
} from "./workflow.js";
import { ARBITRUM_CONTRACTS } from "../networks/arbitrum/contracts.js";
import { ACROSS_SPOKE_POOL } from "../config/networks.js";

const wallet = "0x0000000000000000000000000000000000000001" as const;

function plan(overrides: Partial<WorkflowPlanV1> = {}): WorkflowPlanV1 {
  const createdAt = Date.now();
  return {
    version: 1,
    workflowId: "workflow-test",
    requestId: "request-test",
    userAddress: wallet,
    createdAt,
    expiresAt: createdAt + 60_000,
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
    steps: [
      {
        id: "step-1",
        order: 1,
        action: "bridge",
        network: "base",
        chainId: 8453,
        tokenIn: "USDC",
        amount: "1",
        protocol: "across",
        destinationChain: "arbitrum",
        dependsOn: [],
        status: "awaiting_signature",
        execution: {
          target: ACROSS_SPOKE_POOL,
          calldataHash: `0x${"11".repeat(32)}`,
          value: "0",
          quoteExpiresAt: createdAt + 30_000,
        },
      },
      {
        id: "step-2",
        order: 2,
        action: "lend",
        network: "arbitrum",
        chainId: 42161,
        tokenIn: "USDC",
        amount: "MAX",
        protocol: "aave_v3",
        dependsOn: ["step-1"],
        status: "planned",
      },
    ],
    ...overrides,
  };
}

describe("WorkflowPlanV1 server boundary", () => {
  it("round-trips an exact HMAC-sealed workflow", () => {
    const expected = plan();
    expect(openWorkflowToken(sealWorkflowPlan(expected))).toEqual(expected);
  });

  it("rejects any token payload or signature mutation", () => {
    const sealed = sealWorkflowPlan(plan());
    const [payload, signature] = sealed.split(".");
    const tamperedPayload = `${payload[0] === "A" ? "B" : "A"}${payload.slice(1)}`;
    const tampered = `${tamperedPayload}.${signature}`;
    expect(() => openWorkflowToken(tampered)).toThrow(/signature/u);
  });

  it("rejects a cross-network execution target even before receipt checks", () => {
    const candidate = plan();
    const steps = [...candidate.steps];
    steps[1] = {
      ...steps[1],
      execution: {
        target: ARBITRUM_CONTRACTS.uniswapV3SwapRouter,
        calldataHash: `0x${"22".repeat(32)}`,
        value: "0",
        quoteExpiresAt: candidate.createdAt + 30_000,
      },
    };
    expect(() => assertWorkflowPlan({ ...candidate, steps })).toThrow(
      /execution binding/u,
    );
  });

  it("rejects Arc steps inside a mainnet workflow", () => {
    const candidate = plan() as unknown as Record<string, unknown>;
    const steps = [...(candidate.steps as Array<Record<string, unknown>>)].map(
      (step) => ({ ...step }),
    );
    steps[1] = { ...steps[1], network: "arc", chainId: 5_042_002 };
    expect(() => assertWorkflowPlan({ ...candidate, steps })).toThrow(
      /step graph/u,
    );
  });

  it("rejects an expired signed workflow instead of refreshing it silently", () => {
    const createdAt = Date.now() - 120_000;
    const candidate = plan();
    const expired = plan({
      createdAt,
      expiresAt: createdAt + 60_000,
      steps: candidate.steps.map((step) =>
        step.execution
          ? {
              ...step,
              execution: {
                ...step.execution,
                quoteExpiresAt: createdAt + 30_000,
              },
            }
          : step,
      ),
    });
    expect(() => openWorkflowToken(sealWorkflowPlan(expired))).toThrow(
      /expired/u,
    );
  });
});
