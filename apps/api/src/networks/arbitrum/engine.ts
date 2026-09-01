import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  maxUint256,
  parseUnits,
  type Address,
} from "viem";
import type { ParsedIntent } from "../../shared/ai/parser.js";
import { arbitrumPublicClient } from "../../shared/config/networks.js";
import { emitAgentLog } from "../../shared/observability/agentLog.js";
import {
  AAVE_V3_ADDRESSES_PROVIDER_ABI,
  AAVE_V3_DATA_PROVIDER_ABI,
  AAVE_V3_ORACLE_ABI,
  AAVE_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
  UNISWAP_V3_SWAP_ROUTER_ABI,
} from "./abis.js";
import {
  ARBITRUM_CONTRACTS,
  ARBITRUM_TOKENS,
  type ArbitrumTokenSymbol,
} from "./contracts.js";
import { buildPolicyAgent } from "../../shared/policies/policyAgent.js";
import { isAddressEqual } from "viem";
import { calculateSafeBorrowCapacity } from "../../shared/protocols/aave/risk.js";
import { prepareCompoundV3Intent } from "./compound.js";
export { calculateSafeBorrowCapacity } from "../../shared/protocols/aave/risk.js";

const QUOTE_TTL_MS = 2 * 60 * 1_000;
const RAY = 10n ** 27n;
const HEALTH_FACTOR_SCALE = 10n ** 18n;
const UNISWAP_FEES = [500, 3_000, 10_000] as const;

type Erc20ArbitrumToken = Exclude<ArbitrumTokenSymbol, "ETH">;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function token(symbolInput: unknown, allowNative = false) {
  const symbol = String(symbolInput || "").trim().toUpperCase() as ArbitrumTokenSymbol;
  const definition = ARBITRUM_TOKENS[symbol];
  if (!definition || (!allowNative && symbol === "ETH")) {
    throw controlled(
      "ARBITRUM_ASSET_UNSUPPORTED",
      allowNative
        ? "Arbitrum beta supports ETH, WETH, native USDC and ARB."
        : "This Arbitrum route supports WETH, native USDC and ARB.",
    );
  }
  return { ...definition, symbol };
}

function positiveAmount(value: unknown, decimals: number): bigint {
  const raw = String(value ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) {
    throw controlled("AMOUNT_REQUIRED", "Enter a positive decimal amount.");
  }
  const parsed = parseUnits(raw, decimals);
  if (parsed <= 0n) {
    throw controlled("AMOUNT_REQUIRED", "Enter a positive decimal amount.");
  }
  return parsed;
}

function slippageBps(value: unknown): number {
  const numeric = Number(String(value ?? "1").replace("%", ""));
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 5) {
    throw controlled(
      "SLIPPAGE_OUT_OF_RANGE",
      "Arbitrum beta slippage must be greater than 0% and at most 5%.",
    );
  }
  return Math.ceil(numeric * 100);
}

function rateBps(rayRate: bigint): number {
  return Number((rayRate * 10_000n) / RAY);
}

function targetHealthFactor(intent: ParsedIntent, asset: Erc20ArbitrumToken) {
  if (intent.riskTolerance === "conservative") return 200n * 10n ** 16n;
  if (intent.riskTolerance === "aggressive") return 150n * 10n ** 16n;
  return asset === "USDC" ? 160n * 10n ** 16n : 180n * 10n ** 16n;
}

let readinessCache: { expiresAt: number; promise: Promise<void> } | undefined;

