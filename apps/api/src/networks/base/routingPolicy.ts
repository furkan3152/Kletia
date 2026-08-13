export const SWAP_QUOTE_SOURCES = {
  aerodrome: "aerodrome",
  standardAmm: "standard_amm",
  v3Amm: "v3_amm",
} as const;

export type SwapQuoteSource =
  (typeof SWAP_QUOTE_SOURCES)[keyof typeof SWAP_QUOTE_SOURCES];

export type SwapSimulationStatus = "passed" | "deferred_until_approval";

export interface SwapRouteForRanking {
  readonly name: string;
  readonly amountOut: bigint;
  readonly simulationStatus: SwapSimulationStatus;
  readonly quoteSource?: string;
  readonly router?: unknown;
  readonly routePath?: unknown;
  readonly calldata?: unknown;
  readonly estimatedGasUnits?: string | null;
}

export interface QuoteSourceCoverageInput {
  readonly source: string;
  readonly result: PromiseSettledResult<readonly unknown[]>;
}

export interface QuoteSourceCoverage {
  readonly source: string;
  readonly status: "quoted" | "empty" | "unavailable";
  readonly quotedRouteCount: number;
  readonly attemptedQuoteCount: number;
  readonly successfulQuoteReadCount: number;
  readonly protocols?: readonly QuoteProtocolCoverage[];
}

export interface QuoteProtocolCoverage {
  readonly protocolId: string;
  readonly protocolName: string;
  readonly router: string;
  readonly status: "quoted" | "empty" | "unavailable";
  readonly attemptedQuoteCount: number;
  readonly successfulQuoteReadCount: number;
  readonly failedQuoteReadCount: number;
  readonly quotedRouteCount: number;
  readonly selectedRouteCount: number;
}

export interface SwapQuoteCoverage {
  readonly requestedSourceCount: number;
  readonly responsiveSourceCount: number;
  readonly sourceWithRoutesCount: number;
  readonly unavailableSourceCount: number;
  readonly totalQuotedRouteCount: number;
  readonly totalAttemptedQuoteCount: number;
  readonly totalSuccessfulQuoteReadCount: number;
  readonly sources: readonly QuoteSourceCoverage[];
}

export type SwapRankingStage =
  | "protocol_quotes_after_simulation_before_fee_wrapper"
  | "final_routes_after_fee_router_allowlist_and_simulation";

const ROUTING_LIMITATION =
  "Routes must first satisfy the strongest available simulation evidence, " +
  "then they are ranked by quoted token output. Quoter gas is only a tie-breaker; " +
  "gas is not converted into the output asset and this is not a profitability estimate.";

function invalidSlippage(): Error {
  return Object.assign(
    new Error(
      "Slippage must be between 0.01% and 10% with up to two decimal places.",
    ),
    { code: "INVALID_SLIPPAGE", statusCode: 400 },
  );
}

export function parseSlippageBps(input?: string): number {
  const normalized = input === undefined ? "1" : input.trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(normalized);
  if (!match) throw invalidSlippage();

  const wholeBps = BigInt(match[1]) * 100n;
  const fractionalDigits = match[2] ?? "";
  const fractionalBps =
    fractionalDigits.length === 0
      ? 0n
      : BigInt(fractionalDigits.padEnd(2, "0"));
  const basisPoints = wholeBps + fractionalBps;

  if (basisPoints < 1n || basisPoints > 1_000n) {
    throw invalidSlippage();
  }

  return Number(basisPoints);
}

