import { Asset, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET } from "./config.js";

/**
 * StellarProtocolManifestV1
 *
 * A release claim about a Soroban contract is only honest while the deployed
 * bytecode behind that contract identity is the bytecode Kletia reviewed.
 * Soroban contracts can be upgraded in place, so a stable contract ID is not a
 * stable execution surface. This module pins the identity *and* the observed
 * executable, then quarantines any capability whose executable drifted.
 *
 * Deliberate limitations, kept explicit so the manifest is not over-read:
 * - A matching WASM hash proves the bytecode did not change. It does not prove
 *   the bytecode is safe, audited, or economically correct.
 * - An unpinned contract is reported as `observed_unpinned`, never as verified.
 * - Stellar Testnet resets invalidate every pin; the epoch below must be bumped
 *   and every hash re-observed before a release claim is renewed.
 *
 * The pins live in source (not read from disk at runtime) so a deployed API can
 * never diverge from the reviewed commit. `tooling/verify-stellar-mvp.mjs`
 * asserts this table stays identical to `contracts/stellar/protocol.lock.json`.
 */

export const STELLAR_PROTOCOL_LOCK_SCHEMA =
  "kletia_stellar_protocol_lock_v1" as const;

export type StellarProtocolRole =
  | "stellar_asset_contract"
  | "read_only_quote_comparison"
  | "official_circle_cctp_v2"
  | "official_circle_cctp_v2_forwarder";

export type StellarExecutableKind = "stellar_asset" | "wasm";

export interface StellarProtocolPin {
  readonly key: string;
  readonly contractId: string;
  readonly role: StellarProtocolRole;
  readonly expectedExecutable: StellarExecutableKind;
  /** `null` means no operator-reviewed hash exists yet for this contract. */
  readonly pinnedWasmHash: string | null;
  /** Whether a drift here should close a signing surface, not just a read. */
  readonly executionEnabled: boolean;
  readonly provenance: {
    readonly identitySource: string;
    readonly observedAtLedger: string | null;
    readonly observedAt: string | null;
    readonly reviewStatus:
      | "deterministic_stellar_asset"
      | "operator_observed_bytecode_pin"
      | "unreviewed_observation_only";
    readonly sourceCodeReviewed: false;
  };
}

