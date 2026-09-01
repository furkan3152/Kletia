import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { STELLAR_TESTNET } from "../networks/stellar/config.js";
import { protocolCapabilitiesV3 } from "../cross-chain/v3/capabilities.js";
import {
  compileWorkflowPlanV3,
  deriveRouteBoundWorkflowRootV3,
} from "../cross-chain/v3/compiler.js";
import {
  applyWorkflowLiveReadV3,
  executeWorkflowLiveReadV3,
  type WorkflowV3LiveReadDependencies,
} from "../cross-chain/v3/liveReads.js";
import {
  readStellarControlPlaneReadiness,
  STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256,
} from "../networks/stellar/controlPlaneReadiness.js";
import {
  derivePolicyRegistryRootsV3,
  derivePolicyRegistryRootsFromMaterialV3,
  verifyAndBindPolicyProofV3,
} from "../cross-chain/v3/policyProof.js";
import {
  hydrateWorkflowRouteV3,
  type WorkflowRouteHydrationDependenciesV3,
} from "../cross-chain/v3/executionAdapter.js";
import {
  bindReviewedWorkflowV2ExecutorV3,
  type WorkflowExecutionHandoffDependenciesV3,
} from "../cross-chain/v3/executionHandoff.js";
import { openWorkflowPlanV2 } from "../cross-chain/v2/compiler.js";
import { isWorkflowExpirySafeRecoveryActionV2 } from "../cross-chain/v2/advance.js";
import {
  isReferenceSolverRouteEligible,
  referenceSolverNetworkCliArgs,
} from "../networks/stellar/referenceSolverPolicy.js";

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const COMMITMENT = `0x${"11".repeat(32)}`;
const SOURCE_REQUEST_ID = "6f9635dc-8d90-4c40-a939-2809bd74a8a5";
const SOURCE_WORKFLOW_ID = "7c8bc054-9316-4b83-8c67-a653f10332af";
const SOURCE_PLAN_CORE = `0x${"33".repeat(32)}`;
const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

assert.equal(
  isReferenceSolverRouteEligible({
    id: "arc-arbitrum-direct-cctp",
    protocols: ["circle-cctp-v2", "aave-v3-arbitrum-sepolia"],
    routeHash: `0x${"11".repeat(32)}`,
    quoteEvidenceHash: `0x${"22".repeat(32)}`,
  }),
  true,
  "The reference solver allowlist must accept the exact protocol IDs emitted by Workflow V3.",
);
assert.deepEqual(
  referenceSolverNetworkCliArgs({
    rpcUrl: STELLAR_TESTNET.rpcUrl,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  }),
  [
    "--rpc-url",
    `${STELLAR_TESTNET.rpcUrl}/`,
    "--network-passphrase",
    STELLAR_TESTNET.networkPassphrase,
  ],
  "The worker must not let a cwd-local .env silently override the exact Stellar network binding.",
);
assert.throws(
  () => referenceSolverNetworkCliArgs({
    rpcUrl: "http://127.0.0.1:8000",
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  }),
  /exact HTTPS RPC/u,
);
assert.equal(
  isReferenceSolverRouteEligible({
    id: "arc-arbitrum-direct-cctp",
    protocols: ["circle-cctp-v2", "aave-v3"],
    routeHash: `0x${"11".repeat(32)}`,
    quoteEvidenceHash: `0x${"22".repeat(32)}`,
  }),
  false,
  "A generic protocol alias must not bypass the chain-specific solver allowlist.",
);

assert.deepEqual(
  derivePolicyRegistryRootsFromMaterialV3({
    routeId: "arc-arbitrum-direct-cctp",
    solverRouteHash: `0x${"11".repeat(32)}`,
    recipient: EVM_WALLET,
  }),
  {
    protocolRegistryRoot: "0x0576734ae54ff40f0697ffe315be4cd9ec855837ff7018116591860e0159280e",
    assetRegistryRoot: "0x049b33a3927f8a518896a8238dc1480caec637596c5fecdfe83e8db8a18ff07a",
    recipientPolicyRoot: "0x1e9e77111b85c0eff8c5d76468483130d699ec80598c8927873cf0ca3f482de5",
  },
);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("cctp_attestation"), true);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("cctp_mint"), true);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("borrow_capacity"), true);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("stellar_receipt_finalize"), true);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("cctp_burn"), false);
assert.equal(isWorkflowExpirySafeRecoveryActionV2("aave_supply"), false);

function expectCode(code: string, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  });
}

