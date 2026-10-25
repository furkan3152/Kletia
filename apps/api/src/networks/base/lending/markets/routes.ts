/**
 * Lending routes, opportunities and their ranking.
 */
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { basePublicClient } from "../../../../shared/config/client.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_TOKEN_REGISTRY,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
  getBaseTokenDefinition,
} from "../../protocols.js";
import type { BaseCallerSemantics } from "../../protocols.js";
import type {
  BaseLendingAction,
  BaseLendingRoute,
  BaseRiskTolerance,
  BaseYieldEconomics,
} from "../../intent/routeTypes.js";
import {
  buildYieldRankingEvidence,
  rankLendingRoutes,
  yieldRoutingLimitation,
} from "../../efficiencyEngine.js";
import {
  AAVE_POOL_ABI,
  COMET_ABI,
  ERC4626_ABI,
  MOONWELL_MARKET_ABI,
} from "./abis.js";
import {
  type BaseLendingOpportunity,
  collectMarketSnapshots,
  type LendingMarketSnapshot,
  minBigInt,
} from "./snapshots.js";

function executionEvidence(callerSemantics: BaseCallerSemantics) {
  return {
    executionMode: "direct" as const,
    callerSemantics,
    feeRouterCompatible: false as const,
    chainId: 8453 as const,
    registryVerified: true as const,
  };
}

function routeEconomics(
  snapshot: LendingMarketSnapshot,
  action: BaseLendingAction,
): BaseYieldEconomics {
  const rateBps =
    action === "lend"
      ? snapshot.supplyRateBps
      : action === "borrow"
        ? snapshot.borrowRateBps
        : null;
  return {
    observedAt: snapshot.observedAt,
    rateKind:
      action === "lend"
        ? "supply_rate"
        : action === "borrow"
          ? "variable_borrow_rate"
          : "position",
    rateBps,
    availableLiquidityAtomic:
      (action === "lend"
        ? snapshot.maxDepositAtomic
        : snapshot.availableLiquidityAtomic
      )?.toString() ?? null,
    positionAtomic: snapshot.positionAtomic?.toString() ?? null,
    debtAtomic: snapshot.debtAtomic?.toString() ?? null,
    estimateStatus:
      rateBps === null && (action === "lend" || action === "borrow")
        ? "partial"
        : "complete",
    limitation: yieldRoutingLimitation(),
  };
}

function formattedRate(rateBps: number | null): string {
  return rateBps === null
    ? "rate unavailable"
    : `${(rateBps / 100).toFixed(2)}% annualized rate snapshot`;
}

function actionAmount(
  action: BaseLendingAction,
  requestedAmount: bigint | null,
  walletBalance: bigint,
  snapshot: LendingMarketSnapshot,
): bigint | null {
  if (action === "lend") {
    const amount = requestedAmount ?? walletBalance;
    return amount > 0n &&
      amount <= walletBalance &&
      (snapshot.maxDepositAtomic === null ||
        amount <= snapshot.maxDepositAtomic)
      ? amount
      : null;
  }
  if (action === "borrow") {
    if (requestedAmount === null) return null;
    if (
      snapshot.availableLiquidityAtomic !== null &&
      requestedAmount > snapshot.availableLiquidityAtomic
    ) {
      return null;
    }
    return requestedAmount;
  }
  if (action === "repay") {
    const debt = snapshot.debtAtomic ?? 0n;
    if (debt <= 0n || walletBalance <= 0n) return null;
    return requestedAmount === null
      ? minBigInt(debt, walletBalance)
      : minBigInt(requestedAmount, debt, walletBalance);
  }
  const position = snapshot.positionAtomic ?? 0n;
  if (position <= 0n) return null;
  const amount = requestedAmount ?? position;
  if (
    amount > position ||
    (snapshot.availableLiquidityAtomic !== null &&
      amount > snapshot.availableLiquidityAtomic)
  ) {
    return null;
  }
  return amount;
}

