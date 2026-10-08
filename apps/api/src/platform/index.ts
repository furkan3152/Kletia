/**
 * Kletia platform engine (no HTTP). The public API v1 layer, the first-party
 * app and integrators' servers call these functions; see docs/platform/api-v1.md.
 */
export { PlatformError, isPlatformError, toPlatformError, type PlatformErrorStatus, type PlatformIssue } from "./errors.js";

export {
  cancelIntent,
  configurePlatform,
  createIntent,
  getIntent,
  getIntentStore,
  listIntents,
  prepareStep,
  refreshIntent,
  startSettlementPoller,
  submitStep,
  PAYLOAD_TTL_SECONDS,
  type CreateIntentOptions,
  type PreparedStepResult,
  type SettlementPollerOptions,
} from "./engine/service.js";

export { planIntent, DEFAULT_SLIPPAGE_BPS, INTENT_TTL_MS, type PlanOptions } from "./engine/planner.js";
export { compileIntentText, GRAMMAR_EXAMPLES, LIQUID_STAKING_TOKENS, type GrammarContext, type GrammarResult } from "./engine/grammar.js";
export { quoteRoutes, type QuoteRoute, type QuoteRoutesInput, type QuoteRoutesResult } from "./engine/quotes.js";
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

export { ADAPTERS, EXECUTABLE_PROTOCOLS } from "./engine/adapters/registry.js";
export { AAVE_V3_MARKETS } from "./engine/adapters/aave-v3.js";
export type { ProtocolAdapter } from "./engine/adapters/types.js";