export const STELLAR_PROTOCOL_PINS: readonly StellarProtocolPin[] =
  Object.freeze([
    Object.freeze({
      key: "usdcSac",
      contractId: STELLAR_TESTNET.usdc.sac,
      role: "stellar_asset_contract" as const,
      expectedExecutable: "stellar_asset" as const,
      pinnedWasmHash: null,
      executionEnabled: true,
      provenance: {
        identitySource: "deterministic SAC derived from Circle Testnet USDC code and issuer",
        observedAtLedger: null,
        observedAt: null,
        reviewStatus: "deterministic_stellar_asset" as const,
        sourceCodeReviewed: false as const,
      },
    }),
    Object.freeze({
      key: "aquariusRouter",
      contractId: STELLAR_TESTNET.aquarius.router,
      role: "read_only_quote_comparison" as const,
      expectedExecutable: "wasm" as const,
      pinnedWasmHash: null,
      executionEnabled: false,
      provenance: {
        identitySource: "https://docs.aqua.network/developers/code-examples/prerequisites-and-basics",
        observedAtLedger: "4273629",
        observedAt: "2026-08-22T09:27:16.620Z",
        reviewStatus: "unreviewed_observation_only" as const,
        sourceCodeReviewed: false as const,
      },
    }),
    Object.freeze({
      key: "cctpTokenMessengerMinter",
      contractId: STELLAR_TESTNET.cctp.tokenMessengerMinter,
      role: "official_circle_cctp_v2" as const,
      expectedExecutable: "wasm" as const,
      pinnedWasmHash: "a04c09f4bf064cfafb7e4e931752de15a216af1d59373bdd9d53908e7d29a9fe",
      executionEnabled: true,
      provenance: {
        identitySource: "https://developers.circle.com/cctp/references/stellar-contracts",
        observedAtLedger: "4273629",
        observedAt: "2026-08-22T09:27:16.620Z",
        reviewStatus: "operator_observed_bytecode_pin" as const,
        sourceCodeReviewed: false as const,
      },
    }),
    Object.freeze({
      key: "cctpMessageTransmitter",
      contractId: STELLAR_TESTNET.cctp.messageTransmitter,
      role: "official_circle_cctp_v2" as const,
      expectedExecutable: "wasm" as const,
      pinnedWasmHash: "8927f7389410044b35b1d3d0d7d42ea4ed0677dea18cb1bd89be4a980566c614",
      executionEnabled: true,
      provenance: {
        identitySource: "https://developers.circle.com/cctp/references/stellar-contracts",
        observedAtLedger: "4273629",
        observedAt: "2026-08-22T09:27:16.620Z",
        reviewStatus: "operator_observed_bytecode_pin" as const,
        sourceCodeReviewed: false as const,
      },
    }),
    Object.freeze({
      key: "cctpForwarder",
      contractId: STELLAR_TESTNET.cctp.forwarder,
      role: "official_circle_cctp_v2_forwarder" as const,
      expectedExecutable: "wasm" as const,
      pinnedWasmHash: "caa4d100b5d102c07db3ff08d4c53f1f89562e8bbbf45e8bab593b1d99c1dec5",
      executionEnabled: true,
      provenance: {
        identitySource: "https://developers.circle.com/cctp/references/stellar-contracts",
        observedAtLedger: "4273629",
        observedAt: "2026-08-22T09:27:16.620Z",
        reviewStatus: "operator_observed_bytecode_pin" as const,
        sourceCodeReviewed: false as const,
      },
    }),
  ] as const);

/**
 * Bumped by an operator after a Stellar Testnet reset. Every observation is
 * reported against this epoch so a stale receipt cannot be replayed as current
 * evidence across a network reset boundary.
 */
export const STELLAR_TESTNET_RESET_EPOCH = "2026-08-21" as const;

export type StellarPinObservation =
  | "verified_pinned"
  | "observed_unpinned"
  | "drift_quarantined"
  | "unobservable";

export interface StellarPinReport {
  readonly key: string;
  readonly contractId: string;
  readonly role: StellarProtocolRole;
  readonly expectedExecutable: StellarExecutableKind;
  readonly observedExecutable: StellarExecutableKind | "unknown";
  readonly observedWasmHash: string | null;
  readonly pinnedWasmHash: string | null;
  readonly observation: StellarPinObservation;
  readonly executionEnabled: boolean;
  readonly quarantined: boolean;
  readonly reason: string;
  readonly provenance: StellarProtocolPin["provenance"];
}

export interface StellarProtocolManifestReport {
  readonly schemaVersion: typeof STELLAR_PROTOCOL_LOCK_SCHEMA;
  readonly network: "stellar_testnet";
  readonly networkPassphrase: string;
  readonly testnetResetEpoch: typeof STELLAR_TESTNET_RESET_EPOCH;
  readonly observedAt: string;
  readonly observedAtLedger: string;
  readonly contracts: readonly StellarPinReport[];
  /** True only when no *execution-enabled* capability drifted or vanished. */
  readonly executionSurfaceOpen: boolean;
  readonly quarantinedKeys: readonly string[];
  readonly pinnedCount: number;
  readonly unpinnedCount: number;
  readonly cryptographicSafetyGuaranteed: false;
  readonly limitations: readonly string[];
}

