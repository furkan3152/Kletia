/**
 * Reference Rule Book gate (policy design §4-§9) over storage ports: the
 * HTTP layer supplies the chain source, the spend ledger, the approval
 * store and the decision log (memory ones in `memory.ts`) and installs the
 * result with `configurePolicyGate`.
 *
 * - plan: the owner's chain is read fresh; mode, agent permissions and the
 *   accounts pin are checked before any quote is spent; the request's
 *   constraints are narrowed so the auction only sees allowed venues; the
 *   planned graph is evaluated (window caps as a preview), stamped, and a
 *   stored intent that needs confirmation gets an approval hold.
 * - prepare: the chain and key status are read again, the fresh step is
 *   re-priced and re-evaluated, the approval is checked against the intent
 *   digest and the ceiling, and the payload's exposure is reserved
 *   atomically under every scope's window caps. Nothing leaves uncleared.
 * - verification: the exposure becomes landed; a payload that landed
 *   without one is recorded (`submit.uncleared`), a landed nonce that is not
 *   the pinned one is recorded (`execution.pinNonce`) and stops the group
 *   from counting once. Verification is never refused.
 *
 * Fail closed: an unreadable store, an unknown or revoked owner, an
 * unpriced amount a USD rule needs, a hold without a priced ceiling.
 */
import { randomBytes } from "node:crypto";
import {
  approvalCeilingUsdCents,
  approvalDigest,
  CHAINS,
  effectiveExecution,
  evaluatePolicyChain,
  formatUsdMicros,
  narrowConstraints,
  OBSERVER_POLICY,
  policyErrorCode,
  policyExposureId,
  policyUsdMicros,
  scheduleState,
  type IntentGraph,
  type IntentPolicyStamp,
  type IntentRequest,
  type PolicyApprovalState,
  type PolicyChainEntry,
  type PolicyChainLink,
  type PolicyDecision,
  type PolicyDocument,
  type PolicyEvaluation,
  type PolicyFacts,
  type PolicyRuleResult,
  type PolicyViolation,
  type PolicyWindowUsage,
} from "@kletia/core";
import { isPlatformError, PlatformError } from "../../errors.js";
import { INTENT_TTL_MS } from "../planner.js";
import { canonicalJson, sha256Hex } from "../util.js";
import { policyError, type PolicyApprovalReference } from "./errors.js";
import { publishPolicyEvent } from "./events.js";
import { exclusiveKeyNonce } from "./execution.js";
import { policyFactsDetailed, policyNeedsPricing, stepExposureUsdMicros } from "./facts.js";
import type { ExposureHandle, PayloadClearanceInput, PlanGuard, PolicyGate, VerificationReconcileInput } from "./gate.js";
import type {
  ApproverRequirement,
  ExposureRecord,
  PolicyApprovalRecord,
  PolicyApprovalStore,
  PolicyChainLevel,
  PolicyChainSnapshot,
  PolicyChainSource,
  PolicyDecisionDraft,
  PolicyDecisionLog,
  ScopeCap,
  ScopeUsage,
  SpendLedger,
} from "./ports.js";

export interface RuleBookGateOptions {
  readonly chains: PolicyChainSource;
  readonly ledger: SpendLedger;
  readonly approvals: PolicyApprovalStore;
  readonly decisions: PolicyDecisionLog;
  /** Approval page URL for an id (default `https://kletiaai.xyz/approve#apr_…`; the id stays in the fragment). */
  readonly approvalUrl?: (approvalId: string) => string;
  /** Clock (unix ms). */
  readonly now?: () => number;
}

export interface PolicySimulation {
  readonly decisionId: string;
  readonly outcome: "allow" | "confirm" | "deny";
  readonly notionalUsd: string | null;
  /** Every evaluated rule (pass, fail, trigger, warn), root first. */
  readonly rules: readonly PolicyRuleResult[];
  readonly violations: readonly PolicyViolation[];
  readonly triggers: readonly PolicyViolation[];
  readonly warnings: readonly string[];
  readonly code: string | null;
  readonly effectiveConstraints: IntentRequest["constraints"];
  readonly usage: readonly { readonly scope: string; readonly window: "24h" | "7d"; readonly usedUsd: string; readonly capUsd: string }[];
  readonly schedule: readonly { readonly scope: string; readonly open: boolean; readonly nextChange: string | null; readonly timezone: string | null }[];
}

export interface PolicySimulationInput {
  readonly ownerKeyId: string;
  readonly actorKeyId?: string;
  readonly request: IntentRequest;
  /** The dry-run graph of the narrowed request; null when planning failed (request-level rules only). */
  readonly graph: IntentGraph | null;
  readonly stage: "plan" | "prepare";
  /** What-if clock (schedule only). */
  readonly at?: number;
  /** A draft replacing the owner's own rule book (undefined: the active one; null: none). */
  readonly draft?: PolicyDocument | null;
}

export interface RuleBookGate extends PolicyGate {
  /** The request with the owner's chain narrowing applied (simulator; optional draft for the owner's level). */
  narrow(ownerKeyId: string, request: IntentRequest, draft?: PolicyDocument | null): Promise<IntentRequest>;
  /** Simulator (design §11.3): explains every rule; never throws on policy grounds, never reserves or holds. */
  simulate(input: PolicySimulationInput): Promise<PolicySimulation>;
}

interface PlanState {
  readonly snapshot: PolicyChainSnapshot;
  approval?: PolicyApprovalRecord;
}

/* ---------------------------------------------------------------- helpers */

const EXECUTION_CACHE_MS = 5_000;
const THRESHOLD_DEDUPE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIRM_TTL_SECONDS = 3_600;
/** Holds keep the intent alive at least this long, at most a day. */
const MAX_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function newDecisionId(): string {
  return `pdc_${randomHex(12)}`;
}

