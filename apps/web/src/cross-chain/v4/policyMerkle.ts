import { poseidon2 } from "poseidon-lite";

import { scalarFromMaterialV4, scalarHexV4 } from "./canonical";
import type {
  PolicyMerklePathV4,
  PolicyMerkleTreeV4,
  PolicyRecipientMaterialV4,
} from "./types";

const POLICY_TREE_DEPTH = 16 as const;

function canonicalSet(values: readonly string[]): readonly string[] {
  if (values.length === 0) throw new Error("A policy route set cannot be empty.");
  const entries = [...values].map((value) => value.trim().toLowerCase()).sort();
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length) {
    throw new Error("A policy route set contains an empty or duplicate entry.");
  }
  return entries;
}

export function protocolLeafV4(protocols: readonly string[]): bigint {
  return scalarFromMaterialV4("KLETIA_POLICY_PROTOCOL_LEAF_V2", {
    protocols: canonicalSet(protocols),
  });
}

export function assetLeafV4(assets: readonly string[]): bigint {
  return scalarFromMaterialV4("KLETIA_POLICY_ASSET_LEAF_V2", canonicalSet(assets));
}

export function recipientLeafV4(material: PolicyRecipientMaterialV4): bigint {
  return scalarFromMaterialV4("KLETIA_POLICY_RECIPIENT_LEAF_V2", material);
}

function emptyLeaf(namespace: PolicyMerkleTreeV4["namespace"]): bigint {
  return scalarFromMaterialV4("KLETIA_POLICY_EMPTY_LEAF_V2", { namespace });
}

/**
 * Builds a deterministic sparse depth-16 Poseidon tree without allocating all
 * 65,536 leaves. Real leaves occupy their canonical scalar order; every unused
 * position has one domain-separated empty value.
 */
export function buildPolicyMerkleTreeV4(
  namespace: PolicyMerkleTreeV4["namespace"],
  inputLeaves: readonly bigint[],
): PolicyMerkleTreeV4 {
  const leaves = [...inputLeaves].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (leaves.length === 0 || leaves.length > 2 ** POLICY_TREE_DEPTH) {
    throw new Error("A policy registry must contain between one and 65,536 leaves.");
  }
  const identities = leaves.map((leaf) => scalarHexV4(leaf));
  if (new Set(identities).size !== identities.length) {
    throw new Error(`The ${namespace} policy registry contains duplicate leaves.`);
  }

  const defaults: bigint[] = [emptyLeaf(namespace)];
  for (let level = 0; level < POLICY_TREE_DEPTH; level += 1) {
    defaults.push(poseidon2([defaults[level]!, defaults[level]!]));
  }

  const levels: Array<Map<number, bigint>> = [];
  let nodes = new Map<number, bigint>(leaves.map((leaf, index) => [index, leaf]));
  levels.push(nodes);
  for (let level = 0; level < POLICY_TREE_DEPTH; level += 1) {
    const parents = new Set([...nodes.keys()].map((index) => Math.floor(index / 2)));
    const next = new Map<number, bigint>();
    for (const parent of parents) {
      const left = nodes.get(parent * 2) ?? defaults[level]!;
      const right = nodes.get(parent * 2 + 1) ?? defaults[level]!;
      const value = poseidon2([left, right]);
      if (value !== defaults[level + 1]) next.set(parent, value);
    }
    nodes = next;
    levels.push(nodes);
  }
  const root = levels[POLICY_TREE_DEPTH]!.get(0) ?? defaults[POLICY_TREE_DEPTH]!;
  const paths = new Map<string, PolicyMerklePathV4>();
  leaves.forEach((leaf, leafIndex) => {
    const siblings: string[] = [];
    const pathIndices: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < POLICY_TREE_DEPTH; level += 1) {
      siblings.push(String(levels[level]!.get(index ^ 1) ?? defaults[level]!));
      pathIndices.push(String(index & 1));
      index = Math.floor(index / 2);
    }
    paths.set(scalarHexV4(leaf), {
      leaf,
      root,
      leafIndex,
      siblings,
      pathIndices,
    });
  });
  return { namespace, depth: POLICY_TREE_DEPTH, root, paths };
}

export function pathForPolicyLeafV4(tree: PolicyMerkleTreeV4, leaf: bigint): PolicyMerklePathV4 {
  const path = tree.paths.get(scalarHexV4(leaf));
  if (!path) throw new Error(`The selected ${tree.namespace} leaf is outside the signed policy registry.`);
  return path;
}

