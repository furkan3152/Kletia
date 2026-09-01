import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { poseidon2, poseidon4, poseidon8 } from "poseidon-lite";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(appRoot, "../..");
const circuitRoot = resolve(repositoryRoot, "circuits/stellar-policy");
const fieldModulus = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
const owner = process.env.KLETIA_POLICY_V2_SMOKE_OWNER_ALIAS?.trim() || "";
const controlPlane = process.env.STELLAR_INTENT_CONTROL_PLANE_V2_TESTNET_CONTRACT_ID?.trim() || "";
const registry = process.env.STELLAR_POLICY_V2_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID?.trim() || "";
const verifier = process.env.STELLAR_POLICY_V2_VERIFIER_TESTNET_CONTRACT_ID?.trim() || "";

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed without an automatic retry:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function scalar() {
  const value = BigInt(`0x${randomBytes(32).toString("hex")}`) % fieldModulus;
  return value === 0n ? 1n : value;
}

function bytes32(value) {
  const encoded = BigInt(value).toString(16).padStart(64, "0");
  if (encoded.length !== 64) fail("A smoke-test scalar exceeds 32 bytes.");
  return encoded;
}

function merkleRoot(leaf, siblings, pathIndices) {
  let current = BigInt(leaf);
  for (let index = 0; index < siblings.length; index += 1) {
    current = pathIndices[index] === "0"
      ? poseidon2([current, BigInt(siblings[index])])
      : poseidon2([BigInt(siblings[index]), current]);
  }
  return current;
}

async function latestTransaction(address) {
  const response = await fetch(
    `https://horizon-testnet.stellar.org/accounts/${address}/transactions?order=desc&limit=1`,
    { redirect: "error" },
  );
  if (!response.ok) fail(`Horizon transaction evidence returned HTTP ${response.status}.`);
  const payload = await response.json();
  const record = payload?._embedded?.records?.[0];
  return record
    ? { hash: String(record.hash), ledger: Number(record.ledger), createdAt: String(record.created_at) }
    : null;
}

async function recordNewTransaction(address, priorHash) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await latestTransaction(address);
    if (latest && latest.hash !== priorHash) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  fail("The submitted transaction succeeded locally but Horizon evidence did not advance; result is indeterminate and was not retried.");
}

if (process.env.KLETIA_CONFIRM_POLICY_V2_LIVE_SMOKE !== "RUN_OWNER_SIGNED_STELLAR_TESTNET_POLICY_V2_SMOKE") {
  fail("Live smoke is disabled. Supply the exact Testnet confirmation phrase to send owner-signed transactions.");
}
if (!owner) fail("KLETIA_POLICY_V2_SMOKE_OWNER_ALIAS is required.");
for (const [label, value] of [["control plane", controlPlane], ["registry", registry], ["verifier", verifier]]) {
  if (!/^C[A-Z2-7]{55}$/u.test(value)) fail(`The ${label} contract ID is invalid.`);
}

const ownerAddress = run("stellar", ["keys", "address", owner]);
if (!/^G[A-Z2-7]{55}$/u.test(ownerAddress)) fail("The smoke owner alias did not resolve to a public G-account.");
const boundRegistry = JSON.parse(run("stellar", [
  "-q", "contract", "invoke", "--id", controlPlane, "--source-account", ownerAddress,
  "--network", "testnet", "--send", "no", "--", "verifier_registry",
]));
assert.equal(boundRegistry, registry, "Control-plane registry binding drifted before live smoke.");
const metadata = JSON.parse(run("stellar", [
  "-q", "contract", "invoke", "--id", verifier, "--source-account", ownerAddress,
  "--network", "testnet", "--send", "no", "--", "metadata",
]));
assert.equal(metadata.public_input_count, 12, "The live verifier is not the twelve-input Policy V2 release.");

