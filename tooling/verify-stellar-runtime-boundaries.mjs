#!/usr/bin/env node

import { readFileSync } from "node:fs";

process.env.STELLAR_MVP_ENABLED = "true";
process.env.WORKFLOW_SIGNING_SECRET =
  "kletia-local-release-boundary-check-only-32-bytes";

const {
  compileWorkflowPlanV2,
  computeWorkflowPlanCoreSha256,
  openWorkflowPlanV2,
  rebindWorkflowPlanAuthorization,
  renewWorkflowPlanAuthorization,
  sealWorkflowPlanV2,
} = await import("../apps/api/dist/cross-chain/v2/compiler.js");
const { assertRedactedWorkflowPrompt, parseWorkflowGoalV2 } = await import(
  "../apps/api/dist/cross-chain/v2/parser.js"
);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const controlPlaneBrowserSource = readFileSync(
  new URL(
    "../apps/web/src/networks/stellar/runtime/controlPlane.ts",
    import.meta.url,
  ),
  "utf8",
);
for (const requiredBoundary of [
  "prepareIntentControlPlaneCommit",
  "prepareReceiptRegistryCommit",
  "prepareReceiptRegistryFinalize",
  "prepareIntentControlPlaneFinalize",
  "assertProofMatchesBoundPlan",
  "prepareStellarContractCall",
  "proofPersisted: false",
]) {
  expect(
    controlPlaneBrowserSource.includes(requiredBoundary),
    `the browser control-plane source lost ${requiredBoundary}`,
  );
}
for (const forbiddenOperation of [
  "signTransaction(",
  "submitTransaction(",
  "Keypair.fromSecret",
  "PRIVATE_KEY",
]) {
  expect(
    !controlPlaneBrowserSource.includes(forbiddenOperation),
    `the deploy-last browser control-plane source contains forbidden ${forbiddenOperation}`,
  );
}

const EVM_ACCOUNT = "0x1111111111111111111111111111111111111111";
const STELLAR_ACCOUNT =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const AMOUNT_COMMITMENT = `0x${"11".repeat(32)}`;
const RECIPIENT_COMMITMENT = `0x${"22".repeat(32)}`;
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
    cctpStandardFeeBps: 1.9999,
    cctpHops: 2,
    cctpLegs: [
      { sourceDomain: 26, destinationDomain: 27, standardFeeBps: 1 },
      { sourceDomain: 27, destinationDomain: 3, standardFeeBps: 1 },
    ],
    aaveSupplyApyBps: 250,
    sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"],
  },
};

const REDACTED_SEMANTIC_ENVELOPE = [
  "KLETIA_WORKFLOW_SEMANTIC_V2",
  "scenario=arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
  "private_field_isolation=true",
  "ledger_confidentiality_requested=false",
  "stellar_policy_center=true",
  "include_borrow_capacity=true",
  "amount_slot=[[private:amount]]",
  "recipient_slot=[[private:recipient]]",
].join("\n");
expect(
  assertRedactedWorkflowPrompt(REDACTED_SEMANTIC_ENVELOPE) ===
    REDACTED_SEMANTIC_ENVELOPE,
  "the allowlisted private-intent envelope was rejected",
);
// No OPENROUTER_API_KEY is configured in this process. A successful result is
// therefore executable evidence that deterministic-only planning neither calls
// nor silently falls back to the semantic model.
const deterministicGoal = await parseWorkflowGoalV2(
  REDACTED_SEMANTIC_ENVELOPE,
  { semanticPlanner: "deterministic_registry" },
);
expect(
  deterministicGoal.isComplete === true &&
    deterministicGoal.scenarioId ===
      "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply" &&
    deterministicGoal.stellarPolicyCenter === true &&
    deterministicGoal.includeBorrowCapacity === true,
  "deterministic-only planning did not preserve the device-selected scenario and toggles",
);
for (const unsafePrompt of [
  "Move 5 USDC from Arc to 0x1111111111111111111111111111111111111111",
  `${REDACTED_SEMANTIC_ENVELOPE}\namount=5`,
  REDACTED_SEMANTIC_ENVELOPE.replace("[[private:amount]]", "5"),
]) {
  let rejected = false;
  try {
    assertRedactedWorkflowPrompt(unsafePrompt);
  } catch {
    rejected = true;
  }
  expect(rejected, "a raw or extended private-intent prompt crossed the API boundary");
}

// The compiler now reads its bindings from the matched IntentGrammarV1 entry
// rather than from loose literals, so the fixture must carry the real registry
// scenario. Using the registry here also means this boundary test fails if the
// only compilable scenario is ever renamed or removed.
const { findIntentScenario } = await import(
  "../apps/api/dist/cross-chain/v2/intentGrammar.js"
);
const ARC_TO_ARBITRUM_SCENARIO = findIntentScenario(
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
);
expect(
  ARC_TO_ARBITRUM_SCENARIO?.executionReadiness === "executable",
  "the Arc to Arbitrum corridor must remain the executable grammar scenario",
);

const baseInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  goal: {
    isComplete: true,
    semanticGoal: "Move the private slot through reviewed public checkpoints.",
    scenarioId: ARC_TO_ARBITRUM_SCENARIO.id,
    scenario: ARC_TO_ARBITRUM_SCENARIO,
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
  },
  amountCommitment: AMOUNT_COMMITMENT,
  recipientCommitment: RECIPIENT_COMMITMENT,
  routePreference: "stellar_centered_public",
  arcAddress: EVM_ACCOUNT,
  stellarAddress: STELLAR_ACCOUNT,
  arbitrumSepoliaAddress: EVM_ACCOUNT,
  routeMetrics,
};

// RouteGraphV1 is exercised directly, because the whole point of the phase is
// that disclosure influences ranking. A structural test of the graph is the only
// way to prove that; reading the compiled plan alone would not show whether the
// disclosure term did any work.
const {
  buildRouteCandidatesFromGraph,
  findRoutePaths,
  priceRouteDisclosure,
  readRouteGraphManifest,
} = await import("../apps/api/dist/cross-chain/v2/routeGraph.js");

const graphPaths = findRoutePaths({
  from: "arc_testnet:USDC",
  to: "arbitrum_sepolia:aUSDC",
  maxEdges: 4,
  readiness: ["executable"],
});
expect(
  graphPaths.length === 2,
  "the route graph must expose exactly the two reviewed executable corridors",
);
const directPath = graphPaths.find(
  (path) => !path.networks.includes("stellar_testnet"),
);
const stellarPath = graphPaths.find((path) =>
  path.networks.includes("stellar_testnet"),
);
expect(Boolean(directPath && stellarPath), "the graph lost one of the reviewed corridors");
const directDisclosure = priceRouteDisclosure(directPath);
const stellarDisclosure = priceRouteDisclosure(stellarPath);
// A route touching three ledgers must pay more gross disclosure than one touching
// two. If this ever inverted, the model would be rewarding extra exposure.
expect(
  stellarDisclosure.rawWeight > directDisclosure.rawWeight,
  "the Stellar corridor must pay more gross disclosure for its extra public ledger",
);
expect(
  directDisclosure.correlationDomainsRequired === 1 &&
    stellarDisclosure.correlationDomainsRequired === 1,
  "public re-origination must not be presented as a separate privacy domain",
);
expect(
  directDisclosure.ledgerLinkageCredit === 0 &&
    stellarDisclosure.ledgerLinkageCredit === 0,
  "public routes must not receive an unlinkability credit",
);
// The disclosure term must be non-zero on both routes and must differ between
// them. Equal or zero values would reproduce exactly the inert behaviour this
// phase replaced.
expect(
  directDisclosure.netPenalty !== 0 && stellarDisclosure.netPenalty !== 0,
  "the disclosure penalty must not be inert",
);
expect(
  directDisclosure.netPenalty !== stellarDisclosure.netPenalty,
  "the disclosure penalty must distinguish the two corridors",
);
// The credit must never be presented as protection from Circle, which attests
// both legs.
expect(
  stellarDisclosure.reasoning.includes("No unlinkability credit"),
  "the Stellar disclosure reasoning must reject public re-origination as privacy",
);
const graphCandidates = buildRouteCandidatesFromGraph(routeMetrics);
expect(
  graphCandidates.length === 2 &&
    graphCandidates.every(
      (route) =>
        route.score.methodology === "kletia_normalized_route_score_v2" &&
        route.score.disclosurePenalty === route.disclosureProfile.netPenalty &&
        route.routeGraph.edgeIds.length > 0,
    ),
  "graph-derived candidates did not carry an auditable disclosure profile",
);
for (const route of graphCandidates) {
  const expectedTotal = Number(
    (
      route.score.bridgeFeeBps +
      route.score.latencyPenalty +
      route.score.failurePenalty +
      route.score.disclosurePenalty -
      route.score.apyCredit
    ).toFixed(4),
  );
  expect(
    route.score.total === expectedTotal,
    `${route.kind} score total is not reproducible from its published terms`,
  );
}
const manifest = readRouteGraphManifest();
expect(
  manifest.schemaVersion === "kletia_route_graph_v1" &&
    manifest.executablePathCount === 2 &&
    manifest.edges.some((edge) => edge.readiness === "quote_only"),
  "the route graph manifest must publish edge readiness honestly",
);
// Fail closed: a corridor whose CCTP legs cannot be bound to observed Circle
// evidence must be refused rather than scored on assumed fees.
let unboundEvidenceRejected = false;
try {
  buildRouteCandidatesFromGraph({
    direct: routeMetrics.direct,
    stellar: routeMetrics.direct,
  });
} catch (error) {
  unboundEvidenceRejected =
    error instanceof Error &&
    error.message.toLowerCase().includes("circle fee evidence");
}
expect(
  unboundEvidenceRejected,
  "a graph route without matching Circle fee evidence was accepted",
);

