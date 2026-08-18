import { describe, expect, it } from "vitest";
import type { WorkflowPlanV1 } from "./workflow.js";
import {
  assertDataPurchaseReceiptEvidence,
  assertWorkflowTokenOutputReceipt,
  assertWorkflowPlan,
  normalizeWorkflowSteps,
  openWorkflowToken,
  sealWorkflowPlan,
} from "./workflow.js";
import { ARBITRUM_CONTRACTS } from "../networks/arbitrum/contracts.js";
import { ACROSS_SPOKE_POOL, ACROSS_SPOKE_POOL_PERIPHERY } from "../shared/config/networks.js";
import { TOKENS } from "../networks/base/contracts.js";
import { resolveIntentEntities } from "../shared/assets/resolver.js";
import { encodeAbiParameters, keccak256, padHex, toHex } from "viem";

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

  it("accepts a bounded Base gas-acquisition step and rejects the same semantics on Arbitrum", () => {
    const candidate = plan();
    const gasStep = {
      ...candidate.steps[0],
      action: "gas_acquire",
      tokenIn: "USDC",
      tokenOut: "ETH",
      amount: "0.00001",
      maxPayment: "0.05",
      destinationChain: "arbitrum",
      execution: {
        target: ACROSS_SPOKE_POOL_PERIPHERY,
        calldataHash: `0x${"33".repeat(32)}` as const,
        value: "0",
        quoteExpiresAt: candidate.createdAt + 30_000,
      },
    };
    expect(() => assertWorkflowPlan({
      ...candidate,
      steps: [gasStep, candidate.steps[1]],
    })).not.toThrow();

    expect(() => assertWorkflowPlan({
      ...candidate,
      steps: [
        { ...gasStep, network: "arbitrum", chainId: 42161 },
        candidate.steps[1],
      ],
    })).toThrow(/step graph/u);
  });
});

describe("general Base to Arbitrum workflow compiler", () => {
  it("returns a structured UI decision when native ETH cannot be supplied directly to Aave", async () => {
    const result = await resolveIntentEntities({
      isComplete: true,
      action: "workflow",
      message: "test",
      amount: "MAX",
      tokenIn: "USDC",
      durationInDays: 0,
      workflowSteps: [
        { action: "bridge", network: "base", tokenIn: "USDC", amount: "MAX", destinationChain: "arbitrum" },
        { action: "lend", network: "arbitrum", tokenIn: "ETH", amount: "MAX", protocol: "aave-v3" },
      ],
    }, {
      network: "base",
      userAddress: wallet,
      originalPrompt: "use my Base USDC and lend ETH on Arbitrum",
      requestId: "request-test",
    });
    expect(result.status).toBe("clarification");
    if (result.status === "clarification") {
      expect(result.clarification.kind).toBe("workflow");
      expect(result.clarification.field).toBe("workflowSteps.1.tokenIn");
      expect(result.clarification.options.map(({ symbol }) => symbol)).toEqual([
        "WETH", "USDC", "ARB",
      ]);
    }
  });

  it("propagates wallet balance and verified outputs without consuming the destination wallet's full balance", () => {
    const steps = normalizeWorkflowSteps({
      isComplete: true,
      action: "workflow",
      message: "test",
      amount: "MAX",
      tokenIn: "USDC",
      durationInDays: 0,
      workflowSteps: [
        { action: "swap", network: "base", tokenIn: "USDC", tokenOut: "ETH", amount: "MAX", amountSource: "wallet_balance" },
        { action: "bridge", network: "base", tokenIn: "ETH", amount: "MAX", destinationChain: "arbitrum", protocol: "across" },
        { action: "lend", network: "arbitrum", tokenIn: "WETH", amount: "MAX", protocol: "aave-v3", objective: "best_rate" },
        { action: "borrow_capacity", network: "arbitrum", tokenIn: "USDC", amount: "0", protocol: "aave-v3" },
      ],
    });
    expect(steps.map(({ network, action }) => `${network}:${action}`)).toEqual([
      "base:swap",
      "base:bridge",
      "arbitrum:lend",
      "arbitrum:borrow_capacity",
    ]);
    expect(steps[0]).toMatchObject({ tokenOut: "WETH", amountSource: "wallet_balance" });
    expect(steps[1]).toMatchObject({ tokenIn: "WETH", amountSource: "previous_output" });
    expect(steps[2]).toMatchObject({ tokenIn: "WETH", amountSource: "previous_output" });
    expect(steps[3]).toMatchObject({ amount: "0", amountSource: "explicit" });
  });

  it("inserts a reviewed Arbitrum swap when the selected lending asset differs from the bridge output", () => {
    const steps = normalizeWorkflowSteps({
      isComplete: true,
      action: "workflow",
      message: "test",
      amount: "MAX",
      tokenIn: "USDC",
      durationInDays: 0,
      workflowSteps: [
        { action: "swap", network: "base", tokenIn: "USDC", tokenOut: "WETH", amount: "MAX" },
        { action: "bridge", network: "base", tokenIn: "WETH", amount: "MAX", destinationChain: "arbitrum", protocol: "across" },
        { action: "lend", network: "arbitrum", tokenIn: "USDC", amount: "MAX", protocol: "aave-v3" },
        { action: "borrow_capacity", network: "arbitrum", tokenIn: "USDC", amount: "0", protocol: "aave-v3" },
      ],
    });
    expect(steps[2]).toMatchObject({
      action: "swap",
      network: "arbitrum",
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountSource: "previous_output",
      protocol: "uniswap-v3",
    });
    expect(steps[3]).toMatchObject({
      action: "lend",
      tokenIn: "USDC",
      amountSource: "previous_output",
    });
  });
});

