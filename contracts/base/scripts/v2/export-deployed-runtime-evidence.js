"use strict";

const deployment = require("../../deployments/base-mainnet-v2.json");

if (
  deployment?.network?.chainId !== 8453 ||
  !deployment?.contracts?.intentRouterV2?.address ||
  !deployment?.contracts?.uniswapV2CompatibleAdapter?.address ||
  !deployment?.governance?.governanceSafe?.address ||
  !deployment?.governance?.guardianSafe?.address ||
  !deployment?.governance?.treasurySafe?.address
) {
  throw new Error("KLETIA_V2_DEPLOYMENT_MANIFEST_INVALID");
}

process.env.KLETIA_V2_ROUTER_ADDRESS =
  deployment.contracts.intentRouterV2.address;
if (deployment.governance.mode === "direct_2_of_2_safe") {
  process.env.KLETIA_V2_GOVERNANCE_MODE = "direct_safe";
} else {
  if (!deployment?.governance?.timelock?.address) {
    throw new Error("KLETIA_V2_TIMELOCK_MANIFEST_INVALID");
  }
  process.env.KLETIA_V2_GOVERNANCE_MODE = "timelock";
  process.env.KLETIA_V2_TIMELOCK_ADDRESS =
    deployment.governance.timelock.address;
}
process.env.KLETIA_V2_GOVERNANCE_SAFE =
  deployment.governance.governanceSafe.address;
process.env.KLETIA_V2_GUARDIAN_SAFE =
  deployment.governance.guardianSafe.address;
process.env.KLETIA_V2_TREASURY_SAFE =
  deployment.governance.treasurySafe.address;
process.env.KLETIA_V2_EXPECTED_FEE_BPS = String(
  deployment.contracts.intentRouterV2.feeBps,
);
process.env.KLETIA_V2_ADAPTERS_JSON = JSON.stringify([
  {
    kind: "uniswap_v2_compatible",
    protocolId: "uniswap",
    adapter:
      deployment.contracts.uniswapV2CompatibleAdapter.address,
  },
]);

const { main } = require("./export-runtime-evidence.js");

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "unknown evidence failure";
  console.error(message.replace(/[\r\n]+/gu, " ").slice(0, 500));
  process.exitCode = 1;
});
