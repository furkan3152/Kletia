import assert from "node:assert/strict";

import { derivePolicyMerklePathsV3 } from "../src/cross-chain/v3/policyMerkle";

const roots = derivePolicyMerklePathsV3({
  routeId: "arc-arbitrum-direct-cctp",
  solverRouteHash: `0x${"11".repeat(32)}`,
  recipient: "0x1111111111111111111111111111111111111111",
});

const hex32 = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

assert.equal(
  hex32(roots.protocol.root),
  "0x0576734ae54ff40f0697ffe315be4cd9ec855837ff7018116591860e0159280e",
);
assert.equal(
  hex32(roots.asset.root),
  "0x049b33a3927f8a518896a8238dc1480caec637596c5fecdfe83e8db8a18ff07a",
);
assert.equal(
  hex32(roots.recipient.root),
  "0x1e9e77111b85c0eff8c5d76468483130d699ec80598c8927873cf0ca3f482de5",
);
assert.deepEqual(roots.protocol.pathIndices, Array.from({ length: 16 }, () => "0"));

console.log("Browser policy Merkle roots match the pinned cross-runtime release vector.");