const horizonRoot = await (await fetch("https://horizon-testnet.stellar.org", { redirect: "error" })).json();
const currentLedger = Number(horizonRoot.core_latest_ledger);
if (!Number.isSafeInteger(currentLedger) || currentLedger <= 0) fail("Horizon did not return a valid current ledger.");
const executionExpiresAtLedger = currentLedger + 720;
const receiptCloseByLedger = currentLedger + 1_440;
const retentionFloorLedger = currentLedger + 120_960;
const base = JSON.parse(await readFile(resolve(circuitRoot, "build-v2/valid.json"), "utf8"));
const workflowRoot = scalar();
const protocolRegistryRoot = merkleRoot(base.selectedProtocolLeaf, base.protocolSiblings, base.protocolPathIndices);
const assetRegistryRoot = merkleRoot(base.selectedAssetLeaf, base.assetSiblings, base.assetPathIndices);
const recipientPolicyRoot = merkleRoot(base.selectedRecipientLeaf, base.recipientSiblings, base.recipientPathIndices);
const policySalt = scalar();
const ownerSecret = scalar();
const workflowNonce = scalar();
const executionContextSalt = scalar();
const policyRoot = poseidon8([
  BigInt(base.minimumAmount), BigInt(base.maximumAmount), 1n, BigInt(executionExpiresAtLedger),
  protocolRegistryRoot, assetRegistryRoot, recipientPolicyRoot, policySalt,
]);
const nullifier = poseidon4([ownerSecret, workflowRoot, workflowNonce, policyRoot]);
const executionContextCommitment = poseidon8([
  BigInt(base.amount), BigInt(base.selectedProtocolLeaf), BigInt(base.selectedAssetLeaf),
  BigInt(base.selectedRecipientLeaf), 1n, BigInt(executionExpiresAtLedger), workflowRoot,
  executionContextSalt,
]);
const input = {
  ...base,
  workflowRoot: workflowRoot.toString(),
  policyRoot: policyRoot.toString(),
  protocolRegistryRoot: protocolRegistryRoot.toString(),
  assetRegistryRoot: assetRegistryRoot.toString(),
  recipientPolicyRoot: recipientPolicyRoot.toString(),
  environmentLane: "1",
  executionExpiresAtLedger: String(executionExpiresAtLedger),
  nullifier: nullifier.toString(),
  executionContextCommitment: executionContextCommitment.toString(),
  policySalt: policySalt.toString(),
  ownerSecret: ownerSecret.toString(),
  workflowNonce: workflowNonce.toString(),
  executionContextSalt: executionContextSalt.toString(),
};

