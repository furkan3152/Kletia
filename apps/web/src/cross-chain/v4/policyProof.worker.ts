/// <reference lib="webworker" />

import { Buffer } from "buffer";
import { poseidon2, poseidon4, poseidon8 } from "poseidon-lite";

import { randomScalarV4, scalarHexV4 } from "./canonical";
import type {
  DevicePolicyProofEnvelopeV4,
  PolicyChallengeV4,
  SelectedPolicyWitnessV4,
} from "./types";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

const PROVER_BASE = "/vendor/kletia-policy-v2";
const PROVER_ARTIFACTS = Object.freeze({
  wasm: {
    url: `${PROVER_BASE}/KletiaPolicyV2.wasm`,
    sha256: "f13d9dc4e1ee86fd432a45d9696c91122d8beef3906687acb6a84d1b311115a5",
  },
  provingKey: {
    url: `${PROVER_BASE}/kletia_policy_v2_testnet_final.zkey`,
    sha256: "797054251bab3165a7cdc868d81027b306462e9e181c97db8ec4238344d2b52a",
  },
});
const BN254_BASE_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

type ProofRequest = {
  readonly id: string;
  readonly challenge: PolicyChallengeV4;
  readonly amountAtomic: string;
  readonly witness: SelectedPolicyWitnessV4;
};

type Groth16Proof = {
  readonly pi_a: readonly string[];
  readonly pi_b: readonly (readonly string[])[];
  readonly pi_c: readonly string[];
};

function coordinate(value: string): string {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= BN254_BASE_FIELD_MODULUS) {
    throw new Error("The prover returned a non-canonical BN254 coordinate.");
  }
  return parsed.toString(16).padStart(64, "0");
}

function encodeProof(proof: Groth16Proof): `0x${string}` {
  const { pi_a: a, pi_b: b, pi_c: c } = proof;
  if (a.length < 2 || b.length < 2 || (b[0]?.length ?? 0) < 2 || (b[1]?.length ?? 0) < 2 || c.length < 2) {
    throw new Error("The prover returned an invalid Groth16 point set.");
  }
  return `0x${[
    a[0]!, a[1]!,
    b[0]![1]!, b[0]![0]!, b[1]![1]!, b[1]![0]!,
    c[0]!, c[1]!,
  ].map(coordinate).join("")}`;
}

function pathRoot(leaf: bigint, siblings: readonly string[], indices: readonly string[]): bigint {
  if (siblings.length !== 16 || indices.length !== 16) throw new Error("Policy V2 requires an exact depth-16 path.");
  let current = leaf;
  for (let index = 0; index < 16; index += 1) {
    const direction = indices[index];
    if (direction !== "0" && direction !== "1") throw new Error("A policy Merkle direction is invalid.");
    const sibling = BigInt(siblings[index]!);
    current = direction === "0" ? poseidon2([current, sibling]) : poseidon2([sibling, current]);
  }
  return current;
}

