/**
 * ERC-20 balance-slot discovery for plan-time simulation overrides.
 *
 * At plan time the user may not hold the input yet (it arrives from a bridge
 * step), so the simulation overrides the input token balance to the step
 * amount. Where `balanceOf(user)` reads from is found once per token (and
 * proven with a distinct marker value read back through `balanceOf`), in two
 * bounded rounds:
 *
 * 1. One `eth_simulateV1` request, one block per candidate: Solidity and
 *    Vyper mappings at slots 0..20, the OpenZeppelin upgradeable layouts
 *    (`__gap`s put `_balances` at 51, 101, 151 or 201: live, Arbitrum WETH and
 *    ARB use 51), the ERC-7201 namespace of OpenZeppelin v5
 *    `ERC20Upgradeable`, and a native-balance view (Arc's USDC ERC-20 at
 *    `0x3600…0000` reads the account's 18-decimal native balance, 6 decimals).
 * 2. When none matches: `eth_createAccessList` of `balanceOf(user)` names
 *    every storage key the call reads (on any contract, proxies included);
 *    each is tried with its own marker in one more `eth_simulateV1` request.
 *    A key that is a plain mapping entry is generalised to that mapping;
 *    any other layout (packed or hashed keys, external balance stores) is
 *    kept for that holder only.
 *
 * A token whose `balanceOf` does not return the stored word as is (shares
 * times an index, rebasing) never matches: no override, the call is not
 * simulated before the account holds the amount. Prepare never overrides
 * anything.
 */
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, pad, toBytes, toHex, type Hex } from "viem";
import type { EvmNetworkKey } from "../chains/evm.js";
import { jsonRpc, simulationEndpoints } from "./simulationRpc.js";
import { parseSimulatedBlock, readUint, type StateOverrides } from "./simulateEvm.js";

/** Highest plain mapping slot of the first round (both layouts). */
export const MAX_CANDIDATE_SLOT = 20;
/** `_balances` slots of OpenZeppelin upgradeable contracts (`__gap[50]` after Initializable and each gapped parent). */
export const OZ_UPGRADEABLE_SLOTS: readonly bigint[] = Object.freeze([51n, 101n, 151n, 201n]);

/** ERC-7201 namespace base: `keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff`. */
export function erc7201Slot(id: string): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(keccak256(toBytes(id))) - 1n]))) & ~0xffn;
}

/** OpenZeppelin v5 `ERC20Upgradeable` storage (`_balances` is its first field): 0x52c6…ce00. */
export const OZ_ERC20_NAMESPACE_SLOT = erc7201Slot("openzeppelin.storage.ERC20");

/** Storage keys of one `balanceOf` the access-list round may try (one simulated block each). */
export const MAX_TRACED_KEYS = 48;
/** Mapping slots a traced key is matched against to generalise it to every holder. */
const GENERALISE_UP_TO_SLOT = 255n;
/** Largest decimal shift between a native-view token and the native balance (18-decimal native, 0-decimal token). */
const MAX_NATIVE_SCALE_EXPONENT = 18;

export type BalanceSlot =
  /** `balanceOf(holder)` is the word at `mapping(slot)[holder]` of the token. */
  | { readonly kind: "mapping"; readonly slot: bigint; readonly layout: "solidity" | "vyper" }
  /** `balanceOf(holder)` is the holder's native balance divided by `scale`. */
  | { readonly kind: "native"; readonly scale: bigint }
  /** `balanceOf(holder)` is the word at `key` of `address` (found by tracing for this holder only). */
  | { readonly kind: "storage"; readonly address: string; readonly key: Hex };

const cache = new Map<string, { readonly value: BalanceSlot | null; readonly at: number }>();
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;

/** Storage key of `owner`'s balance for a mapping at `slot`. */
export function balanceStorageKey(owner: string, slot: { readonly slot: bigint | number; readonly layout: "solidity" | "vyper" }): Hex {
  const holder = getAddress(owner);
  const index = BigInt(slot.slot);
  return slot.layout === "solidity"
    ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, index]))
    : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [index, holder]));
}

type MappingSlot = Extract<BalanceSlot, { kind: "mapping" }>;

