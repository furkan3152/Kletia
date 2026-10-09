/**
 * Rule Book evaluation (policy design PF1, §4, §7, §9): facts, the rule
 * catalogue, the pure evaluator, constraint narrowing before planning, the
 * schedule clock, approval digests and signing payloads, and the decision
 * hash chain. The same evaluator runs in the API (plan, prepare), in the
 * simulator and in the SDK's policy-bound signer guard.
 */
import { ASSETS, type AssetCategory } from "./assets.js";
import { CHAINS, type NetworkKey } from "./chains.js";
import { parseAccountId, parseAssetId, sameAddressAccount, type AccountId, type AssetId } from "./caip.js";
import { canonicalJson } from "./contracts.js";
import { sha256Hex } from "./hash.js";
import type { AssetAmount, IntentActionKind, IntentConstraints, IntentGraph, IntentRequest, PolicyChainLink } from "./intent.js";
import { PROTOCOLS, type ProtocolId } from "./protocols.js";
import {
  accountMatchesPattern,
  AGENT_POLICY_DEFAULTS,
  formatUsdMicros,
  OBSERVER_POLICY,
  policyTimeMinutes,
  policyUsdMicros,
  POLICY_LIMITS,
  POLICY_PERMISSIONS,
  WEEKDAYS,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyPermission,
  type Weekday,
} from "./policy.js";

/** Planner defaults the narrowing starts from (engine `DEFAULT_SLIPPAGE_BPS`, `DEFAULT_MAX_SECONDS`). */
export const INTENT_DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_DEFAULT_MAX_SECONDS = 600;

/** Protocols Kletia builds transactions for (`capabilities` includes `execute`). */
export const EXECUTABLE_PROTOCOLS: readonly ProtocolId[] = Object.freeze(
  PROTOCOLS.filter((protocol) => protocol.capabilities.includes("execute")).map((protocol) => protocol.id),
);

/* ===================================================================== facts */

export type PolicyStage = "plan" | "prepare" | "evaluate" | "sign";

export interface AssetFacts {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units. */
  readonly amount: string;
  /** In core ASSETS (registry metadata below is only trusted when listed). */
  readonly listed: boolean;
  readonly category?: AssetCategory;
  readonly group?: string;
  /** Conservative USD in micro-dollars, rounded up; null = unpriced. */
  readonly usdMicros: bigint | null;
}

export interface StepFacts {
  readonly id: string;
  readonly index: number;
  readonly kind: IntentActionKind;
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly destinationNetwork?: NetworkKey;
  /** No incoming `funds` edge. */
  readonly root: boolean;
  readonly input?: AssetFacts;
  readonly output?: AssetFacts;
  /** step.recipient ?? step.account. */
  readonly recipient: AccountId;
  readonly recipientName?: string;
  /** Recipient not in the own set (the evaluator also recomputes it, fail closed). */
  readonly external: boolean;
  readonly contract?: { readonly id: string; readonly entry: string; readonly target: string };
  readonly slippageBps: number;
  readonly extraCosts: readonly AssetFacts[];
  readonly estimatedSeconds?: number;
}

export interface PolicyFacts {
  readonly stage: PolicyStage;
  /** False for dry runs and the simulator. */
  readonly stored: boolean;
  /** request.accounts. */
  readonly accounts: readonly AccountId[];
  readonly steps: readonly StepFacts[];
  readonly intent: {
    readonly stepCount: number;
    /** Step and destination networks. */
    readonly networks: readonly NetworkKey[];
    /** null when any step fee is unknown. */
    readonly feesUsdMicros: bigint | null;
    /** Fresh value (§5.2); null when unpriced. The evaluator recomputes it from the steps. */
    readonly notionalUsdMicros: bigint | null;
    readonly crossNetwork: boolean;
  };
}

/* ===================================================================== rules */

export type PolicyRuleId =
  | "key.status"
  | "mode.paused"
  | "mode.dryRun"
  | "permissions.storeIntents"
  | "networks.allow"
  | "networks.lanes"
  | "kinds.allow"
  | "protocols.allow"
  | "protocols.deny"
  | "contracts.allow"
  | "assets.allow"
  | "assets.categories"
  | "assets.unlisted"
  | "accounts.allow"
  | "recipients.deny"
  | "recipients.mode"
  | "recipients.names"
  | "limits.maxSteps"
  | "limits.maxSlippageBps"
  | "limits.maxExtraCostUsd"
  | "limits.maxFeeUsd"
  | "limits.maxSeconds"
  | "caps.perStepUsd"
  | "caps.perIntentUsd"
  | "caps.dailyUsd"
  | "caps.weeklyUsd"
  | "pricing.unavailable"
  | "schedule.window"
  | "confirm.aboveUsd"
  | "confirm.externalRecipient"
  | "confirm.contractCall"
  | "confirm.crossNetwork"
  | "approval.required"
  | "approval.expired"
  | "approval.stale"
  | "approval.rejected"
  | "permissions.createChildKeys"
  | "permissions.webhooks"
  | "permissions.registerContracts"
  | "permissions.sessions"
  | "permissions.mcpCreateIntents"
  | "permissions.links"
  | "execution.pinNonce"
  | "submit.uncleared";

export interface PolicyRuleInfo {
  /** Rule book article the portal prints (1-13). */
  readonly article: number;
  readonly title: string;
  readonly outcome: "deny" | "confirm" | "observed";
  /** The API error code a violation of this rule maps to. */
  readonly code: string;
  readonly retryable: boolean;
}

const deny = (article: number, title: string, code = "POLICY_VIOLATION", retryable = false): PolicyRuleInfo => ({ article, title, outcome: "deny", code, retryable });
const trigger = (title: string): PolicyRuleInfo => ({ article: 10, title, outcome: "confirm", code: "POLICY_APPROVAL_REQUIRED", retryable: true });
const observed = (article: number, title: string): PolicyRuleInfo => ({ article, title, outcome: "observed", code: "POLICY_VIOLATION", retryable: false });

