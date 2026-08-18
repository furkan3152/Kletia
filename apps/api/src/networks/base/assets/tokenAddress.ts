import { getAddress } from "viem";

import { TOKENS } from "../contracts.js";

export function getAddressSafe(
  tokenSymbol: string | undefined,
): `0x${string}` | undefined {
  if (!tokenSymbol) return undefined;
  const clean = tokenSymbol.trim();
  if (clean.startsWith("0x") || clean.startsWith("0X")) {
    try {
      return getAddress(clean.toLowerCase()) as `0x${string}`;
    } catch {
      return undefined;
    }
  }
  return TOKENS[clean.toUpperCase()] as `0x${string}`;
}
