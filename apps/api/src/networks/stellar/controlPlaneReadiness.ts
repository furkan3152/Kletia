import {
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "./config.js";
import {
  observeLiveExecutable,
  type LiveExecutableObservation,
} from "./policyRegistryReadiness.js";
import { STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256 } from "./policyRegistryManifest.js";

export const STELLAR_CONTROL_PLANE_RELEASES = Object.freeze({
  intentControlPlane: Object.freeze({
    environmentVariable: "STELLAR_INTENT_CONTROL_PLANE_TESTNET_CONTRACT_ID",
    wasmSha256: "7aa98ece040fb218b1ae2f3c700b56a7a9148cc2df16bdb71e583033517a86cc",
  }),
  policyVerifierRegistry: Object.freeze({
    environmentVariable: "STELLAR_POLICY_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID",
    wasmSha256: "c41a359868affc11f094390fe67faeb5711d767657ab5ec37932184b7f061114",
  }),
  policyReceiptRegistry: Object.freeze({
    environmentVariable: "STELLAR_POLICY_RECEIPT_REGISTRY_TESTNET_CONTRACT_ID",
    wasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
  }),
});

export const STELLAR_POLICY_CIRCUIT_RELEASE = Object.freeze({
  circuitSha256: "32743de76874a5d2c0c38ed5b338ae2230678f7c42a98874bd49b46436384272",
  publicInputSchemaSha256: "97956c27bb4e05410cfa933375241d9db7e0c3e429cf13eb67ffa94b3f81b143",
  publicInputCount: 9,
  laneInputIndex: 5,
  expiryLedgerInputIndex: 6,
});

export const STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256 =
  "fb6bcb8fc8492e38b31da3318fb48bcb3a1291bafb83ca201f894a4ee9f5a138";

export const STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE =
  "testnet_development" as const;

export const STELLAR_CONTROL_PLANE_DEPLOYMENT_MANIFEST =
  "contracts/stellar/deployments/testnet/control-plane.v1.json" as const;

type ReleaseKey = keyof typeof STELLAR_CONTROL_PLANE_RELEASES;

type PolicyVerifierArtifactConfiguration = {
  readonly profile: typeof STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE;
  readonly version: number;
  readonly readSourceAccount: string;
  readonly verifierContractId: string;
  readonly verifierWasmSha256: string;
  readonly verificationKeySha256: string;
};

function configuredContract(key: ReleaseKey): string {
  return process.env[STELLAR_CONTROL_PLANE_RELEASES[key].environmentVariable]?.trim() || "";
}

function normalizedSha256(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || "";
  return /^[a-f0-9]{64}$/u.test(normalized) && normalized !== "0".repeat(64)
    ? normalized
    : "";
}

function policyVerifierArtifactConfiguration():
  | PolicyVerifierArtifactConfiguration
  | null {
  const profile = process.env.STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE?.trim();
  const version = Number(process.env.STELLAR_POLICY_VERIFIER_VERSION?.trim() || "");
  const readSourceAccount =
    process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  const verifierContractId =
    process.env.STELLAR_POLICY_GENERATED_VERIFIER_TESTNET_CONTRACT_ID?.trim() || "";
  const verifierWasmSha256 = normalizedSha256(
    process.env.STELLAR_POLICY_GENERATED_VERIFIER_WASM_SHA256,
  );
  const verificationKeySha256 = normalizedSha256(
    process.env.STELLAR_POLICY_VERIFICATION_KEY_SHA256,
  );
  if (
    profile !== STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE ||
    !Number.isSafeInteger(version) ||
    version <= 0 ||
    !StrKey.isValidEd25519PublicKey(readSourceAccount) ||
    !StrKey.isValidContract(verifierContractId) ||
    !verifierWasmSha256 ||
    verifierWasmSha256 !== STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256 ||
    !verificationKeySha256
  ) {
    return null;
  }
  return {
    profile,
    version,
    readSourceAccount,
    verifierContractId,
    verifierWasmSha256,
    verificationKeySha256,
  };
}

export function isStellarPolicyVerifierArtifactConfigurationComplete(): boolean {
  return policyVerifierArtifactConfiguration() !== null;
}

function bytes32Hex(value: unknown): string | null {
  return value instanceof Uint8Array && value.length === 32
    ? Buffer.from(value).toString("hex")
    : null;
}

async function observeRegisteredPolicyVerifier(input: {
  readonly registryContractId: string;
  readonly artifact: PolicyVerifierArtifactConfiguration;
}) {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 8_000 });
  const account = await server.getAccount(input.artifact.readSourceAccount);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(
      new Contract(input.registryContractId).call(
        "get",
        nativeToScVal(input.artifact.version, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw new Error("The exact policy-verifier registry record could not be simulated.");
  }
  const value = scValToNative(simulation.result.retval) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The configured policy-verifier version is not registered.");
  }
  const record = value as Record<string, unknown>;
  const observed = Object.freeze({
    version: Number(record.version),
    verifierContractId: String(record.verifier ?? ""),
    verificationKeySha256: bytes32Hex(record.vk_hash),
    circuitSha256: bytes32Hex(record.circuit_hash),
    publicInputSchemaSha256: bytes32Hex(record.public_input_schema_hash),
    publicInputCount: Number(record.public_input_count),
    laneInputIndex: Number(record.lane_input_index),
    expiryLedgerInputIndex: Number(record.expiry_ledger_input_index),
    enabled: record.enabled === true,
    observedAtLedger: String(simulation.latestLedger),
  });
  const release = STELLAR_POLICY_CIRCUIT_RELEASE;
  const ready = Boolean(
    observed.enabled &&
      observed.version === input.artifact.version &&
      observed.verifierContractId === input.artifact.verifierContractId &&
      observed.verificationKeySha256 === input.artifact.verificationKeySha256 &&
      observed.circuitSha256 === release.circuitSha256 &&
      observed.publicInputSchemaSha256 === release.publicInputSchemaSha256 &&
      observed.publicInputCount === release.publicInputCount &&
      observed.laneInputIndex === release.laneInputIndex &&
      observed.expiryLedgerInputIndex === release.expiryLedgerInputIndex,
  );
  return Object.freeze({ ...observed, ready });
}