async function readArbitrumReadiness() {
  const [chainId, pool, dataProvider, oracle, bytecodes] = await Promise.all([
    arbitrumPublicClient.getChainId(),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3PoolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPool",
    }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3PoolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPoolDataProvider",
    }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3PoolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPriceOracle",
    }),
    Promise.all([
      ARBITRUM_CONTRACTS.uniswapV3Factory,
      ARBITRUM_CONTRACTS.uniswapV3SwapRouter,
      ARBITRUM_CONTRACTS.uniswapV3QuoterV2,
      ARBITRUM_CONTRACTS.aaveV3Pool,
      ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider,
      ARBITRUM_CONTRACTS.aaveV3Oracle,
      ARBITRUM_CONTRACTS.acrossSpokePool,
    ].map((address) => arbitrumPublicClient.getCode({ address }))),
  ]);
  if (
    chainId !== 42_161 ||
    !isAddressEqual(pool, ARBITRUM_CONTRACTS.aaveV3Pool) ||
    !isAddressEqual(dataProvider, ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider) ||
    !isAddressEqual(oracle, ARBITRUM_CONTRACTS.aaveV3Oracle) ||
    bytecodes.some((code) => !code || code === "0x")
  ) {
    throw controlled(
      "ARBITRUM_PROTOCOL_ATTESTATION_FAILED",
      "Arbitrum RPC or reviewed protocol identities did not match the pinned deployment manifest.",
      503,
    );
  }
}

async function assertArbitrumRpc() {
  const now = Date.now();
  if (!readinessCache || readinessCache.expiresAt <= now) {
    readinessCache = {
      expiresAt: now + 30_000,
      promise: readArbitrumReadiness().catch((error) => {
        readinessCache = undefined;
        throw error;
      }),
    };
  }
  return readinessCache.promise;
}

