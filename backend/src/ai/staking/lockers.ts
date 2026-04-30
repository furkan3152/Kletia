import { encodeFunctionData, parseUnits, formatUnits, erc20Abi, getAddress } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

const VE_AERO_CONTRACT = getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4");

// ✨ Baş Mimar Hatası Düzeltildi: Aerodrome %100 Solidity'dir!
const VE_AERO_ABI = [
    { "inputs": [{ "internalType": "uint256", "name": "_value", "type": "uint256" }, { "internalType": "uint256", "name": "_lock_duration", "type": "uint256" }], "name": "createLock", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "_tokenId", "type": "uint256" }, { "internalType": "uint256", "name": "_value", "type": "uint256" }], "name": "increaseAmount", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenOfOwnerByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

export async function getStakingRoutes(tokenInSymbol: string, amountStr: string, durationInDays: number, userAddress: string, requestedProtocol?: string) {
    const safeSymbol = tokenInSymbol.toUpperCase() === "ETH" ? "WETH" : tokenInSymbol.toUpperCase();
    const tokenInAddr = TOKENS[safeSymbol];
    
    if (!tokenInAddr) throw new Error(`🚨 Hata: ${safeSymbol} Staking için desteklenmiyor.`);

    const decimalsIn = await publicClient.readContract({ address: tokenInAddr, abi: erc20Abi, functionName: 'decimals' });
    let amountInWei = parseUnits(amountStr || "0", decimalsIn);

    const userBalance = await publicClient.readContract({ address: tokenInAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });

    if (amountInWei === 0n) amountInWei = userBalance;
    if (amountInWei <= 0n || userBalance < amountInWei) throw new Error(`❌ Yetersiz Bakiye!`);

    const formattedAmount = formatUnits(amountInWei, decimalsIn);
    const WEEK = 604800; 
    const MAXTIME = 126144000; 

    let rawSeconds = durationInDays * 24 * 60 * 60;
    let durationInSeconds = Math.floor(rawSeconds / WEEK) * WEEK;
    if (durationInSeconds < WEEK) durationInSeconds = WEEK;
    if (durationInSeconds > MAXTIME - WEEK) durationInSeconds = MAXTIME - WEEK;

    let rawRoutes: any[] = [];

    if (safeSymbol === "AERO") {
        let existingTokenId = 0n;

        try {
            const nftBalance = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
            if (nftBalance > 0n) {
                try {
                    existingTokenId = await publicClient.readContract({ address: VE_AERO_CONTRACT, abi: VE_AERO_ABI, functionName: 'tokenOfOwnerByIndex', args: [userAddress as `0x${string}`, 0n] });
                } catch (innerE) {
                    console.log(`⚠️ Kilit okunamadı. Yeni kilit (createLock) açılacak.`);
                }
            }
        } catch (e: any) {}

        const votingPowerMultiplier = durationInSeconds / MAXTIME;
        const expectedVotingPower = (parseFloat(formattedAmount) * votingPowerMultiplier).toFixed(2);

        if (existingTokenId > 0n) {
            rawRoutes.push({ 
                name: "Aerodrome Finance (Lock)", amount: amountInWei, 
                expectedOutput: `Adding ${formattedAmount} AERO to Lock #${existingTokenId} ➝ +${expectedVotingPower} veAERO`, 
                routePath: `AERO ➝ [veAERO Lock #${existingTokenId}] ➝ Power`, router: VE_AERO_CONTRACT, 
                calldata: encodeFunctionData({ abi: VE_AERO_ABI, functionName: 'increaseAmount', args: [existingTokenId, amountInWei] }) 
            });
        } else {
            rawRoutes.push({ 
                name: "Aerodrome Finance (New Lock)", amount: amountInWei, 
                expectedOutput: `Locking ${formattedAmount} AERO for ~${Math.floor(durationInSeconds / 86400)} days ➝ Power: ${expectedVotingPower} veAERO`, 
                routePath: `AERO ➝ [veAERO Time-Lock] ➝ Voting Power`, router: VE_AERO_CONTRACT, 
                calldata: encodeFunctionData({ abi: VE_AERO_ABI, functionName: 'createLock', args: [amountInWei, BigInt(durationInSeconds)] }) 
            });
        }
    }

    if (requestedProtocol) return rawRoutes.filter(r => r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, '')));
    return rawRoutes;
}