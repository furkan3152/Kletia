/**
 * Live market snapshots per protocol.
 */
import { erc20Abi, type Address } from "viem";
import { basePublicClient } from "../../../../shared/config/client.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
  getBaseTokenDefinition,
  normalizeBaseProtocolId,
  type BaseRiskTier,
} from "../../protocols.js";
import type {
  BaseLendingAction,
  BaseLendingRoute,
} from "../../intent/routeTypes.js";
import {
  AAVE_DATA_PROVIDER_ABI,
  COMET_ABI,
  ERC4626_ABI,
  MOONWELL_COMPTROLLER_ABI,
  MOONWELL_MARKET_ABI,
  RAY,
  SECONDS_PER_YEAR,
  WAD,
} from "./abis.js";

export interface LendingMarketSnapshot {
  readonly protocolId: BaseLendingRoute["protocolId"];
  readonly name: string;
  readonly router: Address;
  readonly riskTier: BaseRiskTier;
  readonly token: Address;
  readonly active: boolean;
  readonly frozen: boolean;
  readonly borrowingEnabled: boolean;
  readonly supplyRateBps: number | null;
  readonly borrowRateBps: number | null;
  readonly availableLiquidityAtomic: bigint | null;
  readonly positionAtomic: bigint | null;
  readonly debtAtomic: bigint | null;
  readonly maxDepositAtomic: bigint | null;
  readonly supportedActions: readonly BaseLendingAction[];
  readonly actionEnabled: Readonly<Record<BaseLendingAction, boolean>>;
  readonly observedAt: string;
}

export interface BaseLendingOpportunity {
  readonly protocolId: BaseLendingRoute["protocolId"];
  readonly name: string;
  readonly assetSymbol: string;
  readonly target: Address;
  readonly riskTier: BaseRiskTier;
  readonly supplyRateBps: number | null;
  readonly borrowRateBps: number | null;
  readonly availableLiquidityAtomic: string | null;
  readonly observedAt: string;
  readonly executionReady: true;
  readonly executionMode: "direct";
  readonly borrowingEnabled: boolean;
}

function annualizedWadRateBps(ratePerSecond: bigint): number {
  return Number((ratePerSecond * SECONDS_PER_YEAR * 10_000n) / WAD);
}

function rayRateBps(annualRate: bigint): number {
  return Number((annualRate * 10_000n) / RAY);
}

