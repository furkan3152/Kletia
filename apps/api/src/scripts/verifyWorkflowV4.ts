import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { capabilityEdgesV4, networkRolesV4 } from "../cross-chain/v4/capabilityGraph.js";
import {
  compileWorkflowPlanV4,
  derivePolicyOptionsV4,
  interpretIntentV4,
  policyAssetIdV4,
} from "../cross-chain/v4/compiler.js";
import { sha256V4 } from "../cross-chain/v4/canonical.js";
import { policyProfileSigningMessageV1 } from "../cross-chain/v4/policy.js";
import {
  assetRegistryRootV4,
  protocolRegistryRootV4,
  recipientRegistryRootV4,
} from "../cross-chain/v4/policyMerkle.js";
import type { PolicyProfileCoreV1 } from "../cross-chain/v4/types.js";
import { ASSETS_V3 } from "../cross-chain/v3/chains.js";
import { deriveRouteBoundWorkflowRootV3 } from "../cross-chain/v3/compiler.js";
import { workflowPlanV3Hash } from "../cross-chain/v3/compiler.js";
import {
  hydrateWorkflowRouteV3,
  type WorkflowRouteHydrationDependenciesV3,
} from "../cross-chain/v3/executionAdapter.js";
import {
  selectedPolicyLeavesV4,
  verifyAndBindPolicyProofV4,
} from "../cross-chain/v4/policyProof.js";
import {
  bindReviewedWorkflowV2ExecutorV4,
  type WorkflowExecutionHandoffDependenciesV4,
} from "../cross-chain/v4/executionHandoff.js";
import { synchronizeWorkflowExecutionV4 } from "../cross-chain/v4/executionSync.js";

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const stellar = Keypair.random();
const COMMITMENT = `0x${"11".repeat(32)}` as const;
const privacyBudget = {
  defaultLevel: "device_only",
  fields: { amount: "public_execution", wallet_identity: "selected_provider" },
  approvedProviders: ["kletia_api"],
  aiMode: "deterministic_only",
  ledgerMode: "public",
} as const;
const now = Date.now();
const policyCore: PolicyProfileCoreV1 = {
  schemaVersion: "kletia_policy_profile_core_v1",
  policyId: "policy_base_swap_01",
  owner: { family: "stellar", network: "public", address: stellar.publicKey() },
  lane: "production",
  allowedChains: ["base_mainnet", "stellar_mainnet"],
  allowedProtocols: ["base-reviewed-defi"],
  allowedAssets: [
    policyAssetIdV4(ASSETS_V3.base_usdc),
    policyAssetIdV4(ASSETS_V3.base_eth),
  ],
  allowedRouteProtocolSets: [["base-reviewed-defi"]],
  allowedRouteAssetSets: [[
    policyAssetIdV4(ASSETS_V3.base_eth),
    policyAssetIdV4(ASSETS_V3.base_usdc),
  ].sort()],
  policyCircuit: "kletia_policy_v2",
  verifierVersion: 2,
  publicInputCount: 12,
  policyRoot: `0x${"22".repeat(32)}`,
  protocolRegistryRoot: protocolRegistryRootV4([["base-reviewed-defi"]]),
  assetRegistryRoot: assetRegistryRootV4([[
    policyAssetIdV4(ASSETS_V3.base_eth),
    policyAssetIdV4(ASSETS_V3.base_usdc),
  ].sort()]),
  recipientPolicyRoot: recipientRegistryRootV4([{
    mode: "execution_wallet",
    wallet: { family: "evm", chainId: 8453, address: EVM_WALLET },
  }]),
  privacyBudgetCommitment: sha256V4("KLETIA_PRIVACY_BUDGET_V4", {
    schemaVersion: "kletia_privacy_budget_v3",
    ...privacyBudget,
    failClosed: true,
  }),
  risk: {
    tolerance: "balanced",
    minimumHealthFactor: "1.6",
    maximumSlippageBps: 100,
  },
  executionExpiresAtLedger: 9_999_999,
  validFrom: now - 1_000,
  expiresAt: now + 60 * 60_000,
  nonce: `0x${"33".repeat(32)}`,
  requireStellarControlPlane: true,
  perFinancialStepWalletApproval: true,
  solverMayCustodyUserFunds: false,
};
const policyProfile = {
  schemaVersion: "kletia_policy_profile_v1",
  core: policyCore,
  profileHash: sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", policyCore),
  authorization: {
    scheme: "stellar_sep53",
    signer: policyCore.owner,
    signature: Buffer.from(
      await stellar.signMessage(policyProfileSigningMessageV1(policyCore)),
    ).toString("base64"),
  },
} as const;