/** Rule ids are stable API (policy design §4.4). */
export const POLICY_RULES: Readonly<Record<PolicyRuleId, PolicyRuleInfo>> = Object.freeze({
  "key.status": deny(1, "The key and every ancestor are active and unexpired", "POLICY_OWNER_REVOKED"),
  "mode.paused": deny(1, "The rule book is not paused"),
  "mode.dryRun": deny(1, "Dry-run mode: plans and quotes only"),
  "permissions.storeIntents": deny(1, "The agent key may store intents"),
  "networks.allow": deny(2, "Every step and destination network is allowed"),
  "networks.lanes": deny(2, "Every network is on an allowed lane"),
  "kinds.allow": deny(3, "Every step kind is allowed"),
  "protocols.allow": deny(3, "Every step protocol is allowed"),
  "protocols.deny": deny(3, "No step uses a denied protocol"),
  "contracts.allow": deny(4, "Custom contract steps call listed registrations and entries"),
  "assets.allow": deny(5, "Step inputs and outputs are allowed assets"),
  "assets.categories": deny(5, "Step inputs and outputs are in allowed categories"),
  "assets.unlisted": deny(5, "No unlisted tokens"),
  "accounts.allow": deny(6, "Every request account matches a pinned pattern"),
  "recipients.deny": deny(7, "No recipient is denied"),
  "recipients.mode": deny(7, "Recipients are own accounts or allowed"),
  "recipients.names": deny(7, "Recipient names follow the names rule"),
  "limits.maxSteps": deny(8, "Step count within the limit"),
  "limits.maxSlippageBps": deny(8, "Slippage within the limit"),
  "limits.maxExtraCostUsd": deny(8, "Extra costs per step within the limit"),
  "limits.maxFeeUsd": deny(8, "Estimated network fees within the limit"),
  "limits.maxSeconds": deny(8, "Cross-network settlement time within the limit"),
  "caps.perStepUsd": deny(8, "Each step's notional within the cap"),
  "caps.perIntentUsd": deny(8, "The intent's fresh value within the cap"),
  "caps.dailyUsd": deny(8, "Rolling 24 hour exposure within the cap", "POLICY_SPEND_LIMIT", true),
  "caps.weeklyUsd": deny(8, "Rolling 7 day exposure within the cap", "POLICY_SPEND_LIMIT", true),
  "pricing.unavailable": deny(8, "Every amount a USD rule needs has a fresh price", "POLICY_PRICE_UNAVAILABLE", true),
  "schedule.window": deny(9, "Prepared inside an open window", "POLICY_SCHEDULE_CLOSED", true),
  "confirm.aboveUsd": trigger("Above the confirmation threshold"),
  "confirm.externalRecipient": trigger("Pays a recipient outside the request's accounts"),
  "confirm.contractCall": trigger("Calls a custom contract"),
  "confirm.crossNetwork": trigger("Crosses networks"),
  "approval.required": deny(10, "An approver approved this intent", "POLICY_APPROVAL_REQUIRED", true),
  "approval.expired": deny(10, "The approval has not expired", "POLICY_APPROVAL_EXPIRED"),
  "approval.stale": deny(10, "The fresh value is within the approved ceiling", "POLICY_APPROVAL_STALE"),
  "approval.rejected": deny(10, "The approval was not rejected", "POLICY_APPROVAL_REJECTED"),
  "permissions.createChildKeys": deny(11, "The agent key may create child keys", "AGENT_KEY_FORBIDDEN"),
  "permissions.webhooks": deny(11, "The agent key may manage webhooks", "AGENT_KEY_FORBIDDEN"),
  "permissions.registerContracts": deny(11, "The agent key may register contracts", "AGENT_KEY_FORBIDDEN"),
  "permissions.sessions": deny(11, "The agent key may create sessions", "AGENT_KEY_FORBIDDEN"),
  "permissions.mcpCreateIntents": deny(11, "The agent key may store intents through MCP", "AGENT_KEY_FORBIDDEN"),
  "permissions.links": deny(11, "The agent key may create intent links", "AGENT_KEY_FORBIDDEN"),
  "execution.pinNonce": observed(12, "The landed transaction used the pinned nonce"),
  "submit.uncleared": observed(1, "A verified payload had no cleared exposure"),
});

/** Error codes of policy refusals, non-retryable first (policy design §13). */
export const POLICY_ERROR_PRECEDENCE: readonly string[] = Object.freeze([
  "POLICY_VIOLATION",
  "POLICY_OWNER_REVOKED",
  "POLICY_APPROVAL_REJECTED",
  "POLICY_APPROVAL_STALE",
  "POLICY_APPROVAL_EXPIRED",
  "POLICY_PRICE_UNAVAILABLE",
  "POLICY_SPEND_LIMIT",
  "POLICY_SCHEDULE_CLOSED",
  "POLICY_APPROVAL_REQUIRED",
]);

export interface PolicyViolation {
  readonly rule: PolicyRuleId;
  readonly scope: "project" | "key";
  readonly keyId?: string;
  /** "steps[1].recipient", "accounts[0]", "constraints.maxSlippageBps". */
  readonly path?: string;
  readonly message: string;
  readonly observed?: string;
  readonly limit?: string;
}

export interface PolicyRuleResult {
  readonly rule: PolicyRuleId;
  readonly scope: "project" | "key";
  readonly keyId?: string;
  /** `warn`: closed schedule at plan (prepare refuses). */
  readonly status: "pass" | "fail" | "trigger" | "warn";
  readonly path?: string;
  readonly observed?: string;
  readonly limit?: string;
  readonly message?: string;
}

/** The code a set of violations is refused with (precedence of §13); null when empty. */
export function policyErrorCode(violations: readonly Pick<PolicyViolation, "rule">[]): string | null {
  const codes = new Set(violations.map((violation) => POLICY_RULES[violation.rule]?.code ?? "POLICY_VIOLATION"));
  for (const code of POLICY_ERROR_PRECEDENCE) if (codes.has(code)) return code;
  return codes.size > 0 ? ([...codes][0] as string) : null;
}

/* =============================================================== evaluation */

export type PolicyOutcome = "allow" | "confirm" | "deny";

export interface PolicyWindowUsage {
  /** Counted exposure of this scope in the last 24 h / 7 d, micro-dollars (excluding this intent). */
  readonly dayUsdMicros: bigint;
  readonly weekUsdMicros: bigint;
}

export interface PolicyEvaluationContext {
  readonly scope: "project" | "key";
  /** Tags results (the key whose rule book decided, or the project id). */
  readonly keyId?: string;
  /** `agent`: absent fields take agent defaults (§3.2). Default `project`. */
  readonly defaults?: PolicyDefaults;
  /** Clock for the schedule (default now). */
  readonly now?: number | Date;
  /** Owner key and every ancestor active and unexpired; undefined = not checked here. */
  readonly keyActive?: boolean;
  /** Window usage of this scope; undefined = window caps not evaluated (the ledger reserves atomically at prepare). */
  readonly usage?: PolicyWindowUsage;
  /** Amount added to the windows (prepare: the exposure of the step); default the intent's fresh value. */
  readonly windowDeltaUsdMicros?: bigint;
}

