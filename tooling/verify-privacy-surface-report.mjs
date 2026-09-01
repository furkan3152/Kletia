#!/usr/bin/env node

/**
 * Release gate for the scope of Kletia's privacy claims.
 *
 * The report is intentionally imported from the compiled API. This catches both
 * type/build drift and accidental wording changes that would broaden a
 * WorkflowPlanV2 guarantee to legacy, standalone or public-ledger surfaces.
 */

import { readFile } from "node:fs/promises";

const { readPrivacySurfaceReportV1 } = await import(
  "../apps/api/dist/cross-chain/v2/privacySurfaceReport.js"
);

const compiledRoutes = await readFile(
  new URL("../apps/api/dist/cross-chain/v2/routes.js", import.meta.url),
  "utf8",
);
const compiledStellarRoutes = await readFile(
  new URL("../apps/api/dist/networks/stellar/routes.js", import.meta.url),
  "utf8",
);

const report = readPrivacySurfaceReportV1();
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const surface = (id) => report.surfaces.find((entry) => entry.id === id);

expect(
  report.schemaVersion === "kletia_privacy_surface_report_v1" &&
    report.assurance === "reviewed_source_manifest_not_noninterference_proof",
  "the report lost its machine-readable schema or source-manifest assurance boundary",
);
expect(
  compiledRoutes.includes('router.get("/privacy-surfaces"') &&
    compiledRoutes.includes('claimScope: "workflow_v2_semantic_planning_only"') &&
    compiledRoutes.includes("rawPrivateFieldsReceivedByApiDuringPlanning: true") &&
    compiledRoutes.includes("rawExactAmountReceivedByApiDuringPlanning: false") &&
    compiledRoutes.includes("publicExecutionRecipientReceivedByApiDuringPlanning: true"),
  "the report is not exposed or V2 readiness no longer separates exact-amount isolation from public recipient disclosure",
);
expect(
  report.defaultPolicy.semanticPlanner === "deterministic_only" &&
    report.defaultPolicy.financialChatPersistence === "browser_redacted" &&
    report.defaultPolicy.confidentialRequestFallback ===
      "fail_closed_no_public_downgrade" &&
    report.defaultPolicy.ledgerConfidentiality ===
      "stellar_testnet_shielded_pool_only",
  "the default policy no longer scopes ledger privacy to the Stellar Testnet shielded surface",
);
expect(
  report.claimScope.privatePlanning === "workflow_v2_only" &&
    report.claimScope.legacyIntentApiBlindness === false &&
    report.claimScope.standaloneStellarToolsSealedByWorkflowV2 === false &&
    report.claimScope.x402PaymentConfidential === false &&
    report.claimScope.systemwideLedgerConfidentiality === false,
  "a scoped privacy claim was accidentally broadened into a systemwide guarantee",
);

const expectedIds = [
  "legacy_base_arc_intent",
  "workflow_v2_private_planning",
  "stellar_portfolio",
  "stellar_sdex",
  "stellar_transfer",
  "base_x402_buyer",
  "browser_egress_guard",
  "unified_superapp_ui",
  "stellar_private_payments",
  "stellar_confidential_treasury",
];
expect(
  report.surfaces.length === expectedIds.length &&
    expectedIds.every((id) => Boolean(surface(id))),
  "the report does not enumerate every reviewed privacy surface",
);

const legacy = surface("legacy_base_arc_intent");
expect(
  legacy?.kletiaApiReceives.includes("raw_prompt") &&
    legacy.aiAccess.default === "none" &&
    legacy.aiAccess.optIn === "raw_prompt_and_recent_context" &&
    legacy.onchainConfidentiality === "none",
  "legacy intent disclosure is no longer represented honestly",
);

