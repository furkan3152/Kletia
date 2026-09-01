#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const circuitPath = "circuits/stellar-policy/KletiaPolicyV1.circom";
const schemaPath = "circuits/stellar-policy/public-inputs.v1.json";
const registryPath = "contracts/stellar/policy-verifier-registry/src/lib.rs";
const readinessPath = "apps/api/src/networks/stellar/controlPlaneReadiness.ts";
const protocolLockPath = "contracts/stellar/protocol.lock.json";

const circuit = readFileSync(circuitPath, "utf8");
const schemaRaw = readFileSync(schemaPath, "utf8");
const schema = JSON.parse(schemaRaw);
const registry = readFileSync(registryPath, "utf8");
const readiness = readFileSync(readinessPath, "utf8");
const protocolLock = JSON.parse(readFileSync(protocolLockPath, "utf8"));

const failures = [];
const requireFragment = (content, fragment, label) => {
  if (!content.includes(fragment)) failures.push(`${label} is missing ${fragment}`);
};

const mainPublicMatch = circuit.match(/component main \{public \[([\s\S]*?)\]\}/u);
if (!mainPublicMatch) {
  failures.push("the Circom main component does not declare a public-input list");
} else {
  const actualOrder = mainPublicMatch[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (JSON.stringify(actualOrder) !== JSON.stringify(schema.publicInputs)) {
    failures.push(`public-input order drifted: ${JSON.stringify(actualOrder)}`);
  }
}

for (const [fragment, label] of [
  ["amountAboveFloor.out === 1", "private minimum amount constraint"],
  ["amountWithinCap.out === 1", "private maximum amount constraint"],
  ["amountBits = Num2Bits(64)", "private amount range constraint"],
  ["minimumAmountBits = Num2Bits(64)", "minimum amount range constraint"],
  ["maximumAmountBits = Num2Bits(64)", "maximum amount range constraint"],
  ["environmentLane * (environmentLane - 1) === 0", "boolean lane constraint"],
  ["policyCommitment.out === policyRoot", "policy-root constraint"],
  ["protocolMembership.root <== protocolRegistryRoot", "protocol membership root"],
  ["assetMembership.root <== assetRegistryRoot", "asset membership root"],
  ["recipientMembership.root <== recipientPolicyRoot", "recipient policy root"],
  ["nullifierCommitment.out === nullifier", "workflow nullifier constraint"],
  ["executionContext.out === executionContextCommitment", "execution-context commitment constraint"],
  ["executionContext.inputs[0] <== amount", "execution-context amount binding"],
  ["executionContext.inputs[1] <== protocolLeaf", "execution-context protocol binding"],
  ["executionContext.inputs[2] <== assetLeaf", "execution-context asset binding"],
  ["executionContext.inputs[3] <== recipientLeaf", "execution-context recipient binding"],
]) {
  requireFragment(circuit, fragment, label);
}

if (/signal input current(?:Ledger|Epoch|Time)/u.test(circuit)) {
  failures.push("the circuit accepts caller-selected current time or ledger input");
}
requireFragment(registry, "expiry <= env.ledger().sequence()", "registry invocation-ledger expiry gate");
requireFragment(registry, "lane > 1", "registry lane encoding gate");
requireFragment(registry, "public_inputs.len() != record.public_input_count", "registry input-count gate");

const artifact = protocolLock.sourceArtifacts?.policyVerifierRegistry?.policyCircuit;
const circuitHash = createHash("sha256").update(circuit).digest("hex");
const schemaHash = createHash("sha256").update(schemaRaw).digest("hex");
if (artifact?.publicInputCount !== schema.publicInputs.length) {
  failures.push("protocol lock public-input count differs from the versioned schema");
}
if (artifact?.artifactStatus !== "testnet_development_setup_deployed_not_production") {
  failures.push("the circuit deployment profile is not pinned as Testnet development");
}
if (
  artifact?.generatedVerifierContractId !==
    "CBRC2RZQKVW4D4UNUTYGVK2VDJPGHEPNXNWFTEQIZHFHA3U2LLVWOG32" ||
  artifact?.verificationKeyHash !==
    "e5df288a729f0ebed5187cfe58bbd529512b433dd102cfafe556350e503687e6"
) {
  failures.push("the deployed Testnet verifier or exact verification key is not pinned");
}
if (artifact?.sourceSha256 !== circuitHash || artifact?.publicInputManifestSha256 !== schemaHash) {
  failures.push("protocol lock hashes do not match the circuit source and public-input manifest");
}
const groth16Verifier = protocolLock.sourceArtifacts?.policyGroth16Verifier;
if (
  !groth16Verifier?.releaseWasmSha256 ||
  artifact?.verifierReleaseWasmSha256 !== groth16Verifier.releaseWasmSha256
) {
  failures.push("policy circuit and Groth16 verifier release hashes are not bound together");
}
if (
  groth16Verifier?.claimBoundary?.realBn254PairingVectorTested !== true ||
  groth16Verifier?.claimBoundary?.testSetupSafeForDeployment !== false ||
  groth16Verifier?.claimBoundary?.testnetDevelopmentSetupDeployed !== true ||
  groth16Verifier?.claimBoundary?.trustedSetupProductionSafe !== false ||
  groth16Verifier?.claimBoundary?.productionVerificationKeyPresent !== false ||
  groth16Verifier?.claimBoundary?.deploymentProfile !== "testnet_development" ||
  groth16Verifier?.claimBoundary?.liveProofAccepted !== true
) {
  failures.push("Groth16 Testnet deployment and production-setup boundaries are not explicit");
}

for (const [key, environmentVariable] of [
  ["intentControlPlane", "STELLAR_INTENT_CONTROL_PLANE_TESTNET_CONTRACT_ID"],
  ["policyVerifierRegistry", "STELLAR_POLICY_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID"],
  ["policyReceiptRegistry", "STELLAR_POLICY_RECEIPT_REGISTRY_TESTNET_CONTRACT_ID"],
]) {
  const sourceArtifact = protocolLock.sourceArtifacts?.[key];
  if (!sourceArtifact?.releaseWasmSha256) {
    failures.push(`${key} release hash is absent from the protocol lock`);
    continue;
  }
  if (key === "policyReceiptRegistry") {
    requireFragment(
      readiness,
      "wasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256",
      `${key} live readiness hash import`,
    );
  } else {
    requireFragment(readiness, sourceArtifact.releaseWasmSha256, `${key} live readiness hash`);
  }
  requireFragment(readiness, environmentVariable, `${key} exact Testnet environment binding`);
  if (sourceArtifact.contractIdEnvironmentVariable !== environmentVariable) {
    failures.push(`${key} protocol-lock environment variable drifted`);
  }
}
requireFragment(readiness, "observeLiveExecutable", "live executable observation gate");
requireFragment(readiness, "observation.observedWasmSha256 === release.wasmSha256", "exact live WASM comparison");
requireFragment(readiness, "observeRegisteredPolicyVerifier", "live verifier-registry record observation");
requireFragment(readiness, '"get"', "versioned verifier-registry getter simulation");
requireFragment(readiness, "STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256", "generated verifier WASM binding");
requireFragment(readiness, "STELLAR_POLICY_VERIFICATION_KEY_SHA256", "verification-key binding");
requireFragment(readiness, "STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE", "Testnet artifact-profile binding");
requireFragment(
  readiness,
  groth16Verifier.releaseWasmSha256,
  "reviewed Groth16 verifier release binding",
);
requireFragment(readiness, "observed.enabled", "enabled verifier-record gate");
requireFragment(readiness, "generatedVerifierExecutable?.ready", "generated verifier live executable gate");

if (failures.length > 0) {
  console.error("Stellar policy circuit boundary verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Stellar policy circuit and BN254 verifier boundary passed (live Testnet-development deployment; no production trusted setup): circuit=${circuitHash}, schema=${schemaHash}`,
);
