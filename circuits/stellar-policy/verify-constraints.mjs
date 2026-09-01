import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { buildPoseidon } from "circomlibjs";

const buildDirectory = new URL("./build", import.meta.url);
mkdirSync(buildDirectory, { recursive: true });

function run(command, args, expectedSuccess = true) {
  const result = spawnSync(command, args, {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
  });
  if (expectedSuccess && result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (!expectedSuccess && result.status === 0) {
    throw new Error(`${command} unexpectedly accepted an invalid witness.`);
  }
  return result;
}

run("./node_modules/.bin/circom2", [
  "KletiaPolicyV1.circom",
  "--r1cs",
  "--wasm",
  "--sym",
  "-l",
  "node_modules",
  "-o",
  "build",
]);

const poseidon = await buildPoseidon();
const field = poseidon.F;
const hash = (values) => field.toObject(poseidon(values.map(BigInt))).toString();

function merklePath(leaf, offset) {
  const siblings = Array.from({ length: 16 }, (_, index) =>
    BigInt(offset + index + 1),
  );
  const pathIndices = Array.from({ length: 16 }, (_, index) => index % 2);
  let root = BigInt(leaf);
  for (let index = 0; index < siblings.length; index += 1) {
    root = BigInt(
      pathIndices[index] === 0
        ? hash([root, siblings[index]])
        : hash([siblings[index], root]),
    );
  }
  return {
    siblings: siblings.map(String),
    pathIndices: pathIndices.map(String),
    root: root.toString(),
  };
}

function validInput(overrides = {}) {
  const amount = BigInt(overrides.amount ?? 500);
  const minimumAmount = BigInt(overrides.minimumAmount ?? 100);
  const maximumAmount = BigInt(overrides.maximumAmount ?? 1_000);
  const workflowRoot = 9_001n;
  const environmentLane = 1n;
  const executionExpiresAtLedger = 9_999_999n;
  const policySalt = 101n;
  const executionContextSalt = 202n;
  const protocolLeaf = 301n;
  const assetLeaf = 401n;
  const recipientLeaf = 501n;
  const ownerSecret = 601n;
  const workflowNonce = 701n;
  const protocol = merklePath(protocolLeaf, 1_000);
  const asset = merklePath(assetLeaf, 2_000);
  const recipient = merklePath(recipientLeaf, 3_000);
  const policyRoot = hash([
    minimumAmount,
    maximumAmount,
    environmentLane,
    executionExpiresAtLedger,
    protocol.root,
    asset.root,
    recipient.root,
    policySalt,
  ]);
  const nullifier = hash([
    ownerSecret,
    workflowRoot,
    workflowNonce,
    policyRoot,
  ]);
  const executionContextCommitment = hash([
    amount,
    protocolLeaf,
    assetLeaf,
    recipientLeaf,
    environmentLane,
    executionExpiresAtLedger,
    workflowRoot,
    executionContextSalt,
  ]);
  return {
    workflowRoot: workflowRoot.toString(),
    policyRoot,
    protocolRegistryRoot: protocol.root,
    assetRegistryRoot: asset.root,
    recipientPolicyRoot: recipient.root,
    environmentLane: environmentLane.toString(),
    executionExpiresAtLedger: executionExpiresAtLedger.toString(),
    nullifier,
    executionContextCommitment:
      String(overrides.executionContextCommitment ?? executionContextCommitment),
    amount: amount.toString(),
    minimumAmount: minimumAmount.toString(),
    maximumAmount: maximumAmount.toString(),
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
}

const generator = "build/KletiaPolicyV1_js/generate_witness.js";
const wasm = "build/KletiaPolicyV1_js/KletiaPolicyV1.wasm";
const r1cs = "build/KletiaPolicyV1.r1cs";

function witness(name, input, expectedSuccess) {
  const inputPath = `build/${name}.json`;
  writeFileSync(new URL(inputPath, import.meta.url), JSON.stringify(input), {
    encoding: "utf8",
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [generator, wasm, inputPath, `build/${name}.wtns`],
    {
      cwd: new URL(".", import.meta.url),
      encoding: "utf8",
    },
  );
  if (expectedSuccess && result.status !== 0) {
    throw new Error(`valid witness failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (!expectedSuccess && result.status === 0) {
    throw new Error(`${name} unexpectedly satisfied the circuit.`);
  }
}

witness("valid", validInput(), true);
run("./node_modules/.bin/snarkjs", ["wtns", "check", r1cs, "build/valid.wtns"]);

witness("amount_above_cap", validInput({ amount: 1_001 }), false);
witness(
  "non_canonical_64_bit_amount",
  validInput({
    amount: 2n ** 64n + 1n,
    minimumAmount: 2n ** 64n,
    maximumAmount: 2n ** 64n + 2n,
  }),
  false,
);
const valid = validInput();
witness(
  "execution_context_mismatch",
  { ...valid, executionContextCommitment: (BigInt(valid.executionContextCommitment) + 1n).toString() },
  false,
);

assert.equal(Object.keys(valid).includes("executionContextCommitment"), true);
console.log(
  "Stellar policy circuit compiled and enforced valid, capped, 64-bit and execution-context witnesses.",
);
