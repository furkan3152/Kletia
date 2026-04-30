// backend/src/intent/engine.ts
import { parseUnits, formatUnits, erc20Abi, encodeFunctionData, getAddress } from 'viem';
import type { ParsedIntent } from '../ai/parser.js'; 
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

import { getAerodromeRoutes } from '../dex/aerodrome.js';
import { getUniswapAndV2Routes } from '../dex/standard_amm.js';
import { getLendingRoutes } from '../lending/markets.js';
import { getPortfolio } from '../portfolio/viewer.js';
import { getStakingRoutes } from '../staking/lockers.js';
import { getLiquidityRoutes } from '../dex/liquidity.js';

// ✨ KLETIA AGGREGATOR KONTRATI (Base Ağı Onaylı Adres)
const KLETIA_ROUTER_ADDRESS = getAddress("0xF97f807C95B02d4c4b221C67B587fD1a99b2A77F");

const KLETIA_ROUTER_ABI = [
    { "inputs": [ { "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "uint256", "name": "totalAmount", "type": "uint256" }, { "internalType": "address", "name": "targetProtocol", "type": "address" }, { "internalType": "bytes", "name": "targetCalldata", "type": "bytes" } ], "name": "executeERC20", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [ { "internalType": "address", "name": "targetProtocol", "type": "address" }, { "internalType": "bytes", "name": "targetCalldata", "type": "bytes" } ], "name": "executeETH", "outputs": [], "stateMutability": "payable", "type": "function" }
] as const;

// ✨ GOPLUS SECURITY RADARI: Rugpull ve Honeypot tarayıcısı
async function checkTokenSecurity(tokenAddress: string | undefined) {
    if (!tokenAddress || tokenAddress.toLowerCase() === "native") return true;
    try {
        const response = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${tokenAddress}`);
        const data = await response.json();
        const security = data.result[tokenAddress.toLowerCase()];
        
        if (!security) return true;
        if (security.is_honeypot === "1" || security.is_blacklisted === "1" || security.is_scam === "1") {
            throw new Error(`🚨 GÜVENLİK RİSKİ: Bu token bir Honeypot veya Scam olabilir! Kletia seni korumak için işlemi durdurdu.`);
        }
        return true;
    } catch (e: any) {
        if (e.message?.includes('GÜVENLİK RİSKİ')) throw e;
        return true; // API anlık çökerse işlemleri durdurmamak için Fallback
    }
}

// ✨ 0x KÖRLÜĞÜ ÇÖZÜCÜ: Sembolü veya 0x adresini EVM Checksum formatına zorlar
const getAddressSafe = (symbolOrAddr: string | undefined): `0x${string}` | undefined => {
    if (!symbolOrAddr) return undefined;
    const clean = symbolOrAddr.trim();
    if (clean.startsWith("0x") || clean.startsWith("0X")) {
        try {
            return getAddress(clean.toLowerCase()) as `0x${string}`;
        } catch {
            return undefined;
        }
    }
    return TOKENS[clean.toUpperCase()] as `0x${string}`;
};

// ✨ SEÇİCİ KOMİSYON MİMARİSİ (%0.1)
async function applyKletiaFee(tokenSymbol: string, amountStr: string, userAddress: string, action: string) {
    // Sadece Swap, Lend ve Stake komisyonludur. Likidite işlemleri, borç alma ve çekim ücretsizdir.
    const feeExemptActions = ['withdraw', 'repay', 'remove_liquidity', 'add_liquidity', 'portfolio', 'borrow'];
    if (feeExemptActions.includes(action.toLowerCase())) {
        return { netAmountStr: amountStr, feeData: null };
    }

    const isNative = tokenSymbol.toUpperCase() === "ETH";
    const tokenAddr = getAddressSafe(isNative ? "WETH" : tokenSymbol);
    if (!tokenAddr) return { netAmountStr: amountStr, feeData: null };

    const decimals = isNative ? 18 : await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' });
    
    let amountWei = 0n;
    if (amountStr === "0" || amountStr.toUpperCase() === "MAX") {
        const balance = isNative 
            ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) 
            : await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        amountWei = isNative ? balance - parseUnits("0.001", 18) : balance; 
    } else {
        amountWei = parseUnits(amountStr, decimals);
    }

    if (amountWei <= 0n) return { netAmountStr: amountStr, feeData: null };

    const feeWei = (amountWei * 10n) / 10000n; // %0.1 (10 basis points)
    const netWei = amountWei - feeWei;

    return {
        netAmountStr: formatUnits(netWei, decimals),
        feeData: {
            tokenAddress: isNative ? "NATIVE" : tokenAddr,
            amountWei: feeWei.toString(),
            isNative
        }
    };
}

export async function executeKletiaEngine(intent: ParsedIntent, userAddress: string) {
    try {
        if (intent.action === 'portfolio') return await getPortfolio(userAddress);
        
        // ✨ SOHBET BYPASSI
        if (intent.action === 'chat') {
            return { status: "question", message: intent.message };
        }
        
        let action = intent.action.toLowerCase();
        if (action === 'addliquidity') action = 'add_liquidity';
        if (action === 'removeliquidity') action = 'remove_liquidity';

        const originalGrossAmountStr = intent.amount || "0";

        // ✨ İŞLEM ÖNCESİ %0.1 KOMİSYON AYRIŞTIRMASI
        const { netAmountStr, feeData } = await applyKletiaFee(intent.tokenIn || "ETH", originalGrossAmountStr, userAddress, action);
        intent.amount = netAmountStr;

        let result: any;
        switch (action) {
            case 'swap': result = await handleSmartSwap(intent, userAddress); break;
            case 'lend': 
            case 'borrow':
            case 'repay':
            case 'withdraw': result = await handleDeFiBanking(intent, userAddress); break;
            case 'stake': result = await handleStaking(intent, userAddress); break;
            case 'add_liquidity':
            case 'remove_liquidity': result = await handleLiquidity(intent, userAddress); break;
            default: throw new Error(`Desteklenmeyen İşlem: ${intent.action}`);
        }

        // ✨ OMNI AGGREGATOR WRAPPER (Atomik Kontrat Sarıcı)
        if (feeData && result.status === 'success' && !(result.winner && result.winner.includes('WETH Contract'))) {
            
            const isNative = feeData.isNative;
            const decimals = isNative ? 18 : await publicClient.readContract({ address: feeData.tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' });
            
            let grossAmountWei = 0n;
            if (originalGrossAmountStr === "0" || originalGrossAmountStr.toUpperCase() === "MAX") {
                grossAmountWei = BigInt(result.amountInWei) + BigInt(feeData.amountWei);
            } else {
                grossAmountWei = parseUnits(originalGrossAmountStr, decimals);
            }

            const targetProtocol = result.targetContract;
            const targetCalldata = result.calldata;

            let wrappedCalldata;
            if (isNative) {
                 wrappedCalldata = encodeFunctionData({
                     abi: KLETIA_ROUTER_ABI,
                     functionName: 'executeETH',
                     args: [targetProtocol as `0x${string}`, targetCalldata as `0x${string}`]
                 });
            } else {
                 wrappedCalldata = encodeFunctionData({
                     abi: KLETIA_ROUTER_ABI,
                     functionName: 'executeERC20',
                     args: [feeData.tokenAddress as `0x${string}`, grossAmountWei, targetProtocol as `0x${string}`, targetCalldata as `0x${string}`]
                 });
            }

            result.targetContract = KLETIA_ROUTER_ADDRESS;
            result.calldata = wrappedCalldata;
            result.value = isNative ? grossAmountWei.toString() : "0";
            result.amountInWei = grossAmountWei.toString(); 
            result.expectedOutput += ` (Includes %0.1 Protocol Fee)`;
        }

        return result;
    } catch (error: any) { throw new Error(error.message); }
}

// ✨ GERÇEK EVM SİMÜLATÖRÜ
async function xRaySimulate(router: `0x${string}`, data: `0x${string}`, user: string, val: string, name: string, tokensToCheck: {addr?: string, amt?: string}[] = []): Promise<boolean> {
    try {
        await publicClient.call({ account: user as `0x${string}`, to: router, data, value: BigInt(val) });
        console.log(`✅ [X-RAY PROOF] ${name}: EVM Simülasyonu kusursuz!`);
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
            console.log(`⚠️ [X-RAY DEDEKTİFİ] ${name}: İşlem onayı bekliyor (Allowance). Mantıksal rota doğru.`);
            return true;
        }
        
        console.log(`❌ [X-RAY SIMULATION FAILED] ${name} -> Reason: ${e.shortMessage || "Reverted"}`);
        return false; 
    }
}

async function handleSmartSwap(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 İşlem yapılacak token anlaşılamadı.");
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
        if (bal < amountInWei) throw new Error(`❌ Yetersiz Bakiye!`);

        const WETH_ABI = [{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"}];
        
        const routeObj = {
            name: isWrap ? "WETH Contract (Wrap)" : "WETH Contract (Unwrap)", amountOut: amountInWei,
            expectedOutput: isWrap ? `Wrap ${formatUnits(amountInWei, 18)} ETH to WETH` : `Unwrap ${formatUnits(amountInWei, 18)} WETH to ETH`,
            routePath: isWrap ? `ETH ➝ WETH` : `WETH ➝ ETH`, router: wethAddr,
            calldata: encodeFunctionData({abi: WETH_ABI, functionName: isWrap ? 'deposit' : 'withdraw', args: isWrap ? [] : [amountInWei]})
        };

        return { status: "success", winner: routeObj.name, expectedOutput: routeObj.expectedOutput, routePath: routeObj.routePath, targetContract: wethAddr, calldata: routeObj.calldata, tokenInAddress: undefined, amountInWei: amountInWei.toString(), isNativeIn: isWrap, value: isWrap ? amountInWei.toString() : "0", allRoutes: [routeObj] };
    }

    if (!tInAddr || !tOutAddr) throw new Error(`Desteklenmeyen Token veya Adres: ${tIn} veya ${tOut}`);

    await checkTokenSecurity(tInAddr);
    await checkTokenSecurity(tOutAddr);

    const isNativeIn = tIn.toUpperCase() === "ETH";
    const decimalsIn = isNativeIn ? 18 : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'decimals' });
    const decimalsOut = tOut.toUpperCase() === "ETH" ? 18 : await publicClient.readContract({ address: tOutAddr, abi: erc20Abi, functionName: 'decimals' });

    let amountInWei = parseUnits(intent.amount || "0", decimalsIn);
    let bal = isNativeIn ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) : await publicClient.readContract({ address: tInAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });

    if (amountInWei === 0n) amountInWei = isNativeIn ? bal - parseUnits("0.001", 18) : bal;
    if (amountInWei <= 0n || bal < amountInWei) throw new Error(`Yetersiz Bakiye! Cüzdanınızda yeterli token bulunamadı.`);

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
        if (finalRoutes.length === 0) throw new Error(`🚨 Sadece "${intent.protocol}" protokolü istendi ancak bu işlem için güvenli bir rota bulunamadı.`);
    }

    const sortedRoutes = finalRoutes.sort((a, b) => { return (a.amountOut || 0n) < (b.amountOut || 0n) ? 1 : -1; });
    let winner = sortedRoutes[0];
    
    return { status: "success", winner: winner.name, expectedOutput: winner.expectedOutput, routePath: winner.routePath, targetContract: winner.router, calldata: winner.calldata, tokenInAddress: tInAddr, amountInWei: amountInWei.toString(), isNativeIn, value: valStr, allRoutes: sortedRoutes };
}

async function handleLiquidity(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Token belirtilmemiş.");
    
    // ✨ TYPESCRIPT ZIRHI: safeAction'ın tipini baştan kesin olarak kilitliyoruz.
    const rawAction = intent.action.toLowerCase();
    let safeAction: "add_liquidity" | "remove_liquidity";
    
    if (rawAction === 'addliquidity' || rawAction === 'add_liquidity') {
        safeAction = 'add_liquidity';
    } else if (rawAction === 'removeliquidity' || rawAction === 'remove_liquidity') {
        safeAction = 'remove_liquidity';
    } else {
        throw new Error(`🚨 Desteklenmeyen Havuz İşlemi: ${rawAction}`);
    }
                       
    const raw = await getLiquidityRoutes(safeAction, intent.tokenIn, intent.tokenOut, intent.amount!, userAddress, intent.protocol);
    
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