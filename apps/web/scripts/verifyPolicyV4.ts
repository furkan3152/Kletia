import assert from "node:assert/strict";

import { Keypair } from "@stellar/stellar-sdk";

import { scalarHexV4 } from "../src/cross-chain/v4/canonical";
import {
  createUnsignedPolicyProfileV4,
  policyProfileSigningMessageV4,
  selectLocalPolicyWitnessV4,
} from "../src/cross-chain/v4/policyProfile";
import type { PolicyOptionsV4 } from "../src/cross-chain/v4/types";

const recipient = {
  mode: "execution_wallet",
  wallet: {
    family: "evm",
    chainId: 421614,
    address: "0x1111111111111111111111111111111111111111",
  },
} as const;
const options: PolicyOptionsV4 = {
  schemaVersion: "kletia_policy_options_v1",
  lane: "testnet",
  allowedChains: ["arc_testnet", "arbitrum_sepolia", "stellar_testnet"],
  allowedProtocols: ["aave-v3", "circle-cctp-v2"],
  allowedAssets: [
    "eip155:421614:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    "eip155:5042002:0x3600000000000000000000000000000000000000",
  ],
  allowedRouteProtocolSets: [["aave-v3", "circle-cctp-v2"]],
  allowedRouteAssetSets: [[
    "eip155:421614:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    "eip155:5042002:0x3600000000000000000000000000000000000000",
  ]],
  recipientMaterials: [recipient],
  privacyBudget: {
    schemaVersion: "kletia_privacy_budget_v3",
    defaultLevel: "device_only",
    fields: { amount: "public_execution", recipient: "public_execution" },
    approvedProviders: ["kletia_api"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
    failClosed: true,
  },
  privacyBudgetCommitment: `0x${"11".repeat(32)}`,
  routes: [],
};

const policy = createUnsignedPolicyProfileV4({
  options,
  stellarAddress: Keypair.random().publicKey(),
  minimumAmountAtomic: "100000",
  maximumAmountAtomic: "5000000",
  executionExpiresAtLedger: 9_999_999,
  risk: { tolerance: "conservative", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
});
const selected = selectLocalPolicyWitnessV4({
  witness: policy.localWitness,
  protocolSet: ["circle-cctp-v2", "aave-v3"],
  assetSet: options.allowedRouteAssetSets[0]!,
  recipientMaterial: recipient,
});

assert.equal(selected.protocol.root, policy.localWitness.protocolTree.root);
assert.equal(selected.asset.root, policy.localWitness.assetTree.root);
assert.equal(selected.recipient.root, policy.localWitness.recipientTree.root);
assert.equal(scalarHexV4(selected.protocol.root), policy.core.protocolRegistryRoot);
assert.equal(selected.protocol.siblings.length, 16);
assert.equal(selected.protocol.pathIndices.length, 16);
assert.match(policyProfileSigningMessageV4(policy.core), /^KLETIA_POLICY_PROFILE_V1\nstellar:testnet\n0x/u);
assert.throws(
  () => selectLocalPolicyWitnessV4({
    witness: policy.localWitness,
    protocolSet: ["unreviewed-protocol"],
    assetSet: options.allowedRouteAssetSets[0]!,
    recipientMaterial: recipient,
  }),
  /outside the signed policy registry/u,
);

console.log("Browser Policy V4 profile, sparse Merkle paths and pre-route permission binding passed.");
