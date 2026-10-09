import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { merkleAuditPath, merkleLeafHash, merkleRoot, verifyMerkleInclusion } from "../dist/index.js";

// Independent RFC 6962 §2.1 reference (node:crypto, recursive, as in the RFC text).
const h = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
function mth(leaves) {
  if (leaves.length === 0) return h(Buffer.alloc(0));
  if (leaves.length === 1) return h(Buffer.from([0]), Buffer.from(leaves[0], "hex"));
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return h(Buffer.from([1]), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}
function path(m, leaves) {
  if (leaves.length <= 1) return [];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return m < k ? [...path(m, leaves.slice(0, k)), mth(leaves.slice(k)).toString("hex")] : [...path(m - k, leaves.slice(k)), mth(leaves.slice(0, k)).toString("hex")];
}
const leaf = (index) => createHash("sha256").update(`receipt ${index}`).digest("hex");

test("RFC 6962 roots for sizes 0 to 9 match the reference", () => {
  for (let size = 0; size <= 9; size += 1) {
    const leaves = Array.from({ length: size }, (_, index) => leaf(index));
    assert.equal(merkleRoot(leaves), mth(leaves).toString("hex"), `size ${size}`);
  }
  assert.equal(merkleRoot([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.deepEqual(Buffer.from(merkleLeafHash(leaf(0))), h(Buffer.from([0]), Buffer.from(leaf(0), "hex")));
});

test("audit paths match the reference and verify (RFC 9162) for every index of trees of 1 to 17 leaves", () => {
  for (let size = 1; size <= 17; size += 1) {
    const leaves = Array.from({ length: size }, (_, index) => leaf(index));
    const root = merkleRoot(leaves);
    for (let index = 0; index < size; index += 1) {
      const proof = merkleAuditPath(index, leaves);
      assert.deepEqual(proof, path(index, leaves), `size ${size} index ${index}`);
      assert.equal(verifyMerkleInclusion({ leaf: leaves[index], leafIndex: index, treeSize: size, path: proof, root }), true, `size ${size} index ${index}`);
      if (size > 1) {
        assert.equal(verifyMerkleInclusion({ leaf: leaves[index], leafIndex: (index + 1) % size, treeSize: size, path: proof, root }), false, "wrong leaf index");
        assert.equal(verifyMerkleInclusion({ leaf: leaves[(index + 1) % size], leafIndex: index, treeSize: size, path: proof, root }), false, "wrong leaf");
      }
    }
  }
});

test("inclusion verification fails closed on malformed or inconsistent input", () => {
  const leaves = Array.from({ length: 5 }, (_, index) => leaf(index));
  const root = merkleRoot(leaves);
  const proof = merkleAuditPath(1, leaves);
  const good = { leaf: leaves[1], leafIndex: 1, treeSize: 5, path: proof, root };
  assert.equal(verifyMerkleInclusion(good), true);
  for (const bad of [
    // (A different treeSize can share a path shape; the signed batch binds size and root together.)
    { ...good, treeSize: 1 },
    { ...good, treeSize: 2 },
    { ...good, leafIndex: 5 },
    { ...good, leafIndex: -1 },
    { ...good, path: [...proof, leaf(9)] },
    { ...good, path: proof.slice(1) },
    { ...good, path: ["zz"] },
    { ...good, root: root.toUpperCase() },
    { ...good, leaf: "nope" },
  ]) {
    assert.equal(verifyMerkleInclusion(bad), false, JSON.stringify(bad).slice(0, 80));
  }
  assert.throws(() => merkleAuditPath(5, leaves), /outside the tree/u);
  assert.throws(() => merkleRoot(["not hex"]), /hex SHA-256/u);
});
