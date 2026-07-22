import { encodeFunctionData, parseUnits, formatUnits, erc20Abi } from 'viem';
import { publicClient } from '../config/client.js';
import { ROUTERS, UNI_FACTORY_ABI, AERO_FACTORY_ABI, AERO_ABI, UNIV2_ABI, AERO_FACTORY } from './dex_constants.js';

export async function buildRemoveLiquidityRoutes(
    tA_Address: `0x${string}`, 
    tB_Address: `0x${string}`, 
    amountStr: string, 
    userAddress: string, 
    requestedProtocol: string | undefined, 
    tIn: string, 
    tOut: string, 
    hasNativeETH: boolean, 
    isNativeA: boolean
) {
    const getPoolUni = async (fac: `0x${string}`) => {
        try { 
            let p = await publicClient.readContract({ address: fac, abi: UNI_FACTORY_ABI, functionName: 'getPair', args: [tA_Address, tB_Address] }).catch(()=> null) as string | null;
            if (!p || p === "0x0000000000000000000000000000000000000000") {
                p = await publicClient.readContract({ address: fac, abi: UNI_FACTORY_ABI, functionName: 'getPair', args: [tB_Address, tA_Address] }).catch(()=> null) as string | null;
            }
            return (p && p !== "0x0000000000000000000000000000000000000000") ? p : null;
        } catch { return null; }
    };

    const getPoolAero = async () => {
        try { 
            let p = await publicClient.readContract({ address: AERO_FACTORY, abi: AERO_FACTORY_ABI, functionName: 'getPool', args: [tA_Address, tB_Address, false] }).catch(()=> null) as string | null;
            if (!p || p === "0x0000000000000000000000000000000000000000") {
                p = await publicClient.readContract({ address: AERO_FACTORY, abi: AERO_FACTORY_ABI, functionName: 'getPool', args: [tB_Address, tA_Address, false] }).catch(()=> null) as string | null;
            }
            return (p && p !== "0x0000000000000000000000000000000000000000") ? p : null;
        } catch { return null; }
    };

    const getFactoryFromRouter = async (routerAddr: `0x${string}`) => {
        try {
            return await publicClient.readContract({
                address: routerAddr,
                abi: [{"inputs":[],"name":"factory","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}],
                functionName: "factory"
            }) as `0x${string}`;
        } catch { return null; }
    };

    const aeroPool = await getPoolAero();
    
    const uniFactory = await getFactoryFromRouter(ROUTERS.UNI_V2);
    const uniPool = uniFactory ? await getPoolUni(uniFactory) : null;
    
    const alienFactory = await getFactoryFromRouter(ROUTERS.ALIEN_BASE);
    const alienPool = alienFactory ? await getPoolUni(alienFactory) : null;

    let rawRemoveRoutes: any[] = [];

    const buildRemove = async (protocolName: string, router: `0x${string}`, poolAddress: string | null, isAero: boolean) => {
        if (!poolAddress) return null;

        let lpBalance = 0n;
        try {
            lpBalance = await publicClient.readContract({ address: poolAddress as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        } catch { return null; }
        
        if (lpBalance === 0n) return null;

        const amtToRemove = (amountStr === "0" || amountStr === "MAX") ? lpBalance : parseUnits(amountStr, 18);
        if (amtToRemove > lpBalance) throw new Error(`❌ Yetersiz LP Bakiyesi. (${protocolName})`);

        let calldata: `0x${string}`;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

        let amountAMin = 0n;
        let amountBMin = 0n;
        try {
            const poolAbi = [
                { "inputs": [], "name": "getReserves", "outputs": [{ "internalType": "uint112", "name": "reserve0", "type": "uint112" }, { "internalType": "uint112", "name": "reserve1", "type": "uint112" }, { "internalType": "uint32", "name": "blockTimestampLast", "type": "uint32" }], "stateMutability": "view", "type": "function" },
                { "inputs": [], "name": "totalSupply", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
            ] as const;
            const totalSupply = await publicClient.readContract({ address: poolAddress as `0x${string}`, abi: poolAbi, functionName: 'totalSupply' }) as bigint;
            const reserves = await publicClient.readContract({ address: poolAddress as `0x${string}`, abi: poolAbi, functionName: 'getReserves' }) as [bigint, bigint, number];
            
            const reserveA = tA_Address.toLowerCase() < tB_Address.toLowerCase() ? reserves[0] : reserves[1];
            const reserveB = tA_Address.toLowerCase() < tB_Address.toLowerCase() ? reserves[1] : reserves[0];
            
            const expectedA = (amtToRemove * reserveA) / totalSupply;
            const expectedB = (amtToRemove * reserveB) / totalSupply;
            
            amountAMin = (expectedA * 99n) / 100n;
            amountBMin = (expectedB * 99n) / 100n;
        } catch (e) {
            console.log(`⚠️ Havuz rezervleri okunamadı (${protocolName}), işlem iptal ediliyor.`);
            return null; 
        }

        if (hasNativeETH) {
            const erc20Addr = isNativeA ? tB_Address : tA_Address;
            const amountTokenMin = isNativeA ? amountBMin : amountAMin;
            const amountETHMin = isNativeA ? amountAMin : amountBMin;
            
            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'removeLiquidityETH', args: [erc20Addr as `0x${string}`, false, amtToRemove, amountTokenMin, amountETHMin, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'removeLiquidityETH', args: [erc20Addr as `0x${string}`, amtToRemove, amountTokenMin, amountETHMin, userAddress as `0x${string}`, deadline] });
        } else {
            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'removeLiquidity', args: [tA_Address as `0x${string}`, tB_Address as `0x${string}`, false, amtToRemove, amountAMin, amountBMin, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'removeLiquidity', args: [tA_Address as `0x${string}`, tB_Address as `0x${string}`, amtToRemove, amountAMin, amountBMin, userAddress as `0x${string}`, deadline] });
        }

        return {
            name: `${protocolName} (Remove LP)`, amount: amtToRemove, value: "0",
            expectedOutput: `Removing ${parseFloat(formatUnits(amtToRemove, 18)).toFixed(5)} LP Tokens ➝ ${tIn} + ${tOut}`,
            routePath: `[${protocolName}] LP ➝ ${tIn} + ${tOut}`, router: router, calldata: calldata,
            primaryTokenAddress: poolAddress, primaryAmountInWei: amtToRemove.toString(),
            secondaryTokenAddress: undefined, secondaryAmountInWei: undefined
        };
    }

    const aeroRoute = await buildRemove("Aerodrome", ROUTERS.AERO_V1, aeroPool, true);
    const uniRoute = await buildRemove("Uniswap V2", ROUTERS.UNI_V2, uniPool, false);
    const alienRoute = await buildRemove("Alien Base", ROUTERS.ALIEN_BASE, alienPool, false);

    if (aeroRoute) rawRemoveRoutes.push(aeroRoute);
    if (uniRoute) rawRemoveRoutes.push(uniRoute);
    if (alienRoute) rawRemoveRoutes.push(alienRoute);

    if (rawRemoveRoutes.length === 0) {
        throw new Error(`🚨 INSUFFICIENT_FUNDS: No LP tokens (or zero balance) for ${tIn}-${tOut}.`);
    }
    
    if (requestedProtocol) return rawRemoveRoutes.filter(r => r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, '')));
    return rawRemoveRoutes;
}
