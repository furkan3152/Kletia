import { encodeFunctionData, formatUnits } from 'viem';
import { publicClient } from '../config/client.js';
import { ROUTERS, V3_QUOTER_V2_ABI, SLIPSTREAM_ROUTER_ABI } from '../config/constants.js';

export async function getV3Routes(amountInWei: bigint, tokenInAddr: `0x${string}`, tokenOutAddr: `0x${string}`, tokenInSymbol: string, tokenOutSymbol: string, isNativeIn: boolean, userAddress: string, deadline: bigint, decimalsOut: number, slippageBps: number = 100) {
    const routes: any[] = [];
    const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

    async function checkV3Router(quoterAddr: `0x${string}`, routerAddr: `0x${string}`, name: string) {
        let bestAmount = 0n;
        let bestFee = 500;

        for (const fee of feeTiers) {
            try {
                const params = {
                    tokenIn: tokenInAddr,
                    tokenOut: tokenOutAddr,
                    amountIn: amountInWei,
                    fee: fee,
                    sqrtPriceLimitX96: 0n
                };
                
                const d = await publicClient.readContract({
                    address: quoterAddr,
                    abi: V3_QUOTER_V2_ABI,
                    functionName: 'quoteExactInputSingle',
                    args: [params]
                });
                
                const out = Array.isArray(d) ? d[0] as bigint : (d as any).amountOut as bigint || d as unknown as bigint;
                
                if (out > bestAmount) {
                    bestAmount = out;
                    bestFee = fee;
                }
            } catch (e) {
                continue;
            }
        }

        if (bestAmount > 0n) {
            const amountOutMin = (bestAmount * BigInt(10000 - slippageBps)) / 10000n;

            routes.push({
                name: `${name} V3 (${bestFee / 100}%)`,
                amountOut: bestAmount,
                expectedOutput: formatUnits(bestAmount, decimalsOut),
                routePath: `${tokenInSymbol} ➝ [${name} V3] ➝ ${tokenOutSymbol}`,
                router: routerAddr,
                calldata: encodeFunctionData({ 
                    abi: [{"inputs":[{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct ISwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingle","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}], 
                    functionName: 'exactInputSingle', 
                    args: [{ tokenIn: tokenInAddr, tokenOut: tokenOutAddr, fee: bestFee, recipient: userAddress as `0x${string}`, deadline: deadline, amountIn: amountInWei, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n }] 
                })
            });
        }
    }

    await checkV3Router(ROUTERS.UNI_V3_QUOTER, ROUTERS.UNI_V3, "Uniswap");
    await checkV3Router(ROUTERS.PANCAKE_V3_QUOTER, ROUTERS.PANCAKE_V3, "PancakeSwap");

    return routes;
}
