import { parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';
import { getAddressSafe } from './utils.js';
import { checkTokenSecurity, xRaySimulate } from './security.js';
import { KletiaErrorTracker } from '../ai/errorEngine.js';
import type { ParsedIntent } from '../ai/parser.js';

import { getAerodromeRoutes } from '../dex/aerodrome.js';
import { getUniswapAndV2Routes } from '../dex/standard_amm.js';
import { getV3Routes } from '../dex/v3_amm.js';
import { getLendingRoutes } from '../lending/markets.js';
import { getStakingRoutes } from '../staking/lockers.js';
import { getLiquidStakingRoutes } from '../staking/liquid.js';
import { getLiquidityRoutes } from '../dex/liquidity.js';
import { getAcrossBridgeRoutes } from '../bridge/across.js';

export async function handleSmartSwap(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Target token could not be determined.");
    const tIn = intent.tokenIn;
    const tOut = intent.tokenOut || "";

    const tInAddr = getAddressSafe(tIn);
    const tOutAddr = getAddressSafe(tOut);
    
    if ((tIn.toUpperCase() === "ETH" && tOut.toUpperCase() === "WETH") || (tIn.toUpperCase() === "WETH" && tOut.toUpperCase() === "ETH")) {
        const isWrap = tIn.toUpperCase() === "ETH";
        const wethAddr = TOKENS["WETH"] as `0x${string}`;
        let amountInWei = parseUnits(intent.amount || "0", 18);
        
        let bal = isWrap ? await publicClient.getBalance({address: userAddress as `0x${string}`}) : await publicClient.readContract({address: wethAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`]});
        if (amountInWei === 0n) amountInWei = isWrap ? bal - parseUnits("0.001", 18) : bal;
        if (bal < amountInWei) throw new Error(`KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|Insufficient balance. Direct the user to fund their wallet. [SHOW_ONRAMP]`);

        const WETH_ABI = [{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"}];
        
        const routeObj = {
            name: isWrap ? "WETH Contract (Wrap)" : "WETH Contract (Unwrap)", amountOut: amountInWei,
            expectedOutput: isWrap ? `Wrap ${formatUnits(amountInWei, 18)} ETH to WETH` : `Unwrap ${formatUnits(amountInWei, 18)} WETH to ETH`,
            routePath: isWrap ? `ETH ➝ WETH` : `WETH ➝ ETH`, router: wethAddr,
            calldata: encodeFunctionData({abi: WETH_ABI, functionName: isWrap ? 'deposit' : 'withdraw', args: isWrap ? [] : [amountInWei]})
        };

        return { status: "success", winner: routeObj.name, expectedOutput: routeObj.expectedOutput, routePath: routeObj.routePath, targetContract: wethAddr, calldata: routeObj.calldata, tokenInAddress: undefined, amountInWei: amountInWei.toString(), isNativeIn: isWrap, value: isWrap ? amountInWei.toString() : "0", allRoutes: [routeObj] };
    }

    if (!tInAddr || !tOutAddr) throw new Error(`Unsupported Token or Address: ${tIn} or ${tOut}`);

    await checkTokenSecurity(tInAddr);
    await checkTokenSecurity(tOutAddr);

    const isNativeIn = tIn.toUpperCase() === "ETH";
    const decimalsIn = isNativeIn ? 18 : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'decimals' });
    const decimalsOut = tOut.toUpperCase() === "ETH" ? 18 : await publicClient.readContract({ address: tOutAddr, abi: erc20Abi, functionName: 'decimals' });

    let amountInWei = 0n;
    if (intent.amount?.toUpperCase() !== "MAX") {
        amountInWei = parseUnits(intent.amount || "0", decimalsIn);
    }
    let bal = isNativeIn ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });

    if (amountInWei === 0n) amountInWei = isNativeIn ? (bal > parseUnits("0.001", 18) ? bal - parseUnits("0.001", 18) : bal) : bal;
    if (amountInWei <= 0n || bal < amountInWei) throw new Error(`KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|Insufficient balance. Not enough tokens in wallet. Direct the user to fund their wallet. [SHOW_ONRAMP]`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
    
    const slippageValue = parseFloat(intent.slippage || "1");
    const slippageBps = isNaN(slippageValue) ? 100 : Math.floor(slippageValue * 100);
    
    const [aeroRes, uniRes, v3Res] = await Promise.allSettled([
        getAerodromeRoutes(amountInWei, tInAddr, tOutAddr, tIn, tOut, isNativeIn, userAddress, deadline, decimalsOut, slippageBps),
        getUniswapAndV2Routes(amountInWei, tInAddr, tOutAddr, tIn, tOut, isNativeIn, userAddress, deadline, decimalsOut, slippageBps),
        getV3Routes(amountInWei, tInAddr, tOutAddr, tIn, tOut, isNativeIn, userAddress, deadline, decimalsOut, slippageBps)
    ]);

    const aero = aeroRes.status === 'fulfilled' ? aeroRes.value : [];
    const uni = uniRes.status === 'fulfilled' ? uniRes.value : [];
    const v3 = v3Res.status === 'fulfilled' ? v3Res.value : [];
    let all = [...aero, ...uni, ...v3];

    const verified = [];
    const valStr = isNativeIn ? amountInWei.toString() : "0";
    let lastError: any = null;
    for (const r of all) {
        const sim = await xRaySimulate(r.router as `0x${string}`, r.calldata as `0x${string}`, userAddress, valStr, r.name, [{addr: isNativeIn ? undefined : tInAddr, amt: amountInWei.toString()}]);
        if (sim.success) {
            verified.push(r);
        } else {
            lastError = sim.error;
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
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 Only the "${intent.protocol}" protocol was requested, but no secure route was found for this transaction.`);
    }

    const sortedRoutes = finalRoutes.sort((a, b) => { return (a.amountOut || 0n) < (b.amountOut || 0n) ? 1 : -1; });
    let winner = sortedRoutes[0];
    
    return { status: "success", winner: winner.name, expectedOutput: winner.expectedOutput, routePath: winner.routePath, targetContract: winner.router, calldata: winner.calldata, tokenInAddress: tInAddr, amountInWei: amountInWei.toString(), isNativeIn, value: valStr, allRoutes: sortedRoutes, winnerMessage: `🏆 **Kletia Engine Found the Most Profitable Route:** ${winner.name}!\n✨ **Expected Output:** ${winner.expectedOutput}\n\n> I prepared the transaction for you, you can sign it from the console below.` };
}

export async function handleLiquidity(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    
    await checkTokenSecurity(getAddressSafe(intent.tokenIn));
    if (intent.tokenOut) await checkTokenSecurity(getAddressSafe(intent.tokenOut));
    
    const rawAction = intent.action.toLowerCase();
    let safeAction: "add_liquidity" | "remove_liquidity";
    
    if (rawAction === 'addliquidity' || rawAction === 'add_liquidity') {
        safeAction = 'add_liquidity';
    } else if (rawAction === 'removeliquidity' || rawAction === 'remove_liquidity') {
        safeAction = 'remove_liquidity';
    } else {
        throw new Error(`🚨 Unsupported Pool Operation: ${rawAction}`);
    }
                       
    const raw = await getLiquidityRoutes(safeAction, intent.tokenIn, intent.tokenOut, intent.amount!, userAddress, intent.protocol);
    
    const verified = [];
    let lastError: any = null;
    for (const r of raw) {
        const tokensToScan = [
            {addr: r.primaryTokenAddress, amt: r.primaryAmountInWei},
            {addr: r.secondaryTokenAddress, amt: r.secondaryAmountInWei}
        ];
        const sim = await xRaySimulate(r.router as `0x${string}`, r.calldata as `0x${string}`, userAddress, r.value || "0", r.name, tokensToScan);
        if (sim.success) {
            verified.push(r);
        } else {
            lastError = sim.error;
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
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 Sadece "${intent.protocol}" protokolü istendi ancak havuzda rota bulunamadı.`);
    }

    const w = finalRoutes[0];
    return { status: "success", winner: w.name, expectedOutput: w.expectedOutput, routePath: w.routePath, targetContract: w.router, calldata: w.calldata, tokenInAddress: w.primaryTokenAddress || w.secondaryTokenAddress, amountInWei: w.primaryAmountInWei || w.secondaryAmountInWei || "0", isNativeIn: Number(w.value || "0") > 0, value: w.value || "0", allRoutes: finalRoutes };
}

export async function handleDeFiBanking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    
    await checkTokenSecurity(getAddressSafe(safeToken));
    
    const rawRoutes = await getLendingRoutes(intent.action as any, safeToken, intent.amount!, user, intent.protocol);
    const verified = [];
    let lastError: any = null;
    
    const needsAllowance = intent.action === 'lend' || intent.action === 'repay';
    const isNative = tIn === "ETH";

    for (const route of rawRoutes) { 
        const tokensToScan = [{addr: (needsAllowance && !isNative) ? TOKENS[safeToken] : undefined, amt: route.amount?.toString()}];
        const sim = await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, "0", route.name, tokensToScan);
        if (sim.success) {
            verified.push(route);
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
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 "${intent.protocol}" protokolünde bu bankacılık işlemi için rota bulunamadı.`);
    }

    return { status: "success", winner: finalRoutes[0].name, expectedOutput: finalRoutes[0].expectedOutput, routePath: finalRoutes[0].routePath, targetContract: finalRoutes[0].router, calldata: finalRoutes[0].calldata, tokenInAddress: (needsAllowance && !isNative) ? TOKENS[safeToken] : undefined, amountInWei: finalRoutes[0].amount?.toString() || "0", isNativeIn: false, value: "0", allRoutes: finalRoutes };
}

export async function handleStaking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    
    await checkTokenSecurity(getAddressSafe(safeToken));
    
    const rawRoutes = await getStakingRoutes(safeToken, intent.amount!, intent.durationInDays || 30, user, intent.protocol);
    
    const verified = [];
    let lastError: any = null;
    const isNative = tIn === "ETH";
    
    for (const route of rawRoutes) { 
        const tokensToScan = [{addr: isNative ? undefined : TOKENS[safeToken], amt: route.amount?.toString()}];
        const sim = await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, "0", route.name, tokensToScan);
        if (sim.success) {
            verified.push(route);
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
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 "${intent.protocol}" protokolünde bu staking işlemi için rota bulunamadı.`);
    }

    return { status: "success", winner: finalRoutes[0].name, expectedOutput: finalRoutes[0].expectedOutput, routePath: finalRoutes[0].routePath, targetContract: finalRoutes[0].router, calldata: finalRoutes[0].calldata, tokenInAddress: isNative ? undefined : TOKENS[safeToken], amountInWei: finalRoutes[0].amount?.toString() || "0", isNativeIn: false, value: "0", allRoutes: finalRoutes };
}

export async function handleLiquidStaking(intent: ParsedIntent, user: string) {
    const action = intent.action.toLowerCase().includes('unstake') ? 'liquid_unstake' : 'liquid_stake';
    const tIn = (intent.tokenIn || "ETH").trim().toUpperCase();
    
    const rawRoutes = await getLiquidStakingRoutes(
        action as 'liquid_stake' | 'liquid_unstake',
        tIn,
        intent.amount || "0",
        user,
        intent.protocol
    );

    if (rawRoutes.length === 0) {
        throw new Error(`🚨 Could not find a suitable route for liquid staking. Check your balance.`);
    }

    const winner = rawRoutes[0];
    return {
        status: "success",
        winner: winner.name,
        expectedOutput: winner.expectedOutput,
        routePath: winner.routePath,
        targetContract: winner.router,
        calldata: winner.calldata,
        tokenInAddress: winner.primaryTokenAddress,
        amountInWei: winner.primaryAmountInWei || winner.amount?.toString() || "0",
        isNativeIn: tIn === "ETH",
        value: winner.value || "0",
        allRoutes: rawRoutes,
        winnerMessage: `🥩 **Liquid Staking Route Found:** ${winner.name}\n✨ **Result:** ${winner.expectedOutput}`
    };
}

export async function handleBridge(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token not specified.");
    if (!intent.destinationChain) throw new Error("🚨 Please specify the destination network (e.g., arbitrum, optimism).");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    const isNative = tIn === "ETH";

    const tAddr = getAddressSafe(safeToken);
    if (!tAddr) throw new Error(`Invalid token: ${tIn}`);
    await checkTokenSecurity(tAddr);

    const decimals = isNative ? 18 : await publicClient.readContract({ address: tAddr, abi: erc20Abi, functionName: 'decimals' });
    let amountInWei = parseUnits(intent.amount || "0", decimals);
    
    let bal = isNative ? await publicClient.getBalance({ address: user as `0x${string}` }) : await publicClient.readContract({ address: tAddr, abi: erc20Abi, functionName: 'balanceOf', args: [user as `0x${string}`] });

    if (amountInWei === 0n) amountInWei = isNative ? bal - parseUnits("0.001", 18) : bal;
    if (amountInWei <= 0n || bal < amountInWei) throw new Error(`KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|Insufficient balance. Not enough tokens in wallet. Direct the user to fund their wallet. [SHOW_ONRAMP]`);

    const rawRoutes = await getAcrossBridgeRoutes(tAddr, tIn, amountInWei, intent.destinationChain, user, decimals, isNative);

    const verified = [];
    let lastError: any = null;

    for (const route of rawRoutes) {
        const tokensToScan = [{addr: isNative ? undefined : tAddr, amt: amountInWei.toString()}];
        const sim = await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, route.value, route.name, tokensToScan);
        if (sim.success) {
            verified.push(route);
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
        winnerMessage: `🌉 **Bridge Route Ready:** ${verified[0].name} via ${verified[0].routePath}\n✨ **Expected Output on Destination:** ${verified[0].expectedOutput}`
    };
}