async function resolveTokenAmount(
  amountInput: unknown,
  symbol: Erc20ArbitrumToken,
  owner: Address,
) {
  const definition = ARBITRUM_TOKENS[symbol];
  if (String(amountInput || "").trim().toUpperCase() !== "MAX") {
    return positiveAmount(amountInput, definition.decimals);
  }
  const balance = await arbitrumPublicClient.readContract({
    address: definition.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  if (balance <= 0n) {
    throw controlled(
      "ARBITRUM_BALANCE_EMPTY",
      `The wallet has no ${symbol} available for this route.`,
    );
  }
  return balance;
}

async function portfolio(owner: Address) {
  const [blockNumber, nativeBalance, usdc, weth, arb, account] =
    await Promise.all([
      arbitrumPublicClient.getBlockNumber(),
      arbitrumPublicClient.getBalance({ address: owner }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_TOKENS.USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_TOKENS.WETH.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_TOKENS.ARB.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_CONTRACTS.aaveV3Pool,
        abi: AAVE_V3_POOL_ABI,
        functionName: "getUserAccountData",
        args: [owner],
      }),
    ]);
  return {
    status: "success",
    action: "portfolio",
    winnerMessage: "Live Arbitrum wallet and Aave V3 account data loaded.",
    data: {
      policyVersion: "kletia_arbitrum_portfolio_v1",
      observedAtBlock: blockNumber.toString(),
      native: { symbol: "ETH", balanceAtomic: nativeBalance.toString(), decimals: 18 },
      tokens: [
        { symbol: "USDC", address: ARBITRUM_TOKENS.USDC.address, balanceAtomic: usdc.toString(), decimals: 6 },
        { symbol: "WETH", address: ARBITRUM_TOKENS.WETH.address, balanceAtomic: weth.toString(), decimals: 18 },
        { symbol: "ARB", address: ARBITRUM_TOKENS.ARB.address, balanceAtomic: arb.toString(), decimals: 18 },
      ],
      aave: {
        totalCollateralBase: account[0].toString(),
        totalDebtBase: account[1].toString(),
        availableBorrowsBase: account[2].toString(),
        currentLiquidationThresholdBps: Number(account[3]),
        ltvBps: Number(account[4]),
        healthFactor: account[1] === 0n ? null : formatUnits(account[5], 18),
      },
      mockData: false,
    },
  };
}

async function swap(intent: ParsedIntent, owner: Address) {
  const input = token(intent.tokenIn) as ReturnType<typeof token> & {
    symbol: Erc20ArbitrumToken;
    address: Address;
  };
  const output = token(intent.tokenOut) as ReturnType<typeof token> & {
    symbol: Erc20ArbitrumToken;
    address: Address;
  };
  if (input.symbol === output.symbol) {
    throw controlled("IDENTICAL_SWAP_ASSETS", "Swap input and output assets must differ.");
  }
  const amountIn = await resolveTokenAmount(intent.amount, input.symbol, owner);
  const quotes = await Promise.all(
    UNISWAP_FEES.map(async (fee) => {
      try {
        const simulation = await arbitrumPublicClient.simulateContract({
          address: ARBITRUM_CONTRACTS.uniswapV3QuoterV2,
          abi: UNISWAP_V3_QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [{
            tokenIn: input.address,
            tokenOut: output.address,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }],
        });
        return { fee, amountOut: simulation.result[0], quoteGas: simulation.result[3] };
      } catch {
        return null;
      }
    }),
  );
  const eligible = quotes
    .filter((quote): quote is NonNullable<typeof quote> => Boolean(quote?.amountOut))
    .sort((left, right) =>
      left.amountOut === right.amountOut ? 0 : left.amountOut > right.amountOut ? -1 : 1,
    );
  if (eligible.length === 0) {
    throw controlled("ARBITRUM_SWAP_LIQUIDITY_UNAVAILABLE", "No live Uniswap V3 pool returned a usable quote.", 503);
  }
  const slip = slippageBps(intent.slippage);
  const now = Date.now();
  const deadline = BigInt(Math.floor(now / 1_000) + 10 * 60);
  const routes = eligible.map((quote) => {
    const minimum = (quote.amountOut * BigInt(10_000 - slip)) / 10_000n;
    const calldata = encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: input.address,
        tokenOut: output.address,
        fee: quote.fee,
        recipient: owner,
        deadline,
        amountIn,
        amountOutMinimum: minimum,
        sqrtPriceLimitX96: 0n,
      }],
    });
    return {
      name: `Uniswap V3 ${quote.fee / 10_000}%`,
      protocolId: "uniswap-v3",
      expectedOutput: `${formatUnits(quote.amountOut, output.decimals)} ${output.symbol}`,
      routePath: `${input.symbol} → ${output.symbol}`,
      router: ARBITRUM_CONTRACTS.uniswapV3SwapRouter,
      calldata,
      value: "0",
      approvals: [{
        token: input.address,
        spender: ARBITRUM_CONTRACTS.uniswapV3SwapRouter,
        amount: amountIn.toString(),
        symbol: input.symbol,
        required: true as const,
      }],
      approvalPolicy: "explicit" as const,
      primaryTokenAddress: input.address,
      primaryAmountInWei: amountIn.toString(),
      simulationStatus: "deferred_until_approval" as const,
      quoteExpiresAt: now + QUOTE_TTL_MS,
      quoteEvidence: {
        source: "uniswap-v3-quoter-v2",
        feeTier: quote.fee,
        quotedAmountOut: quote.amountOut.toString(),
        minimumAmountOut: minimum.toString(),
        slippageBps: slip,
        quoteGas: quote.quoteGas.toString(),
      },
    };
  });
  const winner = routes[0];
  return {
    status: "success",
    action: "swap",
    actionType: "swap",
    winner: winner.name,
    winnerMessage: `Best reviewed Arbitrum quote: ${winner.expectedOutput}.`,
    expectedOutput: winner.expectedOutput,
    routePath: winner.routePath,
    targetContract: winner.router,
    calldata: winner.calldata,
    value: "0",
    amountInWei: amountIn.toString(),
    tokenInAddress: input.address,
    tokenOutAddress: output.address,
    isNativeIn: false,
    approvals: winner.approvals,
    allRoutes: routes,
    quoteExpiresAt: winner.quoteExpiresAt,
    rankingEvidence: {
      policyVersion: "arbitrum_risk_adjusted_net_output_v1",
      primaryMetric: "quoted_output_after_slippage",
      eligibleRouteCount: routes.length,
      protocolAllowlist: ["uniswap-v3"],
      mockData: false,
    },
  };
}

