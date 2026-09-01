import { poseidon2 } from "poseidon-lite";

import { scalarFromMaterialV4 } from "./canonical.js";

const DEPTH = 16;

function rootFor(namespace: "protocol" | "asset" | "recipient", leaves: readonly `0x${string}`[]): `0x${string}` {
  if (leaves.length === 0 || leaves.length > 2 ** DEPTH || new Set(leaves).size !== leaves.length) {
    throw Object.assign(new Error(`The ${namespace} policy registry is empty, duplicated or oversized.`), {
      code: "POLICY_REGISTRY_INVALID",
      statusCode: 409,
    });
  }
  const sorted = [...leaves].map(BigInt).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const defaults: bigint[] = [BigInt(scalarFromMaterialV4("KLETIA_POLICY_EMPTY_LEAF_V2", { namespace }))];
  for (let level = 0; level < DEPTH; level += 1) defaults.push(poseidon2([defaults[level]!, defaults[level]!]));
  let nodes = new Map<number, bigint>(sorted.map((leaf, index) => [index, leaf]));
  for (let level = 0; level < DEPTH; level += 1) {
    const parents = new Set([...nodes.keys()].map((index) => Math.floor(index / 2)));
    const next = new Map<number, bigint>();
    for (const parent of parents) {
      const value = poseidon2([
        nodes.get(parent * 2) ?? defaults[level]!,
        nodes.get(parent * 2 + 1) ?? defaults[level]!,
      ]);
      if (value !== defaults[level + 1]) next.set(parent, value);
    }
    nodes = next;
  }
  const root = nodes.get(0) ?? defaults[DEPTH]!;
  return `0x${root.toString(16).padStart(64, "0")}`;
}

export function protocolRegistryRootV4(sets: readonly (readonly string[])[]): `0x${string}` {
  return rootFor("protocol", sets.map((protocols) =>
    scalarFromMaterialV4("KLETIA_POLICY_PROTOCOL_LEAF_V2", { protocols: [...protocols].sort() })));
}

export function assetRegistryRootV4(sets: readonly (readonly string[])[]): `0x${string}` {
  return rootFor("asset", sets.map((assets) =>
    scalarFromMaterialV4("KLETIA_POLICY_ASSET_LEAF_V2", [...assets].sort())));
}

export function recipientRegistryRootV4(materials: readonly unknown[]): `0x${string}` {
  return rootFor("recipient", materials.map((material) =>
    scalarFromMaterialV4("KLETIA_POLICY_RECIPIENT_LEAF_V2", material)));
}
