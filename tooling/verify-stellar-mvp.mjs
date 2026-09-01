import { existsSync, readFileSync } from "node:fs";

const failures = [];
const requireFile = (file) => {
  if (!existsSync(file)) failures.push(`missing file: ${file}`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const requireFragment = (content, fragment, file) => {
  if (!content.includes(fragment)) failures.push(`${file} is missing ${fragment}`);
};

const apiConfig = requireFile("apps/api/src/networks/stellar/config.ts");
const arbConfig = requireFile("apps/api/src/networks/arbitrum-sepolia/config.ts");
const apiAdvance = requireFile("apps/api/src/cross-chain/v2/advance.ts");
const workflowCompiler = requireFile("apps/api/src/cross-chain/v2/compiler.ts");
const arbService = requireFile("apps/api/src/networks/arbitrum-sepolia/service.ts");
const arbRoutes = requireFile("apps/api/src/networks/arbitrum-sepolia/routes.ts");
const checkpointStore = requireFile("apps/api/src/cross-chain/v2/checkpointStore.ts");
const webCctp = requireFile("apps/web/src/networks/stellar/runtime/cctp.ts");
const webRecovery = requireFile("apps/web/src/networks/stellar/runtime/recovery.ts");
const webPrivacy = requireFile("apps/web/src/networks/stellar/runtime/privateIntent.ts");
const webIntentPrivacy = requireFile("apps/web/src/shared/privacy/intentPrivacy.ts");
const apiParser = requireFile("apps/api/src/cross-chain/v2/parser.ts");
const stellarService = requireFile("apps/api/src/networks/stellar/service.ts");
const render = requireFile("render.yaml");
const upstream = requireFile("contracts/stellar/upstream.lock.json");
const protocolLock = requireFile("contracts/stellar/protocol.lock.json");
const protocolManifest = requireFile(
  "apps/api/src/networks/stellar/protocolManifest.ts",
);
const confidentialReferenceManifest = requireFile(
  "apps/api/src/networks/stellar/confidentialReferenceManifest.ts",
);
const stellarRoutes = requireFile("apps/api/src/networks/stellar/routes.ts");
const workflowRoutes = requireFile("apps/api/src/cross-chain/v2/routes.ts");
const eventArchive = requireFile("apps/api/src/networks/stellar/eventArchive.ts");
const egressGuard = requireFile("apps/web/src/shared/privacy/egressGuard.ts");
const egressBootstrap = requireFile(
  "apps/web/src/shared/privacy/bootstrapEgressGuard.ts",
);
const webEntrypoint = requireFile("apps/web/src/main.tsx");
const intentGrammar = requireFile("apps/api/src/cross-chain/v2/intentGrammar.ts");
const clientGrammar = requireFile(
  "apps/web/src/shared/privacy/intentGrammarClient.ts",
);
const lifecycle = requireFile("apps/api/src/cross-chain/v2/lifecycle.ts");
const confidentialSurface = requireFile(
  "apps/web/src/shared/privacy/confidentialSurfaceGate.ts",
);
const routeGraph = requireFile("apps/api/src/cross-chain/v2/routeGraph.ts");
const webWorkflowTypes = requireFile("apps/web/src/cross-chain/v2/types.ts");

for (const [file, content, fragments] of [
  [
    "apps/api/src/networks/stellar/config.ts",
    apiConfig,
    [
      "id: \"stellar_testnet\"",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "domain: 27",
    ],
  ],
  [
    "apps/api/src/networks/arbitrum-sepolia/config.ts",
    arbConfig,
    [
      "421_614",
      "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      "0xB25a5D144626a0D488e52AE717A051a2E9997076",
      "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
      "0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01",
      "0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00",
    ],
  ],
  [
    "apps/web/src/networks/stellar/runtime/cctp.ts",
    webCctp,
    ["domain: 26", "domain: 27", "domain: 3", "depositForBurnWithHook"],
  ],
  [
    "apps/api/src/cross-chain/v2/advance.ts",
    apiAdvance,
    ["feeExecuted", "amountCommitmentSalt", "recipientCommitmentSalt", "arbitrum_sepolia_wallet"],
  ],
]) {
  for (const fragment of fragments) requireFragment(content, fragment, file);
}

for (const [file, content, fragments] of [
  [
    "apps/web/src/networks/stellar/runtime/recovery.ts",
    webRecovery,
    ["scryptAsync", "AES-GCM", "kletia_workflow_authorization_recovery_v1"],
  ],
  [
    "apps/web/src/networks/stellar/runtime/privateIntent.ts",
    webPrivacy,
    ["buildClientIntentEnvelope", "requestLedgerConfidentiality"],
  ],
  [
    "apps/web/src/shared/privacy/intentPrivacy.ts",
    webIntentPrivacy,
    ["requestsFinancialPrivacy", "normalize(\"NFKC\")"],
  ],
  [
    "apps/api/src/cross-chain/v2/parser.ts",
    apiParser,
    [
      "matchIntentEnvelope",
      "PRIVATE_FIELD_EGRESS_BLOCKED",
      "INTENT_SCENARIO_INTEGRATION_INCOMPLETE",
      "LEDGER_CONFIDENTIALITY_UNAVAILABLE",
      "INTENT_PARSER_BOUNDARY_MISMATCH",
    ],
  ],
  [
    "apps/api/src/networks/stellar/service.ts",
    stellarService,
    [
      "syntax_validated_untrusted_quote",
      "routerInvocationBound: false",
      "enforcingSimulationBound: false",
      "reviewed_direct_pair_only",
      "route.pathIdentities.length === 0",
    ],
  ],
  [
    "apps/api/src/networks/arbitrum-sepolia/service.ts",
    arbService,
    ["prepareArbitrumSepoliaWithdraw", "AAVE_WITHDRAW_EXCEEDS_POSITION", "maxUint256"],
  ],
  [
    "apps/api/src/networks/arbitrum-sepolia/routes.ts",
    arbRoutes,
    ["/prepare/withdraw"],
  ],
  [
    "apps/api/src/cross-chain/v2/compiler.ts",
    workflowCompiler,
    [
      "rawPrivateAmountReceivedDuringPlanning: false",
      "recipientReceivedAsPublicWalletBinding: true",
    ],
  ],
]) {
  for (const fragment of fragments) requireFragment(content, fragment, file);
}

for (const fragment of [
  "key: STELLAR_MVP_ENABLED\n        value: \"true\"",
  "key: ARBITRUM_SEPOLIA_MVP_ENABLED\n        value: \"true\"",
  "key: VITE_STELLAR_MVP_ENABLED\n        value: \"true\"",
  "name: kletia-stellar-event-archive",
  "key: WORKFLOW_V2_DATABASE_URL",
]) {
  requireFragment(render, fragment, "render.yaml");
}

if (/\b(?:8453|42161)\b/u.test(workflowCompiler)) {
  failures.push("WorkflowPlanV2 compiler contains a Mainnet chain ID");
}
if (/\bct_(?:register|deposit|merge|transfer|withdraw)\b/u.test(workflowCompiler)) {
  failures.push("unavailable confidential execution actions remain in the runtime compiler");
}
if (/stellar_centered_confidential|confidential_treasury/u.test(workflowCompiler)) {
  failures.push("unavailable confidential route remains in the runtime compiler");
}
if (/STELLAR_CONFIDENTIAL_(?:ENABLED|DEPLOYMENT_MANIFEST)/u.test(render)) {
  failures.push("non-executable confidential configuration remains in Render runtime");
}
if (/localStorage|sessionStorage/u.test(webRecovery)) {
  failures.push("private recovery material must not be stored in browser key-value storage");
}
if (webCctp.includes('fee: "10000000"')) {
  failures.push("Stellar contract calls still use a fixed 1 XLM inclusion bid");
}
if (stellarService.includes("verified_read_only_quote")) {
  failures.push("Aquarius syntax-only evidence is still presented as verified");
}
if (apiAdvance.includes("rawPrivateFieldsReceivedByApi")) {
  failures.push("deprecated raw-private-field claim remains in workflow receipt code");
}
for (const fragment of ["PRIMARY KEY (workflow_id, step_id)", "UNIQUE (replay_key)", "ON CONFLICT (workflow_id, step_id) DO NOTHING"]) {
  requireFragment(checkpointStore, fragment, "apps/api/src/cross-chain/v2/checkpointStore.ts");
}

// StellarProtocolManifestV1. A stable contract ID is not a stable execution
// surface, because Soroban contracts can be upgraded in place. These gates keep
// the drift quarantine wired into the signing path rather than left as a
// reporting-only field that a caller could ignore.
for (const [file, content, fragments] of [
  [
    "apps/api/src/networks/stellar/protocolManifest.ts",
    protocolManifest,
    [
      "kletia_stellar_protocol_lock_v1",
      "assertUsdcSacDerivation",
      "assertStellarExecutionSurfaceOpen",
      "STELLAR_TESTNET_RESET_EPOCH",
      "drift_quarantined",
      "observed_unpinned",
      "cryptographicSafetyGuaranteed: false",
    ],
  ],
  [
    "apps/api/src/networks/stellar/routes.ts",
    stellarRoutes,
    ["readStellarProtocolManifest", "readStellarArchiveCoverage", "archiveCoverage"],
  ],
  [
    "apps/api/src/cross-chain/v2/routes.ts",
    workflowRoutes,
    ["assertStellarExecutionSurfaceOpen", "executionSurfaceOpen"],
  ],
  [
    "apps/api/src/networks/stellar/eventArchive.ts",
    eventArchive,
    [
      "kletia_stellar_archive_coverage_v1",
      "unrecoverable_gap",
      "rpc_overlaps_archive",
      "historyReconstructable",
    ],
  ],
  // Enforcing simulation. A recording simulation that succeeds does not prove
  // the assembled authorization tree is what the network will accept, so the
  // browser must re-simulate and compare the exact invocation before signing.
  [
    "apps/web/src/networks/stellar/runtime/cctp.ts",
    webCctp,
    [
      "sorobanInvocationFingerprint",
      "Pass 2 - enforcing simulation",
      "enforcingPrepared",
    ],
  ],
  // EgressGuardV1 turns registered V2-field egress from an intention into an
  // observed-session measurement rather than a systemwide proof.
  [
    "apps/web/src/shared/privacy/egressGuard.ts",
    egressGuard,
    [
      "kletia_egress_guard_v1",
      "PrivateFieldEgressBlockedError",
      "zeroPrivateFieldEgress",
      "unguardable_low_entropy",
      "installEgressGuard",
    ],
  ],
  [
    "apps/web/src/shared/privacy/bootstrapEgressGuard.ts",
    egressBootstrap,
    ["installEgressGuard()"],
  ],
  [
    "apps/web/src/networks/stellar/runtime/privateIntent.ts",
    webPrivacy,
    ["registerPrivateField", "guardPrivateMaterial"],
  ],
]) {
  for (const fragment of fragments) requireFragment(content, fragment, file);
}

// The guard only protects surfaces it wrapped before they were captured. ES
// imports are hoisted, so the bootstrap must be the first import in the
// entrypoint or wallet SDKs and transports will hold unwrapped natives.
const entrypointImports = [...webEntrypoint.matchAll(/^import\s.*$/gmu)].map(
  (match) => match[0],
);
if (!entrypointImports[0]?.includes("bootstrapEgressGuard")) {
  failures.push(
    "apps/web/src/main.tsx must import bootstrapEgressGuard first so the egress guard wraps outbound surfaces before any dependency captures them",
  );
}

// A never-verified violation report is indistinguishable from an unimplemented
// one, so the executable proof must exist alongside the implementation.
if (!existsSync("tooling/verify-privacy-egress-guard.mjs")) {
  failures.push("missing file: tooling/verify-privacy-egress-guard.mjs");
}

// The five-state lifecycle doctrine is only real if `indeterminate` and
// `recovery_required` are produced by code rather than declared in a type union.
for (const fragment of [
  "kletia_workflow_lifecycle_v1",
  "recovery_required",
  "indeterminate",
  "silentRetryAllowed: false",
  "classifyWorkflowLifecycleFailure",
  "assertWorkflowStepAdvanceable",
  "sealWorkflowLifecycleFailure",
]) {
  requireFragment(lifecycle, fragment, "apps/api/src/cross-chain/v2/lifecycle.ts");
}
// An unclassified or infrastructure fault must never be reported as a definite
// failure, because a definite outcome was not observed.
requireFragment(
  lifecycle,
  'status = "indeterminate"',
  "apps/api/src/cross-chain/v2/lifecycle.ts",
);
for (const fragment of [
  "assertWorkflowStepAdvanceable(plan)",
  "sealWorkflowLifecycleFailure(plan, error, sealWorkflowPlanV2)",
]) {
  requireFragment(apiAdvance, fragment, "apps/api/src/cross-chain/v2/advance.ts");
}
requireFragment(
  workflowRoutes,
  "isWorkflowLifecycleClassification",
  "apps/api/src/cross-chain/v2/routes.ts",
);

// The confidential surface claim must be a measurement. An environment that
// cannot be measured has to fail closed rather than report readiness.
for (const fragment of [
  "kletia_confidential_surface_gate_v1",
  "crossOriginIsolated",
  "SharedArrayBuffer",
  "dedicated_worker",
  "unmeasurable",
  "assertConfidentialSurfaceOpen",
]) {
  requireFragment(
    confidentialSurface,
    fragment,
    "apps/web/src/shared/privacy/confidentialSurfaceGate.ts",
  );
}
if (!confidentialSurface.includes("blocking.length === 0")) {
  failures.push(
    "the confidential surface gate must open only when every required capability was observed as available",
  );
}
requireFragment(
  webPrivacy,
  "assertConfidentialSurfaceOpen",
  "apps/web/src/networks/stellar/runtime/privateIntent.ts",
);

// IntentGrammarV1. The envelope must stay deterministic and the enumeration
// closed, otherwise the privacy claim degrades into "the model probably behaved".
for (const fragment of [
  "kletia_intent_grammar_v1",
  "KLETIA_WORKFLOW_SEMANTIC_V2",
  "buildIntentEnvelopePattern",
  "matchIntentEnvelope",
  "integration_incomplete",
  "shadow_only",
  "executionReadiness",
]) {
  requireFragment(
    intentGrammar,
    fragment,
    "apps/api/src/cross-chain/v2/intentGrammar.ts",
  );
}
// The pattern must stay anchored and single-line, so no extra envelope line can
// be smuggled in before, after or between the declared lines.
if (!intentGrammar.includes('new RegExp(`^${parts.join("\\\\n")}$`, "u")')) {
  failures.push(
    "the intent envelope pattern must remain anchored and built without the multiline flag",
  );
}
// A registered scenario expands what can be expressed, never what can be signed.
requireFragment(
  workflowCompiler,
  "WORKFLOW_SCENARIO_NOT_COMPILABLE",
  "apps/api/src/cross-chain/v2/compiler.ts",
);
requireFragment(
  workflowRoutes,
  "readIntentGrammarManifest",
  "apps/api/src/cross-chain/v2/routes.ts",
);

// Device and server registries must not drift. If they did, the device would
// emit envelopes the server rejects and the failure would look like a privacy
// bug rather than a versioning bug.
const scenarioIds = (content) =>
  [...content.matchAll(/^\s*id: "([a-z0-9_]+)",$/gmu)].map((match) => match[1]);
const clientScenarioIds = scenarioIds(clientGrammar);
const serverScenarioIds = scenarioIds(intentGrammar);
if (clientScenarioIds.length === 0 || serverScenarioIds.length === 0) {
  failures.push("the intent grammar registries could not be read for drift comparison");
}
for (const id of clientScenarioIds) {
  if (!serverScenarioIds.includes(id)) {
    failures.push(
      `the device intent registry declares ${id}, which the server grammar does not register`,
    );
  }
}
// Every scenario the device can express must be reviewable on the server, and no
// device scenario may request ledger confidentiality while Kletia's exact
// holder/deployment/recovery runtime is incomplete.
if (clientGrammar.includes("ledger_confidentiality_requested=true")) {
  failures.push(
    "the device intent registry must not request ledger confidentiality while the Kletia confidential runtime is incomplete",
  );
}

// RouteGraphV1. The point of the graph is that disclosure is priced and actually
// affects ranking. These gates exist because the previous implementation carried
// `disclosurePenalty: 0` on both routes, which made the privacy term decorative
// while still being displayed as if it mattered.
for (const fragment of [
  "kletia_route_graph_v1",
  "kletia_route_disclosure_profile_v1",
  "kletia_normalized_route_score_v2",
  "reOriginatesIdentity",
  "correlatingObservers",
  "priceRouteDisclosure",
  "findRoutePaths",
  "buildRouteCandidatesFromGraph",
  "WORKFLOW_ROUTE_EVIDENCE_MISSING",
  "quote_only",
]) {
  requireFragment(routeGraph, fragment, "apps/api/src/cross-chain/v2/routeGraph.ts");
}
// A zero or negative disclosure scale would silently disable or invert the term.
if (!/const DISCLOSURE_SCALE = [1-9]\d*;/u.test(routeGraph)) {
  failures.push("the route graph disclosure scale must be a positive constant");
}
// Public re-origination is not a privacy primitive. Any future non-zero credit
// requires a separate reviewed primitive and test update.
if (!/const LEDGER_LINKAGE_CREDIT_RAW = 0;/u.test(routeGraph)) {
  failures.push("the public-ledger unlinkability credit must remain explicitly zero");
}
// The net penalty must participate in the total. If this identity were dropped,
// the graph would report a disclosure figure that changed nothing.
if (!routeGraph.includes("disclosure.netPenalty -")) {
  failures.push("the route score must include the net disclosure penalty in its total");
}
// The credit is only ever granted for ledger observers. An edge that claimed to
// hide a transfer from Circle would be a false claim, so the correlating-observer
// disclaimer must stay in the reasoning string.
if (!routeGraph.includes("No unlinkability credit is granted")) {
  failures.push("the disclosure reasoning must reject public re-origination as privacy");
}
// The compiler must no longer carry hand-written route literals.
if (/disclosurePenalty:\s*0\b/u.test(workflowCompiler)) {
  failures.push("the compiler still hard-codes an inert zero disclosure penalty");
}
if (workflowCompiler.includes("function candidates(")) {
  failures.push("the compiler still declares its own route candidate literals");
}
requireFragment(
  workflowCompiler,
  "buildRouteCandidatesFromGraph",
  "apps/api/src/cross-chain/v2/compiler.ts",
);
requireFragment(
  workflowRoutes,
  "readRouteGraphManifest",
  "apps/api/src/cross-chain/v2/routes.ts",
);
// The device must recompute the ranking rather than trust it. Without this the
// published disclosure numbers would be unverifiable decoration on the client.
for (const fragment of [
  "kletia_normalized_route_score_v2",
  "expectedNetPenalty",
  "expectedTotal",
  "kletia_route_graph_v1",
]) {
  requireFragment(webWorkflowTypes, fragment, "apps/web/src/cross-chain/v2/types.ts");
}
if (webWorkflowTypes.includes("kletia_normalized_route_score_v1")) {
  failures.push("the device still accepts the superseded v1 route score methodology");
}
// Every edge must declare a readiness, and quote-only edges must never be
// traversed when building signable candidates.
if (!routeGraph.includes('readiness: ["executable"]')) {
  failures.push("signable route candidates must be built from executable edges only");
}

// The runtime pin table and the reviewed lock file must not diverge; otherwise a
// deployed API could enforce different pins than the ones under review.
try {
  const lock = JSON.parse(protocolLock);
  if (lock.schemaVersion !== "kletia_stellar_protocol_lock_v1") {
    failures.push("contracts/stellar/protocol.lock.json schema version drifted");
  }
  if (lock.networkPassphrase !== "Test SDF Network ; September 2015") {
    failures.push("the Stellar protocol lock is not bound to Testnet");
  }
  for (const [key, entry] of Object.entries(lock.contracts || {})) {
    if (!protocolManifest.includes(`key: "${key}"`)) {
      failures.push(`the runtime protocol manifest is missing the pinned contract ${key}`);
    }
    if (typeof entry.contractId !== "string" || entry.contractId.length !== 56) {
      failures.push(`the pinned contract ${key} has an invalid contract ID`);
    }
    if (
      entry.executionEnabled === true &&
      entry.expectedExecutable === "wasm"
    ) {
      if (
        typeof entry.pinnedWasmHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.pinnedWasmHash)
      ) {
        failures.push(`the execution contract ${key} lacks an exact WASM pin`);
      } else if (!protocolManifest.includes(entry.pinnedWasmHash)) {
        failures.push(`the runtime WASM pin for ${key} diverges from the reviewed lock`);
      }
      if (
        entry.provenance?.reviewStatus !== "operator_observed_bytecode_pin" ||
        typeof entry.provenance?.observedAtLedger !== "string" ||
        entry.provenance?.sourceCodeReviewed !== false
      ) {
        failures.push(`the execution contract ${key} lacks honest pin provenance`);
      }
    }
  }
} catch {
  failures.push("contracts/stellar/protocol.lock.json is not valid JSON");
}

try {
  const lock = JSON.parse(upstream);
  if (
    lock.schemaVersion !== "kletia_stellar_confidential_upstream_lock_v2" ||
    lock.securityStatus !== "experimental_unaudited_testnet_developer_preview"
  ) {
    failures.push("the Confidential Token upstream lock lost its versioned unaudited Testnet boundary");
  }
  if (
    lock.mainlineReference?.commit !==
      "fbfde388e1b72afa93d6b1c922067879b20e81db" ||
    lock.mainlineReference?.defaultVerifierStatus !==
      "unfinished_interface_at_pin"
  ) {
    failures.push("the OpenZeppelin mainline reference or its unfinished-interface status drifted");
  }
  const preview = lock.officialDeveloperPreviewReference;
  if (
    preview?.status !== "working_unaudited_stellar_testnet_reference" ||
    preview?.demoCommit !==
      "9500ed774b13b08b5fe99370b60de3479edb492b" ||
    preview?.openZeppelinFeatureTipObserved !==
      "98090b3e59785454f55b3617992c2f84250c7173" ||
    preview?.openZeppelinCommitPinnedByDemo !==
      "539968f158e0d779f584de2821090f715a3b25e1" ||
    preview?.nethermindUltraHonkCommitPinnedByDemo !==
      "661db07200f890b1bd9a7349ed787c70a706dd12" ||
    preview?.claimBoundary?.workingReferenceExists !== true ||
    preview?.claimBoundary?.audited !== false ||
    preview?.claimBoundary?.kletiaExecutable !== false
  ) {
    failures.push("the official working-but-unaudited Testnet reference metadata drifted");
  }
  const kletia = lock.kletiaIntegration;
  if (
    kletia?.status !== "integration_incomplete_non_signable" ||
    kletia?.testnetEvaluationAllowed !== true ||
    kletia?.deploymentAllowed !== false ||
    kletia?.signableRuntimeAllowed !== false ||
    !Array.isArray(kletia?.blockers) ||
    kletia.blockers.length < 5
  ) {
    failures.push("Kletia confidential execution must remain non-signable until every integration gate is evidenced");
  }
  const referenceIds = Object.values(preview?.referenceDeployment ?? {}).filter(
    (value) => typeof value === "string" && /^[A-Z2-7]{56}$/u.test(value),
  );
  if (referenceIds.some((contractId) => protocolManifest.includes(contractId))) {
    failures.push("upstream demo contract IDs must never become Kletia execution pins");
  }
  for (const exactValue of [
    preview?.demoCommit,
    preview?.openZeppelinFeatureTipObserved,
    preview?.openZeppelinCommitPinnedByDemo,
    preview?.nethermindUltraHonkCommitPinnedByDemo,
    preview?.referenceDeployment?.confidentialTokenContractId,
    preview?.referenceDeployment?.verifierContractId,
    preview?.referenceDeployment?.auditorContractId,
    preview?.referenceDeployment?.underlyingSacContractId,
    "integration_incomplete_non_signable",
  ]) {
    if (typeof exactValue !== "string" || !confidentialReferenceManifest.includes(exactValue)) {
      failures.push(`the runtime confidential reference manifest diverges from ${String(exactValue)}`);
    }
  }
  if (
    !confidentialReferenceManifest.includes("signableRuntimeAllowed: false") ||
    !confidentialReferenceManifest.includes("deploymentAllowed: false") ||
    !stellarRoutes.includes('router.get("/confidential-reference"')
  ) {
    failures.push("the runtime must expose documentary preview metadata without opening a signable confidential route");
  }
} catch {
  failures.push("contracts/stellar/upstream.lock.json is not valid JSON");
}

if (failures.length) {
  for (const failure of failures) console.error(`Stellar MVP gate failed: ${failure}`);
  process.exit(1);
}

console.log("Stellar MVP release boundary check passed.");
