import { parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';
import { getAddressSafe } from './utils.js';
import {
    checkTokenSecurity,
    xRaySimulate,
    type XRaySimulationResult,
} from './security.js';
import { KletiaErrorTracker } from '../ai/errorEngine.js';
import type { ParsedIntent } from '../ai/parser.js';
import { normalizeBaseProtocolId } from '../config/baseProtocols.js';

import {
    getLendingOpportunities,
    getLendingRoutes,
    rankVerifiedLendingRoutes,
} from '../lending/markets.js';
import { getStakingRoutes } from '../staking/lockers.js';
import { getLiquidityRoutes } from '../dex/liquidity.js';
import { getAcrossBridgeRoutes } from '../bridge/across.js';
import {
    buildSwapRankingEvidence,
    parseSlippageBps,
    rankSwapRoutes,
    swapRoutingLimitation,
} from './routingPolicy.js';
import {
    applyBaseProtocolExclusions,
    assertBaseProtocolConstraintCompatibility,
    assertProtocolExclusionsLeaveEligibleRoutes,
} from './protocolConstraints.js';
import { collectBaseSwapQuotes } from './baseSwapQuoteCollector.js';

function requiredTokenAddress(reference: string, label: string) {
    const address = getAddressSafe(reference);
    if (!address) {
        throw Object.assign(
            new Error(`${label} doğrulanmış Base token registry kaydı taşımıyor.`),
            { code: 'TOKEN_REQUIRED', statusCode: 400 },
        );
    }
    return address;
}

function routeAfterSimulation<T extends object>(
    route: T,
    simulation: XRaySimulationResult,
): T & { simulationStatus: 'passed' | 'deferred_until_approval' } {
    return {
        ...route,
        simulationStatus: simulation.success
            ? 'passed'
            : 'deferred_until_approval',
    };
}

async function settleWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, items.length) },
            async () => {
                while (nextIndex < items.length) {
                    const index = nextIndex++;
                    try {
                        results[index] = {
                            status: 'fulfilled',
                            value: await worker(items[index]),
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

export async function handleSmartSwap(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Target token could not be determined.");
    assertBaseProtocolConstraintCompatibility(
        intent.protocol,
        intent.excludedProtocols,
    );
    const tIn = intent.tokenIn;
    const tOut = intent.tokenOut || "";

    if ((tIn.toUpperCase() === "ETH" && tOut.toUpperCase() === "WETH") || (tIn.toUpperCase() === "WETH" && tOut.toUpperCase() === "ETH")) {
        const isWrap = tIn.toUpperCase() === "ETH";
        const wethAddr = TOKENS["WETH"] as `0x${string}`;
        const maxRequested = intent.amount?.toUpperCase() === "MAX";
        let amountInWei = maxRequested
            ? 0n
            : parseUnits(intent.amount || "0", 18);

        let bal = isWrap ? await publicClient.getBalance({address: userAddress as `0x${string}`}) : await publicClient.readContract({address: wethAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`]});
        if (maxRequested) {
            const gasReserve = parseUnits("0.001", 18);
            amountInWei = isWrap
                ? bal > gasReserve
                    ? bal - gasReserve
                    : 0n
                : bal;
        }
        if (amountInWei <= 0n) throw new Error(`AMOUNT_REQUIRED: Amount must be positive or explicitly MAX.`);
        if (bal < amountInWei) throw new Error(`KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|Insufficient balance. Direct the user to fund their wallet. [SHOW_ONRAMP]`);

        const WETH_ABI = [{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"}];

        const routeObj = {
            name: isWrap ? "WETH Contract (Wrap)" : "WETH Contract (Unwrap)", amountOut: amountInWei,
            expectedOutput: isWrap ? `Wrap ${formatUnits(amountInWei, 18)} ETH to WETH` : `Unwrap ${formatUnits(amountInWei, 18)} WETH to ETH`,
            routePath: isWrap ? `ETH ➝ WETH` : `WETH ➝ ETH`, router: wethAddr,
            calldata: encodeFunctionData({abi: WETH_ABI, functionName: isWrap ? 'deposit' : 'withdraw', args: isWrap ? [] : [amountInWei]}),
            value: isWrap ? amountInWei.toString() : "0",
        };
        const simulation = await xRaySimulate(
            wethAddr,
            routeObj.calldata,
            userAddress,
            routeObj.value,
            routeObj.name,
        );
        if (!simulation.success) {
            throw Object.assign(
                new Error('WETH wrap/unwrap transaction failed live Base simulation.'),
                { code: 'WETH_SIMULATION_FAILED', statusCode: 400 },
            );
        }
        const verifiedRoute = routeAfterSimulation(routeObj, simulation);

        return { status: "success", winner: verifiedRoute.name, expectedOutput: verifiedRoute.expectedOutput, routePath: verifiedRoute.routePath, targetContract: wethAddr, calldata: verifiedRoute.calldata, tokenInAddress: undefined, amountInWei: amountInWei.toString(), isNativeIn: isWrap, value: verifiedRoute.value, allRoutes: [verifiedRoute] };
    }

    const quoteCollection = await collectBaseSwapQuotes(
        intent,
        userAddress,
        'legacy_direct',
    );
    const tInAddr = quoteCollection.tokenInAddress;
    const amountInWei = BigInt(quoteCollection.amountInWei);
    const isNativeIn = quoteCollection.isNativeIn;
    const quoteCoverage = quoteCollection.quoteCoverage;
    let all = [...quoteCollection.allRoutes];

    const verified = [];
    const valStr = isNativeIn ? amountInWei.toString() : "0";
    let lastError: any = null;
    const simulationResults = await settleWithConcurrency(
        all,
        4,
        async (route) => ({
            route,
            simulation: await xRaySimulate(
                route.router as `0x${string}`,
                route.calldata as `0x${string}`,
                userAddress,
                valStr,
                route.name,
                [{
                    addr: isNativeIn ? undefined : tInAddr,
                    amt: amountInWei.toString(),
                }],
            ),
        }),
    );
    for (const result of simulationResults) {
        if (result.status === 'rejected') {
            lastError = result.reason;
            continue;
        }
        const { route, simulation } = result.value;
        if (simulation.success || simulation.deferredUntilApproval) {
            verified.push(routeAfterSimulation(route, simulation));
        } else {
            lastError = simulation.error;
        }
    }

    if (verified.length === 0) {
        if (lastError) {
            const analyzed = KletiaErrorTracker.analyzeError(lastError, "swap");
            throw new Error(`KEE_ERROR|${analyzed.category}|${analyzed.reason}|${analyzed.aiHint}`);
        }
        throw new Error("Could not find a valid and secure route on the network.");
    }

    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const requestedProtocol = normalizeBaseProtocolId(intent.protocol);
        finalRoutes = verified.filter(
            (route) =>
                route.protocolId === requestedProtocol ||
                route.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '')
                    .includes(requestedProtocol || ''),
        );
        if (finalRoutes.length === 0) throw new Error(`🚨 Only the "${intent.protocol}" protocol was requested, but no secure route was found for this transaction.`);
    }

    const sortedRoutes = rankSwapRoutes(finalRoutes).slice(0, 20);
    const winner = sortedRoutes[0];
    const rankingEvidence = buildSwapRankingEvidence(
        sortedRoutes,
        intent.protocol,
    );

    return {
        status: "success",
        winner: winner.name,
        expectedOutput: winner.expectedOutput,
        routePath: winner.routePath,
        targetContract: winner.router,
        calldata: winner.calldata,
        tokenInAddress: tInAddr,
        amountInWei: amountInWei.toString(),
        isNativeIn,
        value: valStr,
        allRoutes: sortedRoutes,
        quoteCoverage,
        rankingEvidence,
        protocolExclusionEvidence:
            quoteCollection.protocolExclusionEvidence,
        winnerMessage:
            `🏆 **Kletia quoted-output route:** ${winner.name}\n` +
            `✨ **Expected Output:** ${winner.expectedOutput}\n\n` +
            `> ${swapRoutingLimitation()}\n\n` +
            '> I prepared the transaction for you; review and sign it from the console below.',
    };
}

export async function handleLiquidity(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    const excludedProtocolIds =
        assertBaseProtocolConstraintCompatibility(
            intent.protocol,
            intent.excludedProtocols,
        );

    await checkTokenSecurity(requiredTokenAddress(intent.tokenIn, 'tokenIn'));
    if (intent.tokenOut) {
        await checkTokenSecurity(
            requiredTokenAddress(intent.tokenOut, 'tokenOut'),
        );
    }

    const rawAction = intent.action.toLowerCase();
    let safeAction: "add_liquidity" | "remove_liquidity";

    if (rawAction === 'addliquidity' || rawAction === 'add_liquidity') {
        safeAction = 'add_liquidity';
    } else if (rawAction === 'removeliquidity' || rawAction === 'remove_liquidity') {
        safeAction = 'remove_liquidity';
    } else {
        throw new Error(`🚨 Unsupported Pool Operation: ${rawAction}`);
    }

    const raw = await getLiquidityRoutes(
        safeAction,
        intent.tokenIn,
        intent.tokenOut,
        intent.amount || '',
        userAddress,
        intent.protocol,
        parseSlippageBps(intent.slippage),
        intent.secondaryAmount,
    );
    type LiquidityRoute = (typeof raw)[number];
    const protocolExclusionResult =
        applyBaseProtocolExclusions<LiquidityRoute>(
        raw as readonly LiquidityRoute[],
        excludedProtocolIds,
    );
    assertProtocolExclusionsLeaveEligibleRoutes(
        protocolExclusionResult.evidence,
        'Likidite',
    );
    const candidateRoutes: readonly LiquidityRoute[] =
        protocolExclusionResult.routes;

    const verified = [];
    let lastError: any = null;
    const simulationResults = await settleWithConcurrency(
        candidateRoutes,
        4,
        async (route) => ({
            route,
            simulation: await xRaySimulate(
                route.router as `0x${string}`,
                route.calldata as `0x${string}`,
                userAddress,
                route.value || '0',
                route.name,
                route.approvals.map((approval) => ({
                    addr: approval.token,
                    amt: approval.amount,
                })),
            ),
        }),
    );
    for (const result of simulationResults) {
        if (result.status === 'rejected') {
            lastError = result.reason;
            continue;
        }
        const { route, simulation } = result.value;
        if (simulation.success || simulation.deferredUntilApproval) {
            verified.push(routeAfterSimulation(route, simulation));
        } else {
            lastError = simulation.error;
        }
    }
    if (verified.length === 0) {
        if (lastError) {
            const analyzed = KletiaErrorTracker.analyzeError(lastError, safeAction);
            throw new Error(`KEE_ERROR|${analyzed.category}|${analyzed.reason}|${analyzed.aiHint}`);
        }
        throw new Error("Pool (LP) transaction was rejected by the network.");
    }

    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const requestedProtocol = normalizeBaseProtocolId(intent.protocol);
        finalRoutes = verified.filter(
            (route) =>
                route.protocolId === requestedProtocol ||
                route.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '')
                    .includes(requestedProtocol || ''),
        );
        if (finalRoutes.length === 0) throw new Error(`🚨 Sadece "${intent.protocol}" protokolü istendi ancak havuzda rota bulunamadı.`);
    }

    const w = finalRoutes[0];
    const removalComparisonUnavailable =
        safeAction === 'remove_liquidity';
    const liquidityRoutingEvidence = {
        policyVersion: 'base_liquidity_reserves_v1',
        action: safeAction,
        primaryMetric: removalComparisonUnavailable
            ? 'position_not_comparable'
            : 'same_token_reserve_a_depth',
        direction: removalComparisonUnavailable
            ? 'not_applicable'
            : 'descending',
        selectionPolicy: removalComparisonUnavailable
            ? 'explicit_wallet_position_selection'
            : 'automatic_reserve_depth_ranking',
        candidateRouteCount: candidateRoutes.length,
        simulatedRouteCount: simulationResults.length,
        eligibleRouteCount: finalRoutes.length,
        yieldProjectionAvailable: false,
        impermanentLossProjectionAvailable: false,
        rankedRoutes: finalRoutes.map((route, index) => ({
            rank: index + 1,
            protocolId: route.protocolId,
            name: route.name,
            router: route.router,
            pool: route.poolEvidence.pool,
            factory: route.poolEvidence.factory,
            stable: route.poolEvidence.stable,
            reserveAAtomic: route.poolEvidence.reserveAAtomic,
            reserveBAtomic: route.poolEvidence.reserveBAtomic,
            simulationStatus: route.simulationStatus,
        })),
        limitation:
            removalComparisonUnavailable
                ? 'Each removal route is a different wallet-owned LP position, so Kletia does not label one economically best without a common live valuation. Routes are deterministic, factory-bound choices; select the intended protocol and review both outputs.'
                : 'Routes are real factory-bound pools ranked by same-token reserve-A depth. Kletia does not invent fee APR, future yield or impermanent-loss projections; review both token amounts and pool risk before signing.',
    };
    return {
        status: "success",
        winner: w.name,
        expectedOutput: w.expectedOutput,
        routePath: w.routePath,
        targetContract: w.router,
        calldata: w.calldata,
        tokenInAddress:
            w.primaryTokenAddress || w.secondaryTokenAddress,
        amountInWei:
            w.primaryAmountInWei || w.secondaryAmountInWei || "0",
        isNativeIn: BigInt(w.value || '0') > 0n,
        value: w.value || "0",
        approvals: w.approvals,
        executionMode: w.executionMode,
        callerSemantics: w.callerSemantics,
        feeRouterCompatible: w.feeRouterCompatible,
        allRoutes: finalRoutes,
        liquidityRoutingEvidence,
        protocolExclusionEvidence: protocolExclusionResult.evidence,
        winnerMessage:
            `💧 **${removalComparisonUnavailable ? 'Available Base LP position' : 'Kletia Base pool choice'}:** ${w.name}\n` +
            `📊 **Live reserve estimate:** ${w.expectedOutput}\n` +
            `🛡️ **Execution:** direct wallet call with quote-bounded approvals.\n\n` +
            `> ${liquidityRoutingEvidence.limitation}`,
    };
}

export async function handleDeFiBanking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    const excludedProtocolIds =
        assertBaseProtocolConstraintCompatibility(
            intent.protocol,
            intent.excludedProtocols,
        );
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;

    await checkTokenSecurity(requiredTokenAddress(safeToken, 'tokenIn'));

    const action = intent.action as 'lend' | 'borrow' | 'repay' | 'withdraw';
    const quotedRoutes = await getLendingRoutes(
        action,
        safeToken,
        intent.amount!,
        user,
        intent.protocol,
    );
    const protocolExclusionResult = applyBaseProtocolExclusions(
        quotedRoutes,
        excludedProtocolIds,
    );
    assertProtocolExclusionsLeaveEligibleRoutes(
        protocolExclusionResult.evidence,
        'Lending',
    );
    const rawRoutes = protocolExclusionResult.routes;
    const verified = [];
    let lastError: any = null;

    for (const route of rawRoutes) { 
        const tokensToScan = route.approvals.map((approval) => ({
            addr: approval.token,
            amt: approval.amount,
        }));
        const sim = await xRaySimulate(
            route.router as `0x${string}`,
            route.calldata as `0x${string}`,
            user,
            "0",
            route.name,
            tokensToScan,
            route.simulationReturnPolicy,
        );
        if (sim.success || sim.deferredUntilApproval) {
            verified.push(routeAfterSimulation(route, sim));
        } else {
            lastError = sim.error;
        }
    }

    if (verified.length === 0) {
        if (lastError) {
            const analyzed = KletiaErrorTracker.analyzeError(lastError, intent.action);
            throw new Error(`KEE_ERROR|${analyzed.category}|${analyzed.reason}|${analyzed.aiHint}`);
        }
        throw new Error("İşlem reddedildi. Bakiye or teminat (collateral) eksik olabilir.");
    }

    const riskTolerance =
        intent.riskTolerance === 'conservative' ||
        intent.riskTolerance === 'aggressive'
            ? intent.riskTolerance
            : 'balanced';
    const {
        rankedRoutes: finalRoutes,
        yieldRankingEvidence,
    } = rankVerifiedLendingRoutes(verified, action, riskTolerance);
    const winner = finalRoutes[0];
    const needsAllowance = action === 'lend' || action === 'repay';

    return {
        status: "success",
        winner: winner.name,
        expectedOutput: winner.expectedOutput,
        routePath: winner.routePath,
        targetContract: winner.router,
        calldata: winner.calldata,
        tokenInAddress: needsAllowance
            ? winner.primaryTokenAddress
            : undefined,
        amountInWei: winner.amount.toString(),
        isNativeIn: false,
        value: "0",
        approvals: winner.approvals,
        allRoutes: finalRoutes,
        yieldRankingEvidence,
        protocolExclusionEvidence: protocolExclusionResult.evidence,
        winnerMessage:
            `🏦 **Kletia Base yield route:** ${winner.name}\n` +
            `📈 **Live estimate:** ${winner.expectedOutput}\n` +
            `🛡️ **Execution:** direct wallet call; fee router is intentionally bypassed for correct position ownership.\n\n` +
            `> ${yieldRankingEvidence.limitation}`,
    };
}

export async function handleYieldCompare(intent: ParsedIntent) {
    if (!intent.tokenIn) {
        throw Object.assign(
            new Error('Yield comparison requires a Base asset symbol.'),
            { code: 'TOKEN_REQUIRED', statusCode: 400 },
        );
    }
    const excludedProtocolIds =
        assertBaseProtocolConstraintCompatibility(
            intent.protocol,
            intent.excludedProtocols,
        );
    const riskTolerance =
        intent.riskTolerance === 'conservative' ||
        intent.riskTolerance === 'aggressive'
            ? intent.riskTolerance
            : 'balanced';
    const result = await getLendingOpportunities(
        intent.tokenIn,
        intent.protocol,
        riskTolerance,
        intent.objective === 'lowest_borrow_cost'
            ? 'borrow'
            : 'supply',
    );
    const protocolExclusionResult = applyBaseProtocolExclusions(
        result.opportunities,
        excludedProtocolIds,
    );
    assertProtocolExclusionsLeaveEligibleRoutes(
        protocolExclusionResult.evidence,
        'Yield karşılaştırması',
    );
    const opportunities = protocolExclusionResult.routes;
    return {
        ...result,
        opportunities,
        coverage: {
            ...result.coverage,
            eligibleProtocolCount: opportunities.length,
        },
        protocolExclusionEvidence:
            protocolExclusionResult.evidence,
        winnerMessage:
            `Base ${result.assetSymbol} live ${result.comparison}-rate comparison: ` +
            opportunities
                .map((opportunity) => {
                    const rate =
                        result.comparison === 'supply'
                            ? opportunity.supplyRateBps
                            : opportunity.borrowRateBps;
                    return `${opportunity.name} ${
                        rate === null
                            ? 'rate unavailable'
                            : `${rate / 100}%`
                    } (${opportunity.riskTier})`;
                })
                .join(' · ') +
            '\n\nRates are live best-effort reads; review protocol and market risk before signing.',
    };
}

export async function handleStaking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    const excludedProtocolIds =
        assertBaseProtocolConstraintCompatibility(
            intent.protocol,
            intent.excludedProtocols,
        );
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;

    await checkTokenSecurity(requiredTokenAddress(safeToken, 'tokenIn'));

    const quotedRoutes = await getStakingRoutes(safeToken, intent.amount!, intent.durationInDays || 30, user, intent.protocol);
    const protocolExclusionResult = applyBaseProtocolExclusions(
        quotedRoutes,
        excludedProtocolIds,
    );
    assertProtocolExclusionsLeaveEligibleRoutes(
        protocolExclusionResult.evidence,
        'Staking',
    );
    const rawRoutes = protocolExclusionResult.routes;

    const verified = [];
    let lastError: any = null;
    const isNative = tIn === "ETH";

    for (const route of rawRoutes) { 
        const tokensToScan = [{addr: isNative ? undefined : TOKENS[safeToken], amt: route.amount?.toString()}];
        const sim = await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, "0", route.name, tokensToScan);
        if (sim.success || sim.deferredUntilApproval) {
            verified.push(routeAfterSimulation(route, sim));
        } else {
            lastError = sim.error;
        }
    }

    if (verified.length === 0) {
        if (lastError) {
            const analyzed = KletiaErrorTracker.analyzeError(lastError, "stake");
            throw new Error(`KEE_ERROR|${analyzed.category}|${analyzed.reason}|${analyzed.aiHint}`);
        }
        throw new Error("Staking işlemi ağ tarafından reddedildi.");
    }

    const finalRoutes = verified;
    const winner = finalRoutes[0];
    return {
        status: "success",
        winner: winner.name,
        expectedOutput: winner.expectedOutput,
        routePath: winner.routePath,
        targetContract: winner.router,
        calldata: winner.calldata,
        tokenInAddress: isNative ? undefined : TOKENS[safeToken],
        amountInWei: winner.amount?.toString() || "0",
        isNativeIn: false,
        value: "0",
        approvals: winner.approvals,
        allRoutes: finalRoutes,
        protocolExclusionEvidence: protocolExclusionResult.evidence,
        winnerMessage:
            `🔒 **Direct Base staking route:** ${winner.name}\n` +
            `✨ ${winner.expectedOutput}\n` +
            `⚠️ ${winner.riskDisclosure}`,
    };
}

export async function handleLiquidStaking(intent: ParsedIntent, user: string) {
    const action = intent.action.toLowerCase().includes('unstake') ? 'liquid_unstake' : 'liquid_stake';
    const supportedLsdTokens = new Set([
        'WSTETH',
        'CBETH',
        'RETH',
        'WEETH',
        'EZETH',
        'WRSETH',
    ]);
    const candidates = [
        intent.tokenIn,
        intent.tokenOut,
        intent.protocol,
    ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const protocolAliases: Record<string, string> = {
        LIDO: 'WSTETH',
        WSTETH: 'WSTETH',
        COINBASE: 'CBETH',
        CBETH: 'CBETH',
        ROCKETPOOL: 'RETH',
        RETH: 'RETH',
        ETHERFI: 'WEETH',
        WEETH: 'WEETH',
        RENZO: 'EZETH',
        EZETH: 'EZETH',
        KELP: 'WRSETH',
        WRSETH: 'WRSETH',
    };
    const lsdToken = candidates
        .map((candidate) =>
            supportedLsdTokens.has(candidate)
                ? candidate
                : protocolAliases[candidate],
        )
        .find(Boolean);

    if (!lsdToken) {
        throw Object.assign(
            new Error(
                'Liquid staking acquisition için wstETH, cbETH, rETH, weETH, ezETH veya wrsETH hedefini açıkça belirtmelisin.',
            ),
            { code: 'LIQUID_STAKING_TOKEN_REQUIRED', statusCode: 400 },
        );
    }

    const swapIntent: ParsedIntent = {
        ...intent,
        action: 'swap',
        tokenIn: action === 'liquid_stake' ? 'ETH' : lsdToken,
        tokenOut: action === 'liquid_stake' ? lsdToken : 'ETH',

        protocol: undefined,
    };
    const result = await handleSmartSwap(swapIntent, user);
    return {
        ...result,
        winnerMessage:
            `🥩 **Live Base LST/LRT acquisition route ready:** ${result.winner}\n` +
            `✨ **Result:** ${result.expectedOutput}\n` +
            `> This is a DEX acquisition/redemption route on Base, not a native protocol mint or guaranteed 1:1 redemption.`,
    };
}

export async function handleBridge(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    if (!intent.destinationChain) throw new Error("🚨 Please specify the destination network (e.g., arbitrum, optimism).");
    const excludedProtocolIds =
        assertBaseProtocolConstraintCompatibility(
            intent.protocol,
            intent.excludedProtocols,
        );
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    const isNative = tIn === "ETH";

    const tAddr = getAddressSafe(safeToken);
    if (!tAddr) throw new Error(`Invalid token: ${tIn}`);
    await checkTokenSecurity(tAddr);

    const decimals = isNative ? 18 : await publicClient.readContract({ address: tAddr, abi: erc20Abi, functionName: 'decimals' });
    const maxRequested = intent.amount?.toUpperCase() === "MAX";
    let amountInWei = maxRequested
        ? 0n
        : parseUnits(intent.amount || "0", decimals);

    let bal = isNative ? await publicClient.getBalance({ address: user as `0x${string}` }) : await publicClient.readContract({ address: tAddr, abi: erc20Abi, functionName: 'balanceOf', args: [user as `0x${string}`] });

    if (maxRequested) {
        const gasReserve = parseUnits("0.001", 18);
        amountInWei = isNative
            ? bal > gasReserve
                ? bal - gasReserve
                : 0n
            : bal;
    }
    if (amountInWei <= 0n || bal < amountInWei) throw new Error(`KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|Insufficient balance. Not enough tokens in wallet. Direct the user to fund their wallet. [SHOW_ONRAMP]`);

    const quotedRoutes = await getAcrossBridgeRoutes(tAddr, tIn, amountInWei, intent.destinationChain, user, decimals, isNative);
    const protocolExclusionResult = applyBaseProtocolExclusions(
        quotedRoutes,
        excludedProtocolIds,
    );
    assertProtocolExclusionsLeaveEligibleRoutes(
        protocolExclusionResult.evidence,
        'Bridge',
    );
    const rawRoutes = protocolExclusionResult.routes;

    const verified = [];
    let lastError: any = null;

    for (const route of rawRoutes) {
        const tokensToScan = [{addr: isNative ? undefined : tAddr, amt: amountInWei.toString()}];
        const sim = await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, route.value, route.name, tokensToScan);
        if (sim.success || sim.deferredUntilApproval) {
            verified.push(routeAfterSimulation(route, sim));
        } else {
            lastError = sim.error;
        }
    }

    if (verified.length === 0) {
        if (lastError) {
            const analyzed = KletiaErrorTracker.analyzeError(lastError, "bridge");
            throw new Error(`KEE_ERROR|${analyzed.category}|${analyzed.reason}|${analyzed.aiHint}`);
        }
        throw new Error("Bridge transaction was rejected by the network.");
    }

    return { 
        status: "success", 
        winner: verified[0].name, 
        expectedOutput: verified[0].expectedOutput, 
        routePath: verified[0].routePath, 
        targetContract: verified[0].router, 
        calldata: verified[0].calldata, 
        tokenInAddress: isNative ? undefined : tAddr, 
        amountInWei: amountInWei.toString(), 
        isNativeIn: isNative, 
        value: verified[0].value, 
        allRoutes: verified,
        protocolExclusionEvidence: protocolExclusionResult.evidence,
        winnerMessage: `🌉 **Bridge Route Ready:** ${verified[0].name} via ${verified[0].routePath}\n✨ **Expected Output on Destination:** ${verified[0].expectedOutput}`
    };
}
