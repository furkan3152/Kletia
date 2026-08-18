import { describe, expect, it } from "vitest";
import {
  ARC_CONTRACTS,
  NETWORKS,
  NetworkValidationError,
  isNetworkTargetAllowed,
  normalizeNetworkId,
  resolveNetworkRequest,
} from "./networks.js";
import { ARBITRUM_CONTRACTS, ARBITRUM_TOKENS } from "../networks/arbitrum/contracts.js";

describe("network boundary", () => {
  it("normalizes only supported production and test identities", () => {
    expect(normalizeNetworkId("base-mainnet")).toBe("base");
    expect(normalizeNetworkId("eip155:5042002")).toBe("arc");
    expect(normalizeNetworkId("eip155:42161")).toBe("arbitrum");
    expect(normalizeNetworkId("arb")).toBe("arbitrum");
    expect(normalizeNetworkId("base-sepolia")).toBeNull();
  });

  it("requires the exact chain for the selected network", () => {
    expect(resolveNetworkRequest("base", 8453)).toBe(NETWORKS.base);
    expect(resolveNetworkRequest("arc", 5_042_002)).toBe(NETWORKS.arc);
    expect(resolveNetworkRequest("arbitrum", 42_161)).toBe(NETWORKS.arbitrum);

    expect(() => resolveNetworkRequest("base", 5_042_002)).toThrow(
      NetworkValidationError,
    );
    expect(() => resolveNetworkRequest("arc", 8453)).toThrow(
      NetworkValidationError,
    );
    expect(() => resolveNetworkRequest("arbitrum", 8453)).toThrow(
      NetworkValidationError,
    );
  });

  it("keeps Arbitrum targets and token identities isolated", () => {
    expect(isNetworkTargetAllowed("arbitrum", ARBITRUM_CONTRACTS.uniswapV3SwapRouter, "swap")).toBe(true);
    expect(isNetworkTargetAllowed("base", ARBITRUM_CONTRACTS.uniswapV3SwapRouter, "swap")).toBe(false);
    expect(ARBITRUM_TOKENS.USDC.address).not.toBe(NETWORKS.base.tokens[0]);
    expect(NETWORKS.arbitrum.chainId).toBe(42_161);
    expect(NETWORKS.arbitrum.nativeAsset.symbol).toBe("ETH");
  });

  it("never admits an Arc target through the Base allowlist", () => {
    expect(isNetworkTargetAllowed("arc", ARC_CONTRACTS.Swap, "swap")).toBe(
      true,
    );
    expect(isNetworkTargetAllowed("base", ARC_CONTRACTS.Swap, "swap")).toBe(
      false,
    );
  });

  it("publishes distinct native-asset semantics", () => {
    expect(NETWORKS.base.nativeAsset).toEqual({
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    });
    expect(NETWORKS.arc.nativeAsset).toEqual({
      name: "USDC",
      symbol: "USDC",
      decimals: 18,
    });
  });
});