function buildLendingRoute(
  snapshot: LendingMarketSnapshot,
  action: BaseLendingAction,
  assetSymbol: string,
  amount: bigint,
  decimals: number,
  user: Address,
): BaseLendingRoute {
  const requiresApproval = action === "lend" || action === "repay";
  const tokenAddress = snapshot.token;
  let calldata: `0x${string}`;
  let callerSemantics: BaseCallerSemantics;

  if (snapshot.protocolId === "aave-v3") {
    if (action === "lend") {
      calldata = encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: "supply",
        args: [tokenAddress, amount, user, 0],
      });
      callerSemantics = "on_behalf_of";
    } else if (action === "borrow") {
      calldata = encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: "borrow",
        args: [tokenAddress, amount, 2n, 0, user],
      });
      callerSemantics = "msg_sender_owns_position";
    } else if (action === "repay") {
      calldata = encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: "repay",
        args: [tokenAddress, amount, 2n, user],
      });
      callerSemantics = "on_behalf_of";
    } else {
      calldata = encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: "withdraw",
        args: [tokenAddress, amount, user],
      });
      callerSemantics = "msg_sender_owns_position";
    }
  } else if (snapshot.protocolId === "moonwell") {
    const functionName =
      action === "lend"
        ? "mint"
        : action === "borrow"
          ? "borrow"
          : action === "repay"
            ? "repayBorrow"
            : "redeemUnderlying";
    calldata = encodeFunctionData({
      abi: MOONWELL_MARKET_ABI,
      functionName,
      args: [amount],
    });
    callerSemantics = "msg_sender_owns_position";
  } else if (snapshot.protocolId === "compound-v3") {
    calldata = encodeFunctionData({
      abi: COMET_ABI,
      functionName:
        action === "lend" || action === "repay" ? "supply" : "withdraw",
      args: [tokenAddress, amount],
    });
    callerSemantics = "msg_sender_owns_position";
  } else {
    if (action !== "lend" && action !== "withdraw") {
      throw new Error(`${snapshot.protocolId} does not support ${action}.`);
    }
    calldata =
      action === "lend"
        ? encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "deposit",
            args: [amount, user],
          })
        : encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "withdraw",
            args: [amount, user, user],
          });
    callerSemantics =
      action === "lend" ? "explicit_recipient" : "msg_sender_owns_position";
  }

  const formattedAmount = formatUnits(amount, decimals);
  const economics = routeEconomics(snapshot, action);
  const positionText =
    action === "lend"
      ? formattedRate(snapshot.supplyRateBps)
      : action === "borrow"
        ? formattedRate(snapshot.borrowRateBps)
        : action === "repay"
          ? `observed debt ${formatUnits(snapshot.debtAtomic ?? 0n, decimals)} ${assetSymbol}`
          : `observed supplied position ${formatUnits(snapshot.positionAtomic ?? 0n, decimals)} ${assetSymbol}`;
  const execution = executionEvidence(callerSemantics);

  return {
    name: `${snapshot.name} ${assetSymbol}`,
    protocolId: snapshot.protocolId,
    action,
    assetSymbol,
    riskTier: snapshot.riskTier,
    amount,
    expectedOutput:
      `${action.toUpperCase()} ${formattedAmount} ${assetSymbol} via ` +
      `${snapshot.name}; ${positionText}`,
    routePath:
      `${assetSymbol} ➝ [${snapshot.name} ${action.toUpperCase()}] ` +
      `(${snapshot.riskTier} registry tier)`,
    router: snapshot.router,
    calldata,
    primaryTokenAddress: requiresApproval ? tokenAddress : undefined,
    primaryAmountInWei: requiresApproval ? amount.toString() : undefined,
    approvals: requiresApproval
      ? [
          {
            token: tokenAddress,
            spender: snapshot.router,
            amount: amount.toString(),
            symbol: assetSymbol,
            required: true,
          },
        ]
      : [],
    value: "0",
    execution,
    executionMode: "direct",
    callerSemantics,
    feeRouterCompatible: false,
    simulationReturnPolicy:
      snapshot.protocolId === "moonwell" ? "uint256_zero" : undefined,
    economics,
  };
}