function assertRankableRoute(
  route: SwapRouteForRanking,
): asserts route is SwapRouteForRanking {
  if (
    typeof route.name !== "string" ||
    route.name.length === 0 ||
    typeof route.amountOut !== "bigint" ||
    route.amountOut < 0n ||
    (route.simulationStatus !== "passed" &&
      route.simulationStatus !== "deferred_until_approval")
  ) {
    throw Object.assign(
      new Error("A swap quote is missing deterministic ranking evidence."),
      { code: "INVALID_ROUTE_QUOTE", statusCode: 500 },
    );
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function deterministicRouteKey(route: SwapRouteForRanking): string {
  return [
    route.name,
    String(route.quoteSource ?? ""),
    String(route.router ?? ""),
    String(route.routePath ?? ""),
    String(route.calldata ?? ""),
  ].join("\u0000");
}

export function rankSwapRoutes<T extends SwapRouteForRanking>(
  routes: readonly T[],
): T[] {
  for (const route of routes) assertRankableRoute(route);

  return [...routes].sort((left, right) => {
    const leftSimulationRank = left.simulationStatus === "passed" ? 0 : 1;
    const rightSimulationRank = right.simulationStatus === "passed" ? 0 : 1;
    if (leftSimulationRank !== rightSimulationRank) {
      return leftSimulationRank - rightSimulationRank;
    }

    if (left.amountOut !== right.amountOut) {
      return left.amountOut > right.amountOut ? -1 : 1;
    }

    const leftGas =
      typeof left.estimatedGasUnits === "string" &&
      /^\d+$/.test(left.estimatedGasUnits)
        ? BigInt(left.estimatedGasUnits)
        : null;
    const rightGas =
      typeof right.estimatedGasUnits === "string" &&
      /^\d+$/.test(right.estimatedGasUnits)
        ? BigInt(right.estimatedGasUnits)
        : null;
    if (leftGas !== null || rightGas !== null) {
      if (leftGas === null) return 1;
      if (rightGas === null) return -1;
      if (leftGas !== rightGas) return leftGas < rightGas ? -1 : 1;
    }

    const nameOrder = compareText(left.name, right.name);
    if (nameOrder !== 0) return nameOrder;

    return compareText(
      deterministicRouteKey(left),
      deterministicRouteKey(right),
    );
  });
}

export function summarizeQuoteCoverage(
  inputs: readonly QuoteSourceCoverageInput[],
): SwapQuoteCoverage {
  const sources = inputs.map(({ source, result }): QuoteSourceCoverage => {
    if (result.status === "rejected") {
      return {
        source,
        status: "unavailable",
        quotedRouteCount: 0,
        attemptedQuoteCount: 0,
        successfulQuoteReadCount: 0,
      };
    }

    const quotedRouteCount = result.value.length;
    const diagnostics = (
      result.value as readonly unknown[] & {
        quoteDiagnostics?: {
          attemptedQuoteCount?: unknown;
          successfulQuoteReadCount?: unknown;
          protocols?: readonly QuoteProtocolCoverage[];
        };
      }
    ).quoteDiagnostics;
    const attemptedQuoteCount =
      typeof diagnostics?.attemptedQuoteCount === "number" &&
      Number.isSafeInteger(diagnostics.attemptedQuoteCount) &&
      diagnostics.attemptedQuoteCount >= quotedRouteCount
        ? diagnostics.attemptedQuoteCount
        : quotedRouteCount;
    const successfulQuoteReadCount =
      typeof diagnostics?.successfulQuoteReadCount === "number" &&
      Number.isSafeInteger(diagnostics.successfulQuoteReadCount) &&
      diagnostics.successfulQuoteReadCount >= quotedRouteCount
        ? diagnostics.successfulQuoteReadCount
        : quotedRouteCount;
    return {
      source,
      status: quotedRouteCount > 0 ? "quoted" : "empty",
      quotedRouteCount,
      attemptedQuoteCount,
      successfulQuoteReadCount,
      ...(diagnostics?.protocols ? { protocols: diagnostics.protocols } : {}),
    };
  });

  return {
    requestedSourceCount: sources.length,
    responsiveSourceCount: sources.filter(
      ({ status }) => status !== "unavailable",
    ).length,
    sourceWithRoutesCount: sources.filter(({ status }) => status === "quoted")
      .length,
    unavailableSourceCount: sources.filter(
      ({ status }) => status === "unavailable",
    ).length,
    totalQuotedRouteCount: sources.reduce(
      (total, source) => total + source.quotedRouteCount,
      0,
    ),
    totalAttemptedQuoteCount: sources.reduce(
      (total, source) => total + source.attemptedQuoteCount,
      0,
    ),
    totalSuccessfulQuoteReadCount: sources.reduce(
      (total, source) => total + source.successfulQuoteReadCount,
      0,
    ),
    sources,
  };
}

export function buildSwapRankingEvidence<T extends SwapRouteForRanking>(
  rankedRoutes: readonly T[],
  protocolRestriction?: string,
  stage: SwapRankingStage = "protocol_quotes_after_simulation_before_fee_wrapper",
) {
  for (const route of rankedRoutes) assertRankableRoute(route);

  return {
    policyVersion: "base_route_efficiency_v2" as const,
    stage,
    primaryMetric: "simulation_evidence_then_quoted_amount_out" as const,
    direction: "descending" as const,
    tieBreakers: [
      "simulation_passed_first",
      "quoted_amount_out_descending",
      "lower_quoter_gas_when_comparable",
      "route_name_ascending",
    ] as const,
    protocolRestriction:
      protocolRestriction && protocolRestriction !== "unknown"
        ? protocolRestriction
        : null,
    eligibleRouteCount: rankedRoutes.length,
    simulationPassedCount: rankedRoutes.filter(
      ({ simulationStatus }) => simulationStatus === "passed",
    ).length,
    deferredUntilApprovalCount: rankedRoutes.filter(
      ({ simulationStatus }) => simulationStatus === "deferred_until_approval",
    ).length,
    rankedRoutes: rankedRoutes.map((route, index) => ({
      rank: index + 1,
      name: route.name,
      quoteSource: route.quoteSource ?? "unknown",
      quotedAmountOutAtomic: route.amountOut.toString(),
      simulationStatus: route.simulationStatus,
      estimatedGasUnits: route.estimatedGasUnits ?? null,
    })),
    gasCostNormalized: false as const,
    gasEstimateTieBreaker: true as const,
    executionLatencyNormalized: false as const,
    limitation: ROUTING_LIMITATION,
  };
}

export function swapRoutingLimitation(): string {
  return ROUTING_LIMITATION;
}
