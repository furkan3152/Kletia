export type CapabilityReadinessV3 =
  | "read"
  | "quote"
  | "execute"
  | "verify"
  | "unavailable";

export type ChainKeyV3 =
  | "base_mainnet"
  | "arbitrum_one"
  | "arc_testnet"
  | "stellar_testnet"
  | "arbitrum_sepolia"
  | "stellar_mainnet";

export interface ProtocolCapabilityV3View {
  readonly id: string;
  readonly label: string;
  readonly chains: readonly ChainKeyV3[];
  readonly operations: readonly string[];
  readonly readiness: readonly CapabilityReadinessV3[];
  readonly executionEnabled: boolean;
  readonly executionChains?: readonly ChainKeyV3[];
  readonly reason?: string;
  readonly officialSources: readonly string[];
  readonly deploymentBinding: {
    readonly mode: "pinned" | "runtime_attested" | "discovery_only";
    readonly identifiers: readonly string[];
  };
  readonly mockDataAllowed: false;
}

export interface CapabilitiesV3Response {
  readonly success: true;
  readonly schemaVersion: "kletia_capabilities_v3";
  readonly generatedAt: string;
  readonly lanes: {
    readonly production: readonly ChainKeyV3[];
    readonly testnet: readonly ChainKeyV3[];
  };
  readonly protocols: readonly ProtocolCapabilityV3View[];
  readonly workflowStore: {
    readonly status: "ready" | "unavailable";
    readonly backend: "postgresql" | "sqlite" | null;
  };
  readonly controlPlane: {
    readonly sourceReady: boolean;
    readonly deployLast: true;
    readonly testnetExecutionEnabled: boolean;
    readonly productionExecutionEnabled: false;
    readonly provesExternalExecution: false;
    readonly privacyModel: "field_minimization_and_policy_commitments_not_anonymity";
    readonly readiness: {
      readonly lane: "testnet";
      readonly ready: boolean;
      readonly status: string;
      readonly reason: string;
      readonly artifactProfile: "testnet_development" | null;
      readonly productionReady: false;
      readonly deploymentManifest: string;
      readonly contracts: readonly {
        readonly key: string;
        readonly contractId: string | null;
        readonly expectedWasmSha256: string;
        readonly observedWasmSha256: string | null;
        readonly observedAtLedger: string | null;
        readonly ready: boolean;
      }[];
      readonly generatedVerifierExecutable: {
        readonly contractId: string;
        readonly expectedWasmSha256: string;
        readonly observedWasmSha256: string | null;
        readonly observedAtLedger: string;
        readonly ready: boolean;
      } | null;
      readonly provesExternalExecution: false;
    };
  };
  readonly solverMarket: {
    readonly schemaVersion: "kletia_stellar_solver_market_readiness_v1";
    readonly lane: "testnet";
    readonly sourceReady: true;
    readonly ready: boolean;
    readonly status: string;
    readonly reason: string;
    readonly productionReady: false;
    readonly deploymentManifest: "contracts/stellar/deployments/testnet/solver-market.v1.json";
    readonly contractDesign: "asset_backed_bond_and_commit_reveal_auction";
    readonly provesForeignExecution: false;
    readonly automaticTimeoutSlashing: false;
    readonly contracts: readonly {
      readonly key: string;
      readonly contractId: string | null;
      readonly expectedWasmSha256: string;
      readonly observedWasmSha256: string | null;
      readonly observedAtLedger: string | null;
      readonly ready: boolean;
    }[];
    readonly bindings: {
      readonly ready: boolean;
      readonly bondAsset: string;
      readonly minimumBondAtomic: string;
      readonly resolutionGraceLedgers: number;
      readonly coordinator: string;
      readonly settlementAuthority: string;
      readonly treasury: string;
      readonly maximumBids: number;
      readonly observedAtLedger: string;
    } | null;
  };
  readonly workflowV3: {
    readonly planning: "source_ready";
    readonly exactCallExecution: "stellar_control_plane_commits_and_live_reads_financial_calls_fail_closed";
    readonly liveReadExecution: readonly string[];
    readonly policyProofBinding: "live_testnet_registry_verified";
    readonly controlPlaneXdrPreparation: "browser_source_ready_wallet_signature_required";
    readonly reviewedExecutionFallback: "workflow_v2_and_network_local_engines";
    readonly automaticRetry: false;
  };
}

export function isCapabilitiesV3Response(value: unknown): value is CapabilitiesV3Response {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapabilitiesV3Response>;
  return (
    candidate.success === true &&
    candidate.schemaVersion === "kletia_capabilities_v3" &&
    Array.isArray(candidate.protocols) &&
    Boolean(candidate.controlPlane) &&
    Boolean(candidate.solverMarket) &&
    Boolean(candidate.workflowV3) &&
    Boolean(candidate.workflowStore)
  );
}
