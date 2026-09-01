import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL(".", import.meta.url);
const snarkjs = "./node_modules/.bin/snarkjs";

function run(args) {
  const result = spawnSync(snarkjs, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`snarkjs ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

run([
  "groth16",
  "fullprove",
  "build-v2/valid.json",
  "build-v2/KletiaPolicyV2_js/KletiaPolicyV2.wasm",
  "build-v2/testnet-deployment/kletia_policy_v2_testnet_final.zkey",
  "build-v2/testnet-deployment/smoke-proof.json",
  "build-v2/testnet-deployment/smoke-public.json",
]);
run([
  "groth16",
  "verify",
  "build-v2/testnet-deployment/verification_key.json",
  "build-v2/testnet-deployment/smoke-public.json",
  "build-v2/testnet-deployment/smoke-proof.json",
]);

const publicInputs = JSON.parse(readFileSync(new URL("build-v2/testnet-deployment/smoke-public.json", root)));
const valid = JSON.parse(readFileSync(new URL("build-v2/valid.json", root)));
const expected = [
  valid.workflowRoot,
  valid.policyRoot,
  valid.protocolRegistryRoot,
  valid.assetRegistryRoot,
  valid.recipientPolicyRoot,
  valid.selectedProtocolLeaf,
  valid.selectedAssetLeaf,
  valid.selectedRecipientLeaf,
  valid.environmentLane,
  valid.executionExpiresAtLedger,
  valid.nullifier,
  valid.executionContextCommitment,
].map(String);

assert.equal(publicInputs.length, 12);
assert.deepEqual(publicInputs, expected);
console.log("Policy V2 generated and verified a real 12-input Groth16 proof with the pinned Testnet development key.");
