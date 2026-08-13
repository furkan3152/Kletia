import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { publicClient } from "../../../config/client.js";
import { normalizeBaseProtocolId } from "../protocols.js";
import { AERO_ABI, UNIV2_ABI } from "./constants.js";
import {
  discoverLiquidityPools,
  type LiquidityPoolSnapshot,
} from "./liquidityPools.js";

const NATIVE_GAS_RESERVE = parseUnits("0.001", 18);

interface AssetBalance {
  readonly address: Address;
  readonly decimals: number;
  readonly balance: bigint;
  readonly isNative: boolean;
  readonly symbol: string;
}

async function readAssetBalance(
  address: Address,
  symbol: string,
  isNative: boolean,
  user: Address,
): Promise<AssetBalance> {
  const [decimals, balance] = await Promise.all([
    isNative
      ? Promise.resolve(18)
      : publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: "decimals",
        }),
    isNative
      ? publicClient.getBalance({ address: user })
      : publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [user],
        }),
  ]);
  return { address, decimals, balance, isNative, symbol };
}

function spendableBalance(asset: AssetBalance): bigint {
  if (!asset.isNative) return asset.balance;
  return asset.balance > NATIVE_GAS_RESERVE
    ? asset.balance - NATIVE_GAS_RESERVE
    : 0n;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function minimumAfterSlippage(amount: bigint, slippageBps: number): bigint {
  const minimum = (amount * BigInt(10_000 - slippageBps)) / 10_000n;
  return amount > 0n && minimum === 0n ? 1n : minimum;
}

function protocolMatches(
  pool: LiquidityPoolSnapshot,
  requestedProtocol?: string,
): boolean {
  const requested = normalizeBaseProtocolId(requestedProtocol);
  return (
    !requested ||
    requested === pool.protocolId ||
    pool.protocolName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .includes(requested)
  );
}

export async function buildAddLiquidityRoutes(
  tokenAAddress: Address,
  tokenBAddress: Address,
  amountStr: string,
  userAddress: string,
  requestedProtocol: string | undefined,
  tokenASymbol: string,
  tokenBSymbol: string,
  hasNativeETH: boolean,
  isNativeA: boolean,
  isNativeB: boolean,
  slippageBps = 100,
  secondaryAmountStr?: string,
) {
  const normalizedAmount = amountStr.trim();
  if (
    normalizedAmount.toUpperCase() !== "MAX" &&
    (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalizedAmount) ||
      !/[1-9]/.test(normalizedAmount))
  ) {
    throw Object.assign(
      new Error(
        "AMOUNT_REQUIRED: Liquidity amount must be a positive decimal or explicitly MAX.",
      ),
      { code: "AMOUNT_REQUIRED", statusCode: 400 },
    );
  }
  const user = userAddress as Address;
  const [assetA, assetB] = await Promise.all([
    readAssetBalance(tokenAAddress, tokenASymbol, isNativeA, user),
    readAssetBalance(tokenBAddress, tokenBSymbol, isNativeB, user),
  ]);
  const availableA = spendableBalance(assetA);
  const availableB = spendableBalance(assetB);
  let secondaryAmountCap: bigint | undefined;
  if (secondaryAmountStr !== undefined) {
    const normalizedSecondaryAmount = secondaryAmountStr.trim();
    if (
      !/^(?:\d+\.?\d*|\.\d+)$/.test(normalizedSecondaryAmount) ||
      !/[1-9]/.test(normalizedSecondaryAmount)
    ) {
      throw Object.assign(
        new Error(
          "SECONDARY_AMOUNT_INVALID: The second liquidity amount must be a positive decimal.",
        ),
        {
          code: "SECONDARY_AMOUNT_INVALID",
          statusCode: 400,
        },
      );
    }
    secondaryAmountCap = parseUnits(normalizedSecondaryAmount, assetB.decimals);
  }
  const routeAvailableB =
    secondaryAmountCap !== undefined && secondaryAmountCap < availableB
      ? secondaryAmountCap
      : availableB;
  const maxRequested = normalizedAmount.toUpperCase() === "MAX";
  const requestedAmountA = maxRequested
    ? availableA
    : parseUnits(amountStr || "0", assetA.decimals);
  if (requestedAmountA <= 0n) {
    throw Object.assign(
      new Error(
        "AMOUNT_REQUIRED: Liquidity amount must be positive or explicitly MAX.",
      ),
      { code: "AMOUNT_REQUIRED", statusCode: 400 },
    );
  }
  if (requestedAmountA > availableA) {
    throw Object.assign(
      new Error(`INSUFFICIENT_FUNDS: Not enough ${tokenASymbol} in wallet.`),
      { code: "INSUFFICIENT_FUNDS", statusCode: 400 },
    );
  }
  const discoveredPools = await discoverLiquidityPools(
    tokenAAddress,
    tokenBAddress,
  );

  const pools = discoveredPools.filter((pool) =>
    protocolMatches(pool, requestedProtocol),
  );
  if (pools.length === 0) {
    throw Object.assign(
      new Error(
        `${requestedProtocol || "Verified Base routers"} have no active ` +
          `${tokenASymbol}-${tokenBSymbol} pool with readable reserves.`,
      ),
      { code: "LIQUIDITY_POOL_UNAVAILABLE", statusCode: 400 },
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const routes = pools.flatMap((pool) => {
    let amountA = maxRequested
      ? availableA < (routeAvailableB * pool.reserveA) / pool.reserveB
        ? availableA
        : (routeAvailableB * pool.reserveA) / pool.reserveB
      : requestedAmountA;
    let amountB =
      amountA > 0n ? ceilDiv(amountA * pool.reserveB, pool.reserveA) : 0n;
    if (maxRequested && amountB > routeAvailableB && amountA > 0n) {
      amountA -= 1n;
      amountB =
        amountA > 0n ? ceilDiv(amountA * pool.reserveB, pool.reserveA) : 0n;
    }
    if (amountB <= 0n || amountB > routeAvailableB) return [];

    const amountAMin = minimumAfterSlippage(amountA, slippageBps);
    const amountBMin = minimumAfterSlippage(amountB, slippageBps);
    let calldata: `0x${string}`;
    let value = 0n;

    if (hasNativeETH) {
      const erc20Asset = isNativeA ? assetB : assetA;
      const erc20Amount = isNativeA ? amountB : amountA;
      const ethAmount = isNativeA ? amountA : amountB;
      const minErc20 = isNativeA ? amountBMin : amountAMin;
      const minEth = isNativeA ? amountAMin : amountBMin;
      value = ethAmount;
      calldata =
        pool.kind === "aerodrome"
          ? encodeFunctionData({
              abi: AERO_ABI,
              functionName: "addLiquidityETH",
              args: [
                erc20Asset.address,
                pool.stable,
                erc20Amount,
                minErc20,
                minEth,
                user,
                deadline,
              ],
            })
          : encodeFunctionData({
              abi: UNIV2_ABI,
              functionName: "addLiquidityETH",
              args: [
                erc20Asset.address,
                erc20Amount,
                minErc20,
                minEth,
                user,
                deadline,
              ],
            });
    } else {
      calldata =
        pool.kind === "aerodrome"
          ? encodeFunctionData({
              abi: AERO_ABI,
              functionName: "addLiquidity",
              args: [
                assetA.address,
                assetB.address,
                pool.stable,
                amountA,
                amountB,
                amountAMin,
                amountBMin,
                user,
                deadline,
              ],
            })
          : encodeFunctionData({
              abi: UNIV2_ABI,
              functionName: "addLiquidity",
              args: [
                assetA.address,
                assetB.address,
                amountA,
                amountB,
                amountAMin,
                amountBMin,
                user,
                deadline,
              ],
            });
    }

    const approvals = [
      ...(!assetA.isNative
        ? [
            {
              token: assetA.address,
              spender: pool.router,
              amount: amountA.toString(),
              symbol: assetA.symbol,
              required: true as const,
            },
          ]
        : []),
      ...(!assetB.isNative
        ? [
            {
              token: assetB.address,
              spender: pool.router,
              amount: amountB.toString(),
              symbol: assetB.symbol,
              required: true as const,
            },
          ]
        : []),
    ];

    return [
      {
        name: `${pool.protocolName} (LP)`,
        protocolId: pool.protocolId,
        amount: amountA,
        expectedOutput:
          `Pool ${formatUnits(amountA, assetA.decimals)} ${tokenASymbol} + ` +
          `${formatUnits(amountB, assetB.decimals)} ${tokenBSymbol} ` +
          "at this pool’s live reserve ratio",
        routePath:
          `${tokenASymbol} + ${tokenBSymbol} ➝ ` + `[${pool.protocolName}]`,
        router: pool.router,
        calldata,
        value: value.toString(),
        primaryTokenAddress: assetA.isNative ? undefined : assetA.address,
        primaryAmountInWei: assetA.isNative ? undefined : amountA.toString(),
        secondaryTokenAddress: assetB.isNative ? undefined : assetB.address,
        secondaryAmountInWei: assetB.isNative ? undefined : amountB.toString(),
        approvals,
        executionMode: "direct" as const,
        callerSemantics: "explicit_recipient" as const,
        feeRouterCompatible: false as const,
        poolEvidence: {
          pool: pool.pool,
          factory: pool.factory,
          stable: pool.stable,
          reserveAAtomic: pool.reserveA.toString(),
          reserveBAtomic: pool.reserveB.toString(),
          amountAAtomic: amountA.toString(),
          amountBAtomic: amountB.toString(),
          secondaryAmountCapAtomic: secondaryAmountCap?.toString(),
          secondaryAmountPolicy:
            secondaryAmountCap === undefined
              ? "live_reserve_ratio"
              : "user_maximum_input_cap",
          observedAt: pool.observedAt,
          observedBlock: pool.observedBlock.toString(),
          discoveryAttemptCount: pool.discoveryAttemptCount,
          unavailableSourceCount: pool.unavailableSourceCount,
          absentPoolCount: pool.absentPoolCount,
          ratioSource: "factory_bound_pool_reserves" as const,
          limitation: `LP share output and future fee APY are established only by execution; impermanent-loss risk is not projected. Minimum amounts use ${slippageBps} bps slippage.`,
        },
      },
    ];
  });

  if (routes.length === 0) {
    throw Object.assign(
      new Error(
        `INSUFFICIENT_FUNDS: No active ${tokenASymbol}-${tokenBSymbol} ` +
          `pool fits both wallet balances at its own live reserve ratio.`,
      ),
      { code: "INSUFFICIENT_FUNDS", statusCode: 400 },
    );
  }
  return routes.sort((left, right) => {
    const leftDepth = BigInt(left.poolEvidence.reserveAAtomic);
    const rightDepth = BigInt(right.poolEvidence.reserveAAtomic);
    if (leftDepth !== rightDepth) return leftDepth > rightDepth ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
