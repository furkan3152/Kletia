/**
 * Kletia platform engine (no HTTP). The public API v1 layer, the first-party
 * app and integrators' servers call these functions; see docs/platform/api-v1.md.
 */
export { PlatformError, isPlatformError, toPlatformError, type PlatformErrorStatus, type PlatformIssue } from "./errors.js";

export {
  cancelIntent,
  configurePlatform,
  createIntent,
  createIntentDetailed,
  getIntent,
  getIntentOwner,
  getIntentStore,
  listIntents,
  prepareStep,
  refreshIntent,
  refreshIntentPreview,
  startSettlementPoller,
  submitStep,
  MAX_STEP_TRANSACTIONS,
  PAYLOAD_TTL_SECONDS,
  type CreatedIntent,
  type CreateIntentOptions,
  type PlatformConfiguration,
  type PrepareStepOptions,
  type PreparedStepResult,
  type RefreshPreviewOptions,
  type SettlementPollerOptions,
} from "./engine/service.js";

/* Asset-change preview (engine side; the HTTP layer installs the store and serves the routes). */
export {
  configurePreviewPricer,
  configurePreviewStore,
  getPreviewStore,
  materialPreviewChanges,
  MemoryPreviewStore,
  plannedPreviews,
  previewChangedError,
  previewEnforced,
  previewIntent,
  previewPreparedStep,
  PREVIEW_TTL_MS,
  type PreparedPreview,
  type PreviewContext,
  type PreviewPricer,
  type PreviewStore,
} from "./engine/preview/index.js";
export type { PlannedStepPreview, PlannedVenueFee } from "./engine/adapters/types.js";

/** Id formats shared by the engine and the HTTP layer. */
export { INTENT_ID_PATTERN, STEP_ID_PATTERN } from "./engine/util.js";

export { planIntent, planIntentWithPreviews, withIntentTtl, DEFAULT_SLIPPAGE_BPS, INTENT_TTL_MS, MAX_INTENT_TTL_MS, type PlannedIntent, type PlanOptions } from "./engine/planner.js";

/* Rule Book (engine side, policy design PF2; the HTTP layer supplies the stores and installs the gate). */
export {
  ASSET_PRICE_SOURCES,
  chainGoverns,
  CHAINLINK_FEEDS,
  configurePolicyGate,
  configurePolicyPricing,
  configurePolicyReads,
  createRuleBookGate,
  MemoryApprovalStore,
  MemoryDecisionLog,
  MemorySpendLedger,
  newApprovalId,
  newDecisionId,
  notionalUsdMicros,
  payloadExposure,
  pinNonces,
  policyError,
  policyErrorDetails,
  policyFactsDetailed,
  policyFactsFromGraph,
  policyGate,
  policyGateActive,
  policyNeedsPricing,
  policyPrice,
  policyPrices,
  priceSourcesFor,
  ProjectLocks,
  publishPolicyEvent,
  resetPolicyPricing,
  stepExposureUsdMicros,
  subscribePolicyEvents,
  windowRetryAt,
  windowUsage,
  type ApproverRequirement,
  type DetailedFacts,
  type ExposureHandle,
  type ExposureRecord,
  type ExposureState,
  type FactsOptions,
  type PayloadClearanceInput,
  type PayloadExposure,
  type PlanGuard,
  type PolicyApprovalRecord,
  type PolicyApprovalReference,
  type PolicyApprovalStore,
  type PolicyChainLevel,
  type PolicyChainReads,
  type PolicyChainSnapshot,
  type PolicyChainSource,
  type PolicyDecisionDraft,
  type PolicyDecisionLog,
  type PolicyErrorDetails,
  type PolicyEvent,
  type PolicyGate,
  type PolicyPricingTransport,
  type PolicySimulation,
  type PolicySimulationInput,
  type PriceQuote,
  type PriceReading,
  type PriceSource,
  type RuleBookGate,
  type RuleBookGateOptions,
  type ScopeCap,
  type ScopeUsage,
  type SpendLedger,
  type SpendReservation,
  type SpendReservationResult,
  type VerificationReconcileInput,
} from "./engine/policy/index.js";

