import type { NetworkMode } from "./config/networks";
import { getAddress, isAddress, parseUnits } from "viem";
import { isBaseIntentRouterV2SwapBinding } from "../networks/base/security/intentV2Route";

export { isBaseIntentRouterV2SwapBinding };

export type RouteApproval = {
  token: string;
  spender: string;
  amount: string;
  symbol?: string;
  calldata?: string;
  required?: true;
};

export type RouteExecutionMode =
  | "direct"
  | "kletia_fee_router"
  | "kletia_intent_router_v2"
  | "kletia_launch_factory_v2";

export type BaseLaunchFactoryV2Evidence = {
  policyVersion: "kletia_launch_factory_v2_v1";
  factory: string;
  userSalt: string;
  saltSource: "explicit_launch_id" | "canonical_parameters";
  launchId: string | null;
  name: string;
  symbol: string;
  totalSupply: string;
  recipient: string;
  maxDeploymentFee: string;
  deploymentFee: string;
  value: string;
  predictedAddress: string;
  observedAtBlock: string;
  factoryCodehash: string;
  ownerAuthority: string;
  ownerAuthorityKind: "timelock" | "safe_2_of_2";
  treasurySafe: string;
  pendingTreasury: string;
  factoryFeeCap: string;
  simulationStatus: "passed";
  supplyPolicy: "fixed_full_supply_to_recipient";
  saltPolicy: "creator_scoped_create2";
};

export type BaseIntentRouterV2AdapterKind =
  "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";

export type BaseIntentRouterV2AdapterDataEncoding =
  "abi_address_array_v1" | "uniswap_v3_packed_path_v1";

export type BaseIntentRouterV2SwapIntent = {
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
  adapter: string;
  adapterConfigHash: string;
  adapterDataHash: string;
  nonce: string;
  issuedAt: string;
  validAfter: string;
  deadline: string;
  executor: string;
  maxFeeBps: number;
};

export type BaseIntentRouterV2ConfigEvidence = {
  schemaVersion:
    | "kletia_base_intent_v2_deployment_v1"
    | "kletia_base_intent_v2_deployment_v2";
  adapterKind: BaseIntentRouterV2AdapterKind;
  observedAtBlock: string;
  routerCodehash: string;
  wrappedNativeCodehash: string;
  adapterConfigHash: string;
  adapterConfigurationHash: string;
};

export type BaseIntentRouterV2Coverage = {
  policyVersion:
    | "kletia_base_intent_v2_typed_adapter_v1"
    | "kletia_base_intent_v2_typed_adapter_v2";
  runtimeValidationStatus: "validated";
  observedAtBlock: string;
  quotedRouteCount: number;
  typedAdapterMatchedRouteCount: number;
  compiledRouteCount: number;
  simulatedRouteCount: number;
  eligibleRouteCount: number;
  unsupportedQuoteCount: number;
  sharedExclusiveNonce: string;
  rankingMetric: "simulation_then_guaranteed_net_minimum";
  noLegacyFallback: true;
};

export type ArcOfficialPolicyEvidence = {
  network: "arc-testnet";
  chainId: 5_042_002;
  source: "https://docs.arc.io/arc/references/contract-addresses";
  executionAccount: string;
  accountPolicy: "EOA_ONLY";
  requiresRuntimeEoaCodeCheck: true;
  valuePolicy: "ZERO_ONLY";
  asset: string;
  assetDecimals: 6;
  totalAtomic: string;
  maxTotalAtomic: string;
  atomicity: "SINGLE_CALL" | "ALL_OR_NOTHING";
  nestedCalls: {
    target: string;
    selector: string;
    allowFailure: false;
  }[];
  memo?: {
    id: string;
    requestId: string;
    reference: string;
    policy: "PUBLIC_OPAQUE_ASCII_REFERENCE";
    visibility: "PUBLIC_ONCHAIN";
    piiProtection: "FORMAT_ONLY_USER_MUST_EXCLUDE_PII";
    maxBytes: 64;
  };
};

export type RouteData = {
  name: string;
  action?: string;
  protocolId?: string;
  expectedOutput: string;
  router: string;
  calldata: string;
  value: string;
  routePath?: string;
  network: NetworkMode;
  chainId: number;
  approvals?: RouteApproval[];
  approvalPolicy?: "explicit" | "legacy_inferred";
  primaryTokenAddress?: string;
  primaryAmountInWei?: string;
  secondaryTokenAddress?: string;
  secondaryAmountInWei?: string;
  requestId: string;
  userAddress: string;
  quoteExpiresAt: number | string;
  policyEvidence?: ArcOfficialPolicyEvidence;
  executionMode?: RouteExecutionMode;
  callerSemantics?:
    "explicit_recipient" | "on_behalf_of" | "msg_sender_owns_position";
  feeRouterCompatible?: boolean;
  simulationReturnPolicy?: "uint256_zero";
  simulationStatus?: "passed" | "deferred_until_approval";
  yieldComparison?: {
    policyVersion: "arbitrum_aave_v3_live_rates_v1";
    protocolId: "aave-v3";
    asset: string;
    supplyApyBps: number;
    variableBorrowApyBps: number;
    availableLiquidityAtomic: string;
    observedAt: string;
    mockData: false;
  };
  quoteSource?: string;
  policyTargets?: string[];
  targetContract?: string;
  adapter?: string;
  adapterKind?: BaseIntentRouterV2AdapterKind;
  adapterDataEncoding?: BaseIntentRouterV2AdapterDataEncoding;
  underlyingTarget?: string;
  underlyingSpender?: string;
  underlyingFactory?: string;
  wrappedNative?: string;
  adapterData?: string;
  intent?: BaseIntentRouterV2SwapIntent;
  configEvidence?: BaseIntentRouterV2ConfigEvidence;
  riskTier?: "core" | "established" | "elevated";
  riskDisclosure?: string;
  economics?: BaseYieldEconomics | BaseIntentRouterV2SwapEconomics;
  poolEvidence?: BaseLiquidityPoolEvidence;
  launchFactoryV2Evidence?: BaseLaunchFactoryV2Evidence;
};

export type ArcAppKitToken = "USDC" | "EURC" | "cirBTC";

export type ArcAppKitExecutionPlan =
  | {
      version: 1;
      environment: "testnet";
      operation: "swap";
      sourceChain: "Arc_Testnet";
      amount: string;
      tokenIn: ArcAppKitToken;
      tokenOut: ArcAppKitToken;
      slippageBps: number;
      minimumOutput?: string;
      traceId: string;
    }
  | {
      version: 1;
      environment: "testnet";
      operation: "send";
      sourceChain: "Arc_Testnet";
      amount: string;
      token: Exclude<ArcAppKitToken, "cirBTC">;
      recipient: string;
      traceId: string;
    }
  | {
      version: 1;
      environment: "testnet";
      operation: "bridge";
      sourceChain: "Arc_Testnet";
      destinationChain:
        | "Arbitrum_Sepolia"
        | "Avalanche_Fuji"
        | "Base_Sepolia"
        | "Ethereum_Sepolia"
        | "Optimism_Sepolia";
      amount: string;
      token: "USDC";
      recipient: string;
      transferSpeed: "FAST" | "SLOW";
      maxFee?: string;
      useForwarder: true;
      traceId: string;
    };