export interface PolicyEvaluation {
  readonly outcome: PolicyOutcome;
  /** At most POLICY_LIMITS.violationsReturned (the API error); `allViolations` keeps every one. */
  readonly violations: readonly PolicyViolation[];
  readonly allViolations: readonly PolicyViolation[];
  readonly triggers: readonly PolicyViolation[];
  /** Every evaluated rule, passed ones included (the simulator punches them). */
  readonly rules: readonly PolicyRuleResult[];
  readonly warnings: readonly string[];
  /** Fresh value of the intent (§5.2); null when unpriced. */
  readonly notionalUsdMicros: bigint | null;
  /** Error code by precedence; null when allowed or held. */
  readonly code: string | null;
  /** Seconds to retry after (schedule, approvals); null otherwise. */
  readonly retryAfterSeconds: number | null;
}

/** Registry descriptor of an asset id (EVM addresses compared case-insensitively). */
const REGISTRY = new Map(ASSETS.map((asset) => [normalizeAssetIdText(asset.id), asset]));

function normalizeAssetIdText(asset: string): string {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : asset;
}

function networkOfAsset(asset: string): NetworkKey | null {
  return parseAssetId(asset)?.chain.key ?? null;
}

/** True when an asset matches one normalised `assets.allow` entry. Unlisted tokens only ever match their exact CAIP-19 id. */
export function assetMatchesEntry(asset: AssetId, entry: string): boolean {
  const id = normalizeAssetIdText(asset);
  if (entry.includes("/")) return id === entry;
  const descriptor = REGISTRY.get(id);
  if (!descriptor) return false;
  if (entry.startsWith("group:")) return descriptor.group === entry.slice(6);
  const at = entry.lastIndexOf("@");
  if (at > 0) return descriptor.symbol.toUpperCase() === entry.slice(0, at).toUpperCase() && descriptor.network === entry.slice(at + 1);
  return descriptor.symbol.toUpperCase() === entry.toUpperCase();
}

/** True when `account` is one of `own` (same address on any chain of its namespace). */
export function isOwnAccount(own: readonly string[], account: string): boolean {
  return own.some((candidate) => sameAddressAccount(candidate, account));
}

/** Kinds that move no value of their own (a missing input is then not an unknown amount). */
const NO_INPUT_KINDS: ReadonlySet<IntentActionKind> = new Set(["read", "approve", "claim"]);

/** True when a step moves value but its input amount is unknown (fail closed under USD rules). */
function inputUnknown(step: StepFacts): boolean {
  return step.input === undefined && !NO_INPUT_KINDS.has(step.kind);
}

/**
 * Fresh value (§5.2): Σ input notional of root steps + Σ priced extra costs
 * of every step; null when any is unpriced (a value-moving root step without
 * an input amount counts as unpriced).
 */
export function policyNotionalUsdMicros(steps: readonly StepFacts[]): { readonly value: bigint | null; readonly unpriced: readonly string[] } {
  let total = 0n;
  const unpriced: string[] = [];
  for (const step of steps) {
    if (step.root && inputUnknown(step)) unpriced.push(`steps[${step.index}].input`);
    if (step.root && step.input) {
      if (step.input.usdMicros === null) unpriced.push(`steps[${step.index}].input`);
      else total += step.input.usdMicros;
    }
    step.extraCosts.forEach((cost, index) => {
      if (cost.usdMicros === null) unpriced.push(`steps[${step.index}].extraCosts[${index}]`);
      else total += cost.usdMicros;
    });
  }
  return { value: unpriced.length > 0 ? null : total, unpriced };
}

const usdText = (micros: bigint | null) => (micros === null ? "unpriced" : formatUsdMicros(micros));

function laneOf(network: NetworkKey): string {
  return CHAINS[network].lane;
}

/**
 * Evaluates one rule book against facts (policy design §4). Runs every rule
 * so the explanation is complete; the outcome is the worst of the lattice
 * `allow < confirm < deny`. A null document is no rule book (project
 * defaults) or the `observer` template (agent defaults).
 */