const baseSwap = {
  semanticGoal: "Swap my private://amount budget on Base through a reviewed route.",
  lane: "production",
  legs: [{ operation: "swap", chain: "base_mainnet", assetIn: "USDC", assetOut: "ETH" }],
  walletBindings: {
    base_mainnet: EVM_WALLET,
    stellar_mainnet: stellar.publicKey(),
  },
  privateBindings: [{
    field: "amount",
    reference: "private://amount",
    commitment: COMMITMENT,
    disclosureLevel: "public_execution",
  }],
  privacyBudget,
  risk: { tolerance: "balanced", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
  policyProfile,
} as const;

const policyOptions = derivePolicyOptionsV4({ ...baseSwap, policyProfile: undefined });
assert.equal(policyOptions.schemaVersion, "kletia_policy_options_v1");
assert.deepEqual(policyOptions.allowedRouteProtocolSets, [["base-reviewed-defi"]]);
assert.deepEqual(policyOptions.allowedRouteAssetSets, policyCore.allowedRouteAssetSets);
assert.equal(policyOptions.recipientMaterials[0]?.mode, "execution_wallet");
assert.equal(policyOptions.privacyBudgetCommitment, policyCore.privacyBudgetCommitment);

const plan = await compileWorkflowPlanV4(baseSwap, { liveControlPlaneReady: false });
assert.equal(plan.version, 4);
assert.equal(plan.policy.verified, true);
assert.equal(plan.policy.constraintsAppliedBeforeRouteSelection, true);
assert.equal(plan.controlPlane.requiredForEveryFinancialIntent, true);
assert.equal(plan.controlPlane.network, "stellar_mainnet");
assert.equal(plan.controlPlane.ready, false);
assert.equal(plan.executionGate.status, "control_plane_unavailable");
assert.equal(plan.executionGate.signable, false);
assert.equal(plan.compatibility.v3ExecutionTokenExposed, false);
assert.equal(plan.privacy.rawPrivateFieldsReceivedByAi, false);
assert.equal(plan.privacy.rawPrivateFieldsReceivedByApi, false);
assert.equal(plan.evidencePolicy.transactionHashAloneIsSuccess, false);
assert.equal(plan.policy.proofBinding.status, "device_proof_required");

await assert.rejects(
  compileWorkflowPlanV4({ ...baseSwap, policyProfile: undefined }),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, "POLICY_PROFILE_REQUIRED");
    return true;
  },
);
await assert.rejects(
  compileWorkflowPlanV4({
    ...baseSwap,
    policyProfile: {
      ...policyProfile,
      authorization: { ...policyProfile.authorization, signature: Buffer.alloc(64).toString("base64") },
    },
  }),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, "POLICY_SIGNATURE_INVALID");
    return true;
  },
);
await assert.rejects(
  compileWorkflowPlanV4({ ...baseSwap, semanticGoal: "Swap 1 USDC on Base." }),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, "INTENT_V4_PRIVATE_FIELD_EGRESS_BLOCKED");
    return true;
  },
);