export async function getLendingRoutes(
  action: BaseLendingAction,
  tokenSymbol: string,
  amountStr: string,
  userAddress: string,
  requestedProtocol?: string,
): Promise<BaseLendingRoute[]> {
  const safeSymbol =
    tokenSymbol.toUpperCase() === "ETH" ? "WETH" : tokenSymbol.toUpperCase();
  const definition = getBaseTokenDefinition(safeSymbol);
  if (!definition) {
    throw new Error(
      `Kletia does not have a verified Base registry entry for ${safeSymbol}.`,
    );
  }

  const maxRequested = amountStr.trim().toUpperCase() === "MAX";
  if (action === "borrow" && maxRequested) {
    throw Object.assign(
      new Error("Borrow requires an explicit positive amount; MAX is unsafe."),
      { code: "BORROW_MAX_UNSUPPORTED", statusCode: 400 },
    );
  }
  const requestedAmount = maxRequested
    ? null
    : parseUnits(amountStr || "0", definition.decimals);
  if (requestedAmount !== null && requestedAmount <= 0n) {
    throw Object.assign(
      new Error("AMOUNT_REQUIRED: Amount must be positive or explicitly MAX."),
      { code: "AMOUNT_REQUIRED", statusCode: 400 },
    );
  }

  const user = userAddress as Address;
  const walletBalance =
    action === "lend" || action === "repay"
      ? await basePublicClient.readContract({
          address: definition.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [user],
        })
      : 0n;
  if (
    requestedAmount !== null &&
    (action === "lend" || action === "repay") &&
    walletBalance < requestedAmount
  ) {
    throw Object.assign(
      new Error(
        `INSUFFICIENT_FUNDS: Insufficient ${safeSymbol} balance for ${action}.`,
      ),
      { code: "INSUFFICIENT_FUNDS", statusCode: 400 },
    );
  }

  const snapshots = await collectMarketSnapshots(
    safeSymbol,
    user,
    requestedProtocol,
  );
  const routes = snapshots.flatMap((snapshot) => {
    if (!snapshot.supportedActions.includes(action)) return [];
    if (!snapshot.actionEnabled[action]) return [];
    const amount = actionAmount(
      action,
      requestedAmount,
      walletBalance,
      snapshot,
    );
    return amount && amount > 0n
      ? [
          buildLendingRoute(
            snapshot,
            action,
            definition.symbol,
            amount,
            definition.decimals,
            user,
          ),
        ]
      : [];
  });

  if (routes.length === 0) {
    throw Object.assign(
      new Error(
        `No ${safeSymbol} ${action} route satisfies the live balance, ` +
          "position, market-status and liquidity checks.",
      ),
      { code: "NO_ELIGIBLE_LENDING_ROUTE", statusCode: 400 },
    );
  }
  return routes;
}

