import {
  STELLAR_POLICY_REGISTRY_CONTRACT,
  STELLAR_POLICY_REGISTRY_ENABLED,
  STELLAR_TESTNET,
} from "./config.js";

export const STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256 =
  "723d052be3e3f2585050337607fc3c010f18395825bf434693e863a81d27319d" as const;

export const STELLAR_POLICY_REGISTRY_MANIFEST_SCHEMA =
  "kletia_stellar_policy_registry_release_v1" as const;

/**
 * Source-release identity for Kletia's optional policy receipt registry.
 *
 * This is deliberately not a deployment manifest. Until a valid contract ID
 * is configured and its live executable matches the reviewed release hash,
 * runtime readiness remains closed.
 */
export const STELLAR_POLICY_REGISTRY_RELEASE = Object.freeze({
  schemaVersion: STELLAR_POLICY_REGISTRY_MANIFEST_SCHEMA,
  capability: "opaque_owner_authorized_commitment_registry" as const,
  network: STELLAR_TESTNET.id,
  networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  sourcePackage: "contracts/stellar/policy-receipt-registry",
  sourceLicense: "MIT" as const,
  expectedExecutable: "wasm" as const,
  expectedWasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
  sourceStatus: "source_ready" as const,
  custody: false as const,
  ownerAuthorizationRequired: true as const,
  provesReceiptPreimage: false as const,
  provesExternalExecution: false as const,
  providesConfidentiality: false as const,
  limitations: Object.freeze([
    "A matching executable WASM hash proves bytecode identity only; it is not a security audit or a proof of correct integration.",
    "A finalized receipt hash proves only that the record owner authorized that opaque hash.",
    "The registry stores public durable linkage and does not provide privacy, custody, settlement, bridge or protocol verification.",
  ]),
});

export function readStellarPolicyRegistryManifest() {
  return {
    ...STELLAR_POLICY_REGISTRY_RELEASE,
    deployment: {
      capabilityEnabled: STELLAR_POLICY_REGISTRY_ENABLED,
      configurationStatus:
        STELLAR_POLICY_REGISTRY_CONTRACT.configurationStatus,
      contractId: STELLAR_POLICY_REGISTRY_CONTRACT.contractId,
      status:
        STELLAR_POLICY_REGISTRY_CONTRACT.configurationStatus ===
        "not_configured"
          ? ("source_ready_not_deployed" as const)
          : STELLAR_POLICY_REGISTRY_CONTRACT.configurationStatus === "invalid"
            ? ("invalid_configuration" as const)
            : STELLAR_POLICY_REGISTRY_ENABLED
              ? ("configured_pending_live_attestation" as const)
              : ("configured_disabled" as const),
    },
  };
}
