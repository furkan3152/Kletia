// backend/src/dex/aerodrome.ts
import { encodeFunctionData, formatUnits } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS, ROUTERS, AERO_ETH_ABI, AERODROME_ROUTER_ABI, SLIPSTREAM_QUOTER_ABI, SLIPSTREAM_ROUTER_ABI } from '../config/constants.js';

export async function getAerodromeRoutes(amountInWei: bigint, tokenInAddr: `0x${string}`, tokenOutAddr: `0x${string}`, tokenInSymbol: string, tokenOutSymbol: string, isNativeIn: boolean, userAddress: string, deadline: bigint, decimalsOut: number) {
    const routes: any[] = [];
    const safeTokenIn = isNativeIn ? "WETH" : tokenInSymbol;

    // 1. AŞAMA: AERO V1 (Önce Volatile, Sonra Stable dener)
    let v1Amount = 0n;
    let v1Stable = false;
    try {
        const d = await publicClient.readContract({ address: ROUTERS.AERO_V1, abi: AERODROME_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountInWei, [{ from: tokenInAddr, to: tokenOutAddr, stable: false, factory: ROUTERS.AERO_FACTORY }]] });
        v1Amount = (d as any)[(d as any).length - 1] as bigint;
    } catch {
        try {
            const d2 = await publicClient.readContract({ address: ROUTERS.AERO_V1, abi: AERODROME_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountInWei, [{ from: tokenInAddr, to: tokenOutAddr, stable: true, factory: ROUTERS.AERO_FACTORY }]] });
            v1Amount = (d2 as any)[(d2 as any).length - 1] as bigint;
            v1Stable = true;
        } catch { }
    }

    if (v1Amount > 0n) {
        // ✨ BAŞ MİMAR DOKUNUŞU: %1 Slippage (Kayma) Koruması (V1 İçin)
        // Eğer havuzdan beklenen çıktı v1Amount ise, MEV botları bunu en fazla %1 aşağı çekebilir.
        const v1AmountOutMin = (v1Amount * 99n) / 100n;

        routes.push({
            name: "Aerodrome V1", amount: v1Amount, expectedOutput: formatUnits(v1Amount, decimalsOut),
            routePath: `${tokenInSymbol} ➝ [Aerodrome V1] ➝ ${tokenOutSymbol}`, router: ROUTERS.AERO_V1,
            calldata: isNativeIn ? encodeFunctionData({ abi: AERO_ETH_ABI, functionName: 'swapExactETHForTokens', args: [v1AmountOutMin, [{ from: tokenInAddr, to: tokenOutAddr, stable: v1Stable, factory: ROUTERS.AERO_FACTORY }], userAddress as `0x${string}`, deadline] }) : encodeFunctionData({ abi: AERODROME_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountInWei, v1AmountOutMin, [{ from: tokenInAddr, to: tokenOutAddr, stable: v1Stable, factory: ROUTERS.AERO_FACTORY }], userAddress as `0x${string}`, deadline] })
        });
    }

    // 2. AŞAMA: AERO SLIPSTREAM (V3)
    let slipAmount = 0n;
    let slipTick = 1;
    for (const t of [1, 50, 100, 200, 500, 2000]) {
        try {
            const d = await publicClient.readContract({ address: ROUTERS.AERO_SLIPSTREAM_QUOTER, abi: SLIPSTREAM_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tokenInAddr, tokenOut: tokenOutAddr, amountIn: amountInWei, tickSpacing: t, sqrtPriceLimitX96: 0n }] });
            let out = Array.isArray(d) ? d[0] as bigint : (d as any).amountOut as bigint;
            if (out > slipAmount) { slipAmount = out; slipTick = t; }
        } catch { continue; }
    }

    if (slipAmount > 0n) {
        // ✨ BAŞ MİMAR DOKUNUŞU: %1 Slippage (Kayma) Koruması (Slipstream V3 İçin)
        // Konsantre likiditede MEV saldırıları çok daha sert olur. amountOutMinimum artık 0 değil!
        const slipAmountOutMin = (slipAmount * 99n) / 100n;

        routes.push({
            name: "Aerodrome Slipstream", amount: slipAmount, expectedOutput: formatUnits(slipAmount, decimalsOut),
            routePath: `${tokenInSymbol} ➝ [Aero Slipstream] ➝ ${tokenOutSymbol}`, router: ROUTERS.AERO_SLIPSTREAM,
            calldata: encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: tokenInAddr, tokenOut: tokenOutAddr, tickSpacing: slipTick, recipient: userAddress as `0x${string}`, deadline: deadline, amountIn: amountInWei, amountOutMinimum: slipAmountOutMin, sqrtPriceLimitX96: 0n }] })
        });
    }

    return routes;
}