import { getAddress, zeroAddress, type Address } from "viem";
import { namehash, normalize } from "viem/ens";

import { basePublicClient } from "../../../shared/config/client.js";
import { ROUTERS } from "../contracts.js";

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
    const resolver = ROUTERS.BNS_RESOLVER;
    const observedAtBlock = await basePublicClient.getBlockNumber();
    const address = await basePublicClient.readContract({
      address: resolver,
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

    if (address && getAddress(address) !== zeroAddress) {
      const observedAtMs = Date.now();
      return {
        name: normalizedName,
        address: getAddress(address),
        resolver,
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