async function aave(intent: ParsedIntent, owner: Address) {
  const action = intent.action as "lend" | "withdraw" | "borrow" | "borrow_capacity" | "repay" | "yield_compare";
  const asset = token(intent.tokenIn) as ReturnType<typeof token> & {
    symbol: Erc20ArbitrumToken;
    address: Address;
  };
  const [configuration, reserve, position] = await Promise.all([
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getReserveConfigurationData",
      args: [asset.address],
    }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getReserveData",
      args: [asset.address],
    }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider,
      abi: AAVE_V3_DATA_PROVIDER_ABI,
      functionName: "getUserReserveData",
      args: [asset.address, owner],
    }),
  ]);
  if (!configuration[8] || configuration[9]) {
    throw controlled("AAVE_RESERVE_UNAVAILABLE", `${asset.symbol} is not an active, unfrozen Aave V3 reserve.`);
  }
  const totalDebt = reserve[3] + reserve[4];
  const availableLiquidity = reserve[2] > totalDebt ? reserve[2] - totalDebt : 0n;
  const economics = {
    policyVersion: "arbitrum_aave_v3_live_rates_v1",
    protocolId: "aave-v3",
    asset: asset.address,
    supplyApyBps: rateBps(reserve[5]),
    variableBorrowApyBps: rateBps(reserve[6]),
    availableLiquidityAtomic: availableLiquidity.toString(),
    observedAt: new Date().toISOString(),
    mockData: false,
  };
  if (action === "borrow_capacity") {
    const [account, price, blockNumber] = await Promise.all([
      arbitrumPublicClient.readContract({
        address: ARBITRUM_CONTRACTS.aaveV3Pool,
        abi: AAVE_V3_POOL_ABI,
        functionName: "getUserAccountData",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_CONTRACTS.aaveV3Oracle,
        abi: AAVE_V3_ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [asset.address],
      }),
      arbitrumPublicClient.getBlockNumber(),
    ]);
    const target = targetHealthFactor(intent, asset.symbol);
    const capacity = calculateSafeBorrowCapacity({
      totalCollateralBase: account[0],
      totalDebtBase: account[1],
      availableBorrowsBase: account[2],
      liquidationThresholdBps: account[3],
      assetPriceBase: price,
      assetDecimals: asset.decimals,
      availableLiquidityAtomic: availableLiquidity,
      targetHealthFactorScaled: target,
    });
    return {
      status: "success",
      action,
      actionType: action,
      readOnly: true,
      winnerMessage:
        `At the pinned Arbitrum block, the Kletia risk-adjusted additional ${asset.symbol} borrow capacity is ${formatUnits(capacity.safeAmountAtomic, asset.decimals)} ${asset.symbol}. No transaction was created.`,
      borrowCapacity: {
        policyVersion: "kletia_aave_borrow_capacity_v1",
        protocolId: "aave-v3",
        asset: asset.symbol,
        assetAddress: asset.address,
        safeAmountAtomic: capacity.safeAmountAtomic.toString(),
        safeAmount: formatUnits(capacity.safeAmountAtomic, asset.decimals),
        safeAdditionalBase: capacity.safeAdditionalBase.toString(),
        protocolAvailableBorrowsBase: account[2].toString(),
        availableLiquidityAtomic: availableLiquidity.toString(),
        targetHealthFactor: formatUnits(target, 18),
        hardMinimumHealthFactor: "1.5",
        currentHealthFactor:
          account[1] === 0n ? null : formatUnits(account[5], 18),
        observedAtBlock: blockNumber.toString(),
        mockData: false,
      },
    };
  }
  if (action === "yield_compare") {
    return {
      status: "success",
      action,
      winnerMessage: `Aave V3 live ${asset.symbol} supply APY is approximately ${(economics.supplyApyBps / 100).toFixed(2)}%; variable borrow APY is ${(economics.variableBorrowApyBps / 100).toFixed(2)}%.`,
      yieldComparison: economics,
    };
  }

  let amount: bigint;
  let targetHealthFactorScaled: bigint | null = null;
  let projectedHealthFactorScaled: bigint | null = null;
  if (action === "lend") {
    amount = await resolveTokenAmount(intent.amount, asset.symbol, owner);
  } else if (action === "withdraw") {
    amount = String(intent.amount).toUpperCase() === "MAX"
      ? maxUint256
      : positiveAmount(intent.amount, asset.decimals);
    if (position[0] <= 0n) {
      throw controlled("AAVE_POSITION_EMPTY", `No supplied ${asset.symbol} position is available to withdraw.`);
    }
    if (amount !== maxUint256 && amount > position[0]) {
      throw controlled("AAVE_WITHDRAW_EXCEEDS_POSITION", "Requested withdrawal exceeds the live Aave position.");
    }
  } else if (action === "repay") {
    const debt = position[1] + position[2];
    if (debt <= 0n) {
      throw controlled("AAVE_DEBT_EMPTY", `No ${asset.symbol} debt is available to repay.`);
    }
    amount = String(intent.amount).toUpperCase() === "MAX"
      ? debt
      : positiveAmount(intent.amount, asset.decimals);
    if (amount > debt) amount = debt;
  } else {
    if (!configuration[6]) {
      throw controlled("AAVE_BORROWING_DISABLED", `${asset.symbol} borrowing is disabled in the live Aave reserve.`);
    }
    const account = await arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3Pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: "getUserAccountData",
      args: [owner],
    });
    if (account[0] <= 0n || account[3] <= 0n) {
      throw controlled("AAVE_COLLATERAL_REQUIRED", "A live collateral position is required before borrowing.");
    }
    const price = await arbitrumPublicClient.readContract({
      address: ARBITRUM_CONTRACTS.aaveV3Oracle,
      abi: AAVE_V3_ORACLE_ABI,
      functionName: "getAssetPrice",
      args: [asset.address],
    });
    if (price <= 0n) {
      throw controlled("AAVE_PRICE_UNAVAILABLE", "Aave oracle did not return a positive asset price.", 503);
    }
    targetHealthFactorScaled = targetHealthFactor(intent, asset.symbol);
    const liquidationAdjustedCollateral = (account[0] * account[3]) / 10_000n;
    const maximumDebtAtTarget =
      (liquidationAdjustedCollateral * HEALTH_FACTOR_SCALE) /
      targetHealthFactorScaled;
    const targetAdditionalBase = maximumDebtAtTarget > account[1]
      ? maximumDebtAtTarget - account[1]
      : 0n;
    const safeAdditionalBase = targetAdditionalBase < account[2]
      ? targetAdditionalBase
      : account[2];
    const safeAmount =
      (safeAdditionalBase * 10n ** BigInt(asset.decimals)) / price;
    if (safeAmount <= 0n) {
      throw controlled("AAVE_SAFE_BORROW_UNAVAILABLE", "No additional borrow amount satisfies the Kletia health-factor floor.");
    }
    amount = String(intent.amount).toUpperCase() === "MAX"
      ? safeAmount
      : positiveAmount(intent.amount, asset.decimals);
    if (amount > safeAmount) {
      throw controlled(
        "AAVE_BORROW_RISK_LIMIT",
        `Requested amount exceeds the current Kletia risk-adjusted limit of ${formatUnits(safeAmount, asset.decimals)} ${asset.symbol}.`,
      );
    }
    const addedDebtBase = (amount * price) / 10n ** BigInt(asset.decimals);
    projectedHealthFactorScaled =
      ((liquidationAdjustedCollateral * HEALTH_FACTOR_SCALE) /
        (account[1] + addedDebtBase));
    if (projectedHealthFactorScaled < 150n * 10n ** 16n) {
      throw controlled("AAVE_HEALTH_FACTOR_FLOOR", "Projected Aave health factor is below the hard 1.5 floor.");
    }
  }

  if (amount <= 0n) {
    throw controlled("AMOUNT_REQUIRED", "The live Aave route resolved to a zero amount.");
  }
  const functionName = action === "lend" ? "supply" : action;
  const calldata =
    functionName === "supply"
      ? encodeFunctionData({ abi: AAVE_V3_POOL_ABI, functionName, args: [asset.address, amount, owner, 0] })
      : functionName === "withdraw"
        ? encodeFunctionData({ abi: AAVE_V3_POOL_ABI, functionName, args: [asset.address, amount, owner] })
        : functionName === "borrow"
          ? encodeFunctionData({ abi: AAVE_V3_POOL_ABI, functionName, args: [asset.address, amount, 2n, 0, owner] })
          : encodeFunctionData({ abi: AAVE_V3_POOL_ABI, functionName: "repay", args: [asset.address, amount, 2n, owner] });
  const approvals = action === "lend" || action === "repay"
    ? [{
        token: asset.address,
        spender: ARBITRUM_CONTRACTS.aaveV3Pool,
        amount: amount.toString(),
        symbol: asset.symbol,
        required: true as const,
      }]
    : [];
  const expected =
    action === "lend"
      ? `${formatUnits(amount, asset.decimals)} ${asset.symbol} supplied`
      : action === "withdraw"
        ? `${amount === maxUint256 ? "full" : formatUnits(amount, asset.decimals)} ${asset.symbol} withdrawal`
        : action === "borrow"
          ? `${formatUnits(amount, asset.decimals)} ${asset.symbol} variable debt`
          : `${formatUnits(amount, asset.decimals)} ${asset.symbol} repayment`;
  const expiresAt = Date.now() + QUOTE_TTL_MS;
  const route = {
    name: `Aave V3 ${action}`,
    protocolId: "aave-v3",
    expectedOutput: expected,
    routePath: `${asset.symbol} → Aave V3`,
    router: ARBITRUM_CONTRACTS.aaveV3Pool,
    calldata,
    value: "0",
    approvals,
    approvalPolicy: "explicit" as const,
    primaryTokenAddress: asset.address,
    primaryAmountInWei: amount.toString(),
    simulationStatus: approvals.length > 0 ? "deferred_until_approval" as const : "passed" as const,
    quoteExpiresAt: expiresAt,
    callerSemantics: "on_behalf_of" as const,
    policyTargets: [ARBITRUM_CONTRACTS.aaveV3ProtocolDataProvider],
    economics,
    riskEvidence: {
      policyVersion: "kletia_aave_health_factor_v1",
      hardMinimumHealthFactor: "1.5",
      targetHealthFactor: targetHealthFactorScaled
        ? formatUnits(targetHealthFactorScaled, 18)
        : null,
      projectedHealthFactor: projectedHealthFactorScaled
        ? formatUnits(projectedHealthFactorScaled, 18)
        : null,
    },
  };
  return {
    status: "success",
    action,
    actionType: action,
    winner: route.name,
    winnerMessage: `Live Aave V3 ${action} route is ready for explicit wallet review.`,
    expectedOutput: expected,
    routePath: route.routePath,
    targetContract: route.router,
    calldata,
    value: "0",
    amountInWei: amount.toString(),
    tokenInAddress: asset.address,
    isNativeIn: false,
    approvals,
    allRoutes: [route],
    quoteExpiresAt: expiresAt,
    yieldRankingEvidence: {
      policyVersion: "arbitrum_aave_risk_adjusted_yield_v1",
      action,
      riskTolerance: intent.riskTolerance || "balanced",
      eligibleRouteCount: 1,
      mockData: false,
    },
  };
}

