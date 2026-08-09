import {
    encodeFunctionData,
    erc20Abi,
    formatUnits,
    parseUnits,
    type Address,
} from 'viem';
import { publicClient } from '../config/client.js';
import { normalizeBaseProtocolId } from '../config/baseProtocols.js';
import {
    AERO_ABI,
    UNIV2_ABI,
} from './dex_constants.js';
import {
    discoverLiquidityPools,
    type LiquidityPoolSnapshot,
} from './liquidityPools.js';

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
            .replace(/[^a-z0-9]/g, '')
            .includes(requested)
    );
}

function minimumAfterSlippage(amount: bigint, slippageBps: number): bigint {
    const minimum =
        (amount * BigInt(10_000 - slippageBps)) / 10_000n;
    return amount > 0n && minimum === 0n ? 1n : minimum;
}

async function buildPoolRemoval(
    pool: LiquidityPoolSnapshot,
    tokenA: Address,
    tokenB: Address,
    tokenADecimals: number,
    tokenBDecimals: number,
    amountStr: string,
    user: Address,
    tokenASymbol: string,
    tokenBSymbol: string,
    hasNativeETH: boolean,
    isNativeA: boolean,
    slippageBps: number,
) {
    const [lpDecimals, lpBalance] = await Promise.all([
        publicClient.readContract({
            address: pool.pool,
            abi: erc20Abi,
            functionName: 'decimals',
        }),
        publicClient.readContract({
            address: pool.pool,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [user],
        }),
    ]);
    if (lpBalance <= 0n) return null;

    const maxRequested = amountStr.trim().toUpperCase() === 'MAX';
    const amount = maxRequested
        ? lpBalance
        : parseUnits(amountStr || '0', lpDecimals);
    if (amount <= 0n) {
        throw Object.assign(
            new Error(
                'AMOUNT_REQUIRED: LP amount must be positive or explicitly MAX.',
            ),
            { code: 'AMOUNT_REQUIRED', statusCode: 400 },
        );
    }
    if (amount > lpBalance) return null;

    const expectedA = (amount * pool.reserveA) / pool.totalSupply;
    const expectedB = (amount * pool.reserveB) / pool.totalSupply;
    if (expectedA <= 0n || expectedB <= 0n) return null;

    const amountAMin = minimumAfterSlippage(
        expectedA,
        slippageBps,
    );
    const amountBMin = minimumAfterSlippage(
        expectedB,
        slippageBps,
    );
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    let calldata: `0x${string}`;

    if (hasNativeETH) {
        const erc20Address = isNativeA ? tokenB : tokenA;
        const amountTokenMin = isNativeA ? amountBMin : amountAMin;
        const amountEthMin = isNativeA ? amountAMin : amountBMin;
        calldata =
            pool.kind === 'aerodrome'
                ? encodeFunctionData({
                    abi: AERO_ABI,
                    functionName: 'removeLiquidityETH',
                    args: [
                        erc20Address,
                        pool.stable,
                        amount,
                        amountTokenMin,
                        amountEthMin,
                        user,
                        deadline,
                    ],
                })
                : encodeFunctionData({
                    abi: UNIV2_ABI,
                    functionName: 'removeLiquidityETH',
                    args: [
                        erc20Address,
                        amount,
                        amountTokenMin,
                        amountEthMin,
                        user,
                        deadline,
                    ],
                });
    } else {
        calldata =
            pool.kind === 'aerodrome'
                ? encodeFunctionData({
                    abi: AERO_ABI,
                    functionName: 'removeLiquidity',
                    args: [
                        tokenA,
                        tokenB,
                        pool.stable,
                        amount,
                        amountAMin,
                        amountBMin,
                        user,
                        deadline,
                    ],
                })
                : encodeFunctionData({
                    abi: UNIV2_ABI,
                    functionName: 'removeLiquidity',
                    args: [
                        tokenA,
                        tokenB,
                        amount,
                        amountAMin,
                        amountBMin,
                        user,
                        deadline,
                    ],
                });
    }

    return {
        name: `${pool.protocolName} (Remove LP)`,
        protocolId: pool.protocolId,
        amount,
        value: '0',
        expectedOutput:
            `Estimate ${formatUnits(expectedA, tokenADecimals)} ` +
            `${tokenASymbol} + ${formatUnits(expectedB, tokenBDecimals)} ` +
            `${tokenBSymbol} from ${formatUnits(amount, lpDecimals)} LP`,
        routePath:
            `[${pool.protocolName}] LP ➝ ` +
            `${tokenASymbol} + ${tokenBSymbol}`,
        router: pool.router,
        calldata,
        primaryTokenAddress: pool.pool,
        primaryAmountInWei: amount.toString(),
        secondaryTokenAddress: undefined,
        secondaryAmountInWei: undefined,
        approvals: [{
            token: pool.pool,
            spender: pool.router,
            amount: amount.toString(),
            symbol: `${tokenASymbol}-${tokenBSymbol} LP`,
            required: true as const,
        }],
        executionMode: 'direct' as const,
        callerSemantics: 'explicit_recipient' as const,
        feeRouterCompatible: false as const,
        poolEvidence: {
            pool: pool.pool,
            factory: pool.factory,
            stable: pool.stable,
            reserveAAtomic: pool.reserveA.toString(),
            reserveBAtomic: pool.reserveB.toString(),
            totalSupplyAtomic: pool.totalSupply.toString(),
            lpBalanceAtomic: lpBalance.toString(),
            lpDecimals,
            amountLpAtomic: amount.toString(),
            expectedAAtomic: expectedA.toString(),
            expectedBAtomic: expectedB.toString(),
            observedAt: pool.observedAt,
            observedBlock: pool.observedBlock.toString(),
            discoveryAttemptCount: pool.discoveryAttemptCount,
            unavailableSourceCount: pool.unavailableSourceCount,
            absentPoolCount: pool.absentPoolCount,
            ratioSource: 'factory_bound_pool_reserves' as const,
            limitation:
                `Outputs are pro-rata reserve estimates with ${slippageBps} bps minimums; transfer fees, reserve changes and execution gas can change realized amounts.`,
        },
    };
}

