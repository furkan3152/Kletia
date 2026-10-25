/**
 * Runtime guards for portfolio payloads.
 */
import type {
  ArbitrumPortfolioData,
  ArcPortfolioData,
  BasePortfolioData,
} from "./portfolio.ts";
import {
  hasStringFields,
  isCanonicalAddress,
  isObjectRecord,
  isStringOrNull,
  isWalletAsset,
  UNSIGNED_INTEGER,
} from "./guardPrimitives.ts";

export const isBasePortfolioData = (
  value: unknown,
): value is BasePortfolioData =>
  isObjectRecord(value) &&
  value.network === "base" &&
  value.chainId === 8_453 &&
  hasStringFields(value.summary, [
    "totalNetWorthUSD",
    "walletValueUSD",
    "defiTokenValueUSD",
    "liquidStakingValueUSD",
  ]) &&
  Array.isArray(value.wallet) &&
  value.wallet.every(isWalletAsset) &&
  Array.isArray(value.defiTokens) &&
  value.defiTokens.every(isWalletAsset) &&
  Array.isArray(value.liquidStaking) &&
  value.liquidStaking.every((asset) =>
    hasStringFields(asset, [
      "protocol",
      "symbol",
      "balance",
      "formatted",
      "tokenAddress",
    ]),
  ) &&
  isObjectRecord(value.integrity) &&
  value.integrity.network === "base" &&
  value.integrity.chainId === 8_453 &&
  (value.integrity.status === "complete" ||
    value.integrity.status === "partial" ||
    value.integrity.status === "unavailable") &&
  isObjectRecord(value.integrity.valuation) &&
  (value.integrity.valuation.status === "complete" ||
    value.integrity.valuation.status === "partial" ||
    value.integrity.valuation.status === "unavailable") &&
  Array.isArray(value.integrity.unavailableSources) &&
  isObjectRecord(value.integrity.sources);

export const isArcPortfolioData = (value: unknown): value is ArcPortfolioData =>
  isObjectRecord(value) &&
  value.network === "arc" &&
  value.chainId === 5_042_002 &&
  Array.isArray(value.wallet) &&
  value.wallet.every((asset) =>
    hasStringFields(asset, ["symbol", "name", "balance", "formatted"]),
  ) &&
  hasStringFields(value.vault, [
    "executionMode",
    "address",
    "principal",
    "accruedInterest",
    "pendingInterest",
  ]) &&
  (value.vault.executionMode === "legacy_v1" ||
    value.vault.executionMode === "vault_v2") &&
  isCanonicalAddress(value.vault.address) &&
  (value.legacyVault === undefined ||
    (isObjectRecord(value.legacyVault) &&
      value.legacyVault.migrationRequired === true &&
      hasStringFields(value.legacyVault, [
        "address",
        "principal",
        "accruedInterest",
        "pendingInterest",
      ]) &&
      isCanonicalAddress(value.legacyVault.address))) &&
  hasStringFields(value.staking, [
    "stakedAmount",
    "pendingUnstake",
    "pendingRewards",
  ]) &&
  typeof value.staking.cooldownRemaining === "number" &&
  hasStringFields(value.lending, [
    "collateralKLET",
    "borrowedUSDC",
    "suppliedUSDC",
  ]) &&
  // During an oracle outage the API still answers, with healthFactor null.
  isStringOrNull(value.lending.healthFactor) &&
  (value.lending.healthAvailability === undefined ||
    value.lending.healthAvailability === "available" ||
    value.lending.healthAvailability === "unavailable") &&
  typeof value.observedAtBlock === "string" &&
  UNSIGNED_INTEGER.test(value.observedAtBlock);

export const isArbitrumPortfolioData = (
  value: unknown,
): value is ArbitrumPortfolioData =>
  isObjectRecord(value) &&
  value.network === "arbitrum" &&
  value.chainId === 42_161 &&
  value.policyVersion === "kletia_arbitrum_portfolio_v1" &&
  typeof value.observedAtBlock === "string" &&
  UNSIGNED_INTEGER.test(value.observedAtBlock) &&
  isObjectRecord(value.native) &&
  value.native.symbol === "ETH" &&
  value.native.decimals === 18 &&
  typeof value.native.balanceAtomic === "string" &&
  UNSIGNED_INTEGER.test(value.native.balanceAtomic) &&
  Array.isArray(value.tokens) &&
  value.tokens.length === 3 &&
  value.tokens.every(
    (token) =>
      isObjectRecord(token) &&
      (token.symbol === "USDC" || token.symbol === "WETH" || token.symbol === "ARB") &&
      isCanonicalAddress(token.address) &&
      (token.decimals === 6 || token.decimals === 18) &&
      typeof token.balanceAtomic === "string" &&
      UNSIGNED_INTEGER.test(token.balanceAtomic),
  ) &&
  isObjectRecord(value.aave) &&
  hasStringFields(value.aave, [
    "totalCollateralBase",
    "totalDebtBase",
    "availableBorrowsBase",
  ]) &&
  typeof value.aave.currentLiquidationThresholdBps === "number" &&
  typeof value.aave.ltvBps === "number" &&
  (value.aave.healthFactor === null || typeof value.aave.healthFactor === "string") &&
  value.mockData === false;
