import { encodeFunctionData, formatUnits } from "viem";
import { publicClient } from "../../../config/client.js";
import {
  ROUTERS,
  AERO_ETH_ABI,
  AERODROME_ROUTER_ABI,
  SLIPSTREAM_QUOTER_ABI,
  SLIPSTREAM_ROUTER_ABI,
} from "../contracts.js";

export async function getAerodromeRoutes(
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
  if (tokenOutSymbol.toUpperCase() === "ETH") {
    throw Object.assign(
      new Error(
        "Aerodrome native-output route is disabled until unwrap calldata is policy-validated.",
      ),
      { code: "AERODROME_NATIVE_OUTPUT_UNAVAILABLE" },
    );
  }
  const routes: any[] = [];
  let successfulQuoteReads = 0;

  const v1Results = await Promise.allSettled(
    [false, true].map(async (stable) => {
      const amounts = await publicClient.readContract({
        address: ROUTERS.AERO_V1,
        abi: AERODROME_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [
          amountInWei,
          [
            {
              from: tokenInAddr,
              to: tokenOutAddr,
              stable,
              factory: ROUTERS.AERO_FACTORY,
            },
          ],
        ],
      });
      const amountOut = amounts.at(-1);
      if (typeof amountOut !== "bigint") {
        throw new Error("Invalid Aerodrome V1 quote response.");
      }
      return { amountOut, stable };
    }),
  );
  const v1Quotes = v1Results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  successfulQuoteReads += v1Quotes.length;
  const bestV1 = v1Quotes.reduce(
    (best, quote) => (quote.amountOut > best.amountOut ? quote : best),
    { amountOut: 0n, stable: false },
  );
  const v1Amount = bestV1.amountOut;
  const v1Stable = bestV1.stable;

  if (v1Amount > 0n) {
    const v1AmountOutMin = (v1Amount * BigInt(10000 - slippageBps)) / 10000n;

    routes.push({
      name: "Aerodrome V1",
      protocolId: "aerodrome",
      amountOut: v1Amount,
      expectedOutput: formatUnits(v1Amount, decimalsOut),
      routePath: `${tokenInSymbol} ➝ [Aerodrome V1] ➝ ${tokenOutSymbol}`,
      router: ROUTERS.AERO_V1,
      calldata: isNativeIn
        ? encodeFunctionData({
            abi: AERO_ETH_ABI,
            functionName: "swapExactETHForTokens",
            args: [
              v1AmountOutMin,
              [
                {
                  from: tokenInAddr,
                  to: tokenOutAddr,
                  stable: v1Stable,
                  factory: ROUTERS.AERO_FACTORY,
                },
              ],
              userAddress as `0x${string}`,
              deadline,
            ],
          })
        : encodeFunctionData({
            abi: AERODROME_ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [
              amountInWei,
              v1AmountOutMin,
              [
                {
                  from: tokenInAddr,
                  to: tokenOutAddr,
                  stable: v1Stable,
                  factory: ROUTERS.AERO_FACTORY,
                },
              ],
              userAddress as `0x${string}`,
              deadline,
            ],
          }),
      hopCount: 1,
      quoteObservedAt: new Date().toISOString(),
      callerSemantics: "explicit_recipient",
      feeRouterCompatible: true,
    });
  }

  const slipResults = await Promise.allSettled(
    [1, 50, 100, 200, 500, 2000].map(async (tickSpacing) => {
      const quote = await publicClient.readContract({
        address: ROUTERS.AERO_SLIPSTREAM_QUOTER,
        abi: SLIPSTREAM_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            amountIn: amountInWei,
            tickSpacing,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const amountOut = Array.isArray(quote)
        ? (quote[0] as bigint)
        : (quote as { amountOut: bigint }).amountOut;
      if (typeof amountOut !== "bigint") {
        throw new Error("Invalid Aerodrome Slipstream quote response.");
      }
      return { amountOut, tickSpacing };
    }),
  );
  const slipQuotes = slipResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  successfulQuoteReads += slipQuotes.length;
  const bestSlipstream = slipQuotes.reduce(
    (best, quote) => (quote.amountOut > best.amountOut ? quote : best),
    { amountOut: 0n, tickSpacing: 1 },
  );
  const slipAmount = bestSlipstream.amountOut;
  const slipTick = bestSlipstream.tickSpacing;

  if (slipAmount > 0n) {
    const slipAmountOutMin =
      (slipAmount * BigInt(10000 - slippageBps)) / 10000n;

    routes.push({
      name: "Aerodrome Slipstream",
      protocolId: "aerodrome",
      amountOut: slipAmount,
      expectedOutput: formatUnits(slipAmount, decimalsOut),
      routePath: `${tokenInSymbol} ➝ [Aero Slipstream] ➝ ${tokenOutSymbol}`,
      router: ROUTERS.AERO_SLIPSTREAM,
      calldata: encodeFunctionData({
        abi: SLIPSTREAM_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            tickSpacing: slipTick,
            recipient: userAddress as `0x${string}`,
            deadline: deadline,
            amountIn: amountInWei,
            amountOutMinimum: slipAmountOutMin,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
      hopCount: 1,
      quoteObservedAt: new Date().toISOString(),
      callerSemantics: "explicit_recipient",
      feeRouterCompatible: true,
    });
  }

  if (successfulQuoteReads === 0) {
    throw Object.assign(
      new Error(
        "Aerodrome quote adapter could not reach any live quote surface.",
      ),
      { code: "AERODROME_QUOTE_SOURCE_UNAVAILABLE" },
    );
  }

  return Object.assign(routes, {
    quoteDiagnostics: {
      attemptedQuoteCount: 8,
      successfulQuoteReadCount: successfulQuoteReads,
    },
  });
}