export type ArcAppKitRouteProof = {
  environment: "testnet";
  sourceNetwork: "arc";
  sourceChainId: 5_042_002;
  provider: "Circle App Kit";
  requiresLiveEstimate: true;
  requiresExplicitWalletApproval: true;
  forwardsDestinationMint: boolean;
};

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
    healthFactor: string;
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

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasStringFields = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, string> =>
  isObjectRecord(value) &&
  fields.every((field) => typeof value[field] === "string");

const isWalletAsset = (value: unknown): boolean =>
  hasStringFields(value, ["symbol", "formatted"]);

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_USDC = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;

const isCanonicalAddress = (value: unknown): value is string => {
  if (typeof value !== "string" || !isAddress(value)) return false;
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
};

const isBaseUsdcAddress = (value: unknown): value is string =>
  isCanonicalAddress(value) &&
  getAddress(value) === getAddress(BASE_MAINNET_USDC);

const isPublicHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      Boolean(hostname) &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) &&
      !hostname.includes(":")
    );
  } catch {
    return false;
  }
};

const isPreparedResourceUrl = (
  resource: string,
  requestUrl: unknown,
): requestUrl is string => {
  if (requestUrl === undefined) return true;
  if (!isPublicHttpsUrl(requestUrl)) return false;
  try {
    const catalog = new URL(resource);
    const prepared = new URL(requestUrl);
    return (
      prepared.origin === catalog.origin &&
      prepared.pathname === catalog.pathname &&
      prepared.hash === ""
    );
  } catch {
    return false;
  }
};

const isExactUsdcPair = (
  amount: unknown,
  amountAtomic: unknown,
): amount is string => {
  if (
    typeof amount !== "string" ||
    typeof amountAtomic !== "string" ||
    !POSITIVE_USDC.test(amount) ||
    !UNSIGNED_INTEGER.test(amountAtomic)
  ) {
    return false;
  }
  try {
    return (
      parseUnits(amount, 6) > 0n &&
      parseUnits(amount, 6).toString() === amountAtomic
    );
  } catch {
    return false;
  }
};

export const isBaseX402Service = (value: unknown): value is BaseX402Service => {
  if (
    !isObjectRecord(value) ||
    !isPublicHttpsUrl(value.resource) ||
    typeof value.description !== "string" ||
    value.description.length > 280 ||
    typeof value.curated !== "boolean" ||
    typeof value.lastUpdated !== "string" ||
    !Number.isFinite(Date.parse(value.lastUpdated)) ||
    (value.method !== undefined &&
      value.method !== "GET" &&
      value.method !== "POST") ||
    !isPreparedResourceUrl(value.resource, value.requestUrl) ||
    value.scheme !== "exact" ||
    value.network !== "eip155:8453" ||
    !isBaseUsdcAddress(value.asset) ||
    !isCanonicalAddress(value.payTo) ||
    !isExactUsdcPair(value.amount, value.amountAtomic)
  ) {
    return false;
  }
  if (
    value.maxTimeoutSeconds !== undefined &&
    (typeof value.maxTimeoutSeconds !== "number" ||
      !Number.isInteger(value.maxTimeoutSeconds) ||
      value.maxTimeoutSeconds <= 0 ||
      value.maxTimeoutSeconds > 300)
  ) {
    return false;
  }
  return value.skillUrl === undefined || isPublicHttpsUrl(value.skillUrl);
};

export const isBaseX402Search = (value: unknown): value is BaseX402Search =>
  isObjectRecord(value) &&
  typeof value.query === "string" &&
  value.query.length >= 2 &&
  value.query.length <= 120 &&
  typeof value.curatedOnly === "boolean" &&
  isExactUsdcPair(value.maxPayment, value.maxPaymentAtomic) &&
  value.network === "eip155:8453" &&
  isBaseUsdcAddress(value.asset) &&
  typeof value.partialResults === "boolean" &&
  (value.method === "hybrid" ||
    value.method === "vector" ||
    value.method === "text");

export const isBaseMcpX402Plan = (value: unknown): value is BaseMcpX402Plan => {
  if (
    !isObjectRecord(value) ||
    value.version !== 1 ||
    value.network !== "base" ||
    value.chainId !== 8_453 ||
    typeof value.requestId !== "string" ||
    !UUID_V4.test(value.requestId) ||
    !isObjectRecord(value.initiate) ||
    value.initiate.tool !== "initiate_x402_request" ||
    !isPublicHttpsUrl(value.initiate.url) ||
    (value.initiate.method !== "GET" && value.initiate.method !== "POST") ||
    typeof value.initiate.maxPayment !== "string" ||
    !POSITIVE_USDC.test(value.initiate.maxPayment) ||
    parseUnits(value.initiate.maxPayment, 6) <= 0n ||
    !isObjectRecord(value.initiate.headers) ||
    !Object.values(value.initiate.headers).every(
      (header) => typeof header === "string" && header.length <= 200,
    ) ||
    !isObjectRecord(value.complete) ||
    value.complete.tool !== "complete_x402_request" ||
    value.complete.requestIdFrom !== "initiate_x402_request.requestId"
  ) {
    return false;
  }
  const headers = value.initiate.headers;
  const headerNames = Object.keys(headers).sort().join(",");
  if (
    headers.Accept !== "application/json" ||
    (value.initiate.method === "GET"
      ? headerNames !== "Accept" || value.initiate.body !== undefined
      : headerNames !== "Accept,Content-Type" ||
        headers["Content-Type"] !== "application/json" ||
        !isObjectRecord(value.initiate.body))
  ) {
    return false;
  }
  return (
    value.initiate.body === undefined ||
    new TextEncoder().encode(JSON.stringify(value.initiate.body)).byteLength <=
      4_096
  );
};

