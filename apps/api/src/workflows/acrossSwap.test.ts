import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
} from "viem";
import { TOKENS } from "../networks/base/contracts.js";
import { ACROSS_SPOKE_POOL_PERIPHERY } from "../config/networks.js";
import {
  getAcrossGasAcquisitionRoute,
} from "./acrossSwap.js";

const wallet = "0x0000000000000000000000000000000000000001" as const;

function quote(overrides: Record<string, unknown> = {}) {
  return {
    crossSwapType: "anyToBridgeable",
    amountType: "exactOutput",
    inputToken: {
      chainId: 8453,
      decimals: 6,
      symbol: "USDC",
      address: TOKENS.USDC,
    },
    outputToken: {
      chainId: 42161,
      decimals: 18,
      symbol: "ETH",
      address: "0x0000000000000000000000000000000000000000",
    },
    inputAmount: "25000",
    maxInputAmount: "30000",
    expectedOutputAmount: "10000000000000",
    minOutputAmount: "10000000000000",
    quoteExpiryTimestamp: Math.floor(Date.now() / 1_000) + 60,
    approvalTxns: [{
      chainId: 8453,
      to: TOKENS.USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [ACROSS_SPOKE_POOL_PERIPHERY, maxUint256],
      }),
    }],
    swapTx: {
      chainId: 8453,
      to: ACROSS_SPOKE_POOL_PERIPHERY,
      data: "0x110560ad00",
      value: "0",
    },
    ...overrides,
  };
}

function mockQuote(value: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Across exact-output gas acquisition", () => {
  it("accepts only an exact Arbitrum ETH output inside the Base USDC cap", async () => {
    mockQuote(quote());
    const route = await getAcrossGasAcquisitionRoute({
      outputEth: "0.00001",
      maxUsdc: "0.03",
      userAddress: wallet,
    });
    expect(route.router).toBe(ACROSS_SPOKE_POOL_PERIPHERY);
    expect(route.outputAmountAtomic).toBe("10000000000000");
    expect(route.maxInputAmountAtomic).toBe("30000");
    expect(route.approval.amount).toBe("30000");
  });

  it("rejects a quote above the user's exact USDC cap", async () => {
    mockQuote(quote({ maxInputAmount: "30001" }));
    await expect(getAcrossGasAcquisitionRoute({
      outputEth: "0.00001",
      maxUsdc: "0.03",
      userAddress: wallet,
    })).rejects.toMatchObject({ code: "ACROSS_GAS_CAP_EXCEEDED" });
  });

  it("rejects an API-provided transaction outside the pinned periphery", async () => {
    mockQuote(quote({
      swapTx: {
        chainId: 8453,
        to: "0x0000000000000000000000000000000000000002",
        data: "0x110560ad00",
      },
    }));
    await expect(getAcrossGasAcquisitionRoute({
      outputEth: "0.00001",
      maxUsdc: "0.03",
      userAddress: wallet,
    })).rejects.toMatchObject({ code: "ACROSS_SWAP_TARGET_INVALID" });
  });
});
