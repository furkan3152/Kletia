/**
 * Admin storage contract. Postgres in any persisted deployment (required in
 * production), memory only for development and tests.
 */
import type {
  AdminAuditEntry,
  AdminDeploymentRecord,
  AdminEvmNetwork,
  AdminNetworkProfile,
  AdminSafeProposal,
  AdminWalletKind,
} from "@kletia/core";

export type AdminNoncePurpose = "login" | "confirm";

export interface AdminNonceRecord {
  readonly nonceHash: string;
  readonly walletKind: AdminWalletKind;
  /** Lower-cased EVM address, or the base58 Solana address. */
  readonly address: string;
  /** EIP-155 chain id (EVM), null for Solana. */
  readonly chainId: number | null;
  readonly origin: string;
  readonly purpose: AdminNoncePurpose;
  readonly message: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AdminSessionRecord {
  readonly idHash: string;
  readonly walletKind: AdminWalletKind;
  /** Lower-cased EVM address, or the base58 Solana address. */
  readonly address: string;
  readonly chainId: number | null;
  readonly origin: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export interface AdminAuditInput {
  readonly address: string | null;
  readonly action: string;
  readonly outcome: AdminAuditEntry["outcome"];
  readonly target: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly ipHash: string | null;
}

export interface AdminFeeScanRecord {
  readonly key: string;
  readonly network: AdminEvmNetwork;
  readonly address: string;
  readonly scannedThroughBlock: bigint;
  /** Sum per token key ("native" or lower-cased token address), decimal strings. */
  readonly totals: Readonly<Record<string, string>>;
}

export interface AdminDeploymentFilter {
  readonly network?: AdminEvmNetwork;
  readonly status?: AdminDeploymentRecord["status"];
}

export interface AdminProposalFilter {
  readonly network?: AdminEvmNetwork;
  readonly status?: AdminSafeProposal["status"];
}

export interface AdminStore {
  readonly kind: "memory" | "postgres";

  createNonce(record: AdminNonceRecord): Promise<void>;
  /** Marks the nonce used and returns it when unused and unexpired; null otherwise (single use). */
  consumeNonce(nonceHash: string, now: Date): Promise<AdminNonceRecord | null>;
  pruneNonces(now: Date): Promise<void>;

  createSession(record: AdminSessionRecord): Promise<void>;
  getSession(idHash: string): Promise<AdminSessionRecord | null>;
  touchSession(idHash: string, at: Date): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  deleteSessionsOf(walletKind: AdminWalletKind, address: string): Promise<void>;

  writeAudit(input: AdminAuditInput, at: Date): Promise<AdminAuditEntry>;
  listAudit(limit: number, before: Date | null): Promise<AdminAuditEntry[]>;

  /** Inserts; throws AdminHttpError ADMIN_RECORD_CONFLICT on a duplicate (chain id, address) or (chain id, tx hash). */
  insertDeployment(record: AdminDeploymentRecord): Promise<void>;
  updateDeployment(record: AdminDeploymentRecord): Promise<void>;
  getDeployment(id: string): Promise<AdminDeploymentRecord | null>;
  findDeploymentByTx(chainId: number, txHash: string): Promise<AdminDeploymentRecord | null>;
  findDeploymentByAddress(chainId: number, address: string): Promise<AdminDeploymentRecord | null>;
  listDeployments(filter: AdminDeploymentFilter): Promise<AdminDeploymentRecord[]>;

  listProfiles(): Promise<AdminNetworkProfile[]>;
  putProfile(profile: AdminNetworkProfile): Promise<void>;

  insertProposal(proposal: AdminSafeProposal): Promise<void>;
  updateProposal(proposal: AdminSafeProposal): Promise<void>;
  getProposal(id: string): Promise<AdminSafeProposal | null>;
  listProposals(filter: AdminProposalFilter): Promise<AdminSafeProposal[]>;

  getFeeScan(key: string): Promise<AdminFeeScanRecord | null>;
  putFeeScan(record: AdminFeeScanRecord): Promise<void>;
}