const baseSwap = {
  semanticGoal: "Swap my protected budget on Base using a reviewed route.",
  legs: [
    {
      operation: "swap",
      chain: "base_mainnet",
      assetIn: "USDC",
      assetOut: "ETH",
    },
  ],
  walletBindings: { base_mainnet: EVM_WALLET },
  privateBindings: [
    {
      field: "amount",
      reference: "private://amount",
      commitment: COMMITMENT,
      disclosureLevel: "public_execution",
    },
  ],
  privacyBudget: {
    defaultLevel: "device_only",
    fields: { amount: "public_execution", wallet_identity: "selected_provider" },
    approvedProviders: ["kletia_api"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
  },
  risk: { maximumSlippageBps: 100 },
} as const;

const localPlan = compileWorkflowPlanV3(baseSwap);
assert.equal(localPlan.controlPlane.required, false);
assert.equal(localPlan.controlPlane.mode, "local_manifest");
assert.ok(BigInt(localPlan.controlPlane.workflowRoot) > 0n);
assert.ok(BigInt(localPlan.controlPlane.workflowRoot) < BN254_SCALAR_FIELD_MODULUS);
assert.equal(localPlan.controlPlane.policyRoot, null);
assert.equal(localPlan.controlPlane.nullifier, null);
assert.equal(localPlan.controlPlane.proofBinding.status, "not_required");
assert.equal(localPlan.controlPlane.commitment.status, "not_required");
assert.equal(localPlan.controlPlane.receiptRegistry.status, "not_required");
assert.equal(localPlan.lane, "production");
assert.equal(localPlan.privacy.aiReceivedRawPrivateFields, false);
assert.equal(localPlan.executionPolicy.environmentMixingAllowed, false);
assert.equal(localPlan.executionPolicy.silentRetryAllowed, false);
assert.equal(localPlan.routes[0]?.available, false);
assert.match(localPlan.routes[0]?.unavailableReason ?? "", /V3 exact-call hydrator/u);

const unresolvedSwap = compileWorkflowPlanV3({
  ...baseSwap,
  semanticGoal: "Swap my protected budget after asking me which output asset I want.",
  legs: [{ operation: "swap", chain: "base_mainnet", assetIn: "USDC" }],
});
assert.equal(unresolvedSwap.selectedRouteId, null);
assert.equal(unresolvedSwap.intent.unresolved.some((entry) => entry.field === "legs.0.assetOut"), true);
assert.match(unresolvedSwap.routes[0]?.unavailableReason ?? "", /legs\.0\.assetOut/u);

expectCode("PRIVATE_FIELD_EGRESS_BLOCKED", () =>
  compileWorkflowPlanV3({ ...baseSwap, amount: "1.00" }),
);
expectCode("SEMANTIC_GOAL_CONTAINS_AMOUNT", () =>
  compileWorkflowPlanV3({ ...baseSwap, semanticGoal: "Swap 1 USDC on Base." }),
);
expectCode("PRIVACY_BUDGET_WALLET_EGRESS_CONFLICT", () =>
  compileWorkflowPlanV3({
    ...baseSwap,
    privacyBudget: {
      ...baseSwap.privacyBudget,
      fields: { amount: "public_execution", wallet_identity: "device_only" },
    },
  }),
);
expectCode("PRIVACY_BUDGET_PROVIDER_NOT_APPROVED", () =>
  compileWorkflowPlanV3({
    ...baseSwap,
    privacyBudget: {
      ...baseSwap.privacyBudget,
      approvedProviders: [],
    },
  }),
);
expectCode("WORKFLOW_ENVIRONMENT_MIXING_BLOCKED", () =>
  compileWorkflowPlanV3({
    ...baseSwap,
    legs: [
      ...baseSwap.legs,
      {
        operation: "supply",
        chain: "arbitrum_sepolia",
        protocol: "aave-v3-arbitrum-sepolia",
        assetIn: "USDC",
      },
    ],
    walletBindings: {
      base_mainnet: EVM_WALLET,
      arbitrum_sepolia: EVM_WALLET,
    },
  }),
);
expectCode("STELLAR_CONTROL_PLANE_WALLET_REQUIRED", () =>
  compileWorkflowPlanV3({
    ...baseSwap,
    semanticGoal: "Move my protected budget from Base to Arbitrum using reviewed protocols.",
    legs: [
      {
        operation: "bridge",
        chain: "base_mainnet",
        assetIn: "USDC",
        assetOut: "USDC",
      },
      {
        operation: "supply",
        chain: "arbitrum_one",
        assetIn: "USDC",
      },
    ],
    walletBindings: {
      base_mainnet: EVM_WALLET,
      arbitrum_one: EVM_WALLET,
    },
  }),
);

const competitiveCrossChain = compileWorkflowPlanV3({
  ...baseSwap,
  semanticGoal: "Move my protected budget from Base to Arbitrum using competing reviewed routes.",
  coordinationMode: "competitive",
  legs: [
    {
      operation: "bridge",
      chain: "base_mainnet",
      assetIn: "USDC",
      assetOut: "USDC",
    },
    {
      operation: "supply",
      chain: "arbitrum_one",
      assetIn: "USDC",
    },
  ],
  walletBindings: {
    base_mainnet: EVM_WALLET,
    arbitrum_one: EVM_WALLET,
    stellar_mainnet: STELLAR_TESTNET.usdc.issuer,
  },
});
assert.equal(competitiveCrossChain.coordinationMarket.required, true);
assert.equal(
  competitiveCrossChain.coordinationMarket.mode,
  "stellar_commit_reveal_auction",
);
assert.equal(competitiveCrossChain.coordinationMarket.status, "deployment_required");
assert.equal(competitiveCrossChain.coordinationMarket.winner, null);
assert.equal(competitiveCrossChain.selectedRouteId, null);
assert.equal(
  competitiveCrossChain.coordinationMarket.publicDisclosure.commitmentsHideBidTermsUntilReveal,
  true,
);
assert.equal(
  competitiveCrossChain.coordinationMarket.publicDisclosure.revealedBidEconomicsPublic,
  true,
);
assert.equal(
  competitiveCrossChain.privacy.disclosureDiff.some(
    (entry) =>
      entry.stepId === "solver-market-auction" &&
      entry.field === "route" &&
      entry.userApprovalRequired,
  ),
  true,
);
assert.equal(
  competitiveCrossChain.privacy.disclosureDiff.some(
    (entry) =>
      entry.stepId === "solver-market-auction" &&
      entry.field === "amount" &&
      !entry.userApprovalRequired,
  ),
  true,
);
assert.equal(
  competitiveCrossChain.routes.every((route) => /^0x[a-f\d]{64}$/u.test(route.solverRouteHash)),
  true,
);
await assert.rejects(
  verifyAndBindPolicyProofV3(competitiveCrossChain, {}),
  (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "WORKFLOW_V3_AUCTION_WINNER_REQUIRED",
    );
    return true;
  },
);

