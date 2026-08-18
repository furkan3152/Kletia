import { encodeFunctionData, formatUnits } from "viem";
import { basePublicClient } from "../../../shared/config/client.js";
import { TOKENS, ROUTERS, UNI_V2_ROUTER_ABI } from "../contracts.js";

export interface StandardAmmProtocolDiagnostics {
  readonly protocolId: string;
  readonly protocolName: string;
  readonly router: `0x${string}`;
  readonly status: "quoted" | "empty" | "unavailable";
  readonly attemptedQuoteCount: number;
  readonly successfulQuoteReadCount: number;
  readonly failedQuoteReadCount: number;
  readonly quotedRouteCount: number;
  readonly selectedRouteCount: number;
}

export async function getUniswapAndV2Routes(
  amountInWei: bigint,
  tokenInAddr: `0x${string}`,
  tokenOutAddr: `0x${string}`,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  isNativeIn: boolean,
  userAddress: string,
  deadline: bigint,
  decimalsOut: number,
  slippageBps: number = 100,
) {
  const isNativeOut = tokenOutSymbol === "ETH";
  const rawRoutes: any[] = [];
  const protocolDiagnostics: StandardAmmProtocolDiagnostics[] = [];
  let successfulQuoteReads = 0;

  const bases = [
    TOKENS["WETH"],
    TOKENS["USDC"],
    TOKENS["USDBC"],
    TOKENS["AERO"],
    TOKENS["DAI"],
    TOKENS["CBBTC"],
    TOKENS["EURC"],
  ];
  const pathsToTry: `0x${string}`[][] = [[tokenInAddr, tokenOutAddr]];

  for (const base of new Set(bases)) {
    if (base !== tokenInAddr && base !== tokenOutAddr)
      pathsToTry.push([tokenInAddr, base, tokenOutAddr]);
  }

  const checkRouter = async (
    routerAddr: `0x${string}`,
    protocolName: string,
    protocolId: string,
  ) => {
    const routerRoutes: any[] = [];
    let routerSuccessfulQuoteReads = 0;
    let routerFailedQuoteReads = 0;
    let nextPath = 0;
    const workers = Array.from(
      { length: Math.min(4, pathsToTry.length) },
      async () => {
        while (nextPath < pathsToTry.length) {
          const path = pathsToTry[nextPath++];
          try {
            const amounts = (await basePublicClient.readContract({
              address: routerAddr,
              abi: UNI_V2_ROUTER_ABI,
              functionName: "getAmountsOut",
              args: [amountInWei, path],
            })) as bigint[];
            successfulQuoteReads += 1;
            routerSuccessfulQuoteReads += 1;

            const amountOut = amounts[amounts.length - 1];

            if (amountOut > 0n) {
              let calldata: `0x${string}`;
              const amountOutMin =
                (amountOut * BigInt(10000 - slippageBps)) / 10000n;

              let pathNames = path.map(
                (addr) =>
                  Object.keys(TOKENS).find(
                    (key) =>
                      key !== "ETH" &&
                      TOKENS[key].toLowerCase() === addr.toLowerCase(),
                  ) || "???",
              );
              let routePathStr = pathNames.join(" ➝ ");

              if (isNativeOut) {
                if (pathNames[pathNames.length - 1] === "WETH")
                  routePathStr = routePathStr.replace(
                    /WETH$/,
                    "WETH ➝ [Unwrap] ➝ ETH",
                  );
                else routePathStr += " ➝ [Unwrap] ➝ ETH";
                calldata = encodeFunctionData({
                  abi: UNI_V2_ROUTER_ABI,
                  functionName: "swapExactTokensForETH",
                  args: [
                    amountInWei,
                    amountOutMin,
                    path,
                    userAddress as `0x${string}`,
                    deadline,
                  ],
                });
              } else if (isNativeIn) {
                if (pathNames[0] === "WETH")
                  routePathStr = routePathStr.replace(
                    /^WETH/,
                    "ETH ➝ [Wrap] ➝ WETH",
                  );
                else routePathStr = "ETH ➝ [Wrap] ➝ " + routePathStr;
                calldata = encodeFunctionData({
                  abi: UNI_V2_ROUTER_ABI,
                  functionName: "swapExactETHForTokens",
                  args: [
                    amountOutMin,
                    path,
                    userAddress as `0x${string}`,
                    deadline,
                  ],
                });
              } else {
                calldata = encodeFunctionData({
                  abi: UNI_V2_ROUTER_ABI,
                  functionName: "swapExactTokensForTokens",
                  args: [
                    amountInWei,
                    amountOutMin,
                    path,
                    userAddress as `0x${string}`,
                    deadline,
                  ],
                });
              }

              const routeType = path.length > 2 ? "Multi-Hop" : "Direct";

              routerRoutes.push({
                name: `${protocolName} (${routeType})`,
                protocolId,
                amountOut: amountOut,
                expectedOutput: `Get ~${formatUnits(amountOut, decimalsOut)} ${isNativeOut ? "ETH" : tokenOutSymbol}`,
                routePath: routePathStr,

                path: [...path],
                router: routerAddr,
                calldata: calldata,
                hopCount: path.length - 1,
                quoteObservedAt: new Date().toISOString(),
                callerSemantics: "explicit_recipient",
                feeRouterCompatible: true,
              });
            }
          } catch {
            routerFailedQuoteReads += 1;
          }
        }
      },
    );
    await Promise.all(workers);
    routerRoutes.sort((left, right) =>
      left.amountOut === right.amountOut
        ? left.routePath.localeCompare(right.routePath)
        : left.amountOut > right.amountOut
          ? -1
          : 1,
    );
    const selectedRoutes = routerRoutes.slice(0, 2);
    rawRoutes.push(...selectedRoutes);
    protocolDiagnostics.push({
      protocolId,
      protocolName,
      router: routerAddr,
      status:
        routerRoutes.length > 0
          ? "quoted"
          : routerSuccessfulQuoteReads > 0
            ? "empty"
            : "unavailable",
      attemptedQuoteCount: pathsToTry.length,
      successfulQuoteReadCount: routerSuccessfulQuoteReads,
      failedQuoteReadCount: routerFailedQuoteReads,
      quotedRouteCount: routerRoutes.length,
      selectedRouteCount: selectedRoutes.length,
    });
  };

  await Promise.all([
    checkRouter(ROUTERS.UNI_V2, "Uniswap V2", "uniswap"),
    checkRouter(ROUTERS.ALIEN_BASE, "Alien Base", "alienbase"),
    checkRouter(ROUTERS.PANCAKE_V2, "PancakeSwap", "pancakeswap"),
    checkRouter(ROUTERS.SUSHI_V2, "SushiSwap", "sushiswap"),
    checkRouter(ROUTERS.BASESWAP, "BaseSwap", "baseswap"),
    checkRouter(ROUTERS.SWAPBASED, "SwapBased", "swapbased"),
  ]);

  if (successfulQuoteReads === 0) {
    throw Object.assign(
      new Error("Standard AMM quote adapter could not reach any live router."),
      { code: "STANDARD_AMM_QUOTE_SOURCE_UNAVAILABLE" },
    );
  }

  return Object.assign(rawRoutes, {
    quoteDiagnostics: {
      attemptedQuoteCount: pathsToTry.length * 6,
      successfulQuoteReadCount: successfulQuoteReads,
      protocols: protocolDiagnostics.sort((left, right) =>
        left.protocolId.localeCompare(right.protocolId),
      ),
    },
  });
}
