// backend/src/intent/engine.ts
import { parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import type { ParsedIntent } from '../ai/parser.js'; 
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

import { getAerodromeRoutes } from '../dex/aerodrome.js';
import { getUniswapAndV2Routes } from '../dex/standard_amm.js';
import { getLendingRoutes } from '../lending/markets.js';
import { getPortfolio } from '../portfolio/viewer.js';
import { getStakingRoutes } from '../staking/lockers.js';
import { getLiquidityRoutes } from '../dex/liquidity.js';

export async function executeKletiaEngine(intent: ParsedIntent, userAddress: string) {
    try {
        if (intent.action === 'portfolio') return await getPortfolio(userAddress);
        
        // ✨ DÜZELTME: AI'ın uydurabileceği tüm varyasyonları (camelCase) kapsıyoruz!
        let action = intent.action.toLowerCase();
        if (action === 'addliquidity') action = 'add_liquidity';
        if (action === 'removeliquidity') action = 'remove_liquidity';

        switch (action) {
            case 'swap': return await handleSmartSwap(intent, userAddress);
            case 'lend': 
            case 'borrow':
            case 'repay':
            case 'withdraw': return await handleDeFiBanking(intent, userAddress);
            case 'stake': return await handleStaking(intent, userAddress);
            case 'add_liquidity':
            case 'remove_liquidity':
            case 'claim': return await handleLiquidity(intent, userAddress); 
            default: throw new Error(`Desteklenmeyen İşlem: ${intent.action}`);
        }
    } catch (error: any) { throw new Error(error.message); }
}

async function xRaySimulate(router: `0x${string}`, data: `0x${string}`, user: string, val: string, name: string, tokensToCheck: {addr?: string, amt?: string}[] = []): Promise<boolean> {
    try {
        await publicClient.call({ account: user as `0x${string}`, to: router, data, value: BigInt(val) });
        return true;
    } catch (e: any) {
        const errMsg = (e.shortMessage || e.message || "").toLowerCase();
        let needsApproval = false;

        if (errMsg.includes('transfer_from_failed') || errMsg.includes('stf') || errMsg.includes('transferfrom failed') || errMsg.includes('allowance')) {
            needsApproval = true;
        }

        if (!needsApproval) {
            try {
                for (const token of tokensToCheck) {
                    if (token.addr && token.amt && token.addr !== TOKENS["ETH"]) {
                        const safeAddr = token.addr.toLowerCase() as `0x${string}`;
                        const allowance = await publicClient.readContract({ address: safeAddr, abi: erc20Abi, functionName: 'allowance', args: [user as `0x${string}`, router] });
                        if (allowance < BigInt(token.amt)) needsApproval = true;
                    }
                }
            } catch (err) {}
        }

        if (needsApproval) {
            console.log(`⚠️ [X-RAY DEDEKTİFİ] ${name}: İşlem çöktü AMA sebebi sadece harcama izni (Allowance). Rota onaylandı!`);
            return true;
        }
        
        console.log(`❌ [X-RAY SIMULATION FAILED] ${name} -> Reason: ${e.shortMessage || "Reverted"}`);
        return false; 
    }
}

async function handleSmartSwap(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 İşlem yapılacak token anlaşılamadı.");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const tOut = (intent.tokenOut || "").trim().toUpperCase();

    if ((tIn === "ETH" && tOut === "WETH") || (tIn === "WETH" && tOut === "ETH")) {
        const isWrap = tIn === "ETH";
        const wethAddr = TOKENS["WETH"] as `0x${string}`;
        let amountInWei = parseUnits(intent.amount || "0", 18);
        
        let bal = isWrap ? await publicClient.getBalance({address: userAddress as `0x${string}`}) : await publicClient.readContract({address: wethAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`]});
        if (amountInWei === 0n) amountInWei = isWrap ? bal - parseUnits("0.001", 18) : bal;
        if (bal < amountInWei) throw new Error(`❌ Yetersiz Bakiye! Cüzdanınızda bu işlem için yeterli miktar yok.`);

        const WETH_ABI = [{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"}];
        
        const routeObj = {
            name: isWrap ? "WETH Contract (Wrap)" : "WETH Contract (Unwrap)", amountOut: amountInWei,
            expectedOutput: isWrap ? `Wrap ${formatUnits(amountInWei, 18)} ETH to WETH` : `Unwrap ${formatUnits(amountInWei, 18)} WETH to ETH`,
            routePath: isWrap ? `ETH ➝ WETH` : `WETH ➝ ETH`, router: wethAddr,
            calldata: encodeFunctionData({abi: WETH_ABI, functionName: isWrap ? 'deposit' : 'withdraw', args: isWrap ? [] : [amountInWei]})
        };

        return { status: "success", winner: routeObj.name, expectedOutput: routeObj.expectedOutput, routePath: routeObj.routePath, targetContract: wethAddr, calldata: routeObj.calldata, tokenInAddress: undefined, amountInWei: amountInWei.toString(), isNativeIn: isWrap, value: isWrap ? amountInWei.toString() : "0", allRoutes: [routeObj] };
    }

    const isNativeIn = tIn === "ETH";
    const tInAddr = TOKENS[isNativeIn ? "WETH" : tIn] as `0x${string}`;
    const tOutAddr = TOKENS[tOut === "ETH" ? "WETH" : tOut] as `0x${string}`;
    if (!tInAddr || !tOutAddr) throw new Error(`Desteklenmeyen Token: ${tIn} veya ${tOut}`);

    const decimalsIn = isNativeIn ? 18 : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'decimals' });
    const decimalsOut = tOut === "ETH" ? 18 : await publicClient.readContract({ address: tOutAddr, abi: erc20Abi, functionName: 'decimals' });

    let amountInWei = parseUnits(intent.amount || "0", decimalsIn);
    let bal = isNativeIn ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });

    if (amountInWei === 0n) amountInWei = isNativeIn ? bal - parseUnits("0.001", 18) : bal;
    if (amountInWei <= 0n || bal < amountInWei) throw new Error(`Yetersiz Bakiye! Cüzdanınızda yeterli ${tIn} bulunamadı.`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
    
    const aero = await getAerodromeRoutes(amountInWei, tInAddr, tOutAddr, tIn, tOut, isNativeIn, userAddress, deadline, decimalsOut);
    const uni = await getUniswapAndV2Routes(amountInWei, tInAddr, tOutAddr, tIn, tOut, isNativeIn, userAddress, deadline, decimalsOut);
    let all = [...aero, ...uni];

    const verified = [];
    const valStr = isNativeIn ? amountInWei.toString() : "0";
    for (const r of all) {
        if (await xRaySimulate(r.router as `0x${string}`, r.calldata as `0x${string}`, userAddress, valStr, r.name, [{addr: isNativeIn ? undefined : tInAddr, amt: amountInWei.toString()}])) {
            verified.push(r);
        }
    }
    
    if (verified.length === 0) throw new Error("Ağ üzerinde geçerli ve güvenli bir rota bulunamadı.");
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 Sadece "${intent.protocol}" protokolü istendi ancak bu işlem için orada güvenli bir rota bulunamadı.`);
    }

    const sortedRoutes = finalRoutes.sort((a, b) => { return (a.amountOut || 0n) < (b.amountOut || 0n) ? 1 : -1; });
    let winner = sortedRoutes[0];
    
    return { status: "success", winner: winner.name, expectedOutput: winner.expectedOutput, routePath: winner.routePath, targetContract: winner.router, calldata: winner.calldata, tokenInAddress: tInAddr, amountInWei: amountInWei.toString(), isNativeIn, value: valStr, allRoutes: sortedRoutes };
}

async function handleLiquidity(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token belirtilmemiş.");
    let raw;
    // ✨ DÜZELTME: Likidite action'ı her zaman alt tireli gönderilir!
    const safeAction = intent.action.toLowerCase() === 'addliquidity' ? 'add_liquidity' : 
                       (intent.action.toLowerCase() === 'removeliquidity' ? 'remove_liquidity' : 'claim');
                       
    raw = await getLiquidityRoutes(safeAction, intent.tokenIn, intent.tokenOut, intent.amount!, userAddress, intent.protocol);
    
    const verified = [];
    for (const r of raw) {
        const tokensToScan = [
            {addr: r.primaryTokenAddress, amt: r.primaryAmountInWei},
            {addr: r.secondaryTokenAddress, amt: r.secondaryAmountInWei}
        ];
        if (await xRaySimulate(r.router as `0x${string}`, r.calldata as `0x${string}`, userAddress, r.value || "0", r.name, tokensToScan)) {
            verified.push(r);
        }
    }
    if (verified.length === 0) throw new Error("Havuz (LP) işlemi ağ tarafından reddedildi.");
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 Sadece "${intent.protocol}" protokolü istendi ancak havuzda rota bulunamadı.`);
    }

    const w = finalRoutes[0];
    return { status: "success", winner: w.name, expectedOutput: w.expectedOutput, routePath: w.routePath, targetContract: w.router, calldata: w.calldata, tokenInAddress: w.primaryTokenAddress || w.secondaryTokenAddress, amountInWei: w.primaryAmountInWei || w.secondaryAmountInWei || "0", isNativeIn: Number(w.value || "0") > 0, value: w.value || "0", allRoutes: finalRoutes };
}

async function handleDeFiBanking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token belirtilmemiş.");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    const rawRoutes = await getLendingRoutes(intent.action as any, safeToken, intent.amount!, user, intent.protocol);
    const verified = [];
    
    const needsAllowance = intent.action === 'lend' || intent.action === 'repay';
    const isNative = tIn === "ETH";

    for (const route of rawRoutes) { 
        const tokensToScan = [{addr: (needsAllowance && !isNative) ? TOKENS[safeToken] : undefined, amt: route.amount?.toString()}];
        if (await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, "0", route.name, tokensToScan)) {
            verified.push(route);
        }
    }
    
    if (verified.length === 0) throw new Error("İşlem reddedildi. Bakiye veya teminat (collateral) eksik olabilir.");
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 "${intent.protocol}" protokolünde bu bankacılık işlemi için rota bulunamadı.`);
    }

    return { status: "success", winner: finalRoutes[0].name, expectedOutput: finalRoutes[0].expectedOutput, routePath: finalRoutes[0].routePath, targetContract: finalRoutes[0].router, calldata: finalRoutes[0].calldata, tokenInAddress: (needsAllowance && !isNative) ? TOKENS[safeToken] : undefined, amountInWei: finalRoutes[0].amount?.toString() || "0", isNativeIn: false, value: "0", allRoutes: finalRoutes };
}

