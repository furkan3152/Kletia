/**
 * Documentary runtime truth for Stellar's Confidential Token developer preview.
 *
 * This is deliberately separate from `protocolManifest.ts`: the contract IDs
 * below belong to the upstream native-XLM demo, not to Kletia, and therefore
 * must never become transaction targets or execution pins by being listed here.
 * The release gate keeps this metadata byte-for-byte aligned with
 * `contracts/stellar/upstream.lock.json`.
 */

export const STELLAR_CONFIDENTIAL_REFERENCE_MANIFEST = Object.freeze({
  schemaVersion: "kletia_stellar_confidential_reference_manifest_v1" as const,
  upstreamStatus: "working_unaudited_stellar_testnet_reference" as const,
  kletiaRuntimeStatus: "integration_incomplete_non_signable" as const,
  testnetEvaluationAllowed: true as const,
  deploymentAllowed: false as const,
  signableRuntimeAllowed: false as const,
  mainlineReference: Object.freeze({
    commit: "fbfde388e1b72afa93d6b1c922067879b20e81db",
    defaultVerifierStatus: "unfinished_interface_at_pin" as const,
  }),
  workingReference: Object.freeze({
    demoRepository: "https://github.com/brozorec/stellar-confidential-token-demo",
    demoCommit: "9500ed774b13b08b5fe99370b60de3479edb492b",
    openZeppelinFeatureTipObserved:
      "98090b3e59785454f55b3617992c2f84250c7173",
    openZeppelinCommitPinnedByDemo:
      "539968f158e0d779f584de2821090f715a3b25e1",
    nethermindUltraHonkCommitPinnedByDemo:
      "661db07200f890b1bd9a7349ed787c70a706dd12",
    network: "stellar_testnet" as const,
    underlyingAsset: "native_xlm" as const,
    confidentialTokenContractId:
      "CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F",
    verifierContractId:
      "CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL",
    auditorContractId:
      "CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L",
    underlyingSacContractId:
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    identityStatus: "reference_declared_not_kletia_runtime_pin" as const,
  }),
  missingKletiaEvidence: Object.freeze([
    "pinned_holder_sdk_and_browser_prover",
    "reproducible_kletia_usdc_wrapper_verifier_and_auditor_wasm",
    "kletia_specific_auditor_key_and_administration_policy",
    "canonical_event_archive_and_clean_device_recovery",
    "adversarial_proof_replay_recovery_and_egress_tests",
    "real_user_signed_stellar_testnet_lifecycle",
  ] as const),
  claimBoundary: Object.freeze({
    confidentialRouteSignable: false as const,
    kletiaConfidentialContractsDeployed: false as const,
    audited: false as const,
    mainnetReady: false as const,
    productionReady: false as const,
    realAssetSecurityClaim: false as const,
    publicDepositWithdrawalAndAddressMetadataRemainVisible: true as const,
  }),
  reason:
    "The official developer preview proves that a Testnet implementation exists; it does not supply Kletia with a pinned holder runtime, a Kletia-specific USDC deployment, safe auditor material, recovery evidence or a signable confidential route.",
});

export function readStellarConfidentialReferenceManifest() {
  return STELLAR_CONFIDENTIAL_REFERENCE_MANIFEST;
}