async function observeIntentControlPlaneVerifierRegistry(input: {
  readonly intentControlPlaneContractId: string;
  readonly expectedVerifierRegistryContractId: string;
  readonly readSourceAccount: string;
}) {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 8_000 });
  const account = await server.getAccount(input.readSourceAccount);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(input.intentControlPlaneContractId).call("verifier_registry"))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw new Error("The intent control plane verifier-registry binding could not be simulated.");
  }
  const observedContractId = String(scValToNative(simulation.result.retval) ?? "");
  return Object.freeze({
    expectedContractId: input.expectedVerifierRegistryContractId,
    observedContractId,
    observedAtLedger: String(simulation.latestLedger),
    ready: observedContractId === input.expectedVerifierRegistryContractId,
  });
}

function observationVerdict(
  key: ReleaseKey,
  contractId: string,
  observation: LiveExecutableObservation | null,
) {
  const release = STELLAR_CONTROL_PLANE_RELEASES[key];
  const ready = Boolean(
    observation &&
    observation.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
    observation.observedExecutable === "wasm" &&
    observation.observedWasmSha256 === release.wasmSha256,
  );
  return Object.freeze({
    key,
    contractId: contractId || null,
    expectedWasmSha256: release.wasmSha256,
    observedWasmSha256: observation?.observedWasmSha256 ?? null,
    observedAtLedger: observation ? String(observation.latestLedger) : null,
    ready,
  });
}

