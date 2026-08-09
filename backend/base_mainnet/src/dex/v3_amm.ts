import {
    encodeFunctionData,
    encodePacked,
    formatUnits,
    type Address,
    type Hex,
} from 'viem';
import { publicClient } from '../config/client.js';
import {
    PANCAKE_SMART_ROUTER_ABI,
    ROUTERS,
    TOKENS,
    V3_QUOTER_V2_ABI,
    V3_ROUTER_02_ABI,
} from '../config/constants.js';

const DIRECT_FEE_TIERS = [100, 500, 3000, 10000] as const;
const MULTI_HOP_FEE_PAIRS = [
    [100, 100],
    [500, 500],
    [3000, 3000],
    [10000, 10000],
    [500, 3000],
    [3000, 500],
] as const;

interface V3QuoteCandidate {
    readonly amountOut: bigint;
    readonly gasEstimate: bigint | null;
    readonly feeLabel: string;
    readonly hopCount: 1 | 2;
    readonly path: Hex;
    readonly tokenPath: readonly Address[];
    readonly directFee?: number;
}

export type V3RouteExecutionProfile =
    | 'legacy_direct'
    | 'intent_router_v2_quote';

export interface V3RouteOptions {
        readonly executionProfile?: V3RouteExecutionProfile;
}

async function runBounded<T>(
    tasks: readonly (() => Promise<T>)[],
    concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, tasks.length) },
            async () => {
                while (nextIndex < tasks.length) {
                    const index = nextIndex++;
                    try {
                        results[index] = {
                            status: 'fulfilled',
                            value: await tasks[index](),
                        };
                    } catch (reason) {
                        results[index] = { status: 'rejected', reason };
                    }
                }
            },
        ),
    );
    return results;
}

function tupleAmountAndGas(result: unknown): {
    amountOut: bigint;
    gasEstimate: bigint | null;
} {
    if (Array.isArray(result)) {
        return {
            amountOut: result[0] as bigint,
            gasEstimate:
                typeof result[3] === 'bigint' ? result[3] : null,
        };
    }
    const object = result as {
        amountOut?: bigint;
        gasEstimate?: bigint;
    };
    return {
        amountOut: object.amountOut ?? 0n,
        gasEstimate: object.gasEstimate ?? null,
    };
}

function symbolFor(address: Address): string {
    return (
        Object.entries(TOKENS).find(
            ([symbol, tokenAddress]) =>
                symbol !== 'ETH' &&
                tokenAddress.toLowerCase() === address.toLowerCase(),
        )?.[0] || address.slice(0, 8)
    );
}

function formatV3Fee(fee: number): string {
    return `${(fee / 10_000).toLocaleString('en-US', {
        maximumFractionDigits: 2,
    })}%`;
}

