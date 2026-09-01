import {
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  maxUint256,
  parseUnits,
  type Address,
} from "viem";
import {
  AAVE_V3_DATA_PROVIDER_ABI,
  AAVE_V3_ORACLE_ABI,
  AAVE_V3_POOL_ABI,
} from "../../shared/protocols/aave/abis.js";
import { calculateSafeBorrowCapacity } from "../../shared/protocols/aave/risk.js";
import {
  ARBITRUM_SEPOLIA,
  arbitrumSepoliaPublicClient,
  assertArbitrumSepoliaReadiness,
} from "./config.js";

const RAY = 10n ** 27n;
const TARGET_HEALTH_FACTOR = 160n * 10n ** 16n;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function account(value: unknown): Address {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw controlled("ARBITRUM_SEPOLIA_ACCOUNT_INVALID", "A valid EVM account is required.");
  }
}

function amountAtomic(value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) {
    throw controlled("AMOUNT_REQUIRED", "Enter a positive USDC amount.");
  }
  let parsed: bigint;
  try {
    parsed = parseUnits(raw, 6);
  } catch {
    throw controlled("AMOUNT_INVALID", "USDC supports at most six decimals on Arbitrum Sepolia.");
  }
  if (parsed <= 0n) throw controlled("AMOUNT_REQUIRED", "Enter a positive USDC amount.");
  return parsed;
}

export async function readArbitrumSepoliaPortfolio(userInput: unknown) {
  await assertArbitrumSepoliaReadiness();
  const user = account(userInput);
  const [eth, usdc, reserve] = await Promise.all([
    arbitrumSepoliaPublicClient.getBalance({ address: user }),
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    }),
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.aave.dataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getUserReserveData",
      args: [ARBITRUM_SEPOLIA.usdc, user],
    }),
  ]);
  return {
    schemaVersion: "kletia_arbitrum_sepolia_portfolio_v1" as const,
    network: ARBITRUM_SEPOLIA.id,
    chainId: ARBITRUM_SEPOLIA.chainId,
    userAddress: user,
    balances: {
      ETH: { atomic: eth.toString(), formatted: formatEther(eth) },
      USDC: { atomic: usdc.toString(), formatted: formatUnits(usdc, 6) },
      aUSDC: { atomic: reserve[0].toString(), formatted: formatUnits(reserve[0], 6) },
    },
    mockData: false as const,
    observedAtBlock: (await arbitrumSepoliaPublicClient.getBlockNumber()).toString(),
  };
}

export async function prepareArbitrumSepoliaSupply(input: {
  userAddress?: unknown;
  amount?: unknown;
  requestId?: unknown;
}) {
  await assertArbitrumSepoliaReadiness();
  const user = account(input.userAddress);
  const atomic = amountAtomic(input.amount);
  const requestId = String(input.requestId ?? "").trim();
  if (!UUID_V4_PATTERN.test(requestId)) {
    throw controlled("REQUEST_ID_INVALID", "A valid request ID is required.");
  }
  const [balance, allowance, reserveConfiguration, blockNumber] = await Promise.all([
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    }),
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [user, ARBITRUM_SEPOLIA.aave.pool],
    }),
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.aave.dataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getReserveConfigurationData",
      args: [ARBITRUM_SEPOLIA.usdc],
    }),
    arbitrumSepoliaPublicClient.getBlockNumber(),
  ]);
  if (!reserveConfiguration[8] || reserveConfiguration[9]) {
    throw controlled(
      "AAVE_RESERVE_UNAVAILABLE",
      "The reviewed Aave USDC reserve is inactive or frozen.",
      503,
    );
  }
  if (balance < atomic) {
    throw controlled("INSUFFICIENT_USDC", "Arbitrum Sepolia USDC balance is insufficient.", 409);
  }
  const approval = allowance < atomic
    ? {
        target: ARBITRUM_SEPOLIA.usdc,
        calldata: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [ARBITRUM_SEPOLIA.aave.pool, atomic],
        }),
        value: "0",
        amountAtomic: atomic.toString(),
        spender: ARBITRUM_SEPOLIA.aave.pool,
      }
    : null;
  return {
    schemaVersion: "kletia_arbitrum_sepolia_aave_supply_v1" as const,
    network: ARBITRUM_SEPOLIA.id,
    chainId: ARBITRUM_SEPOLIA.chainId,
    requestId,
    userAddress: user,
    asset: ARBITRUM_SEPOLIA.usdc,
    amountAtomic: atomic.toString(),
    approval,
    execution: {
      target: ARBITRUM_SEPOLIA.aave.pool,
      calldata: encodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        functionName: "supply",
        args: [ARBITRUM_SEPOLIA.usdc, atomic, user, 0],
      }),
      value: "0",
    },
    observedAtBlock: blockNumber.toString(),
    quoteExpiresAt: Date.now() + 60_000,
    requiresExplicitWalletApproval: true as const,
    mockData: false as const,
  };
}

