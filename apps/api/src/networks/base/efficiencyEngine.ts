import type {
  BaseLendingAction,
  BaseLendingRoute,
  BaseRiskTolerance,
  BaseYieldRankingEvidence,
} from "./intent/routeTypes.js";

const RISK_RANK = {
  core: 0,
  established: 1,
  elevated: 2,
} as const;

const YIELD_LIMITATION =
  "Rates and available liquidity are live point-in-time contract reads and can " +
  "change before execution. Gas is not converted into the asset, incentives " +
  "are not projected, and this is not a guaranteed return or borrowing cost.";

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function rateFor(route: BaseLendingRoute): number | null {
  return route.economics.rateBps;
}

function compareOptionalBigInt(
  left: string | null,
  right: string | null,
  direction: "ascending" | "descending",
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) return 0;
  const comparison = leftValue < rightValue ? -1 : 1;
  return direction === "ascending" ? comparison : -comparison;
}

function assertRoute(route: BaseLendingRoute, action: BaseLendingAction) {
  if (
    route.action !== action ||
    route.execution.chainId !== 8453 ||
    route.execution.executionMode !== "direct" ||
    route.executionMode !== "direct" ||
    route.execution.feeRouterCompatible !== false ||
    route.feeRouterCompatible !== false ||
    route.amount <= 0n
  ) {
    throw Object.assign(
      new Error("Lending route is missing Base execution evidence."),
      { code: "INVALID_BASE_LENDING_ROUTE", statusCode: 500 },
    );
  }
}

export function rankLendingRoutes(
  routes: readonly BaseLendingRoute[],
  action: BaseLendingAction,
  riskTolerance: BaseRiskTolerance = "balanced",
): BaseLendingRoute[] {
  for (const route of routes) assertRoute(route, action);

  const eligible = routes.filter((route) => {
    if (riskTolerance === "aggressive") return true;
    if (riskTolerance === "conservative") {
      return route.riskTier === "core";
    }
    return route.riskTier !== "elevated";
  });
  const candidates = eligible.length > 0 ? eligible : routes;

  return [...candidates].sort((left, right) => {
    const leftRate = rateFor(left);
    const rightRate = rateFor(right);

    if (action === "lend" && leftRate !== rightRate) {
      if (leftRate === null) return 1;
      if (rightRate === null) return -1;
      return rightRate - leftRate;
    }
    if (action === "borrow" && leftRate !== rightRate) {
      if (leftRate === null) return 1;
      if (rightRate === null) return -1;
      return leftRate - rightRate;
    }
    if (action === "repay") {
      const debtOrder = compareOptionalBigInt(
        left.economics.debtAtomic,
        right.economics.debtAtomic,
        "descending",
      );
      if (debtOrder !== 0) return debtOrder;
    }
    if (action === "withdraw") {
      const positionOrder = compareOptionalBigInt(
        left.economics.positionAtomic,
        right.economics.positionAtomic,
        "descending",
      );
      if (positionOrder !== 0) return positionOrder;
    }

    const riskOrder = RISK_RANK[left.riskTier] - RISK_RANK[right.riskTier];
    if (riskOrder !== 0) return riskOrder;

    const liquidityOrder = compareOptionalBigInt(
      left.economics.availableLiquidityAtomic,
      right.economics.availableLiquidityAtomic,
      "descending",
    );
    if (liquidityOrder !== 0) return liquidityOrder;

    return compareText(
      `${left.protocolId}:${left.router}:${left.calldata}`,
      `${right.protocolId}:${right.router}:${right.calldata}`,
    );
  });
}

export function buildYieldRankingEvidence(
  rankedRoutes: readonly BaseLendingRoute[],
  action: BaseLendingAction,
  riskTolerance: BaseRiskTolerance = "balanced",
): BaseYieldRankingEvidence {
  const primaryMetric =
    action === "lend"
      ? "supply_rate_bps"
      : action === "borrow"
        ? "borrow_rate_bps"
        : "position";
  const direction = action === "borrow" ? "ascending" : "descending";

  return {
    policyVersion: "base_yield_efficiency_v1",
    action,
    riskTolerance,
    primaryMetric,
    direction,
    gasCostNormalized: false,
    quoteBlockConsistency: "best_effort_live_reads",
    limitation: YIELD_LIMITATION,
    eligibleRouteCount: rankedRoutes.length,
    rankedRoutes: rankedRoutes.map((route, index) => ({
      rank: index + 1,
      protocolId: route.protocolId,
      name: route.name,
      riskTier: route.riskTier,
      rateBps: route.economics.rateBps,
      availableLiquidityAtomic: route.economics.availableLiquidityAtomic,
      positionAtomic: route.economics.positionAtomic,
      debtAtomic: route.economics.debtAtomic,
    })),
  };
}

export function yieldRoutingLimitation(): string {
  return YIELD_LIMITATION;
}