/** First-round mapping candidates, in preference order. */
export function mappingCandidates(): MappingSlot[] {
  const list: MappingSlot[] = [];
  for (let slot = 0n; slot <= BigInt(MAX_CANDIDATE_SLOT); slot += 1n) list.push({ kind: "mapping", slot, layout: "solidity" });
  for (let slot = 0n; slot <= BigInt(MAX_CANDIDATE_SLOT); slot += 1n) list.push({ kind: "mapping", slot, layout: "vyper" });
  for (const slot of OZ_UPGRADEABLE_SLOTS) list.push({ kind: "mapping", slot, layout: "solidity" });
  list.push({ kind: "mapping", slot: OZ_ERC20_NAMESPACE_SLOT, layout: "solidity" });
  return list;
}

/**
 * Marker written by candidate `index`: distinctive, never a plausible real
 * balance, and below 2^96 so tokens that store balances as uint96 (or pack
 * them in 128 bits) read it back intact.
 */
function marker(index: number): bigint {
  return (0x5eedn << 64n) + BigInt(index + 1);
}

/** Native balance written by the native-view block: a multiple of 10^18, so every decimal shift divides it exactly. */
const NATIVE_MARKER = (0x5eedn << 40n) * 10n ** 18n;

/** The decimal scale `s` with `read * s === NATIVE_MARKER`, if any. */
function nativeScale(read: bigint | null): bigint | null {
  if (read === null || read <= 0n) return null;
  for (let exponent = 0; exponent <= MAX_NATIVE_SCALE_EXPONENT; exponent += 1) {
    const scale = 10n ** BigInt(exponent);
    if (read * scale === NATIVE_MARKER) return scale;
  }
  return null;
}

type Probe =
  | { readonly kind: "write"; readonly address: string; readonly key: Hex; readonly found: BalanceSlot }
  | { readonly kind: "native" };

/**
 * Runs one block per probe (each writes its marker, then reads
 * `balanceOf(holder)`) and returns the first probe whose block reads back its
 * own marker: `null` when none does, `undefined` when no endpoint answered.
 * Overrides persist into later blocks, so only a block's own marker counts.
 */
async function runProbes(network: EvmNetworkKey, token: string, holder: string, probes: readonly Probe[]): Promise<BalanceSlot | null | undefined> {
  const target = getAddress(token);
  const account = getAddress(holder);
  const read = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const blocks = probes.map((probe, index) => ({
    stateOverrides: probe.kind === "native"
      ? { [account]: { balance: toHex(NATIVE_MARKER) } }
      : { [getAddress(probe.address)]: { stateDiff: { [probe.key]: pad(toHex(marker(index))) } } },
    calls: [{ from: account, to: target, data: read }],
  }));
  for (const url of await simulationEndpoints(network)) {
    try {
      const outcome = await jsonRpc(url, "eth_simulateV1", [{ blockStateCalls: blocks, validation: false }, "latest"]);
      if (!outcome.ok || !Array.isArray(outcome.result) || outcome.result.length !== blocks.length) continue;
      for (const [index, probe] of probes.entries()) {
        const value = readUint(parseSimulatedBlock([outcome.result[index]], 1)?.calls[0]);
        if (probe.kind === "native") {
          const scale = nativeScale(value);
          if (scale !== null) return { kind: "native", scale };
        } else if (value === marker(index)) {
          return probe.found;
        }
      }
      return null;
    } catch {
      // Try the next endpoint.
    }
  }
  return undefined;
}

/** Storage keys `balanceOf(holder)` reads, per contract (bounded); undefined when no endpoint can trace it. */
async function tracedKeys(network: EvmNetworkKey, token: string, holder: string): Promise<{ readonly address: string; readonly key: Hex }[] | undefined> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(holder)] });
  for (const url of await simulationEndpoints(network)) {
    try {
      // No `from`: some nodes (Arbitrum) refuse an unfunded sender before tracing a call.
      const outcome = await jsonRpc(url, "eth_createAccessList", [{ to: getAddress(token), data }, "latest"]);
      if (!outcome.ok || typeof outcome.result !== "object" || outcome.result === null) continue;
      const list = (outcome.result as { accessList?: unknown }).accessList;
      if (!Array.isArray(list)) continue;
      const keys: { address: string; key: Hex }[] = [];
      for (const entry of list as { address?: unknown; storageKeys?: unknown }[]) {
        if (typeof entry.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(entry.address) || !Array.isArray(entry.storageKeys)) continue;
        for (const key of entry.storageKeys) {
          if (typeof key === "string" && /^0x[0-9a-fA-F]{64}$/u.test(key) && keys.length < MAX_TRACED_KEYS) {
            keys.push({ address: entry.address.toLowerCase(), key: key.toLowerCase() as Hex });
          }
        }
      }
      return keys;
    } catch {
      // Try the next endpoint.
    }
  }
  return undefined;
}