const temporary = await mkdtemp(resolve(tmpdir(), "kletia-policy-v2-smoke-"));
try {
  const inputPath = resolve(temporary, "input.json");
  const proofPath = resolve(temporary, "proof.json");
  const publicPath = resolve(temporary, "public.json");
  const transportPrefix = resolve(temporary, "transport");
  await writeFile(inputPath, `${JSON.stringify(input)}\n`, { mode: 0o600 });
  run("./node_modules/.bin/snarkjs", [
    "groth16", "fullprove", inputPath,
    "build-v2/KletiaPolicyV2_js/KletiaPolicyV2.wasm",
    "build-v2/testnet-deployment/kletia_policy_v2_testnet_final.zkey",
    proofPath, publicPath,
  ], { cwd: circuitRoot });
  run("./node_modules/.bin/snarkjs", [
    "groth16", "verify", "build-v2/testnet-deployment/verification_key.json",
    publicPath, proofPath,
  ], { cwd: circuitRoot });
  run("node", [
    resolve(repositoryRoot, "tooling/prepare-stellar-groth16-proof.mjs"),
    proofPath, publicPath, transportPrefix,
  ]);
  const envelope = JSON.parse(await readFile(`${transportPrefix}.envelope.json`, "utf8"));
  const publicInputs = JSON.parse(await readFile(publicPath, "utf8"));
  assert.deepEqual(publicInputs.map(String), [
    workflowRoot, policyRoot, protocolRegistryRoot, assetRegistryRoot, recipientPolicyRoot,
    BigInt(base.selectedProtocolLeaf), BigInt(base.selectedAssetLeaf),
    BigInt(base.selectedRecipientLeaf), 1n, BigInt(executionExpiresAtLedger), nullifier,
    executionContextCommitment,
  ].map(String));

  const nonce = Number(run("stellar", [
    "-q", "contract", "invoke", "--id", controlPlane, "--source-account", ownerAddress,
    "--network", "testnet", "--send", "no", "--", "next_nonce", "--owner", ownerAddress,
  ]));
  if (!Number.isSafeInteger(nonce) || nonce < 0) fail("The live control plane returned an invalid owner nonce.");
  const beforeCommit = await latestTransaction(ownerAddress);
  run("stellar", [
    "-q", "contract", "invoke", "--id", controlPlane, "--source-account", owner,
    "--network", "testnet", "--send", "yes", "--", "commit",
    "--owner", ownerAddress, "--nonce", String(nonce),
    "--workflow_root", bytes32(workflowRoot), "--policy_root", bytes32(policyRoot),
    "--protocol_registry_root", bytes32(protocolRegistryRoot),
    "--asset_registry_root", bytes32(assetRegistryRoot),
    "--recipient_policy_root", bytes32(recipientPolicyRoot),
    "--selected_protocol_leaf", bytes32(base.selectedProtocolLeaf),
    "--selected_asset_leaf", bytes32(base.selectedAssetLeaf),
    "--selected_recipient_leaf", bytes32(base.selectedRecipientLeaf),
    "--nullifier", bytes32(nullifier),
    "--execution_context_commitment", bytes32(executionContextCommitment),
    "--lane", "Testnet", "--execution_expires_at_ledger", String(executionExpiresAtLedger),
    "--receipt_close_by_ledger", String(receiptCloseByLedger),
    "--retention_floor_ledger", String(retentionFloorLedger), "--verifier_version", "2",
    "--proof", envelope.proof.slice(2),
  ]);
  const commitTransaction = await recordNewTransaction(ownerAddress, beforeCommit?.hash ?? null);

  const receiptRoot = createHash("sha256").update(JSON.stringify({
    schemaVersion: "kletia_policy_v2_testnet_smoke_receipt_v1",
    controlPlane, registry, verifier, owner: ownerAddress, nonce,
    workflowRoot: bytes32(workflowRoot), commitTransaction: commitTransaction.hash,
    provesForeignChainExecution: false,
  })).digest("hex");
  const beforeFinalize = await latestTransaction(ownerAddress);
  run("stellar", [
    "-q", "contract", "invoke", "--id", controlPlane, "--source-account", owner,
    "--network", "testnet", "--send", "yes", "--", "finalize",
    "--owner", ownerAddress, "--nonce", String(nonce), "--receipt_root", receiptRoot,
  ]);
  const finalizeTransaction = await recordNewTransaction(ownerAddress, beforeFinalize?.hash ?? null);
  const record = JSON.parse(run("stellar", [
    "-q", "contract", "invoke", "--id", controlPlane, "--source-account", ownerAddress,
    "--network", "testnet", "--send", "no", "--", "get", "--owner", ownerAddress,
    "--nonce", String(nonce),
  ]));
  assert.equal(record.status, "Finalized");
  assert.equal(record.receipt_root, receiptRoot);
  assert.equal(record.verifier_version, 2);

  console.log(JSON.stringify({
    schemaVersion: "kletia_stellar_control_plane_v2_live_smoke_v1",
    network: "stellar_testnet",
    owner: ownerAddress,
    controlPlane,
    registry,
    verifier,
    workflowNonce: String(nonce),
    workflowRoot: bytes32(workflowRoot),
    publicInputsSha256: createHash("sha256").update(publicInputs.join("|")).digest("hex"),
    commitTransaction,
    finalizeTransaction,
    receiptRoot,
    nullifierConsumed: true,
    finalStatus: "finalized",
    provesForeignChainExecution: false,
    productionReady: false,
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
