import { parseUnits, formatUnits, erc20Abi } from 'viem';
import { publicClient } from '../config/client.js';
import { getAddressSafe } from './utils.js';

export function feePolicyActionForIntent(
    action: string,
    tokenIn?: string,
    tokenOut?: string,
): string {
    const normalizedAction = action.trim().toLowerCase();
    const normalizedTokenIn = tokenIn?.trim().toUpperCase();
    const normalizedTokenOut = tokenOut?.trim().toUpperCase();
    if (
        normalizedAction === 'swap' &&
        (
            (
                normalizedTokenIn === 'ETH' &&
                normalizedTokenOut === 'WETH'
            ) ||
            (
                normalizedTokenIn === 'WETH' &&
                normalizedTokenOut === 'ETH'
            )
        )
    ) {
        return 'wrapped_native_conversion';
    }
    return normalizedAction;
}

export async function applyKletiaFee(tokenSymbol: string, amountStr: string, userAddress: string, action: string) {
    const feeExemptActions = [
        'portfolio',
        'basename_register',
        'basename_renew',
        'deploy_token',
        'mint_nft',

        'add_liquidity',
        'remove_liquidity',
        'borrow',
        'withdraw',

        'lend',
        'repay',
        'stake',
        'yield_compare',

        'liquid_stake',
        'liquid_unstake',

        'wrapped_native_conversion',
    ];
    if (feeExemptActions.includes(action.toLowerCase())) {
        return { netAmountStr: amountStr, feeData: null };
    }

    const isNative = tokenSymbol.toUpperCase() === "ETH";
    const tokenAddr = getAddressSafe(isNative ? "WETH" : tokenSymbol);
    if (!tokenAddr) return { netAmountStr: amountStr, feeData: null };

    const decimals = isNative ? 18 : await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' });

    let amountWei = 0n;
    if (amountStr.toUpperCase() === "MAX") {
        const balance = isNative 
            ? await publicClient.getBalance({ address: userAddress as `0x${string}` }) 
            : await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        const nativeGasReserve = parseUnits("0.001", 18);
        amountWei = isNative
            ? balance > nativeGasReserve
                ? balance - nativeGasReserve
                : 0n
            : balance;
    } else {
        amountWei = parseUnits(amountStr, decimals);
    }

    if (amountWei <= 0n) {
        throw Object.assign(
            new Error('Ücret ve gas sonrasında kullanılabilir pozitif bakiye kalmadı.'),
            { code: 'INSUFFICIENT_FUNDS', statusCode: 400 },
        );
    }

    const feeWei = (amountWei * 10n) / 10000n; 
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