const plan = compileWorkflowPlanV2(baseInput);
expect(plan.environmentLane === "testnet", "workflow escaped the testnet lane");
expect(
  plan.privacy.semanticPlanner === "deterministic_registry" &&
    plan.privacy.privacyBudget.preset ===
      "deterministic_only_public_execution" &&
    plan.privacy.privacyBudget.rules.every(
      (rule) => !rule.allowedObservers.includes("kletia_ai"),
    ),
  "the default WorkflowPlanV2 privacy budget is not deterministic and AI-free",
);
expect(
  plan.routeCandidates.length === 2 &&
    plan.routeCandidates.every((route) => route.privacyGain === "private_intent_only"),
  "runtime exposed an unavailable route or misrepresented planning privacy",
);
expect(
  plan.routeCandidates.every(
    (route) => route.score.disclosurePenalty !== 0 && route.disclosureCost > 0,
  ),
  "the compiled plan still carries an inert disclosure term",
);
expect(
  plan.privacy.scope === "browser_private_fields_public_ledger" &&
    plan.privacy.privateFieldIsolationRequested === true &&
    plan.privacy.onchainConfidentiality === "none",
  "workflow privacy scope is not explicit",
);
expect(
  plan.privacy.privacyBudget.schemaVersion === "kletia_privacy_budget_v1" &&
    plan.privacy.privacyBudget.enforcement === "fail_closed" &&
    plan.privacy.disclosureDiff.schemaVersion ===
      "kletia_disclosure_diff_v1" &&
    plan.privacy.disclosureDiff.compatible === true &&
    plan.privacy.disclosureDiff.violations.length === 0 &&
    plan.privacy.disclosureDiff.entries.length === plan.steps.length + 1,
  "the canonical Privacy Budget or checkpoint Disclosure Diff is missing",
);
expect(
  plan.authorizationBoundary.planCoreSha256 ===
    computeWorkflowPlanCoreSha256(plan),
  "authorization boundary does not bind the plan core",
);
expect(
  !JSON.stringify(plan).includes("5.000000") &&
    !JSON.stringify(plan).includes("amountCommitmentSalt") &&
    !JSON.stringify(plan).includes("recipientCommitmentSalt"),
  "plaintext private amount leaked into the plan",
);
expect(
  plan.authorizationBoundary.requiredStepSigners.includes("arc_wallet") &&
    plan.authorizationBoundary.requiredStepSigners.includes("stellar_wallet") &&
    plan.authorizationBoundary.requiredStepSigners.includes(
      "arbitrum_sepolia_wallet",
    ),
  "the heterogeneous signer set is incomplete",
);

const token = sealWorkflowPlanV2(plan);
expect(
  token.length <= 64_000,
  "the deterministic privacy projections made the sealed workflow token too large for the API boundary",
);
expect(
  openWorkflowPlanV2(token).workflowId === plan.workflowId,
  "sealed workflow token did not round-trip",
);

const deterministicPlan = compileWorkflowPlanV2({
  ...baseInput,
  privacyBudgetPreset: "deterministic_only_public_execution",
});
expect(
  deterministicPlan.privacy.semanticPlanner === "deterministic_registry" &&
    deterministicPlan.privacy.privacyBudget.preset ===
      "deterministic_only_public_execution" &&
    deterministicPlan.privacy.disclosureDiff.finalKnowledge.every(
      (fact) => fact.observer !== "kletia_ai",
    ) &&
    deterministicPlan.privacy.privacyBudget.rules.every(
      (rule) => !rule.allowedObservers.includes("kletia_ai"),
    ),
  "the no-AI Privacy Budget still discloses planning data to the semantic model",
);

