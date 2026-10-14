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

/* ------------------------------------------------- keccak-256 and EIP-55 */

const UTF8 = new TextEncoder();
const MASK64 = (1n << 64n) - 1n;
const KECCAK_ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets r[x][y], indexed x + 5y. */
const KECCAK_ROTATIONS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (64n - bits))) & MASK64;
}

function keccakPermute(state: bigint[]): void {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n];
  const b: bigint[] = new Array<bigint>(25).fill(0n);
  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] = (state[x] as bigint) ^ (state[x + 5] as bigint) ^ (state[x + 10] as bigint) ^ (state[x + 15] as bigint) ^ (state[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x += 1) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl64(c[(x + 1) % 5] as bigint, 1);
      for (let y = 0; y < 25; y += 5) state[y + x] = (state[y + x] as bigint) ^ d;
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y] as bigint, KECCAK_ROTATIONS[x + 5 * y] as number);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        state[y + x] = (b[y + x] as bigint) ^ (~(b[y + ((x + 1) % 5)] as bigint) & MASK64 & (b[y + ((x + 2) % 5)] as bigint));
      }
    }
    state[0] = (state[0] as bigint) ^ (KECCAK_ROUND_CONSTANTS[round] as bigint);
  }
}


/** Keccak-256 (Ethereum's hash, not SHA3-256) of bytes or a UTF-8 string, as 0x hex. */
export function keccak256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? UTF8.encode(input) : input;
  const rate = 136;
  const length = (Math.floor(bytes.length / rate) + 1) * rate;
  const message = new Uint8Array(length);
  message.set(bytes);
  message[bytes.length] = (message[bytes.length] as number) ^ 0x01;
  message[length - 1] = (message[length - 1] as number) ^ 0x80;
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(message[offset + lane * 8 + byte] as number);
      state[lane] = (state[lane] as bigint) ^ value;
    }
    keccakPermute(state);
  }
  let out = "0x";
  for (let lane = 0; lane < 4; lane += 1) {
    let value = state[lane] as bigint;
    for (let byte = 0; byte < 8; byte += 1) {
      out += Number(value & 0xffn).toString(16).padStart(2, "0");
      value >>= 8n;
    }
  }
  return out;
}

/** EIP-55 checksum form of a 0x address. Throws on a malformed address. */
export function toChecksumAddress(address: string): string {
  if (!isEvmAddress(address)) throw new Error(`Invalid EVM address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(lower).slice(2);
  let out = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index] as string;
    out += Number.parseInt(hash[index] as string, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/** False only for a mixed-case address whose EIP-55 checksum is wrong (a typo). */
export function isChecksumAddressValid(address: string): boolean {
  if (!isEvmAddress(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/**
 * EIP-55 state of an EVM address (core's own keccak, no dependency):
 * `valid` when its mixed case matches the checksum, `uncased` when it is
 * all lower- or upper-case (no checksum to check) and `invalid` for a
 * malformed address or a mixed case that does not match, which usually
 * means one mistyped character.
 */
export function evmChecksumState(address: string): "valid" | "uncased" | "invalid" {
  if (!isEvmAddress(address)) return "invalid";
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return "uncased";
  return toChecksumAddress(address) === address ? "valid" : "invalid";
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
