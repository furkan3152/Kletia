/**
 * Evaluates a chain of Rule Books and the effective permissions,
 * execution, perps and prediction views.
 */
import { PERPS_LIMITS, PERPS_VENUE_IDS, type PerpsVenueId } from "../perps.js";
import {
  PREDICTION_LIMITS,
  PREDICTION_VENUES,
  type PredictionVenueId,
} from "../predictions.js";
import {
  AGENT_POLICY_DEFAULTS,
  formatUsdMicros,
  OBSERVER_POLICY,
  POLICY_LIMITS,
  POLICY_PERMISSIONS,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyPermission,
} from "../policy.js";
import {
  policyErrorCode,
  type PolicyEvaluation,
  type PolicyFacts,
  type PolicyOutcome,
  type PolicyRuleId,
  type PolicyViolation,
  type PolicyWindowUsage,
} from "./rules.js";
import { policyNotionalUsdMicros, usdText } from "./facts.js";
import { evaluatePolicy } from "./evaluate.js";

export interface PolicyChainEntry {
  /** null: no rule book at this level (project defaults) or the observer (agent defaults). */
  readonly policy: PolicyDocument | null;
  readonly scope: "project" | "key";
  /** Key id (or `prj_…`) whose rule book this is; tags the results. */
  readonly keyId?: string;
  /** Agent keys: `agent`. */
  readonly defaults?: PolicyDefaults;
  readonly usage?: PolicyWindowUsage;
}

export interface PolicyApprovalState {
  readonly status: "pending" | "approved" | "rejected" | "expired";
  /** Approved ceiling in micro-dollars (`approvalCeilingUsdCents` × 10,000). */
  readonly ceilingUsdMicros?: bigint;
}

export interface PolicyChainOptions {
  readonly now?: number | Date;
  readonly keyActive?: boolean;
  /** Prepare and sign: the hold's state (null or absent = none yet). */
  readonly approval?: PolicyApprovalState | null;
  readonly windowDeltaUsdMicros?: bigint;
}

/**
 * Evaluates a chain root first (project rule book, lineage, the key's own)
 * and combines the results: the worst outcome wins; at prepare and sign a
 * `confirm` needs an approved approval whose ceiling covers the fresh value
 * (an approval satisfies `confirm.*` triggers only).
 */
