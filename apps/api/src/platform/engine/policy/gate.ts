/**
 * The Rule Book gate (policy design §16.3, frozen PF2 → PF3a interface).
 * The engine calls it at four points: before and after planning (narrow
 * the request, then evaluate the planned graph and stamp it), after a
 * stored intent was created (approval rows), before a prepared payload
 * leaves (re-evaluate with fresh amounts, check the approval, reserve spend)
 * and after on-chain verification (reconcile the exposure).
 *
 * The default gate is a no-op: without a configured gate nothing changes.
 * `createRuleBookGate` (ruleBookGate.ts) is the reference implementation
 * over storage ports; the HTTP layer installs it (or its own) with
 * `configurePolicyGate`.
 */
import type { IntentGraph, IntentPolicyStamp, IntentRequest, IntentStep } from "@kletia/core";
import type { ContractPreparedPayload, PreparedPayload } from "../adapters/types.js";

/** What `beforePlan` decided; handed back to `afterPlan` / `afterCreate`. */
export interface PlanGuard {
  /** The request to plan: constraints narrowed by every rule book of the owner's chain (§4.3). */
  readonly request: IntentRequest;
  readonly ownerKeyId?: string;
  /** Authenticated caller (MCP, agent); absent for public callers (link visitors). */
  readonly actorKeyId?: string;
  readonly dryRun: boolean;
  /** False when nothing in the owner's chain governs it (no rule book, no agent key): later hooks change nothing. */
  readonly governed: boolean;
}

/** The exposure a payload would open (computed by the engine; §6.2, §6.3). */
export interface PayloadExposure {
  /** `px_…`: deterministic per payload (retries of one reservation are idempotent). */
  readonly id: string;
  /** `evm:<chainId>:<account>:<nonce>` for nonce-pinned EVM payloads (mutually exclusive), else null. */
  readonly exclusiveKey: string | null;
  /** Solana `lastValidBlockHeight` (the exposure dies when it passes unlanded); null on EVM. */
  readonly validUntilHeight: number | null;
  /** Pinned nonces of the payload's EVM transactions (decimal), in order; empty when unpinned. */
  readonly nonces: readonly string[];
}

export interface PayloadClearanceInput {
  /** The intent as it will be committed (the prepared step's fresh amounts in place). */
  readonly graph: IntentGraph;
  /** The freshly prepared step. */
  readonly step: IntentStep;
  /** The adapter payload (transactions carry pinned nonces when pinning applies). */
  readonly prepared: PreparedPayload | ContractPreparedPayload;
  /** Owner key of the intent (null for keyless intents). */
  readonly ownerKeyId: string | null;
  readonly quoteBinding: string;
  readonly exposure: PayloadExposure;
  /** Unix ms of this prepare. */
  readonly now: number;
  /** Current Solana block height of the step network (read lazily; null when unreadable). */
  readonly solanaBlockHeight?: () => Promise<bigint | null>;
}

/** A reserved exposure: committed once the graph commit succeeded, aborted (dead) if the payload never left. */
export interface ExposureHandle {
  readonly decisionId: string;
  readonly exposureId: string;
  /** USD counted, 2 decimals; null when no USD rule applied and nothing was priced. */
  readonly notionalUsd: string | null;
  /** Hashes (`sha256:…`) of every rule book evaluated, root first (StepPolicyClearance). */
  readonly chainHashes?: readonly string[];
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface VerificationReconcileInput {
  readonly graph: IntentGraph;
  /** The step whose references verified on-chain. */
  readonly step: IntentStep;
  /** Nonce of each landed EVM transaction, in reference order (null when unknown). */
  readonly landedNonces?: readonly (string | null)[];
  /** Owner key of the intent (the stamp's key when absent). */
  readonly ownerKeyId?: string | null;
  /** Binding of the payload that landed, when known (EVM verification in this process). */
  readonly quoteBinding?: string | null;
}

export interface PolicyGate {
  /** Before planning: lineage status, mode, permissions, accounts pin; returns the narrowed request. */
  beforePlan(input: { ownerKeyId?: string; actorKeyId?: string; request: IntentRequest; dryRun: boolean }): Promise<PlanGuard>;
  /** After planning: full evaluation; returns the stamp (allow | confirm) and an optional ttl; throws policy errors. */
  afterPlan(guard: PlanGuard, graph: IntentGraph): Promise<{ stamp: IntentPolicyStamp | null; ttlMs?: number }>;
  /** After the stored graph was created (approval rows need the intent id persisted). */
  afterCreate(guard: PlanGuard, graph: IntentGraph): Promise<void>;
  /** Prepare: re-evaluate with the fresh step, check the approval, reserve. Null when the owner has no chain. */
  beforePayload(input: PayloadClearanceInput): Promise<ExposureHandle | null>;
  /** Nonce pinning and other execution options for the intent's owner. */
  executionOptions(ownerKeyId: string | null): Promise<{ pinNonce: boolean }>;
  /** Submit / refresh: reconcile a verified step (idempotent; never throws on policy grounds). */
  afterVerification(input: VerificationReconcileInput): Promise<void>;
}

/** The default: governs nothing. */
export const NO_POLICY_GATE: PolicyGate = Object.freeze({
  async beforePlan(input: { ownerKeyId?: string; actorKeyId?: string; request: IntentRequest; dryRun: boolean }): Promise<PlanGuard> {
    return {
      request: input.request,
      ...(input.ownerKeyId !== undefined ? { ownerKeyId: input.ownerKeyId } : {}),
      ...(input.actorKeyId !== undefined ? { actorKeyId: input.actorKeyId } : {}),
      dryRun: input.dryRun,
      governed: false,
    };
  },
  async afterPlan() {
    return { stamp: null };
  },
  async afterCreate() {},
  async beforePayload() {
    return null;
  },
  async executionOptions() {
    return { pinNonce: false };
  },
  async afterVerification() {},
});

let gate: PolicyGate = NO_POLICY_GATE;

/** Installs the Rule Book gate; null restores the no-op default. */
export function configurePolicyGate(next: PolicyGate | null): void {
  gate = next ?? NO_POLICY_GATE;
}

export function policyGate(): PolicyGate {
  return gate;
}

/** True when a gate other than the no-op default is installed (the engine skips owner reads otherwise). */
export function policyGateActive(): boolean {
  return gate !== NO_POLICY_GATE;
}
