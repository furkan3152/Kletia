import { encodeFunctionData, parseUnits, type Hex } from "viem";
import { ARC_SWAP_ABI } from "./abis.js";

export class ArcSwapBoundsError extends Error {
  constructor(readonly code: "ARC_INVALID_SLIPPAGE" | "ARC_SWAP_MINIMUM_UNAVAILABLE", message: string) {
    super(message);
    this.name = "ArcSwapBoundsError";
  }
}

/** Compiles the user floor and a five-minute expiry into the reviewed Swap V2 call. */
export function boundedArcSwapCall(input: {
  readonly amount: bigint;
  readonly output: bigint;
  readonly usdcToKlet: boolean;
  readonly slippage?: string;
  readonly userMinimum?: bigint;
  readonly now?: number;
}): { readonly calldata: Hex; readonly minimum: bigint; readonly deadline: bigint } {
  const slippage = String(input.slippage ?? "1").trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(slippage)) throw new ArcSwapBoundsError("ARC_INVALID_SLIPPAGE", "Arc swap slippage must be a decimal percentage with at most two decimal places.");
  const slippageBps = parseUnits(slippage, 2);
  if (slippageBps > 5_000n) throw new ArcSwapBoundsError("ARC_INVALID_SLIPPAGE", "Arc swap slippage cannot exceed 50%.");
  const quotedMinimum = input.output * (10_000n - slippageBps) / 10_000n;
  const userMinimum = input.userMinimum ?? 0n;
  const minimum = userMinimum > quotedMinimum ? userMinimum : quotedMinimum;
  if (input.amount <= 0n || userMinimum < 0n || minimum <= 0n || minimum > input.output) {
    throw new ArcSwapBoundsError("ARC_SWAP_MINIMUM_UNAVAILABLE", "The Arc swap quote cannot satisfy a positive user minimum; no transaction was prepared.");
  }
  const deadline = BigInt(Math.floor((input.now ?? Date.now()) / 1000) + 300);
  const calldata = input.usdcToKlet
    ? encodeFunctionData({ abi: ARC_SWAP_ABI, functionName: "swapUSDCForToken", args: [minimum, deadline] })
    : encodeFunctionData({ abi: ARC_SWAP_ABI, functionName: "swapTokenForUSDC", args: [input.amount, minimum, deadline] });
  return { calldata, minimum, deadline };
}