export async function prepareArbitrumSepoliaWithdraw(input: {
  userAddress?: unknown;
  amount?: unknown;
  requestId?: unknown;
}) {
  await assertArbitrumSepoliaReadiness();
  const user = account(input.userAddress);
  const requestId = String(input.requestId ?? "").trim();
  if (!UUID_V4_PATTERN.test(requestId)) {
    throw controlled("REQUEST_ID_INVALID", "A valid request ID is required.");
  }
  const rawAmount = String(input.amount ?? "").trim().toLowerCase();
  const withdrawAll = rawAmount === "max" || rawAmount === "all";
  const requestedAtomic = withdrawAll ? maxUint256 : amountAtomic(input.amount);
  const [reserve, blockNumber] = await Promise.all([
    arbitrumSepoliaPublicClient.readContract({
      address: ARBITRUM_SEPOLIA.aave.dataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getUserReserveData",
      args: [ARBITRUM_SEPOLIA.usdc, user],
    }),
    arbitrumSepoliaPublicClient.getBlockNumber(),
  ]);
  const suppliedAtomic = reserve[0];
  if (suppliedAtomic <= 0n) {
    throw controlled(
      "AAVE_POSITION_EMPTY",
      "No supplied USDC position is available to withdraw.",
      409,
    );
  }
  if (!withdrawAll && requestedAtomic > suppliedAtomic) {
    throw controlled(
      "AAVE_WITHDRAW_EXCEEDS_POSITION",
      "Requested withdrawal exceeds the live supplied USDC position.",
      409,
    );
  }
  return {
    schemaVersion: "kletia_arbitrum_sepolia_aave_withdraw_v1" as const,
    network: ARBITRUM_SEPOLIA.id,
    chainId: ARBITRUM_SEPOLIA.chainId,
    requestId,
    userAddress: user,
    asset: ARBITRUM_SEPOLIA.usdc,
    requestedAmount: withdrawAll ? "max" as const : String(input.amount).trim(),
    suppliedAmountAtomic: suppliedAtomic.toString(),
    execution: {
      target: ARBITRUM_SEPOLIA.aave.pool,
      calldata: encodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        functionName: "withdraw",
        args: [ARBITRUM_SEPOLIA.usdc, requestedAtomic, user],
      }),
      value: "0",
    },
    observedAtBlock: blockNumber.toString(),
    quoteExpiresAt: Date.now() + 60_000,
    requiresExplicitWalletApproval: true as const,
    mockData: false as const,
  };
}

