/**
 * Base Intent Router V2 coverage, ranking and quote coverage checks and
 * the V2 envelope.
 */
import type { Address } from "viem";
import {
  NATIVE_TOKEN_SENTINEL,
  type IntentV2ExecutionConfig,
} from "../../../networks/base/intent/routerV2.js";
import type { ResultLike, UnknownRecord } from "./types.js";
import {
  BASE_INTENT_V2_EXECUTION_MODE,
  MAX_BASE_INTENT_V2_ROUTES,
  V2_COVERAGE_KEYS,
  V2_QUOTE_COVERAGE_KEYS,
  V2_QUOTE_SOURCE_ORDER,
  V2_RANKING_KEYS,
} from "./constants.js";
import {
  checkedCalldata,
  decimalValue,
  hasOnlyKeys,
  isRecord,
  sameAddress,
  sameHex,
} from "./checks.js";
import { assertV2EntityResolutionBinding } from "./entityResolution.js";
import {
  checkedV2Address,
  checkedV2Decimal,
  v2ResponseError,
} from "./v2Checks.js";
import {
  checkedV2Approvals,
  checkedV2Count,
  type CheckedV2Route,
  normalizeV2Route,
  requireSharedV2Intent,
  sameV2Approvals,
} from "./v2Routes.js";

function checkedV2Coverage(value: unknown, routes: readonly CheckedV2Route[]) {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_COVERAGE_KEYS)) {
    return v2ResponseError();
  }
  const quotedRouteCount = checkedV2Count(value.quotedRouteCount);
  const typedAdapterMatchedRouteCount = checkedV2Count(
    value.typedAdapterMatchedRouteCount,
  );
  const compiledRouteCount = checkedV2Count(value.compiledRouteCount);
  const simulatedRouteCount = checkedV2Count(value.simulatedRouteCount);
  const eligibleRouteCount = checkedV2Count(value.eligibleRouteCount);
  const unsupportedQuoteCount = checkedV2Count(value.unsupportedQuoteCount);
  const observedAtBlock = checkedV2Decimal(
    value.observedAtBlock,
    false,
  ).encoded;
  const sharedExclusiveNonce = checkedV2Decimal(
    value.sharedExclusiveNonce,
  ).encoded;
  const expectedPolicyVersion = routes.some(
    ({ adapter }) => adapter.kind === "uniswap_v3_swaprouter02",
  )
    ? "kletia_base_intent_v2_typed_adapter_v2"
    : "kletia_base_intent_v2_typed_adapter_v1";
  if (
    value.policyVersion !== expectedPolicyVersion ||
    value.runtimeValidationStatus !== "validated" ||
    value.rankingMetric !== "simulation_then_guaranteed_net_minimum" ||
    value.noLegacyFallback !== true ||
    observedAtBlock !== routes[0].observedAtBlock ||
    sharedExclusiveNonce !== routes[0].intent.nonce ||
    quotedRouteCount < typedAdapterMatchedRouteCount ||
    typedAdapterMatchedRouteCount !== compiledRouteCount ||
    compiledRouteCount !== simulatedRouteCount ||
    eligibleRouteCount !== routes.length ||
    eligibleRouteCount > simulatedRouteCount ||
    unsupportedQuoteCount !== quotedRouteCount - typedAdapterMatchedRouteCount
  ) {
    return v2ResponseError();
  }
  return {
    policyVersion: expectedPolicyVersion,
    runtimeValidationStatus: "validated" as const,
    observedAtBlock,
    quotedRouteCount,
    typedAdapterMatchedRouteCount,
    compiledRouteCount,
    simulatedRouteCount,
    eligibleRouteCount,
    unsupportedQuoteCount,
    sharedExclusiveNonce,
    rankingMetric: "simulation_then_guaranteed_net_minimum" as const,
    noLegacyFallback: true as const,
  };
}

