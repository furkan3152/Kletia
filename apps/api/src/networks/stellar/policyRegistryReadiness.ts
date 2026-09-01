import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  STELLAR_POLICY_REGISTRY_CONTRACT,
  STELLAR_POLICY_REGISTRY_ENABLED,
  STELLAR_TESTNET,
} from "./config.js";
import {
  STELLAR_POLICY_REGISTRY_RELEASE,
  STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
  readStellarPolicyRegistryManifest,
} from "./policyRegistryManifest.js";

export const STELLAR_POLICY_REGISTRY_READINESS_SCHEMA =
  "kletia_stellar_policy_registry_readiness_v1" as const;

export type StellarPolicyRegistryReadinessStatus =
  | "source_ready_not_deployed"
  | "invalid_configuration"
  | "configured_disabled"
  | "rpc_unobservable"
  | "network_mismatch"
  | "contract_unavailable"
  | "unexpected_executable"
  | "wasm_hash_mismatch"
  | "ready";

export type LiveExecutableObservation = {
  readonly networkPassphrase: string;
  readonly latestLedger: number;
  readonly observedExecutable: "wasm" | "stellar_asset" | "unknown";
  readonly observedWasmSha256: string | null;
};

class PolicyRegistryObservationError extends Error {
  constructor(
    readonly readinessStatus: "rpc_unobservable" | "contract_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PolicyRegistryObservationError";
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readExecutable(entryVal: xdr.LedgerEntryData): {
  observedExecutable: LiveExecutableObservation["observedExecutable"];
  observedWasmSha256: string | null;
} {
  try {
    if (entryVal.type !== "contractData") {
      return { observedExecutable: "unknown", observedWasmSha256: null };
    }
    const value = entryVal.contractData.val;
    if (value.type !== "scvContractInstance") {
      return { observedExecutable: "unknown", observedWasmSha256: null };
    }
    const executable = value.instance.executable;
    if (executable.type === "contractExecutableWasm") {
      return {
        observedExecutable: "wasm",
        observedWasmSha256: bytesToHex(executable.wasmHash.toBytes()),
      };
    }
    if (executable.type === "contractExecutableStellarAsset") {
      return {
        observedExecutable: "stellar_asset",
        observedWasmSha256: null,
      };
    }
  } catch {
    // Unknown XDR shapes are quarantined below rather than guessed.
  }
  return { observedExecutable: "unknown", observedWasmSha256: null };
}

function report(input: {
  status: StellarPolicyRegistryReadinessStatus;
  ready?: boolean;
  reason: string;
  observation?: LiveExecutableObservation | null;
}) {
  return {
    schemaVersion: STELLAR_POLICY_REGISTRY_READINESS_SCHEMA,
    capability: STELLAR_POLICY_REGISTRY_RELEASE.capability,
    enabled: STELLAR_POLICY_REGISTRY_ENABLED,
    ready: input.ready === true,
    status: input.status,
    reason: input.reason,
    contractId: STELLAR_POLICY_REGISTRY_CONTRACT.contractId,
    expectedExecutable: STELLAR_POLICY_REGISTRY_RELEASE.expectedExecutable,
    expectedWasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
    observedExecutable:
      input.observation?.observedExecutable ?? null,
    observedWasmSha256:
      input.observation?.observedWasmSha256 ?? null,
    observedAtLedger:
      input.observation?.latestLedger === undefined
        ? null
        : String(input.observation.latestLedger),
    network: STELLAR_TESTNET.id,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    ownerAuthorizationRequired: true as const,
    custody: false as const,
    provesExternalExecution: false as const,
    providesConfidentiality: false as const,
  };
}

export async function observeLiveExecutable(
  contractId: string,
): Promise<LiveExecutableObservation> {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl);
  let health: Awaited<ReturnType<typeof server.getHealth>>;
  let network: Awaited<ReturnType<typeof server.getNetwork>>;
  try {
    [health, network] = await Promise.all([
      server.getHealth(),
      server.getNetwork(),
    ]);
  } catch {
    throw new PolicyRegistryObservationError(
      "rpc_unobservable",
      "Stellar RPC health or network identity could not be observed.",
    );
  }
  if (health.status !== "healthy") {
    throw new PolicyRegistryObservationError(
      "rpc_unobservable",
      "Stellar RPC did not report a healthy status.",
    );
  }
  if (network.passphrase !== STELLAR_TESTNET.networkPassphrase) {
    return {
      networkPassphrase: network.passphrase,
      latestLedger: health.latestLedger,
      observedExecutable: "unknown",
      observedWasmSha256: null,
    };
  }
  let entry: Awaited<ReturnType<typeof server.getContractData>>;
  try {
    entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
    );
  } catch {
    throw new PolicyRegistryObservationError(
      "contract_unavailable",
      "The configured contract instance could not be read.",
    );
  }
  const executable = readExecutable(entry.val);
  return {
    networkPassphrase: network.passphrase,
    latestLedger: health.latestLedger,
    ...executable,
  };
}

