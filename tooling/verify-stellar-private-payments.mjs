#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const repo = new URL("../", import.meta.url);
const readJson = async (relative) =>
  JSON.parse(await readFile(new URL(relative, repo), "utf8"));
const readText = (relative) => readFile(new URL(relative, repo), "utf8");

const [lock, webPackage, webLock, runtime, panel, stageScript, apiManifest, routes, workflowRoutes, surfaceReport] =
  await Promise.all([
    readJson("contracts/stellar/private-payments.lock.json"),
    readJson("apps/web/package.json"),
    readJson("apps/web/package-lock.json"),
    readText("apps/web/src/networks/stellar/runtime/privatePayments.ts"),
    readText("apps/web/src/networks/stellar/components/ShieldedPaymentsPanel.tsx"),
    readText("apps/web/scripts/stage-stellar-private-payments.mjs"),
    readText("apps/api/src/networks/stellar/privatePaymentsManifest.ts"),
    readText("apps/api/src/networks/stellar/routes.ts"),
    readText("apps/api/src/cross-chain/v2/routes.ts"),
    readText("apps/api/src/cross-chain/v2/privacySurfaceReport.ts"),
  ]);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const dependency = webLock.packages?.["node_modules/stellar-private-payments"];

expect(
  lock.schemaVersion === "kletia_stellar_private_payments_lock_v1" &&
    lock.network === "stellar_testnet",
  "the Stellar Private Payments lock schema or network changed",
);
expect(
  webPackage.dependencies?.["stellar-private-payments"] === lock.upstream.sdkVersion &&
    dependency?.version === lock.upstream.sdkVersion &&
    dependency?.integrity === lock.upstream.npmIntegrity,
  "the browser SDK version or npm integrity no longer matches the reviewed lock",
);
expect(
  runtime.includes('import("stellar-private-payments")') &&
    runtime.includes('import("stellar-private-payments/freighter")') &&
    runtime.includes("revealSensitive: false") &&
    runtime.includes("PrivatePaymentsArchiveConsentRequiredError") &&
    !runtime.includes("BACKEND_URL") &&
    !runtime.includes("/api/"),
  "the shielded browser path is no longer lazy, API-blind, telemetry-redacted and archive-consent gated",
);
expect(
  runtime.includes("compileLocalShieldedIntent") &&
    panel.includes("compiled only in this browser") &&
    panel.includes("executionIndeterminate") &&
    panel.includes("Silent retry is locked"),
  "the shielded intent surface lost its local-only compiler or indeterminate-submission lock",
);
expect(
  stageScript.includes("source-bundle.tar.gz") &&
    stageScript.includes("circuits/NOTICE.txt") &&
    stageScript.includes("licenses/LGPL-3.0.txt") &&
    webPackage.scripts?.build?.includes("stage-stellar-private-payments.mjs"),
  "the distributed circuit artifacts lost their notices, corresponding source or build staging gate",
);

const runtimeIdentities = [
  lock.deployment.aspMembership,
  lock.deployment.aspNonMembership,
  lock.deployment.verifierB,
  lock.deployment.publicKeyRegistry,
  ...lock.deployment.pools.flatMap((pool) => [
    pool.poolContractId,
    pool.tokenContractId,
  ]),
];
for (const value of runtimeIdentities) {
  expect(apiManifest.includes(value), `the API manifest lost deployment identity ${value}`);
}

expect(
  routes.includes('router.get("/private-payments/readiness"') &&
    routes.includes("readStellarPrivatePaymentsReadiness") &&
    workflowRoutes.includes("capabilities:") &&
    workflowRoutes.includes("privatePayments"),
  "the live contract readiness endpoint is not mounted",
);
expect(
  surfaceReport.includes('id: "stellar_private_payments"') &&
    surfaceReport.includes('onchainConfidentiality: "zk_shielded_pool"') &&
    surfaceReport.includes("deposit and withdrawal amounts and addresses remain public") &&
    surfaceReport.includes("unaudited Testnet research alpha"),
  "the machine-readable privacy report no longer states both the real shielded guarantee and its public boundaries",
);
expect(
  lock.claimBoundary.inPoolAmountAndBalancePrivacy === true &&
    lock.claimBoundary.depositAndWithdrawalPublic === true &&
    lock.claimBoundary.privateBridge === false &&
    lock.claimBoundary.privateEvmExecution === false &&
    lock.claimBoundary.usdcPoolDeployed === false &&
    lock.claimBoundary.audited === false &&
    lock.claimBoundary.productionReady === false,
  "the lock file broadened the privacy or maturity claim",
);

if (process.argv.includes("--live")) {
  const { readStellarPrivatePaymentsReadiness } = await import(
    "../apps/api/dist/networks/stellar/privatePaymentsManifest.js"
  );
  const live = await readStellarPrivatePaymentsReadiness();
  expect(
    live.readiness.xlmLifecycle === "available" &&
      live.contracts
        .filter((entry) => entry.requiredForXlmLifecycle)
        .every((entry) => entry.ready),
    "one or more live XLM privacy-pool contracts drifted or disappeared",
  );
}

if (failures.length > 0) {
  console.error("Stellar Private Payments gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Stellar Private Payments gate passed (${process.argv.includes("--live") ? "source, package and live pins" : "source and package pins"}).`,
);