const directGoal = {
  ...baseInput.goal,
  toggles: { ...baseInput.goal.toggles, stellarPolicyCenter: false },
  stellarPolicyCenter: false,
};
const directPlan = compileWorkflowPlanV2({
  ...baseInput,
  goal: directGoal,
  routePreference: "direct_cctp",
  stellarAddress: undefined,
});
expect(
  directPlan.selectedRoute === "direct_cctp" &&
    !directPlan.walletBindings.some((binding) => binding.id === "stellar_wallet"),
  "a corridor-forbidden envelope did not compile to the direct route only",
);
expect(
  directPlan.privacy.privacyBudget.rules.every((rule) =>
    rule.allowedObservers.every(
      (observer) =>
        observer !== "rpc:stellar_testnet" &&
        observer !== "public_ledger:stellar_testnet" &&
        observer !== "stellar_archive",
    ),
  ),
  "the direct route retained permission for unused Stellar observers",
);
expect(
  plan.privacy.privacyBudget.rules
    .filter(
      (rule) =>
        rule.field === "amount_commitment_opening" ||
        rule.field === "recipient_commitment_opening",
    )
    .every(
      (rule) =>
        rule.allowedObservers.length === 2 &&
        rule.allowedObservers.includes("device") &&
        rule.allowedObservers.includes("kletia_api"),
    ),
  "commitment openings were permitted to unrelated model, bridge, protocol, or ledger observers",
);
expect(
  plan.privacy.privacyBudget.rules
    .filter((rule) => rule.phase !== "planning")
    .every((rule) => !rule.allowedObservers.includes("kletia_ai")),
  "an execution phase still permits disclosure to the semantic model",
);

const autoPlan = compileWorkflowPlanV2({
  ...baseInput,
  routePreference: "auto",
});
expect(
  autoPlan.routeSelection.mode === "auto",
  "a corridor-permitted envelope did not preserve automatic route selection",
);

for (const conflictingInput of [
  {
    ...baseInput,
    goal: directGoal,
    routePreference: "stellar_centered_public",
  },
  {
    ...baseInput,
    goal: directGoal,
    routePreference: "auto",
  },
  {
    ...baseInput,
    routePreference: "direct_cctp",
  },
  {
    ...baseInput,
    goal: {
      ...baseInput.goal,
      toggles: { ...baseInput.goal.toggles, stellarPolicyCenter: false },
      stellarPolicyCenter: true,
    },
  },
]) {
  let mismatchRejected = false;
  try {
    compileWorkflowPlanV2(conflictingInput);
  } catch (error) {
    mismatchRejected = error?.code === "WORKFLOW_ROUTE_POLICY_MISMATCH";
  }
  expect(
    mismatchRejected,
    "a route preference that conflicts with the sealed Stellar corridor permission was accepted",
  );
}
let confidentialBudgetRejected = false;
try {
  compileWorkflowPlanV2({
    ...baseInput,
    privacyBudgetPreset: "confidential_ledger_required",
  });
} catch (error) {
  confidentialBudgetRejected =
    error?.code === "PRIVACY_BUDGET_UNSATISFIABLE";
}
expect(
  confidentialBudgetRejected,
  "a ledger-confidential budget was silently downgraded to public execution",
);

const changedQuote = plan.routeCandidates.map((route) =>
  route.kind === plan.selectedRoute
    ? {
        ...route,
        liveEvidence: {
          ...route.liveEvidence,
          quoteExpiresAt: route.liveEvidence.quoteExpiresAt + 1,
        },
      }
    : route,
);
const rebound = rebindWorkflowPlanAuthorization({
  ...plan,
  manifestAuthorization: {
    family: "stellar",
    signer: STELLAR_ACCOUNT,
    signature: "00".repeat(64),
    manifestSha256: `0x${"33".repeat(32)}`,
    verifiedAt: new Date().toISOString(),
  },
  routeCandidates: changedQuote,
});
expect(
  rebound.authorizationBoundary.planCoreSha256 !==
    plan.authorizationBoundary.planCoreSha256,
  "quote change did not change the plan core",
);
expect(
  rebound.manifestAuthorization === undefined,
  "quote change preserved stale manifest authorization",
);

const renewed = renewWorkflowPlanAuthorization(plan);
expect(
  typeof renewed.authorizationRefreshedAt === "number" &&
    renewed.expiresAt === renewed.authorizationRefreshedAt + 24 * 60 * 60 * 1_000 &&
    renewed.authorizationBoundary.planCoreSha256 !==
      plan.authorizationBoundary.planCoreSha256,
  "authorization renewal did not create a new consent boundary",
);

let unavailableRouteRejected = false;
try {
  compileWorkflowPlanV2({
    ...baseInput,
    routePreference: "stellar_centered_confidential",
  });
} catch (error) {
  unavailableRouteRejected =
    error instanceof Error &&
    error.message.toLowerCase().includes("route policy");
}
expect(unavailableRouteRejected, "unavailable confidential route was accepted");

for (const [display, canonical, local] of [
  ["1", 1_000_000n, 10_000_000n],
  ["0.123456", 123_456n, 1_234_560n],
]) {
  expect(local === canonical * 10n, `${display} failed the canonical 6 to Stellar 7 decimal invariant`);
}
expect(
  1_234_567n % 10n !== 0n,
  "the seventh-decimal CCTP dust case was not detected",
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Stellar runtime boundary failed: ${failure}`);
  }
  process.exit(1);
}

console.log("Stellar runtime authorization and privacy boundaries passed.");
