/**
 * Route, Router V2, Launch Factory V2 and Arc App Kit route types.
 */
import type { NetworkMode } from "../config/networks";
import type {
  BaseIntentRouterV2SwapEconomics,
  BaseLiquidityPoolEvidence,
  BaseYieldEconomics,
} from "./evidence.ts";

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