export const isBaseX402ChallengeEvidence = (
  value: unknown,
  plan?: BaseMcpX402Plan,
  expectedUserAddress?: string,
): value is BaseX402ChallengeEvidence => {
  if (
    !isObjectRecord(value) ||
    value.policyVersion !== "kletia_x402_challenge_v1" ||
    value.status !== "verified" ||
    value.method !== "GET" ||
    !isPublicHttpsUrl(value.sourceRequestUrl) ||
    !isPublicHttpsUrl(value.requestUrl) ||
    !isPublicHttpsUrl(value.resourceUrl) ||
    value.network !== "eip155:8453" ||
    value.chainId !== 8_453 ||
    value.scheme !== "exact" ||
    !isBaseUsdcAddress(value.asset) ||
    !isCanonicalAddress(value.payTo) ||
    value.payTo === "0x0000000000000000000000000000000000000000" ||
    !isExactUsdcPair(value.amount, value.amountAtomic) ||
    typeof value.maxPayment !== "string" ||
    !POSITIVE_USDC.test(value.maxPayment) ||
    !Array.isArray(value.requiredParams) ||
    value.requiredParams.length > 20 ||
    !value.requiredParams.every(
      (parameter) =>
        typeof parameter === "string" &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(parameter),
    ) ||
    new Set(value.requiredParams).size !== value.requiredParams.length ||
    typeof value.observedAt !== "string"
  ) {
    return false;
  }

  try {
    if (
      parseUnits(value.amount, 6) > parseUnits(value.maxPayment, 6) ||
      parseUnits(value.maxPayment, 6) <= 0n
    ) {
      return false;
    }
    const observedAt = Date.parse(value.observedAt);
    const now = Date.now();
    if (
      !Number.isFinite(observedAt) ||
      observedAt > now + 60_000 ||
      observedAt < now - 10 * 60_000
    ) {
      return false;
    }
    const maxTimeoutSeconds = value.maxTimeoutSeconds;
    if (
      maxTimeoutSeconds !== undefined &&
      (typeof maxTimeoutSeconds !== "number" ||
        !Number.isSafeInteger(maxTimeoutSeconds) ||
        maxTimeoutSeconds < 1 ||
        maxTimeoutSeconds > 300)
    ) {
      return false;
    }

    const sourceUrl = new URL(value.sourceRequestUrl);
    const requestUrl = new URL(value.requestUrl);
    const resourceUrl = new URL(value.resourceUrl);
    if (
      sourceUrl.hash ||
      requestUrl.hash ||
      resourceUrl.hash ||
      sourceUrl.origin !== requestUrl.origin ||
      sourceUrl.pathname !== requestUrl.pathname ||
      requestUrl.origin !== resourceUrl.origin ||
      requestUrl.pathname !== resourceUrl.pathname ||
      (resourceUrl.search && resourceUrl.search !== requestUrl.search) ||
      value.requiredParams.some(
        (parameter) => !requestUrl.searchParams.get(parameter)?.trim(),
      )
    ) {
      return false;
    }

    if (value.walletInputBinding !== undefined) {
      if (
        !isObjectRecord(value.walletInputBinding) ||
        (value.walletInputBinding.parameter !== "address" &&
          value.walletInputBinding.parameter !== "wallet") ||
        value.walletInputBinding.source !== "active_user_address" ||
        !isCanonicalAddress(value.walletInputBinding.value) ||
        !expectedUserAddress ||
        !isAddress(expectedUserAddress) ||
        getAddress(value.walletInputBinding.value) !==
          getAddress(expectedUserAddress) ||
        sourceUrl.searchParams.has(value.walletInputBinding.parameter) ||
        !value.requiredParams.includes(value.walletInputBinding.parameter)
      ) {
        return false;
      }
      const expectedRequestUrl = new URL(sourceUrl);
      expectedRequestUrl.searchParams.set(
        value.walletInputBinding.parameter,
        value.walletInputBinding.value,
      );
      if (expectedRequestUrl.toString() !== requestUrl.toString()) {
        return false;
      }
    } else if (sourceUrl.toString() !== requestUrl.toString()) {
      return false;
    }

    if (
      plan &&
      (plan.network !== "base" ||
        plan.chainId !== 8_453 ||
        plan.initiate.method !== "GET" ||
        plan.initiate.url !== value.requestUrl ||
        plan.initiate.maxPayment !== value.maxPayment)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveAtomicString = (value: unknown): value is string =>
  typeof value === "string" &&
  UNSIGNED_INTEGER.test(value) &&
  BigInt(value) > 0n;

const isBaseLiquidityPoolEvidence = (
  value: unknown,
  action: "add_liquidity" | "remove_liquidity",
): value is BaseLiquidityPoolEvidence => {
  if (
    !isObjectRecord(value) ||
    !isCanonicalAddress(value.pool) ||
    !isCanonicalAddress(value.factory) ||
    typeof value.stable !== "boolean" ||
    !isPositiveAtomicString(value.reserveAAtomic) ||
    !isPositiveAtomicString(value.reserveBAtomic) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !isPositiveAtomicString(value.observedBlock) ||
    !isNonNegativeInteger(value.discoveryAttemptCount) ||
    value.discoveryAttemptCount === 0 ||
    value.discoveryAttemptCount > 32 ||
    !isNonNegativeInteger(value.unavailableSourceCount) ||
    !isNonNegativeInteger(value.absentPoolCount) ||
    value.unavailableSourceCount + value.absentPoolCount >=
      value.discoveryAttemptCount ||
    value.ratioSource !== "factory_bound_pool_reserves" ||
    typeof value.limitation !== "string" ||
    value.limitation.length === 0 ||
    value.limitation.length > 800
  ) {
    return false;
  }

  if (action === "add_liquidity") {
    return (
      isPositiveAtomicString(value.amountAAtomic) &&
      isPositiveAtomicString(value.amountBAtomic) &&
      (value.secondaryAmountPolicy === "live_reserve_ratio"
        ? value.secondaryAmountCapAtomic === undefined
        : value.secondaryAmountPolicy === "user_maximum_input_cap" &&
          isPositiveAtomicString(value.secondaryAmountCapAtomic) &&
          BigInt(value.amountBAtomic) <= BigInt(value.secondaryAmountCapAtomic))
    );
  }
  return (
    isPositiveAtomicString(value.totalSupplyAtomic) &&
    isPositiveAtomicString(value.lpBalanceAtomic) &&
    typeof value.lpDecimals === "number" &&
    Number.isSafeInteger(value.lpDecimals) &&
    value.lpDecimals >= 0 &&
    value.lpDecimals <= 36 &&
    isPositiveAtomicString(value.amountLpAtomic) &&
    BigInt(value.amountLpAtomic) <= BigInt(value.lpBalanceAtomic) &&
    isPositiveAtomicString(value.expectedAAtomic) &&
    isPositiveAtomicString(value.expectedBAtomic)
  );
};

export const isBaseLiquidityRoutingResponse = (
  value: unknown,
): value is IntentResponse & {
  actionType: "add_liquidity" | "remove_liquidity";
  allRoutes: RouteData[];
  liquidityRoutingEvidence: BaseLiquidityRoutingEvidence;
} => {
  if (!isObjectRecord(value)) return false;
  const action =
    value.actionType === "add_liquidity" ||
    value.actionType === "remove_liquidity"
      ? value.actionType
      : value.action === "add_liquidity" || value.action === "remove_liquidity"
        ? value.action
        : undefined;
  const evidence = value.liquidityRoutingEvidence;
  if (
    !action ||
    value.network !== "base" ||
    value.chainId !== 8_453 ||
    !Array.isArray(value.allRoutes) ||
    value.allRoutes.length === 0 ||
    value.allRoutes.length > 32 ||
    !isObjectRecord(evidence) ||
    evidence.policyVersion !== "base_liquidity_reserves_v1" ||
    evidence.action !== action ||
    !isNonNegativeInteger(evidence.candidateRouteCount) ||
    !isNonNegativeInteger(evidence.simulatedRouteCount) ||
    !isNonNegativeInteger(evidence.eligibleRouteCount) ||
    evidence.candidateRouteCount === 0 ||
    evidence.simulatedRouteCount !== evidence.candidateRouteCount ||
    evidence.eligibleRouteCount !== value.allRoutes.length ||
    evidence.eligibleRouteCount > evidence.simulatedRouteCount ||
    evidence.yieldProjectionAvailable !== false ||
    evidence.impermanentLossProjectionAvailable !== false ||
    typeof evidence.limitation !== "string" ||
    evidence.limitation.length === 0 ||
    evidence.limitation.length > 1_000 ||
    !Array.isArray(evidence.rankedRoutes) ||
    evidence.rankedRoutes.length !== value.allRoutes.length ||
    (action === "add_liquidity"
      ? evidence.primaryMetric !== "same_token_reserve_a_depth" ||
        evidence.direction !== "descending" ||
        evidence.selectionPolicy !== "automatic_reserve_depth_ranking"
      : evidence.primaryMetric !== "position_not_comparable" ||
        evidence.direction !== "not_applicable" ||
        evidence.selectionPolicy !== "explicit_wallet_position_selection")
  ) {
    return false;
  }

  const routes = value.allRoutes as Array<Record<string, unknown>>;
  const validRoutes = routes.every((route) => {
    if (
      route.network !== "base" ||
      route.chainId !== 8_453 ||
      route.executionMode !== "direct" ||
      route.feeRouterCompatible !== false ||
      route.approvalPolicy !== "explicit" ||
      typeof route.name !== "string" ||
      typeof route.protocolId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(route.protocolId) ||
      !isCanonicalAddress(route.router) ||
      !Array.isArray(route.approvals) ||
      route.approvals.length === 0 ||
      route.approvals.length > 2 ||
      !isBaseLiquidityPoolEvidence(route.poolEvidence, action)
    ) {
      return false;
    }
    const poolEvidence = route.poolEvidence;
    const validApprovals = route.approvals.every(
      (approval) =>
        isObjectRecord(approval) &&
        isCanonicalAddress(approval.token) &&
        approval.spender === route.router &&
        isPositiveAtomicString(approval.amount),
    );
    if (!validApprovals) return false;
    if (action === "remove_liquidity") {
      return (
        route.approvals.length === 1 &&
        (route.approvals[0] as Record<string, unknown>).token ===
          poolEvidence.pool
      );
    }
    return true;
  });
  if (!validRoutes) return false;

  const poolKeys = routes.map((route) => {
    const pool = route.poolEvidence as BaseLiquidityPoolEvidence;
    return `${String(route.router).toLowerCase()}:${pool.pool.toLowerCase()}:${pool.stable}`;
  });
  const observedBlocks = routes.map(
    (route) => (route.poolEvidence as BaseLiquidityPoolEvidence).observedBlock,
  );
  if (
    new Set(poolKeys).size !== poolKeys.length ||
    new Set(observedBlocks).size !== 1
  ) {
    return false;
  }

  return (evidence.rankedRoutes as Array<Record<string, unknown>>).every(
    (ranked, index) => {
      const route = routes[index];
      const pool = route.poolEvidence as BaseLiquidityPoolEvidence;
      return (
        ranked.rank === index + 1 &&
        ranked.protocolId === route.protocolId &&
        ranked.name === route.name &&
        ranked.router === route.router &&
        ranked.pool === pool.pool &&
        ranked.factory === pool.factory &&
        ranked.stable === pool.stable &&
        ranked.reserveAAtomic === pool.reserveAAtomic &&
        ranked.reserveBAtomic === pool.reserveBAtomic &&
        (ranked.simulationStatus === "passed" ||
          ranked.simulationStatus === "deferred_until_approval")
      );
    },
  );
};

export const isBaseSwapRoutingEvidence = (
  coverage: unknown,
  ranking: unknown,
): coverage is BaseSwapQuoteCoverage => {
  if (
    !isObjectRecord(coverage) ||
    !isNonNegativeInteger(coverage.requestedSourceCount) ||
    !isNonNegativeInteger(coverage.responsiveSourceCount) ||
    !isNonNegativeInteger(coverage.sourceWithRoutesCount) ||
    !isNonNegativeInteger(coverage.unavailableSourceCount) ||
    !isNonNegativeInteger(coverage.totalQuotedRouteCount) ||
    (coverage.totalAttemptedQuoteCount !== undefined &&
      !isNonNegativeInteger(coverage.totalAttemptedQuoteCount)) ||
    (coverage.totalSuccessfulQuoteReadCount !== undefined &&
      !isNonNegativeInteger(coverage.totalSuccessfulQuoteReadCount)) ||
    !Array.isArray(coverage.sources) ||
    coverage.sources.length !== coverage.requestedSourceCount ||
    coverage.requestedSourceCount === 0 ||
    coverage.requestedSourceCount > 32 ||
    !coverage.sources.every(
      (source) =>
        isObjectRecord(source) &&
        typeof source.source === "string" &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.source) &&
        (source.status === "quoted" ||
          source.status === "empty" ||
          source.status === "unavailable") &&
        isNonNegativeInteger(source.quotedRouteCount) &&
        (source.attemptedQuoteCount === undefined ||
          isNonNegativeInteger(source.attemptedQuoteCount)) &&
        (source.successfulQuoteReadCount === undefined ||
          isNonNegativeInteger(source.successfulQuoteReadCount)),
    ) ||
    !isObjectRecord(ranking)
  ) {
    return false;
  }
  const isIntentRouterV2Ranking =
    ranking.policyVersion === "base_intent_v2_net_floor_v1" &&
    ranking.stage === "final_routes_after_intent_v2_runtime_and_simulation" &&
    ranking.primaryMetric === "guaranteed_net_minimum_amount_out";
  const isLegacyRanking =
    (ranking.policyVersion === "base_quoted_output_v1" ||
      ranking.policyVersion === "base_route_efficiency_v2") &&
    (ranking.stage === "protocol_quotes_after_simulation_before_fee_wrapper" ||
      ranking.stage ===
        "final_routes_after_fee_router_allowlist_and_simulation") &&
    (ranking.primaryMetric === "quoted_amount_out" ||
      ranking.primaryMetric === "simulation_evidence_then_quoted_amount_out");
  if (
    (!isIntentRouterV2Ranking && !isLegacyRanking) ||
    ranking.direction !== "descending" ||
    !isNonNegativeInteger(ranking.eligibleRouteCount) ||
    !isNonNegativeInteger(ranking.simulationPassedCount) ||
    !isNonNegativeInteger(ranking.deferredUntilApprovalCount) ||
    ranking.gasCostNormalized !== false ||
    ranking.executionLatencyNormalized !== false ||
    (ranking.policyVersion === "base_route_efficiency_v2" &&
      ranking.gasEstimateTieBreaker !== true) ||
    typeof ranking.limitation !== "string" ||
    ranking.limitation.length > 500 ||
    (isIntentRouterV2Ranking &&
      (!Array.isArray(ranking.rankedRoutes) ||
        ranking.rankedRoutes.length !== ranking.eligibleRouteCount ||
        !ranking.rankedRoutes.every(
          (route, index) =>
            isObjectRecord(route) &&
            route.rank === index + 1 &&
            typeof route.protocolId === "string" &&
            /^[a-z0-9][a-z0-9-]{1,63}$/.test(route.protocolId) &&
            typeof route.name === "string" &&
            route.name.length > 0 &&
            isPositiveAtomicString(route.guaranteedNetMinimumAtomic) &&
            isPositiveAtomicString(route.quotedGrossAmountAtomic) &&
            BigInt(route.quotedGrossAmountAtomic) >=
              BigInt(route.guaranteedNetMinimumAtomic) &&
            (route.simulationStatus === "passed" ||
              route.simulationStatus === "deferred_until_approval"),
        )))
  ) {
    return false;
  }
  const sources = coverage.sources as Array<Record<string, unknown>>;
  const sourceNames = sources.map((source) => String(source.source));
  const quotedRouteTotal = sources.reduce(
    (total, source) => total + Number(source.quotedRouteCount),
    0,
  );
  const responsiveSourceCount = sources.filter(
    (source) => source.status !== "unavailable",
  ).length;
  const sourceWithRoutesCount = sources.filter(
    (source) => source.status === "quoted",
  ).length;
  const unavailableSourceCount = sources.filter(
    (source) => source.status === "unavailable",
  ).length;
  const sourceCountsAreConsistent = sources.every((source) => {
    const count = Number(source.quotedRouteCount);
    const attempted = Number(
      source.attemptedQuoteCount ?? source.quotedRouteCount,
    );
    const successful = Number(
      source.successfulQuoteReadCount ?? source.quotedRouteCount,
    );
    return (
      (source.status === "quoted" ? count > 0 : count === 0) &&
      attempted >= successful &&
      successful >= count
    );
  });
  const totalAttemptedQuoteCount = sources.reduce(
    (total, source) =>
      total + Number(source.attemptedQuoteCount ?? source.quotedRouteCount),
    0,
  );
  const totalSuccessfulQuoteReadCount = sources.reduce(
    (total, source) =>
      total +
      Number(source.successfulQuoteReadCount ?? source.quotedRouteCount),
    0,
  );
  const diagnosticsAreConsistent =
    (coverage.totalAttemptedQuoteCount === undefined ||
      coverage.totalAttemptedQuoteCount === totalAttemptedQuoteCount) &&
    (coverage.totalSuccessfulQuoteReadCount === undefined ||
      coverage.totalSuccessfulQuoteReadCount === totalSuccessfulQuoteReadCount);
  return (
    new Set(sourceNames).size === sourceNames.length &&
    sourceCountsAreConsistent &&
    diagnosticsAreConsistent &&
    coverage.totalQuotedRouteCount === quotedRouteTotal &&
    coverage.responsiveSourceCount === responsiveSourceCount &&
    coverage.sourceWithRoutesCount === sourceWithRoutesCount &&
    coverage.unavailableSourceCount === unavailableSourceCount &&
    ranking.eligibleRouteCount > 0 &&
    ranking.simulationPassedCount + ranking.deferredUntilApprovalCount ===
      ranking.eligibleRouteCount
  );
};

const isAtomicStringOrNull = (value: unknown): boolean =>
  value === null || (typeof value === "string" && /^\d+$/.test(value));

export const isBaseYieldRankingEvidence = (
  value: unknown,
): value is BaseYieldRankingEvidence => {
  if (
    !isObjectRecord(value) ||
    value.policyVersion !== "base_yield_efficiency_v1" ||
    !["lend", "borrow", "repay", "withdraw"].includes(String(value.action)) ||
    !["conservative", "balanced", "aggressive"].includes(
      String(value.riskTolerance),
    ) ||
    !["supply_rate_bps", "borrow_rate_bps", "position"].includes(
      String(value.primaryMetric),
    ) ||
    (value.direction !== "ascending" && value.direction !== "descending") ||
    value.gasCostNormalized !== false ||
    value.quoteBlockConsistency !== "best_effort_live_reads" ||
    typeof value.limitation !== "string" ||
    value.limitation.length > 800 ||
    !isNonNegativeInteger(value.eligibleRouteCount) ||
    value.eligibleRouteCount === 0 ||
    !Array.isArray(value.rankedRoutes) ||
    value.rankedRoutes.length !== value.eligibleRouteCount
  ) {
    return false;
  }
  return value.rankedRoutes.every(
    (route, index) =>
      isObjectRecord(route) &&
      route.rank === index + 1 &&
      typeof route.protocolId === "string" &&
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(route.protocolId) &&
      typeof route.name === "string" &&
      (route.riskTier === "core" ||
        route.riskTier === "established" ||
        route.riskTier === "elevated") &&
      (route.rateBps === null ||
        (typeof route.rateBps === "number" &&
          Number.isFinite(route.rateBps) &&
          route.rateBps >= 0)) &&
      isAtomicStringOrNull(route.availableLiquidityAtomic) &&
      isAtomicStringOrNull(route.positionAtomic) &&
      isAtomicStringOrNull(route.debtAtomic),
  );
};

const BASE_LENDING_PROTOCOL_IDS = new Set([
  "aave-v3",
  "moonwell",
  "compound-v3",
  "moonwell-vault",
  "seamless-vault",
  "spark-vault",
  "fluid-vault",
]);

const isRateBpsOrNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

export const isBaseYieldComparisonResponse = (
  value: unknown,
): value is IntentResponse & {
  action: "yield_compare";
  comparison: "supply" | "borrow";
  opportunities: BaseLendingOpportunity[];
  coverage: BaseYieldComparisonCoverage;
} => {
  if (
    !isObjectRecord(value) ||
    value.action !== "yield_compare" ||
    (value.comparison !== "supply" && value.comparison !== "borrow") ||
    typeof value.assetSymbol !== "string" ||
    !/^[A-Za-z0-9]{2,16}$/.test(value.assetSymbol) ||
    !["conservative", "balanced", "aggressive"].includes(
      String(value.riskTolerance),
    ) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.opportunities) ||
    value.opportunities.length === 0 ||
    value.opportunities.length > 64 ||
    !isObjectRecord(value.coverage) ||
    !isNonNegativeInteger(value.coverage.registeredProtocolCount) ||
    !isNonNegativeInteger(value.coverage.responsiveProtocolCount) ||
    !isNonNegativeInteger(value.coverage.eligibleProtocolCount) ||
    value.coverage.registeredProtocolCount <
      value.coverage.responsiveProtocolCount ||
    value.coverage.responsiveProtocolCount <
      value.coverage.eligibleProtocolCount ||
    value.coverage.eligibleProtocolCount !== value.opportunities.length
  ) {
    return false;
  }

  const opportunities = value.opportunities as Array<Record<string, unknown>>;
  const validOpportunities = opportunities.every(
    (opportunity) =>
      typeof opportunity.protocolId === "string" &&
      BASE_LENDING_PROTOCOL_IDS.has(opportunity.protocolId) &&
      typeof opportunity.name === "string" &&
      opportunity.name.length > 0 &&
      opportunity.name.length <= 120 &&
      opportunity.assetSymbol === value.assetSymbol &&
      isCanonicalAddress(opportunity.target) &&
      (opportunity.riskTier === "core" ||
        opportunity.riskTier === "established" ||
        opportunity.riskTier === "elevated") &&
      isRateBpsOrNull(opportunity.supplyRateBps) &&
      isRateBpsOrNull(opportunity.borrowRateBps) &&
      isAtomicStringOrNull(opportunity.availableLiquidityAtomic) &&
      typeof opportunity.observedAt === "string" &&
      Number.isFinite(Date.parse(opportunity.observedAt)) &&
      opportunity.executionReady === true &&
      opportunity.executionMode === "direct" &&
      typeof opportunity.borrowingEnabled === "boolean" &&
      (value.comparison !== "borrow" ||
        (opportunity.borrowingEnabled === true &&
          opportunity.borrowRateBps !== null)),
  );
  if (!validOpportunities) return false;

  const targets = opportunities.map((opportunity) =>
    String(opportunity.target).toLowerCase(),
  );
  if (new Set(targets).size !== targets.length) return false;

  const rates = opportunities.map((opportunity) =>
    value.comparison === "borrow"
      ? (opportunity.borrowRateBps as number | null)
      : (opportunity.supplyRateBps as number | null),
  );
  let encounteredUnknownRate = false;
  let previousRate: number | null = null;
  for (const rate of rates) {
    if (rate === null) {
      encounteredUnknownRate = true;
      continue;
    }
    if (encounteredUnknownRate) return false;
    if (
      previousRate !== null &&
      (value.comparison === "supply"
        ? rate > previousRate
        : rate < previousRate)
    ) {
      return false;
    }
    previousRate = rate;
  }
  return true;
};

export const isBaseFeeRouterCoverage = (
  value: unknown,
): value is BaseFeeRouterCoverage =>
  isObjectRecord(value) &&
  isNonNegativeInteger(value.requestedRouteCount) &&
  isNonNegativeInteger(value.compatibleRouteCount) &&
  isNonNegativeInteger(value.approvedRouteCount) &&
  isNonNegativeInteger(value.unapprovedTargetCount) &&
  isNonNegativeInteger(value.simulatedRouteCount) &&
  isNonNegativeInteger(value.eligibleRouteCount) &&
  Array.isArray(value.unapprovedTargets) &&
  value.unapprovedTargets.length === value.unapprovedTargetCount &&
  value.unapprovedTargets.every(
    (target) => typeof target === "string" && isAddress(target),
  ) &&
  value.compatibleRouteCount <= value.requestedRouteCount &&
  value.approvedRouteCount <= value.compatibleRouteCount &&
  value.simulatedRouteCount === value.approvedRouteCount &&
  value.eligibleRouteCount <= value.simulatedRouteCount;

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
    "healthFactor",
  ]) &&
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

