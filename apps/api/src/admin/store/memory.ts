/**
 * In-memory admin store for development and tests. Refused in production
 * (sessions and the audit log must survive restarts).
 */
import type { AdminAuditEntry, AdminDeploymentRecord, AdminNetworkProfile, AdminSafeProposal, AdminWalletKind } from "@kletia/core";
import { randomHex } from "../../platform/http/secrets.js";
import { AdminHttpError } from "../http/errors.js";
import type {
  AdminAuditInput,
  AdminDeploymentFilter,
  AdminFeeScanRecord,
  AdminNonceRecord,
  AdminProposalFilter,
  AdminSessionRecord,
  AdminStore,
} from "./types.js";

interface StoredNonce {
  record: AdminNonceRecord;
  usedAt: Date | null;
}

export class MemoryAdminStore implements AdminStore {
  readonly kind = "memory" as const;
  private readonly nonces = new Map<string, StoredNonce>();
  private readonly sessions = new Map<string, AdminSessionRecord>();
  private readonly audit: AdminAuditEntry[] = [];
  private readonly deployments = new Map<string, AdminDeploymentRecord>();
  private readonly profiles = new Map<string, AdminNetworkProfile>();
  private readonly proposals = new Map<string, AdminSafeProposal>();
  private readonly feeScans = new Map<string, AdminFeeScanRecord>();
  /** Test hook: makes writeAudit fail like an unavailable database. */
  failAuditWrites = false;

  constructor(options: { readonly production?: boolean } = {}) {
    if (options.production) throw new Error("The in-memory admin store is not allowed in production.");
  }

  async createNonce(record: AdminNonceRecord): Promise<void> {
    if (this.nonces.has(record.nonceHash)) throw new AdminHttpError(409, "ADMIN_NONCE_INVALID", "Nonce collision; request a new one.");
    this.nonces.set(record.nonceHash, { record, usedAt: null });
  }

  async consumeNonce(nonceHash: string, now: Date): Promise<AdminNonceRecord | null> {
    const stored = this.nonces.get(nonceHash);
    if (!stored || stored.usedAt || stored.record.expiresAt.getTime() <= now.getTime()) return null;
    stored.usedAt = now;
    return stored.record;
  }

  async pruneNonces(now: Date): Promise<void> {
    for (const [hash, stored] of this.nonces) {
      if (stored.record.expiresAt.getTime() < now.getTime() - 60 * 60 * 1000) this.nonces.delete(hash);
    }
  }

  async createSession(record: AdminSessionRecord): Promise<void> {
    this.sessions.set(record.idHash, record);
  }

  async getSession(idHash: string): Promise<AdminSessionRecord | null> {
    return this.sessions.get(idHash) ?? null;
  }

  async touchSession(idHash: string, at: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) this.sessions.set(idHash, { ...session, lastSeenAt: at });
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async deleteSessionsOf(walletKind: AdminWalletKind, address: string): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.walletKind === walletKind && session.address === address) this.sessions.delete(hash);
    }
  }

  async writeAudit(input: AdminAuditInput, at: Date): Promise<AdminAuditEntry> {
    if (this.failAuditWrites) throw new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "Admin storage is temporarily unavailable.");
    const entry: AdminAuditEntry = {
      id: `aud_${randomHex(12)}`, at: at.toISOString(), address: input.address, action: input.action,
      outcome: input.outcome, target: { ...input.target }, requestId: input.requestId,
    };
    this.audit.push(entry);
    return entry;
  }

  async listAudit(limit: number, before: Date | null): Promise<AdminAuditEntry[]> {
    return this.audit
      .filter((entry) => !before || new Date(entry.at).getTime() < before.getTime())
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async insertDeployment(record: AdminDeploymentRecord): Promise<void> {
    for (const existing of this.deployments.values()) {
      if (existing.chainId !== record.chainId) continue;
      if (existing.address.toLowerCase() === record.address.toLowerCase() || existing.txHash.toLowerCase() === record.txHash.toLowerCase()) {
        throw new AdminHttpError(409, "ADMIN_RECORD_CONFLICT", "A record for this address or transaction already exists.");
      }
    }
    this.deployments.set(record.id, record);
  }

  async updateDeployment(record: AdminDeploymentRecord): Promise<void> {
    this.deployments.set(record.id, record);
  }

  async getDeployment(id: string): Promise<AdminDeploymentRecord | null> {
    return this.deployments.get(id) ?? null;
  }

  async findDeploymentByTx(chainId: number, txHash: string): Promise<AdminDeploymentRecord | null> {
    for (const record of this.deployments.values()) {
      if (record.chainId === chainId && record.txHash.toLowerCase() === txHash.toLowerCase()) return record;
    }
    return null;
  }

  async findDeploymentByAddress(chainId: number, address: string): Promise<AdminDeploymentRecord | null> {
    for (const record of this.deployments.values()) {
      if (record.chainId === chainId && record.address.toLowerCase() === address.toLowerCase()) return record;
    }
    return null;
  }

  async listDeployments(filter: AdminDeploymentFilter): Promise<AdminDeploymentRecord[]> {
    return [...this.deployments.values()]
      .filter((record) => (!filter.network || record.network === filter.network) && (!filter.status || record.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async listProfiles(): Promise<AdminNetworkProfile[]> {
    return [...this.profiles.values()];
  }

  async putProfile(profile: AdminNetworkProfile): Promise<void> {
    this.profiles.set(profile.network, profile);
  }

  async insertProposal(proposal: AdminSafeProposal): Promise<void> {
    for (const existing of this.proposals.values()) {
      if (existing.network === proposal.network && existing.safeTxHash === proposal.safeTxHash) {
        throw new AdminHttpError(409, "ADMIN_SAFE_NONCE_BUSY", "This Safe transaction is already proposed.");
      }
    }
    this.proposals.set(proposal.id, proposal);
  }

  async updateProposal(proposal: AdminSafeProposal): Promise<void> {
    this.proposals.set(proposal.id, proposal);
  }

  async getProposal(id: string): Promise<AdminSafeProposal | null> {
    return this.proposals.get(id) ?? null;
  }

  async listProposals(filter: AdminProposalFilter): Promise<AdminSafeProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => (!filter.network || proposal.network === filter.network) && (!filter.status || proposal.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getFeeScan(key: string): Promise<AdminFeeScanRecord | null> {
    return this.feeScans.get(key) ?? null;
  }

  async putFeeScan(record: AdminFeeScanRecord): Promise<void> {
    this.feeScans.set(record.key, record);
  }
}
