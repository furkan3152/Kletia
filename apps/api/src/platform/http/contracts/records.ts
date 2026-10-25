/**
 * Stored contract records, revisions, the store interface and the
 * registration errors.
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  contractSecurityFields,
  type ContractDefinition,
  type ContractPins,
  type ContractStatus,
  type ContractVerification,
  type ContractVisibility,
  type ContractVm,
  type NetworkKey,
  type SolanaActionMetadata,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { contractsEnabled } from "../contractChecks.js";
import { HttpError } from "../context.js";

/* ================================================================== model */

export type StoredContractStatus = ContractStatus | "deleted";

/** Suspension reasons set by the platform; operator suspensions are stored as `operator: <reason>`. */
export const LIFTABLE_SUSPENSIONS = new Set(["pins_changed", "program_changed", "outcome_mismatch", "domain_unverified"]);
export const OPERATOR_PREFIX = "operator: ";

export interface ContractRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly projectId: string | null;
  readonly vm: ContractVm;
  readonly network: NetworkKey;
  /** Lower-case contract address (EVM) or the Solana Actions origin. */
  readonly target: string;
  readonly status: StoredContractStatus;
  /** Visibility of the revision intents use (the active one, else the first). */
  readonly visibility: ContractVisibility;
  /** Latest revision number. */
  readonly revision: number;
  readonly activeRevision: number | null;
  readonly pendingRevision: number | null;
  readonly activatesAt: string | null;
  readonly suspendedReason: string | null;
  readonly verification: ContractVerification;
  /** Solana Actions metadata per entry id (recorded at registration). */
  readonly metadata: Readonly<Record<string, SolanaActionMetadata>>;
  readonly pinsCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContractRevision {
  readonly contractId: string;
  readonly revision: number;
  /** Normalised definition (`validateContractDefinition`). */
  readonly definition: ContractDefinition;
  readonly definitionHash: string;
  readonly pins: ContractPins;
  readonly createdAt: string;
}

export interface ContractEntry {
  readonly record: ContractRecord;
  /** The active revision; null while the first revision waits for activation. */
  readonly active: ContractRevision | null;
  /** The revision waiting for activation, if any. */
  readonly pending: ContractRevision | null;
}

export interface RevisionSummary {
  readonly revision: number;
  readonly definitionHash: string;
  readonly createdAt: string;
}

/** sha256 hex of the canonical security-relevant fields (same value as core `contractDefinitionHash`). */
export function definitionHashOf(definition: ContractDefinition): string {
  return createHash("sha256").update(canonicalJson(contractSecurityFields(definition)), "utf8").digest("hex");
}

export function latestRevision(entry: ContractEntry): ContractRevision {
  const revision = entry.pending ?? entry.active;
  if (!revision) throw new Error(`Contract ${entry.record.id} has no revision.`);
  return revision;
}

/** The revision intents plan and prepare with: the active one, else the first (pending) one. */
export function usedRevision(entry: ContractEntry): ContractRevision {
  const revision = entry.active ?? entry.pending;
  if (!revision) throw new Error(`Contract ${entry.record.id} has no revision.`);
  return revision;
}

export function isOperatorSuspension(record: ContractRecord): boolean {
  return record.status === "suspended" && (record.suspendedReason ?? "").startsWith(OPERATOR_PREFIX);
}

/* ============================================================ store errors */

export function contractNotFound(): HttpError {
  return new HttpError(404, "CONTRACT_NOT_FOUND", "Contract registration not found.");
}

export function contractExists(): PlatformError {
  return new PlatformError("CONTRACT_EXISTS", "This key already registered this address (or origin) on this network. Change it with PATCH /v1/contracts/{id}.", 409);
}

export function contractLimitReached(max: number): PlatformError {
  return new PlatformError("CONTRACT_LIMIT_REACHED", `An API key holds at most ${max} contract registrations. Delete one with DELETE /v1/contracts/{id} first.`, 409);
}

/** The registration changed under a read-modify-write; the caller re-reads (never leaves the module as-is). */
export class ConcurrentChange extends PlatformError {
  constructor() {
    super("STORE_UNAVAILABLE", "The registration is being changed concurrently. Read it again and retry.", 503);
  }
}

function contractsDisabled(): PlatformError {
  return new PlatformError("CONTRACTS_DISABLED", "Custom contracts are disabled on this deployment.", 503);
}

export function assertContractsEnabled(): void {
  if (!contractsEnabled()) throw contractsDisabled();
}

/* ================================================================== store */

export interface ContractStore {
  readonly kind: "memory" | "postgres";
  /**
   * Inserts a registration with its first revision. Refuses 409 CONTRACT_EXISTS
   * when the owner already holds a (not deleted) registration of the same
   * target on the network, 409 CONTRACT_LIMIT_REACHED at `maxPerOwner`.
   */
  create(record: ContractRecord, revision: ContractRevision, maxPerOwner: number): Promise<void>;
  /** One registration (deleted ones included) with its active and pending revisions. */
  get(id: string): Promise<ContractEntry | null>;
  /** Not-deleted registrations of `ownerKeyId`, plus project-visible ones of `projectId` (other keys). At most 200. */
  listVisible(ownerKeyId: string, projectId: string | null): Promise<ContractEntry[]>;
  /** Registrations whose pending revision is due (`activatesAt` <= now), oldest first. */
  listDue(now: string, limit: number): Promise<ContractEntry[]>;
  /** Active and pending registrations, least recently pin-checked first. */
  listForWatch(limit: number): Promise<ContractEntry[]>;
  /**
   * Replaces the record when its stored `updatedAt` equals `expectedUpdatedAt`
   * (false otherwise), inserting a new revision and/or replacing the
   * definition of an existing one in the same transaction.
   */
  update(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions?: { readonly insert?: ContractRevision; readonly replace?: ContractRevision },
  ): Promise<boolean>;
  /** Revision numbers, hashes and creation times, newest first. */
  history(id: string, limit: number): Promise<RevisionSummary[]>;
  /** Registrations of one owner (not deleted), and how many are suspended. */
  counts(ownerKeyId: string): Promise<{ readonly registered: number; readonly suspended: number }>;
  /** Adds priced notional for `day` unless the total would exceed `capUsd`; false when refused. */
  addSpend(ownerKeyId: string, day: string, usd: number, capUsd: number): Promise<boolean>;
  spend(ownerKeyId: string, day: string): Promise<{ readonly usd: number; readonly prepared: number }>;
}
