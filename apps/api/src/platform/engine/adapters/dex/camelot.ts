/**
 * Camelot V3 exact-in swaps on Arbitrum One (protocols design 3.1), the
 * `algebra` dialect of concentrated.ts: one dynamic-fee pool per pair
 * (`poolByPair` on the pinned AlgebraFactory, the pool's `factory()` must
 * match), quotes from the pinned Algebra Quoter, calls only to the pinned
 * SwapRouter (`exactInputSingle` / `exactInput` with 20-byte paths inside
 * `multicall(bytes[])`, `unwrapWNativeToken` / `refundNativeToken` for native
 * legs) with an on-chain minimum output. Router and quoter must report the
 * pinned factory, `WNativeToken()` and `poolDeployer()`.
 */
import type { ProtocolAdapter } from "../types.js";
import { createConcentratedAdapter } from "./concentrated.js";

export const camelotAdapter: ProtocolAdapter | null = createConcentratedAdapter({ id: "camelot", label: "Camelot V3" });