export type EntityAssetField =
  "tokenIn" | "tokenOut" | "collateralToken" | "borrowToken";

export type EntityClarificationOption = {
  id: string;
  label: string;
  symbol: string;
  address?: string;
  trustLabel: string;
};

export type EntityClarification = {
  kind: "asset" | "recipient" | "protocol" | "workflow";
  code: string;
  field?: EntityAssetField | "recipient" | "protocol" | `workflowSteps.${number}.${EntityAssetField}`;
  reference?: string;
  question: string;
  options: EntityClarificationOption[];
};

export type ResolvedAssetEvidence = {
  role: EntityAssetField;
  originalReference: string;
  canonicalSymbol: string;
  displayName: string;
  address?: string;
  decimals: number;
  representation:
    "native" | "erc20" | "native_with_erc20_interface" | "app_kit_symbol";
  matchedBy:
    | "canonical_symbol"
    | "curated_alias"
    | "exact_address"
    | "portfolio_verified_address"
    | "protocol_fixed_asset";
  identityConfidence: number;
  trustScore: number;
  trustTier: "core" | "established" | "elevated" | "project" | "portfolio";
  trustLabel:
    | "canonical"
    | "reviewed"
    | "elevated_risk"
    | "project_contract"
    | "unlisted_verified";
  security: {
    status: "manifest_verified" | "registry_reviewed" | "provider_passed";
    provider: "Kletia reviewed registry" | "GoPlus";
    observedAt: string;
    catalogRevision?: string;
    primarySource?: string;
  };
  onchain?: {
    observedAtBlock: string;
    codeHash: string;
    metadataBounded: true;
    balanceAtomic: string;
    balanceVerified: true;
  };
  actionCompatibility: {
    action: string;
    allowed: true;
    executionDecimals: number;
  };
  warnings: string[];
};