function checkedV2Ranking(value: unknown, routes: readonly CheckedV2Route[]) {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_RANKING_KEYS)) {
    return v2ResponseError();
  }
  const eligibleRouteCount = checkedV2Count(value.eligibleRouteCount);
  const simulationPassedCount = checkedV2Count(value.simulationPassedCount);
  const deferredUntilApprovalCount = checkedV2Count(
    value.deferredUntilApprovalCount,
  );
  if (
    value.policyVersion !== "base_intent_v2_net_floor_v1" ||
    value.stage !== "final_routes_after_intent_v2_runtime_and_simulation" ||
    value.primaryMetric !== "guaranteed_net_minimum_amount_out" ||
    value.direction !== "descending" ||
    value.gasCostNormalized !== false ||
    value.executionLatencyNormalized !== false ||
    typeof value.limitation !== "string" ||
    value.limitation.length === 0 ||
    value.limitation.length > 500 ||
    eligibleRouteCount !== routes.length ||
    simulationPassedCount !==
      routes.filter(({ simulationStatus }) => simulationStatus === "passed")
        .length ||
    deferredUntilApprovalCount !==
      routes.filter(
        ({ simulationStatus }) =>
          simulationStatus === "deferred_until_approval",
      ).length ||
    !Array.isArray(value.rankedRoutes) ||
    value.rankedRoutes.length !== routes.length
  ) {
    return v2ResponseError();
  }
  const rankedRoutes = value.rankedRoutes.map((ranked, index) => {
    if (!isRecord(ranked)) return v2ResponseError();
    const route = routes[index];
    if (
      ranked.rank !== index + 1 ||
      ranked.protocolId !== route.protocolId ||
      ranked.name !== route.name ||
      ranked.guaranteedNetMinimumAtomic !==
        route.economics.netMinimumAmountOut ||
      ranked.quotedGrossAmountAtomic !== route.economics.quotedGrossAmountOut ||
      ranked.simulationStatus !== route.simulationStatus
    ) {
      return v2ResponseError();
    }
    return {
      rank: index + 1,
      protocolId: route.protocolId,
      name: route.name,
      guaranteedNetMinimumAtomic: route.economics.netMinimumAmountOut,
      quotedGrossAmountAtomic: route.economics.quotedGrossAmountOut,
      simulationStatus: route.simulationStatus,
    };
  });
  return {
    policyVersion: "base_intent_v2_net_floor_v1" as const,
    stage: "final_routes_after_intent_v2_runtime_and_simulation" as const,
    primaryMetric: "guaranteed_net_minimum_amount_out" as const,
    direction: "descending" as const,
    eligibleRouteCount,
    simulationPassedCount,
    deferredUntilApprovalCount,
    gasCostNormalized: false as const,
    executionLatencyNormalized: false as const,
    limitation: value.limitation,
    rankedRoutes,
  };
}

function checkedV2QuoteCoverage(
  value: unknown,
  routes: readonly CheckedV2Route[],
  minimumQuotedRouteCount: number,
) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, V2_QUOTE_COVERAGE_KEYS) ||
    !Array.isArray(value.sources) ||
    value.sources.length !== V2_QUOTE_SOURCE_ORDER.length
  ) {
    return v2ResponseError();
  }
  const requestedSourceCount = checkedV2Count(value.requestedSourceCount);
  const responsiveSourceCount = checkedV2Count(value.responsiveSourceCount);
  const sourceWithRoutesCount = checkedV2Count(value.sourceWithRoutesCount);
  const unavailableSourceCount = checkedV2Count(value.unavailableSourceCount);
  const totalQuotedRouteCount = checkedV2Count(value.totalQuotedRouteCount);
  const totalAttemptedQuoteCount = checkedV2Count(
    value.totalAttemptedQuoteCount,
  );
  const totalSuccessfulQuoteReadCount = checkedV2Count(
    value.totalSuccessfulQuoteReadCount,
  );
  const sources = value.sources.map((source, index) => {
    if (!isRecord(source)) return v2ResponseError();
    const quotedRouteCount = checkedV2Count(source.quotedRouteCount);
    const attemptedQuoteCount = checkedV2Count(source.attemptedQuoteCount);
    const successfulQuoteReadCount = checkedV2Count(
      source.successfulQuoteReadCount,
    );
    if (
      source.source !== V2_QUOTE_SOURCE_ORDER[index] ||
      (source.status !== "quoted" &&
        source.status !== "empty" &&
        source.status !== "unavailable") ||
      (source.status === "quoted"
        ? quotedRouteCount === 0
        : quotedRouteCount !== 0) ||
      attemptedQuoteCount < successfulQuoteReadCount ||
      successfulQuoteReadCount < quotedRouteCount
    ) {
      return v2ResponseError();
    }
    return {
      source: V2_QUOTE_SOURCE_ORDER[index],
      status: source.status,
      quotedRouteCount,
      attemptedQuoteCount,
      successfulQuoteReadCount,
    };
  });
  const summedQuoted = sources.reduce(
    (total, source) => total + source.quotedRouteCount,
    0,
  );
  const summedAttempted = sources.reduce(
    (total, source) => total + source.attemptedQuoteCount,
    0,
  );
  const summedSuccessful = sources.reduce(
    (total, source) => total + source.successfulQuoteReadCount,
    0,
  );
  const expectedResponsive = sources.filter(
    ({ status }) => status !== "unavailable",
  ).length;
  const expectedWithRoutes = sources.filter(
    ({ status }) => status === "quoted",
  ).length;
  const expectedUnavailable = sources.filter(
    ({ status }) => status === "unavailable",
  ).length;
  const requiredSources = new Set(
    routes.map(({ route }) => String(route.quoteSource)),
  );
  if (
    requestedSourceCount !== V2_QUOTE_SOURCE_ORDER.length ||
    responsiveSourceCount !== expectedResponsive ||
    sourceWithRoutesCount !== expectedWithRoutes ||
    unavailableSourceCount !== expectedUnavailable ||
    totalQuotedRouteCount !== summedQuoted ||
    totalAttemptedQuoteCount !== summedAttempted ||
    totalSuccessfulQuoteReadCount !== summedSuccessful ||
    totalQuotedRouteCount < minimumQuotedRouteCount ||
    [...requiredSources].some(
      (requiredSource) =>
        !sources.some(
          (source) =>
            source.source === requiredSource &&
            source.status === "quoted" &&
            source.quotedRouteCount > 0,
        ),
    )
  ) {
    return v2ResponseError();
  }
  return {
    requestedSourceCount,
    responsiveSourceCount,
    sourceWithRoutesCount,
    unavailableSourceCount,
    totalQuotedRouteCount,
    totalAttemptedQuoteCount,
    totalSuccessfulQuoteReadCount,
    sources,
  };
}

