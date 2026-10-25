/**
 * Portfolio types for Base, Arc and Arbitrum.
 */

export type PortfolioAvailability =
  "available" | "partial" | "unavailable" | "not_configured" | "not_needed";

export type WalletAsset = {
  symbol: string;
  name?: string;
  formatted: string;
  balance?: string;
  address?: string;
  usdValue?: number;
  usdFormatted?: string;
  balanceStatus?: "available" | "unavailable";
  metadataStatus?: "available" | "partial" | "unavailable";
  priceStatus?: "available" | "unavailable";
  priceSource?: string;
};

export type LSTAsset = {
  protocol: string;
  symbol: string;
  balance: string;
  formatted: string;
  tokenAddress: string;
  usdValue?: number;
  usdFormatted?: string;
  balanceStatus?: "available" | "unavailable";
  priceStatus?: "available" | "unavailable";
  priceSource?: string;
};

export type PortfolioSourceReport = {
  source: "base_rpc" | "alchemy" | "dexscreener" | string;
  status: PortfolioAvailability;
  partial: boolean;
  observedAt: string;
  method: string;
  scope?: string;
  reason?: string;
  records?: number;
  failures?: number;
  requested?: number;
  resolved?: number;
};

export type BasePortfolioIntegrity = {
  status: "complete" | "partial" | "unavailable";
  partial: boolean;
  observedAt: string;
  network: "base";
  chainId: number;
  valuation: {
    status: "complete" | "partial" | "unavailable";
    partial: boolean;
    knownPricedValueUSD: string | null;
    pricedAssetCount: number;
    unpricedAssetCount: number;
    unpricedAssets: {
      symbol: string;
      address?: string;
      reason: string;
    }[];
    scope: string;
    isCompleteNetWorth: boolean;
  };
  unavailableSources: string[];
  sources: Record<string, PortfolioSourceReport>;
};

export type BasePortfolioData = {
  network: "base";
  chainId: number;
  summary?: {
    totalNetWorthUSD: string;
    walletValueUSD: string;
    defiTokenValueUSD: string;
    liquidStakingValueUSD: string;
  };
  wallet?: WalletAsset[];
  defiTokens?: WalletAsset[];
  liquidStaking?: LSTAsset[];
  baseNames?: { tokenId: string; name?: string; index: number }[];
  defiPositions?: {
    aave?: {
      suppliedCollateralUSD: string;
      totalDebtUSD: string;
      availableBorrowPowerUSD: string;
      healthFactor: string;
      status: string;
    };
    moonwell?: { [marketName: string]: { supplied: string; debt: string } };
    compound?: {
      [marketName: string]: { supplied: string; debt: string };
    };
    aerodrome?: {
      lockId: string;
      lockedAmount: string;
      votingPower: string;
      unlockDate: string;
    };
  };
  recentTransactions?: {
    hash: string;
    from: string;
    to: string;
    value: string;
    type: string;
    timestamp?: string;
  }[];
  integrity?: BasePortfolioIntegrity;
};

export type ArcPortfolioData = {
  network: "arc";
  chainId: number;
  wallet: {
    symbol: "USDC" | "KLET" | string;
    name: string;
    balance: string;
    formatted: string;
    address?: string;
  }[];
  vault: {
    executionMode: "legacy_v1" | "vault_v2";
    address: string;
    principal: string;
    accruedInterest: string;
    pendingInterest: string;
  };
  legacyVault?: {
    address: string;
    principal: string;
    accruedInterest: string;
    pendingInterest: string;
    migrationRequired: true;
  };
  staking: {
    stakedAmount: string;
    pendingUnstake: string;
    pendingRewards: string;
    cooldownRemaining: number;
  };
  lending: {
    collateralKLET: string;
    borrowedUSDC: string;
    suppliedUSDC: string;
    /** Null while the pool's price source is not answering (the health factor cannot be computed). */
    healthFactor: string | null;
    healthAvailability?: "available" | "unavailable";
  };
  observedAtBlock: string;
};

export type ArbitrumPortfolioData = {
  network: "arbitrum";
  chainId: 42161;
  policyVersion: "kletia_arbitrum_portfolio_v1";
  observedAtBlock: string;
  native: { symbol: "ETH"; balanceAtomic: string; decimals: 18 };
  tokens: Array<{
    symbol: "USDC" | "WETH" | "ARB";
    address: string;
    balanceAtomic: string;
    decimals: 6 | 18;
  }>;
  aave: {
    totalCollateralBase: string;
    totalDebtBase: string;
    availableBorrowsBase: string;
    currentLiquidationThresholdBps: number;
    ltvBps: number;
    healthFactor: string | null;
  };
  mockData: false;
};

export type PortfolioData = BasePortfolioData | ArcPortfolioData | ArbitrumPortfolioData;