export type RecipientResolutionEvidence = {
  role: "recipient";
  originalReference: string;
  resolvedAddress: string;
  matchedBy: "exact_address" | "basename";
  basename?: string;
  resolver?: string;
  observedAtBlock?: string;
  observedAt: string;
  expiresAt: number;
  crossNetworkIdentity: boolean;
  warning?: string;
  transferIndex?: number;
};

export type IntentEntityResolution = {
  policyVersion: "kletia_entity_resolution_v1";
  requestId: string;
  network: NetworkMode;
  chainId: number;
  userAddress: string;
  action: string;
  decision: "eligible";
  observedAt: string;
  assets: ResolvedAssetEvidence[];
  recipients: RecipientResolutionEvidence[];
  protocol?: {
    original: string;
    canonical: string;
    matchedBy: "curated_alias" | "canonical_id";
  };
  warnings: string[];
  scorePolicy: "informational_only_hard_gates_take_precedence";
};

export type WorkflowStepStatus =
  | "planned"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "filled"
  | "ready"
  | "failed"
  | "refunded"
  | "indeterminate";

export type WorkflowPlanV1 = {
  version: 1;
  workflowId: string;
  requestId: string;
  userAddress: string;
  createdAt: number;
  expiresAt: number;
  objective: "risk_adjusted_net_return";
  atomicity: {
    sameChain: "wallet_batch_when_verified";
    crossChain: "staged_checkpointed_no_global_rollback";
  };
  hardPolicies: {
    minimumHealthFactor: "1.5";
    requiresPerStepWalletApproval: true;
    mockDataAllowed: false;
  };
  currentStepIndex: number;
  steps: Array<{
    id: string;
    order: number;
    action: string;
    network: "base" | "arbitrum";
    chainId: 8453 | 42161;
    tokenIn?: string;
    tokenOut?: string;
    amount: string;
    amountSource?: "explicit" | "wallet_balance" | "previous_output";
    protocol?: string;
    destinationChain?: string;
    objective?: string;
    url?: string;
    method?: "GET";
    maxPayment?: string;
    dependsOn: string[];
    status: WorkflowStepStatus;
    expectedOutputAtomic?: string;
    actualOutputAtomic?: string;
    outputTokenAddress?: string;
    execution?: {
      target: string;
      calldataHash: string;
      value: string;
      quoteExpiresAt: number;
    };
    payment?: {
      asset: string;
      payTo: string;
      amountAtomic: string;
      requestUrl: string;
      observedAt: string;
    };
    txHash?: string;
    fillTxHash?: string;
    authorizationNonce?: string;
    readResult?: {
      kind: "borrow_capacity";
      protocolId: "aave-v3";
      asset: string;
      safeAmountAtomic: string;
      safeAmount: string;
      targetHealthFactor: string;
      observedAtBlock: string;
      mockData: false;
    };
  }>;
};

