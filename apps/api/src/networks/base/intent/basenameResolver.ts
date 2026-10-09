import {
  BaseError,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize } from "viem/ens";
import { venueContracts } from "@kletia/core";

import { basePublicClient } from "../../../shared/config/client.js";
import { NETWORKS, type NetworkId } from "../../../shared/config/networks.js";

/**
 * Basenames are resolved through the Base registry: registry.resolver(node)
 * names the resolver the owner chose (names migrated to the new L2 resolver
 * return 0x0 from the old one), then that resolver's address records are
 * read at the same block. A zero resolver is no resolution. Every read is a
 * raw eth_call, so an offchain (CCIP-Read) resolver can never trigger an HTTP
 * lookup.
 */
export const BASENAMES_REGISTRY: Address = getAddress(
  venueContracts("basenames", "base", "registry")[0] ?? "0xB94704422c2a1E396835A571837Aa5AE53285a95",
);
/** Resolvers Base operates (the L2 resolver and its predecessor); others are user-chosen. */
export const BASENAMES_RESOLVERS: readonly Address[] = venueContracts("basenames", "base", "resolver").map((resolver) => getAddress(resolver));
/** ENSIP-11 coin type of Base (0x80000000 | 8453). */
export const BASE_COIN_TYPE = 0x80000000n | 8453n;
/** ENSIP-1 coin type of an Ethereum address record (`addr(bytes32)`). */
export const ETH_COIN_TYPE = 60n;

/** ENSIP-11 coin type of an EVM chain (0x80000000 | chainId). */
export function evmCoinType(chainId: number): bigint {
  return 0x80000000n | BigInt(chainId);
}

const REGISTRY_ABI = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const RESOLVER_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);

export interface BasenameResolutionEvidence {
  readonly name: string;
  readonly address: Address;
  readonly resolver: Address;
  readonly observedAtBlock: string;
  readonly observedAt: string;
  readonly expiresAt: number;
}

export interface BasenameRecords {
  readonly name: string;
  readonly resolver: Address;
  readonly block: bigint;
  /** Address record per requested coin type (null when unset or unreadable from the resolver). */
  readonly addresses: ReadonlyMap<bigint, Address | null>;
}

/** Lower-cases, completes `.base` to `.base.eth` and ENSIP-15 normalises; null when not a Basename. */
export function normalizeBasename(name: string): string | null {
  let value = name.trim().toLowerCase();
  if (value.endsWith(".base")) value += ".eth";
  if (!value.endsWith(".base.eth") || value.length <= ".base.eth".length) return null;
  try {
    return normalize(value);
  } catch {
    return null;
  }
}

type CallResult = { readonly ok: true; readonly data: Hex } | { readonly ok: false };

/** Raw eth_call at `block`: a revert is `{ ok: false }`; an RPC failure throws. */
async function rawCall(client: PublicClient, to: Address, data: Hex, block: bigint): Promise<CallResult> {
  try {
    const result = await client.request({ method: "eth_call", params: [{ to, data }, toHex(block)] });
    return { ok: true, data: (typeof result === "string" ? result : "0x") as Hex };
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => /revert/iu.test(`${(cause as BaseError).shortMessage ?? ""} ${(cause as BaseError).details ?? ""}`) || (cause as { code?: unknown }).code === 3);
    if (reverted) return { ok: false };
    throw error;
  }
}

function addressRecord(data: Hex, coinType: bigint, node: Hex): Address | null {
  try {
    if (coinType === ETH_COIN_TYPE) {
      const value = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "addr", args: [node], data });
      return value && getAddress(value) !== zeroAddress ? getAddress(value) : null;
    }
    const bytes = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "addr", args: [node, coinType], data });
    // EVM coin types hold a 20-byte address; anything else is not an address for these networks.
    return typeof bytes === "string" && bytes.length === 42 && getAddress(bytes) !== zeroAddress ? getAddress(bytes) : null;
  } catch {
    return null;
  }
}

/**
 * Reads a Basename's resolver from the Base registry and the requested
 * address records from that resolver, all at one block. Returns null when the
 * name has no resolver (zero). Throws when the RPC cannot answer.
 */
export async function readBasenameRecords(
  name: string,
  coinTypes: readonly bigint[],
  client: PublicClient = basePublicClient as PublicClient,
): Promise<BasenameRecords | null> {
  const normalized = normalizeBasename(name);
  if (!normalized) return null;
  const node = namehash(normalized);
  const block = await client.getBlockNumber();
  const registry = await rawCall(client, BASENAMES_REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: "resolver", args: [node] }), block);
  if (!registry.ok) throw new Error("Basenames registry read reverted");
  const resolverValue = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "resolver", data: registry.data });
  if (!resolverValue || getAddress(resolverValue) === zeroAddress) return null;
  const resolver = getAddress(resolverValue);
  const addresses = new Map<bigint, Address | null>();
  for (const coinType of coinTypes) {
    const data = coinType === ETH_COIN_TYPE
      ? encodeFunctionData({ abi: RESOLVER_ABI, functionName: "addr", args: [node] })
      : encodeFunctionData({ abi: RESOLVER_ABI, functionName: "addr", args: [node, coinType] });
    const result = await rawCall(client, resolver, data, block);
    addresses.set(coinType, result.ok ? addressRecord(result.data, coinType, node) : null);
  }
  return { name: normalized, resolver, block, addresses };
}

/**
 * Resolves a Basename for a transfer on `network`: that network's own
 * address record first (ENSIP-11; coin type 8453 on Base), then the Ethereum
 * address record Basenames sets by default. A record set for another network
 * (e.g. a Base-only Safe) never pays a transfer on Arbitrum or Arc.
 */
export async function resolveBasenameEvidence(
  name: string,
  network: NetworkId = "base",
  client: PublicClient = basePublicClient as PublicClient,
): Promise<BasenameResolutionEvidence | null> {
  if (!name) return null;
  try {
    const chainCoinType = evmCoinType(NETWORKS[network].chainId);
    const records = await readBasenameRecords(name, [chainCoinType, ETH_COIN_TYPE], client);
    const address = records ? (records.addresses.get(chainCoinType) ?? records.addresses.get(ETH_COIN_TYPE) ?? null) : null;
    if (records && address) {
      const observedAtMs = Date.now();
      return {
        name: records.name,
        address,
        resolver: records.resolver,
        observedAtBlock: records.block.toString(),
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
