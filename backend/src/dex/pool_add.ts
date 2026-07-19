import { encodeFunctionData, parseUnits, formatUnits, erc20Abi } from 'viem';
import { publicClient } from '../config/client.js';
import { ROUTERS, UNI_V2_ROUTER_ABI, AERODROME_ROUTER_ABI, AERO_ABI, UNIV2_ABI, AERO_FACTORY } from './dex_constants.js';

export async function buildAddLiquidityRoutes(
    tA_Address: `0x${string}`, 
    tB_Address: `0x${string}`, 
    amountStr: string, 
    userAddress: string, 
    requestedProtocol: string | undefined, 
    tIn: string, 
    tOut: string, 
    hasNativeETH: boolean, 
    isNativeA: boolean,
    isNativeB: boolean
) {
    const getBalance = async (isNative: boolean, addr: string) => {
        const decimals = isNative ? 18 : await publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'decimals' });
        const balance = isNative ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) : await publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        return { decimals, balance, addr };
    };

    const tokenAData = await getBalance(isNativeA, tA_Address);
    const tokenBData = await getBalance(isNativeB, tB_Address);

    let amountAWei = parseUnits(amountStr || "0", tokenAData.decimals);
    if (tokenAData.balance < amountAWei) throw new Error(`❌ INSUFFICIENT_FUNDS: Not enough ${amountStr} ${tIn} in wallet.`);

    let amountBWei = 0n;
    try {
        const amountsUni = await publicClient.readContract({
            address: ROUTERS.UNI_V2, abi: UNI_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountAWei, [tA_Address as `0x${string}`, tB_Address as `0x${string}`]]
        }) as bigint[];
        amountBWei = amountsUni[1];
    } catch(e) {
        try {
            const amountsAero = await publicClient.readContract({
                address: ROUTERS.AERO_V1, abi: AERODROME_ROUTER_ABI, functionName: 'getAmountsOut', 
                args: [amountAWei, [{from: tA_Address as `0x${string}`, to: tB_Address as `0x${string}`, stable: false, factory: AERO_FACTORY}]]
            }) as bigint[];
            amountBWei = amountsAero[1];
        } catch(e2) {
            throw new Error(`🚨 Havuz Oranı Bulunamadı (${tIn}-${tOut}). Bu çift için yeterli likidite olmayabilir.`);
        }
    }

    if (tokenBData.balance < amountBWei) throw new Error(`❌ INSUFFICIENT_FUNDS: Need ${formatUnits(amountBWei, tokenBData.decimals)} ${tOut} to match pool ratio.`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
    
    const amountAMin = (amountAWei * 99n) / 100n;
    const amountBMin = (amountBWei * 99n) / 100n;

    let rawRoutes: any[] = [];

    const buildRoute = (protocolName: string, router: `0x${string}`, isAero: boolean) => {
        let calldata: `0x${string}`;
        let msgValue = "0";
        let secAddr = tokenBData.addr as `0x${string}`;
        let secAmt = amountBWei.toString();

        if (hasNativeETH) {
            const erc20Data = isNativeA ? tokenBData : tokenAData;
            const erc20Amount = isNativeA ? amountBWei : amountAWei;
            const ethAmount = isNativeA ? amountAWei : amountBWei;

            const minErc20 = isNativeA ? amountBMin : amountAMin;
            const minEth = isNativeA ? amountAMin : amountBMin;

            msgValue = ethAmount.toString(); 
            secAddr = erc20Data.addr as `0x${string}`; 
            secAmt = erc20Amount.toString();

            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'addLiquidityETH', args: [secAddr as `0x${string}`, false, erc20Amount, minErc20, minEth, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'addLiquidityETH', args: [secAddr as `0x${string}`, erc20Amount, minErc20, minEth, userAddress as `0x${string}`, deadline] });
        } else {
            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'addLiquidity', args: [tokenAData.addr as `0x${string}`, tokenBData.addr as `0x${string}`, false, amountAWei, amountBWei, amountAMin, amountBMin, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'addLiquidity', args: [tokenAData.addr as `0x${string}`, tokenBData.addr as `0x${string}`, amountAWei, amountBWei, amountAMin, amountBMin, userAddress as `0x${string}`, deadline] });
        }

        return {
            name: `${protocolName} (LP)`, amount: amountAWei, value: msgValue,
            expectedOutput: `Pooling ${amountStr} ${tIn} & ${parseFloat(formatUnits(amountBWei, tokenBData.decimals)).toFixed(5)} ${tOut}`,
            routePath: `${tIn} + ${tOut} ➝ [${protocolName}]`, router: router, calldata: calldata, 
            secondaryTokenAddress: secAddr, secondaryAmountInWei: secAmt,
            primaryTokenAddress: isNativeA ? undefined : tokenAData.addr, primaryAmountInWei: isNativeA ? undefined : amountAWei.toString()
        };
    };

    rawRoutes.push(buildRoute("Aerodrome", ROUTERS.AERO_V1, true));
    rawRoutes.push(buildRoute("Uniswap V2", ROUTERS.UNI_V2, false));
    rawRoutes.push(buildRoute("Alien Base", ROUTERS.ALIEN_BASE, false));

    if (requestedProtocol) return rawRoutes.filter(r => r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, '')));
    return rawRoutes;
}
