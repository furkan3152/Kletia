/**
 * Runtime guards for Base liquidity, swap, yield and fee-router evidence.
 */
import { isAddress } from "viem";
import type { RouteData } from "./routes.ts";
import type {
  BaseFeeRouterCoverage,
  BaseLendingOpportunity,
  BaseLiquidityPoolEvidence,
  BaseLiquidityRoutingEvidence,
  BaseSwapQuoteCoverage,
  BaseYieldComparisonCoverage,
  BaseYieldRankingEvidence,
} from "./evidence.ts";
import {
  isCanonicalAddress,
  isNonNegativeInteger,
  isObjectRecord,
  isPositiveAtomicString,
} from "./guardPrimitives.ts";
import type { IntentResponse } from "./intent.ts";

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
