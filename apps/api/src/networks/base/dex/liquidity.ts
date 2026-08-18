import { getAddressSafe } from "../assets/tokenAddress.js";
import { buildAddLiquidityRoutes } from "./addLiquidity.js";
import { buildRemoveLiquidityRoutes } from "./removeLiquidity.js";

export async function getLiquidityRoutes(
  action: "add_liquidity" | "remove_liquidity",
  tIn: string,
  tOut: string | undefined,
  amountStr: string,
  userAddress: string,
  requestedProtocol?: string,
  slippageBps = 100,
  secondaryAmount?: string,
) {
  if (action !== "add_liquidity" && action !== "remove_liquidity") {
    throw new Error(`Desteklenmeyen LP Action: ${action}`);
  }
  if (!tOut)
    throw new Error(
      "🚨 Two tokens must be specified for pool operations (LP). E.g., 'Add 100 USDC and WETH to pool'.",
    );

  const tA_Address = getAddressSafe(tIn === "ETH" ? "WETH" : tIn);
  const tB_Address = getAddressSafe(tOut === "ETH" ? "WETH" : tOut);

  if (!tA_Address || !tB_Address)
    throw new Error(`Invalid token pair: ${tIn}-${tOut}`);

  const isNativeA = tIn.toUpperCase() === "ETH";
  const isNativeB = tOut.toUpperCase() === "ETH";
  const hasNativeETH = isNativeA || isNativeB;

  if (action === "add_liquidity") {
    return buildAddLiquidityRoutes(
      tA_Address,
      tB_Address,
      amountStr,
      userAddress,
      requestedProtocol,
      tIn,
      tOut,
      hasNativeETH,
      isNativeA,
      isNativeB,
      slippageBps,
      secondaryAmount,
    );
  } else {
    return buildRemoveLiquidityRoutes(
      tA_Address,
      tB_Address,
      amountStr,
      userAddress,
      requestedProtocol,
      tIn,
      tOut,
      hasNativeETH,
      isNativeA,
      slippageBps,
    );
  }
}
