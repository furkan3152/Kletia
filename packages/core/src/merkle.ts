/**
 * RFC 6962 Merkle trees over 32-byte digests (the receipt transparency log,
 * design §5.8): Merkle Tree Hash, audit paths, and RFC 9162 §2.1.3.2
 * inclusion verification. Leaves are hex SHA-256 digests (64 characters);
 * every function is pure and synchronous.
 *
 *   MTH({})    = SHA-256()
 *   MTH({d})   = SHA-256(0x00 || d)
 *   MTH(D[n])  = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n])), k = largest power of two < n
 */
import { bytesToHex, hexToBytes, sha256 } from "./hash.js";

const DIGEST_HEX = /^[0-9a-f]{64}$/u;

function digestBytes(hex: string, what: string): Uint8Array {
  const bytes = DIGEST_HEX.test(hex) ? hexToBytes(hex) : null;
  if (!bytes) throw new Error(`${what} must be a lower-case hex SHA-256 digest.`);
  return bytes;
}

/** `SHA-256(0x00 || leaf)` of a hex digest, as bytes. */
export function merkleLeafHash(leaf: string): Uint8Array {
  const bytes = digestBytes(leaf, "A Merkle leaf");
  const input = new Uint8Array(33);
  input[0] = 0x00;
  input.set(bytes, 1);
  return sha256(input);
}

/** `SHA-256(0x01 || left || right)`. */
export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = new Uint8Array(1 + left.length + right.length);
  input[0] = 0x01;
  input.set(left, 1);
  input.set(right, 1 + left.length);
  return sha256(input);
}

function split(size: number): number {
  let k = 1;
  while (k * 2 < size) k *= 2;
  return k;
}

function treeHash(leaves: readonly string[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return merkleLeafHash(leaves[0] as string);
  const k = split(leaves.length);
  return merkleNodeHash(treeHash(leaves.slice(0, k)), treeHash(leaves.slice(k)));
}

/** RFC 6962 Merkle Tree Hash of hex digests, as lower-case hex. */
export function merkleRoot(leaves: readonly string[]): string {
  return bytesToHex(treeHash(leaves));
}

/** RFC 6962 §2.1.1 audit path for `leafIndex`, as lower-case hex (closest sibling first). */
export function merkleAuditPath(leafIndex: number, leaves: readonly string[]): string[] {
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error("leafIndex is outside the tree.");
  }
  const path = (index: number, subtree: readonly string[]): string[] => {
    if (subtree.length <= 1) return [];
    const k = split(subtree.length);
    return index < k
      ? [...path(index, subtree.slice(0, k)), bytesToHex(treeHash(subtree.slice(k)))]
      : [...path(index - k, subtree.slice(k)), bytesToHex(treeHash(subtree.slice(0, k)))];
  };
  return path(leafIndex, leaves);
}

export interface MerkleInclusionProof {
  /** Hex digest of the leaf (not its leaf hash). */
  readonly leaf: string;
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly path: readonly string[];
  /** Hex Merkle Tree Hash the path must reach. */
  readonly root: string;
}

/** RFC 9162 §2.1.3.2 inclusion verification. Never throws: malformed input is `false`. */
export function verifyMerkleInclusion(proof: MerkleInclusionProof): boolean {
  const { leaf, leafIndex, treeSize, path, root } = proof;
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize) || leafIndex < 0 || leafIndex >= treeSize) return false;
  if (typeof leaf !== "string" || typeof root !== "string" || !DIGEST_HEX.test(leaf) || !DIGEST_HEX.test(root)) return false;
  if (!Array.isArray(path) || path.length > 64 || path.some((entry) => typeof entry !== "string" || !DIGEST_HEX.test(entry))) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let hash = merkleLeafHash(leaf);
  for (const entry of path) {
    if (sn === 0) return false;
    const sibling = hexToBytes(entry) as Uint8Array;
    if (fn % 2 === 1 || fn === sn) {
      hash = merkleNodeHash(sibling, hash);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      hash = merkleNodeHash(hash, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && bytesToHex(hash) === root;
}