export async function getV3Routes(
    amountInWei: bigint,
    tokenInAddr: Address,
    tokenOutAddr: Address,
    tokenInSymbol: string,
    tokenOutSymbol: string,
    isNativeIn: boolean,
    userAddress: string,
    deadline: bigint,
    decimalsOut: number,
    slippageBps: number = 100,
    options: V3RouteOptions = {},
) {
    const executionProfile =
        options.executionProfile ?? 'legacy_direct';

    if (
        tokenOutSymbol.toUpperCase() === 'ETH' &&
        executionProfile === 'legacy_direct'
    ) {
        throw Object.assign(
            new Error(
                'V3 native-output adapter is disabled until router-specific unwrap calldata is policy-validated.',
            ),
            { code: 'V3_NATIVE_OUTPUT_UNAVAILABLE' },
        );
    }

    const routes: any[] = [];
    let attemptedQuoteCount = 0;
    let successfulQuoteReads = 0;
    const hubs = [
        TOKENS.WETH,
        TOKENS.USDC,
        TOKENS.USDBC,
        TOKENS.AERO,
    ].filter(
        (hub, index, all) =>
            hub.toLowerCase() !== tokenInAddr.toLowerCase() &&
            hub.toLowerCase() !== tokenOutAddr.toLowerCase() &&
            all.findIndex(
                (candidate) =>
                    candidate.toLowerCase() === hub.toLowerCase(),
            ) === index,
    );

    async function checkV3Router(
        quoterAddr: Address,
        routerAddr: Address,
        name: 'Uniswap' | 'PancakeSwap',
    ) {
        const tasks: Array<() => Promise<V3QuoteCandidate>> = [];

        for (const fee of DIRECT_FEE_TIERS) {
            tasks.push(async () => {
                const result = await publicClient.readContract({
                    address: quoterAddr,
                    abi: V3_QUOTER_V2_ABI,
                    functionName: 'quoteExactInputSingle',
                    args: [{
                        tokenIn: tokenInAddr,
                        tokenOut: tokenOutAddr,
                        amountIn: amountInWei,
                        fee,
                        sqrtPriceLimitX96: 0n,
                    }],
                });
                const { amountOut, gasEstimate } =
                    tupleAmountAndGas(result);
                return {
                    amountOut,
                    gasEstimate,
                    feeLabel: formatV3Fee(fee),
                    hopCount: 1,
                    path: encodePacked(
                        ['address', 'uint24', 'address'],
                        [tokenInAddr, fee, tokenOutAddr],
                    ),
                    tokenPath: [tokenInAddr, tokenOutAddr],
                    directFee: fee,
                };
            });
        }

        for (const hub of hubs) {
            for (const [firstFee, secondFee] of MULTI_HOP_FEE_PAIRS) {
                const path = encodePacked(
                    ['address', 'uint24', 'address', 'uint24', 'address'],
                    [
                        tokenInAddr,
                        firstFee,
                        hub,
                        secondFee,
                        tokenOutAddr,
                    ],
                );
                tasks.push(async () => {
                    const result = await publicClient.readContract({
                        address: quoterAddr,
                        abi: V3_QUOTER_V2_ABI,
                        functionName: 'quoteExactInput',
                        args: [path, amountInWei],
                    });
                    const { amountOut, gasEstimate } =
                        tupleAmountAndGas(result);
                    return {
                        amountOut,
                        gasEstimate,
                        feeLabel:
                            `${formatV3Fee(firstFee)} + ${formatV3Fee(secondFee)}`,
                        hopCount: 2,
                        path,
                        tokenPath: [tokenInAddr, hub, tokenOutAddr],
                    };
                });
            }
        }

        attemptedQuoteCount += tasks.length;
        const settled = await runBounded(tasks, 6);
        const candidates = settled
            .filter(
                (
                    result,
                ): result is PromiseFulfilledResult<V3QuoteCandidate> =>
                    result.status === 'fulfilled',
            )
            .map(({ value }) => value)
            .filter(({ amountOut }) => amountOut > 0n);
        successfulQuoteReads += candidates.length;
        candidates.sort((left, right) =>
            left.amountOut === right.amountOut
                ? (left.gasEstimate ?? 2n ** 255n) <
                  (right.gasEstimate ?? 2n ** 255n)
                    ? -1
                    : 1
                : left.amountOut > right.amountOut
                  ? -1
                  : 1,
        );

        const routerAbi =
            name === 'Uniswap'
                ? V3_ROUTER_02_ABI
                : PANCAKE_SMART_ROUTER_ABI;
        for (const candidate of candidates.slice(0, 3)) {
            const amountOutMin =
                (candidate.amountOut * BigInt(10_000 - slippageBps)) /
                10_000n;
            let calldata: Hex | undefined;
            if (executionProfile === 'legacy_direct') {
                const recipient = userAddress as Address;
                const swapCalldata =
                    candidate.hopCount === 1
                        ? encodeFunctionData({
                            abi: routerAbi,
                            functionName: 'exactInputSingle',
                            args: [{
                                tokenIn: tokenInAddr,
                                tokenOut: tokenOutAddr,
                                fee: candidate.directFee!,
                                recipient,
                                amountIn: amountInWei,
                                amountOutMinimum: amountOutMin,
                                sqrtPriceLimitX96: 0n,
                            }],
                        })
                        : encodeFunctionData({
                            abi: routerAbi,
                            functionName: 'exactInput',
                            args: [{
                                path: candidate.path,
                                recipient,
                                amountIn: amountInWei,
                                amountOutMinimum: amountOutMin,
                            }],
                        });
                calldata = encodeFunctionData({
                    abi: routerAbi,
                    functionName: 'multicall',
                    args: [deadline, [swapCalldata]],
                });
            }
            const routeSymbols = candidate.tokenPath.map(symbolFor);
            if (isNativeIn && routeSymbols[0] === 'WETH') {
                routeSymbols[0] = 'ETH';
            }
            let routePath = routeSymbols.join(' ➝ ');
            if (
                tokenOutSymbol.toUpperCase() === 'ETH' &&
                routeSymbols.at(-1) === 'WETH'
            ) {
                routePath += ' ➝ [Kletia Unwrap] ➝ ETH';
            }

            routes.push({
                name:
                    `${name} V3 ${candidate.hopCount === 1 ? 'Direct' : 'Multi-Hop'} ` +
                    `(${candidate.feeLabel})`,
                protocolId:
                    name === 'Uniswap' ? 'uniswap' : 'pancakeswap',
                amountOut: candidate.amountOut,
                expectedOutput:
                    `Get ~${formatUnits(candidate.amountOut, decimalsOut)} ` +
                    tokenOutSymbol,
                routePath,
                typedAdapterKind:
                    name === 'Uniswap'
                        ? 'uniswap_v3_swaprouter02'
                        : null,
                packedPath: candidate.path,
                tokenPath: candidate.tokenPath,
                path: candidate.tokenPath,
                router: routerAddr,
                ...(calldata ? { calldata } : {}),
                estimatedGasUnits:
                    candidate.gasEstimate?.toString() ?? null,
                hopCount: candidate.hopCount,
                quoteObservedAt: new Date().toISOString(),
                quoteExecutionProfile: executionProfile,
                callerSemantics:
                    executionProfile === 'legacy_direct'
                        ? 'explicit_recipient'
                        : 'intent_router_v2_settlement',
                feeRouterCompatible:
                    executionProfile === 'legacy_direct',
            });
        }
    }

    await Promise.all([
        checkV3Router(
            ROUTERS.UNI_V3_QUOTER,
            ROUTERS.UNI_V3,
            'Uniswap',
        ),
        checkV3Router(
            ROUTERS.PANCAKE_V3_QUOTER,
            ROUTERS.PANCAKE_SMART_ROUTER,
            'PancakeSwap',
        ),
    ]);

    if (successfulQuoteReads === 0) {
        throw Object.assign(
            new Error('V3 quote adapter could not reach any live quoter.'),
            { code: 'V3_QUOTE_SOURCE_UNAVAILABLE' },
        );
    }

    return Object.assign(routes, {
        quoteDiagnostics: {
            attemptedQuoteCount,
            successfulQuoteReadCount: successfulQuoteReads,
        },
    });
}