export async function getLendingOpportunities(
  tokenSymbol: string,
  requestedProtocol?: string,
  riskTolerance: BaseRiskTolerance = "balanced",
  comparison: "supply" | "borrow" = "supply",
) {
  const safeSymbol =
    tokenSymbol.toUpperCase() === "ETH" ? "WETH" : tokenSymbol.toUpperCase();
  const definition =
    BASE_TOKEN_REGISTRY[safeSymbol as keyof typeof BASE_TOKEN_REGISTRY];
  if (!definition) {
    throw Object.assign(
      new Error(`No verified Base lending registry entry for ${safeSymbol}.`),
      { code: "LENDING_MARKET_UNSUPPORTED", statusCode: 400 },
    );
  }
  const snapshots = await collectMarketSnapshots(
    safeSymbol,
    undefined,
    requestedProtocol,
  );
  const opportunities: BaseLendingOpportunity[] = snapshots
    .filter(({ actionEnabled, borrowingEnabled, borrowRateBps }) =>
      comparison === "supply"
        ? actionEnabled.lend
        : actionEnabled.borrow && borrowingEnabled && borrowRateBps !== null,
    )
    .map((snapshot) => ({
      protocolId: snapshot.protocolId,
      name: snapshot.name,
      assetSymbol: definition.symbol,
      target: snapshot.router,
      riskTier: snapshot.riskTier,
      supplyRateBps: snapshot.supplyRateBps,
      borrowRateBps: snapshot.borrowRateBps,
      availableLiquidityAtomic:
        snapshot.availableLiquidityAtomic?.toString() ?? null,
      observedAt: snapshot.observedAt,
      executionReady: true,
      executionMode: "direct",
      borrowingEnabled: snapshot.borrowingEnabled,
    }));
  if (opportunities.length === 0) {
    throw Object.assign(
      new Error(
        `${requestedProtocol || "Verified Base protocols"} have no ${comparison} comparison for ${definition.symbol}.`,
      ),
      { code: "NO_LENDING_COMPARISON", statusCode: 400 },
    );
  }
  const riskRank = { core: 0, established: 1, elevated: 2 } as const;
  const riskFiltered = opportunities.filter((opportunity) => {
    if (riskTolerance === "aggressive") return true;
    if (riskTolerance === "conservative") {
      return opportunity.riskTier === "core";
    }
    return opportunity.riskTier !== "elevated";
  });
  const ranked = (riskFiltered.length > 0 ? riskFiltered : opportunities).sort(
    (left, right) => {
      const leftRate =
        comparison === "supply" ? left.supplyRateBps : left.borrowRateBps;
      const rightRate =
        comparison === "supply" ? right.supplyRateBps : right.borrowRateBps;
      if (leftRate !== rightRate) {
        if (leftRate === null) return 1;
        if (rightRate === null) return -1;
        return comparison === "supply"
          ? rightRate - leftRate
          : leftRate - rightRate;
      }
      const riskOrder = riskRank[left.riskTier] - riskRank[right.riskTier];
      if (riskOrder !== 0) return riskOrder;
      return left.name.localeCompare(right.name);
    },
  );
  return {
    status: "success",
    action: "yield_compare",
    comparison,
    assetSymbol: definition.symbol,
    riskTolerance,
    observedAt: new Date().toISOString(),
    opportunities: ranked,
    coverage: {
      registeredProtocolCount:
        Number(
          Boolean(
            AAVE_V3_BASE.reserves.find(({ token }) => token === safeSymbol),
          ),
        ) +
        Number(
          Boolean(
            MOONWELL_BASE.markets.find(({ token }) => token === safeSymbol),
          ),
        ) +
        COMPOUND_V3_BASE.markets.filter(({ token }) => token === safeSymbol)
          .length +
        BASE_ERC4626_VAULTS.filter(({ token }) => token === safeSymbol).length,
      responsiveProtocolCount: snapshots.length,
      eligibleProtocolCount: ranked.length,
    },
    winnerMessage:
      `Base ${definition.symbol} live ${comparison}-rate comparison: ` +
      ranked
        .map(
          ({ name, supplyRateBps, borrowRateBps, riskTier }) =>
            `${name} ${
              (comparison === "supply" ? supplyRateBps : borrowRateBps) === null
                ? "rate unavailable"
                : `${
                    (comparison === "supply"
                      ? supplyRateBps!
                      : borrowRateBps!) / 100
                  }%`
            } (${riskTier})`,
        )
        .join(" · ") +
      `\n\n${yieldRoutingLimitation()}`,
  };
}

export function rankVerifiedLendingRoutes(
  routes: readonly BaseLendingRoute[],
  action: BaseLendingAction,
  riskTolerance: BaseRiskTolerance = "balanced",
) {
  const rankedRoutes = rankLendingRoutes(routes, action, riskTolerance);
  return {
    rankedRoutes,
    yieldRankingEvidence: buildYieldRankingEvidence(
      rankedRoutes,
      action,
      riskTolerance,
    ),
  };
}
