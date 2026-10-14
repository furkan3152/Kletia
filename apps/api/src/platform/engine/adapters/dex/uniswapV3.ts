/**
 * Uniswap V3 exact-in swaps on the five EVM production networks (protocols
 * design 3.2): pools proven by the pinned factory, quotes from the pinned
 * QuoterV2, calls only to the pinned SwapRouter02 with an on-chain minimum
 * output. Placeholder: the evm-swaps-and-feeds package replaces `null` with
 * the adapter; the registry skips it until then.
 */
import type { ProtocolAdapter } from "../types.js";

export const uniswapV3Adapter: ProtocolAdapter | null = null;