describe("workflow output propagation evidence", () => {
  const transferTopic = keccak256(toHex("Transfer(address,address,uint256)"));
  const sender = "0x0000000000000000000000000000000000000002" as const;
  const outputLogs = [{
    address: TOKENS.WETH,
    topics: [transferTopic, padHex(sender), padHex(wallet)],
    data: encodeAbiParameters([{ type: "uint256" }], [12_500n]),
  }];

  it("extracts only the exact token output delivered to the workflow wallet", () => {
    expect(assertWorkflowTokenOutputReceipt({
      logs: outputLogs,
      token: TOKENS.WETH,
      recipient: wallet,
      minimumAmountAtomic: "12000",
    })).toBe(12_500n);
  });

  it("rejects stale balances, another recipient, another token, or output below the sealed floor", () => {
    expect(() => assertWorkflowTokenOutputReceipt({
      logs: [],
      token: TOKENS.WETH,
      recipient: wallet,
      minimumAmountAtomic: "1",
    })).toThrow(/minimum output/u);
    expect(() => assertWorkflowTokenOutputReceipt({
      logs: outputLogs,
      token: TOKENS.USDC,
      recipient: wallet,
      minimumAmountAtomic: "1",
    })).toThrow(/minimum output/u);
    expect(() => assertWorkflowTokenOutputReceipt({
      logs: outputLogs,
      token: TOKENS.WETH,
      recipient: sender,
      minimumAmountAtomic: "1",
    })).toThrow(/minimum output/u);
    expect(() => assertWorkflowTokenOutputReceipt({
      logs: outputLogs,
      token: TOKENS.WETH,
      recipient: wallet,
      minimumAmountAtomic: "12501",
    })).toThrow(/minimum output/u);
  });
});

describe("workflow x402 receipt checkpoint", () => {
  const payTo = "0x0000000000000000000000000000000000000002" as const;
  const nonce = `0x${"ab".repeat(32)}` as const;
  const dataStep = {
    id: "step-1",
    order: 1,
    action: "data_purchase",
    network: "base" as const,
    chainId: 8453 as const,
    amount: "0.0085",
    url: "https://example.com/report",
    method: "GET" as const,
    maxPayment: "0.0085",
    dependsOn: [],
    status: "awaiting_signature" as const,
    payment: {
      asset: TOKENS.USDC,
      payTo,
      amountAtomic: "8500",
      requestUrl: "https://example.com/report",
      observedAt: new Date().toISOString(),
    },
  };
  const transferTopic = keccak256(toHex("Transfer(address,address,uint256)"));
  const authorizationTopic = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
  const receipt = {
    status: "success" as const,
    logs: [
      {
        address: TOKENS.USDC,
        topics: [transferTopic, padHex(wallet), padHex(payTo)],
        data: encodeAbiParameters([{ type: "uint256" }], [8500n]),
      },
      {
        address: TOKENS.USDC,
        topics: [authorizationTopic, padHex(wallet), nonce],
        data: "0x" as const,
      },
    ],
  };

  it("requires both the exact transfer and freshly signed authorization nonce", () => {
    expect(() => assertDataPurchaseReceiptEvidence({
      transactionTo: TOKENS.USDC,
      receipt,
      step: dataStep,
      userAddress: wallet,
      authorizationNonce: nonce,
    })).not.toThrow();
  });

  it("rejects a stale same-amount settlement with another nonce", () => {
    expect(() => assertDataPurchaseReceiptEvidence({
      transactionTo: TOKENS.USDC,
      receipt,
      step: dataStep,
      userAddress: wallet,
      authorizationNonce: `0x${"cd".repeat(32)}`,
    })).toThrow(/AuthorizationUsed nonce evidence/u);
  });
});
