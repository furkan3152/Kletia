export type RouteData = { 
  name: string; expectedOutput: string; router: string; calldata: string; 
  primaryTokenAddress?: string; primaryAmountInWei?: string; 
  secondaryTokenAddress?: string; secondaryAmountInWei?: string; 
};

export type WalletAsset = { symbol: string; name?: string; formatted: string; balance?: string; usdValue?: number; usdFormatted?: string; };
export type LSTAsset = { protocol: string; symbol: string; balance: string; formatted: string; tokenAddress: string; usdValue?: number; usdFormatted?: string; };
export type PortfolioData = {
  summary?: { totalNetWorthUSD: string; walletValueUSD: string; defiTokenValueUSD: string; liquidStakingValueUSD: string; };
  wallet?: WalletAsset[];
  defiTokens?: WalletAsset[];
  liquidStaking?: LSTAsset[];
  baseNames?: { tokenId: string; name?: string; index: number }[];
  defiPositions?: {
    aave?: { suppliedCollateralUSD: string; totalDebtUSD: string; availableBorrowPowerUSD: string; healthFactor: string; status: string; };
    moonwell?: { [marketName: string]: { supplied: string; debt: string } };
    compound?: { suppliedUSDC: string; borrowedUSDC: string };
    aerodrome?: { lockId: string; lockedAmount: string; votingPower: string; unlockDate: string };
  };
  recentTransactions?: { hash: string; from: string; to: string; value: string; type: string; timestamp?: string }[];
};

export type IntentResponse = { 
  status: string; message?: string; action?: string; data?: PortfolioData; 
  winner?: string; expectedOutput?: string; targetContract?: string; 
  calldata?: string; tokenInAddress?: string; amountInWei?: string;    
  isNativeIn?: boolean; value?: string; allRoutes?: RouteData[]; actionType?: string; 
};

export type ChatMessage = {
  id: string; role: 'user' | 'kletia'; text: string; isLoading?: boolean;
  intentData?: IntentResponse; terminalLogs?: string[]; txHash?: string; selectedRouteIndex?: number;
  widgetType?: 'copy_trade' | 'yield_optimizer' | 'limit_order' | string;
  widgetData?: any;
};

export type WidgetId = 'portfolio' | 'swap' | 'vault' | 'batch' | 'memo' | 'job' | 'agent' | 'staking' | 'liquidity' | 'lending' | null;