export async function buildRemoveLiquidityRoutes(
    tokenA: Address,
    tokenB: Address,
    amountStr: string,
    userAddress: string,
    requestedProtocol: string | undefined,
    tokenASymbol: string,
    tokenBSymbol: string,
    hasNativeETH: boolean,
    isNativeA: boolean,
    slippageBps = 100,
) {
    const normalizedAmount = amountStr.trim();
    if (
        normalizedAmount.toUpperCase() !== 'MAX' &&
        (
            !/^(?:\d+\.?\d*|\.\d+)$/.test(normalizedAmount) ||
            !/[1-9]/.test(normalizedAmount)
        )
    ) {
        throw Object.assign(
            new Error(
                'AMOUNT_REQUIRED: LP amount must be a positive decimal or explicitly MAX.',
            ),
            { code: 'AMOUNT_REQUIRED', statusCode: 400 },
        );
    }
    const user = userAddress as Address;
    const [tokenADecimals, tokenBDecimals, discoveredPools] =
        await Promise.all([
            publicClient.readContract({
                address: tokenA,
                abi: erc20Abi,
                functionName: 'decimals',
            }),
            publicClient.readContract({
                address: tokenB,
                abi: erc20Abi,
                functionName: 'decimals',
            }),
            discoverLiquidityPools(tokenA, tokenB),
        ]);
    const pools = discoveredPools.filter((pool) =>
        protocolMatches(pool, requestedProtocol),
    );
    if (pools.length === 0) {
        throw Object.assign(
            new Error(
                `${requestedProtocol || 'Verified Base routers'} have no active ` +
                `${tokenASymbol}-${tokenBSymbol} pool with readable reserves.`,
            ),
            { code: 'LIQUIDITY_POOL_UNAVAILABLE', statusCode: 400 },
        );
    }

    const settled = await Promise.allSettled(
        pools.map((pool) =>
            buildPoolRemoval(
                pool,
                tokenA,
                tokenB,
                tokenADecimals,
                tokenBDecimals,
                amountStr,
                user,
                tokenASymbol,
                tokenBSymbol,
                hasNativeETH,
                isNativeA,
                slippageBps,
            )),
    );
    const routes = settled.flatMap((result) =>
        result.status === 'fulfilled' && result.value
            ? [result.value]
            : []);
    if (routes.length === 0) {
        throw Object.assign(
            new Error(
                `INSUFFICIENT_FUNDS: No removable ${tokenASymbol}-${tokenBSymbol} ` +
                'LP balance was found for the requested amount and protocol.',
            ),
            { code: 'INSUFFICIENT_FUNDS', statusCode: 400 },
        );
    }

    return routes.sort((left, right) =>
        left.name.localeCompare(right.name));
}