async function transfer(intent: ParsedIntent, owner: Address) {
  if (!intent.recipient) {
    throw controlled("RECIPIENT_REQUIRED", "Enter the recipient address.");
  }
  const recipient = getAddress(intent.recipient);
  const asset = token(intent.tokenIn, true);
  const amount = asset.symbol === "ETH"
    ? positiveAmount(intent.amount, 18)
    : await resolveTokenAmount(
        intent.amount,
        asset.symbol as Erc20ArbitrumToken,
        owner,
      );
  const native = asset.symbol === "ETH";
  const target = native ? recipient : asset.address!;
  const calldata = native
    ? "0x" as const
    : encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, amount],
      });
  const expiresAt = Date.now() + QUOTE_TTL_MS;
  const route = {
    name: `Arbitrum ${asset.symbol} transfer`,
    protocolId: "native-transfer",
    expectedOutput: `${formatUnits(amount, asset.decimals)} ${asset.symbol} to ${recipient}`,
    routePath: `${owner} → ${recipient}`,
    router: target,
    calldata,
    value: native ? amount.toString() : "0",
    approvals: [],
    approvalPolicy: "explicit" as const,
    quoteExpiresAt: expiresAt,
  };
  return {
    status: "success",
    action: "transfer",
    actionType: "transfer",
    winner: route.name,
    winnerMessage: "The recipient-bound Arbitrum transfer is ready for review.",
    expectedOutput: route.expectedOutput,
    routePath: route.routePath,
    targetContract: target,
    calldata,
    value: route.value,
    amountInWei: amount.toString(),
    tokenInAddress: native ? undefined : asset.address,
    isNativeIn: native,
    approvals: [],
    allRoutes: [route],
    quoteExpiresAt: expiresAt,
  };
}

