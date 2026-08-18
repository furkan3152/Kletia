import { describe, expect, it } from "vitest";
import { buildPolicyAgent } from "./policyAgent.js";

const owner = "0x1111111111111111111111111111111111111111";

describe("PolicyAgentV1", () => {
  it("creates planning-only EIP-712 data without transaction authority", () => {
    const result = buildPolicyAgent({
      isComplete: true,
      action: "policy_agent",
      message: "Create policy",
      amount: "0",
      durationInDays: 0,
      policyAgent: {
        name: "Arbitrum yield policy",
        objective: "Find risk-adjusted USDC yield without moving funds automatically.",
        allowedNetworks: ["base", "arbitrum"],
        allowedProtocols: ["across", "aave-v3"],
        allowedAssets: ["USDC"],
        maxSpendUsdc: "25",
        riskTolerance: "balanced",
        expiresInHours: 24,
      },
    }, owner, "base");
    expect(result.policyAgent.authority).toBe("planning_only_no_transaction_authority");
    expect(result.policyAgent.requiresPerStepWalletApproval).toBe(true);
    expect(result.policyAgent.maxSpendUsdcAtomic).toBe("25000000");
    expect(result.typedData.domain.chainId).toBe(8453);
  });

  it("rejects Arc Testnet in a Base/Arbitrum capital policy", () => {
    expect(() => buildPolicyAgent({
      isComplete: true,
      action: "policy_agent",
      message: "Create policy",
      amount: "0",
      durationInDays: 0,
      policyAgent: {
        name: "Mixed policy",
        objective: "Mix test and production capital in one policy.",
        allowedNetworks: ["arc", "base"] as unknown as Array<"base" | "arbitrum">,
        allowedProtocols: ["across"],
        allowedAssets: ["USDC"],
        maxSpendUsdc: "1",
        riskTolerance: "conservative",
        expiresInHours: 1,
      },
    }, owner, "base")).toThrow(/unsupported network/u);
  });
});