export type PolicyAgentV1 = {
  version: 1;
  policyId: string;
  owner: string;
  name: string;
  objective: string;
  allowedNetworks: NetworkMode[];
  allowedProtocols: string[];
  allowedAssets: string[];
  maxSpendUsdcAtomic: string;
  riskTolerance: "conservative" | "balanced" | "aggressive";
  createdAt: number;
  expiresAt: number;
  authority: "planning_only_no_transaction_authority";
  requiresPerStepWalletApproval: true;
};

export type IntentResponse = {
  status: string;
  message?: string;
  question?: string;
  requiresInput?: boolean;
  action?: string;
  data?: PortfolioData;
  network?: NetworkMode;
  chainId?: number;
  requestId?: string;
  conversationId?: string;
  conversationExpiresAt?: number;
  clarification?: EntityClarification;
  entityResolution?: IntentEntityResolution;
  quoteExpiresAt?: number | string;
  userAddress?: string;
  winner?: string;
  winnerMessage?: string;
  expectedOutput?: string;
  routePath?: string;
  targetContract?: string;
  calldata?: string;
  tokenInAddress?: string;
  amountInWei?: string;
  isNativeIn?: boolean;
  value?: string;
  approvals?: RouteApproval[];
  executionMode?: RouteExecutionMode;
  allRoutes?: RouteData[];
  actionType?: string;
  widgetTarget?: string;
  subTarget?: WidgetId;
  executionKind?:
    | "circle_app_kit"
    | "base_x402_discovery"
    | "base_mcp_x402"
    | "workflow_plan_v1";
  executionPlan?: ArcAppKitExecutionPlan;
  routeProof?: ArcAppKitRouteProof;
  provider?: "Circle App Kit" | "Coinbase CDP Bazaar" | "Base MCP";
  services?: BaseX402Service[];
  search?: BaseX402Search;
  mcpPlan?: BaseMcpX402Plan;
  challengeEvidence?: BaseX402ChallengeEvidence;
  trustNotice?: string;
  approvalRequired?: boolean;
  intentRouterV2Coverage?: BaseIntentRouterV2Coverage;
  quoteCoverage?: BaseSwapQuoteCoverage;
  rankingEvidence?: BaseSwapRankingEvidence;
  yieldRankingEvidence?: BaseYieldRankingEvidence;
  feeRouterCoverage?: BaseFeeRouterCoverage;
  liquidityRoutingEvidence?: BaseLiquidityRoutingEvidence;
  opportunities?: BaseLendingOpportunity[];
  comparison?: "supply" | "borrow";
  assetSymbol?: string;
  riskTolerance?: "conservative" | "balanced" | "aggressive";
  observedAt?: string;
  coverage?: BaseYieldComparisonCoverage;
  launchFactoryV2Evidence?: BaseLaunchFactoryV2Evidence;
  predictedTokenAddress?: string;
  simulationStatus?: "passed" | "deferred_until_approval";
  workflowPlan?: WorkflowPlanV1;
  workflowToken?: string;
  policyAgent?: PolicyAgentV1;
  yieldComparison?: {
    policyVersion: "arbitrum_aave_v3_live_rates_v1";
    protocolId: "aave-v3";
    asset: string;
    supplyApyBps: number;
    variableBorrowApyBps: number;
    availableLiquidityAtomic: string;
    observedAt: string;
    mockData: false;
  };
  gasReadiness?: {
    policyVersion: "arbitrum_explicit_gas_acquisition_v1";
    nativeAsset: "ETH";
    balanceAtomic: string;
    recommendedBufferAtomic: string;
    gasAcquisitionRequired: boolean;
    automaticSpendAllowed: false;
    acquisitionPolicy: "switch_to_base_and_request_bounded_across_eth_route";
    observedAtBlock: string;
    mockData: false;
  };
};