export function minBigInt(...values: bigint[]): bigint {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function protocolMatches(
  snapshot: LendingMarketSnapshot,
  requestedProtocol?: string,
): boolean {
  const requested = normalizeBaseProtocolId(requestedProtocol);
  return !requested || requested === snapshot.protocolId;
}

async function readAaveSnapshot(
  token: Address,
  riskTier: BaseRiskTier,
  user?: Address,
): Promise<LendingMarketSnapshot> {
  const [configuration, reserveData, reserveTokens, reserveCaps, isPaused] =
    await Promise.all([
      basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveConfigurationData",
        args: [token],
      }),
      basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [token],
      }),
      basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveTokensAddresses",
        args: [token],
      }),
      basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveCaps",
        args: [token],
      }),
      basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getPaused",
        args: [token],
      }),
    ]);

  const [reserveDecimals, , , , , , borrowingEnabled, , isActive, isFrozen] =
    configuration;
  const [
    ,
    ,
    totalAToken,
    totalStableDebt,
    totalVariableDebt,
    liquidityRate,
    variableBorrowRate,
  ] = reserveData;
  const [aTokenAddress, , variableDebtTokenAddress] = reserveTokens;
  const [borrowCap, supplyCap] = reserveCaps;

  const [availableLiquidityAtomic, positionAtomic, debtAtomic] =
    await Promise.all([
      basePublicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [aTokenAddress],
      }),
      user
        ? basePublicClient.readContract({
            address: aTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [user],
          })
        : Promise.resolve(null),
      user
        ? basePublicClient.readContract({
            address: variableDebtTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [user],
          })
        : Promise.resolve(null),
    ]);

  const unit = 10n ** reserveDecimals;
  const supplyCapRemaining =
    supplyCap === 0n
      ? null
      : supplyCap * unit > totalAToken
        ? supplyCap * unit - totalAToken
        : 0n;
  const totalDebt = totalStableDebt + totalVariableDebt;
  const borrowCapRemaining =
    borrowCap === 0n
      ? null
      : borrowCap * unit > totalDebt
        ? borrowCap * unit - totalDebt
        : 0n;
  const borrowLiquidity =
    borrowCapRemaining === null
      ? availableLiquidityAtomic
      : minBigInt(availableLiquidityAtomic, borrowCapRemaining);

  return {
    protocolId: "aave-v3",
    name: "Aave V3",
    router: AAVE_V3_BASE.pool,
    riskTier,
    token,
    active: isActive && !isPaused,
    frozen: isFrozen,
    borrowingEnabled,
    supplyRateBps: rayRateBps(liquidityRate),
    borrowRateBps: rayRateBps(variableBorrowRate),
    availableLiquidityAtomic: borrowLiquidity,
    positionAtomic,
    debtAtomic,
    maxDepositAtomic: supplyCapRemaining,
    supportedActions: ["lend", "borrow", "repay", "withdraw"],
    actionEnabled: {
      lend: isActive && !isPaused && !isFrozen,
      borrow: isActive && !isPaused && !isFrozen && borrowingEnabled,
      repay: isActive && !isPaused,
      withdraw: isActive && !isPaused,
    },
    observedAt: new Date().toISOString(),
  };
}

async function readMoonwellSnapshot(
  token: Address,
  market: Address,
  riskTier: BaseRiskTier,
  user?: Address,
): Promise<LendingMarketSnapshot> {
  const [
    listedMarkets,
    underlying,
    supplyRate,
    borrowRate,
    availableLiquidityAtomic,
    mintPaused,
    borrowPaused,
    supplyCap,
    borrowCap,
    totalSupply,
    totalBorrows,
    exchangeRate,
    positionAtomic,
    debtAtomic,
  ] = await Promise.all([
    basePublicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "getAllMarkets",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "underlying",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "supplyRatePerTimestamp",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "borrowRatePerTimestamp",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "getCash",
    }),
    basePublicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "mintGuardianPaused",
      args: [market],
    }),
    basePublicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "borrowGuardianPaused",
      args: [market],
    }),
    basePublicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "supplyCaps",
      args: [market],
    }),
    basePublicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "borrowCaps",
      args: [market],
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "totalSupply",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "totalBorrows",
    }),
    basePublicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "exchangeRateStored",
    }),
    user
      ? basePublicClient.readContract({
          address: market,
          abi: MOONWELL_MARKET_ABI,
          functionName: "balanceOfUnderlying",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? basePublicClient.readContract({
          address: market,
          abi: MOONWELL_MARKET_ABI,
          functionName: "borrowBalanceCurrent",
          args: [user],
        })
      : Promise.resolve(null),
  ]);

  const isListed = listedMarkets.some(
    (listed) => listed.toLowerCase() === market.toLowerCase(),
  );
  if (underlying.toLowerCase() !== token.toLowerCase()) {
    throw new Error("Moonwell market underlying does not match registry.");
  }
  const totalSuppliedUnderlying = (totalSupply * exchangeRate) / WAD;
  const maxDepositAtomic =
    supplyCap === 0n
      ? null
      : supplyCap > totalSuppliedUnderlying
        ? supplyCap - totalSuppliedUnderlying
        : 0n;
  const borrowCapRemaining =
    borrowCap === 0n
      ? null
      : borrowCap > totalBorrows
        ? borrowCap - totalBorrows
        : 0n;
  const borrowLiquidity =
    borrowCapRemaining === null
      ? availableLiquidityAtomic
      : minBigInt(availableLiquidityAtomic, borrowCapRemaining);
  const canBorrow =
    isListed &&
    !borrowPaused &&
    (borrowCapRemaining === null || borrowCapRemaining > 0n);

  return {
    protocolId: "moonwell",
    name: "Moonwell",
    router: market,
    riskTier,
    token,
    active: isListed,
    frozen: mintPaused,
    borrowingEnabled: canBorrow,
    supplyRateBps: annualizedWadRateBps(supplyRate),
    borrowRateBps: annualizedWadRateBps(borrowRate),
    availableLiquidityAtomic: borrowLiquidity,
    positionAtomic,
    debtAtomic,
    maxDepositAtomic,
    supportedActions: ["lend", "borrow", "repay", "withdraw"],
    actionEnabled: {
      lend:
        isListed &&
        !mintPaused &&
        (maxDepositAtomic === null || maxDepositAtomic > 0n),
      borrow: canBorrow,
      repay: isListed,
      withdraw: isListed,
    },
    observedAt: new Date().toISOString(),
  };
}

