import { encodeFunctionData, formatUnits } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS, ROUTERS, UNI_V2_ROUTER_ABI } from '../config/constants.js';

export async function getUniswapAndV2Routes(
    amountInWei: bigint, tokenInAddr: `0x${string}`, tokenOutAddr: `0x${string}`, 
    tokenInSymbol: string, tokenOutSymbol: string, isNativeIn: boolean, 
    userAddress: string, deadline: bigint, decimalsOut: number
) {
    const isNativeOut = tokenOutSymbol === "ETH"; 
    const rawRoutes: any[] = [];

    const bases = [TOKENS["WETH"], TOKENS["USDC"], TOKENS["AERO"]];
    const pathsToTry: `0x${string}`[][] = [ [tokenInAddr, tokenOutAddr] ];

    for (const base of bases) {
        if (base !== tokenInAddr && base !== tokenOutAddr) pathsToTry.push([tokenInAddr, base, tokenOutAddr]);
    }

    const checkRouter = async (routerAddr: `0x${string}`, protocolName: string) => {
        for (const path of pathsToTry) {
            try {
                const amounts = await publicClient.readContract({
                    address: routerAddr, abi: UNI_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountInWei, path]
                }) as bigint[];
                
                const amountOut = amounts[amounts.length - 1];
                
                if (amountOut > 0n) {
                    let calldata: `0x${string}`;
                    const amountOutMin = (amountOut * 99n) / 100n; 

                    // ✨ ŞEFFAF ROTA OLUŞTURUCU (Wrap/Unwrap adımlarını koda döker)
                    let pathNames = path.map(addr => Object.keys(TOKENS).find(k => TOKENS[k].toLowerCase() === addr.toLowerCase()) || "???");
                    let routePathStr = pathNames.join(" ➝ ");

                    if (isNativeOut) {
                        if (pathNames[pathNames.length - 1] === "WETH") routePathStr = routePathStr.replace(/WETH$/, "WETH ➝ [Unwrap] ➝ ETH");
                        else routePathStr += " ➝ [Unwrap] ➝ ETH";
                        calldata = encodeFunctionData({ abi: UNI_V2_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [amountInWei, amountOutMin, path, userAddress as `0x${string}`, deadline] });
                    } else if (isNativeIn) {
                        if (pathNames[0] === "WETH") routePathStr = routePathStr.replace(/^WETH/, "ETH ➝ [Wrap] ➝ WETH");
                        else routePathStr = "ETH ➝ [Wrap] ➝ " + routePathStr;
                        calldata = encodeFunctionData({ abi: UNI_V2_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [amountOutMin, path, userAddress as `0x${string}`, deadline] });
                    } else {
                        calldata = encodeFunctionData({ abi: UNI_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountInWei, amountOutMin, path, userAddress as `0x${string}`, deadline] });
                    }

                    const routeType = path.length > 2 ? 'Multi-Hop' : 'Direct';
                    
                    rawRoutes.push({
                        name: `${protocolName} (${routeType})`,
                        amountOut: amountOut,
                        expectedOutput: `Get ~${parseFloat(formatUnits(amountOut, decimalsOut)).toFixed(6)} ${isNativeOut ? "ETH" : tokenOutSymbol}`,
                        routePath: routePathStr,
                        router: routerAddr,
                        calldata: calldata
                    });
                }
            } catch (e) {}
        }
    };

    await checkRouter(ROUTERS.UNI_V2, "Uniswap V2");
    await checkRouter(ROUTERS.ALIEN_BASE, "Alien Base");

    return rawRoutes;
}