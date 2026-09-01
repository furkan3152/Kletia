const HEALTH_FACTOR_SCALE = 10n ** 18n;

export interface SafeBorrowCapacityInput {
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly availableBorrowsBase: bigint;
  readonly liquidationThresholdBps: bigint;
  readonly assetPriceBase: bigint;
  readonly assetDecimals: number;
  readonly availableLiquidityAtomic: bigint;
  readonly targetHealthFactorScaled: bigint;
}

export function calculateSafeBorrowCapacity(
  input: SafeBorrowCapacityInput,
): {
  readonly safeAdditionalBase: bigint;
  readonly safeAmountAtomic: bigint;
} {
  if (
    input.totalCollateralBase <= 0n ||
    input.liquidationThresholdBps <= 0n ||
    input.assetPriceBase <= 0n ||
    input.targetHealthFactorScaled < 150n * 10n ** 16n ||
    !Number.isInteger(input.assetDecimals) ||
    input.assetDecimals < 0 ||
    input.assetDecimals > 36
  ) {
    return { safeAdditionalBase: 0n, safeAmountAtomic: 0n };
  }
  const liquidationAdjustedCollateral =
    (input.totalCollateralBase * input.liquidationThresholdBps) / 10_000n;
  const maximumDebtAtTarget =
    (liquidationAdjustedCollateral * HEALTH_FACTOR_SCALE) /
    input.targetHealthFactorScaled;
  const targetAdditionalBase = maximumDebtAtTarget > input.totalDebtBase
    ? maximumDebtAtTarget - input.totalDebtBase
    : 0n;
  const safeAdditionalBase = targetAdditionalBase < input.availableBorrowsBase
    ? targetAdditionalBase
    : input.availableBorrowsBase;
  const rawAmount =
    (safeAdditionalBase * 10n ** BigInt(input.assetDecimals)) /
    input.assetPriceBase;
  return {
    safeAdditionalBase,
    safeAmountAtomic: rawAmount < input.availableLiquidityAtomic
      ? rawAmount
      : input.availableLiquidityAtomic,
  };
}