const MANIFEST_LIMITATIONS: readonly string[] = Object.freeze([
  "A matching WASM hash proves the deployed bytecode did not change; it does not prove the bytecode is safe, audited or economically correct.",
  "An unpinned contract is reported as observed_unpinned and is never presented as a verified pin.",
  "Stellar Testnet resets invalidate every pin; the reset epoch must be bumped and every hash re-observed before a release claim is renewed.",
  "This manifest attests deployed bytecode identity only. It does not attest Kletia's own adapter wiring, argument construction or UI bindings.",
]);

function manifestError(code: string, message: string, statusCode = 503): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the contract instance ledger entry and extracts the executable. Any
 * shape we do not recognise is reported as `unknown` rather than coerced, so an
 * unexpected XDR layout can never be mistaken for a verified observation.
 *
 * stellar-sdk v17 exposes XDR unions as discriminated objects. Deliberately use
 * those public discriminants instead of the callable-arm API from SDK v16 and
 * earlier: a version mismatch must quarantine the surface, never make every
 * healthy contract look like drift.
 */
function readExecutable(entryVal: xdr.LedgerEntryData): {
  kind: StellarExecutableKind | "unknown";
  wasmHash: string | null;
} {
  try {
    if (entryVal.type !== "contractData") {
      return { kind: "unknown", wasmHash: null };
    }
    const scVal = entryVal.contractData.val;
    if (scVal.type !== "scvContractInstance") {
      return { kind: "unknown", wasmHash: null };
    }
    const executable = scVal.instance.executable;
    if (executable.type === "contractExecutableStellarAsset") {
      return { kind: "stellar_asset", wasmHash: null };
    }
    if (executable.type === "contractExecutableWasm") {
      return {
        kind: "wasm",
        wasmHash: bytesToHex(executable.wasmHash.toBytes()),
      };
    }
    return { kind: "unknown", wasmHash: null };
  } catch {
    return { kind: "unknown", wasmHash: null };
  }
}

function classify(input: {
  pin: StellarProtocolPin;
  observedExecutable: StellarExecutableKind | "unknown";
  observedWasmHash: string | null;
  observable: boolean;
}): { observation: StellarPinObservation; reason: string } {
  if (!input.observable) {
    return {
      observation: "unobservable",
      reason:
        "The contract instance ledger entry could not be read, so no identity or bytecode claim is made.",
    };
  }
  if (input.observedExecutable === "unknown") {
    return {
      observation: "drift_quarantined",
      reason:
        "The contract instance returned an executable shape Kletia does not recognise; the capability is quarantined instead of guessed.",
    };
  }
  if (input.observedExecutable !== input.pin.expectedExecutable) {
    return {
      observation: "drift_quarantined",
      reason: `Expected a ${input.pin.expectedExecutable} executable but observed ${input.observedExecutable}.`,
    };
  }
  if (input.pin.expectedExecutable === "stellar_asset") {
    return {
      observation: "verified_pinned",
      reason:
        "The ledger reports a native Stellar Asset Contract executable, which is bound to its classic asset by construction and carries no upgradable bytecode.",
    };
  }
  if (!input.pin.pinnedWasmHash) {
    return {
      observation: "observed_unpinned",
      reason:
        "The WASM hash was observed but no operator-reviewed pin exists yet, so this is an observation and not a verified pin.",
    };
  }
  if (input.pin.pinnedWasmHash.toLowerCase() !== (input.observedWasmHash || "")) {
    return {
      observation: "drift_quarantined",
      reason:
        "The deployed WASM hash no longer matches the reviewed pin; the contract was upgraded or replaced.",
    };
  }
  return {
    observation: "verified_pinned",
    reason: "The deployed WASM hash matches the reviewed pin.",
  };
}

/**
 * Verifies that the reviewed USDC Stellar Asset Contract ID is genuinely the
 * deterministic SAC of the reviewed classic `code + issuer`. Without this a
 * malicious contract could be listed under a familiar identity.
 */