const hasBaseIntentV2RouteMarker = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  const intent = value.intent;
  const configEvidence = value.configEvidence;
  return (
    value.executionMode === "kletia_intent_router_v2" ||
    value.adapterKind === "uniswap_v2_compatible" ||
    value.adapterKind === "uniswap_v3_swaprouter02" ||
    value.adapterDataEncoding === "abi_address_array_v1" ||
    value.adapterDataEncoding === "uniswap_v3_packed_path_v1" ||
    (isObjectRecord(intent) &&
      typeof intent.adapterConfigHash === "string" &&
      typeof value.adapterData === "string") ||
    (isObjectRecord(configEvidence) &&
      (configEvidence.schemaVersion === "kletia_base_intent_v2_deployment_v1" ||
        configEvidence.schemaVersion === "kletia_base_intent_v2_deployment_v2"))
  );
};

export const hasBaseIntentV2Marker = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  const ranking = value.rankingEvidence;
  return (
    value.executionMode === "kletia_intent_router_v2" ||
    value.intentRouterV2Coverage !== undefined ||
    (isObjectRecord(ranking) &&
      (ranking.policyVersion === "base_intent_v2_net_floor_v1" ||
        ranking.stage ===
          "final_routes_after_intent_v2_runtime_and_simulation" ||
        ranking.primaryMetric === "guaranteed_net_minimum_amount_out")) ||
    (Array.isArray(value.allRoutes) &&
      value.allRoutes.some(hasBaseIntentV2RouteMarker))
  );
};

const sameCanonicalAddress = (left: unknown, right: unknown): boolean =>
  typeof left === "string" &&
  typeof right === "string" &&
  isAddress(left) &&
  isAddress(right) &&
  getAddress(left) === getAddress(right);

const compareBaseIntentV2Routes = (
  left: RouteData,
  right: RouteData,
): number => {
  if (left.simulationStatus !== right.simulationStatus) {
    return left.simulationStatus === "passed" ? -1 : 1;
  }
  const leftEconomics = left.economics as Record<string, unknown> | undefined;
  const rightEconomics = right.economics as Record<string, unknown> | undefined;
  const leftMinimum =
    isObjectRecord(leftEconomics) &&
    typeof leftEconomics.netMinimumAmountOut === "string" &&
    /^(?:0|[1-9]\d*)$/.test(leftEconomics.netMinimumAmountOut)
      ? BigInt(leftEconomics.netMinimumAmountOut)
      : -1n;
  const rightMinimum =
    isObjectRecord(rightEconomics) &&
    typeof rightEconomics.netMinimumAmountOut === "string" &&
    /^(?:0|[1-9]\d*)$/.test(rightEconomics.netMinimumAmountOut)
      ? BigInt(rightEconomics.netMinimumAmountOut)
      : -1n;
  if (leftMinimum !== rightMinimum) {
    return leftMinimum > rightMinimum ? -1 : 1;
  }
  const protocolOrder = String(left.protocolId).localeCompare(
    String(right.protocolId),
  );
  if (protocolOrder !== 0) return protocolOrder;
  const adapterKindOrder = String(left.adapterKind).localeCompare(
    String(right.adapterKind),
  );
  if (adapterKindOrder !== 0) return adapterKindOrder;
  return String(left.adapterData).localeCompare(String(right.adapterData));
};