export async function readStellarControlPlaneReadiness(
  lane: "production" | "testnet",
) {
  if (lane !== "testnet") {
    return Object.freeze({
      schemaVersion: "kletia_stellar_control_plane_readiness_v1" as const,
      lane,
      ready: false,
      status: "mainnet_disabled" as const,
      reason: "Stellar Mainnet control-plane execution is not released.",
      artifactProfile: null,
      productionReady: false as const,
      deploymentManifest: STELLAR_CONTROL_PLANE_DEPLOYMENT_MANIFEST,
      contracts: [],
      provesExternalExecution: false as const,
    });
  }

  const enabled = process.env.STELLAR_INTENT_CONTROL_PLANE_ENABLED?.trim() === "true";
  const artifactsReady = process.env.STELLAR_POLICY_VERIFIER_ARTIFACTS_READY?.trim() === "true";
  const artifactProfile = process.env.STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE?.trim() || "";
  const artifactProfileValid =
    artifactProfile === STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE;
  const policyArtifact = policyVerifierArtifactConfiguration();
  const entries = (Object.keys(STELLAR_CONTROL_PLANE_RELEASES) as ReleaseKey[]).map((key) => ({
    key,
    contractId: configuredContract(key),
  }));
  const configurationValid = entries.every(({ contractId }) => StrKey.isValidContract(contractId));

  if (
    !enabled ||
    !artifactsReady ||
    !artifactProfileValid ||
    !configurationValid ||
    !policyArtifact
  ) {
    return Object.freeze({
      schemaVersion: "kletia_stellar_control_plane_readiness_v1" as const,
      lane,
      ready: false,
      status: !enabled
        ? "disabled" as const
        : !artifactsReady
          ? "verifier_artifacts_unavailable" as const
          : !artifactProfileValid
            ? "verifier_artifact_profile_invalid" as const
          : !configurationValid
            ? "contract_configuration_invalid" as const
            : "verifier_artifact_configuration_invalid" as const,
      reason: !enabled
        ? "The deploy-last control-plane flag is disabled."
        : !artifactsReady
          ? "Reproducible policy verifier artifacts are not marked ready."
          : !artifactProfileValid
            ? "The exact Testnet-development verifier artifact profile is required and cannot be promoted to Mainnet."
          : !configurationValid
            ? "All exact Stellar Testnet contract IDs are required."
            : "The exact verifier version, read source account, verifier contract, verifier WASM hash and VK hash are required.",
      contracts: entries.map(({ key, contractId }) => observationVerdict(key, contractId, null)),
      artifactProfile: artifactProfile || null,
      productionReady: false as const,
      deploymentManifest: STELLAR_CONTROL_PLANE_DEPLOYMENT_MANIFEST,
      policyVerifier: null,
      provesExternalExecution: false as const,
    });
  }

  const observations = await Promise.all(
    entries.map(async ({ key, contractId }) => {
      try {
        return observationVerdict(key, contractId, await observeLiveExecutable(contractId));
      } catch {
        return observationVerdict(key, contractId, null);
      }
    }),
  );
  let policyVerifier: Awaited<ReturnType<typeof observeRegisteredPolicyVerifier>> | null = null;
  let generatedVerifierExecutable: {
    readonly contractId: string;
    readonly expectedWasmSha256: string;
    readonly observedWasmSha256: string | null;
    readonly observedAtLedger: string;
    readonly ready: boolean;
  } | null = null;
  let intentControlPlaneBinding: Awaited<ReturnType<typeof observeIntentControlPlaneVerifierRegistry>> | null = null;
  try {
    policyVerifier = await observeRegisteredPolicyVerifier({
      registryContractId: configuredContract("policyVerifierRegistry"),
      artifact: policyArtifact,
    });
    const executable = await observeLiveExecutable(policyArtifact.verifierContractId);
    generatedVerifierExecutable = Object.freeze({
      contractId: policyArtifact.verifierContractId,
      expectedWasmSha256: policyArtifact.verifierWasmSha256,
      observedWasmSha256: executable.observedWasmSha256,
      observedAtLedger: String(executable.latestLedger),
      ready: Boolean(
        executable.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
          executable.observedExecutable === "wasm" &&
          executable.observedWasmSha256 === policyArtifact.verifierWasmSha256,
      ),
    });
  } catch {
    policyVerifier = null;
    generatedVerifierExecutable = null;
  }
  try {
    intentControlPlaneBinding = await observeIntentControlPlaneVerifierRegistry({
      intentControlPlaneContractId: configuredContract("intentControlPlane"),
      expectedVerifierRegistryContractId: configuredContract("policyVerifierRegistry"),
      readSourceAccount: policyArtifact.readSourceAccount,
    });
  } catch {
    intentControlPlaneBinding = null;
  }
  const ready = Boolean(
    observations.every((entry) => entry.ready) &&
      policyVerifier?.ready &&
      generatedVerifierExecutable?.ready &&
      intentControlPlaneBinding?.ready,
  );
  return Object.freeze({
    schemaVersion: "kletia_stellar_control_plane_readiness_v1" as const,
    lane,
    ready,
    status: ready ? "ready" as const : "live_artifact_mismatch" as const,
    reason: ready
      ? "All Testnet control-plane executables, the active registry record and the circuit-bound verifier match the pinned development release. This is not a production trusted setup."
      : "A live executable, active registry record, circuit/VK binding or circuit-bound verifier did not match the reviewed release artifacts.",
    artifactProfile: STELLAR_POLICY_VERIFIER_ARTIFACT_PROFILE,
    productionReady: false as const,
    deploymentManifest: STELLAR_CONTROL_PLANE_DEPLOYMENT_MANIFEST,
    contracts: observations,
    policyVerifier,
    generatedVerifierExecutable,
    intentControlPlaneBinding,
    provesExternalExecution: false as const,
  });
}
