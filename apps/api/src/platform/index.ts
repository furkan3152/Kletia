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
  startSettlementPoller,
  submitStep,
  MAX_STEP_TRANSACTIONS,
  PAYLOAD_TTL_SECONDS,
  type CreatedIntent,
  type CreateIntentOptions,
  type PlatformConfiguration,
  type PreparedStepResult,
  type SettlementPollerOptions,
} from "./engine/service.js";

/** Id formats shared by the engine and the HTTP layer. */
export { INTENT_ID_PATTERN, STEP_ID_PATTERN } from "./engine/util.js";

export { planIntent, DEFAULT_SLIPPAGE_BPS, INTENT_TTL_MS, type PlanOptions } from "./engine/planner.js";
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
  readIntentEvents,
  subscribeIntentEvents,
  type IntentEvent,
  type IntentEventType,
} from "./engine/events.js";

export {
  createIntentStore,
  MemoryIntentStore,
  PostgresIntentStore,
  type IntentRecordMeta,
  type IntentStore,
  type ReferenceClaim,
} from "./engine/store.js";

export { activeProtocolAdapters, ADAPTERS, effectiveProtocol, EXECUTABLE_PROTOCOLS } from "./engine/adapters/registry.js";
export { REJECTION_CODES } from "./engine/adapters/verification.js";
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
export type { ResolvedAsset } from "./engine/assets.js";