/** The mapping (any layout, slot up to 255) a traced key of the token itself belongs to, if any. */
function generalise(found: Extract<BalanceSlot, { kind: "storage" }>, token: string, holder: string): MappingSlot | null {
  if (found.address !== token.toLowerCase()) return null;
  for (let slot = 0n; slot <= GENERALISE_UP_TO_SLOT; slot += 1n) {
    for (const layout of ["solidity", "vyper"] as const) {
      if (balanceStorageKey(holder, { slot, layout }).toLowerCase() === found.key) return { kind: "mapping", slot, layout };
    }
  }
  return null;
}

function fresh(entry: { readonly value: BalanceSlot | null; readonly at: number } | undefined): entry is { readonly value: BalanceSlot | null; readonly at: number } {
  return entry !== undefined && Date.now() - entry.at < (entry.value ? FOUND_TTL_MS : MISSING_TTL_MS);
}

/**
 * Finds where `token` keeps `holder`'s balance (cached per network and token,
 * or per holder for traced layouts). Null when nothing proves a location or
 * no endpoint can simulate.
 */
export async function discoverBalanceSlot(network: EvmNetworkKey, token: string, holder: string): Promise<BalanceSlot | null> {
  const tokenKey = `${network}:${token.toLowerCase()}`;
  const holderKey = `${tokenKey}:${holder.toLowerCase()}`;
  const perHolder = cache.get(holderKey);
  if (fresh(perHolder)) return perHolder.value;
  const perToken = cache.get(tokenKey);
  if (fresh(perToken) && perToken.value) return perToken.value;

  if (!fresh(perToken)) {
    const probes: Probe[] = [
      ...mappingCandidates().map((found): Probe => ({ kind: "write", address: token, key: balanceStorageKey(holder, found), found })),
      { kind: "native" },
    ];
    const found = await runProbes(network, token, holder, probes);
    if (found === undefined) return null;
    cache.set(tokenKey, { value: found, at: Date.now() });
    if (found) return found;
  }

  const keys = await tracedKeys(network, token, holder);
  if (keys === undefined) return null;
  const traced = keys.length === 0
    ? null
    : await runProbes(network, token, holder, keys.map((entry): Probe => ({ kind: "write", ...entry, found: { kind: "storage", ...entry } })));
  if (traced === undefined) return null;
  const mapping = traced?.kind === "storage" ? generalise(traced, token, holder) : null;
  if (mapping) {
    cache.set(tokenKey, { value: mapping, at: Date.now() });
    return mapping;
  }
  cache.set(holderKey, { value: traced, at: Date.now() });
  return traced;
}

/**
 * State override setting `owner`'s balance of `token` to `amount`, or null
 * when the location is unknown. A native-view token is overridden through
 * the owner's native balance (`amount` × scale).
 */
export async function balanceOverride(network: EvmNetworkKey, token: string, owner: string, amount: bigint): Promise<StateOverrides | null> {
  const slot = await discoverBalanceSlot(network, token, owner);
  if (!slot) return null;
  if (slot.kind === "native") return { [getAddress(owner)]: { balance: amount * slot.scale } };
  if (slot.kind === "storage") return { [getAddress(slot.address)]: { stateDiff: { [slot.key]: pad(toHex(amount)) } } };
  return { [getAddress(token)]: { stateDiff: { [balanceStorageKey(owner, slot)]: pad(toHex(amount)) } } };
}

/** Clears discovered slots (tests). */
export function resetBalanceSlots(): void {
  cache.clear();
}
