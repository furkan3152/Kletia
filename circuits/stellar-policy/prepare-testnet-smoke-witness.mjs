import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { buildPoseidon } from "circomlibjs";

const latestLedger = Number(process.argv[2]);
const outputDirectory = new URL("./build/testnet-deployment/", import.meta.url);
if (!Number.isSafeInteger(latestLedger) || latestLedger <= 0) {
  throw new Error("Usage: node prepare-testnet-smoke-witness.mjs <latest-ledger>");
}
mkdirSync(outputDirectory, { recursive: true });

const poseidon = await buildPoseidon();
const field = poseidon.F;
const hash = (values) => field.toObject(poseidon(values.map(BigInt))).toString();
const modulus = BigInt(field.p);
const randomField = () => {
  const value = BigInt(`0x${randomBytes(32).toString("hex")}`) % modulus;
  return value === 0n ? 1n : value;
};

function merklePath(leaf) {
  const siblings = Array.from({ length: 16 }, () => randomField());
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

const amount = 500n;
const minimumAmount = 100n;
const maximumAmount = 1_000n;
const workflowRoot = randomField();
const environmentLane = 1n;
const executionExpiresAtLedger = BigInt(latestLedger + 720);
const policySalt = randomField();
const executionContextSalt = randomField();
const protocolLeaf = randomField();
const assetLeaf = randomField();
const recipientLeaf = randomField();
const ownerSecret = randomField();
const workflowNonce = 0n;
const protocol = merklePath(protocolLeaf);
const asset = merklePath(assetLeaf);
const recipient = merklePath(recipientLeaf);
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
const nullifier = hash([ownerSecret, workflowRoot, workflowNonce, policyRoot]);
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

const witness = {
  workflowRoot: workflowRoot.toString(),
  policyRoot,
  protocolRegistryRoot: protocol.root,
  assetRegistryRoot: asset.root,
  recipientPolicyRoot: recipient.root,
  environmentLane: environmentLane.toString(),
  executionExpiresAtLedger: executionExpiresAtLedger.toString(),
  nullifier,
  executionContextCommitment,
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
const publicInputs = [
  witness.workflowRoot,
  witness.policyRoot,
  witness.protocolRegistryRoot,
  witness.assetRegistryRoot,
  witness.recipientPolicyRoot,
  witness.environmentLane,
  witness.executionExpiresAtLedger,
  witness.nullifier,
  witness.executionContextCommitment,
];

writeFileSync(new URL("smoke-witness.json", outputDirectory), `${JSON.stringify(witness)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
writeFileSync(
  new URL("smoke-public-metadata.json", outputDirectory),
  `${JSON.stringify({
    schemaVersion: "kletia_policy_testnet_smoke_v1",
    latestLedger,
    executionExpiresAtLedger: Number(executionExpiresAtLedger),
    receiptCloseByLedger: latestLedger + 1_440,
    retentionFloorLedger: latestLedger + 241_920,
    publicInputs,
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

console.log(
  `Prepared Testnet smoke witness for ledger ${latestLedger}; expiry ${executionExpiresAtLedger}.`,
);