const automaticCrossChain = compileWorkflowPlanV3({
  ...baseSwap,
  semanticGoal: "Move my protected budget from Base to Arbitrum using reviewed routes.",
  coordinationMode: "automatic",
  legs: [
    {
      operation: "bridge",
      chain: "base_mainnet",
      assetIn: "USDC",
      assetOut: "USDC",
    },
    {
      operation: "supply",
      chain: "arbitrum_one",
      assetIn: "USDC",
    },
  ],
  walletBindings: {
    base_mainnet: EVM_WALLET,
    arbitrum_one: EVM_WALLET,
    stellar_mainnet: STELLAR_TESTNET.usdc.issuer,
  },
});
assert.equal(automaticCrossChain.coordinationMarket.required, false);
assert.equal(automaticCrossChain.coordinationMarket.mode, "direct_adapter");
assert.equal(automaticCrossChain.coordinationMarket.status, "not_required");
assert.equal(
  automaticCrossChain.privacy.disclosureDiff.some(
    (entry) => entry.stepId === "solver-market-auction",
  ),
  false,
);
assert.match(
  automaticCrossChain.coordinationMarket.reasons[0] ?? "",
  /solver auction is opt-in/u,
);

const confidential = compileWorkflowPlanV3({
  ...baseSwap,
  walletBindings: {
    ...baseSwap.walletBindings,
    stellar_mainnet: STELLAR_TESTNET.usdc.issuer,
  },
  privacyBudget: {
    ...baseSwap.privacyBudget,
    ledgerMode: "stellar_confidential_required",
  },
});
assert.equal(confidential.controlPlane.required, true);
assert.equal(confidential.controlPlane.policyRoot, null);
assert.equal(confidential.controlPlane.nullifier, null);
assert.equal(confidential.controlPlane.proofBinding.status, "device_proof_required");
assert.equal(confidential.controlPlane.commitment.status, "device_proof_required");
assert.equal(confidential.controlPlane.receiptRegistry.status, "control_plane_required");
assert.notEqual(
  confidential.controlPlane.planningPolicyCommitment,
  confidential.controlPlane.privacyBudgetCommitment,
);
assert.equal(confidential.selectedRouteId, null);
assert.equal(confidential.routes.every((route) => route.available === false), true);
assert.match(confidential.routes[0]?.unavailableReason ?? "", /confidential ledger/u);
const confidentialOperations = confidential.routes[0]?.steps.map((step) => step.operation) ?? [];
assert.deepEqual(confidentialOperations.slice(0, 2), [
  "control_plane_commit",
  "receipt_registry_commit",
]);
assert.deepEqual(confidentialOperations.slice(-2), [
  "receipt_registry_finalize",
  "control_plane_finalize",
]);
assert.equal(confidential.routes[0]?.steps.at(-1)?.protocol, "kletia-intent-control-plane");
assert.equal(confidential.routes[0]?.steps.at(-2)?.receiptBinding, "workflow_receipt_root");
assert.equal(confidential.routes[0]?.steps.at(-1)?.receiptBinding, "workflow_receipt_root");

