/**
 * Admin wire and catalog types. The contract lives in `@kletia/core`
 * (`packages/core/src/admin.ts`, owned by the admin API package); this file
 * re-exports it and adds the shapes the core does not name: the catalog,
 * overview and artifact responses, and the ABI subset the panel reads.
 * Types only: nothing here runs.
 */
import type {
  AdminContractId,
  AdminContractSpec,
  AdminDeployTarget,
  AdminEvmNetwork,
  AdminNetworkConstants,
  AdminPinnedDeployment,
} from "@kletia/core";

export type {
  AdminActionRisk,
  AdminActionSpec,
  AdminActionVerifyRequest,
  AdminArgSource,
  AdminAuditEntry,
  AdminConfirmation,
  AdminConstructorInput,
  AdminContractId,
  AdminContractSpec,
  AdminContractState,
  AdminDeployTarget,
  AdminDeploymentRecord,
  AdminEnvItem,
  AdminEnvView,
  AdminErrorBody,
  AdminEvmNetwork,
  AdminExport,
  AdminExportEntry,
  AdminFeeModel,
  AdminFeeRow,
  AdminFeesView,
  AdminLifecycle,
  AdminNetworkConstant,
  AdminNetworkConstants,
  AdminNetworkProfile,
  AdminNonceRequest,
  AdminNonceResponse,
  AdminOwnerModel,
  AdminPinnedDeployment,
  AdminPostDeployStep,
  AdminRecordRequest,
  AdminRecordStatus,
  AdminRenderDeploy,
  AdminRenderService,
  AdminRenderServiceKey,
  AdminRole,
  AdminSafeProposal,
  AdminServicesView,
  AdminSessionView,
  AdminTargetStatus,
  AdminTokenAmount,
  AdminVerificationCheck,
  AdminWalletKind,
} from "@kletia/core";

export type AdminNoProgramNetwork = "solana" | "solana-devnet";
export type AdminPanelNetwork = AdminEvmNetwork | AdminNoProgramNetwork;

/** `GET /api/admin/catalog`: the core data, served so the panel and the API agree on one version. */
export interface AdminCatalog {
  readonly schemaVersion: string;
  readonly contracts: Readonly<Record<AdminContractId, AdminContractSpec>>;
  readonly targets: readonly AdminDeployTarget[];
  readonly pinned: readonly AdminPinnedDeployment[];
  readonly constants: Readonly<Record<AdminEvmNetwork, AdminNetworkConstants>>;
}

export interface AdminOverviewNetwork {
  readonly network: AdminEvmNetwork;
  readonly pinned: number;
  readonly verified: number;
  readonly deployable: number;
  readonly warnings: readonly string[];
}

/** `GET /api/admin/overview`. */
export interface AdminOverview {
  readonly networks: readonly AdminOverviewNetwork[];
  readonly safeQueue: number;
  readonly servicesConfigured: boolean;
}

/** The ABI shape the panel reads (a structural subset of viem's `Abi`). */
export interface AbiParameter {
  readonly name?: string;
  readonly type: string;
  readonly internalType?: string;
  readonly components?: readonly AbiParameter[];
  readonly indexed?: boolean;
}

export interface AbiItem {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
  readonly stateMutability?: string;
  readonly anonymous?: boolean;
}

/** One artifact from `GET /api/admin/artifacts/:artifactId` (ABI-only entries carry no bytecode). */
export interface AdminArtifact {
  readonly contractName: string;
  readonly sourceName: string;
  readonly project: "base" | "arc";
  readonly deployable: boolean;
  readonly compiler: { readonly solc: string; readonly optimizer: boolean; readonly runs: number; readonly evmVersion: string };
  readonly abi: readonly AbiItem[];
  readonly bytecode?: string;
  readonly deployedBytecode?: string;
  readonly maskedRuntimeHash?: string;
  readonly runtimeHash?: string;
}