export async function readArbitrumSepoliaBorrowCapacity(userInput: unknown) {
  await assertArbitrumSepoliaReadiness();
  const user = account(userInput);
  const [accountData, reserveConfig, reserveTokens, reserveData, price, blockNumber] =
    await Promise.all([
      arbitrumSepoliaPublicClient.readContract({
        address: ARBITRUM_SEPOLIA.aave.pool,
        abi: AAVE_V3_POOL_ABI,
        functionName: "getUserAccountData",
        args: [user],
      }),
      arbitrumSepoliaPublicClient.readContract({
        address: ARBITRUM_SEPOLIA.aave.dataProvider,
        abi: AAVE_V3_DATA_PROVIDER_ABI,
        functionName: "getReserveConfigurationData",
        args: [ARBITRUM_SEPOLIA.usdc],
      }),
      arbitrumSepoliaPublicClient.readContract({
        address: ARBITRUM_SEPOLIA.aave.dataProvider,
        abi: AAVE_V3_DATA_PROVIDER_ABI,
        functionName: "getReserveTokensAddresses",
        args: [ARBITRUM_SEPOLIA.usdc],
      }),
      arbitrumSepoliaPublicClient.readContract({
        address: ARBITRUM_SEPOLIA.aave.dataProvider,
        abi: AAVE_V3_DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [ARBITRUM_SEPOLIA.usdc],
      }),
      arbitrumSepoliaPublicClient.readContract({
        address: ARBITRUM_SEPOLIA.aave.oracle,
        abi: AAVE_V3_ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [ARBITRUM_SEPOLIA.usdc],
      }),
      arbitrumSepoliaPublicClient.getBlockNumber(),
    ]);
  const availableLiquidity = await arbitrumSepoliaPublicClient.readContract({
    address: ARBITRUM_SEPOLIA.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [reserveTokens[0]],
  });
  if (!reserveConfig[8] || reserveConfig[9]) {
    throw controlled(
      "AAVE_RESERVE_UNAVAILABLE",
      "The reviewed Aave USDC reserve is inactive or frozen.",
      503,
    );
  }
  const calculatedCapacity = calculateSafeBorrowCapacity({
    totalCollateralBase: accountData[0],
    totalDebtBase: accountData[1],
    availableBorrowsBase: accountData[2],
    liquidationThresholdBps: accountData[3],
    assetPriceBase: price,
    assetDecimals: Number(reserveConfig[0]),
    availableLiquidityAtomic: availableLiquidity,
    targetHealthFactorScaled: TARGET_HEALTH_FACTOR,
  });
  const borrowingEnabled = reserveConfig[6] === true;
  const safeAmountAtomic = borrowingEnabled
    ? calculatedCapacity.safeAmountAtomic
    : 0n;
  return {
    schemaVersion: "kletia_arbitrum_sepolia_borrow_capacity_v1" as const,
    network: ARBITRUM_SEPOLIA.id,
    chainId: ARBITRUM_SEPOLIA.chainId,
    userAddress: user,
    protocol: "aave-v3" as const,
    asset: "USDC" as const,
    safeAmountAtomic: safeAmountAtomic.toString(),
    safeAmount: formatUnits(safeAmountAtomic, 6),
    capacityStatus: borrowingEnabled
      ? "theoretical_read_only" as const
      : "borrowing_disabled" as const,
    ...(borrowingEnabled
      ? {}
      : { capacityLimitedReason: "Borrowing is disabled for the reviewed Aave USDC reserve." }),
    targetHealthFactor: "1.60",
    limitations: [
      "This is a read-only risk-buffered estimate, not an executable borrow quote.",
      "A fresh execution plan must additionally revalidate reserve caps, isolation or eMode constraints, liquidity, oracle state and gas.",
    ],
    currentHealthFactor:
      accountData[5] === (2n ** 256n - 1n)
        ? "unbounded"
        : formatUnits(accountData[5], 18),
    supplyApyBps: Number((reserveData[5] * 10_000n) / RAY),
    variableBorrowApyBps: Number((reserveData[6] * 10_000n) / RAY),
    reserve: {
      active: reserveConfig[8],
      frozen: reserveConfig[9],
      borrowingEnabled,
      availableLiquidityAtomic: availableLiquidity.toString(),
    },
    observedAtBlock: blockNumber.toString(),
    mockData: false as const,
  };
}