export function newApprovalId(): string {
  return `apr_${randomHex(16)}`;
}

/** True when anything in the chain governs the owner (a rule book at any level, or an agent key). */
export function chainGoverns(snapshot: PolicyChainSnapshot): boolean {
  return snapshot.levels.some((level) => level.policy !== null || level.defaults === "agent");
}

function entriesOf(levels: readonly PolicyChainLevel[], usage?: ReadonlyMap<string, PolicyWindowUsage>): PolicyChainEntry[] {
  return levels.map((level) => {
    const scoped = usage?.get(level.id);
    return {
      policy: level.policy,
      scope: level.scope,
      keyId: level.id,
      defaults: level.defaults,
      ...(scoped && windowCaps(level) ? { usage: scoped } : {}),
    };
  });
}

function linksOf(levels: readonly PolicyChainLevel[]): PolicyChainLink[] {
  return levels.flatMap((level) => (level.version !== null && level.hash !== null ? [{ scope: level.scope, id: level.id, version: level.version, hash: level.hash }] : []));
}

/** Documents as evaluated (agent keys without a rule book are the observer). */
function documentsOf(levels: readonly PolicyChainLevel[]): (PolicyDocument | null)[] {
  return levels.map((level) => level.policy ?? (level.defaults === "agent" ? OBSERVER_POLICY : null));
}

function windowCaps(level: PolicyChainLevel): ScopeCap | null {
  const caps = level.policy?.caps;
  if (!caps || (caps.dailyUsd === undefined && caps.weeklyUsd === undefined)) return null;
  return {
    scope: level.id,
    ...(caps.dailyUsd !== undefined ? { dailyUsdMicros: policyUsdMicros(caps.dailyUsd) } : {}),
    ...(caps.weeklyUsd !== undefined ? { weeklyUsdMicros: policyUsdMicros(caps.weeklyUsd) } : {}),
  };
}

function needsPrices(levels: readonly PolicyChainLevel[]): boolean {
  const documents = documentsOf(levels);
  return policyNeedsPricing(documents) || documents.some((document) => (document?.confirm?.when?.length ?? 0) > 0);
}

function requestDigest(request: IntentRequest): string {
  return `sha256:${sha256Hex(canonicalJson(request))}`;
}

