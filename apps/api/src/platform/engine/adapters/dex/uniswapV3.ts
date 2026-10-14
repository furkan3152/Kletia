/**
 * Uniswap V3 exact-in swaps on the five EVM production networks: pools
 * proven by the pinned factory, quotes from the pinned QuoterV2 across the
 * four fee tiers (two hops through the wrapped native token or USDC when
 * no direct pool quotes), calls only to the pinned SwapRouter02 with an
 * on-chain minimum output, the Chainlink band and the Swap / output proof
 * of concentrated.ts.
 */
import type { ProtocolAdapter } from "../types.js";
import { createConcentratedAdapter } from "./concentrated.js";

export const uniswapV3Adapter: ProtocolAdapter | null = createConcentratedAdapter({ id: "uniswap-v3", label: "Uniswap V3" });
