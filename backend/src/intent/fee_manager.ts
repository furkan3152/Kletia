import { parseUnits, formatUnits, erc20Abi } from 'viem';
import { publicClient } from '../config/client.js';
import { getAddressSafe } from './utils.js';

export async function applyKletiaFee(tokenSymbol: string, amountStr: string, userAddress: string, action: string) {
    const feeExemptActions = ['portfolio', 'basename_register', 'basename_renew', 'deploy_token', 'mint_nft'];
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

    const feeWei = (amountWei * 10n) / 10000n; // %0.1
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