async function withGasReadiness(
  result: Record<string, any>,
  owner: Address,
  action: string,
) {
  const gasUnits = action === "transfer" ? 100_000n : action === "swap" ? 420_000n : 500_000n;
  const [gasPrice, balance, blockNumber] = await Promise.all([
    arbitrumPublicClient.getGasPrice(),
    arbitrumPublicClient.getBalance({ address: owner }),
    arbitrumPublicClient.getBlockNumber(),
  ]);
  const recommendedBuffer = (gasPrice * gasUnits * 125n) / 100n;
  return {
    ...result,
    gasReadiness: {
      policyVersion: "arbitrum_explicit_gas_acquisition_v1",
      nativeAsset: "ETH",
      balanceAtomic: balance.toString(),
      recommendedBufferAtomic: recommendedBuffer.toString(),
      gasAcquisitionRequired: balance < recommendedBuffer,
      automaticSpendAllowed: false,
      acquisitionPolicy: "switch_to_base_and_request_bounded_across_eth_route",
      observedAtBlock: blockNumber.toString(),
      mockData: false,
    },
  };
}

function routeSupplyApy(result: Record<string, any>): number {
  const direct = Number(result?.yieldComparison?.supplyApyBps);
  if (Number.isFinite(direct)) return direct;
  const nested = Number(result?.allRoutes?.[0]?.economics?.supplyApyBps);
  return Number.isFinite(nested) ? nested : -1;
}