async function readCompoundSnapshot(
  token: Address,
  market: Address,
  riskTier: BaseRiskTier,
  user?: Address,
): Promise<LendingMarketSnapshot> {
  const [baseToken, utilization, supplyPaused, withdrawPaused] =
    await Promise.all([
      basePublicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "baseToken",
      }),
      basePublicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "getUtilization",
      }),
      basePublicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "isSupplyPaused",
      }),
      basePublicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "isWithdrawPaused",
      }),
    ]);
  if (baseToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error("Compound Comet base token does not match registry.");
  }

  const [
    supplyRate,
    borrowRate,
    availableLiquidityAtomic,
    positionAtomic,
    debtAtomic,
  ] = await Promise.all([
    basePublicClient.readContract({
      address: market,
      abi: COMET_ABI,
      functionName: "getSupplyRate",
      args: [utilization],
    }),
    basePublicClient.readContract({
      address: market,
      abi: COMET_ABI,
      functionName: "getBorrowRate",
      args: [utilization],
    }),
    basePublicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [market],
    }),
    user
      ? basePublicClient.readContract({
          address: market,
          abi: COMET_ABI,
          functionName: "balanceOf",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? basePublicClient.readContract({
          address: market,
          abi: COMET_ABI,
          functionName: "borrowBalanceOf",
          args: [user],
        })
      : Promise.resolve(null),
  ]);

  return {
    protocolId: "compound-v3",
    name: "Compound V3",
    router: market,
    riskTier,
    token,
    active: true,
    frozen: supplyPaused,
    borrowingEnabled: !withdrawPaused,
    supplyRateBps: annualizedWadRateBps(supplyRate),
    borrowRateBps: annualizedWadRateBps(borrowRate),
    availableLiquidityAtomic,
    positionAtomic,
    debtAtomic,
    maxDepositAtomic: null,
    supportedActions: ["lend", "borrow", "repay", "withdraw"],
    actionEnabled: {
      lend: !supplyPaused,
      borrow: !withdrawPaused,
      repay: !supplyPaused,
      withdraw: !withdrawPaused,
    },
    observedAt: new Date().toISOString(),
  };
}

