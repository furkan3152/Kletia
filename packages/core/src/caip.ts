/**
 * CAIP-10 account and CAIP-19 asset identities plus per-namespace address
 * validation. Kletia never compares raw address strings across networks;
 * everything crosses a boundary as a namespaced identifier.
 */
import {
  CHAINS,
  resolveChain,
  type CaipChainId,
  type ChainDescriptor,
  type ChainNamespace,
  type NetworkKey,
} from "./chains.js";

export type AccountId = `${CaipChainId}:${string}`;
export type AssetId = `${CaipChainId}/${string}:${string}`;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map<string, number>(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

/** Decode base58 into bytes; returns null for invalid input. */
export function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null;
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] as number) * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[out.length - 1 - index] = bytes[index] as number;
  }
  return out;
}

export function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] as number) << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(leadingZeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    out += BASE58_ALPHABET[digits[index] as number];
  }
  return out;
}

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}

/** A Solana public key is 32 bytes of base58 (32-44 characters). */
export function isSolanaAddress(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  const decoded = decodeBase58(value);
  return decoded !== null && decoded.length === 32;
}

/** A Solana transaction signature is 64 bytes of base58. */
export function isSolanaSignature(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 64 || value.length > 90) return false;
  const decoded = decodeBase58(value);
  return decoded !== null && decoded.length === 64;
}

export function isEvmTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

export function isAddressForNamespace(namespace: ChainNamespace, value: unknown): boolean {
  return namespace === "eip155" ? isEvmAddress(value) : isSolanaAddress(value);
}

/** Detects which namespace an address string belongs to, if any. */
export function detectAddressNamespace(value: unknown): ChainNamespace | null {
  if (isEvmAddress(value)) return "eip155";
  if (isSolanaAddress(value)) return "solana";
  return null;
}

/** Lower-cases EVM addresses for comparisons; Solana keys are case-sensitive. */
export function normalizeAddress(namespace: ChainNamespace, address: string): string {
  return namespace === "eip155" ? address.toLowerCase() : address;
}

export function formatAccountId(chain: NetworkKey | ChainDescriptor, address: string): AccountId {
  const descriptor = typeof chain === "string" ? CHAINS[chain] : chain;
  if (!isAddressForNamespace(descriptor.namespace, address)) {
    throw new Error(`Invalid ${descriptor.namespace} address for ${descriptor.name}.`);
  }
  return `${descriptor.id}:${address}` as AccountId;
}

export interface ParsedAccountId {
  readonly chain: ChainDescriptor;
  readonly address: string;
  readonly id: AccountId;
}

export function parseAccountId(value: unknown): ParsedAccountId | null {
  if (typeof value !== "string") return null;
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const chain = resolveChain(value.slice(0, lastColon));
  const address = value.slice(lastColon + 1);
  if (!chain || !isAddressForNamespace(chain.namespace, address)) return null;
  return { chain, address, id: `${chain.id}:${address}` as AccountId };
}

export function sameAccount(a: string, b: string): boolean {
  const left = parseAccountId(a);
  const right = parseAccountId(b);
  if (!left || !right || left.chain.id !== right.chain.id) return false;
  return (
    normalizeAddress(left.chain.namespace, left.address) ===
    normalizeAddress(right.chain.namespace, right.address)
  );
}

/**
 * True when two CAIP-10 accounts are the same address in the same namespace,
 * on any chain of it: an EVM address on every eip155 network, a Solana address
 * on every cluster. This is how the planner re-homes a user's account onto
 * another network of the same VM (e.g. the default recipient of a bridge).
 * A smart-contract account need not exist at that address on every chain.
 */
export function sameAddressAccount(a: string, b: string): boolean {
  const left = parseAccountId(a);
  const right = parseAccountId(b);
  if (!left || !right || left.chain.namespace !== right.chain.namespace) return false;
  return (
    normalizeAddress(left.chain.namespace, left.address) ===
    normalizeAddress(right.chain.namespace, right.address)
  );
}

/** Asset namespaces: `slip44` for natives, `erc20` on EVM, `token` for SPL mints. */
export type AssetNamespace = "slip44" | "erc20" | "token";

export interface ParsedAssetId {
  readonly chain: ChainDescriptor;
  readonly assetNamespace: AssetNamespace;
  readonly reference: string;
  readonly id: AssetId;
  readonly isNative: boolean;
}

export function formatAssetId(
  chain: NetworkKey | ChainDescriptor,
  assetNamespace: AssetNamespace,
  reference: string,
): AssetId {
  const descriptor = typeof chain === "string" ? CHAINS[chain] : chain;
  return `${descriptor.id}/${assetNamespace}:${reference}` as AssetId;
}

export function nativeAssetId(chain: NetworkKey | ChainDescriptor): AssetId {
  const descriptor = typeof chain === "string" ? CHAINS[chain] : chain;
  return formatAssetId(descriptor, "slip44", descriptor.vm === "svm" ? "501" : "60");
}

export function parseAssetId(value: unknown): ParsedAssetId | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const chain = resolveChain(value.slice(0, slash));
  if (!chain) return null;
  const rest = value.slice(slash + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const assetNamespace = rest.slice(0, colon) as AssetNamespace;
  const reference = rest.slice(colon + 1);
  if (assetNamespace === "slip44") {
    if (!/^\d+$/u.test(reference)) return null;
  } else if (assetNamespace === "erc20") {
    if (chain.namespace !== "eip155" || !isEvmAddress(reference)) return null;
  } else if (assetNamespace === "token") {
    if (chain.namespace !== "solana" || !isSolanaAddress(reference)) return null;
  } else {
    return null;
  }
  return {
    chain,
    assetNamespace,
    reference,
    id: `${chain.id}/${assetNamespace}:${reference}` as AssetId,
    isNative: assetNamespace === "slip44",
  };
}
