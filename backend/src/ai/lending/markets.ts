// backend/src/lending/markets.ts
import { encodeFunctionData, parseUnits, formatUnits, erc20Abi, getAddress, maxUint256 } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

// AAVE V3 POOL SÖZLEŞMESİ (Base Ağı)
const AAVE_POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");

// MOONWELL mTOKEN SÖZLEŞMELERİ (Compound V2 Fork)
const MOONWELL_MTOKENS: Record<string, `0x${string}`> = {
    "WETH": getAddress("0x628ff693D22751D3691740560FCfEc11e03A3A95"),
    "USDC": getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22"),
    "CBBTC": getAddress("0xcc970D2bb6cb7D9E0eEbb17c7674251214A3D0AE")
};

// --- ABI TANIMLAMALARI ---
const AAVE_ABI = [
    { "inputs": [{ "internalType": "address", "name": "asset", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "address", "name": "onBehalfOf", "type": "address" }, { "internalType": "uint16", "name": "referralCode", "type": "uint16" }], "name": "supply", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "asset", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }], "name": "withdraw", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "asset", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "interestRateMode", "type": "uint256" }, { "internalType": "uint16", "name": "referralCode", "type": "uint16" }, { "internalType": "address", "name": "onBehalfOf", "type": "address" }], "name": "borrow", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "asset", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "interestRateMode", "type": "uint256" }, { "internalType": "address", "name": "onBehalfOf", "type": "address" }], "name": "repay", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }
] as const;

// ✨ BAŞ MİMAR: Aave'den Anlık Borç Çekmek İçin ReserveData ABI'si eklendi
const AAVE_RESERVE_DATA_ABI = [{ "inputs": [{ "internalType": "address", "name": "asset", "type": "address" }], "name": "getReserveData", "outputs": [{ "components": [ { "internalType": "uint256", "name": "configuration", "type": "uint256" }, { "internalType": "uint128", "name": "liquidityIndex", "type": "uint128" }, { "internalType": "uint128", "name": "variableBorrowIndex", "type": "uint128" }, { "internalType": "uint128", "name": "currentLiquidityRate", "type": "uint128" }, { "internalType": "uint128", "name": "currentVariableBorrowRate", "type": "uint128" }, { "internalType": "uint128", "name": "currentStableBorrowRate", "type": "uint128" }, { "internalType": "uint40", "name": "lastUpdateTimestamp", "type": "uint40" }, { "internalType": "uint16", "name": "id", "type": "uint16" }, { "internalType": "address", "name": "aTokenAddress", "type": "address" }, { "internalType": "address", "name": "stableDebtTokenAddress", "type": "address" }, { "internalType": "address", "name": "variableDebtTokenAddress", "type": "address" }, { "internalType": "address", "name": "interestRateStrategyAddress", "type": "address" }, { "internalType": "uint128", "name": "accruedToTreasury", "type": "uint128" }, { "internalType": "uint128", "name": "unbacked", "type": "uint128" }, { "internalType": "uint128", "name": "isolationModeTotalDebt", "type": "uint128" } ], "internalType": "struct DataTypes.ReserveData", "name": "", "type": "tuple" }], "stateMutability": "view", "type": "function" }] as const;

const MOONWELL_ABI = [
    { "inputs": [{ "internalType": "uint256", "name": "mintAmount", "type": "uint256" }], "name": "mint", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "redeemAmount", "type": "uint256" }], "name": "redeemUnderlying", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "borrowAmount", "type": "uint256" }], "name": "borrow", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "repayAmount", "type": "uint256" }], "name": "repayBorrow", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }
] as const;

// ✨ BAŞ MİMAR: Moonwell Borç Okuma ABI'si
const MOONWELL_DEBT_ABI = [{ "inputs": [{ "internalType": "address", "name": "account", "type": "address" }], "name": "borrowBalanceStored", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }] as const;