const readOnly = await compileWorkflowPlanV4({
  semanticGoal: "Calculate my reviewed Aave borrow capacity using a conservative buffer.",
  lane: "testnet",
  legs: [{
    operation: "borrow_capacity",
    chain: "arbitrum_sepolia",
    protocol: "aave-v3-arbitrum-sepolia",
    assetIn: "USDC",
  }],
  walletBindings: { arbitrum_sepolia: EVM_WALLET },
  privacyBudget: {
    defaultLevel: "device_only",
    fields: { wallet_identity: "selected_provider", balance: "selected_provider" },
    approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
  },
  risk: { minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
});
assert.equal(readOnly.policy.required, false);
assert.equal(readOnly.executionGate.status, "read_only");
assert.equal(readOnly.executionGate.signable, false);

const interpretation = interpretIntentV4({
  requestId: "6f9635dc-8d90-4c40-a939-2809bd74a8a5",
  semanticGoal: "Bridge private://amount through the selected testnet route.",
  lane: "testnet",
});
assert.deepEqual(interpretation.privateReferences, ["private://amount"]);
assert.equal(interpretation.rawPrivateFieldsReceivedByApi, false);
assert.equal(interpretation.questions.some((question) => question.field === "route_graph"), true);

const edges = capabilityEdgesV4();
const arcToStellar = edges.find((edge) => edge.id === "bridge:arc_testnet:stellar_testnet:circle-cctp-v2");
assert.equal(arcToStellar?.exactBinding, "reviewed_v2");
assert.equal(arcToStellar?.stages.execute, "legacy_only");
const reverseAcross = edges.find((edge) => edge.id === "bridge:arbitrum_one:base_mainnet:across-swap-api");
assert.equal(reverseAcross?.stages.execute, "unavailable");
assert.equal(reverseAcross?.stages.quote, "adapter_required");
assert.equal(edges.every((edge) => edge.mockDataAllowed === false), true);
const arcDefi = edges.find((edge) => edge.id === "local:arc_testnet:kletia-arc-defi");
assert.equal(arcDefi?.stages.execute, "legacy_only");
assert.equal(arcDefi?.operations.includes("lending_borrow"), true);
const arcAgentRegistry = edges.find((edge) => edge.id === "local:arc_testnet:kletia-agent-registry");
assert.equal(arcAgentRegistry?.stages.execute, "unavailable");
assert.match(arcAgentRegistry?.limitations.join(" ") ?? "", /not presented as ERC-8004 or ERC-8183/u);

const roles = networkRolesV4();
assert.equal(
  roles.find((role) => role.chain === "stellar_testnet")?.role,
  "intent_control_policy_receipt_center",
);
assert.equal(
  roles.find((role) => role.chain === "arc_testnet")?.role,
  "stablecoin_agent_hub",
);

const selectedRouteId = plan.selectedRouteId;
assert.ok(selectedRouteId);
const leaves = selectedPolicyLeavesV4(plan, selectedRouteId);
const workflowRoot = deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, selectedRouteId);
const proofEnvelope = {
  schemaVersion: "kletia_policy_proof_envelope_v2",
  routeId: selectedRouteId,
  workflowRoot,
  policyRoot: policyCore.policyRoot,
  protocolRegistryRoot: policyCore.protocolRegistryRoot,
  assetRegistryRoot: policyCore.assetRegistryRoot,
  recipientPolicyRoot: policyCore.recipientPolicyRoot,
  ...leaves,
  environmentLane: 0,
  executionExpiresAtLedger: 9_999_999,
  nullifier: `0x${"26".repeat(32)}`,
  executionContextCommitment: `0x${"27".repeat(32)}`,
  verifierVersion: 2,
  proof: `0x${"31".repeat(256)}`,
} as const;
const boundProof = await verifyAndBindPolicyProofV4(plan, proofEnvelope, {
  verify: async ({ publicInputs, verifierVersion }) => ({
    accepted: publicInputs.length === 12 && verifierVersion === 2,
    observedAtLedger: "123456",
  }),
});
assert.equal(boundProof.plan.policy.proofBinding.status, "bound");
assert.equal(boundProof.plan.policy.proofBinding.verifierVersion, 2);
assert.equal(boundProof.evidence.proofPersisted, false);
assert.equal(boundProof.evidence.externalExecutionTruthProven, false);