async function readErc4626Snapshot(
  token: Address,
  vault: Address,
  protocolId: Extract<
    BaseLendingRoute["protocolId"],
    "moonwell-vault" | "seamless-vault" | "spark-vault" | "fluid-vault"
  >,
  name: string,
  riskTier: BaseRiskTier,
  user?: Address,
): Promise<LendingMarketSnapshot> {
  const [asset, maxDepositAtomic, maxWithdrawAtomic] = await Promise.all([
    basePublicClient.readContract({
      address: vault,
      abi: ERC4626_ABI,
      functionName: "asset",
    }),
    user
      ? basePublicClient.readContract({
          address: vault,
          abi: ERC4626_ABI,
          functionName: "maxDeposit",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? basePublicClient.readContract({
          address: vault,
          abi: ERC4626_ABI,
          functionName: "maxWithdraw",
          args: [user],
        })
      : Promise.resolve(null),
  ]);
  if (asset.toLowerCase() !== token.toLowerCase()) {
    throw new Error("ERC-4626 vault asset does not match registry.");
  }
  return {
    protocolId,
    name,
    router: vault,
    riskTier,
    token,
    active: true,
    frozen: maxDepositAtomic === 0n,
    borrowingEnabled: false,
    supplyRateBps: null,
    borrowRateBps: null,
    availableLiquidityAtomic: maxWithdrawAtomic,
    positionAtomic: maxWithdrawAtomic,
    debtAtomic: 0n,
    maxDepositAtomic,
    supportedActions: ["lend", "withdraw"],
    actionEnabled: {
      lend: maxDepositAtomic === null || maxDepositAtomic > 0n,
      borrow: false,
      repay: false,
      withdraw: maxWithdrawAtomic === null || maxWithdrawAtomic > 0n,
    },
    observedAt: new Date().toISOString(),
  };
}

export async function collectMarketSnapshots(
  tokenSymbol: string,
  user?: Address,
  requestedProtocol?: string,
): Promise<LendingMarketSnapshot[]> {
  const safeSymbol =
    tokenSymbol.toUpperCase() === "ETH" ? "WETH" : tokenSymbol.toUpperCase();
  const definition = getBaseTokenDefinition(safeSymbol);
  if (!definition) {
    throw new Error(
      `Kletia does not have a verified Base registry entry for ${safeSymbol}.`,
    );
  }

  const tasks: Array<Promise<LendingMarketSnapshot>> = [];
  const aaveReserve = AAVE_V3_BASE.reserves.find(
    ({ token }) => token === safeSymbol,
  );
  if (aaveReserve) {
    tasks.push(
      readAaveSnapshot(definition.address, aaveReserve.riskTier, user),
    );
  }
  const moonwell = MOONWELL_BASE.markets.find(
    ({ token }) => token === safeSymbol,
  );
  if (moonwell) {
    tasks.push(
      readMoonwellSnapshot(
        definition.address,
        moonwell.market,
        moonwell.riskTier,
        user,
      ),
    );
  }
  for (const market of COMPOUND_V3_BASE.markets.filter(
    ({ token }) => token === safeSymbol,
  )) {
    tasks.push(
      readCompoundSnapshot(
        definition.address,
        market.comet,
        market.riskTier,
        user,
      ),
    );
  }
  for (const vault of BASE_ERC4626_VAULTS.filter(
    ({ token }) => token === safeSymbol,
  )) {
    tasks.push(
      readErc4626Snapshot(
        definition.address,
        vault.vault,
        vault.protocolId,
        vault.name,
        vault.riskTier,
        user,
      ),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const snapshots = settled
    .filter(
      (result): result is PromiseFulfilledResult<LendingMarketSnapshot> =>
        result.status === "fulfilled",
    )
    .map(({ value }) => value)
    .filter(
      (snapshot) =>
        snapshot.active && protocolMatches(snapshot, requestedProtocol),
    );

  if (snapshots.length === 0) {
    const normalizedProtocol = normalizeBaseProtocolId(requestedProtocol);
    const unavailableAdapters = settled.filter(
      ({ status }) => status === "rejected",
    ).length;
    throw Object.assign(
      new Error(
        normalizedProtocol
          ? `${normalizedProtocol} has no live verified ${safeSymbol} market for this request.`
          : `No live verified lending market responded for ${safeSymbol}.`,
      ),
      {
        code:
          unavailableAdapters > 0
            ? "LENDING_MARKET_READS_UNAVAILABLE"
            : "LENDING_MARKET_UNSUPPORTED",
        statusCode: unavailableAdapters > 0 ? 502 : 400,
      },
    );
  }
  return snapshots;
}
