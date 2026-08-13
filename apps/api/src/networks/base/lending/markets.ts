import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { publicClient } from "../../../config/client.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_TOKEN_REGISTRY,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
  getBaseTokenDefinition,
  normalizeBaseProtocolId,
  type BaseRiskTier,
} from "../protocols.js";
import type { BaseCallerSemantics } from "../protocols.js";
import type {
  BaseLendingAction,
  BaseLendingRoute,
  BaseRiskTolerance,
  BaseYieldEconomics,
} from "../intent/routeTypes.js";
import {
  buildYieldRankingEvidence,
  rankLendingRoutes,
  yieldRoutingLimitation,
} from "../../../intent/efficiencyEngine.js";

const SECONDS_PER_YEAR = 31_536_000n;
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;

const AAVE_POOL_ABI = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    name: "withdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    name: "borrow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    name: "repay",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const AAVE_DATA_PROVIDER_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveConfigurationData",
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveData",
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveTokensAddresses",
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveCaps",
    outputs: [
      { name: "borrowCap", type: "uint256" },
      { name: "supplyCap", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getPaused",
    outputs: [{ name: "isPaused", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MOONWELL_MARKET_ABI = [
  {
    inputs: [{ name: "mintAmount", type: "uint256" }],
    name: "mint",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    name: "redeemUnderlying",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "borrowAmount", type: "uint256" }],
    name: "borrow",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "repayAmount", type: "uint256" }],
    name: "repayBorrow",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "underlying",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "supplyRatePerTimestamp",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "borrowRatePerTimestamp",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getCash",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "borrowBalanceCurrent",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOfUnderlying",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalBorrows",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "exchangeRateStored",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MOONWELL_COMPTROLLER_ABI = [
  {
    inputs: [],
    name: "getAllMarkets",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "market", type: "address" }],
    name: "mintGuardianPaused",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "market", type: "address" }],
    name: "borrowGuardianPaused",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "market", type: "address" }],
    name: "supplyCaps",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "market", type: "address" }],
    name: "borrowCaps",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const COMET_ABI = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "baseToken",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getUtilization",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "utilization", type: "uint256" }],
    name: "getSupplyRate",
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "utilization", type: "uint256" }],
    name: "getBorrowRate",
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "borrowBalanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "isSupplyPaused",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "isWithdrawPaused",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC4626_ABI = [
  {
    inputs: [],
    name: "asset",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "receiver", type: "address" }],
    name: "maxDeposit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "maxWithdraw",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    name: "withdraw",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface LendingMarketSnapshot {
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

function minBigInt(...values: bigint[]): bigint {
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
      publicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveConfigurationData",
        args: [token],
      }),
      publicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [token],
      }),
      publicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveTokensAddresses",
        args: [token],
      }),
      publicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveCaps",
        args: [token],
      }),
      publicClient.readContract({
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
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [aTokenAddress],
      }),
      user
        ? publicClient.readContract({
            address: aTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [user],
          })
        : Promise.resolve(null),
      user
        ? publicClient.readContract({
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
    publicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "getAllMarkets",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "underlying",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "supplyRatePerTimestamp",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "borrowRatePerTimestamp",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "getCash",
    }),
    publicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "mintGuardianPaused",
      args: [market],
    }),
    publicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "borrowGuardianPaused",
      args: [market],
    }),
    publicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "supplyCaps",
      args: [market],
    }),
    publicClient.readContract({
      address: MOONWELL_BASE.comptroller,
      abi: MOONWELL_COMPTROLLER_ABI,
      functionName: "borrowCaps",
      args: [market],
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "totalBorrows",
    }),
    publicClient.readContract({
      address: market,
      abi: MOONWELL_MARKET_ABI,
      functionName: "exchangeRateStored",
    }),
    user
      ? publicClient.readContract({
          address: market,
          abi: MOONWELL_MARKET_ABI,
          functionName: "balanceOfUnderlying",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? publicClient.readContract({
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
      publicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "baseToken",
      }),
      publicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "getUtilization",
      }),
      publicClient.readContract({
        address: market,
        abi: COMET_ABI,
        functionName: "isSupplyPaused",
      }),
      publicClient.readContract({
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
    publicClient.readContract({
      address: market,
      abi: COMET_ABI,
      functionName: "getSupplyRate",
      args: [utilization],
    }),
    publicClient.readContract({
      address: market,
      abi: COMET_ABI,
      functionName: "getBorrowRate",
      args: [utilization],
    }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [market],
    }),
    user
      ? publicClient.readContract({
          address: market,
          abi: COMET_ABI,
          functionName: "balanceOf",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? publicClient.readContract({
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
    publicClient.readContract({
      address: vault,
      abi: ERC4626_ABI,
      functionName: "asset",
    }),
    user
      ? publicClient.readContract({
          address: vault,
          abi: ERC4626_ABI,
          functionName: "maxDeposit",
          args: [user],
        })
      : Promise.resolve(null),
    user
      ? publicClient.readContract({
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

async function collectMarketSnapshots(
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
      ? await publicClient.readContract({
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