const arbitrumSepoliaRead = compileWorkflowPlanV3({
  semanticGoal: "Calculate my reviewed Aave borrow capacity with a conservative risk buffer.",
  legs: [{
    operation: "borrow_capacity",
    chain: "arbitrum_sepolia",
    protocol: "aave-v3-arbitrum-sepolia",
    assetIn: "USDC",
  }],
  walletBindings: { arbitrum_sepolia: EVM_WALLET },
  privacyBudget: {
    defaultLevel: "device_only",
    fields: {
      wallet_identity: "selected_provider",
      balance: "selected_provider",
      strategy: "selected_provider",
    },
    approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
  },
  risk: { minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
});
assert.equal(arbitrumSepoliaRead.routes[0]?.available, true);
assert.equal(arbitrumSepoliaRead.currentStepId, arbitrumSepoliaRead.routes[0]?.steps[0]?.id);
assert.equal(arbitrumSepoliaRead.routes[0]?.steps[0]?.status, "ready");
const readStep = arbitrumSepoliaRead.routes[0]!.steps[0]!;
const liveReadDependencies = {
  readStellarPortfolio: async () => { throw new Error("unexpected Stellar read"); },
  readArbitrumSepoliaPortfolio: async () => { throw new Error("unexpected portfolio read"); },
  readArbitrumSepoliaBorrowCapacity: async (address: unknown) => ({
    schemaVersion: "kletia_arbitrum_sepolia_borrow_capacity_v1",
    network: "arbitrum_sepolia",
    chainId: 421_614,
    userAddress: String(address),
    protocol: "aave-v3",
    asset: "USDC",
    safeAmountAtomic: "750000",
    safeAmount: "0.75",
    capacityStatus: "theoretical_read_only",
    targetHealthFactor: "1.60",
    limitations: ["test vector"],
    currentHealthFactor: "2.00",
    supplyApyBps: 200,
    variableBorrowApyBps: 350,
    reserve: {
      active: true,
      frozen: false,
      borrowingEnabled: true,
      availableLiquidityAtomic: "100000000",
    },
    observedAtBlock: "123456",
    mockData: false,
  }),
  now: () => new Date("2026-08-22T12:00:00.000Z"),
} as unknown as WorkflowV3LiveReadDependencies;
const executedRead = await executeWorkflowLiveReadV3(
  arbitrumSepoliaRead,
  readStep,
  liveReadDependencies,
);
assert.equal(executedRead.evidence.level, "protocol_verified");
assert.match(executedRead.evidence.reference, /block:123456/u);
assert.equal(executedRead.evidence.details?.rawResultPersisted, false);
assert.equal("result" in (executedRead.evidence.details ?? {}), false);
const advancedRead = applyWorkflowLiveReadV3(arbitrumSepoliaRead, readStep.id);
assert.equal(advancedRead.routes[0]?.steps[0]?.status, "confirmed");
assert.equal(advancedRead.currentStepId, null);

const providerBlockedRead = compileWorkflowPlanV3({
  ...arbitrumSepoliaRead.intent,
  semanticGoal: "Calculate my reviewed Aave borrow capacity without an approved RPC disclosure.",
  legs: [{ operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" }],
  walletBindings: { arbitrum_sepolia: EVM_WALLET },
  privacyBudget: {
    ...arbitrumSepoliaRead.privacy.budget,
    approvedProviders: ["kletia_api"],
  },
});
assert.equal(providerBlockedRead.selectedRouteId, null);
assert.match(providerBlockedRead.routes[0]?.unavailableReason ?? "", /arbitrum_sepolia_rpc/u);

const balanceBlockedRead = compileWorkflowPlanV3({
  semanticGoal: "Calculate my reviewed Aave borrow capacity while keeping balances device-only.",
  legs: [{ operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" }],
  walletBindings: { arbitrum_sepolia: EVM_WALLET },
  privacyBudget: {
    defaultLevel: "selected_provider",
    fields: { balance: "device_only" },
    approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
  },
});
assert.equal(balanceBlockedRead.selectedRouteId, null);
assert.match(balanceBlockedRead.routes[0]?.unavailableReason ?? "", /balance/u);

for (const capability of protocolCapabilitiesV3()) {
  assert.equal(capability.mockDataAllowed, false);
  if (capability.executionEnabled) {
    assert.notEqual(capability.deploymentBinding.mode, "discovery_only");
    assert.ok(capability.executionChains && capability.executionChains.length > 0);
    assert.equal(
      capability.executionChains.every((chain) => capability.chains.includes(chain)),
      true,
    );
  }
}

const controlPlaneReadiness = await readStellarControlPlaneReadiness("testnet");
assert.equal(controlPlaneReadiness.provesExternalExecution, false);
if (controlPlaneReadiness.ready) {
  assert.equal(controlPlaneReadiness.status, "ready");
  assert.equal(controlPlaneReadiness.artifactProfile, "testnet_development");
  assert.equal(controlPlaneReadiness.productionReady, false);
} else {
  assert.notEqual(controlPlaneReadiness.status, "ready");
}

const controlPlaneEnvironmentKeys = [
  "STELLAR_INTENT_CONTROL_PLANE_ENABLED",
  "STELLAR_POLICY_VERIFIER_ARTIFACTS_READY",
  "STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE",
  "STELLAR_INTENT_CONTROL_PLANE_TESTNET_CONTRACT_ID",
  "STELLAR_POLICY_RECEIPT_REGISTRY_TESTNET_CONTRACT_ID",
  "STELLAR_POLICY_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID",
  "STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT",
  "STELLAR_POLICY_VERIFIER_VERSION",
  "STELLAR_POLICY_GENERATED_VERIFIER_TESTNET_CONTRACT_ID",
  "STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256",
  "STELLAR_POLICY_VERIFICATION_KEY_SHA256",
] as const;
const previousControlPlaneEnvironment = Object.fromEntries(
  controlPlaneEnvironmentKeys.map((key) => [key, process.env[key]]),
);
try {
  process.env.STELLAR_INTENT_CONTROL_PLANE_ENABLED = "true";
  process.env.STELLAR_POLICY_VERIFIER_ARTIFACTS_READY = "true";
  process.env.STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE = "testnet_development";
  process.env.STELLAR_INTENT_CONTROL_PLANE_TESTNET_CONTRACT_ID =
    STELLAR_TESTNET.cctp.forwarder;
  process.env.STELLAR_POLICY_RECEIPT_REGISTRY_TESTNET_CONTRACT_ID =
    STELLAR_TESTNET.cctp.forwarder;
  process.env.STELLAR_POLICY_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID =
    STELLAR_TESTNET.cctp.forwarder;
  process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT = "";
  process.env.STELLAR_POLICY_VERIFIER_VERSION = "1";
  process.env.STELLAR_POLICY_GENERATED_VERIFIER_TESTNET_CONTRACT_ID =
    STELLAR_TESTNET.cctp.forwarder;
  process.env.STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256 = "11".repeat(32);
  process.env.STELLAR_POLICY_VERIFICATION_KEY_SHA256 = "22".repeat(32);

  // A deploy-last plan may expose the proof-binding transition only when all
  // exact artifacts are configured. The live verifier is dependency-injected
  // here; no transaction, deployment or unsafe test key is used.
  process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT = STELLAR_TESTNET.usdc.issuer;
  process.env.STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256 =
    STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256;
  const proofInput = {
    requestId: SOURCE_REQUEST_ID,
    sourceIntentReceipt: {
      schemaVersion: "kletia_source_intent_receipt_v1",
      engine: "workflow_v2",
      scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
      workflowId: SOURCE_WORKFLOW_ID,
      requestId: SOURCE_REQUEST_ID,
      planCoreSha256: SOURCE_PLAN_CORE,
      selectedRoute: "direct_cctp",
    },
    preferredRouteId: "arc-arbitrum-direct-cctp",
    semanticGoal: "Move my protected Arc budget to Arbitrum Sepolia and supply it to reviewed Aave.",
    coordinationMode: "direct",
    legs: [
      { operation: "bridge", chain: "arc_testnet", assetIn: "USDC", assetOut: "USDC" },
      { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
      { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
    ],
    walletBindings: {
      arc_testnet: EVM_WALLET,
      stellar_testnet: STELLAR_TESTNET.usdc.issuer,
      arbitrum_sepolia: EVM_WALLET,
    },
    privateBindings: [{
      field: "amount",
      reference: "private://amount",
      commitment: COMMITMENT,
      disclosureLevel: "public_execution",
    }],
    privacyBudget: {
      defaultLevel: "device_only",
      fields: { amount: "public_execution", wallet_identity: "selected_provider" },
      approvedProviders: ["kletia_api"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  } as const;
  const proofPlan = compileWorkflowPlanV3(proofInput, { liveControlPlaneReady: true });
  assert.equal(proofPlan.controlPlane.status, "ready");
  assert.equal(proofPlan.requestId, SOURCE_REQUEST_ID);
  assert.equal(proofPlan.intent.sourceIntentReceipt?.workflowId, SOURCE_WORKFLOW_ID);
  assert.equal(proofPlan.intent.sourceIntentReceipt?.planCoreSha256, SOURCE_PLAN_CORE);
  assert.equal(proofPlan.intent.preferredRouteId, "arc-arbitrum-direct-cctp");
  assert.equal(proofPlan.selectedRouteId, "arc-arbitrum-direct-cctp");
  expectCode("SOURCE_INTENT_GRAPH_MISMATCH", () =>
    compileWorkflowPlanV3({
      ...proofInput,
      preferredRouteId: "arc-stellar-arbitrum-cctp",
    }, { liveControlPlaneReady: true }),
  );
  assert.equal(proofPlan.controlPlane.proofBinding.status, "device_proof_required");
  const selectedProofRoute = "arc-arbitrum-direct-cctp";
  const routeBoundRoot = deriveRouteBoundWorkflowRootV3(proofPlan, selectedProofRoute);
  const policyRegistryRoots = derivePolicyRegistryRootsV3(proofPlan, selectedProofRoute);
  await assert.rejects(
    verifyAndBindPolicyProofV3(
      proofPlan,
      {
        schemaVersion: "kletia_policy_proof_envelope_v1",
        routeId: selectedProofRoute,
        workflowRoot: routeBoundRoot,
        policyRoot: `0x${"01".padStart(64, "0")}`,
        protocolRegistryRoot: `0x${"02".padStart(64, "0")}`,
        assetRegistryRoot: policyRegistryRoots.assetRegistryRoot,
        recipientPolicyRoot: policyRegistryRoots.recipientPolicyRoot,
        executionExpiresAtLedger: 10_000,
        nullifier: `0x${"05".padStart(64, "0")}`,
        executionContextCommitment: `0x${"06".padStart(64, "0")}`,
        verifierVersion: 1,
        proof: `0x${"ab".repeat(256)}`,
      },
      {
        verify: async () => {
          throw new Error("A mismatched policy root must be rejected before live verification.");
        },
      },
    ),
    (error: unknown) =>
      (error as { code?: unknown }).code === "WORKFLOW_V3_POLICY_REGISTRY_ROOT_MISMATCH",
  );
  const boundProof = await verifyAndBindPolicyProofV3(
    proofPlan,
    {
      schemaVersion: "kletia_policy_proof_envelope_v1",
      routeId: selectedProofRoute,
      workflowRoot: routeBoundRoot,
      policyRoot: `0x${"01".padStart(64, "0")}`,
      protocolRegistryRoot: policyRegistryRoots.protocolRegistryRoot,
      assetRegistryRoot: policyRegistryRoots.assetRegistryRoot,
      recipientPolicyRoot: policyRegistryRoots.recipientPolicyRoot,
      executionExpiresAtLedger: 10_000,
      nullifier: `0x${"05".padStart(64, "0")}`,
      executionContextCommitment: `0x${"06".padStart(64, "0")}`,
      verifierVersion: 1,
      proof: `0x${"ab".repeat(256)}`,
    },
    {
      verify: async ({ publicInputs, proof, verifierVersion }) => {
        assert.equal(publicInputs.length, 9);
        assert.equal(publicInputs[0], routeBoundRoot);
        assert.equal(publicInputs[5], `0x${"01".padStart(64, "0")}`);
        assert.equal(proof.length, 256);
        assert.equal(verifierVersion, 1);
        return {
          accepted: true,
          observedAtLedger: "777",
          registryContractId: STELLAR_TESTNET.cctp.forwarder,
          verifierContractId: STELLAR_TESTNET.cctp.tokenMessengerMinter,
          verifierVersion: 1,
        };
      },
    },
  );
  assert.equal(boundProof.plan.selectedRouteId, selectedProofRoute);
  assert.equal(boundProof.plan.controlPlane.workflowRoot, routeBoundRoot);
  assert.equal(boundProof.plan.controlPlane.proofBinding.status, "bound");
  assert.equal(boundProof.plan.controlPlane.proofBinding.verifiedAtLedger, "777");
  assert.equal(boundProof.plan.controlPlane.commitment.status, "awaiting_signature");
  assert.equal(boundProof.plan.controlPlane.commitment.owner, null);
  assert.equal(boundProof.plan.controlPlane.commitment.transactionHash, null);
  assert.equal(boundProof.plan.controlPlane.receiptRegistry.status, "control_plane_required");
  assert.equal(boundProof.evidence.proofPersisted, false);
  assert.equal(boundProof.evidence.externalExecutionTruthProven, false);
  assert.equal(JSON.stringify(boundProof.plan).includes("ab".repeat(256)), false);

  await assert.rejects(
    verifyAndBindPolicyProofV3(
      proofPlan,
      {
        schemaVersion: "kletia_policy_proof_envelope_v1",
        routeId: selectedProofRoute,
        workflowRoot: routeBoundRoot,
        policyRoot: `0x${"01".padStart(64, "0")}`,
        protocolRegistryRoot: policyRegistryRoots.protocolRegistryRoot,
        assetRegistryRoot: policyRegistryRoots.assetRegistryRoot,
        recipientPolicyRoot: policyRegistryRoots.recipientPolicyRoot,
        executionExpiresAtLedger: 999_999,
        nullifier: `0x${"05".padStart(64, "0")}`,
        executionContextCommitment: `0x${"06".padStart(64, "0")}`,
        verifierVersion: 1,
        proof: `0x${"ab".repeat(256)}`,
      },
      {
        verify: async () => ({
          accepted: true,
          observedAtLedger: "777",
          registryContractId: STELLAR_TESTNET.cctp.forwarder,
          verifierContractId: STELLAR_TESTNET.cctp.tokenMessengerMinter,
          verifierVersion: 1,
        }),
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "WORKFLOW_V3_POLICY_EXPIRY_OUTSIDE_LIFECYCLE",
  );

  process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT = "";
  process.env.STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256 = "11".repeat(32);
  const flagOnlyReadiness = await readStellarControlPlaneReadiness("testnet");
  assert.equal(flagOnlyReadiness.ready, false);
  assert.equal(flagOnlyReadiness.status, "verifier_artifact_configuration_invalid");
} finally {
  for (const key of controlPlaneEnvironmentKeys) {
    const previous = previousControlPlaneEnvironment[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const hydrationAmount = "5";
const hydrationSalt = `0x${"22".repeat(32)}`;
const hydrationCommitment = `0x${createHash("sha256")
  .update([
    "KLETIA_PRIVATE_FIELD_V1",
    "stellar:testnet",
    "amount",
    hydrationAmount,
    hydrationSalt,
  ].join("\u001f"))
  .digest("hex")}`;
const recipientSalt = `0x${"44".repeat(32)}`;
const recipientCommitment = `0x${createHash("sha256")
  .update([
    "KLETIA_PRIVATE_FIELD_V1",
    "stellar:testnet",
    "recipient",
    EVM_WALLET,
    recipientSalt,
  ].join("\u001f"))
  .digest("hex")}`;
const hydrationDraft = compileWorkflowPlanV3({
  semanticGoal: "Move my protected USDC budget through reviewed CCTP and supply it to Aave.",
  coordinationMode: "direct",
  legs: [
    { operation: "bridge", chain: "arc_testnet", protocol: "circle-cctp-v2", assetIn: "USDC", assetOut: "USDC" },
    { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
    { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
  ],
  walletBindings: {
    arc_testnet: EVM_WALLET,
    stellar_testnet: STELLAR_TESTNET.usdc.issuer,
    arbitrum_sepolia: EVM_WALLET,
  },
  privateBindings: [
    {
      field: "amount",
      reference: "private://workflow_amount",
      commitment: hydrationCommitment,
      disclosureLevel: "public_execution",
    },
    {
      field: "recipient",
      reference: "private://workflow_recipient",
      commitment: recipientCommitment,
      disclosureLevel: "public_execution",
    },
  ],
  privacyBudget: {
    defaultLevel: "device_only",
    fields: {
      amount: "public_execution",
      recipient: "public_execution",
      wallet_identity: "selected_provider",
      balance: "selected_provider",
      strategy: "selected_provider",
      route: "public_execution",
      timing: "public_execution",
    },
    approvedProviders: ["kletia_api", "arc_rpc", "arbitrum_sepolia_rpc"],
    aiMode: "deterministic_only",
    ledgerMode: "public",
  },
  risk: { minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
});
const hydrationPlan = {
  ...hydrationDraft,
  controlPlane: { ...hydrationDraft.controlPlane, status: "ready" as const },
  routes: hydrationDraft.routes.map((route) =>
    route.id === "arc-arbitrum-direct-cctp"
      ? {
          ...route,
          available: true,
          unavailableReason: undefined,
          steps: route.steps.map((step) => ({
            ...step,
            executionReadiness: "ready" as const,
            unavailableReason: undefined,
          })),
        }
      : route,
  ),
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
await assert.rejects(
  hydrateWorkflowRouteV3(
    hydrationPlan,
    {
      routeId: "arc-arbitrum-direct-cctp",
      amount: hydrationAmount,
      amountSalt: hydrationSalt,
      acknowledgePublicExecution: false,
    },
    hydrationDependencies,
  ),
  (error: unknown) => (error as { code?: unknown }).code === "WORKFLOW_V3_PUBLIC_AMOUNT_DISCLOSURE_REQUIRED",
);
await assert.rejects(
  hydrateWorkflowRouteV3(
    hydrationPlan,
    {
      routeId: "arc-arbitrum-direct-cctp",
      amount: hydrationAmount,
      amountSalt: `0x${"33".repeat(32)}`,
      acknowledgePublicExecution: true,
    },
    hydrationDependencies,
  ),
  (error: unknown) => (error as { code?: unknown }).code === "WORKFLOW_V3_AMOUNT_COMMITMENT_MISMATCH",
);
const hydrated = await hydrateWorkflowRouteV3(
  hydrationPlan,
  {
    routeId: "arc-arbitrum-direct-cctp",
    amount: hydrationAmount,
    amountSalt: hydrationSalt,
    acknowledgePublicExecution: true,
  },
  hydrationDependencies,
);
const hydratedRoute = hydrated.plan.routes.find((route) => route.id === "arc-arbitrum-direct-cctp");
assert.equal(hydratedRoute?.hydration?.amountCommitment, hydrationCommitment);
assert.equal(hydratedRoute?.metrics.amountDependentCostsComplete, true);
assert.equal(hydratedRoute?.metrics.estimatedOutputAtomic, "4994000");
assert.equal(hydrated.quote.maximumBridgeFeeAtomic, "6000");
assert.equal(hydrated.quote.standardFeeBps, 10);
assert.equal(hydrated.quote.sourceApprovalRequired, true);
assert.equal(hydrated.evidence.kind, "route_quote");
assert.equal(hydrated.evidence.details?.plaintextAmountFieldPersisted, false);
assert.equal(hydrated.evidence.details?.economicScaleDerivableFromPublicQuote, true);

const executorRoute = hydrated.plan.routes.find(
  (route) => route.id === "arc-arbitrum-direct-cctp",
)!;
const executorSteps = executorRoute.steps.map((step) => {
  if (step.operation === "control_plane_commit" || step.operation === "receipt_registry_commit") {
    return { ...step, status: "confirmed" as const };
  }
  const firstFinancial = executorRoute.steps.find(
    (candidate) =>
      candidate.operation !== "control_plane_commit" &&
      candidate.operation !== "receipt_registry_commit",
  );
  return step.id === firstFinancial?.id
    ? { ...step, status: "awaiting_signature" as const }
    : { ...step, status: "planned" as const };
});
const firstFinancialStep = executorSteps.find(
  (step) => step.status === "awaiting_signature",
)!;
const executorParent = {
  ...hydrated.plan,
  selectedRouteId: executorRoute.id,
  currentStepId: firstFinancialStep.id,
  routes: hydrated.plan.routes.map((route) =>
    route.id === executorRoute.id ? { ...route, steps: executorSteps } : route,
  ),
  controlPlane: {
    ...hydrated.plan.controlPlane,
    policyRoot: `0x${"01".padStart(64, "0")}` as const,
    nullifier: `0x${"02".padStart(64, "0")}` as const,
    proofBinding: {
      ...hydrated.plan.controlPlane.proofBinding,
      status: "bound" as const,
      routeId: executorRoute.id,
      verifierVersion: 1,
      protocolRegistryRoot: `0x${"03".padStart(64, "0")}` as const,
      assetRegistryRoot: `0x${"04".padStart(64, "0")}` as const,
      recipientPolicyRoot: `0x${"05".padStart(64, "0")}` as const,
      executionExpiresAtLedger: 99_999,
      executionContextCommitment: `0x${"06".padStart(64, "0")}` as const,
      publicInputsHash: `0x${"07".repeat(32)}` as const,
      proofSha256: `0x${"08".repeat(32)}` as const,
      verifiedAtLedger: "99",
    },
    commitment: {
      status: "confirmed" as const,
      owner: STELLAR_TESTNET.usdc.issuer,
      nonce: "1",
      transactionHash: "11".repeat(32),
      committedAtLedger: "100",
      receiptCloseByLedger: 100_719,
      retentionFloorLedger: 100_720,
    },
    receiptRegistry: {
      status: "confirmed" as const,
      owner: STELLAR_TESTNET.usdc.issuer,
      nonce: "1",
      transactionHash: "22".repeat(32),
      committedAtLedger: "101",
    },
  },
};
const handoffObservedAt = "2026-08-24T00:00:30.000Z";
const handoffQuoteExpiresAt = Date.now() + 90_000;
await assert.rejects(
  bindReviewedWorkflowV2ExecutorV3(
    executorParent,
    {
      readRouteMetrics: async () => ({
        direct: {
          observedAt: handoffObservedAt,
          quoteExpiresAt: Date.now() - 1,
          cctpStandardFeeBps: 12,
          cctpHops: 1 as const,
          cctpLegs: [{ sourceDomain: 26 as const, destinationDomain: 3 as const, standardFeeBps: 12 }],
          aaveSupplyApyBps: 330,
          sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
        },
      }),
      readBorrowCapacity: async () => ({ supplyApyBps: 330 }),
    } as unknown as WorkflowExecutionHandoffDependenciesV3,
  ),
  (error: unknown) => (error as { code?: unknown }).code === "WORKFLOW_V3_EXECUTOR_QUOTE_STALE",
);
const executorHandoff = await bindReviewedWorkflowV2ExecutorV3(
  executorParent,
  {
    readRouteMetrics: async () => ({
      direct: {
        observedAt: handoffObservedAt,
        quoteExpiresAt: handoffQuoteExpiresAt,
        cctpStandardFeeBps: 12,
        cctpHops: 1 as const,
        cctpLegs: [{ sourceDomain: 26 as const, destinationDomain: 3 as const, standardFeeBps: 12 }],
        aaveSupplyApyBps: 330,
        sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
      },
    }),
    readBorrowCapacity: async () => ({ supplyApyBps: 330 }),
  } as unknown as WorkflowExecutionHandoffDependenciesV3,
);
const openedExecutor = openWorkflowPlanV2(executorHandoff.handoff.workflowToken);
assert.equal(executorHandoff.plan.compatibility?.status, "bound");
assert.equal(executorHandoff.plan.compatibility?.parentPlanHash, executorHandoff.handoff.parentPlanHash);
assert.equal(openedExecutor.parentWorkflowV3?.workflowId, executorParent.workflowId);
assert.equal(openedExecutor.parentWorkflowV3?.expiresAt, executorParent.expiresAt);
assert.equal(openedExecutor.selectedRoute, "direct_cctp");
assert.equal(openedExecutor.privacy.amountCommitment, hydrationCommitment);
assert.equal(openedExecutor.privacy.recipientCommitment, recipientCommitment);
assert.equal(openedExecutor.routeCandidates[0]?.liveEvidence.cctpStandardFeeBps, 12);
assert.equal(openedExecutor.routeCandidates[0]?.liveEvidence.observedAt, handoffObservedAt);
assert.equal(executorHandoff.plan.compatibility?.policyRouteHash, executorRoute.solverRouteHash);
assert.equal(executorHandoff.plan.compatibility?.executionQuoteExpiresAt, handoffQuoteExpiresAt);
assert.equal(openedExecutor.parentWorkflowV3?.externalExecutionTruthProvenByStellar, false);

console.log("Workflow V3 privacy, lane and capability boundaries verified.");