async function compareArbitrumLending(
  intent: ParsedIntent,
  owner: Address,
) {
  const results = await Promise.allSettled([
    aave(intent, owner),
    prepareCompoundV3Intent(intent, owner),
  ]);
  const eligible: Record<string, any>[] = results
    .flatMap<Record<string, any>>((result) =>
      result.status === "fulfilled" ? [result.value as Record<string, any>] : [],
    )
    .sort((left, right) => routeSupplyApy(right) - routeSupplyApy(left));
  if (eligible.length === 0) {
    throw controlled(
      "ARBITRUM_LENDING_ROUTES_UNAVAILABLE",
      "No reviewed Arbitrum lending protocol returned a live route.",
      503,
    );
  }
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{
          protocolId: index === 0 ? "aave-v3" : "compound-v3",
          reason: result.reason instanceof Error
            ? result.reason.message
            : "Live protocol read failed.",
        }]
      : [],
  );
  if (intent.action === "yield_compare") {
    const comparisons = eligible.map((candidate) => candidate.yieldComparison);
    const winner = comparisons[0]!;
    return {
      status: "success",
      action: "yield_compare",
      readOnly: true,
      winner: winner.protocolId,
      winnerMessage: `Best live reviewed USDC supply rate: ${winner.protocolId} at approximately ${(winner.supplyApyBps / 100).toFixed(2)}% APY.`,
      yieldComparisons: comparisons,
      unavailableRoutes: failures,
      rankingEvidence: {
        policyVersion: "arbitrum_multi_protocol_live_yield_v1",
        primaryMetric: "live_supply_apy_bps",
        eligibleRouteCount: eligible.length,
        mockData: false,
      },
    };
  }
  const winner = eligible[0]!;
  const allRoutes: Record<string, any>[] = eligible.flatMap<Record<string, any>>(
    (candidate) => Array.isArray(candidate.allRoutes) ? candidate.allRoutes : [],
  );
  return {
    ...winner,
    allRoutes,
    unavailableRoutes: failures,
    winnerMessage: `${winner.winnerMessage} ${eligible.length} reviewed live lending routes were compared by supply APY before wallet approval.`,
    yieldRankingEvidence: {
      policyVersion: "arbitrum_multi_protocol_live_yield_v1",
      primaryMetric: "live_supply_apy_bps",
      eligibleRouteCount: eligible.length,
      selectedProtocol: winner.allRoutes?.[0]?.protocolId,
      mockData: false,
    },
  };
}

