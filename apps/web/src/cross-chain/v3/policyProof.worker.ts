/// <reference lib="webworker" />

import { Buffer } from "buffer";
import { poseidon2, poseidon4, poseidon8 } from "poseidon-lite";
import { derivePolicyMerklePathsV3 } from "./policyMerkle";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);
const BN254_BASE_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);
const PROVER_BASE = "/vendor/kletia-policy-v1";

type ProofRequest = {
  readonly id: string;
  readonly workflowRoot: `0x${string}`;
  readonly routeId: string;
  readonly solverRouteHash: `0x${string}`;
  readonly amountAtomic: string;
  readonly recipient: string;
  readonly executionExpiresAtLedger: number;
};

type Groth16Proof = {
  readonly pi_a: readonly string[];
  readonly pi_b: readonly (readonly string[])[];
  readonly pi_c: readonly string[];
};

function randomField(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value %= BN254_SCALAR_FIELD_MODULUS;
  return value === 0n ? 1n : value;
}

function poseidonHash(values: readonly bigint[]): bigint {
  if (values.length === 2) return poseidon2([...values]);
  if (values.length === 4) {
    return poseidon4([...values]);
  }
  if (values.length === 8) {
    return poseidon8([...values]);
  }
  throw new Error(`Unsupported Poseidon input width: ${values.length}.`);
}

function hex32(value: bigint): `0x${string}` {
  if (value <= 0n || value >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error("A generated policy scalar is outside the BN254 field.");
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function coordinate(value: string): string {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= BN254_BASE_FIELD_MODULUS) {
    throw new Error("The prover returned a non-canonical BN254 coordinate.");
  }
  return parsed.toString(16).padStart(64, "0");
}

function encodeProof(proof: Groth16Proof): `0x${string}` {
  const a = proof.pi_a;
  const b = proof.pi_b;
  const c = proof.pi_c;
  if (a.length < 2 || b.length < 2 || (b[0]?.length ?? 0) < 2 || (b[1]?.length ?? 0) < 2 || c.length < 2) {
    throw new Error("The prover returned an invalid Groth16 point set.");
  }
  // Soroban uses the Ethereum-compatible G2 order x.c1 | x.c0 | y.c1 | y.c0.
  return `0x${[
    a[0]!, a[1]!,
    b[0]![1]!, b[0]![0]!, b[1]![1]!, b[1]![0]!,
    c[0]!, c[1]!,
  ].map(coordinate).join("")}`;
}

async function prove(input: ProofRequest) {
  if (
    !/^0x[a-f\d]{64}$/iu.test(input.workflowRoot) ||
    !/^0x[a-f\d]{64}$/iu.test(input.solverRouteHash) ||
    !/^\d+$/u.test(input.amountAtomic) ||
    BigInt(input.amountAtomic) <= 0n ||
    !Number.isSafeInteger(input.executionExpiresAtLedger) ||
    input.executionExpiresAtLedger <= 0
  ) {
    throw new Error("The policy prover received malformed sealed inputs.");
  }
  const workflowRoot = BigInt(input.workflowRoot);
  if (workflowRoot <= 0n || workflowRoot >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error("The workflow root is outside the BN254 scalar field.");
  }
  const amount = BigInt(input.amountAtomic);
  if (amount >= 2n ** 64n) throw new Error("The policy amount exceeds its reviewed 64-bit circuit range.");

  self.postMessage({ id: input.id, success: "progress", stage: "loading_prover" });
  const { groth16 } = await import("snarkjs");
  const paths = derivePolicyMerklePathsV3({
    routeId: input.routeId,
    solverRouteHash: input.solverRouteHash,
    recipient: input.recipient,
  });
  const { protocol, asset, recipient } = paths;
  const protocolLeaf = protocol.leaf;
  const assetLeaf = asset.leaf;
  const recipientLeaf = recipient.leaf;
  const policySalt = randomField();
  const ownerSecret = randomField();
  const executionContextSalt = randomField();
  const workflowNonce = randomField();
  const environmentLane = 1n;
  const expiry = BigInt(input.executionExpiresAtLedger);
  const policyRoot = poseidonHash([
    1n,
    amount,
    environmentLane,
    expiry,
    protocol.root,
    asset.root,
    recipient.root,
    policySalt,
  ]);
  const nullifier = poseidonHash([ownerSecret, workflowRoot, workflowNonce, policyRoot]);
  const executionContextCommitment = poseidonHash([
    amount,
    protocolLeaf,
    assetLeaf,
    recipientLeaf,
    environmentLane,
    expiry,
    workflowRoot,
    executionContextSalt,
  ]);
  const witness = {
    workflowRoot: workflowRoot.toString(),
    policyRoot: policyRoot.toString(),
    protocolRegistryRoot: protocol.root.toString(),
    assetRegistryRoot: asset.root.toString(),
    recipientPolicyRoot: recipient.root.toString(),
    environmentLane: environmentLane.toString(),
    executionExpiresAtLedger: expiry.toString(),
    nullifier: nullifier.toString(),
    executionContextCommitment: executionContextCommitment.toString(),
    amount: amount.toString(),
    minimumAmount: "1",
    maximumAmount: amount.toString(),
    policySalt: policySalt.toString(),
    protocolLeaf: protocolLeaf.toString(),
    protocolSiblings: protocol.siblings,
    protocolPathIndices: protocol.pathIndices,
    assetLeaf: assetLeaf.toString(),
    assetSiblings: asset.siblings,
    assetPathIndices: asset.pathIndices,
    recipientLeaf: recipientLeaf.toString(),
    recipientSiblings: recipient.siblings,
    recipientPathIndices: recipient.pathIndices,
    ownerSecret: ownerSecret.toString(),
    workflowNonce: workflowNonce.toString(),
    executionContextSalt: executionContextSalt.toString(),
  };
  self.postMessage({ id: input.id, success: "progress", stage: "proving" });
  const result = await groth16.fullProve(
    witness,
    `${PROVER_BASE}/KletiaPolicyV1.wasm`,
    `${PROVER_BASE}/kletia_policy_testnet_final.zkey`,
  );
  const expectedPublic = [
    workflowRoot,
    policyRoot,
    protocol.root,
    asset.root,
    recipient.root,
    environmentLane,
    expiry,
    nullifier,
    executionContextCommitment,
  ].map(String);
  if (
    result.publicSignals.length !== expectedPublic.length ||
    result.publicSignals.some((value, index) => value !== expectedPublic[index])
  ) {
    throw new Error("The generated proof public inputs did not match the sealed policy witness.");
  }
  self.postMessage({ id: input.id, success: "progress", stage: "encoding" });
  return {
    schemaVersion: "kletia_policy_proof_envelope_v1" as const,
    routeId: input.routeId,
    workflowRoot: hex32(workflowRoot),
    policyRoot: hex32(policyRoot),
    protocolRegistryRoot: hex32(protocol.root),
    assetRegistryRoot: hex32(asset.root),
    recipientPolicyRoot: hex32(recipient.root),
    executionExpiresAtLedger: input.executionExpiresAtLedger,
    nullifier: hex32(nullifier),
    executionContextCommitment: hex32(executionContextCommitment),
    verifierVersion: 1,
    proof: encodeProof(result.proof),
  };
}

self.addEventListener("message", (event: MessageEvent<ProofRequest>) => {
  const input = event.data;
  void prove(input).then(
    (policyProof) => self.postMessage({ id: input.id, success: true, policyProof }),
    (error: unknown) => self.postMessage({
      id: input.id,
      success: false,
      message: error instanceof Error ? error.message : "Device policy proof generation failed.",
    }),
  );
});

export {};
