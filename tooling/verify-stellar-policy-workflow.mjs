#!/usr/bin/env node

import { readFileSync } from "node:fs";

process.env.STELLAR_MVP_ENABLED = "true";
process.env.WORKFLOW_SIGNING_SECRET =
  "kletia-policy-workflow-verifier-only-32-bytes";

const {
  compileWorkflowPlanV2,
  computeWorkflowPlanCoreSha256,
  openWorkflowPlanV2,
  sealWorkflowPlanV2,
} = await import("../apps/api/dist/cross-chain/v2/compiler.js");
const { findIntentScenario } = await import(
  "../apps/api/dist/cross-chain/v2/intentGrammar.js"
);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const scenario = findIntentScenario(
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
);
if (!scenario) throw new Error("Executable workflow scenario is missing.");

const EVM_ACCOUNT = "0x1111111111111111111111111111111111111111";
const STELLAR_ACCOUNT =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const REGISTRY_CONTRACT =
  "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
const POLICY_COMMITMENT = `0x${"33".repeat(32)}`;
const BUDGET_COMMITMENT = `0x${"44".repeat(32)}`;
const routeMetrics = {
  direct: {
    observedAt: new Date().toISOString(),
    quoteExpiresAt: Date.now() + 60_000,
    cctpStandardFeeBps: 1,
    cctpHops: 1,
    cctpLegs: [{ sourceDomain: 26, destinationDomain: 3, standardFeeBps: 1 }],
    aaveSupplyApyBps: 250,
    sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"],
  },
  stellar: {
    observedAt: new Date().toISOString(),
    quoteExpiresAt: Date.now() + 60_000,
    cctpStandardFeeBps: 2,
    cctpHops: 2,
    cctpLegs: [
      { sourceDomain: 26, destinationDomain: 27, standardFeeBps: 1 },
      { sourceDomain: 27, destinationDomain: 3, standardFeeBps: 1 },
    ],
    aaveSupplyApyBps: 250,
    sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"],
  },
};

const stellarGoal = {
  isComplete: true,
  semanticGoal: "Move the private slot through reviewed public checkpoints.",
  scenarioId: scenario.id,
  scenario,
  toggles: { stellarPolicyCenter: true, includeBorrowCapacity: true },
  sourceNetwork: "arc_testnet",
  destinationNetwork: "arbitrum_sepolia",
  asset: "USDC",
  targetProtocol: "aave_v3",
  targetAction: "supply",
  includeBorrowCapacity: true,
  privateFieldIsolation: true,
  ledgerConfidentialityRequested: false,
  stellarPolicyCenter: true,
};

const common = {
  requestId: "11111111-1111-4111-8111-111111111111",
  amountCommitment: `0x${"11".repeat(32)}`,
  recipientCommitment: `0x${"22".repeat(32)}`,
  arcAddress: EVM_ACCOUNT,
  stellarAddress: STELLAR_ACCOUNT,
  arbitrumSepoliaAddress: EVM_ACCOUNT,
  routeMetrics,
};

const registryPlan = compileWorkflowPlanV2({
  ...common,
  goal: stellarGoal,
  routePreference: "stellar_centered_public",
  policyAnchorMode: "stellar_public_registry",
  policyRegistryCommit: {
    schemaVersion: "kletia_stellar_policy_registry_prepared_commit_v1",
    contractId: REGISTRY_CONTRACT,
    owner: STELLAR_ACCOUNT,
    nonce: "7",
    policyCommitment: POLICY_COMMITMENT,
    privacyBudgetCommitment: BUDGET_COMMITMENT,
    executionExpiresAtLedger: 1_017_280,
    receiptCloseByLedger: 1_120_960,
    retentionFloorLedger: 1_241_920,
    expectedWasmSha256:
      "723d052be3e3f2585050337607fc3c010f18395825bf434693e863a81d27319d",
    stateObservedAtLedger: 1_000_000,
    recordingSimulationLatestLedger: 1_000_001,
    invocationSha256: `0x${"55".repeat(32)}`,
    enforcingSimulationRequiredBeforeSigning: true,
  },
});

