import { sha256 } from "@noble/hashes/sha256";
import { poseidon2 } from "poseidon-lite";

const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

const encoder = new TextEncoder();

function domainField(domain: string, value: string): bigint {
  const digest = sha256(encoder.encode(`${domain}\u001f${value}`));
  let field = 0n;
  for (const byte of digest) field = (field << 8n) | BigInt(byte);
  field %= BN254_SCALAR_FIELD_MODULUS;
  return field === 0n ? 1n : field;
}

function deterministicPath(leaf: bigint, namespace: string) {
  const siblings = Array.from({ length: 16 }, (_, index) =>
    domainField("KLETIA_POLICY_MERKLE_SIBLING_V1", `${namespace}:${index}`));
  const pathIndices = Array.from({ length: 16 }, () => 0n);
  let root = leaf;
  for (const sibling of siblings) root = poseidon2([root, sibling]);
  return {
    leaf,
    root,
    siblings: siblings.map(String),
    pathIndices: pathIndices.map(String),
  };
}

/**
 * Browser side of the cross-runtime policy-root release vector. These paths
 * are deterministic so the API can reject a client-selected private allowlist.
 */
export function derivePolicyMerklePathsV3(input: {
  readonly routeId: string;
  readonly solverRouteHash: `0x${string}`;
  readonly recipient: string;
}) {
  const protocolLeaf = domainField(
    "KLETIA_POLICY_PROTOCOL_LEAF_V1",
    `${input.routeId}:${input.solverRouteHash}`,
  );
  const assetLeaf = domainField(
    "KLETIA_POLICY_ASSET_LEAF_V1",
    "arc:5042002:USDC:arbitrum-sepolia:421614:USDC",
  );
  const recipientLeaf = domainField(
    "KLETIA_POLICY_RECIPIENT_LEAF_V1",
    input.recipient.toLowerCase(),
  );
  return {
    protocol: deterministicPath(protocolLeaf, "protocol"),
    asset: deterministicPath(assetLeaf, "asset"),
    recipient: deterministicPath(recipientLeaf, "recipient"),
  };
}
