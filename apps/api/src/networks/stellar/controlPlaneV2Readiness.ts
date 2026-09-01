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
import { observeLiveExecutable } from "./policyRegistryReadiness.js";
import {
  STELLAR_CONTROL_PLANE_RELEASES,
  STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256,
} from "./controlPlaneReadiness.js";

export const STELLAR_CONTROL_PLANE_V2_RELEASE = Object.freeze({
  controlPlaneWasmSha256: "865c18119424356c42b35301bbb9b926e24c15fc44956c08853a929245f87249",
  registryWasmSha256: STELLAR_CONTROL_PLANE_RELEASES.policyVerifierRegistry.wasmSha256,
  verifierWasmSha256: STELLAR_POLICY_GROTH16_VERIFIER_RELEASE_WASM_SHA256,
  circuitSha256: "6dbb3e6247265135e66e7614c1fbac2ace437928c07abbd8fd9fe8a402e4eb70",
  publicInputSchemaSha256: "db64a625e6d7b8b89deee9b8b0aa606d1f054b5b71b5f40c27234c66142f1866",
  r1csSha256: "fe7e0cafdda02d637c0852a94708b11fc6a7f051d6a563519a85a9640cac8495",
  proverWasmSha256: "f13d9dc4e1ee86fd432a45d9696c91122d8beef3906687acb6a84d1b311115a5",
  provingKeySha256: "797054251bab3165a7cdc868d81027b306462e9e181c97db8ec4238344d2b52a",
  verificationKeySha256: "c4b6f6eb1a6b845c587cb3481461d0a710cac76702265fc2608ff94ad61a78f8",
  publicInputCount: 12,
  laneInputIndex: 8,
  expiryLedgerInputIndex: 9,
  verifierVersion: 2,
});

function bytes32Hex(value: unknown): string | null {
  return value instanceof Uint8Array && value.length === 32
    ? Buffer.from(value).toString("hex")
    : null;
}

function sha256(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-f\d]{64}$/u.test(normalized) && normalized !== "0".repeat(64) ? normalized : "";
}

function configuration() {
  const controlPlane = process.env.STELLAR_INTENT_CONTROL_PLANE_V2_TESTNET_CONTRACT_ID?.trim() || "";
  const registry = process.env.STELLAR_POLICY_V2_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID?.trim() || "";
  const verifier = process.env.STELLAR_POLICY_V2_VERIFIER_TESTNET_CONTRACT_ID?.trim() || "";
  const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  const vkHash = sha256(process.env.STELLAR_POLICY_V2_VERIFICATION_KEY_SHA256);
  const version = Number(process.env.STELLAR_POLICY_V2_VERIFIER_VERSION?.trim() || "");
  return {
    enabled: process.env.STELLAR_INTENT_CONTROL_PLANE_V2_ENABLED?.trim() === "true",
    artifactsReady: process.env.STELLAR_POLICY_V2_ARTIFACTS_READY?.trim() === "true",
    controlPlane,
    registry,
    verifier,
    source,
    vkHash,
    version,
    valid:
      StrKey.isValidContract(controlPlane) &&
      StrKey.isValidContract(registry) &&
      StrKey.isValidContract(verifier) &&
      StrKey.isValidEd25519PublicKey(source) &&
      vkHash.length === 64 &&
      vkHash === STELLAR_CONTROL_PLANE_V2_RELEASE.verificationKeySha256 &&
      version === STELLAR_CONTROL_PLANE_V2_RELEASE.verifierVersion,
  };
}

async function simulateRead(contractId: string, source: string, method: string, ...args: ReturnType<typeof nativeToScVal>[]) {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 10_000 });
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  }).addOperation(new Contract(contractId).call(method, ...args)).setTimeout(60).build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation) || !simulation.result) {
    throw new Error(`${method} could not be simulated on the configured Stellar Testnet contract.`);
  }
  return { value: scValToNative(simulation.result.retval) as unknown, ledger: String(simulation.latestLedger) };
}