expect(
  registryPlan.policyAnchor.mode === "stellar_public_registry" &&
    registryPlan.policyAnchor.policyCommitment === POLICY_COMMITMENT &&
    registryPlan.policyAnchor.privacyBudgetCommitment === BUDGET_COMMITMENT,
  "opaque browser commitments are not bound into the plan core",
);
expect(
  registryPlan.steps[0]?.action === "stellar_policy_commit" &&
    registryPlan.steps.at(-1)?.action !== "stellar_receipt_finalize",
  "commit must precede economic work and finalize must not exist before terminal evidence",
);
expect(
  registryPlan.privacy.boundaryMap.commitmentOpeningSchedule.every(
    (entry) => entry.openingStep === "step-2",
  ),
  "private amount openings were not moved to the first economic step",
);
expect(
  registryPlan.privacy.disclosureDiff.finalKnowledge.some(
    (fact) =>
      fact.field === "workflow_linkage" &&
      fact.observer === "public_ledger:stellar_testnet",
  ),
  "public owner/nonce/workflow linkage is absent from Disclosure Diff",
);
expect(
  registryPlan.authorizationBoundary.planCoreSha256 ===
    computeWorkflowPlanCoreSha256(registryPlan),
  "policy anchor is not covered by the workflow authorization boundary",
);
expect(
  !JSON.stringify(registryPlan).toLowerCase().includes("blind\"") &&
    registryPlan.policyAnchor.commitmentSchemes.rawBlindReceivedByApi === false,
  "raw blinding material crossed the sealed plan boundary",
);
expect(
  openWorkflowPlanV2(sealWorkflowPlanV2(registryPlan)).policyAnchor.mode ===
    "stellar_public_registry",
  "registry plan did not survive authenticated token hydration",
);

const directGoal = {
  ...stellarGoal,
  toggles: { stellarPolicyCenter: false, includeBorrowCapacity: true },
  stellarPolicyCenter: false,
};
const directPlan = compileWorkflowPlanV2({
  ...common,
  goal: directGoal,
  routePreference: "direct_cctp",
});
expect(
  directPlan.policyAnchor.mode === "local_manifest" &&
    directPlan.steps.every(
      (step) => step.binding?.protocol !== "kletia_policy_registry",
    ),
  "the default direct route acquired an implicit Stellar registry dependency",
);

let directRegistryRejected = false;
try {
  compileWorkflowPlanV2({
    ...common,
    goal: directGoal,
    routePreference: "direct_cctp",
    policyAnchorMode: "stellar_public_registry",
    policyRegistryCommit: {
      schemaVersion: "kletia_stellar_policy_registry_prepared_commit_v1",
      contractId: REGISTRY_CONTRACT,
      owner: STELLAR_ACCOUNT,
      nonce: "7",
      policyCommitment: POLICY_COMMITMENT,
      privacyBudgetCommitment: BUDGET_COMMITMENT,
      executionExpiresAtLedger: 1_017_280,
      receiptCloseByLedger: 1_120_960,
      retentionFloorLedger: 1_241_920,
      expectedWasmSha256:
        "723d052be3e3f2585050337607fc3c010f18395825bf434693e863a81d27319d",
      stateObservedAtLedger: 1_000_000,
      recordingSimulationLatestLedger: 1_000_001,
      invocationSha256: `0x${"55".repeat(32)}`,
      enforcingSimulationRequiredBeforeSigning: true,
    },
  });
} catch (error) {
  directRegistryRejected =
    error?.code === "STELLAR_POLICY_REGISTRY_ROUTE_REQUIRED";
}
expect(directRegistryRejected, "a direct route accepted a Stellar public registry anchor");

const advanceSource = readFileSync(
  "apps/api/src/cross-chain/v2/advance.ts",
  "utf8",
);
for (const fragment of [
  "KLETIA_EXECUTION_RECEIPT_ANCHOR_V1",
  "exactRegistryEvent",
  "readStellarPolicyRegistryRecord",
  "externalTruthProvenByRegistry: false",
  'current.action !== "stellar_receipt_finalize"',
]) {
  expect(
    advanceSource.includes(fragment),
    `advance verifier is missing ${fragment}`,
  );
}

if (failures.length > 0) {
  console.error("Stellar public policy workflow verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Stellar optional public policy workflow boundaries passed (no deploy or signing performed).",
);
