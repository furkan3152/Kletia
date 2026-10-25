/**
 * Base x402, swap, yield, fee-router and liquidity evidence types.
 */

export type BaseX402Service = {
  resource: string;
  description: string;
  curated: boolean;
  lastUpdated: string;
  method?: "GET" | "POST";
  requestUrl?: string;
  scheme: "exact";
  network: "eip155:8453";
  asset: string;
  payTo: string;
  amountAtomic: string;
  amount: string;
  maxTimeoutSeconds?: number;
  skillUrl?: string;
};

export type BaseX402Search = {
  query: string;
  curatedOnly: boolean;
  maxPayment: string;
  maxPaymentAtomic: string;
  network: "eip155:8453";
  asset: string;
  partialResults: boolean;
  method: "hybrid" | "vector" | "text";
};

export type BaseMcpX402Plan = {
  version: 1;
  network: "base";
  chainId: 8_453;
  requestId: string;
  initiate: {
    tool: "initiate_x402_request";
    url: string;
    method: "GET" | "POST";
    maxPayment: string;
    body?: Record<string, unknown>;
    headers: Record<string, string>;
  };
  complete: {
    tool: "complete_x402_request";
    requestIdFrom: "initiate_x402_request.requestId";
  };
};

export type BaseX402ChallengeEvidence = {
  policyVersion: "kletia_x402_challenge_v1";
  status: "verified";
  method: "GET";
  sourceRequestUrl: string;
  requestUrl: string;
  resourceUrl: string;
  network: "eip155:8453";
  chainId: 8_453;
  scheme: "exact";
  asset: string;
  payTo: string;
  amountAtomic: string;
  amount: string;
  maxPayment: string;
  maxTimeoutSeconds?: number;
  requiredParams: string[];
  walletInputBinding?: {
    parameter: "address" | "wallet";
    value: string;
    source: "active_user_address";
  };
  observedAt: string;
};

export type BaseSwapQuoteCoverage = {
  requestedSourceCount: number;
  responsiveSourceCount: number;
  sourceWithRoutesCount: number;
  unavailableSourceCount: number;
  totalQuotedRouteCount: number;
  totalAttemptedQuoteCount: number;
  totalSuccessfulQuoteReadCount: number;
  sources: {
    source: string;
    status: "quoted" | "empty" | "unavailable";
    quotedRouteCount: number;
    attemptedQuoteCount: number;
    successfulQuoteReadCount: number;
  }[];
};

export type BaseSwapRankingEvidence = {
  policyVersion:
    | "base_quoted_output_v1"
    | "base_route_efficiency_v2"
    | "base_intent_v2_net_floor_v1";
  stage:
    | "protocol_quotes_after_simulation_before_fee_wrapper"
    | "final_routes_after_fee_router_allowlist_and_simulation"
    | "final_routes_after_intent_v2_runtime_and_simulation";
  primaryMetric:
    | "quoted_amount_out"
    | "simulation_evidence_then_quoted_amount_out"
    | "guaranteed_net_minimum_amount_out";
  direction: "descending";
  eligibleRouteCount: number;
  simulationPassedCount: number;
  deferredUntilApprovalCount: number;
  gasCostNormalized: false;
  gasEstimateTieBreaker?: true;
  executionLatencyNormalized: false;
  limitation: string;
};

export type BaseYieldEconomics = {
  observedAt: string;
  rateKind: "supply_rate" | "variable_borrow_rate" | "position";
  rateBps: number | null;
  availableLiquidityAtomic: string | null;
  positionAtomic: string | null;
  debtAtomic: string | null;
  estimateStatus: "complete" | "partial";
  limitation: string;
};

export type BaseIntentRouterV2SwapEconomics = {
  quotedGrossAmountOut: string;
  grossMinimumAfterSlippage: string;
  estimatedFeeAtObservedRate: string;
  maximumFeeAtSignedCap: string;
  netMinimumAmountOut: string;
  userMinimumNetAmountOut: string | null;
  bindingMinimumSource: "slippage_and_fee_cap" | "user_minimum";
  observedFeeBps: number;
  maxFeeBps: number;
  slippageBps: number;
};

export type BaseYieldRankingEvidence = {
  policyVersion: "base_yield_efficiency_v1";
  action: "lend" | "borrow" | "repay" | "withdraw";
  riskTolerance: "conservative" | "balanced" | "aggressive";
  primaryMetric: "supply_rate_bps" | "borrow_rate_bps" | "position";
  direction: "ascending" | "descending";
  gasCostNormalized: false;
  quoteBlockConsistency: "best_effort_live_reads";
  limitation: string;
  eligibleRouteCount: number;
  rankedRoutes: {
    rank: number;
    protocolId: string;
    name: string;
    riskTier: "core" | "established" | "elevated";
    rateBps: number | null;
    availableLiquidityAtomic: string | null;
    positionAtomic: string | null;
    debtAtomic: string | null;
  }[];
};

export type BaseFeeRouterCoverage = {
  requestedRouteCount: number;
  compatibleRouteCount: number;
  approvedRouteCount: number;
  unapprovedTargetCount: number;
  unapprovedTargets: string[];
  simulatedRouteCount: number;
  eligibleRouteCount: number;
};

export type BaseLiquidityPoolEvidence = {
  pool: string;
  factory: string;
  stable: boolean;
  reserveAAtomic: string;
  reserveBAtomic: string;
  observedAt: string;
  observedBlock: string;
  discoveryAttemptCount: number;
  unavailableSourceCount: number;
  absentPoolCount: number;
  ratioSource: "factory_bound_pool_reserves";
  limitation: string;
  amountAAtomic?: string;
  amountBAtomic?: string;
  secondaryAmountCapAtomic?: string;
  secondaryAmountPolicy?: "live_reserve_ratio" | "user_maximum_input_cap";
  totalSupplyAtomic?: string;
  lpBalanceAtomic?: string;
  lpDecimals?: number;
  amountLpAtomic?: string;
  expectedAAtomic?: string;
  expectedBAtomic?: string;
};

export type BaseLiquidityRoutingEvidence = {
  policyVersion: "base_liquidity_reserves_v1";
  action: "add_liquidity" | "remove_liquidity";
  primaryMetric: "same_token_reserve_a_depth" | "position_not_comparable";
  direction: "descending" | "not_applicable";
  selectionPolicy:
    "automatic_reserve_depth_ranking" | "explicit_wallet_position_selection";
  candidateRouteCount: number;
  simulatedRouteCount: number;
  eligibleRouteCount: number;
  yieldProjectionAvailable: false;
  impermanentLossProjectionAvailable: false;
  limitation: string;
  rankedRoutes: {
    rank: number;
    protocolId: string;
    name: string;
    router: string;
    pool: string;
    factory: string;
    stable: boolean;
    reserveAAtomic: string;
    reserveBAtomic: string;
    simulationStatus: "passed" | "deferred_until_approval";
  }[];
};

export type BaseLendingOpportunity = {
  protocolId:
    | "aave-v3"
    | "moonwell"
    | "compound-v3"
    | "moonwell-vault"
    | "seamless-vault"
    | "spark-vault"
    | "fluid-vault";
  name: string;
  assetSymbol: string;
  target: string;
  riskTier: "core" | "established" | "elevated";
  supplyRateBps: number | null;
  borrowRateBps: number | null;
  availableLiquidityAtomic: string | null;
  observedAt: string;
  executionReady: true;
  executionMode: "direct";
  borrowingEnabled: boolean;
};

export type BaseYieldComparisonCoverage = {
  registeredProtocolCount: number;
  responsiveProtocolCount: number;
  eligibleProtocolCount: number;
};
