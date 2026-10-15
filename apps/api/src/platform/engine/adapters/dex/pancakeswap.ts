/**
 * PancakeSwap V3 exact-in swaps on Ethereum, Base and Arbitrum One.
 * PancakeSwap V3 speaks the Uniswap V3 dialect: pools proven by
 * the pinned factory (`getPool` + the pool's `factory()`), quotes from the
 * pinned QuoterV2 across its four fee tiers (0.01 / 0.05 / 0.25 / 1 %), calls
 * only to the pinned SmartRouter (SwapRouter02 selectors) with an on-chain
 * minimum output. The router and quoter must also report the pinned pool
 * deployer (`deployer()`), and the proof reads PancakeSwap's own Swap event
 * (protocol fees appended). It competes in the same-network auction with
 * Uniswap V3 and Aerodrome on the same routes.
 */
import type { ProtocolAdapter } from "../types.js";
import { createConcentratedAdapter } from "./concentrated.js";

export const pancakeswapV3Adapter: ProtocolAdapter | null = createConcentratedAdapter({ id: "pancakeswap-v3", label: "PancakeSwap V3" });