function centsText(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function storeUnavailable(): PlatformError {
  return new PlatformError("STORE_UNAVAILABLE", "The rule book store cannot be read or written right now, so nothing is planned or prepared for this key. Retry shortly.", 503);
}

/** Store and ledger failures fail closed; policy errors pass through. */
function closed(error: unknown): PlatformError {
  if (isPlatformError(error) && error.status < 500) return error;
  if (isPlatformError(error) && error.code === "STORE_UNAVAILABLE") return error;
  console.warn("[platform] rule book store failed:", error instanceof Error ? error.message : error);
  return storeUnavailable();
}

function usageRows(usage: readonly ScopeUsage[]): NonNullable<PolicyDecision["usage"]> {
  return usage.map((entry) => ({ scope: entry.scope, window: entry.window, usedUsd: formatUsdMicros(entry.usedUsdMicros), capUsd: formatUsdMicros(entry.capUsdMicros) }));
}

function previewUsageRows(levels: readonly PolicyChainLevel[], usage: ReadonlyMap<string, PolicyWindowUsage> | undefined): NonNullable<PolicyDecision["usage"]> {
  if (!usage) return [];
  return levels.flatMap((level) => {
    const caps = windowCaps(level);
    const scoped = usage.get(level.id);
    if (!caps || !scoped) return [];
    return [
      ...(caps.dailyUsdMicros !== undefined ? [{ scope: level.id, window: "24h" as const, usedUsd: formatUsdMicros(scoped.dayUsdMicros), capUsd: formatUsdMicros(caps.dailyUsdMicros) }] : []),
      ...(caps.weeklyUsdMicros !== undefined ? [{ scope: level.id, window: "7d" as const, usedUsd: formatUsdMicros(scoped.weekUsdMicros), capUsd: formatUsdMicros(caps.weeklyUsdMicros) }] : []),
    ];
  });
}

/** Facts of a request alone (pre-plan checks: mode, permissions, accounts pin). */
function requestFacts(request: IntentRequest, stored: boolean): PolicyFacts {
  return {
    stage: "plan",
    stored,
    accounts: request.accounts,
    steps: [],
    intent: { stepCount: 0, networks: [], feesUsdMicros: 0n, notionalUsdMicros: 0n, crossNetwork: false },
  };
}

function revokedViolation(ownerKeyId: string, message: string): PolicyViolation {
  return { rule: "key.status", scope: "key", keyId: ownerKeyId, message };
}

/** The approval state the evaluator sees: expired by time, stale when the digest no longer matches. */
function approvalState(record: PolicyApprovalRecord | undefined, digest: string, now: number): PolicyApprovalState | null {
  if (!record) return null;
  if (record.status === "pending" && Date.parse(record.expiresAt) <= now) return { status: "expired" };
  if (record.status === "approved") {
    // An approval binds one intent shape: another digest never clears (stale).
    if (record.digest !== digest) return { status: "approved" };
    return { status: "approved", ceilingUsdMicros: record.ceilingUsdCents * 10_000n };
  }
  return { status: record.status };
}

function approvalReference(record: PolicyApprovalRecord, now: number): PolicyApprovalReference {
  const expired = record.status === "pending" && Date.parse(record.expiresAt) <= now;
  return { id: record.id, url: record.url, expiresAt: record.expiresAt, ceilingUsd: centsText(record.ceilingUsdCents), status: expired ? "expired" : record.status };
}

/* ------------------------------------------------------------------- gate */

export function createRuleBookGate(options: RuleBookGateOptions): RuleBookGate {
  const clock = options.now ?? (() => Date.now());
  const approvalUrl = options.approvalUrl ?? ((id: string) => `https://kletiaai.xyz/approve#${id}`);
  const states = new WeakMap<PlanGuard, PlanState>();
  const execution = new Map<string, { readonly pinNonce: boolean; readonly expiresAt: number }>();
  const thresholds = new Map<string, number>();

  async function readChain(ownerKeyId: string): Promise<PolicyChainSnapshot | undefined> {
    try {
      return await options.chains.chain(ownerKeyId);
    } catch (error) {
      throw closed(error);
    }
  }

  async function record(draft: PolicyDecisionDraft): Promise<PolicyDecision> {
    try {
      return await options.decisions.append(draft);
    } catch (error) {
      throw closed(error);
    }
  }

  function draftOf(snapshot: PolicyChainSnapshot, fields: Omit<PolicyDecisionDraft, "id" | "projectId" | "keyId" | "chain"> & { readonly id?: string; readonly chain?: readonly PolicyChainLink[] }): PolicyDecisionDraft {
    const { id, chain, ...rest } = fields;
    return {
      id: id ?? newDecisionId(),
      projectId: snapshot.projectId,
      keyId: snapshot.ownerKeyId,
      chain: chain ?? linksOf(snapshot.levels),
      ...rest,
    };
  }

  function announceViolation(snapshot: PolicyChainSnapshot, decision: PolicyDecision, violations: readonly PolicyViolation[], intentId?: string): void {
    publishPolicyEvent("policy.violation", {
      projectId: snapshot.projectId,
      keyId: snapshot.ownerKeyId,
      decisionId: decision.id,
      stage: decision.stage,
      ...(intentId ? { intentId } : {}),
      rules: [...new Set(violations.map((violation) => violation.rule))],
    });
  }

  /** Refuses with POLICY_OWNER_REVOKED (logged when the project is known). */
  async function refuseRevoked(ownerKeyId: string, snapshot: PolicyChainSnapshot | undefined, stage: "plan" | "prepare", at: number, request: IntentRequest, intentId?: string): Promise<never> {
    const violation = revokedViolation(ownerKeyId, snapshot ? "The key that owns this intent, or one of its ancestors, is revoked or expired." : "The key that owns this intent is unknown.");
    let decisionId: string | null = null;
    if (snapshot) {
      const decision = await record(draftOf(snapshot, {
        at: new Date(at).toISOString(), stage, outcome: "deny", actorKeyId: null, ...(intentId ? { intentId } : {}), dryRun: false,
        violations: [violation], triggers: [], warnings: [], requestDigest: requestDigest(request),
      }));
      decisionId = decision.id;
    }
    throw policyError("POLICY_OWNER_REVOKED", { decisionId, stage, outcome: "deny", keyId: ownerKeyId, violations: [violation], retryAt: null });
  }

  /* ------------------------------------------------------------- plan */

  async function beforePlan(input: { ownerKeyId?: string; actorKeyId?: string; request: IntentRequest; dryRun: boolean }): Promise<PlanGuard> {
    const base: PlanGuard = {
      request: input.request,
      ...(input.ownerKeyId !== undefined ? { ownerKeyId: input.ownerKeyId } : {}),
      ...(input.actorKeyId !== undefined ? { actorKeyId: input.actorKeyId } : {}),
      dryRun: input.dryRun,
      governed: false,
    };
    if (!input.ownerKeyId) return base;
    const at = clock();
    const snapshot = await readChain(input.ownerKeyId);
    if (!snapshot || !snapshot.keyActive) return refuseRevoked(input.ownerKeyId, snapshot, "plan", at, input.request);
    if (!chainGoverns(snapshot)) return base;
    // Request-level rules first: no quote is spent on a request the chain refuses outright.
    const evaluation = evaluatePolicyChain(entriesOf(snapshot.levels), requestFacts(input.request, !input.dryRun), { now: at, keyActive: true });
    if (evaluation.outcome === "deny") {
      const decision = await record(draftOf(snapshot, {
        at: new Date(at).toISOString(), stage: "plan", outcome: "deny", actorKeyId: input.actorKeyId ?? null, dryRun: input.dryRun,
        violations: evaluation.allViolations, triggers: [], warnings: [...evaluation.warnings], requestDigest: requestDigest(input.request),
      }));
      announceViolation(snapshot, decision, evaluation.allViolations);
      throw policyError(evaluation.code ?? "POLICY_VIOLATION", { decisionId: decision.id, stage: "plan", outcome: "deny", keyId: evaluation.violations[0]?.keyId ?? input.ownerKeyId, violations: evaluation.violations, retryAt: null });
    }
    const guard: PlanGuard = { ...base, request: narrowConstraints(documentsOf(snapshot.levels), input.request), governed: true };
    states.set(guard, { snapshot });
    return guard;
  }

  async function afterPlan(guard: PlanGuard, graph: IntentGraph): Promise<{ stamp: IntentPolicyStamp | null; ttlMs?: number }> {
    if (!guard.governed || !guard.ownerKeyId) return { stamp: null };
    const owner = guard.ownerKeyId;
    let state = states.get(guard);
    if (!state) {
      // A guard this gate did not issue (configuration changed mid-request): read the chain again.
      const snapshot = await readChain(owner);
      if (!snapshot || !snapshot.keyActive) return refuseRevoked(owner, snapshot, "plan", clock(), guard.request);
      state = { snapshot };
      states.set(guard, state);
    }
    const { snapshot } = state;
    const levels = snapshot.levels;
    const at = clock();
    const capped = levels.some((level) => windowCaps(level) !== null);
    let usage: ReadonlyMap<string, PolicyWindowUsage> | undefined;
    if (capped) {
      try {
        usage = await options.ledger.usage(levels.map((level) => level.id), at);
      } catch (error) {
        throw closed(error);
      }
    }
    const detailed = await policyFactsDetailed(graph, { stage: "plan", stored: !guard.dryRun, price: needsPrices(levels) });
    const evaluation = evaluatePolicyChain(entriesOf(levels, usage), detailed.facts, { now: at, keyActive: snapshot.keyActive });
    const violations = [...evaluation.allViolations];
    const triggers = evaluation.triggers;
    const notional = evaluation.notionalUsdMicros;
    if (violations.length === 0 && triggers.length > 0 && notional === null) {
      const first = triggers[0] as PolicyViolation;
      violations.push({ rule: "pricing.unavailable", scope: first.scope, ...(first.keyId ? { keyId: first.keyId } : {}), path: "intent.notionalUsd", message: "An approval needs a priced ceiling, and no fresh price covers this intent's value." });
    }
    const outcome = violations.length > 0 ? "deny" : triggers.length > 0 ? "confirm" : "allow";
    const decisionId = newDecisionId();
    const warnings = [...new Set([...evaluation.warnings, ...detailed.warnings])];
    let approval: PolicyApprovalRecord | undefined;
    let ttlMs: number | undefined;
    if (outcome === "confirm" && !guard.dryRun && notional !== null) {
      const triggering = levels.filter((level) => triggers.some((entry) => entry.keyId === level.id));
      const ttlSeconds = Math.min(...triggering.map((level) => level.policy?.confirm?.ttlSeconds ?? DEFAULT_CONFIRM_TTL_SECONDS), DEFAULT_CONFIRM_TTL_SECONDS * 24);
      const deadline = graph.request.constraints?.deadline !== undefined ? graph.request.constraints.deadline * 1000 : Number.POSITIVE_INFINITY;
      ttlMs = Math.min(MAX_HOLD_TTL_MS, Math.max(INTENT_TTL_MS, ttlSeconds * 1000));
      const expires = Math.min(at + ttlSeconds * 1000, at + ttlMs, deadline);
      const id = newApprovalId();
      const approvers: ApproverRequirement[] = triggering.map((level) => ({
        scope: level.scope,
        id: level.id,
        keys: [...(level.policy?.confirm?.approvers?.keys ?? [])],
        wallets: [...(level.policy?.confirm?.approvers?.wallets ?? [])],
        requireWallet: level.policy?.confirm?.approvers?.requireWallet ?? false,
      }));
      approval = {
        id,
        projectId: snapshot.projectId,
        keyId: owner,
        lineage: [...snapshot.lineage],
        intentId: graph.id,
        digest: approvalDigest(graph, owner),
        ceilingUsdCents: approvalCeilingUsdCents(notional),
        notionalUsd: formatUsdMicros(notional),
        triggers: [...new Set(triggers.map((entry) => entry.rule))],
        approvers,
        status: "pending",
        url: approvalUrl(id),
        expiresAt: new Date(expires).toISOString(),
        createdAt: new Date(at).toISOString(),
      };
    }
    const decision = await record(draftOf(snapshot, {
      id: decisionId,
      at: new Date(at).toISOString(),
      stage: "plan",
      outcome,
      actorKeyId: guard.actorKeyId ?? null,
      ...(guard.dryRun ? {} : { intentId: graph.id }),
      dryRun: guard.dryRun,
      ...(notional !== null ? { notionalUsd: formatUsdMicros(notional) } : {}),
      ...(capped ? { usage: previewUsageRows(levels, usage) } : {}),
      violations,
      triggers: [...triggers],
      warnings,
      requestDigest: requestDigest(graph.request),
      title: graph.summary.title.slice(0, 200),
      ...(approval ? { approvalId: approval.id } : {}),
    }));
    if (outcome === "deny") {
      announceViolation(snapshot, decision, violations, guard.dryRun ? undefined : graph.id);
      throw policyError(policyErrorCode(violations) ?? "POLICY_VIOLATION", {
        decisionId: decision.id, stage: "plan", outcome: "deny", keyId: violations[0]?.keyId ?? owner, violations, retryAt: null,
      });
    }
    if (approval) state.approval = approval;
    const stamp: IntentPolicyStamp = {
      decisionId: decision.id,
      outcome,
      keyId: owner,
      chain: linksOf(levels),
      notionalUsd: notional !== null && needsPrices(levels) ? formatUsdMicros(notional) : null,
      evaluatedAt: new Date(at).toISOString(),
      ...(approval
        ? { approval: { id: approval.id, url: approval.url, expiresAt: approval.expiresAt, ceilingUsd: centsText(approval.ceilingUsdCents), triggers: approval.triggers } }
        : {}),
    };
    return { stamp, ...(ttlMs !== undefined ? { ttlMs } : {}) };
  }

  async function afterCreate(guard: PlanGuard, graph: IntentGraph): Promise<void> {
    const state = states.get(guard);
    const pending = state?.approval;
    if (!state || !pending) return;
    let created: PolicyApprovalRecord;
    try {
      created = await options.approvals.create({ ...pending, intentId: graph.id });
    } catch (error) {
      throw closed(error);
    }
    state.approval = undefined;
    publishPolicyEvent("policy.approval_requested", {
      projectId: state.snapshot.projectId,
      keyId: created.keyId,
      approvalId: created.id,
      intentId: graph.id,
      decisionId: graph.policy?.decisionId ?? "",
      notionalUsd: created.notionalUsd,
      ceilingUsd: centsText(created.ceilingUsdCents),
      url: created.url,
      expiresAt: created.expiresAt,
      triggers: [...created.triggers],
    });
  }

  /* ---------------------------------------------------------- prepare */

  async function clear(input: PayloadClearanceInput, attempt: number): Promise<ExposureHandle | null> {
    const owner = input.ownerKeyId;
    if (!owner) return null;
    const { graph, step } = input;
    const at = input.now;
    const decisionId = newDecisionId();
    const snapshot = await readChain(owner);
    if (!snapshot || !snapshot.keyActive) return refuseRevoked(owner, snapshot, "prepare", at, graph.request, graph.id);
    if (!chainGoverns(snapshot)) return null;
    const levels = snapshot.levels;
    const links = linksOf(levels);
    if (CHAINS[step.network].vm === "svm" && input.solanaBlockHeight) {
      const height = await input.solanaBlockHeight();
      if (height !== null) await options.ledger.expire(graph.id, step.id, height).catch((error: unknown) => {
        console.warn("[platform] expiring Solana exposures failed:", error instanceof Error ? error.message : error);
      });
    }
    const detailed = await policyFactsDetailed(graph, { stage: "prepare", stored: true, price: true });
    const exposureUsd = stepExposureUsdMicros(detailed.facts, step.id);
    let held: PolicyApprovalRecord | undefined;
    try {
      held = await options.approvals.forIntent(graph.id);
    } catch (error) {
      throw closed(error);
    }
    const digest = approvalDigest(graph, owner);
    const evaluation: PolicyEvaluation = evaluatePolicyChain(entriesOf(levels), detailed.facts, {
      now: at,
      keyActive: true,
      approval: approvalState(held, digest, at),
      ...(exposureUsd !== null ? { windowDeltaUsdMicros: exposureUsd } : {}),
    });
    const violations = [...evaluation.allViolations];
    const caps = levels.flatMap((level) => {
      const cap = windowCaps(level);
      return cap ? [cap] : [];
    });
    const stepIndex = detailed.facts.steps.find((entry) => entry.id === step.id)?.index ?? step.index;
    if (exposureUsd === null && caps.length > 0 && !violations.some((violation) => violation.rule === "pricing.unavailable")) {
      const level = levels.find((candidate) => windowCaps(candidate) !== null) as PolicyChainLevel;
      violations.push({ rule: "pricing.unavailable", scope: level.scope, keyId: level.id, path: `steps[${stepIndex}].input`, message: "The spend windows need this payload's USD value, and no fresh price covers it." });
    }
    if (evaluation.triggers.length > 0 && evaluation.notionalUsdMicros === null && !violations.some((violation) => violation.rule === "pricing.unavailable")) {
      const first = evaluation.triggers[0] as PolicyViolation;
      violations.push({ rule: "pricing.unavailable", scope: first.scope, ...(first.keyId ? { keyId: first.keyId } : {}), path: "intent.notionalUsd", message: "An approval needs a priced ceiling, and no fresh price covers this intent's value." });
    }
    // A hold stamped at plan stays a hold: fresh prices below the threshold never lift it (§7.1).
    const stamped = graph.policy?.outcome === "confirm" ? graph.policy : undefined;
    if (stamped && evaluation.triggers.length === 0) {
      const tag = { scope: "key" as const, keyId: stamped.keyId };
      const state = approvalState(held, digest, at);
      const notional = evaluation.notionalUsdMicros;
      if (!state || state.status === "pending") violations.push({ rule: "approval.required", ...tag, message: "This intent is on hold until an approver approves it." });
      else if (state.status === "rejected") violations.push({ rule: "approval.rejected", ...tag, message: "An approver rejected this intent." });
      else if (state.status === "expired") violations.push({ rule: "approval.expired", ...tag, message: "The approval expired before it was decided." });
      else if (state.ceilingUsdMicros === undefined || notional === null || notional > state.ceilingUsdMicros) {
        violations.push({ rule: "approval.stale", ...tag, message: "The fresh value is above the approved ceiling (or cannot be priced); plan a new intent.", observed: notional === null ? "unpriced" : formatUsdMicros(notional), ...(state.ceilingUsdMicros !== undefined ? { limit: formatUsdMicros(state.ceilingUsdMicros) } : {}) });
      }
    }
    // The hold row is created now when fresh prices raised a trigger after an allowed plan, or when the
    // row of a stamped hold is missing (its creation failed after the intent was stored).
    const holdOnly = violations.length > 0 && violations.every((violation) => violation.rule === "approval.required");
    const stampCents = stamped?.approval && /^\d+\.\d{2}$/u.test(stamped.approval.ceilingUsd) ? BigInt(stamped.approval.ceilingUsd.replace(".", "")) : null;
    if (!held && holdOnly && (stampCents !== null || evaluation.notionalUsdMicros !== null)) {
      const triggering = levels.filter((level) => evaluation.triggers.some((entry) => entry.keyId === level.id) || (stamped !== undefined && level.policy?.confirm !== undefined));
      const ttlSeconds = Math.min(DEFAULT_CONFIRM_TTL_SECONDS * 24, ...triggering.map((level) => level.policy?.confirm?.ttlSeconds ?? DEFAULT_CONFIRM_TTL_SECONDS));
      const fromStamp = stampCents !== null ? stamped?.approval : undefined;
      const id = fromStamp?.id ?? newApprovalId();
      const notional = evaluation.notionalUsdMicros;
      const ceilingUsdCents = stampCents ?? approvalCeilingUsdCents(notional as bigint);
      try {
        held = await options.approvals.create({
          id,
          projectId: snapshot.projectId,
          keyId: owner,
          lineage: [...snapshot.lineage],
          intentId: graph.id,
          digest,
          ceilingUsdCents,
          notionalUsd: fromStamp && stamped?.notionalUsd ? stamped.notionalUsd : formatUsdMicros(notional ?? 0n),
          triggers: fromStamp ? [...fromStamp.triggers] : [...new Set(evaluation.triggers.map((entry) => entry.rule))],
          approvers: triggering.map((level) => ({
            scope: level.scope,
            id: level.id,
            keys: [...(level.policy?.confirm?.approvers?.keys ?? [])],
            wallets: [...(level.policy?.confirm?.approvers?.wallets ?? [])],
            requireWallet: level.policy?.confirm?.approvers?.requireWallet ?? false,
          })),
          status: "pending",
          url: fromStamp?.url ?? approvalUrl(id),
          expiresAt: fromStamp?.expiresAt ?? new Date(Math.min(at + ttlSeconds * 1000, Date.parse(graph.expiresAt) || Number.POSITIVE_INFINITY)).toISOString(),
          createdAt: new Date(at).toISOString(),
        });
      } catch (error) {
        throw closed(error);
      }
      if (held.id === id) {
        publishPolicyEvent("policy.approval_requested", {
          projectId: snapshot.projectId, keyId: owner, approvalId: held.id, intentId: graph.id, decisionId,
          notionalUsd: held.notionalUsd, ceilingUsd: centsText(held.ceilingUsdCents), url: held.url, expiresAt: held.expiresAt, triggers: [...held.triggers],
        });
      }
    }
    const notionalText = evaluation.notionalUsdMicros !== null ? formatUsdMicros(evaluation.notionalUsdMicros) : undefined;
    if (violations.length > 0) {
      const code = policyErrorCode(violations) ?? "POLICY_VIOLATION";
      const decision = await record(draftOf(snapshot, {
        id: decisionId, at: new Date(at).toISOString(), stage: "prepare", outcome: "deny", actorKeyId: null, intentId: graph.id, stepId: step.id, dryRun: false,
        ...(notionalText ? { notionalUsd: notionalText } : {}),
        violations, triggers: [...evaluation.triggers], warnings: [...new Set([...evaluation.warnings, ...detailed.warnings])],
        requestDigest: requestDigest(graph.request), title: graph.summary.title.slice(0, 200),
        ...(held ? { approvalId: held.id } : {}),
      }));
      announceViolation(snapshot, decision, violations, graph.id);
      const retryAfter = code === "POLICY_SCHEDULE_CLOSED" || code === "POLICY_APPROVAL_REQUIRED" ? evaluation.retryAfterSeconds ?? (code === "POLICY_APPROVAL_REQUIRED" ? 15 : null) : null;
      throw policyError(code, {
        decisionId: decision.id,
        stage: "prepare",
        outcome: "deny",
        keyId: violations[0]?.keyId ?? owner,
        violations,
        retryAt: retryAfter !== null ? new Date(at + retryAfter * 1000).toISOString() : null,
        ...(held && violations.some((violation) => violation.rule.startsWith("approval.")) ? { approval: approvalReference(held, at) } : {}),
      }, retryAfter);
    }
    const exposure: ExposureRecord = {
      id: input.exposure.id,
      projectId: snapshot.projectId,
      ownerKeyId: owner,
      intentId: graph.id,
      stepId: step.id,
      network: step.network,
      quoteBinding: input.quoteBinding,
      exclusiveKey: input.exposure.exclusiveKey,
      validUntilHeight: input.exposure.validUntilHeight,
      usdMicros: exposureUsd ?? 0n,
      decisionId,
      createdAt: at,
    };
    let result;
    try {
      result = await options.ledger.reserve({ exposure, scopes: levels.map((level) => level.id), caps, chain: links, now: at });
    } catch (error) {
      throw closed(error);
    }
    if (!result.ok && result.reason === "chain_changed") {
      if (attempt < 2) return clear(input, attempt + 1);
      throw new PlatformError("STORE_UNAVAILABLE", "The rule book changed while this payload was being cleared. Retry shortly.", 503);
    }
    if (!result.ok) {
      const level = levels.find((candidate) => candidate.id === result.scope);
      const entry = result.usage.find((row) => row.scope === result.scope && row.window === result.window);
      const before = entry ? entry.usedUsdMicros - entry.deltaUsdMicros : 0n;
      const violation: PolicyViolation = {
        rule: result.window === "24h" ? "caps.dailyUsd" : "caps.weeklyUsd",
        scope: level?.scope ?? "key",
        keyId: result.scope,
        message: `This payload would move $${formatUsdMicros(entry?.usedUsdMicros ?? 0n)} in the ${result.window === "24h" ? "rolling 24 hours" : "rolling 7 days"} of ${result.scope}, above the cap.${input.exposure.exclusiveKey === null && CHAINS[step.network].vm === "evm" ? " Every unpinned payload counts on its own (an earlier one can still be signed); pin nonces to let re-prepares supersede each other." : ""}`,
        observed: `${formatUsdMicros(entry?.deltaUsdMicros ?? exposure.usdMicros)} + ${formatUsdMicros(before)} used`,
        limit: entry ? formatUsdMicros(entry.capUsdMicros) : "cap",
      };
      const decision = await record(draftOf(snapshot, {
        id: decisionId, at: new Date(at).toISOString(), stage: "prepare", outcome: "deny", actorKeyId: null, intentId: graph.id, stepId: step.id, dryRun: false,
        notionalUsd: formatUsdMicros(exposure.usdMicros), usage: usageRows(result.usage), violations: [violation], triggers: [...evaluation.triggers],
        warnings: [...new Set([...evaluation.warnings, ...detailed.warnings])], requestDigest: requestDigest(graph.request), title: graph.summary.title.slice(0, 200),
      }));
      announceViolation(snapshot, decision, [violation], graph.id);
      const retryAfter = result.retryAt !== null ? Math.max(1, Math.ceil((result.retryAt - at) / 1000)) : null;
      throw policyError("POLICY_SPEND_LIMIT", {
        decisionId: decision.id, stage: "prepare", outcome: "deny", keyId: result.scope, violations: [violation],
        retryAt: result.retryAt !== null ? new Date(result.retryAt).toISOString() : null,
      }, retryAfter);
    }
    let decision: PolicyDecision;
    try {
      decision = await record(draftOf(snapshot, {
        id: decisionId, at: new Date(at).toISOString(), stage: "prepare", outcome: "allow", actorKeyId: null, intentId: graph.id, stepId: step.id, dryRun: false,
        notionalUsd: formatUsdMicros(exposure.usdMicros), ...(result.usage.length > 0 ? { usage: usageRows(result.usage) } : {}),
        violations: [], triggers: [...evaluation.triggers], warnings: [...new Set([...evaluation.warnings, ...detailed.warnings])],
        requestDigest: requestDigest(graph.request), title: graph.summary.title.slice(0, 200), exposureId: exposure.id,
        ...(held ? { approvalId: held.id } : {}),
      }));
    } catch (error) {
      await options.ledger.abort(exposure.id).catch(() => undefined);
      throw error;
    }
    announceThresholds(snapshot, decision.id, result.usage, at);
    return {
      decisionId: decision.id,
      exposureId: exposure.id,
      notionalUsd: exposureUsd === null ? null : formatUsdMicros(exposureUsd),
      chainHashes: links.map((link) => link.hash),
      commit: async () => undefined,
      abort: async () => {
        await options.ledger.abort(exposure.id);
      },
    };
  }

  function announceThresholds(snapshot: PolicyChainSnapshot, decisionId: string, usage: readonly ScopeUsage[], at: number): void {
    for (const [key, expires] of thresholds) if (expires <= at) thresholds.delete(key);
    for (const entry of usage) {
      const before = entry.usedUsdMicros - entry.deltaUsdMicros;
      for (const pct of [80, 95] as const) {
        const line = (entry.capUsdMicros * BigInt(pct) + 99n) / 100n;
        if (!(before < line && entry.usedUsdMicros >= line)) continue;
        const key = `${entry.scope}|${entry.window}|${pct}`;
        if (thresholds.has(key)) continue;
        thresholds.set(key, at + THRESHOLD_DEDUPE_MS);
        publishPolicyEvent("policy.spend_threshold", {
          projectId: snapshot.projectId,
          keyId: entry.scope.startsWith("prj_") ? null : entry.scope,
          scope: entry.scope,
          window: entry.window,
          thresholdPct: pct,
          usedUsd: formatUsdMicros(entry.usedUsdMicros),
          capUsd: formatUsdMicros(entry.capUsdMicros),
          decisionId,
        });
      }
    }
  }

  /* ---------------------------------------------------- verification */

  async function reconcile(input: VerificationReconcileInput): Promise<void> {
    const owner = input.ownerKeyId ?? input.graph.policy?.keyId ?? null;
    if (!owner) return;
    const { graph, step } = input;
    const at = clock();
    const landed = await options.ledger.land({ intentId: graph.id, stepId: step.id, quoteBinding: input.quoteBinding ?? null, now: at });
    if (landed.length === 0) {
      const snapshot = await options.chains.chain(owner);
      if (!snapshot || !chainGoverns(snapshot)) return;
      const detailed = await policyFactsDetailed(graph, { stage: "prepare", stored: true, price: true });
      const usd = stepExposureUsdMicros(detailed.facts, step.id) ?? 0n;
      const binding = input.quoteBinding ?? step.prepared?.quoteBinding ?? "";
      const decisionId = newDecisionId();
      const exposure: ExposureRecord = {
        id: policyExposureId(graph.id, step.id, `${binding}|uncleared`),
        projectId: snapshot.projectId, ownerKeyId: owner, intentId: graph.id, stepId: step.id, network: step.network,
        quoteBinding: binding, exclusiveKey: null, validUntilHeight: null, usdMicros: usd, decisionId, createdAt: at,
      };
      await options.ledger.recordLanded(exposure, snapshot.levels.map((level) => level.id));
      const violation: PolicyViolation = {
        rule: "submit.uncleared", scope: "key", keyId: owner, path: `steps[${step.index}]`,
        message: "A verified payload had no cleared exposure (prepared before the rule book applied); it now counts as landed.",
        observed: formatUsdMicros(usd),
      };
      const decision = await options.decisions.append(draftOf(snapshot, {
        id: decisionId, at: new Date(at).toISOString(), stage: "submit", outcome: "observed", actorKeyId: null, intentId: graph.id, stepId: step.id,
        dryRun: false, notionalUsd: formatUsdMicros(usd), violations: [violation], triggers: [], warnings: [], requestDigest: requestDigest(graph.request), exposureId: exposure.id,
      }));
      announceViolation(snapshot, decision, [violation], graph.id);
      return;
    }
    const landedNonce = input.landedNonces?.[0] ?? null;
    const pinned = landed.flatMap((exposure) => {
      const nonce = exclusiveKeyNonce(exposure.exclusiveKey);
      return nonce !== null && exposure.exclusiveKey ? [{ nonce, key: exposure.exclusiveKey }] : [];
    });
    if (landedNonce === null || pinned.length === 0 || pinned.some((entry) => entry.nonce === landedNonce)) return;
    for (const key of new Set(pinned.map((entry) => entry.key))) await options.ledger.clearExclusive(key);
    const snapshot = await options.chains.chain(owner);
    if (!snapshot) return;
    const violation: PolicyViolation = {
      rule: "execution.pinNonce", scope: "key", keyId: owner, path: `steps[${step.index}].nonce`,
      message: "The landed transaction used another nonce than the pinned one; its re-prepares now count in full.",
      observed: landedNonce, limit: pinned.map((entry) => entry.nonce).join(", "),
    };
    const decision = await options.decisions.append(draftOf(snapshot, {
      at: new Date(at).toISOString(), stage: "submit", outcome: "observed", actorKeyId: null, intentId: graph.id, stepId: step.id,
      dryRun: false, violations: [violation], triggers: [], warnings: [], requestDigest: requestDigest(graph.request),
      ...(landed[0] ? { exposureId: landed[0].id } : {}),
    }));
    announceViolation(snapshot, decision, [violation], graph.id);
  }

  /* -------------------------------------------------------- simulator */

  async function snapshotWithDraft(ownerKeyId: string, draft: PolicyDocument | null | undefined): Promise<PolicyChainSnapshot> {
    const snapshot = await readChain(ownerKeyId);
    if (!snapshot) throw new PlatformError("KEY_NOT_FOUND", "API key not found.", 404);
    if (draft === undefined) return snapshot;
    const levels = snapshot.levels.map((level, index) =>
      index === snapshot.levels.length - 1 ? { ...level, policy: draft, version: null, hash: null } : level);
    return { ...snapshot, levels };
  }

  async function narrow(ownerKeyId: string, request: IntentRequest, draft?: PolicyDocument | null): Promise<IntentRequest> {
    const snapshot = await snapshotWithDraft(ownerKeyId, draft);
    return narrowConstraints(documentsOf(snapshot.levels), request);
  }

  async function simulate(input: PolicySimulationInput): Promise<PolicySimulation> {
    const snapshot = await snapshotWithDraft(input.ownerKeyId, input.draft);
    const levels = snapshot.levels;
    const at = input.at ?? clock();
    const capped = levels.some((level) => windowCaps(level) !== null);
    let usage: ReadonlyMap<string, PolicyWindowUsage> | undefined;
    if (capped) {
      try {
        usage = await options.ledger.usage(levels.map((level) => level.id), clock());
      } catch (error) {
        throw closed(error);
      }
    }
    const stage = input.stage;
    let facts: PolicyFacts;
    let warnings: readonly string[] = [];
    if (input.graph) {
      const detailed = await policyFactsDetailed(input.graph, { stage: "evaluate", stored: false, price: needsPrices(levels) || stage === "prepare" });
      facts = stage === "prepare" ? { ...detailed.facts, stage: "prepare", stored: true } : detailed.facts;
      warnings = detailed.warnings;
    } else {
      facts = requestFacts(input.request, false);
    }
    const evaluation = evaluatePolicyChain(entriesOf(levels, usage), facts, {
      now: at,
      keyActive: snapshot.keyActive,
      // The simulator explains holds without deciding them: a prepare-stage run reports the trigger as approval.required.
      approval: null,
    });
    const decision = await record(draftOf(snapshot, {
      at: new Date(clock()).toISOString(), stage: "evaluate", outcome: evaluation.outcome, actorKeyId: input.actorKeyId ?? null, dryRun: true,
      ...(evaluation.notionalUsdMicros !== null ? { notionalUsd: formatUsdMicros(evaluation.notionalUsdMicros) } : {}),
      ...(capped ? { usage: previewUsageRows(levels, usage) } : {}),
      violations: evaluation.allViolations, triggers: [...evaluation.triggers], warnings: [...new Set([...evaluation.warnings, ...warnings])],
      requestDigest: requestDigest(input.request), ...(input.graph ? { title: input.graph.summary.title.slice(0, 200) } : {}),
    }));
    return {
      decisionId: decision.id,
      outcome: evaluation.outcome,
      notionalUsd: evaluation.notionalUsdMicros !== null ? formatUsdMicros(evaluation.notionalUsdMicros) : null,
      rules: evaluation.rules,
      violations: evaluation.violations,
      triggers: evaluation.triggers,
      warnings: [...new Set([...evaluation.warnings, ...warnings])],
      code: evaluation.code,
      effectiveConstraints: narrowConstraints(documentsOf(levels), input.request).constraints,
      usage: previewUsageRows(levels, usage),
      schedule: levels.flatMap((level) => {
        const schedule = level.policy?.schedule;
        if (!schedule) return [];
        const state = scheduleState(schedule, at);
        return [{ scope: level.id, open: state.open, nextChange: state.nextChange, timezone: state.timezone }];
      }),
    };
  }

  return {
    beforePlan,
    afterPlan,
    afterCreate,
    beforePayload: (input) => clear(input, 1),
    async executionOptions(ownerKeyId) {
      if (!ownerKeyId) return { pinNonce: false };
      const at = clock();
      const cached = execution.get(ownerKeyId);
      if (cached && cached.expiresAt > at) return { pinNonce: cached.pinNonce };
      const snapshot = await readChain(ownerKeyId);
      const pinNonce = snapshot !== undefined && snapshot.keyActive && chainGoverns(snapshot) && effectiveExecution(entriesOf(snapshot.levels)).pinNonce;
      execution.set(ownerKeyId, { pinNonce, expiresAt: at + EXECUTION_CACHE_MS });
      while (execution.size > 10_000) {
        const oldest = execution.keys().next().value;
        if (oldest === undefined) break;
        execution.delete(oldest);
      }
      return { pinNonce };
    },
    async afterVerification(input) {
      try {
        await reconcile(input);
      } catch (error) {
        console.warn(`[platform] policy reconcile of ${input.graph.id}/${input.step.id} failed:`, error instanceof Error ? error.message : error);
      }
    },
    narrow,
    simulate,
  };
}