async function pinnedArtifact(input: { readonly url: string; readonly sha256: string }): Promise<string> {
  const response = await fetch(input.url, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new Error("A pinned Policy V2 prover artifact is unavailable.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("A pinned Policy V2 prover artifact is empty.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const observed = Array.from(digest, (entry) => entry.toString(16).padStart(2, "0")).join("");
  if (observed !== input.sha256) {
    throw new Error("A served Policy V2 prover artifact failed its pinned SHA-256 identity.");
  }
  return URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
}

async function prove(input: ProofRequest): Promise<DevicePolicyProofEnvelopeV4> {
  const { challenge, witness } = input;
  if (
    challenge.schemaVersion !== "kletia_policy_challenge_v2" ||
    challenge.verifierVersion !== 2 ||
    !/^\d+$/u.test(input.amountAtomic) ||
    witness.schemaVersion !== "kletia_selected_policy_witness_v2"
  ) {
    throw new Error("The Policy V2 worker received a malformed sealed request.");
  }
  const amount = BigInt(input.amountAtomic);
  const minimumAmount = BigInt(witness.minimumAmountAtomic);
  const maximumAmount = BigInt(witness.maximumAmountAtomic);
  if (amount < minimumAmount || amount > maximumAmount || maximumAmount >= 2n ** 64n) {
    throw new Error("The execution amount is outside the user-signed Policy V2 range.");
  }
  const protocolLeaf = BigInt(challenge.selectedProtocolLeaf);
  const assetLeaf = BigInt(challenge.selectedAssetLeaf);
  const recipientLeaf = BigInt(challenge.selectedRecipientLeaf);
  const protocolRoot = pathRoot(protocolLeaf, witness.protocol.siblings, witness.protocol.pathIndices);
  const assetRoot = pathRoot(assetLeaf, witness.asset.siblings, witness.asset.pathIndices);
  const recipientRoot = pathRoot(recipientLeaf, witness.recipient.siblings, witness.recipient.pathIndices);
  if (
    scalarHexV4(protocolRoot) !== challenge.protocolRegistryRoot ||
    scalarHexV4(assetRoot) !== challenge.assetRegistryRoot ||
    scalarHexV4(recipientRoot) !== challenge.recipientPolicyRoot
  ) {
    throw new Error("The selected route is not a member of the locally retained signed policy registries.");
  }
  const policyRoot = poseidon8([
    minimumAmount,
    maximumAmount,
    BigInt(challenge.environmentLane),
    BigInt(challenge.executionExpiresAtLedger),
    protocolRoot,
    assetRoot,
    recipientRoot,
    BigInt(witness.policySalt),
  ]);
  if (scalarHexV4(policyRoot) !== challenge.policyRoot) {
    throw new Error("The locally retained policy opening no longer matches the signed policy root.");
  }

  const workflowRoot = BigInt(challenge.workflowRoot);
  const workflowNonce = randomScalarV4();
  const executionContextSalt = randomScalarV4();
  const nullifier = poseidon4([
    BigInt(witness.ownerSecret),
    workflowRoot,
    workflowNonce,
    policyRoot,
  ]);
  const executionContextCommitment = poseidon8([
    amount,
    protocolLeaf,
    assetLeaf,
    recipientLeaf,
    BigInt(challenge.environmentLane),
    BigInt(challenge.executionExpiresAtLedger),
    workflowRoot,
    executionContextSalt,
  ]);
  const circuitInput = {
    workflowRoot: workflowRoot.toString(),
    policyRoot: policyRoot.toString(),
    protocolRegistryRoot: protocolRoot.toString(),
    assetRegistryRoot: assetRoot.toString(),
    recipientPolicyRoot: recipientRoot.toString(),
    selectedProtocolLeaf: protocolLeaf.toString(),
    selectedAssetLeaf: assetLeaf.toString(),
    selectedRecipientLeaf: recipientLeaf.toString(),
    environmentLane: String(challenge.environmentLane),
    executionExpiresAtLedger: String(challenge.executionExpiresAtLedger),
    nullifier: nullifier.toString(),
    executionContextCommitment: executionContextCommitment.toString(),
    amount: amount.toString(),
    minimumAmount: minimumAmount.toString(),
    maximumAmount: maximumAmount.toString(),
    policySalt: witness.policySalt,
    protocolSiblings: witness.protocol.siblings,
    protocolPathIndices: witness.protocol.pathIndices,
    assetSiblings: witness.asset.siblings,
    assetPathIndices: witness.asset.pathIndices,
    recipientSiblings: witness.recipient.siblings,
    recipientPathIndices: witness.recipient.pathIndices,
    ownerSecret: witness.ownerSecret,
    workflowNonce: workflowNonce.toString(),
    executionContextSalt: executionContextSalt.toString(),
  };
  self.postMessage({ id: input.id, success: "progress", stage: "loading_prover" });
  const { groth16 } = await import("snarkjs");
  const [wasmUrl, provingKeyUrl] = await Promise.all([
    pinnedArtifact(PROVER_ARTIFACTS.wasm),
    pinnedArtifact(PROVER_ARTIFACTS.provingKey),
  ]);
  self.postMessage({ id: input.id, success: "progress", stage: "proving" });
  let result: Awaited<ReturnType<typeof groth16.fullProve>>;
  try {
    result = await groth16.fullProve(circuitInput, wasmUrl, provingKeyUrl);
  } finally {
    URL.revokeObjectURL(wasmUrl);
    URL.revokeObjectURL(provingKeyUrl);
  }
  const expectedPublic = [
    workflowRoot,
    policyRoot,
    protocolRoot,
    assetRoot,
    recipientRoot,
    protocolLeaf,
    assetLeaf,
    recipientLeaf,
    BigInt(challenge.environmentLane),
    BigInt(challenge.executionExpiresAtLedger),
    nullifier,
    executionContextCommitment,
  ].map(String);
  if (
    result.publicSignals.length !== expectedPublic.length ||
    result.publicSignals.some((value, index) => value !== expectedPublic[index])
  ) {
    throw new Error("The generated proof public inputs differ from the sealed Policy V2 challenge.");
  }
  self.postMessage({ id: input.id, success: "progress", stage: "encoding" });
  return {
    ...challenge,
    schemaVersion: "kletia_policy_proof_envelope_v2",
    nullifier: scalarHexV4(nullifier),
    executionContextCommitment: scalarHexV4(executionContextCommitment),
    proof: encodeProof(result.proof),
  };
}

self.addEventListener("message", (event: MessageEvent<ProofRequest>) => {
  void prove(event.data).then(
    (policyProof) => self.postMessage({ id: event.data.id, success: true, policyProof }),
    (error: unknown) => self.postMessage({
      id: event.data.id,
      success: false,
      message: error instanceof Error ? error.message : "Device Policy V2 proof generation failed.",
    }),
  );
});

export {};
