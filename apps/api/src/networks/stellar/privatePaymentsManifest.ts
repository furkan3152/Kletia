import { rpc, xdr } from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "./config.js";

const SOURCE_REPOSITORY =
  "https://github.com/NethermindEth/stellar-private-payments";
const SDK_VERSION = "0.1.0-alpha.1";
const SDK_GIT_HEAD = "9e40585d28cd733a928b026539f6a45cef8b5dba";
const SDK_NPM_INTEGRITY =
  "sha512-1+BKGXMuimRT3BsMW1u2IkcjkdFsEy/O6zf9xwkxFK04XW+y4giOay8WGys70nVOMepKL5t8oSIitOcZxVWW1w==";

type ExecutableKind = "stellar_asset" | "wasm";

interface PrivatePaymentsContractPin {
  readonly key: string;
  readonly contractId: string;
  readonly role:
    | "pool"
    | "asset"
    | "groth16_verifier"
    | "asp_membership"
    | "asp_non_membership"
    | "public_key_registry";
  readonly expectedExecutable: ExecutableKind;
  readonly pinnedWasmHash: string | null;
  readonly requiredForXlmLifecycle: boolean;
}

const CONTRACT_PINS: readonly PrivatePaymentsContractPin[] = Object.freeze([
  Object.freeze({
    key: "xlmPool",
    contractId: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
    role: "pool" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "9d86e9ca717474bc040665f25a2bc52ef194d8b5b87410053b1a2765737b1a23",
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "xlmSac",
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    role: "asset" as const,
    expectedExecutable: "stellar_asset" as const,
    pinnedWasmHash: null,
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "verifierB",
    contractId: "CCNOLQUUPEZTPNZ7LMS3PYE5NVYNNTKTHJP7HDK4NJMH4JPKFP7HOHD4",
    role: "groth16_verifier" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "82d2cba661627aeadf949c88dd9a49c178226bf2868c06d9970322b526621811",
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "aspMembership",
    contractId: "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
    role: "asp_membership" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "aa19bea557326c0f4b3324bdb9a4eddb45506519c68723a78e0af463f3798847",
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "aspNonMembership",
    contractId: "CBEPJBHP6X4K7KWLRPFUGPRS3OM6HWXTWIVN3M2LCGZZHCCTHHSYAAF3",
    role: "asp_non_membership" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "589795639fe5259ed579d3e0a3b1c4d3e13ddc1c1584fe882aeb24491dc56350",
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "publicKeyRegistry",
    contractId: "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    role: "public_key_registry" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "036ad22c517e47e0dbab61875db27bec2b1a4b4ffab1e3106bbf867dd6bf5739",
    requiredForXlmLifecycle: true,
  }),
  Object.freeze({
    key: "eurcPool",
    contractId: "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74",
    role: "pool" as const,
    expectedExecutable: "wasm" as const,
    pinnedWasmHash:
      "9d86e9ca717474bc040665f25a2bc52ef194d8b5b87410053b1a2765737b1a23",
    requiredForXlmLifecycle: false,
  }),
  Object.freeze({
    key: "eurcSac",
    contractId: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
    role: "asset" as const,
    expectedExecutable: "stellar_asset" as const,
    pinnedWasmHash: null,
    requiredForXlmLifecycle: false,
  }),
]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readExecutable(entryVal: xdr.LedgerEntryData): {
  kind: ExecutableKind | "unknown";
  wasmHash: string | null;
} {
  if (entryVal.type !== "contractData") {
    return { kind: "unknown", wasmHash: null };
  }
  const value = entryVal.contractData.val;
  if (value.type !== "scvContractInstance") {
    return { kind: "unknown", wasmHash: null };
  }
  const executable = value.instance.executable;
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
}

export async function readStellarPrivatePaymentsReadiness() {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl);
  const observations = await Promise.all(
    CONTRACT_PINS.map(async (pin) => {
      try {
        const entry = await server.getContractData(
          pin.contractId,
          xdr.ScVal.scvLedgerKeyContractInstance(),
        );
        const executable = readExecutable(entry.val);
        const executableMatches = executable.kind === pin.expectedExecutable;
        const hashMatches =
          pin.expectedExecutable === "stellar_asset" ||
          (pin.pinnedWasmHash !== null &&
            executable.wasmHash === pin.pinnedWasmHash);
        return {
          ...pin,
          observedExecutable: executable.kind,
          observedWasmHash: executable.wasmHash,
          lastModifiedLedger: String(entry.lastModifiedLedgerSeq),
          ready: executableMatches && hashMatches,
          reason:
            executableMatches && hashMatches
              ? "The live Testnet executable matches the Kletia pin."
              : "The live Testnet executable does not match the Kletia pin.",
        };
      } catch {
        return {
          ...pin,
          observedExecutable: "unknown" as const,
          observedWasmHash: null,
          lastModifiedLedger: null,
          ready: false,
          reason: "The contract instance could not be read from Stellar Testnet.",
        };
      }
    }),
  );
  const xlmLifecycleReady = observations
    .filter((entry) => entry.requiredForXlmLifecycle)
    .every((entry) => entry.ready);

  return {
    schemaVersion: "kletia_stellar_private_payments_readiness_v1" as const,
    network: "stellar_testnet" as const,
    observedAt: new Date().toISOString(),
    upstream: {
      repository: SOURCE_REPOSITORY,
      sdkVersion: SDK_VERSION,
      sdkGitHead: SDK_GIT_HEAD,
      npmIntegrity: SDK_NPM_INTEGRITY,
      maturity: "unaudited_research_alpha" as const,
    },
    readiness: {
      xlmLifecycle: xlmLifecycleReady ? "available" as const : "quarantined" as const,
      eurcLifecycle: observations
        .filter((entry) => entry.key === "eurcPool" || entry.key === "eurcSac")
        .every((entry) => entry.ready)
        ? "available" as const
        : "quarantined" as const,
      usdcLifecycle: "not_deployed" as const,
      mainnet: "unavailable" as const,
    },
    contracts: observations,
    privacyProperties: {
      inPoolAmountsHidden: true,
      inPoolBalancesHidden: true,
      recipientLinkHiddenFromPublicLedger: true,
      depositAmountAndDepositorPublic: true,
      withdrawalAmountAndRecipientPublic: true,
      transactionSubmitterOrAuthorizationMayBePublic: true,
      timingAndPoolInteractionPublic: true,
      publicKeyRegistryIsOptionalButLinkable: true,
      aiAndKletiaApiReceiveWitnessOrNoteSecret: false,
    },
    licensing: {
      source: "Apache-2.0 with LGPL-3.0 circuit build exception",
      distributedCircuitArtifactsRequireNoticesAndCorrespondingSource: true,
    },
    claimBoundary: {
      realInPoolCryptographicPrivacy: xlmLifecycleReady,
      privateBridge: false,
      privateEvmExecution: false,
      audited: false,
      productionReady: false,
      realAssetSafetyClaim: false,
    },
  };
}