/**
 * Reports policy-registry capability readiness without enabling any execution
 * or signing path. The feature opens only when the operator enabled it, the
 * configured target is a valid Stellar contract ID, the RPC is Testnet, and
 * the live executable hash exactly matches the reviewed release artifact.
 */
export async function readStellarPolicyRegistryReadiness() {
  const manifest = readStellarPolicyRegistryManifest();
  if (
    STELLAR_POLICY_REGISTRY_CONTRACT.configurationStatus === "not_configured"
  ) {
    return {
      ...report({
        status: "source_ready_not_deployed",
        reason:
          "The reviewed source artifact is ready, but no Stellar Testnet contract ID is configured or claimed as deployed.",
      }),
      manifest,
    };
  }
  if (STELLAR_POLICY_REGISTRY_CONTRACT.configurationStatus === "invalid") {
    return {
      ...report({
        status: "invalid_configuration",
        reason:
          "STELLAR_POLICY_REGISTRY_CONTRACT_ID was rejected because it is not a valid Stellar contract ID.",
      }),
      manifest,
    };
  }
  if (!STELLAR_POLICY_REGISTRY_ENABLED) {
    return {
      ...report({
        status: "configured_disabled",
        reason:
          "A valid contract ID is configured, but the policy registry capability flag is disabled.",
      }),
      manifest,
    };
  }

  let observation: LiveExecutableObservation;
  try {
    observation = await observeLiveExecutable(
      STELLAR_POLICY_REGISTRY_CONTRACT.contractId,
    );
  } catch (error) {
    const status =
      error instanceof PolicyRegistryObservationError
        ? error.readinessStatus
        : "rpc_unobservable";
    return {
      ...report({
        status,
        reason:
          status === "contract_unavailable"
            ? "The configured policy registry contract instance could not be read from Stellar Testnet RPC."
            : "Stellar RPC health or network identity could not be observed, so no deployment claim is made.",
      }),
      manifest,
    };
  }
  if (observation.networkPassphrase !== STELLAR_TESTNET.networkPassphrase) {
    return {
      ...report({
        status: "network_mismatch",
        reason:
          "The configured Stellar RPC is not bound to the reviewed Testnet network passphrase.",
        observation,
      }),
      manifest,
    };
  }
  if (observation.observedExecutable !== "wasm") {
    return {
      ...report({
        status: "unexpected_executable",
        reason:
          "The configured contract does not expose the reviewed WASM executable shape.",
        observation,
      }),
      manifest,
    };
  }
  if (
    observation.observedWasmSha256 !==
    STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256
  ) {
    return {
      ...report({
        status: "wasm_hash_mismatch",
        reason:
          "The live executable hash does not match the reviewed policy registry release artifact.",
        observation,
      }),
      manifest,
    };
  }
  return {
    ...report({
      status: "ready",
      ready: true,
      reason:
        "The capability flag is enabled and the live Stellar Testnet executable matches the reviewed release artifact.",
      observation,
    }),
    manifest,
  };
}

export async function assertStellarPolicyRegistryReady() {
  const readiness = await readStellarPolicyRegistryReadiness();
  if (!readiness.ready || readiness.status !== "ready" || !readiness.contractId) {
    throw Object.assign(
      new Error(
        `The optional Stellar public policy registry is not ready (${readiness.status}). ${readiness.reason}`,
      ),
      {
        code: "STELLAR_POLICY_REGISTRY_NOT_READY",
        statusCode: 503,
        policyRegistryReadiness: readiness,
      },
    );
  }
  return {
    ...readiness,
    ready: true as const,
    status: "ready" as const,
    contractId: readiness.contractId,
  };
}
