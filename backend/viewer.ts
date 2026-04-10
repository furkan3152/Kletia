// backend/src/portfolio/viewer.ts
import { formatUnits, erc20Abi, getAddress } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

const AAVE_POOL_BASE = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const VE_AERO_CONTRACT = getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4");

const AAVE_ABI = [{ "inputs": [{ "internalType": "address", "name": "user", "type": "address" }], "name": "getUserAccountData", "outputs": [{ "internalType": "uint256", "name": "totalCollateralBase", "type": "uint256" }, { "internalType": "uint256", "name": "totalDebtBase", "type": "uint256" }, { "internalType": "uint256", "name": "availableBorrowsBase", "type": "uint256" }, { "internalType": "uint256", "name": "currentLiquidationThreshold", "type": "uint256" }, { "internalType": "uint256", "name": "ltv", "type": "uint256" }, { "internalType": "uint256", "name": "healthFactor", "type": "uint256" }], "stateMutability": "view", "type": "function" }] as const;

// Aerodrome Oylama Gücü ve Kilit Okuma ABI'si
const VE_AERO_ABI = [
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenOfOwnerByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "_tokenId", "type": "uint256" }], "name": "locked", "outputs": [{ "internalType": "int128", "name": "amount", "type": "int128" }, { "internalType": "uint256", "name": "end", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "_tokenId", "type": "uint256" }], "name": "balanceOfNFT", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

export async function getPortfolio(userAddress: string) {
    console.log(`\n==============================================`);
    console.log(`💼 [PORTFOLIO] Scanning deep DeFi assets for ${userAddress}...`);
    console.log(`==============================================`);

    const wallet: { symbol: string, balance: string, formatted: string }[] = [];
    const defiPositions: any = {};

    // 1. CÜZDAN BAKİYELERİ (Wallet Assets)
    const ethBalance = await publicClient.getBalance({ address: userAddress as `0x${string}` });
    if (ethBalance > 0n) wallet.push({ symbol: "ETH", balance: ethBalance.toString(), formatted: parseFloat(formatUnits(ethBalance, 18)).toFixed(4) });

    const tokenSymbols = Object.keys(TOKENS).filter(sym => sym !== "ETH");
    for (const symbol of tokenSymbols) {
        const address = TOKENS[symbol];
        try {
            const balance = await publicClient.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
            if (balance > 0n) {
                const decimals = await publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' });
                wallet.push({ symbol, balance: balance.toString(), formatted: parseFloat(formatUnits(balance, decimals)).toFixed(4) });
            }
        } catch (error) { continue; }
    }

    // 2. AAVE V3 BORÇ/LEND POZİSYONLARI
    try {
        const aaveData = await publicClient.readContract({ address: AAVE_POOL_BASE, abi: AAVE_ABI, functionName: 'getUserAccountData', args: [userAddress as `0x${string}`] }) as unknown as any[];
        const collateral = parseFloat(formatUnits(aaveData[0], 8)).toFixed(2);
        const debt = parseFloat(formatUnits(aaveData[1], 8)).toFixed(2);
        const availableBorrow = parseFloat(formatUnits(aaveData[2], 8)).toFixed(2);
        
        if (Number(collateral) > 0 || Number(debt) > 0) {
            defiPositions.aave = {
                suppliedCollateralUSD: `$${collateral}`,
                totalDebtUSD: `$${debt}`,
                availableBorrowPowerUSD: `$${availableBorrow}`,
                healthFactor: Number(aaveData[5]) > 1000000 ? "SAFE" : parseFloat(formatUnits(aaveData[5], 18)).toFixed(2)
            };
        }
    } catch (e) {}

    // 3. AERODROME (veAERO) STAKING POZİSYONLARI
    try {
        const nftBalance = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        if (nftBalance > 0n) {
            const tokenId = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'tokenOfOwnerByIndex', args: [userAddress as `0x${string}`, 0n] });
            const lockedData = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'locked', args: [tokenId] }) as unknown as any[];
            const votingPower = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'balanceOfNFT', args: [tokenId] });
            
            const lockedAmount = formatUnits(lockedData[0], 18);
            const formattedPower = formatUnits(votingPower, 18);
            
            // Tarih Çevirimi (Saniyeden Gün/Ay/Yıl Formatına)
            const unlockTimestamp = Number(lockedData[1]) * 1000;
            const unlockDateStr = new Date(unlockTimestamp).toLocaleDateString('en-GB'); // DD/MM/YYYY formatı

            if (Number(lockedAmount) > 0) {
                defiPositions.aerodrome = {
                    lockId: tokenId.toString(),
                    lockedAmount: parseFloat(lockedAmount).toFixed(2) + " AERO",
                    votingPower: parseFloat(formattedPower).toFixed(2) + " veAERO",
                    unlockDate: unlockDateStr
                };
            }
        }
    } catch (e) {}

    console.log(`🟢 [PORTFOLIO] Scan complete.`);
    
    let displayMessage = `**DeFi Portfolio Scanned Successfully.**\nAssets found across Wallet, Aave, and Aerodrome.`;

    return {
        status: "success",
        action: "portfolio",
        data: { wallet, defiPositions },
        expectedOutput: "DeFi Portfolio Overview",
        message: displayMessage
    };
}