export function evaluatePolicy(policy: PolicyDocument | null, facts: PolicyFacts, context: PolicyEvaluationContext): PolicyEvaluation {
  const agent = context.defaults === "agent";
  const doc: PolicyDocument = policy ?? (agent ? OBSERVER_POLICY : { schema: "kletia.policy/v1" });
  const tag = { scope: context.scope, ...(context.keyId !== undefined ? { keyId: context.keyId } : {}) };
  const rules: PolicyRuleResult[] = [];
  const violations: PolicyViolation[] = [];
  const triggers: PolicyViolation[] = [];
  const warnings: string[] = [];
  let retryAfterSeconds: number | null = null;
  const stage = facts.stage;
  const enforcing = stage === "prepare" || stage === "sign";

  const pass = (rule: PolicyRuleId, detail: Partial<PolicyRuleResult> = {}) => rules.push({ rule, ...tag, status: "pass", ...detail });
  const fail = (rule: PolicyRuleId, message: string, detail: { path?: string; observed?: string; limit?: string } = {}) => {
    const violation: PolicyViolation = { rule, ...tag, message, ...detail };
    violations.push(violation);
    rules.push({ rule, ...tag, status: "fail", message, ...detail });
  };
  const raise = (rule: PolicyRuleId, message: string, detail: { path?: string; observed?: string; limit?: string } = {}) => {
    triggers.push({ rule, ...tag, message, ...detail });
    rules.push({ rule, ...tag, status: "trigger", message, ...detail });
  };
  /** Runs a per-item rule: one result, failing on the first offender (every offender is listed in violations). */
  const each = <T>(rule: PolicyRuleId, items: readonly T[], test: (item: T) => { path: string; message: string; observed?: string } | null, limit?: string) => {
    let failed = false;
    for (const item of items) {
      const problem = test(item);
      if (problem) {
        failed = true;
        fail(rule, problem.message, { path: problem.path, ...(problem.observed !== undefined ? { observed: problem.observed } : {}), ...(limit !== undefined ? { limit } : {}) });
      }
    }
    if (!failed) pass(rule, limit !== undefined ? { limit } : {});
  };

  const own = facts.accounts;
  const steps = facts.steps.map((step) => ({ ...step, external: step.external || !isOwnAccount(own, step.recipient) }));
  const assetsOf = (step: StepFacts) => [
    ...(step.input ? [{ asset: step.input, path: `steps[${step.index}].input` }] : []),
    ...(step.output ? [{ asset: step.output, path: `steps[${step.index}].output` }] : []),
  ];
  const networksOf = (step: StepFacts) => [
    { network: step.network, path: `steps[${step.index}].network` },
    ...(step.destinationNetwork && step.destinationNetwork !== step.network ? [{ network: step.destinationNetwork, path: `steps[${step.index}].destinationNetwork` }] : []),
  ];

  // Article 1: service.
  if (context.keyActive === false) fail("key.status", "The key or one of its ancestors is revoked or expired.");
  else if (context.keyActive === true) pass("key.status");
  const mode = doc.mode ?? "live";
  if (mode === "paused") fail("mode.paused", "The rule book is paused: nothing is planned or prepared.", { observed: "paused" });
  else pass("mode.paused", { observed: mode });
  if (mode === "dry-run") {
    if (facts.stored || enforcing) fail("mode.dryRun", "The rule book is in dry-run mode: plans and quotes only, nothing is stored or prepared.", { observed: facts.stored ? "stored intent" : stage });
    else pass("mode.dryRun", { observed: "dry run" });
  }
  if (agent && facts.stored) {
    const allowed = doc.permissions?.storeIntents ?? AGENT_POLICY_DEFAULTS.permissions.storeIntents;
    if (!allowed) fail("permissions.storeIntents", "This agent key may not store intents.");
    else pass("permissions.storeIntents");
  }

  // Article 2: lines.
  const allSteps = steps;
  if (doc.networks?.allow) {
    const allow = doc.networks.allow;
    each("networks.allow", allSteps.flatMap(networksOf), (entry) => (allow.includes(entry.network) ? null : { path: entry.path, message: `${CHAINS[entry.network].name} is not an allowed network.`, observed: entry.network }), allow.join(", "));
  }
  if (doc.networks?.lanes) {
    const lanes = doc.networks.lanes as readonly string[];
    each("networks.lanes", allSteps.flatMap(networksOf), (entry) => (lanes.includes(laneOf(entry.network)) ? null : { path: entry.path, message: `${CHAINS[entry.network].name} is on the ${laneOf(entry.network)} lane.`, observed: laneOf(entry.network) }), lanes.join(", "));
  }

  // Article 3: carriers.
  if (doc.kinds?.allow) {
    const allow = doc.kinds.allow;
    each("kinds.allow", allSteps, (step) => (allow.includes(step.kind) ? null : { path: `steps[${step.index}].kind`, message: `Step kind ${step.kind} is not allowed.`, observed: step.kind }), allow.join(", "));
  }
  if (doc.protocols?.allow) {
    const allow = doc.protocols.allow;
    each("protocols.allow", allSteps, (step) => (allow.includes(step.protocol) ? null : { path: `steps[${step.index}].protocol`, message: `${step.protocol} is not an allowed protocol.`, observed: step.protocol }), allow.join(", "));
  }
  if (doc.protocols?.deny) {
    const denied = doc.protocols.deny;
    each("protocols.deny", allSteps, (step) => (denied.includes(step.protocol) ? { path: `steps[${step.index}].protocol`, message: `${step.protocol} is denied.`, observed: step.protocol } : null), denied.join(", "));
  }

  // Article 4: private sidings.
  const contractAllow = doc.contracts?.allow ?? (agent ? AGENT_POLICY_DEFAULTS.contractsAllow : undefined);
  if (contractAllow) {
    const contractSteps = allSteps.filter((step) => step.kind === "call" || step.kind === "action" || step.contract !== undefined);
    each(
      "contracts.allow",
      contractSteps,
      (step) => {
        const listed = step.contract ? contractAllow.find((entry) => entry.id === step.contract?.id) : undefined;
        const ok = listed !== undefined && (listed.entries === undefined || listed.entries.includes(step.contract?.entry ?? ""));
        return ok
          ? null
          : { path: `steps[${step.index}].contract`, message: step.contract ? `Registration ${step.contract.id} entry ${step.contract.entry} is not listed.` : "A custom contract step without a registration.", observed: step.contract ? `${step.contract.id}:${step.contract.entry}` : "unknown" };
      },
      contractAllow.map((entry) => entry.id).join(", ") || "none",
    );
  }

  // Article 5: cargo.
  const stepAssets = allSteps.flatMap(assetsOf);
  if (doc.assets?.allow) {
    const allow = doc.assets.allow;
    each("assets.allow", stepAssets, (entry) => (allow.some((pattern) => assetMatchesEntry(entry.asset.asset, pattern)) ? null : { path: entry.path, message: `${entry.asset.symbol} is not an allowed asset.`, observed: entry.asset.asset }), allow.join(", "));
  }
  if (doc.assets?.categories) {
    const categories = doc.assets.categories as readonly string[];
    each(
      "assets.categories",
      stepAssets,
      (entry) => {
        const descriptor = REGISTRY.get(normalizeAssetIdText(entry.asset.asset));
        return descriptor && categories.includes(descriptor.category) ? null : { path: entry.path, message: `${entry.asset.symbol} is not in an allowed category.`, observed: descriptor?.category ?? "unlisted" };
      },
      categories.join(", "),
    );
  }
  const unlisted = doc.assets?.unlisted ?? (agent ? AGENT_POLICY_DEFAULTS.assetsUnlisted : "allow");
  if (unlisted === "deny") {
    each("assets.unlisted", stepAssets, (entry) => (REGISTRY.has(normalizeAssetIdText(entry.asset.asset)) ? null : { path: entry.path, message: `${entry.asset.asset} is not a listed token.`, observed: entry.asset.asset }), "listed tokens only");
  }

  // Article 6: passengers.
  if (doc.accounts?.allow) {
    const allow = doc.accounts.allow;
    each(
      "accounts.allow",
      facts.accounts.map((account, index) => ({ account, index })),
      (entry) => (allow.some((pattern) => accountMatchesPattern(entry.account, pattern)) ? null : { path: `accounts[${entry.index}]`, message: `${entry.account} is not a pinned account.`, observed: entry.account }),
      `${allow.length} pinned`,
    );
  }

  // Article 7: destinations.
  const recipients = doc.recipients;
  const names = recipients?.names ?? "resolve";
  const nameOf = (step: StepFacts) => step.recipientName?.trim().toLowerCase();
  if (recipients?.deny) {
    const denied = recipients.deny;
    each(
      "recipients.deny",
      allSteps,
      (step) =>
        denied.some((pattern) => accountMatchesPattern(step.recipient, pattern) || (nameOf(step) !== undefined && pattern.trim().toLowerCase() === nameOf(step)))
          ? { path: `steps[${step.index}].recipient`, message: "The recipient is denied.", observed: step.recipientName ? `${step.recipientName} (${step.recipient})` : step.recipient }
          : null,
      `${denied.length} denied`,
    );
  }
  const recipientMode = recipients?.mode ?? (agent ? AGENT_POLICY_DEFAULTS.recipientsMode : "any");
  if (recipientMode !== "any") {
    const allow = recipients?.allow ?? [];
    each(
      "recipients.mode",
      allSteps,
      (step) => {
        if (!step.external) return null;
        if (recipientMode === "allowlist") {
          if (allow.some((pattern) => accountMatchesPattern(step.recipient, pattern))) return null;
          const name = nameOf(step);
          if (names === "trusted" && name !== undefined && allow.some((pattern) => pattern.trim().toLowerCase() === name)) return null;
        }
        return {
          path: `steps[${step.index}].recipient`,
          message: recipientMode === "own" ? "Recipient is not one of the request's accounts." : "Recipient is neither one of the request's accounts nor allowed.",
          observed: step.recipient,
        };
      },
      recipientMode,
    );
  }
  if (names === "deny") {
    each("recipients.names", allSteps, (step) => (step.recipientName ? { path: `steps[${step.index}].recipientName`, message: "Recipients given as names are not allowed.", observed: step.recipientName } : null), "deny");
  }

  // Article 8: fares.
  const notional = policyNotionalUsdMicros(allSteps);
  const unpricedNeeds: string[] = [];
  const limits = doc.limits;
  if (limits?.maxSteps !== undefined) {
    const count = Math.max(facts.intent.stepCount, allSteps.length);
    if (count > limits.maxSteps) fail("limits.maxSteps", `${count} steps exceed the limit.`, { observed: String(count), limit: String(limits.maxSteps) });
    else pass("limits.maxSteps", { observed: String(count), limit: String(limits.maxSteps) });
  }
  if (limits?.maxSlippageBps !== undefined) {
    const max = limits.maxSlippageBps;
    each("limits.maxSlippageBps", allSteps, (step) => (step.slippageBps > max ? { path: `steps[${step.index}].slippageBps`, message: `Slippage ${step.slippageBps} bps exceeds the limit.`, observed: String(step.slippageBps) } : null), String(max));
  }
  if (limits?.maxExtraCostUsd !== undefined) {
    const max = policyUsdMicros(limits.maxExtraCostUsd);
    each(
      "limits.maxExtraCostUsd",
      allSteps.filter((step) => step.extraCosts.length > 0),
      (step) => {
        if (step.extraCosts.some((cost) => cost.usdMicros === null)) {
          unpricedNeeds.push(`steps[${step.index}].extraCosts`);
          return null;
        }
        const total = step.extraCosts.reduce((sum, cost) => sum + (cost.usdMicros as bigint), 0n);
        return total > max ? { path: `steps[${step.index}].extraCosts`, message: `Extra costs of $${formatUsdMicros(total)} exceed the limit.`, observed: formatUsdMicros(total) } : null;
      },
      formatUsdMicros(max),
    );
  }
  if (limits?.maxFeeUsd !== undefined) {
    const max = policyUsdMicros(limits.maxFeeUsd);
    const fees = facts.intent.feesUsdMicros;
    if (fees === null) fail("limits.maxFeeUsd", "Network fees are unknown for at least one step, so the fee limit cannot be checked.", { path: "intent.feesUsd", observed: "unknown", limit: formatUsdMicros(max) });
    else if (fees > max) fail("limits.maxFeeUsd", `Estimated fees of $${formatUsdMicros(fees)} exceed the limit.`, { path: "intent.feesUsd", observed: formatUsdMicros(fees), limit: formatUsdMicros(max) });
    else pass("limits.maxFeeUsd", { observed: formatUsdMicros(fees), limit: formatUsdMicros(max) });
  }
  if (limits?.maxSeconds !== undefined) {
    const max = limits.maxSeconds;
    each(
      "limits.maxSeconds",
      allSteps.filter((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network),
      (step) =>
        step.estimatedSeconds === undefined
          ? { path: `steps[${step.index}].estimatedSeconds`, message: "The settlement time of this cross-network step is unknown.", observed: "unknown" }
          : step.estimatedSeconds > max
            ? { path: `steps[${step.index}].estimatedSeconds`, message: `Settlement estimate ${step.estimatedSeconds} s exceeds the limit.`, observed: String(step.estimatedSeconds) }
            : null,
      String(max),
    );
  }
  const caps = doc.caps;
  if (caps?.perStepUsd !== undefined) {
    const max = policyUsdMicros(caps.perStepUsd);
    each(
      "caps.perStepUsd",
      allSteps.filter((step) => step.input !== undefined || inputUnknown(step)),
      (step) => {
        const value = step.input?.usdMicros ?? null;
        if (value === null) {
          unpricedNeeds.push(`steps[${step.index}].input`);
          return null;
        }
        return value > max ? { path: `steps[${step.index}].input`, message: `Step notional $${formatUsdMicros(value)} exceeds the per-step cap.`, observed: formatUsdMicros(value) } : null;
      },
      formatUsdMicros(max),
    );
  }
  const needNotional = (rule: PolicyRuleId): bigint | null => {
    if (notional.value === null) unpricedNeeds.push(...notional.unpriced.map((path) => `${path} (${rule})`));
    return notional.value;
  };
  if (caps?.perIntentUsd !== undefined) {
    const max = policyUsdMicros(caps.perIntentUsd);
    const value = needNotional("caps.perIntentUsd");
    if (value !== null && value > max) fail("caps.perIntentUsd", `The intent moves $${formatUsdMicros(value)}, above the per-intent cap.`, { observed: formatUsdMicros(value), limit: formatUsdMicros(max) });
    else if (value !== null) pass("caps.perIntentUsd", { observed: formatUsdMicros(value), limit: formatUsdMicros(max) });
  }
  for (const [rule, cap, used] of [
    ["caps.dailyUsd", caps?.dailyUsd, context.usage?.dayUsdMicros],
    ["caps.weeklyUsd", caps?.weeklyUsd, context.usage?.weekUsdMicros],
  ] as const) {
    if (cap === undefined || used === undefined) continue;
    const max = policyUsdMicros(cap);
    const delta = context.windowDeltaUsdMicros ?? needNotional(rule);
    if (delta === null) continue;
    const observedText = `${formatUsdMicros(delta)} + ${formatUsdMicros(used)} used`;
    if (used + delta > max) fail(rule, `This would move $${formatUsdMicros(used + delta)} in the window, above the cap.`, { observed: observedText, limit: formatUsdMicros(max) });
    else pass(rule, { observed: observedText, limit: formatUsdMicros(max) });
  }

  // Article 9: timetable.
  if (doc.schedule) {
    const state = scheduleState(doc.schedule, context.now ?? Date.now());
    if (state.open) pass("schedule.window", { observed: "open", limit: doc.schedule.timezone });
    else {
      const message = state.error
        ? `The time zone ${doc.schedule.timezone} cannot be evaluated here.`
        : `Outside every window of the timetable (${doc.schedule.timezone})${state.nextChange ? `; opens ${state.nextChange}` : ""}.`;
      if (enforcing) {
        fail("schedule.window", message, { observed: "closed", limit: doc.schedule.timezone });
        if (state.retryAfterSeconds !== null) retryAfterSeconds = state.retryAfterSeconds;
      } else {
        rules.push({ rule: "schedule.window", ...tag, status: "warn", message, observed: "closed", limit: doc.schedule.timezone });
        warnings.push(message);
      }
    }
  }

  // Article 10: inspection.
  const confirm = doc.confirm;
  if (confirm?.aboveUsd !== undefined) {
    const threshold = policyUsdMicros(confirm.aboveUsd);
    const value = needNotional("confirm.aboveUsd");
    if (value !== null && value > threshold) raise("confirm.aboveUsd", `The intent moves $${formatUsdMicros(value)}, above the confirmation threshold.`, { observed: formatUsdMicros(value), limit: formatUsdMicros(threshold) });
    else if (value !== null) pass("confirm.aboveUsd", { observed: formatUsdMicros(value), limit: formatUsdMicros(threshold) });
  }
  const when = confirm?.when ?? [];
  if (when.includes("external-recipient")) {
    const external = allSteps.find((step) => step.external);
    if (external) raise("confirm.externalRecipient", "A step pays a recipient outside the request's accounts.", { path: `steps[${external.index}].recipient`, observed: external.recipient });
    else pass("confirm.externalRecipient");
  }
  if (when.includes("contract-call")) {
    const call = allSteps.find((step) => step.kind === "call" || step.kind === "action" || step.contract !== undefined);
    if (call) raise("confirm.contractCall", "A step calls a custom contract.", { path: `steps[${call.index}].contract`, observed: call.contract?.id ?? call.kind });
    else pass("confirm.contractCall");
  }
  if (when.includes("cross-network")) {
    if (facts.intent.crossNetwork || allSteps.some((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network)) raise("confirm.crossNetwork", "The intent crosses networks.");
    else pass("confirm.crossNetwork");
  }

  if (unpricedNeeds.length > 0) {
    fail("pricing.unavailable", "No fresh price for an amount a USD rule needs; refused until a price source answers.", { path: unpricedNeeds[0] as string, observed: [...new Set(unpricedNeeds)].slice(0, 5).join(", ") });
  }

  const outcome: PolicyOutcome = violations.length > 0 ? "deny" : triggers.length > 0 ? "confirm" : "allow";
  return {
    outcome,
    violations: violations.slice(0, POLICY_LIMITS.violationsReturned),
    allViolations: violations,
    triggers,
    rules,
    warnings,
    notionalUsdMicros: notional.value,
    code: policyErrorCode(violations),
    retryAfterSeconds: violations.some((violation) => violation.rule === "schedule.window") ? retryAfterSeconds : null,
  };
}

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

/**
 * Builds facts from an intent graph (pure). `price` returns the conservative
 * USD value of an amount in micro-dollars (rounded up), or null when
 * unpriced; without it the graph's reported `usd` values are used (the SDK
 * signer guard). The engine passes its pricer's results.
 */
export function buildPolicyFacts(
  graph: IntentGraph,
  options: {
    readonly stage: PolicyStage;
    readonly stored: boolean;
    readonly price?: (amount: AssetAmount) => bigint | null;
    /** Slippage per step when the caller knows it from the step ref (default: expected vs minimum output). */
    readonly slippageBps?: (stepId: string) => number | undefined;
  },
): PolicyFacts {
  const funded = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const price = options.price ?? ((amount: AssetAmount) => (typeof amount.usd === "number" && Number.isFinite(amount.usd) && amount.usd >= 0 ? BigInt(Math.ceil(amount.usd * 1_000_000)) : null));
  const assetFacts = (amount: AssetAmount): AssetFacts => {
    const descriptor = REGISTRY.get(normalizeAssetIdText(amount.asset));
    return {
      asset: amount.asset,
      symbol: amount.symbol,
      decimals: amount.decimals,
      amount: amount.amount,
      listed: descriptor !== undefined,
      ...(descriptor ? { category: descriptor.category, ...(descriptor.group ? { group: descriptor.group } : {}) } : {}),
      usdMicros: price(amount),
    };
  };
  const steps = graph.steps.map((step): StepFacts => {
    const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
    const recipient = step.recipient ?? step.account;
    let slippage = options.slippageBps?.(step.id);
    if (slippage === undefined) {
      const expected = step.expectedOutput;
      const minimum = step.minimumOutput;
      slippage = 0;
      if (expected && minimum && expected.asset === minimum.asset && BigInt(expected.amount) > 0n && BigInt(minimum.amount) < BigInt(expected.amount)) {
        const gap = BigInt(expected.amount) - BigInt(minimum.amount);
        slippage = Number((gap * 10_000n + BigInt(expected.amount) - 1n) / BigInt(expected.amount));
      }
    }
    const estimated = step.estimatedSeconds ?? step.settlement?.expectedSeconds;
    return {
      id: step.id,
      index: step.index,
      kind: step.kind,
      protocol: step.protocol,
      network: step.network,
      ...(destination ? { destinationNetwork: destination } : {}),
      root: !funded.has(step.id),
      ...(step.input ? { input: assetFacts(step.input) } : {}),
      ...(step.expectedOutput ? { output: assetFacts(step.expectedOutput) } : {}),
      recipient,
      ...(step.recipientName ? { recipientName: step.recipientName } : {}),
      external: !isOwnAccount(graph.request.accounts, recipient),
      ...(step.call ? { contract: { id: step.call.contract, entry: step.call.entry, target: step.call.target } } : {}),
      slippageBps: slippage,
      extraCosts: (step.extraCosts ?? []).map(assetFacts),
      ...(estimated !== undefined ? { estimatedSeconds: estimated } : {}),
    };
  });
  const networks: NetworkKey[] = [];
  for (const step of steps) {
    for (const network of [step.network, step.destinationNetwork]) if (network && !networks.includes(network)) networks.push(network);
  }
  const fees = graph.steps.map((step) => (typeof step.feesUsd === "number" && Number.isFinite(step.feesUsd) && step.feesUsd >= 0 ? BigInt(Math.ceil(step.feesUsd * 1_000_000)) : step.mode === "wallet" ? null : 0n));
  return {
    stage: options.stage,
    stored: options.stored,
    accounts: graph.request.accounts,
    steps,
    intent: {
      stepCount: graph.steps.length,
      networks,
      feesUsdMicros: fees.some((fee) => fee === null) ? null : fees.reduce<bigint>((sum, fee) => sum + (fee as bigint), 0n),
      notionalUsdMicros: policyNotionalUsdMicros(steps).value,
      crossNetwork: steps.some((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network),
    },
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

/**
 * Rewrites the request's constraints before planning so the auction picks
 * an allowed venue (policy design §4.3). Only constraints some rule book
 * restricts are touched; the post-plan evaluation stays authoritative.
 */
export function narrowConstraints(chain: readonly (PolicyDocument | null)[], request: IntentRequest): IntentRequest {
  const documents = chain.filter((document): document is PolicyDocument => document !== null);
  const constraints: IntentConstraints = request.constraints ?? {};
  const next: { -readonly [K in keyof IntentConstraints]: IntentConstraints[K] } = { ...constraints };
  const slippageLimits = documents.map((document) => document.limits?.maxSlippageBps).filter((value): value is number => value !== undefined);
  if (slippageLimits.length > 0) next.maxSlippageBps = Math.min(constraints.maxSlippageBps ?? INTENT_DEFAULT_SLIPPAGE_BPS, ...slippageLimits);
  const feeLimits = documents.map((document) => document.limits?.maxFeeUsd).filter((value): value is string => value !== undefined).map(Number);
  if (feeLimits.length > 0) next.maxFeeUsd = Math.min(...(constraints.maxFeeUsd !== undefined ? [constraints.maxFeeUsd] : []), ...feeLimits);
  const secondLimits = documents.map((document) => document.limits?.maxSeconds).filter((value): value is number => value !== undefined);
  if (secondLimits.length > 0) next.maxSeconds = Math.min(constraints.maxSeconds ?? INTENT_DEFAULT_MAX_SECONDS, ...secondLimits);
  const avoid = new Set<ProtocolId>(constraints.avoidProtocols ?? []);
  for (const document of documents) {
    for (const protocol of document.protocols?.deny ?? []) avoid.add(protocol);
    const allow = document.protocols?.allow;
    if (allow) for (const protocol of EXECUTABLE_PROTOCOLS) if (!allow.includes(protocol)) avoid.add(protocol);
  }
  if (avoid.size > (constraints.avoidProtocols?.length ?? 0)) next.avoidProtocols = [...avoid].sort();
  if (constraints.preferProtocols) next.preferProtocols = constraints.preferProtocols.filter((protocol) => !avoid.has(protocol));
  if (documents.some((document) => document.networks?.lanes && !document.networks.lanes.includes("testnet"))) next.allowTestnets = false;
  const changed = Object.keys(next).some((key) => (next as Record<string, unknown>)[key] !== (constraints as Record<string, unknown>)[key]);
  return changed ? { ...request, constraints: next } : request;
}

/* ================================================================ schedule */

export interface ScheduleState {
  readonly open: boolean;
  /** ISO time of the next opening or closing within 8 days; null when it never changes. */
  readonly nextChange: string | null;
  readonly timezone: string | null;
  /** Closed: seconds to the next opening (capped at 86,400); null when open or never opens. */
  readonly retryAfterSeconds: number | null;
  /** The time zone could not be evaluated (fail closed: treated as closed). */
  readonly error?: true;
}

const WEEKDAY_SHORT: Readonly<Record<string, number>> = Object.freeze({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 });

function localMinuteOfWeek(formatter: Intl.DateTimeFormat, time: number): number {
  const parts = formatter.formatToParts(new Date(time));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = WEEKDAY_SHORT[value("weekday")];
  const hour = Number(value("hour")) % 24;
  const minute = Number(value("minute"));
  if (day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("Unexpected time format.");
  return day * 1_440 + hour * 60 + minute;
}

function openAt(schedule: NonNullable<PolicyDocument["schedule"]>, minuteOfWeek: number): boolean {
  const day = WEEKDAYS[Math.floor(minuteOfWeek / 1_440)] as Weekday;
  const minute = minuteOfWeek % 1_440;
  return schedule.windows.some((window) => window.days.includes(day) && minute >= (policyTimeMinutes(window.from) ?? 0) && minute < (policyTimeMinutes(window.to) ?? 0));
}

/**
 * Whether `now` falls in a window of the timetable, read in its IANA zone
 * through Intl (DST handled by Intl), and when that changes next (scan of at
 * most 8 days, resynchronised with Intl every 15 minutes).
 */
export function scheduleState(schedule: PolicyDocument["schedule"] | null | undefined, now: number | Date = Date.now()): ScheduleState {
  if (!schedule) return { open: true, nextChange: null, timezone: null, retryAfterSeconds: null };
  const time = now instanceof Date ? now.getTime() : now;
  let formatter: Intl.DateTimeFormat;
  let current: number;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    current = localMinuteOfWeek(formatter, time);
  } catch {
    return { open: false, nextChange: null, timezone: schedule.timezone, retryAfterSeconds: null, error: true };
  }
  const open = openAt(schedule, current);
  const startOfNextMinute = Math.floor(time / 60_000) * 60_000 + 60_000;
  let local = (current + 1) % 10_080;
  let nextChange: number | null = null;
  for (let step = 0; step < 8 * 1_440; step += 1) {
    const candidate = startOfNextMinute + step * 60_000;
    if (candidate % 900_000 === 0 || step === 0) local = localMinuteOfWeek(formatter, candidate);
    if (openAt(schedule, local) !== open) {
      nextChange = candidate;
      break;
    }
    local = (local + 1) % 10_080;
  }
  return {
    open,
    nextChange: nextChange === null ? null : new Date(nextChange).toISOString(),
    timezone: schedule.timezone,
    retryAfterSeconds: open || nextChange === null ? null : Math.min(86_400, Math.max(1, Math.ceil((nextChange - time) / 1_000))),
  };
}

/* ================================================================ approvals */

/**
 * What an approval approves (policy design §7.2): `0x` + sha256 of the
 * canonical intent shape (no amounts; the ceiling bounds them).
 */
export function approvalDigest(graph: IntentGraph, ownerKeyId: string): string {
  return `0x${sha256Hex(
    canonicalJson({
      intent: graph.id,
      owner: ownerKeyId,
      accounts: graph.request.accounts,
      steps: graph.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        network: step.network,
        destinationNetwork: step.settlement?.destinationNetwork,
        protocol: step.protocol,
        venue: step.venue,
        input: step.input?.asset,
        output: step.expectedOutput?.asset,
        recipient: step.recipient ?? step.account,
        recipientName: step.recipientName,
        contract: step.call?.contract,
        entry: step.call?.entry,
      })),
    }),
  )}`;
}

/** ceil(notional × 1.02) in cents (the hold's ceiling). */
export function approvalCeilingUsdCents(notionalUsdMicros: bigint): bigint {
  const denominator = 100n * 10_000n;
  return (notionalUsdMicros * 102n + denominator - 1n) / denominator;
}

export interface ApprovalSigningInput {
  readonly approvalId: string;
  readonly intentId: string;
  /** `approvalDigest` (0x + 64 hex). */
  readonly digest: string;
  readonly ceilingUsdCents: bigint | string | number;
  readonly decision: "approve" | "reject";
  /** Unix seconds, or an ISO time. */
  readonly expiresAt: number | string;
}

function expiresSeconds(value: number | string): bigint {
  const seconds = typeof value === "number" ? value : Math.floor(Date.parse(value) / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("expiresAt must be unix seconds or an ISO time.");
  return BigInt(seconds);
}

/** EIP-712 approval typed data, domain "Kletia Approvals" v1 on the signer's chain (pass to viem signTypedData / verifyTypedData). */
export function approvalTypedData(input: ApprovalSigningInput & { readonly signer: string }) {
  const account = parseAccountId(input.signer);
  const chainId = account?.chain.evmChainId;
  if (!account || chainId === undefined) throw new Error("EVM approvals need an eip155 CAIP-10 signer; Solana approvals sign approvalMessageText.");
  if (!/^0x[0-9a-f]{64}$/u.test(input.digest)) throw new Error("digest must be 0x + 64 lower-case hex.");
  return {
    domain: { name: "Kletia Approvals", version: "1", chainId },
    types: {
      Approval: [
        { name: "approval", type: "string" },
        { name: "intent", type: "string" },
        { name: "digest", type: "bytes32" },
        { name: "ceilingUsdCents", type: "uint256" },
        { name: "decision", type: "string" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "Approval" as const,
    message: {
      approval: input.approvalId,
      intent: input.intentId,
      digest: input.digest as `0x${string}`,
      ceilingUsdCents: BigInt(input.ceilingUsdCents),
      decision: input.decision,
      expiresAt: expiresSeconds(input.expiresAt),
    },
  };
}

function dollars(centsValue: bigint): string {
  const whole = (centsValue / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `$${whole}.${(centsValue % 100n).toString().padStart(2, "0")}`;
}

/** Canonical Solana approval message (UTF-8, LF, no trailing spaces), signed with signMessage. */
export function approvalMessageText(input: ApprovalSigningInput): string {
  const expires = new Date(Number(expiresSeconds(input.expiresAt)) * 1_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return [
    "Kletia approval",
    `approval: ${input.approvalId}`,
    `intent: ${input.intentId}`,
    `digest: ${input.digest}`,
    `up to: ${dollars(BigInt(input.ceilingUsdCents))}`,
    `decision: ${input.decision}`,
    `expires: ${expires}`,
  ].join("\n");
}

/* ============================================================ decision log */

export type PolicyDecisionStage = "plan" | "prepare" | "submit" | "evaluate" | "approval" | "amendment" | "key";
export type PolicyDecisionOutcome = "allow" | "confirm" | "deny" | "approved" | "rejected" | "observed";

export interface PolicyDecision {
  /** pdc_… */
  readonly id: string;
  /** Per project, gapless under the project lock. */
  readonly seq: number;
  /** chainHash of seq − 1 (POLICY_DECISION_GENESIS for the first). */
  readonly prevHash: string;
  /** "0x" + sha256(prevHash ‖ "\n" ‖ canonicalJson(record without seq, prevHash, chainHash)). */
  readonly chainHash: string;
  readonly at: string;
  readonly stage: PolicyDecisionStage;
  readonly outcome: PolicyDecisionOutcome;
  readonly projectId: string;
  readonly keyId: string | null;
  readonly actorKeyId: string | null;
  readonly intentId?: string;
  readonly stepId?: string;
  readonly dryRun: boolean;
  readonly chain: readonly PolicyChainLink[];
  readonly notionalUsd?: string;
  readonly usage?: readonly { readonly scope: string; readonly window: "24h" | "7d"; readonly usedUsd: string; readonly capUsd: string }[];
  readonly violations: readonly PolicyViolation[];
  readonly triggers: readonly PolicyViolation[];
  readonly warnings: readonly string[];
  /** sha256 of the canonical request (the request itself is not stored). */
  readonly requestDigest: string;
  readonly title?: string;
  readonly exposureId?: string;
  readonly approvalId?: string;
}

export const POLICY_DECISION_GENESIS = `0x${"0".repeat(64)}`;

/** The chain hash of one decision record given the previous hash. */
export function policyDecisionChainHash(prevHash: string, record: Omit<PolicyDecision, "seq" | "prevHash" | "chainHash"> | PolicyDecision): string {
  const { seq: _seq, prevHash: _prev, chainHash: _chain, ...rest } = record as PolicyDecision;
  return `0x${sha256Hex(`${prevHash}\n${canonicalJson(rest)}`)}`;
}

export interface DecisionChainVerification {
  readonly valid: boolean;
  /** Newest verified record. */
  readonly head: { readonly seq: number; readonly chainHash: string } | null;
  readonly problems: readonly string[];
}

/**
 * Recomputes the hash chain of a page of decisions (any order). A stored
 * `knownHead` must reappear unchanged when its seq is inside the page, and
 * must not be newer than the page's head.
 */
export function verifyDecisionChain(decisions: readonly PolicyDecision[], knownHead?: { readonly seq: number; readonly chainHash: string }): DecisionChainVerification {
  const problems: string[] = [];
  const sorted = [...decisions].sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < sorted.length; index += 1) {
    const decision = sorted[index] as PolicyDecision;
    const previous = sorted[index - 1];
    if (previous) {
      if (decision.seq !== previous.seq + 1) problems.push(`gap between seq ${previous.seq} and ${decision.seq}`);
      else if (decision.prevHash !== previous.chainHash) problems.push(`seq ${decision.seq} does not link to seq ${previous.seq}`);
    } else if (decision.seq === 1 && decision.prevHash !== POLICY_DECISION_GENESIS) {
      problems.push("seq 1 must link to the genesis hash");
    }
    if (policyDecisionChainHash(decision.prevHash, decision) !== decision.chainHash) problems.push(`seq ${decision.seq} chainHash does not match its record`);
  }
  const last = sorted[sorted.length - 1];
  if (knownHead) {
    const match = sorted.find((decision) => decision.seq === knownHead.seq);
    if (match && match.chainHash !== knownHead.chainHash) problems.push(`seq ${knownHead.seq} differs from the stored head: history was rewritten`);
    if (last && knownHead.seq > last.seq) problems.push(`the stored head (seq ${knownHead.seq}) is newer than this page`);
  }
  return { valid: problems.length === 0, head: last ? { seq: last.seq, chainHash: last.chainHash } : null, problems };
}

/** Deterministic exposure id: "px_" + sha256(intentId|stepId|quoteBinding)[0:24] (retries are idempotent). */
export function policyExposureId(intentId: string, stepId: string, quoteBinding: string): string {
  return `px_${sha256Hex(`${intentId}|${stepId}|${quoteBinding}`).slice(0, 24)}`;
}