const workflow = surface("workflow_v2_private_planning");
expect(
  workflow?.sealedWorkflowV2 === true &&
    workflow.kletiaApiReceives.includes(
      "amount_commitment_not_exact_amount_during_planning",
    ) &&
    workflow.kletiaApiReceives.includes(
      "public_execution_wallet_bindings_including_destination",
    ) &&
    workflow.settlementVisibility === "public_ledger" &&
    workflow.onchainConfidentiality === "none",
  "WorkflowPlanV2 no longer distinguishes private planning from public recipient and settlement visibility",
);

const sdex = surface("stellar_sdex");
expect(
  sdex?.sealedWorkflowV2 === false &&
    sdex.kletiaApiReceives.includes("exact_quote_amount") &&
    !sdex.kletiaApiReceives.some((entry) => entry.includes("account")) &&
    sdex.externalObservers.some((entry) => entry.includes("horizon")) &&
    sdex.externalObservers.some((entry) => entry.includes("aquarius")) &&
    sdex.onchainConfidentiality === "none" &&
    compiledStellarRoutes.includes("account identity is not required"),
  "standalone Stellar SDEX disclosure was hidden or presented as sealed/private",
);

const transfer = surface("stellar_transfer");
expect(
  transfer?.sealedWorkflowV2 === false &&
    transfer.kletiaApiReceives.length === 0 &&
    transfer.externalObservers.some((entry) => entry.includes("horizon")) &&
    transfer.settlementVisibility === "public_ledger",
  "the browser-built Stellar transfer boundary is no longer described accurately",
);

const x402 = surface("base_x402_buyer");
expect(
  x402?.settlementVisibility === "public_ledger" &&
    x402.onchainConfidentiality === "none" &&
    x402.kletiaApiReceives.includes("wallet_signed_eip_3009_authorization") &&
    x402.limitations.some((entry) => entry.includes("public Base evidence")),
  "x402 was accidentally presented as confidential or its signed-payment boundary disappeared",
);

const guard = surface("browser_egress_guard");
expect(
  guard?.settlementVisibility === "no_settlement" &&
    guard.limitations.some((entry) => entry.includes("observed browser realm")) &&
    guard.limitations.some((entry) => entry.includes("non-interference proof")),
  "the browser guard is being presented as a systemwide proof",
);

const ui = surface("unified_superapp_ui");
expect(
  ui?.settlementVisibility === "no_settlement" &&
    ui.sealedWorkflowV2 === false &&
    ui.limitations.some((entry) => entry.includes("WorkflowPlanV2 only")) &&
    ui.limitations.some((entry) => entry.includes("standalone Stellar tools")),
  "the UI report no longer distinguishes V2 disclosure cards from legacy and standalone surfaces",
);

const confidential = surface("stellar_confidential_treasury");
expect(
  confidential?.availability === "blocked" &&
    confidential.onchainConfidentiality === "blocked_no_reviewed_runtime" &&
    confidential.settlementVisibility === "unavailable" &&
    confidential.endpoints.length === 0,
  "the unavailable confidential treasury was exposed as a runtime capability",
);

const privatePayments = surface("stellar_private_payments");
expect(
  privatePayments?.availability === "capability_gated" &&
    privatePayments.onchainConfidentiality === "zk_shielded_pool" &&
    privatePayments.settlementVisibility === "public_ledger" &&
    privatePayments.kletiaApiReceives.length === 0 &&
    privatePayments.limitations.some((entry) => entry.includes("unaudited Testnet")) &&
    privatePayments.limitations.some((entry) => entry.includes("deposit and withdrawal")),
  "the real Stellar shielded surface is missing or overstates its privacy boundary",
);

expect(
  report.surfaces.every(
    (entry) =>
      entry.onchainConfidentiality === "none" ||
      entry.onchainConfidentiality === "not_applicable" ||
      entry.onchainConfidentiality === "zk_shielded_pool" ||
      entry.onchainConfidentiality === "blocked_no_reviewed_runtime",
  ),
  "a current surface uses an unreviewed onchain confidentiality classification",
);

if (failures.length > 0) {
  console.error("Privacy surface report gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Privacy surface report gate passed (${report.surfaces.length} separately scoped surfaces).`,
);
