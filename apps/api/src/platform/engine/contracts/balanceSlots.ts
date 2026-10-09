/**
 * ERC-20 balance-slot discovery for plan-time simulation overrides.
 *
 * At plan time the user may not hold the input yet (it arrives from a bridge
 * step), so the simulation overrides the input token balance to the step
 * amount. The storage slot of `balanceOf(user)` is found once per token:
 * candidate mapping slots 0..20 in Solidity order `keccak(pad(user) ‖
 * pad(slot))` and Vyper order `keccak(pad(slot) ‖ pad(user))`, each tried in
 * its own simulated block with a distinct marker value; the first block whose
 * `balanceOf(user)` returns its own marker names the slot. (Live: USDC uses
 * slot 9 on all five EVM mainnets.) Prepare never overrides anything.
 */
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, pad, toHex, type Hex } from "viem";
import type { EvmNetworkKey } from "../chains/evm.js";
import { jsonRpc, simulationEndpoints } from "./simulationRpc.js";
import { parseSimulatedBlock, readUint, type StateOverrides } from "./simulateEvm.js";

export const MAX_CANDIDATE_SLOT = 20;

export interface BalanceSlot {
  readonly slot: number;
  readonly layout: "solidity" | "vyper";
}

const cache = new Map<string, { readonly value: BalanceSlot | null; readonly at: number }>();
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;

/** Storage key of `owner`'s balance for a mapping at `slot`. */
export function balanceStorageKey(owner: string, slot: BalanceSlot): Hex {
  const holder = getAddress(owner);
  const index = BigInt(slot.slot);
  return slot.layout === "solidity"
    ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, index]))
    : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [index, holder]));
}

function candidates(): BalanceSlot[] {
  const list: BalanceSlot[] = [];
  for (let slot = 0; slot <= MAX_CANDIDATE_SLOT; slot += 1) list.push({ slot, layout: "solidity" });
  for (let slot = 0; slot <= MAX_CANDIDATE_SLOT; slot += 1) list.push({ slot, layout: "vyper" });
  return list;
}

/** Marker written by candidate `index`: distinctive and never a plausible real balance. */
function marker(index: number): bigint {
  return (0x5eedn << 200n) + BigInt(index + 1);
}

/**
 * Finds the balance slot of `token` (cached per network and token). Null when
 * no candidate works or no endpoint can simulate.
 */
export async function discoverBalanceSlot(network: EvmNetworkKey, token: string, holder: string): Promise<BalanceSlot | null> {
  const key = `${network}:${token.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.value ? FOUND_TTL_MS : MISSING_TTL_MS)) return cached.value;
  const list = candidates();
  const address = getAddress(token);
  const read = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(holder)] });
  const blocks = list.map((slot, index) => ({
    stateOverrides: { [address]: { stateDiff: { [balanceStorageKey(holder, slot)]: pad(toHex(marker(index))) } } },
    calls: [{ from: getAddress(holder), to: address, data: read }],
  }));
  for (const url of await simulationEndpoints(network)) {
    try {
      const outcome = await jsonRpc(url, "eth_simulateV1", [{ blockStateCalls: blocks, validation: false }, "latest"]);
      if (!outcome.ok || !Array.isArray(outcome.result) || outcome.result.length !== blocks.length) continue;
      let found: BalanceSlot | null = null;
      for (let index = 0; index < blocks.length; index += 1) {
        const parsed = parseSimulatedBlock([outcome.result[index]], 1);
        if (readUint(parsed?.calls[0]) === marker(index)) {
          found = list[index] as BalanceSlot;
          break;
        }
      }
      cache.set(key, { value: found, at: Date.now() });
      return found;
    } catch {
      // Try the next endpoint.
    }
  }
  return null;
}

/** State override setting `owner`'s balance of `token` to `amount`, or null when the slot is unknown. */
export async function balanceOverride(network: EvmNetworkKey, token: string, owner: string, amount: bigint): Promise<StateOverrides | null> {
  const slot = await discoverBalanceSlot(network, token, owner);
  if (!slot) return null;
  return { [getAddress(token)]: { stateDiff: { [balanceStorageKey(owner, slot)]: pad(toHex(amount)) } } };
}

/** Clears discovered slots (tests). */
export function resetBalanceSlots(): void {
  cache.clear();
}