export function createBaseIntentV2Envelope(
  rawResult: ResultLike,
  requestId: string,
  userAddress: Address,
  config: IntentV2ExecutionConfig,
  entityResolution?: UnknownRecord,
) {
  if (
    rawResult.actionType !== "swap" ||
    (rawResult.action !== undefined && rawResult.action !== "swap") ||
    !Array.isArray(rawResult.allRoutes) ||
    rawResult.allRoutes.length === 0 ||
    rawResult.allRoutes.length > MAX_BASE_INTENT_V2_ROUTES
  ) {
    return v2ResponseError();
  }
  const routes = rawResult.allRoutes.map((route) => {
    if (!isRecord(route)) return v2ResponseError();
    return normalizeV2Route(route, {
      action: "swap",
      network: "base",
      requestId,
      userAddress,
      config,
    });
  });
  requireSharedV2Intent(routes);
  const winner = routes[0];
  assertV2EntityResolutionBinding(entityResolution, winner.intent);
  const rawTarget = checkedV2Address(
    rawResult.targetContract || rawResult.target,
  );
  const calldata = checkedCalldata(rawResult.calldata, "transaction.calldata");
  const value = decimalValue(rawResult.value, "transaction.value");
  const amountInWei = decimalValue(
    rawResult.amountInWei,
    "transaction.amountInWei",
  );
  const approvals = checkedV2Approvals(
    rawResult.approvals,
    winner.router,
    winner.intent,
  );
  const nativeInput = sameAddress(winner.intent.tokenIn, NATIVE_TOKEN_SENTINEL);
  if (
    rawResult.winner !== winner.name ||
    rawResult.expectedOutput !== winner.expectedOutput ||
    rawResult.routePath !== winner.routePath ||
    !sameAddress(rawTarget, winner.router) ||
    !sameHex(calldata, winner.calldata) ||
    value !== winner.value ||
    amountInWei !== winner.intent.amountIn ||
    rawResult.isNativeIn !== nativeInput ||
    rawResult.quoteExpiresAt !== winner.quoteExpiresAt ||
    !sameV2Approvals(approvals, winner.approvals) ||
    (nativeInput
      ? rawResult.tokenInAddress !== undefined
      : !sameAddress(
          checkedV2Address(rawResult.tokenInAddress),
          winner.intent.tokenIn,
        ))
  ) {
    return v2ResponseError();
  }
  const coverage = checkedV2Coverage(rawResult.intentRouterV2Coverage, routes);
  const rankingEvidence = checkedV2Ranking(rawResult.rankingEvidence, routes);
  const quoteCoverage = checkedV2QuoteCoverage(
    rawResult.quoteCoverage,
    routes,
    coverage.quotedRouteCount,
  );

  const winnerMessage =
    typeof rawResult.winnerMessage === "string" &&
    rawResult.winnerMessage.trim().length > 0 &&
    rawResult.winnerMessage.trim().length <= 2_000
      ? rawResult.winnerMessage.trim()
      : undefined;
  return {
    status: "success",
    action: "swap",
    actionType: "swap",
    executionMode: BASE_INTENT_V2_EXECUTION_MODE,
    winner: winner.name,
    expectedOutput: winner.expectedOutput,
    routePath: winner.routePath,
    target: winner.router,
    targetContract: winner.router,
    calldata: winner.calldata,
    value: winner.value,
    amountInWei: winner.intent.amountIn,
    isNativeIn: nativeInput,
    tokenInAddress: nativeInput ? undefined : winner.intent.tokenIn,
    approvals,
    allRoutes: routes.map(({ route }) => route),
    intentRouterV2Coverage: coverage,
    quoteCoverage,
    rankingEvidence,
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt: winner.quoteExpiresAt,
    ...(entityResolution ? { entityResolution } : {}),
    ...(winnerMessage ? { winnerMessage } : {}),
  };
}

export function hasBaseIntentV2Marker(rawResult: ResultLike): boolean {
  return (
    rawResult.executionMode === BASE_INTENT_V2_EXECUTION_MODE ||
    rawResult.intentRouterV2Coverage !== undefined ||
    (Array.isArray(rawResult.allRoutes) &&
      rawResult.allRoutes.some(
        (route) =>
          isRecord(route) &&
          (route.executionMode === BASE_INTENT_V2_EXECUTION_MODE ||
            route.adapterKind !== undefined ||
            route.adapterDataEncoding !== undefined),
      ))
  );
}
