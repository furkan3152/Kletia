import { namehash, normalize } from "viem/ens";
import { publicClient } from "../config/client.js";
import { TOKENS, ROUTERS } from "../networks/base/contracts.js";
import { getAddress, zeroAddress, type Address } from "viem";

export const getAddressSafe = (
  tokenSymbol: string | undefined,
): `0x${string}` | undefined => {
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
};

export interface BasenameResolutionEvidence {
  readonly name: string;
  readonly address: Address;
  readonly resolver: Address;
  readonly observedAtBlock: string;
  readonly observedAt: string;
  readonly expiresAt: number;
}

export async function resolveBasenameEvidence(
  name: string,
): Promise<BasenameResolutionEvidence | null> {
  if (!name) return null;

  let normalizedName = name.trim().toLowerCase();
  if (normalizedName.endsWith(".base")) normalizedName += ".eth";
  if (!normalizedName.endsWith(".base.eth")) return null;

  try {
    normalizedName = normalize(normalizedName);
    const node = namehash(normalizedName);
    const L2Resolver = ROUTERS.BNS_RESOLVER;
    const observedAtBlock = await publicClient.getBlockNumber();
    const addr = await publicClient.readContract({
      address: L2Resolver,
      abi: [
        {
          inputs: [{ internalType: "bytes32", name: "node", type: "bytes32" }],
          name: "addr",
          outputs: [
            { internalType: "address payable", name: "", type: "address" },
          ],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "addr",
      args: [node],
      blockNumber: observedAtBlock,
    });

    if (addr && getAddress(addr) !== zeroAddress) {
      const observedAtMs = Date.now();
      return {
        name: normalizedName,
        address: getAddress(addr),
        resolver: L2Resolver,
        observedAtBlock: observedAtBlock.toString(),
        observedAt: new Date(observedAtMs).toISOString(),

        expiresAt: observedAtMs + 60_000,
      };
    }
  } catch (error: unknown) {
    console.error("BNS resolution failed:", {
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined,
    });
  }
  return null;
}

export async function resolveBasename(name: string): Promise<string | null> {
  return (await resolveBasenameEvidence(name))?.address || null;
}
