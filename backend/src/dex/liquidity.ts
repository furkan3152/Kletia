// backend/src/dex/liquidity.ts
import { encodeFunctionData, parseUnits, formatUnits, erc20Abi } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS, ROUTERS, UNI_V2_ROUTER_ABI, AERODROME_ROUTER_ABI } from '../config/constants.js';

const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFeCE40Da".toLowerCase() as `0x${string}`;
const UNI_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC4".toLowerCase() as `0x${string}`;
const ALIEN_FACTORY = "0x3E84D913803b02A4a7f027165E8cB244B7eD2F22".toLowerCase() as `0x${string}`;

const UNI_FACTORY_ABI = [{"inputs":[{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"}],"name":"getPair","outputs":[{"internalType":"address","name":"pair","type":"address"}],"stateMutability":"view","type":"function"}] as const;
const AERO_FACTORY_ABI = [{"inputs":[{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"},{"internalType":"bool","name":"stable","type":"bool"}],"name":"getPool","outputs":[{"internalType":"address","name":"pool","type":"address"}],"stateMutability":"view","type":"function"}] as const;

const AERO_ABI = [
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "uint256", "name": "amountADesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountBDesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "addLiquidity", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "uint256", "name": "amountTokenDesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "addLiquidityETH", "outputs": [], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "removeLiquidity", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "removeLiquidityETH", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
] as const;

const UNIV2_ABI = [
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "uint256", "name": "amountADesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountBDesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "addLiquidity", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "uint256", "name": "amountTokenDesired", "type": "uint256" }, { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "addLiquidityETH", "outputs": [], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "removeLiquidity", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "removeLiquidityETH", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
] as const;

export async function getLiquidityRoutes(action: 'add_liquidity' | 'remove_liquidity' | 'claim', tokenInSymbol: string, tokenOutSymbol: string | undefined, amountStr: string, userAddress: string, requestedProtocol?: string) {
    if (action === 'claim') {
        throw new Error("🚨 Kletia: Ödül toplama (Claim) işlemi her havuzun kendine özel 'Gauge' kontratı üzerinden yapılır. Tam otonom Claim modülü Kletia'nın bir sonraki güncellemesiyle eklenecektir!");
    }

    const tIn = tokenInSymbol.trim().toUpperCase();
    const tOut = (tokenOutSymbol || "").trim().toUpperCase();
    if (!tOut) throw new Error("🚨 İkinci token eksik.");

    const isNativeA = tIn === "ETH";
    const isNativeB = tOut === "ETH";
    const hasNativeETH = isNativeA || isNativeB;

    // ✨ Adresleri Viem'in sevdiği standart (küçük harf) yapıya zorluyoruz
    const tA_Address = TOKENS[isNativeA ? "WETH" : tIn].toLowerCase() as `0x${string}`;
    const tB_Address = TOKENS[isNativeB ? "WETH" : tOut].toLowerCase() as `0x${string}`;

    if (!tA_Address || !tB_Address) throw new Error(`🚨 Sistemde kayıtlı olmayan token: ${tIn} veya ${tOut}`);

    if (action === 'remove_liquidity') {
        // ✨ HAVUZ BULUCU: Hataları tamamen yutan ve sadece geçerli adres döndüren yapı
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

        const aeroPool = await getPoolAero();
        const uniPool = await getPoolUni(UNI_FACTORY);
        const alienPool = await getPoolUni(ALIEN_FACTORY);

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

            if (hasNativeETH) {
                const erc20Addr = isNativeA ? tB_Address : tA_Address;
                if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'removeLiquidityETH', args: [erc20Addr as `0x${string}`, false, amtToRemove, 0n, 0n, userAddress as `0x${string}`, deadline] });
                else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'removeLiquidityETH', args: [erc20Addr as `0x${string}`, amtToRemove, 0n, 0n, userAddress as `0x${string}`, deadline] });
            } else {
                if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'removeLiquidity', args: [tA_Address as `0x${string}`, tB_Address as `0x${string}`, false, amtToRemove, 0n, 0n, userAddress as `0x${string}`, deadline] });
                else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'removeLiquidity', args: [tA_Address as `0x${string}`, tB_Address as `0x${string}`, amtToRemove, 0n, 0n, userAddress as `0x${string}`, deadline] });
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
            throw new Error(`🚨 ${tIn}-${tOut} cüzdanınızda LP token yok (veya sıfır).`);
        }
        
        if (requestedProtocol) return rawRemoveRoutes.filter(r => r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, '')));
        return rawRemoveRoutes;
    }

    const getBalance = async (isNative: boolean, addr: string) => {
        const decimals = isNative ? 18 : await publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'decimals' });
        const balance = isNative ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) : await publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        return { decimals, balance, addr };
    };

    const tokenAData = await getBalance(isNativeA, tA_Address);
    const tokenBData = await getBalance(isNativeB, tB_Address);

    let amountAWei = parseUnits(amountStr || "0", tokenAData.decimals);
    if (tokenAData.balance < amountAWei) throw new Error(`❌ Yetersiz Bakiye: Cüzdanda ${amountStr} ${tIn} yok.`);

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

    if (tokenBData.balance < amountBWei) throw new Error(`❌ Yetersiz Bakiye: Havuz eşleşmesi için ${formatUnits(amountBWei, tokenBData.decimals)} ${tOut} gerekiyor.`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
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

            msgValue = ethAmount.toString(); 
            secAddr = erc20Data.addr as `0x${string}`; 
            secAmt = erc20Amount.toString();

            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'addLiquidityETH', args: [secAddr as `0x${string}`, false, erc20Amount, 0n, 0n, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'addLiquidityETH', args: [secAddr as `0x${string}`, erc20Amount, 0n, 0n, userAddress as `0x${string}`, deadline] });
        } else {
            if (isAero) calldata = encodeFunctionData({ abi: AERO_ABI, functionName: 'addLiquidity', args: [tokenAData.addr as `0x${string}`, tokenBData.addr as `0x${string}`, false, amountAWei, amountBWei, 0n, 0n, userAddress as `0x${string}`, deadline] });
            else calldata = encodeFunctionData({ abi: UNIV2_ABI, functionName: 'addLiquidity', args: [tokenAData.addr as `0x${string}`, tokenBData.addr as `0x${string}`, amountAWei, amountBWei, 0n, 0n, userAddress as `0x${string}`, deadline] });
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