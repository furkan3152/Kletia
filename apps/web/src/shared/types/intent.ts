/**
 * Intent response, entity resolution, workflow, chat and widget types.
 */
import type { NetworkMode } from "../config/networks";
import type {
  ArcAppKitExecutionPlan,
  ArcAppKitRouteProof,
  BaseIntentRouterV2Coverage,
  BaseLaunchFactoryV2Evidence,
  RouteApproval,
  RouteData,
  RouteExecutionMode,
} from "./routes.ts";
import type {
  BaseFeeRouterCoverage,
  BaseLendingOpportunity,
  BaseLiquidityRoutingEvidence,
  BaseMcpX402Plan,
  BaseSwapQuoteCoverage,
  BaseSwapRankingEvidence,
  BaseX402ChallengeEvidence,
  BaseX402Search,
  BaseX402Service,
  BaseYieldComparisonCoverage,
  BaseYieldRankingEvidence,
} from "./evidence.ts";
import type { PortfolioData } from "./portfolio.ts";

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
    network: "base" | "arc" | "arbitrum";
    chainId: 8453 | 5042002 | 42161;
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
  success?: boolean;
  code?: string;
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
  privacyDecision?: import("../privacy/defaultIntentPrivacy").IntentPrivacyDecisionV1;
  privacyTrace?: import("../privacy/intentPrivacyTrace").IntentPrivacyTraceV1;
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
  /**
   * The desk task this message belongs to (its task id), or `wf:<workflowId>`
   * for a restored cross-chain workflow. Persisted: it names a task, not what
   * was said. Messages of the old console have none.
   */
  threadId?: string;
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
