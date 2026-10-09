/**
 * Storage ports of the reference Rule Book gate (policy design §6, §7, §9,
 * §14). The engine evaluates; the HTTP layer stores. Memory implementations
 * live in `memory.ts` (single instance, tests); the Postgres ones belong to
 * the HTTP layer (one advisory lock per project around the reservation).
 */
import type { NetworkKey, PolicyChainLink, PolicyDecision, PolicyDefaults, PolicyDocument, PolicyWindowUsage } from "@kletia/core";

/* ------------------------------------------------------------------ chain */

export interface PolicyChainLevel {
  readonly scope: "project" | "key";
  /** `prj_…` for the project rule book, the key id otherwise. Also the spend scope of this level. */
  readonly id: string;
  /** `agent` for agent keys: absent fields take agent defaults (§3.2). */
  readonly defaults: PolicyDefaults;
  /** The active document (canonical form); null when this level has no rule book. */
  readonly policy: PolicyDocument | null;
  /** Active version and `sha256:` hash; null without a rule book. */
  readonly version: number | null;
  readonly hash: string | null;
}

export interface PolicyChainSnapshot {
  /** Project scope id (`prj_…`). */
  readonly projectId: string;
  readonly ownerKeyId: string;
  /** Ancestors of the owner, project key first (the owner excluded). */
  readonly lineage: readonly string[];
  /** The owner and every ancestor are active and unexpired (a fresh store read, never a cache). */
  readonly keyActive: boolean;
  /** Root first: the project, each lineage key, the owner. */
  readonly levels: readonly PolicyChainLevel[];
}

export interface PolicyChainSource {
  /**
   * Fresh read of an owner key's chain (pending amendments due by now
   * promoted). Undefined when the key is unknown. Throws when the store
   * cannot be read: the gate then refuses (fail closed).
   */
  chain(ownerKeyId: string): Promise<PolicyChainSnapshot | undefined>;
}

/* ----------------------------------------------------- spend reservations */

export interface ExposureRecord {
  /** `px_…` */
  readonly id: string;
  readonly projectId: string;
  readonly ownerKeyId: string;
  readonly intentId: string;
  readonly stepId: string;
  readonly network: NetworkKey;
  readonly quoteBinding: string;
  /** `evm:<chainId>:<account>:<nonce>`: exposures sharing it count once, at their largest amount. */
  readonly exclusiveKey: string | null;
  /** Solana `lastValidBlockHeight`. */
  readonly validUntilHeight: number | null;
  /** Integer micro-dollars this payload adds to the windows (≥ 0). */
  readonly usdMicros: bigint;
  readonly decisionId: string;
  /** Unix ms. */
  readonly createdAt: number;
}

export type ExposureState = "open" | "landed" | "dead";

export interface ScopeCap {
  /** Key id or `prj_…`. */
  readonly scope: string;
  readonly dailyUsdMicros?: bigint;
  readonly weeklyUsdMicros?: bigint;
}

export interface ScopeUsage {
  readonly scope: string;
  readonly window: "24h" | "7d";
  /** Counted usage after this reservation. */
  readonly usedUsdMicros: bigint;
  readonly capUsdMicros: bigint;
  /** What this reservation added (after exclusive-group merging). */
  readonly deltaUsdMicros: bigint;
}

export interface SpendReservation {
  readonly exposure: ExposureRecord;
  /** Every scope the exposure is written to: the owner, each lineage key and the project. */
  readonly scopes: readonly string[];
  /** Window caps to enforce (scopes without caps are written, never checked). */
  readonly caps: readonly ScopeCap[];
  /**
   * The rule book heads the caller evaluated. The ledger re-reads them under
   * its lock and answers `chain_changed` when any moved, so a pause that
   * committed first is always seen (P13). Implementations without a policy
   * store of their own may skip the check.
   */
  readonly chain: readonly PolicyChainLink[];
  readonly now: number;
}

export type SpendReservationResult =
  | { readonly ok: true; readonly replayed: boolean; readonly usage: readonly ScopeUsage[] }
  | {
      readonly ok: false;
      readonly reason: "cap";
      readonly scope: string;
      readonly window: "24h" | "7d";
      readonly usage: readonly ScopeUsage[];
      /** Unix ms when enough counted exposure leaves the window (≤ 7 days); null when never. */
      readonly retryAt: number | null;
    }
  | { readonly ok: false; readonly reason: "chain_changed" };

/**
 * The spend reservation interface (design §6.4): one atomic
 * read-usage → check → insert per prepared payload, serialised per project.
 */
export interface SpendLedger {
  /** Window usage per scope (no lock; plan-time preview). */
  usage(scopes: readonly string[], now: number): Promise<ReadonlyMap<string, PolicyWindowUsage>>;
  /** Atomic reservation; idempotent per (exposure id, scope). */
  reserve(reservation: SpendReservation): Promise<SpendReservationResult>;
  /** The payload never left (the graph commit failed): the exposure is dead. */
  abort(exposureId: string): Promise<void>;
  /**
   * Verified on chain: the step's exposures with this binding become landed
   * (every open one of the step when the binding is unknown). Returns them;
   * empty when the payload had no exposure. Idempotent.
   */
  land(input: { readonly intentId: string; readonly stepId: string; readonly quoteBinding: string | null; readonly now: number }): Promise<readonly ExposureRecord[]>;
  /** A verified payload without exposure is recorded as landed (never refused). Idempotent per id. */
  recordLanded(exposure: ExposureRecord, scopes: readonly string[]): Promise<void>;
  /** Open Solana exposures of the step whose `validUntilHeight` is below `height` become dead; returns how many. */
  expire(intentId: string, stepId: string, height: bigint): Promise<number>;
  /** A landed transaction overrode its pinned nonce: the group's members count in full from now on. */
  clearExclusive(exclusiveKey: string): Promise<void>;
}

/* -------------------------------------------------------------- approvals */

export interface ApproverRequirement {
  /** The rule book that asked for the approval. */
  readonly scope: "project" | "key";
  readonly id: string;
  /** confirm.approvers.keys of that rule book (project keys). */
  readonly keys: readonly string[];
  /** confirm.approvers.wallets (CAIP-10 patterns). */
  readonly wallets: readonly string[];
  readonly requireWallet: boolean;
}

export interface PolicyApprovalRecord {
  /** `apr_…` (128-bit capability). */
  readonly id: string;
  readonly projectId: string;
  /** Requester: the intent's owner key. */
  readonly keyId: string;
  readonly lineage: readonly string[];
  readonly intentId: string;
  /** `approvalDigest(graph, keyId)`. */
  readonly digest: string;
  readonly ceilingUsdCents: bigint;
  readonly notionalUsd: string;
  /** Rule ids that asked for it. */
  readonly triggers: readonly string[];
  /** One entry per rule book that raised a trigger: an approver must satisfy every one (intersection). */
  readonly approvers: readonly ApproverRequirement[];
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly url: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

export interface PolicyApprovalStore {
  forIntent(intentId: string): Promise<PolicyApprovalRecord | undefined>;
  /** Inserts a pending approval; returns the existing one when the intent already has a hold (one per intent). */
  create(record: PolicyApprovalRecord): Promise<PolicyApprovalRecord>;
}

/* -------------------------------------------------------------- decisions */

export type PolicyDecisionDraft = Omit<PolicyDecision, "seq" | "prevHash" | "chainHash">;

export interface PolicyDecisionLog {
  /** Appends one decision; the log assigns `seq`, `prevHash` and `chainHash` (per project, gapless). */
  append(record: PolicyDecisionDraft): Promise<PolicyDecision>;
}