export async function readStellarControlPlaneV2Readiness() {
  const config = configuration();
  const base = {
    schemaVersion: "kletia_stellar_control_plane_v2_readiness" as const,
    lane: "testnet" as const,
    release: STELLAR_CONTROL_PLANE_V2_RELEASE,
    productionReady: false as const,
    provesExternalExecution: false as const,
  };
  if (!config.enabled || !config.artifactsReady || !config.valid) {
    return Object.freeze({
      ...base,
      ready: false,
      status: !config.enabled
        ? "disabled" as const
        : !config.artifactsReady
          ? "artifacts_unavailable" as const
          : "configuration_invalid" as const,
      reason: "Policy V2 execution requires exact Testnet contract IDs, verifier version 2, a VK hash, a read source account and explicit artifact readiness.",
      configuration: {
        controlPlane: config.controlPlane || null,
        registry: config.registry || null,
        verifier: config.verifier || null,
        verifierVersion: config.version || null,
      },
      observations: null,
    });
  }
  try {
    const [controlExecutable, registryExecutable, verifierExecutable, registryRecord, controlBinding, verifierMetadata] = await Promise.all([
      observeLiveExecutable(config.controlPlane),
      observeLiveExecutable(config.registry),
      observeLiveExecutable(config.verifier),
      simulateRead(config.registry, config.source, "get", nativeToScVal(config.version, { type: "u32" })),
      simulateRead(config.controlPlane, config.source, "verifier_registry"),
      simulateRead(config.verifier, config.source, "metadata"),
    ]);
    const record = registryRecord.value && typeof registryRecord.value === "object" && !Array.isArray(registryRecord.value)
      ? registryRecord.value as Record<string, unknown>
      : {};
    const metadata = verifierMetadata.value && typeof verifierMetadata.value === "object" && !Array.isArray(verifierMetadata.value)
      ? verifierMetadata.value as Record<string, unknown>
      : {};
    const release = STELLAR_CONTROL_PLANE_V2_RELEASE;
    const ready = Boolean(
      controlExecutable.observedExecutable === "wasm" &&
      controlExecutable.observedWasmSha256 === release.controlPlaneWasmSha256 &&
      registryExecutable.observedExecutable === "wasm" &&
      registryExecutable.observedWasmSha256 === release.registryWasmSha256 &&
      verifierExecutable.observedExecutable === "wasm" &&
      verifierExecutable.observedWasmSha256 === release.verifierWasmSha256 &&
      String(controlBinding.value ?? "") === config.registry &&
      Number(record.version) === config.version &&
      String(record.verifier ?? "") === config.verifier &&
      bytes32Hex(record.vk_hash) === release.verificationKeySha256 &&
      bytes32Hex(record.circuit_hash) === release.circuitSha256 &&
      bytes32Hex(record.public_input_schema_hash) === release.publicInputSchemaSha256 &&
      Number(record.public_input_count) === release.publicInputCount &&
      Number(record.lane_input_index) === release.laneInputIndex &&
      Number(record.expiry_ledger_input_index) === release.expiryLedgerInputIndex &&
      record.enabled === true &&
      bytes32Hex(metadata.vk_hash) === release.verificationKeySha256 &&
      Number(metadata.public_input_count) === release.publicInputCount
    );
    return Object.freeze({
      ...base,
      ready,
      status: ready ? "ready" as const : "live_artifact_mismatch" as const,
      reason: ready
        ? "The Policy V2 circuit, registry record, immutable verifier key and Intent Control Plane V2 executable match the pinned Testnet release."
        : "At least one live Policy V2 executable, registry field, verifier key or control-plane binding differs from the pinned release.",
      configuration: {
        controlPlane: config.controlPlane,
        registry: config.registry,
        verifier: config.verifier,
        verifierVersion: config.version,
      },
      observations: {
        controlPlaneWasmSha256: controlExecutable.observedWasmSha256,
        registryWasmSha256: registryExecutable.observedWasmSha256,
        verifierWasmSha256: verifierExecutable.observedWasmSha256,
        registryLedger: registryRecord.ledger,
        bindingLedger: controlBinding.ledger,
        verifierMetadataLedger: verifierMetadata.ledger,
      },
    });
  } catch {
    return Object.freeze({
      ...base,
      ready: false,
      status: "observation_failed" as const,
      reason: "The Policy V2 live executable and registry observations could not all be completed.",
      configuration: {
        controlPlane: config.controlPlane,
        registry: config.registry,
        verifier: config.verifier,
        verifierVersion: config.version,
      },
      observations: null,
    });
  }
}