export const isBaseIntentRouterV2ResponseBinding = (
  response: IntentResponse,
): boolean => {
  const routes = response.allRoutes;
  const coverage = response.intentRouterV2Coverage;
  const ranking = response.rankingEvidence;
  const quoteCoverage = response.quoteCoverage;
  if (
    !hasBaseIntentV2Marker(response) ||
    response.executionMode !== "kletia_intent_router_v2" ||
    response.network !== "base" ||
    response.chainId !== 8_453 ||
    !Array.isArray(routes) ||
    routes.length === 0 ||
    routes.length > 20 ||
    !isObjectRecord(coverage) ||
    !isObjectRecord(ranking) ||
    !isBaseSwapRoutingEvidence(quoteCoverage, ranking) ||
    !routes.every(
      (route) =>
        route.executionMode === "kletia_intent_router_v2" &&
        isBaseIntentRouterV2SwapBinding(response, route),
    )
  ) {
    return false;
  }

  const integerCounts = [
    coverage.quotedRouteCount,
    coverage.typedAdapterMatchedRouteCount,
    coverage.compiledRouteCount,
    coverage.simulatedRouteCount,
    coverage.eligibleRouteCount,
    coverage.unsupportedQuoteCount,
  ];
  const expectedPolicy = routes.some(
    ({ adapterKind }) => adapterKind === "uniswap_v3_swaprouter02",
  )
    ? "kletia_base_intent_v2_typed_adapter_v2"
    : "kletia_base_intent_v2_typed_adapter_v1";
  const first = routes[0];
  const firstIntent = first.intent;
  const firstConfig = first.configEvidence;
  if (
    integerCounts.some((count) => !isNonNegativeInteger(count)) ||
    coverage.policyVersion !== expectedPolicy ||
    coverage.runtimeValidationStatus !== "validated" ||
    coverage.rankingMetric !== "simulation_then_guaranteed_net_minimum" ||
    coverage.noLegacyFallback !== true ||
    coverage.quotedRouteCount < coverage.typedAdapterMatchedRouteCount ||
    coverage.typedAdapterMatchedRouteCount !== coverage.compiledRouteCount ||
    coverage.compiledRouteCount !== coverage.simulatedRouteCount ||
    coverage.eligibleRouteCount !== routes.length ||
    coverage.eligibleRouteCount > coverage.simulatedRouteCount ||
    coverage.unsupportedQuoteCount !==
      coverage.quotedRouteCount - coverage.typedAdapterMatchedRouteCount ||
    !firstIntent ||
    !firstConfig ||
    coverage.observedAtBlock !== firstConfig.observedAtBlock ||
    coverage.sharedExclusiveNonce !== firstIntent.nonce ||
    !quoteCoverage ||
    quoteCoverage.totalQuotedRouteCount < coverage.quotedRouteCount ||
    quoteCoverage.sources.map(({ source }) => source).join(",") !==
      "aerodrome,standard_amm,v3_amm" ||
    routes.some(
      ({ quoteSource }) =>
        !quoteCoverage.sources.some(
          (source) =>
            source.source === quoteSource &&
            source.status === "quoted" &&
            source.quotedRouteCount > 0,
        ),
    )
  ) {
    return false;
  }

  const sharedIntentFieldsAreValid = routes.every((route) => {
    const intent = route.intent;
    const config = route.configEvidence;
    return (
      intent !== undefined &&
      config !== undefined &&
      sameCanonicalAddress(intent.owner, firstIntent.owner) &&
      sameCanonicalAddress(intent.tokenIn, firstIntent.tokenIn) &&
      sameCanonicalAddress(intent.tokenOut, firstIntent.tokenOut) &&
      intent.amountIn === firstIntent.amountIn &&
      sameCanonicalAddress(intent.recipient, firstIntent.recipient) &&
      intent.nonce === firstIntent.nonce &&
      intent.issuedAt === firstIntent.issuedAt &&
      intent.validAfter === firstIntent.validAfter &&
      intent.deadline === firstIntent.deadline &&
      sameCanonicalAddress(intent.executor, firstIntent.executor) &&
      intent.maxFeeBps === firstIntent.maxFeeBps &&
      String(route.quoteExpiresAt) === String(first.quoteExpiresAt) &&
      config.observedAtBlock === firstConfig.observedAtBlock
    );
  });
  if (
    !sharedIntentFieldsAreValid ||
    routes.some(
      (route, index) =>
        index > 0 && compareBaseIntentV2Routes(routes[index - 1], route) > 0,
    )
  ) {
    return false;
  }

  const simulationPassedCount = routes.filter(
    ({ simulationStatus }) => simulationStatus === "passed",
  ).length;
  const deferredUntilApprovalCount = routes.filter(
    ({ simulationStatus }) => simulationStatus === "deferred_until_approval",
  ).length;
  const rankedRoutes = (ranking as Record<string, unknown>).rankedRoutes;
  if (
    ranking.eligibleRouteCount !== routes.length ||
    ranking.simulationPassedCount !== simulationPassedCount ||
    ranking.deferredUntilApprovalCount !== deferredUntilApprovalCount ||
    !Array.isArray(rankedRoutes) ||
    rankedRoutes.length !== routes.length ||
    !rankedRoutes.every((ranked, index) => {
      if (!isObjectRecord(ranked)) return false;
      const route = routes[index];
      const economics = route.economics;
      const economicsRecord = economics as Record<string, unknown> | undefined;
      return (
        isObjectRecord(economicsRecord) &&
        ranked.rank === index + 1 &&
        ranked.protocolId === route.protocolId &&
        ranked.name === route.name &&
        ranked.guaranteedNetMinimumAtomic ===
          economicsRecord.netMinimumAmountOut &&
        ranked.quotedGrossAmountAtomic ===
          economicsRecord.quotedGrossAmountOut &&
        ranked.simulationStatus === route.simulationStatus
      );
    })
  ) {
    return false;
  }

  const nativeInput =
    firstIntent.tokenIn === "0x0000000000000000000000000000000000000000";
  return (
    response.winner === first.name &&
    response.expectedOutput === first.expectedOutput &&
    response.routePath === first.routePath &&
    sameCanonicalAddress(response.targetContract, first.router) &&
    typeof response.calldata === "string" &&
    response.calldata.toLowerCase() === first.calldata.toLowerCase() &&
    response.value === first.value &&
    response.amountInWei === firstIntent.amountIn &&
    response.isNativeIn === nativeInput &&
    (nativeInput
      ? response.tokenInAddress === undefined
      : sameCanonicalAddress(response.tokenInAddress, firstIntent.tokenIn)) &&
    String(response.quoteExpiresAt) === String(first.quoteExpiresAt)
  );
};

export const hasExecutableIntentActionBinding = (
  response: IntentResponse,
  route: RouteData,
): boolean => {
  const action = (
    typeof response.actionType === "string" &&
    response.actionType.trim().length > 0
      ? response.actionType
      : response.action
  )?.trim();

  if (!action || route.action !== action) return false;
  if (
    typeof response.action === "string" &&
    response.action.trim().length > 0 &&
    response.action.trim() !== action
  ) {
    return false;
  }
  if (hasBaseIntentV2Marker(response) || hasBaseIntentV2RouteMarker(route)) {
    return (
      isBaseIntentRouterV2ResponseBinding(response) &&
      route.executionMode === "kletia_intent_router_v2" &&
      response.allRoutes?.includes(route) === true
    );
  }
  return true;
};

export type ChatMessage = {
  id: string;
  role: "user" | "kletia";
  text: string;
  isLoading?: boolean;
  intentData?: IntentResponse;
  terminalLogs?: string[];
  txHash?: string;
  selectedRouteIndex?: number;
  executionStatus?: "success" | "pending" | "recoverable" | "blocked";
  widgetType?: "copy_trade" | "yield_optimizer" | "limit_order" | string;
  widgetData?: unknown;
  network?: NetworkMode;
  chainId?: number;
  walletAddress?: string;
  requestId?: string;
  clarification?: EntityClarification;
  conversationId?: string;
  conversationExpiresAt?: number;
  clarificationStatus?:
    "pending" | "submitting" | "resolved" | "blocked" | "expired";
};

export type WidgetId =
  | "portfolio"
  | "swap"
  | "vault"
  | "batch"
  | "memo"
  | "job"
  | "agent"
  | "staking"
  | "liquidity"
  | "lending"
  | null;