async function handleStaking(intent: ParsedIntent, user: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token belirtilmemiş.");
    const tIn = intent.tokenIn.trim().toUpperCase();
    const safeToken = tIn === "ETH" ? "WETH" : tIn;
    const rawRoutes = await getStakingRoutes(safeToken, intent.amount!, intent.durationInDays || 30, user, intent.protocol);
    
    const verified = [];
    const isNative = tIn === "ETH";
    
    for (const route of rawRoutes) { 
        const tokensToScan = [{addr: isNative ? undefined : TOKENS[safeToken], amt: route.amount?.toString()}];
        if (await xRaySimulate(route.router as `0x${string}`, route.calldata as `0x${string}`, user, "0", route.name, tokensToScan)) {
            verified.push(route);
        }
    }
    
    if (verified.length === 0) throw new Error("Staking işlemi ağ tarafından reddedildi.");
    
    let finalRoutes = verified;
    if (intent.protocol && intent.protocol !== "unknown") {
        const pName = intent.protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
        finalRoutes = verified.filter(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(pName));
        if (finalRoutes.length === 0) throw new Error(`🚨 "${intent.protocol}" protokolünde bu staking işlemi için rota bulunamadı.`);
    }

    return { status: "success", winner: finalRoutes[0].name, expectedOutput: finalRoutes[0].expectedOutput, routePath: finalRoutes[0].routePath, targetContract: finalRoutes[0].router, calldata: finalRoutes[0].calldata, tokenInAddress: isNative ? undefined : TOKENS[safeToken], amountInWei: finalRoutes[0].amount?.toString() || "0", isNativeIn: false, value: "0", allRoutes: finalRoutes };
}