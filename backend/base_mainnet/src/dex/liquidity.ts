import { getAddressSafe } from '../intent/utils.js';
import { buildAddLiquidityRoutes } from './pool_add.js';
import { buildRemoveLiquidityRoutes } from './pool_remove.js';

export async function getLiquidityRoutes(action: 'add_liquidity' | 'remove_liquidity', tIn: string, tOut: string | undefined, amountStr: string, userAddress: string, requestedProtocol?: string) {
    if (action !== 'add_liquidity' && action !== 'remove_liquidity') {
        throw new Error(`Desteklenmeyen LP Action: ${action}`);
    }
    if (!tOut) throw new Error("🚨 Havuz işlemleri (LP) için 2 adet token belirtilmelidir. Örn: 'Add 100 USDC and WETH to pool'");

    const tA_Address = getAddressSafe(tIn === "ETH" ? "WETH" : tIn);
    const tB_Address = getAddressSafe(tOut === "ETH" ? "WETH" : tOut);

    if (!tA_Address || !tB_Address) throw new Error(`Geçersiz token çifti: ${tIn}-${tOut}`);

    const isNativeA = tIn.toUpperCase() === "ETH";
    const isNativeB = tOut.toUpperCase() === "ETH";
    const hasNativeETH = isNativeA || isNativeB;

    if (action === 'add_liquidity') {
        return buildAddLiquidityRoutes(tA_Address, tB_Address, amountStr, userAddress, requestedProtocol, tIn, tOut, hasNativeETH, isNativeA, isNativeB);
    } else {
        return buildRemoveLiquidityRoutes(tA_Address, tB_Address, amountStr, userAddress, requestedProtocol, tIn, tOut, hasNativeETH, isNativeA);
    }
}