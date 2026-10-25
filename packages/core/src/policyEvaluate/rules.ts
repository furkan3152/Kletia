/**
 * Defaults, policy facts, the rule table and violation shapes.
 */
import type { AssetCategory } from "../assets.js";
import type { NetworkKey } from "../chains.js";
import type { AccountId, AssetId } from "../caip.js";
import type { IntentActionKind } from "../intent.js";
import {
  PROTOCOLS,
  protocolDependencies,
  type ProtocolId,
} from "../protocols.js";
import type { PolicyDefaults } from "../policy.js";

/** Planner defaults the narrowing starts from (engine `DEFAULT_SLIPPAGE_BPS`, `DEFAULT_MAX_SECONDS`). */
export const INTENT_DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_DEFAULT_MAX_SECONDS = 600;

/** Protocols Kletia builds transactions for (`capabilities` includes `execute`). */
export const EXECUTABLE_PROTOCOLS: readonly ProtocolId[] = Object.freeze(
  PROTOCOLS.filter((protocol) => protocol.capabilities.includes("execute")).map((protocol) => protocol.id),
);

/** "raydium (via jupiter)" for a routed protocol, the id otherwise (decision log `observed`). */
export function observedProtocol(protocol: ProtocolId): string {
  const via = protocolDependencies(protocol).slice(1);
  return via.length > 0 ? `${protocol} (via ${via.join(", ")})` : protocol;
}

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
    /** Fresh value; null when unpriced. The evaluator recomputes it from the steps. */
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

/** Rule ids are stable API. */
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

/** Error codes of policy refusals, non-retryable first. */
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

/** The code a set of violations is refused with (non-retryable codes first); null when empty. */
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
  /** `agent`: absent fields take agent defaults. Default `project`. */
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
  /** Fresh value of the intent; null when unpriced. */
  readonly notionalUsdMicros: bigint | null;
  /** Error code by precedence; null when allowed or held. */
  readonly code: string | null;
  /** Seconds to retry after (schedule, approvals); null otherwise. */
  readonly retryAfterSeconds: number | null;
}