export function assertUsdcSacDerivation(): void {
  const derived = new Asset(
    STELLAR_TESTNET.usdc.symbol,
    STELLAR_TESTNET.usdc.issuer,
  ).contractId(Networks.TESTNET);
  if (derived !== STELLAR_TESTNET.usdc.sac) {
    throw manifestError(
      "STELLAR_SAC_DERIVATION_MISMATCH",
      "The configured USDC Stellar Asset Contract is not the deterministic SAC of the reviewed classic asset.",
    );
  }
}

export async function readStellarProtocolManifest(): Promise<StellarProtocolManifestReport> {
  assertUsdcSacDerivation();
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl);
  const [health, entries] = await Promise.all([
    server.getHealth(),
    Promise.all(
      STELLAR_PROTOCOL_PINS.map(async (pin) => {
        try {
          const entry = await server.getContractData(
            pin.contractId,
            xdr.ScVal.scvLedgerKeyContractInstance(),
          );
          return { pin, entry, observable: true as const };
        } catch {
          return { pin, entry: null, observable: false as const };
        }
      }),
    ),
  ]);

  const contracts = entries.map<StellarPinReport>(({ pin, entry, observable }) => {
    const executable = entry
      ? readExecutable(entry.val)
      : { kind: "unknown" as const, wasmHash: null };
    const { observation, reason } = classify({
      pin,
      observedExecutable: executable.kind,
      observedWasmHash: executable.wasmHash,
      observable,
    });
    // A signing surface is not reviewed merely because its bytecode is
    // observable. Execution-enabled WASM must have an operator-reviewed pin;
    // otherwise a silently upgraded official contract could inherit Kletia's
    // previous release claim.
    const quarantined =
      observation === "drift_quarantined" ||
      observation === "unobservable" ||
      (pin.executionEnabled && observation !== "verified_pinned");
    return {
      key: pin.key,
      contractId: pin.contractId,
      role: pin.role,
      expectedExecutable: pin.expectedExecutable,
      observedExecutable: executable.kind,
      observedWasmHash: executable.wasmHash,
      pinnedWasmHash: pin.pinnedWasmHash,
      observation,
      executionEnabled: pin.executionEnabled,
      quarantined,
      reason,
      provenance: pin.provenance,
    };
  });

  const quarantinedKeys = contracts
    .filter((contract) => contract.quarantined)
    .map((contract) => contract.key);

  return {
    schemaVersion: STELLAR_PROTOCOL_LOCK_SCHEMA,
    network: "stellar_testnet",
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    testnetResetEpoch: STELLAR_TESTNET_RESET_EPOCH,
    observedAt: new Date().toISOString(),
    observedAtLedger: String(health.latestLedger),
    contracts,
    executionSurfaceOpen: contracts.every(
      (contract) =>
        !contract.executionEnabled ||
        (contract.observation === "verified_pinned" && !contract.quarantined),
    ),
    quarantinedKeys,
    pinnedCount: contracts.filter(
      (contract) => contract.observation === "verified_pinned",
    ).length,
    unpinnedCount: contracts.filter(
      (contract) => contract.observation === "observed_unpinned",
    ).length,
    cryptographicSafetyGuaranteed: false,
    limitations: MANIFEST_LIMITATIONS,
  };
}

/**
 * Fail-closed gate used before any Stellar signing surface is offered. A drifted
 * or unobservable execution-enabled contract closes the surface entirely rather
 * than degrading to a best-effort path.
 */
export async function assertStellarExecutionSurfaceOpen(): Promise<StellarProtocolManifestReport> {
  const manifest = await readStellarProtocolManifest();
  if (!manifest.executionSurfaceOpen) {
    throw manifestError(
      "STELLAR_PROTOCOL_DRIFT_QUARANTINED",
      `A Stellar execution contract is unpinned, unavailable, or drifted from its reviewed executable (${manifest.quarantinedKeys.join(", ")}). The Stellar execution surface is closed until the manifest is re-reviewed.`,
    );
  }
  return manifest;
}