/* Intent links (engine side, intent-links design L2; the HTTP layer stores links and serves the routes). */
export {
  assertLinkEnvelope,
  DeliverCandidateRejected,
  linkClientReference,
  linkPinDrift,
  linkPinDriftError,
  linkPolicyCheck,
  linkVisitorAccounts,
  planLinkIntent,
  resetDeliverSizing,
  sizeDelivery,
  type DeliverSizingInput,
  type DeliverSizingResult,
  type LinkEnvelopeCheck,
  type LinkPinDrift,
  type LinkPlanInput,
  type LinkPolicyCheck,
  type PlannedLinkIntent,
} from "./engine/links/index.js";
export { compileIntentText, GRAMMAR_EXAMPLES, LIQUID_STAKING_TOKENS, type GrammarContext, type GrammarResult } from "./engine/grammar.js";
export { quoteRoutes, type QuoteRoute, type QuoteRoutesInput, type QuoteRoutesResult } from "./engine/quotes.js";
export { LENDING_PROTOCOLS } from "./engine/planner.js";
export { configureVenueQuoteTimeout, DEFAULT_MAX_SECONDS } from "./engine/auction.js";
export {
  looksLikeName,
  registerNameResolver,
  resolveRecipientName,
  type NameResolution,
  type NameResolver,
} from "./engine/names.js";
export { readAccountPortfolio, type AccountPortfolio, type PortfolioHolding } from "./engine/portfolio.js";

export {
  buildEvent,
  emitGraphChanges,
  platformEvents,
  publishIntentEvent,
  publishReceiptEvent,
  readIntentEvents,
  subscribeIntentEvents,
  subscribeReceiptEvents,
  type IntentEvent,
  type IntentEventType,
  type ReceiptEvent,
  type ReceiptEventType,
} from "./engine/events.js";

/* Verifiable receipts (engine side: inputs gated on finality; the HTTP layer signs, stores and serves). */
export {
  collectReceiptInputs,
  plannedAnchors,
  RECEIPT_FINALITY_LAG_SECONDS,
  resetReceiptHeads,
  type CollectReceiptOptions,
} from "./engine/receipts/collect.js";
export type { ReceiptCollection } from "@kletia/core";

export {
  createIntentStore,
  MemoryIntentStore,
  PostgresIntentStore,
  type IntentChange,
  type IntentRecordMeta,
  type IntentStore,
  type ReferenceClaim,
} from "./engine/store.js";

export { activeProtocolAdapters, ADAPTERS, effectiveProtocol, EXECUTABLE_PROTOCOLS } from "./engine/adapters/registry.js";
export { landedPayload, REJECTION_CODES, type LandedPayload } from "./engine/adapters/verification.js";
export { AAVE_V3_MARKETS } from "./engine/adapters/aaveV3.js";
export {
  compoundV3Adapter,
  erc4626Adapter,
  moonwellAdapter,
  listLendingMetrics,
  readLendingMetrics,
  type LendingMetrics,
  type LendingMetricsListing,
} from "./engine/adapters/lending/index.js";
export { jupiterLendAdapter } from "./engine/adapters/jupiterLend.js";
export { kaminoAdapter } from "./engine/adapters/kamino.js";
export { lifiAdapter } from "./engine/adapters/lifi.js";
export { debridgeDlnAdapter } from "./engine/adapters/debridge.js";
export {
  createBasenamesResolver,
  createEnsResolver,
  createSnsResolver,
  installNameResolvers,
  NAME_RESOLVERS,
} from "./engine/nameResolvers.js";
export type { AdapterRoute, ProtocolAdapter } from "./engine/adapters/types.js";

/* Bring your own contract (engine side; the HTTP layer installs the directory). */
export {
  configureContractDirectory,
  contractDirectory,
  contractsEnabled,
  type ActionTransport,
  type ContractDirectory,
  type ContractPhrase,
  type RegisteredContract,
} from "./engine/contracts/directory.js";
export {
  compareEvmPins,
  inspectEvmContract,
  proxyRefusalReason,
  PROXY_REFUSAL_HINTS,
  type EvmContractInspection,
} from "./engine/contracts/pins.js";
export {
  compareSolanaProgramPins,
  fetchSolanaActionMetadata,
  readSolanaProgramPins,
} from "./engine/contracts/solanaActions.js";
export { testContractAction } from "./engine/contracts/review.js";
export { simulationCapability, simulationUrls } from "./engine/contracts/simulationRpc.js";
export { EVM_NETWORK_KEYS, isEvmNetwork, type EvmNetworkKey } from "./engine/chains/evm.js";
export type { SolanaNetworkKey } from "../networks/solana/index.js";
export type { ResolvedAsset } from "./engine/assets.js";