export function evaluatePolicyChain(chain: readonly PolicyChainEntry[], facts: PolicyFacts, options: PolicyChainOptions = {}): PolicyEvaluation {
  const results = chain.map((entry) =>
    evaluatePolicy(entry.policy, facts, {
      scope: entry.scope,
      ...(entry.keyId !== undefined ? { keyId: entry.keyId } : {}),
      ...(entry.defaults !== undefined ? { defaults: entry.defaults } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.keyActive !== undefined ? { keyActive: options.keyActive } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(options.windowDeltaUsdMicros !== undefined ? { windowDeltaUsdMicros: options.windowDeltaUsdMicros } : {}),
    }),
  );
  const violations = results.flatMap((result) => result.allViolations);
  const triggers = results.flatMap((result) => result.triggers);
  const rules = results.flatMap((result) => result.rules);
  const warnings = [...new Set(results.flatMap((result) => result.warnings))];
  const notional = policyNotionalUsdMicros(facts.steps).value;
  let retryAfterSeconds = results.reduce<number | null>((max, result) => (result.retryAfterSeconds === null ? max : Math.max(max ?? 0, result.retryAfterSeconds)), null);
  const enforcing = facts.stage === "prepare" || facts.stage === "sign";
  let held = triggers.length > 0;
  if (enforcing && held) {
    const first = triggers[0] as PolicyViolation;
    const tag = { scope: first.scope, ...(first.keyId !== undefined ? { keyId: first.keyId } : {}) };
    const approval = options.approval ?? null;
    const add = (rule: PolicyRuleId, message: string, extra: Partial<PolicyViolation> = {}) => {
      violations.push({ rule, ...tag, message, ...extra });
      rules.push({ rule, ...tag, status: "fail", message });
    };
    if (approval === null || approval.status === "pending") {
      add("approval.required", "This intent is on hold until an approver approves it.");
      retryAfterSeconds = retryAfterSeconds ?? 15;
    } else if (approval.status === "rejected") add("approval.rejected", "An approver rejected this intent.");
    else if (approval.status === "expired") add("approval.expired", "The approval expired before it was decided.");
    else if (approval.ceilingUsdMicros === undefined || notional === null || notional > approval.ceilingUsdMicros) {
      // An approval never lifts what it cannot bound: no ceiling, or an unpriced fresh value, is stale.
      add("approval.stale", "The fresh value is above the approved ceiling (or cannot be priced); plan a new intent.", {
        observed: usdText(notional),
        ...(approval.ceilingUsdMicros !== undefined ? { limit: formatUsdMicros(approval.ceilingUsdMicros) } : {}),
      });
    } else {
      rules.push({ rule: "approval.required", ...tag, status: "pass", observed: "approved" });
      held = false;
    }
  }
  const outcome: PolicyOutcome = violations.length > 0 ? "deny" : held ? "confirm" : "allow";
  const code = policyErrorCode(violations);
  return {
    outcome,
    violations: violations.slice(0, POLICY_LIMITS.violationsReturned),
    allViolations: violations,
    triggers,
    rules,
    warnings,
    notionalUsdMicros: notional,
    code,
    retryAfterSeconds: code === "POLICY_SCHEDULE_CLOSED" || code === "POLICY_APPROVAL_REQUIRED" ? retryAfterSeconds : null,
  };
}

/* ========================================================= chain-level views */

/** API rights of a key: AND over the agent rule books of its chain (project rule books never grant or restrict them). */
export function effectivePermissions(chain: readonly Pick<PolicyChainEntry, "policy" | "defaults">[]): Readonly<Record<PolicyPermission, boolean>> {
  const out = Object.fromEntries(POLICY_PERMISSIONS.map((permission) => [permission, true])) as Record<PolicyPermission, boolean>;
  for (const entry of chain) {
    if (entry.defaults !== "agent") continue;
    const document = entry.policy ?? OBSERVER_POLICY;
    for (const permission of POLICY_PERMISSIONS) {
      out[permission] = out[permission] && (document.permissions?.[permission] ?? AGENT_POLICY_DEFAULTS.permissions[permission]);
    }
  }
  return out;
}

/** Execution options of a chain: nonces are pinned when any rule book pins them (agents by default). */
export function effectiveExecution(chain: readonly Pick<PolicyChainEntry, "policy" | "defaults">[]): { readonly pinNonce: boolean } {
  return {
    pinNonce: chain.some((entry) => entry.policy?.execution?.pinNonce ?? (entry.defaults === "agent" ? AGENT_POLICY_DEFAULTS.pinNonce : false)),
  };
}

/** What a chain allows on /v1/perps (perps.* of every level, plus mode and protocol lists). */
export interface PerpsPolicyView {
  /** False when any level disables perps (agents by default), pauses or only dry-runs. */
  readonly enabled: boolean;
  /** Lowest perps.maxLeverage the chain sets (PERPS_LIMITS.defaultMaxLeverage when none sets one). */
  readonly maxLeverage: number;
  /** Venues every level allows (perps.venues and protocols.allow / deny). */
  readonly venues: readonly PerpsVenueId[];
  /** Why perps are disabled, when they are. */
  readonly reason: string | null;
}

/** Perps rights of a chain: AND of every level, the lowest leverage cap, the intersection of venues. */
export function effectivePerps(chain: readonly Pick<PolicyChainEntry, "policy" | "defaults">[]): PerpsPolicyView {
  let maxLeverage: number | null = null;
  let venues: PerpsVenueId[] = [...PERPS_VENUE_IDS];
  let reason: string | null = null;
  for (const entry of chain) {
    const agent = entry.defaults === "agent";
    const document = entry.policy ?? (agent ? OBSERVER_POLICY : null);
    if (!document) continue;
    if (!(document.perps?.enabled ?? (agent ? AGENT_POLICY_DEFAULTS.perpsEnabled : true))) {
      reason ??= agent ? "Agent keys trade perps only when their rule book sets perps.enabled." : "A rule book of this key disables perps.";
    }
    const mode = document.mode ?? "live";
    if (mode !== "live") reason ??= `A rule book of this key is ${mode}.`;
    const cap = document.perps?.maxLeverage;
    if (cap !== undefined) maxLeverage = Math.min(maxLeverage ?? cap, cap);
    const allowed = document.perps?.venues;
    const protocolAllow = document.protocols?.allow;
    const protocolDeny = document.protocols?.deny ?? [];
    venues = venues.filter((venue) => (!allowed || allowed.includes(venue)) && (!protocolAllow || protocolAllow.includes(venue)) && !protocolDeny.includes(venue));
  }
  return { enabled: reason === null, maxLeverage: maxLeverage ?? PERPS_LIMITS.defaultMaxLeverage, venues, reason };
}

/** What a chain allows on /v1/predictions (predictions.* of every level, plus mode and protocol lists). */
export interface PredictionPolicyView {
  /** False when any level disables prediction markets (agents by default), pauses or only dry-runs. */
  readonly enabled: boolean;
  /** Lowest predictions.maxStakeUsd the chain sets (PREDICTION_LIMITS.defaultMaxStakeUsd when none sets one), per order. */
  readonly maxStakeUsd: number;
  /** Live venues every level allows (predictions.venues and protocols.allow / deny). */
  readonly venues: readonly PredictionVenueId[];
  /** Why prediction markets are disabled, when they are. */
  readonly reason: string | null;
}

/** Prediction rights of a chain: AND of every level, the lowest stake cap, the intersection of venues. */
export function effectivePredictions(chain: readonly Pick<PolicyChainEntry, "policy" | "defaults">[]): PredictionPolicyView {
  let maxStake: number | null = null;
  let venues: PredictionVenueId[] = PREDICTION_VENUES.filter((venue) => venue.enabled).map((venue) => venue.id);
  let reason: string | null = null;
  for (const entry of chain) {
    const agent = entry.defaults === "agent";
    const document = entry.policy ?? (agent ? OBSERVER_POLICY : null);
    if (!document) continue;
    if (!(document.predictions?.enabled ?? (agent ? AGENT_POLICY_DEFAULTS.predictionsEnabled : true))) {
      reason ??= agent ? "Agent keys trade prediction markets only when their rule book sets predictions.enabled." : "A rule book of this key disables prediction markets.";
    }
    const mode = document.mode ?? "live";
    if (mode !== "live") reason ??= `A rule book of this key is ${mode}.`;
    const cap = document.predictions?.maxStakeUsd;
    if (cap !== undefined) maxStake = Math.min(maxStake ?? Number(cap), Number(cap));
    const allowed = document.predictions?.venues;
    const protocolAllow = document.protocols?.allow as readonly string[] | undefined;
    const protocolDeny = (document.protocols?.deny ?? []) as readonly string[];
    venues = venues.filter((venue) => (!allowed || allowed.includes(venue)) && (!protocolAllow || protocolAllow.includes(venue)) && !protocolDeny.includes(venue));
  }
  return { enabled: reason === null, maxStakeUsd: maxStake ?? PREDICTION_LIMITS.defaultMaxStakeUsd, venues, reason };
}
