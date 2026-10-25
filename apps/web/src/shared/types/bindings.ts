/**
 * Base Intent Router V2 response bindings and executable action checks.
 */
import { getAddress, isAddress } from "viem";
import {
  isBaseIntentRouterV2SwapBinding,
} from "../../networks/base/security/intentV2Route.ts";
import type { RouteData } from "./routes.ts";
import { isNonNegativeInteger, isObjectRecord } from "./guardPrimitives.ts";
import { isBaseSwapRoutingEvidence } from "./evidenceGuards.ts";
import type { IntentResponse } from "./intent.ts";

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
  const workflowExecution =
    response.executionKind === "workflow_plan_v1" &&
    response.action?.trim() === "workflow";
  const action = (
    typeof response.actionType === "string" &&
    response.actionType.trim().length > 0
      ? response.actionType
      : response.action
  )?.trim();

  if (!action || route.action !== action) return false;
  if (
    !workflowExecution &&
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
