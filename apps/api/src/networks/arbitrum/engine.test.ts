import { describe, expect, it } from "vitest";
import { calculateSafeBorrowCapacity } from "./engine.js";

describe("Arbitrum Aave risk-adjusted borrow capacity", () => {
  const baseInput = {
    totalCollateralBase: 100n * 10n ** 8n,
    totalDebtBase: 20n * 10n ** 8n,
    availableBorrowsBase: 80n * 10n ** 8n,
    liquidationThresholdBps: 8_000n,
    assetPriceBase: 1n * 10n ** 8n,
    assetDecimals: 6,
    availableLiquidityAtomic: 100n * 10n ** 6n,
    targetHealthFactorScaled: 160n * 10n ** 16n,
  } as const;

  it("uses the stricter target-health-factor capacity instead of Aave's protocol maximum", () => {
    const result = calculateSafeBorrowCapacity(baseInput);
    expect(result.safeAdditionalBase).toBe(30n * 10n ** 8n);
    expect(result.safeAmountAtomic).toBe(30n * 10n ** 6n);
  });

  it("caps the read-only answer to live reserve liquidity", () => {
    const result = calculateSafeBorrowCapacity({
      ...baseInput,
      availableLiquidityAtomic: 12n * 10n ** 6n,
    });
    expect(result.safeAmountAtomic).toBe(12n * 10n ** 6n);
  });

  it("fails closed for a target below Kletia's hard 1.5 health-factor floor", () => {
    const result = calculateSafeBorrowCapacity({
      ...baseInput,
      targetHealthFactorScaled: 149n * 10n ** 16n,
    });
    expect(result).toEqual({ safeAdditionalBase: 0n, safeAmountAtomic: 0n });
  });
});