const liveControlPlaneId = StrKey.encodeContract(Buffer.alloc(32, 7));
const livePlan = await compileWorkflowPlanV4(baseSwap, {
  liveControlPlaneReady: true,
  controlPlaneContractId: liveControlPlaneId,
});
assert.equal(livePlan.controlPlane.ready, true);
assert.equal(livePlan.controlPlane.contractId, liveControlPlaneId);
assert.equal(livePlan.controlPlane.commitment.status, "awaiting_policy_proof");
const liveRouteId = livePlan.selectedRouteId;
assert.ok(liveRouteId);
const liveProofEnvelope = {
  ...proofEnvelope,
  routeId: liveRouteId,
  workflowRoot: deriveRouteBoundWorkflowRootV3(livePlan.compatibility.plan, liveRouteId),
  ...selectedPolicyLeavesV4(livePlan, liveRouteId),
};
const liveBoundProof = await verifyAndBindPolicyProofV4(livePlan, liveProofEnvelope, {
  verify: async () => ({ accepted: true, observedAtLedger: "123456" }),
});
assert.equal(liveBoundProof.plan.controlPlane.commitment.status, "awaiting_signature");
assert.equal(liveBoundProof.plan.executionGate.status, "control_plane_commit_required");
assert.equal(liveBoundProof.plan.executionGate.signable, true);
assert.equal(liveBoundProof.plan.policy.proofBinding.nullifier, liveProofEnvelope.nullifier);
assert.equal(
  liveBoundProof.plan.policy.proofBinding.executionContextCommitment,
  liveProofEnvelope.executionContextCommitment,
);

const hydrationAmount = "5";
const hydrationSalt = `0x${"44".repeat(32)}` as const;
const hydrationCommitment = `0x${createHash("sha256")
  .update(["KLETIA_PRIVATE_FIELD_V1", "stellar:testnet", "amount", hydrationAmount, hydrationSalt].join("\u001f"))
  .digest("hex")}` as const;
const recipientSalt = `0x${"45".repeat(32)}` as const;
const recipientCommitment = `0x${createHash("sha256")
  .update(["KLETIA_PRIVATE_FIELD_V1", "stellar:testnet", "recipient", EVM_WALLET, recipientSalt].join("\u001f"))
  .digest("hex")}` as const;