export async function getLendingRoutes(action: 'lend' | 'borrow' | 'repay' | 'withdraw', tokenSymbol: string, amountStr: string, userAddress: string, requestedProtocol?: string) {
    const isNative = tokenSymbol.toUpperCase() === "ETH";
    const safeSymbol = isNative ? "WETH" : tokenSymbol.toUpperCase();
    const tokenAddr = TOKENS[safeSymbol];

    if (!tokenAddr) throw new Error(`🚨 Kletia henüz ${safeSymbol} tokenini desteklemiyor.`);

    const decimals = await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' });
    let amountWei = parseUnits(amountStr || "0", decimals);

    // Her durumda cüzdan bakiyesini önden okuyoruz (Lend ve Akıllı Repay için şart)
    const balance = isNative 
        ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) 
        : await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });

    if (amountWei === 0n) {
        if (action === 'withdraw' || action === 'repay') {
            amountWei = maxUint256; 
        } else if (action === 'lend') {
            amountWei = isNative ? balance - parseUnits("0.001", 18) : balance;
        } else {
            throw new Error(`🚨 Borç alma (borrow) işlemlerinde net bir miktar belirtmelisiniz.`);
        }
    }

    // Normal (Belli bir Miktar Girilmiş) İşlemler için Bakiye Kontrolü
    if ((action === 'lend' || action === 'repay') && amountWei !== maxUint256) {
        if (balance < amountWei) throw new Error(`❌ Yetersiz Bakiye! Bu işlemi yapmak için cüzdanınızda yeterli ${safeSymbol} yok.`);
    }

    let aaveRepayAmount = amountWei;
    let moonwellRepayAmount = amountWei;

    // ✨ FAZ 1 - AKSİYON 2: "REVERT" ÖNLEYİCİ AKILLI REPAY MANTIĞI
    if (action === 'repay' && amountWei === maxUint256) {
        
        // 1. AAVE V3 Borç Analizi
        try {
            const reserveData = await publicClient.readContract({
                address: AAVE_POOL, abi: AAVE_RESERVE_DATA_ABI, functionName: 'getReserveData', args: [tokenAddr]
            }) as any;
            
            const vDebtToken = reserveData.variableDebtTokenAddress;
            if (vDebtToken) {
                const aaveDebt = await publicClient.readContract({ address: vDebtToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
                // Eğer borç, cüzdandaki paradan büyükse; maksimum ödeyebileceği tutar cüzdanındaki kadardır!
                aaveRepayAmount = (aaveDebt > balance) ? balance : maxUint256;
            }
        } catch (e) { aaveRepayAmount = balance; } // Hata olursa güvenli moda (cüzdan bakiyesi) geç

        // 2. MOONWELL Borç Analizi
        const mTokenAddr = MOONWELL_MTOKENS[safeSymbol];
        if (mTokenAddr) {
            try {
                const moonwellDebt = await publicClient.readContract({
                    address: mTokenAddr, abi: MOONWELL_DEBT_ABI, functionName: 'borrowBalanceStored', args: [userAddress as `0x${string}`]
                }) as bigint;
                moonwellRepayAmount = (moonwellDebt > balance) ? balance : maxUint256;
            } catch (e) { moonwellRepayAmount = balance; }
        }
    }

    const getExpectedText = (act: string, amt: bigint) => {
        if (amt === maxUint256) return `${act} MAX (Full Debt) ${safeSymbol}`;
        return `${act} ${parseFloat(formatUnits(amt, decimals)).toFixed(4)} ${safeSymbol}`;
    };

    let rawRoutes: any[] = [];
    const userAddrStr = userAddress as `0x${string}`;

    // ==========================================
    // 1. AAVE V3 ROTASI
    // ==========================================
    let aaveCalldata: `0x${string}`;
    if (action === 'lend') aaveCalldata = encodeFunctionData({ abi: AAVE_ABI, functionName: 'supply', args: [tokenAddr, amountWei, userAddrStr, 0] });
    else if (action === 'withdraw') aaveCalldata = encodeFunctionData({ abi: AAVE_ABI, functionName: 'withdraw', args: [tokenAddr, amountWei, userAddrStr] });
    else if (action === 'borrow') aaveCalldata = encodeFunctionData({ abi: AAVE_ABI, functionName: 'borrow', args: [tokenAddr, amountWei, 2n, 0, userAddrStr] });
    else aaveCalldata = encodeFunctionData({ abi: AAVE_ABI, functionName: 'repay', args: [tokenAddr, aaveRepayAmount, 2n, userAddrStr] }); // ✨ Akıllı Miktar

    rawRoutes.push({
        name: "Aave V3", amount: aaveRepayAmount !== maxUint256 && action === 'repay' ? aaveRepayAmount : amountWei,
        expectedOutput: `${getExpectedText(action.toUpperCase(), aaveRepayAmount)} via Aave V3`,
        routePath: `Aave V3 Pool ➝ [${action.toUpperCase()}]`,
        router: AAVE_POOL, calldata: aaveCalldata,
        primaryTokenAddress: tokenAddr, 
        primaryAmountInWei: (action === 'repay' ? aaveRepayAmount : amountWei).toString(),
        value: "0" 
    });

    // ==========================================
    // 2. MOONWELL ROTASI
    // ==========================================
    const mTokenAddr = MOONWELL_MTOKENS[safeSymbol];
    if (mTokenAddr) {
        let moonwellCalldata: `0x${string}`;
        if (action === 'lend') moonwellCalldata = encodeFunctionData({ abi: MOONWELL_ABI, functionName: 'mint', args: [amountWei] });
        else if (action === 'withdraw') moonwellCalldata = encodeFunctionData({ abi: MOONWELL_ABI, functionName: 'redeemUnderlying', args: [amountWei] });
        else if (action === 'borrow') moonwellCalldata = encodeFunctionData({ abi: MOONWELL_ABI, functionName: 'borrow', args: [amountWei] });
        else moonwellCalldata = encodeFunctionData({ abi: MOONWELL_ABI, functionName: 'repayBorrow', args: [moonwellRepayAmount] }); // ✨ Akıllı Miktar

        rawRoutes.push({
            name: "Moonwell", amount: moonwellRepayAmount !== maxUint256 && action === 'repay' ? moonwellRepayAmount : amountWei,
            expectedOutput: `${getExpectedText(action.toUpperCase(), moonwellRepayAmount)} via Moonwell`,
            routePath: `Moonwell ${safeSymbol} Market ➝ [${action.toUpperCase()}]`,
            router: mTokenAddr, calldata: moonwellCalldata,
            primaryTokenAddress: tokenAddr, 
            primaryAmountInWei: (action === 'repay' ? moonwellRepayAmount : amountWei).toString(),
            value: "0"
        });
    }

    if (requestedProtocol) {
        const filtered = rawRoutes.filter(r => r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, '')));
        if (filtered.length > 0) return filtered;
    }

    return rawRoutes;
}