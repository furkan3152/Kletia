/**
 * Envelope limits, patterns and the exact key sets of V2 evidence objects.
 */
import { getAddress } from "viem";

export const KLETIA_FEE_ROUTER = getAddress(
  "0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf",
);
export const BASE_INTENT_V2_EXECUTION_MODE = "kletia_intent_router_v2" as const;
export const MAX_BASE_INTENT_V2_ROUTES = 20;
export const MAX_BASE_INTENT_V2_FEE_BPS = 100;
export const MAX_BASE_INTENT_V2_TTL_SECONDS = 3_600n;
export const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/u;
export const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
export const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
export const V2_INTENT_KEYS = new Set([
  "owner",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "minAmountOut",
  "recipient",
  "adapter",
  "adapterConfigHash",
  "adapterDataHash",
  "nonce",
  "issuedAt",
  "validAfter",
  "deadline",
  "executor",
  "maxFeeBps",
]);
export const V2_CONFIG_EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "adapterKind",
  "observedAtBlock",
  "routerCodehash",
  "wrappedNativeCodehash",
  "adapterConfigHash",
  "adapterConfigurationHash",
]);
export const V2_ECONOMICS_KEYS = new Set([
  "quotedGrossAmountOut",
  "grossMinimumAfterSlippage",
  "estimatedFeeAtObservedRate",
  "maximumFeeAtSignedCap",
  "netMinimumAmountOut",
  "userMinimumNetAmountOut",
  "bindingMinimumSource",
  "observedFeeBps",
  "maxFeeBps",
  "slippageBps",
]);
export const V2_COVERAGE_KEYS = new Set([
  "policyVersion",
  "runtimeValidationStatus",
  "observedAtBlock",
  "quotedRouteCount",
  "typedAdapterMatchedRouteCount",
  "compiledRouteCount",
  "simulatedRouteCount",
  "eligibleRouteCount",
  "unsupportedQuoteCount",
  "sharedExclusiveNonce",
  "rankingMetric",
  "noLegacyFallback",
]);
export const V2_RANKING_KEYS = new Set([
  "policyVersion",
  "stage",
  "primaryMetric",
  "direction",
  "eligibleRouteCount",
  "simulationPassedCount",
  "deferredUntilApprovalCount",
  "gasCostNormalized",
  "executionLatencyNormalized",
  "limitation",
  "rankedRoutes",
]);
export const V2_QUOTE_COVERAGE_KEYS = new Set([
  "requestedSourceCount",
  "responsiveSourceCount",
  "sourceWithRoutesCount",
  "unavailableSourceCount",
  "totalQuotedRouteCount",
  "totalAttemptedQuoteCount",
  "totalSuccessfulQuoteReadCount",
  "sources",
]);
export const V2_QUOTE_SOURCE_ORDER = ["aerodrome", "standard_amm", "v3_amm"] as const;
export const LAUNCH_V2_EVIDENCE_KEYS = new Set([
  "policyVersion",
  "factory",
  "userSalt",
  "saltSource",
  "launchId",
  "name",
  "symbol",
  "totalSupply",
  "recipient",
  "maxDeploymentFee",
  "deploymentFee",
  "value",
  "predictedAddress",
  "observedAtBlock",
  "factoryCodehash",
  "ownerAuthority",
  "ownerAuthorityKind",
  "treasurySafe",
  "pendingTreasury",
  "factoryFeeCap",
  "simulationStatus",
  "supplyPolicy",
  "saltPolicy",
]);