const testnetBudget = {
  defaultLevel: "device_only",
  fields: {
    amount: "public_execution",
    recipient: "public_execution",
    route: "public_execution",
    timing: "public_execution",
    wallet_identity: "selected_provider",
    balance: "selected_provider",
    strategy: "selected_provider",
  },
  approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc", "stellar_rpc"],
  aiMode: "deterministic_only",
  ledgerMode: "public",
} as const;
const testnetIntentBase = {
  requestId: "4d2d4e71-a696-4bf8-9e95-27a56abf3dd7",
  preferredRouteId: "arc-arbitrum-direct-cctp",
  semanticGoal: "Move my private://workflow_amount Arc USDC budget to Arbitrum Sepolia, supply it to reviewed Aave, and calculate borrow capacity without borrowing.",
  lane: "testnet",
  coordinationMode: "direct",
  minimumEvidenceLevel: "protocol_verified",
  legs: [
    { operation: "bridge", chain: "arc_testnet", protocol: "circle-cctp-v2", assetIn: "USDC", assetOut: "USDC" },
    { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" },
    { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" },
  ],
  walletBindings: {
    arc_testnet: EVM_WALLET,
    stellar_testnet: stellar.publicKey(),
    arbitrum_sepolia: EVM_WALLET,
  },
  privateBindings: [
    { field: "amount", reference: "private://workflow_amount", commitment: hydrationCommitment, disclosureLevel: "public_execution" },
    { field: "recipient", reference: "private://workflow_recipient", commitment: recipientCommitment, disclosureLevel: "public_execution" },
  ],
  privacyBudget: testnetBudget,
  risk: { tolerance: "conservative", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
} as const;
const testnetOptions = derivePolicyOptionsV4(testnetIntentBase);
const testnetAllowedProtocols = [...new Set(testnetOptions.allowedProtocols)];
const testnetAllowedAssets = [...new Set(testnetOptions.allowedAssets)];
const testnetPolicyCore: PolicyProfileCoreV1 = {
  schemaVersion: "kletia_policy_profile_core_v1",
  policyId: "policy_arc_aave_01",
  owner: { family: "stellar", network: "testnet", address: stellar.publicKey() },
  lane: "testnet",
  allowedChains: ["arc_testnet", "stellar_testnet", "arbitrum_sepolia"],
  allowedProtocols: testnetAllowedProtocols,
  allowedAssets: testnetAllowedAssets,
  allowedRouteProtocolSets: testnetOptions.allowedRouteProtocolSets,
  allowedRouteAssetSets: testnetOptions.allowedRouteAssetSets,
  policyCircuit: "kletia_policy_v2",
  verifierVersion: 2,
  publicInputCount: 12,
  policyRoot: `0x${"28".repeat(32)}`,
  protocolRegistryRoot: protocolRegistryRootV4(testnetOptions.allowedRouteProtocolSets),
  assetRegistryRoot: assetRegistryRootV4(testnetOptions.allowedRouteAssetSets),
  recipientPolicyRoot: recipientRegistryRootV4(testnetOptions.recipientMaterials),
  privacyBudgetCommitment: testnetOptions.privacyBudgetCommitment,
  risk: { tolerance: "conservative", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
  executionExpiresAtLedger: 9_999_999,
  validFrom: now - 1_000,
  expiresAt: now + 60 * 60_000,
  nonce: `0x${"46".repeat(32)}`,
  requireStellarControlPlane: true,
  perFinancialStepWalletApproval: true,
  solverMayCustodyUserFunds: false,
};
const testnetProfile = {
  schemaVersion: "kletia_policy_profile_v1",
  core: testnetPolicyCore,
  profileHash: sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", testnetPolicyCore),
  authorization: {
    scheme: "stellar_sep53",
    signer: testnetPolicyCore.owner,
    signature: Buffer.from(await stellar.signMessage(policyProfileSigningMessageV1(testnetPolicyCore))).toString("base64"),
  },
} as const;
const canonicalTestnet = await compileWorkflowPlanV4(
  { ...testnetIntentBase, policyProfile: testnetProfile },
  { liveControlPlaneReady: true, controlPlaneContractId: liveControlPlaneId },
);
assert.equal(canonicalTestnet.routes[0]?.steps[0]?.operation, "approve");
assert.equal(canonicalTestnet.routes[0]?.steps.some((step) => step.operation === "receipt_registry_commit"), false);
const canonicalRouteId = canonicalTestnet.selectedRouteId!;
const canonicalLeaves = selectedPolicyLeavesV4(canonicalTestnet, canonicalRouteId);
const canonicalProof = {
  schemaVersion: "kletia_policy_proof_envelope_v2",
  routeId: canonicalRouteId,
  workflowRoot: deriveRouteBoundWorkflowRootV3(canonicalTestnet.compatibility.plan, canonicalRouteId),
  policyRoot: testnetPolicyCore.policyRoot,
  protocolRegistryRoot: testnetPolicyCore.protocolRegistryRoot,
  assetRegistryRoot: testnetPolicyCore.assetRegistryRoot,
  recipientPolicyRoot: testnetPolicyCore.recipientPolicyRoot,
  ...canonicalLeaves,
  environmentLane: 1,
  executionExpiresAtLedger: testnetPolicyCore.executionExpiresAtLedger,
  nullifier: `0x${"01".padStart(64, "0")}`,
  executionContextCommitment: `0x${"02".padStart(64, "0")}`,
  verifierVersion: 2,
  proof: `0x${"49".repeat(256)}`,
} as const;
const canonicalBound = await verifyAndBindPolicyProofV4(canonicalTestnet, canonicalProof, {
  verify: async () => ({ accepted: true, observedAtLedger: "123456" }),
});
const committedCanonical = {
  ...canonicalBound.plan,
  controlPlane: {
    ...canonicalBound.plan.controlPlane,
    commitment: {
      status: "confirmed" as const,
      transactionHash: "50".repeat(32),
      nonce: "7",
      committedAtLedger: "123457",
      receiptCloseByLedger: 9_999_999 + 720,
      retentionFloorLedger: 9_999_999 + 1_440,
    },
  },
  executionGate: {
    signable: false,
    status: "exact_adapter_required" as const,
    reasons: ["Test fixture committed."],
  },
};
const hydrationDependencies = {
  readRouteMetrics: async () => ({
    direct: {
      observedAt: "2026-08-24T00:00:00.000Z",
      quoteExpiresAt: Date.now() + 60_000,
      cctpStandardFeeBps: 10,
      cctpHops: 1 as const,
      cctpLegs: [{ sourceDomain: 26 as const, destinationDomain: 3 as const, standardFeeBps: 10 }],
      aaveSupplyApyBps: 325,
      sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
    },
  }),
  readBorrowCapacity: async () => ({ supplyApyBps: 325 }),
  readArcBalance: async () => 10_000_000n,
  readArcAllowance: async () => 0n,
  readArcBlock: async () => 123_456n,
  assertAuctionNotOpened: async () => undefined,
  now: () => new Date("2026-08-24T00:00:00.000Z"),
} as unknown as WorkflowRouteHydrationDependenciesV3;
const hydratedCompatibility = await hydrateWorkflowRouteV3(committedCanonical.compatibility.plan, {
  routeId: canonicalRouteId,
  amount: hydrationAmount,
  amountSalt: hydrationSalt,
  acknowledgePublicExecution: true,
}, hydrationDependencies);
assert.equal(
  deriveRouteBoundWorkflowRootV3(hydratedCompatibility.plan, canonicalRouteId),
  canonicalProof.workflowRoot,
);
const hydratedCanonical = {
  ...committedCanonical,
  routes: hydratedCompatibility.plan.routes,
  compatibility: {
    ...committedCanonical.compatibility,
    planHash: workflowPlanV3Hash(hydratedCompatibility.plan),
    plan: hydratedCompatibility.plan,
  },
};
const handoffDependencies = {
  readBorrowCapacity: async () => ({ supplyApyBps: 325 }),
  readRouteMetrics: hydrationDependencies.readRouteMetrics,
} as unknown as WorkflowExecutionHandoffDependenciesV4;
const canonicalHandoff = await bindReviewedWorkflowV2ExecutorV4(hydratedCanonical, handoffDependencies);
assert.equal(canonicalHandoff.plan.executionHandoff.status, "bound");
assert.equal(canonicalHandoff.handoff.workflowPlan.parentWorkflowV4?.workflowId, hydratedCanonical.workflowId);
assert.equal(
  canonicalHandoff.handoff.workflowPlan.parentWorkflowV4?.policyProofPublicInputsHash,
  hydratedCanonical.policy.proofBinding.publicInputsHash,
);
assert.equal(canonicalHandoff.handoff.workflowPlan.parentWorkflowV3, undefined);
const initialSync = synchronizeWorkflowExecutionV4(canonicalHandoff.plan, canonicalHandoff.handoff.workflowToken);
assert.equal(initialSync.plan.executionHandoff.progressStatus, "not_started");
assert.equal(initialSync.plan.executionHandoff.confirmedCheckpointCount, 0);
await assert.rejects(
  bindReviewedWorkflowV2ExecutorV4(canonicalHandoff.plan, handoffDependencies),
  (error: unknown) => (error as { code?: unknown }).code === "WORKFLOW_V4_EXECUTOR_HANDOFF_NOT_READY",
);
await assert.rejects(
  verifyAndBindPolicyProofV4(plan, {
    ...proofEnvelope,
    selectedProtocolLeaf: `0x${"29".repeat(32)}`,
  }, {
    verify: async () => ({ accepted: true, observedAtLedger: "123456" }),
  }),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, "WORKFLOW_V4_POLICY_PUBLIC_INPUT_MISMATCH");
    return true;
  },
);

const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
assert.equal(digest.length, 64);

console.log("Workflow V4 checks passed.");