export async function executeArbitrumEngine(
  intent: ParsedIntent,
  userAddress: string,
  _originalPrompt = "",
  requestId = "",
) {
  await assertArbitrumRpc();
  const owner = getAddress(userAddress);
  emitAgentLog(owner, requestId, `Arbitrum beta planner started: ${intent.action}`, "arbitrum");
  if (intent.action === "chat") return { status: "question", message: intent.message };
  if (intent.action === "open_widget") {
    return { status: "success", action: "open_widget", widgetTarget: "chat", winnerMessage: intent.message };
  }
  if (intent.action === "portfolio") return portfolio(owner);
  if (intent.action === "policy_agent") return buildPolicyAgent(intent, owner, "arbitrum");
  if (intent.action === "swap") {
    const requestedProtocol = String(intent.protocol || "").trim().toLowerCase();
    if (["camelot", "camelot-v3", "camelot-v4"].includes(requestedProtocol)) {
      throw controlled(
        "CAMELOT_ADAPTER_UNAVAILABLE",
        "Camelot is recognized, but its exact quote, calldata and simulation adapter is not ready. Kletia will not silently replace the requested protocol with Uniswap.",
        409,
      );
    }
    if (requestedProtocol && !["uniswap", "uniswap-v3"].includes(requestedProtocol)) {
      throw controlled(
        "ARBITRUM_SWAP_PROTOCOL_UNSUPPORTED",
        `The requested Arbitrum swap protocol ${requestedProtocol} is not executable.`,
        409,
      );
    }
    return withGasReadiness(await swap(intent, owner), owner, "swap");
  }
  if (["lend", "withdraw", "borrow", "borrow_capacity", "repay", "yield_compare"].includes(intent.action)) {
    const requestedProtocol = String(intent.protocol || "").trim().toLowerCase();
    const compoundRequested = ["compound", "compound-v3", "comet"].includes(requestedProtocol);
    if (
      requestedProtocol &&
      !compoundRequested &&
      !["aave", "aave-v3"].includes(requestedProtocol)
    ) {
      throw controlled(
        "ARBITRUM_LENDING_PROTOCOL_UNSUPPORTED",
        `The requested Arbitrum lending protocol ${requestedProtocol} is not executable.`,
        409,
      );
    }
    if (
      !requestedProtocol &&
      (intent.action === "withdraw" || intent.action === "repay")
    ) {
      return {
        status: "question",
        requiresInput: true,
        question: "Which reviewed Arbitrum lending position should Kletia use?",
        options: [
          {
            id: "aave-v3",
            label: "Aave V3",
            effect: "Uses the live Aave position and its separate approval/risk rules.",
          },
          {
            id: "compound-v3",
            label: "Compound III",
            effect: "Uses the native-USDC Comet position; Compound borrowing remains disabled.",
          },
        ],
      };
    }
    const compare =
      !requestedProtocol &&
      (intent.action === "lend" || intent.action === "yield_compare") &&
      String(intent.tokenIn || "USDC").trim().toUpperCase() === "USDC";
    const result = compare
      ? await compareArbitrumLending(intent, owner)
      : compoundRequested
        ? await prepareCompoundV3Intent(intent, owner)
        : await aave(intent, owner);
    return intent.action === "yield_compare" || intent.action === "borrow_capacity"
      ? result
      : withGasReadiness(result, owner, intent.action);
  }
  if (intent.action === "transfer") return withGasReadiness(await transfer(intent, owner), owner, "transfer");
  throw controlled(
    "ARBITRUM_ACTION_UNSUPPORTED",
    `${intent.action} is not available in the Arbitrum beta engine.`,
  );
}
