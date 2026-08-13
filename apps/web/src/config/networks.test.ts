import { describe, expect, it } from "vitest";

import {
  NETWORKS,
  getNetworkByChainId,
} from "./networks";
import { ARC_CONTRACTS } from "../networks/arc/config";

describe("network execution profiles", () => {
  it("keeps Base Mainnet production-only and free of Arc targets", () => {
    expect(NETWORKS.base.chainId).toBe(8_453);
    expect(NETWORKS.base.isTestnet).toBe(false);
    expect(NETWORKS.base.nativeCurrency.symbol).toBe("ETH");
    expect(NETWORKS.base.tokens.usdc.decimals).toBe(6);
    expect(NETWORKS.base.features.arcContracts).toBe(false);
    expect(Object.values(NETWORKS.base.contracts)).not.toContain(
      ARC_CONTRACTS.Swap,
    );
  });

  it("keeps Arc Testnet native-USDC semantics and Arc-only targets", () => {
    expect(NETWORKS.arc.chainId).toBe(5_042_002);
    expect(NETWORKS.arc.isTestnet).toBe(true);
    expect(NETWORKS.arc.nativeCurrency.symbol).toBe("USDC");
    expect(NETWORKS.arc.nativeCurrency.decimals).toBe(18);
    expect(NETWORKS.arc.tokens.usdc.decimals).toBe(6);
    expect(NETWORKS.arc.tokens.usdc.isNative).toBe(true);
    expect(NETWORKS.arc.features.x402).toBe(false);
    expect(NETWORKS.arc.contracts.Swap).toBe(ARC_CONTRACTS.Swap);
  });

  it("resolves only the two explicitly supported chain identities", () => {
    expect(getNetworkByChainId(8_453)?.key).toBe("base");
    expect(getNetworkByChainId(5_042_002)?.key).toBe("arc");
    expect(getNetworkByChainId(84_532)).toBeUndefined();
  });
});
