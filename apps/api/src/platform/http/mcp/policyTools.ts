/**
 * MCP tools of the Rule Book (policy design §12.3). Agents connect with
 * their agent key:
 *
 * - `get_policy` (read-only): the caller's effective rule book in plain
 *   terms, with spend used and remaining: "know your leash" before planning;
 * - `check_intent` (read-only): the simulator (`POST /v1/policy/evaluate`,
 *   stage plan) with a per-rule explanation;
 * - `create_intent`: stores an intent owned by the caller's key (agent keys
 *   need `permissions.storeIntents` and `permissions.mcpCreateIntents`);
 *   never prepares, returns the approval link when the intent is held and an
 *   execution link for the signer service, never calldata;
 * - `get_approval` (read-only): status of an approval (polling).
 *
 * `plan_intent` and `get_intent` carry the decision (tools.ts).
 */
import {
  APPROVAL_ID_PATTERN,
  effectivePermissions,
  POLICY_MODES,
  scheduleState,
  type IntentGraph,
  type IntentPolicyStamp,
  type PolicyDocument,
} from "@kletia/core";
import { createIntentDetailed, policyErrorDetails } from "../../index.js";
import { PlatformError } from "../../errors.js";
import { apiKeyStore } from "../auth.js";
import { HttpError, invalidRequest, type AuthContext } from "../context.js";
import { rememberIntentOwner } from "../owners.js";
import { assertAgentPermission } from "../policies/agentGuard.js";
import { approvalStore, approvalView } from "../policies/approvals.js";
import { chainLinks, readKeyChain } from "../policies/chain.js";
import { evaluatePolicyRequest } from "../policies/handlers.js";
import { spendLedger } from "../policies/ledger.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import type { KletiaTool, ToolAnnotations, ToolCaller } from "./tools.js";

function annotations(title: string, readOnly: boolean, idempotent: boolean, openWorld: boolean): ToolAnnotations {
  return { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld };
}

/** The caller's AuthContext outside an HTTP request (project, kind and lineage from the key store). */
export async function toolAuth(caller: ToolCaller): Promise<AuthContext> {
  if (!caller.keyId) throw new HttpError(401, "API_KEY_REQUIRED", "This tool needs an API key: connect with Authorization: Bearer <key>.");
  if (caller.tier === "operator") return { tier: "operator", keyId: caller.keyId };
  const record = await apiKeyStore().findById(caller.keyId);
  if (!record) throw new HttpError(401, "API_KEY_REQUIRED", "This tool needs an API key: connect with Authorization: Bearer <key>.");
  return {
    tier: "developer",
    keyId: record.id,
    projectId: record.projectId,
    keyKind: record.kind === "agent" ? "agent" : "project",
    ...(record.kind === "agent" ? { lineage: [...(record.lineage ?? [])] } : {}),
  };
}

function usd(micros: bigint): string {
  return `${micros / 1_000_000n}.${((micros % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}

function capMicros(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

/** One rule book in plain terms (no addresses beyond counts, never the whole allowlists). */
function plainLevel(document: PolicyDocument | null, at: number): Record<string, unknown> {
  if (!document) return { ruleBook: false };
  const schedule = document.schedule ? scheduleState(document.schedule, at) : null;
  return {
    ruleBook: true,
    mode: document.mode ?? "live",
    ...(document.networks?.allow ? { networks: document.networks.allow } : {}),
    ...(document.networks?.lanes ? { lanes: document.networks.lanes } : {}),
    ...(document.kinds?.allow ? { kinds: document.kinds.allow } : {}),
    ...(document.protocols ? { protocols: { allow: document.protocols.allow ?? "any", deny: document.protocols.deny ?? [] } } : {}),
    ...(document.assets ? { assets: { allow: document.assets.allow ?? "any", categories: document.assets.categories ?? "any", unlisted: document.assets.unlisted ?? "allow" } } : {}),
    ...(document.accounts?.allow ? { pinnedAccounts: document.accounts.allow.length } : {}),
    recipients: { mode: document.recipients?.mode ?? "any", allowlist: document.recipients?.allow?.length ?? 0, denylist: document.recipients?.deny?.length ?? 0, names: document.recipients?.names ?? "resolve" },
    ...(document.contracts?.allow ? { contracts: document.contracts.allow.length } : {}),
    ...(document.limits ? { limits: document.limits } : {}),
    ...(document.caps ? { caps: document.caps } : {}),
    ...(document.confirm ? { confirm: { aboveUsd: document.confirm.aboveUsd ?? null, when: document.confirm.when ?? [], requireWallet: document.confirm.approvers?.requireWallet ?? false } } : {}),
    ...(schedule ? { schedule: { open: schedule.open, nextChange: schedule.nextChange, timezone: schedule.timezone } } : {}),
  };
}

/** The decision block of plan_intent and create_intent. */
export function stampSummary(stamp: IntentPolicyStamp | undefined): Record<string, unknown> | undefined {
  if (!stamp) return undefined;
  return {
    outcome: stamp.outcome,
    decisionId: stamp.decisionId,
    notionalUsd: stamp.notionalUsd,
    chain: stamp.chain.map((link) => `${link.scope}:${link.id}@v${link.version}`),
    ...(stamp.approval ? { approval: { url: stamp.approval.url, expiresAt: stamp.approval.expiresAt, ceilingUsd: stamp.approval.ceilingUsd, triggers: stamp.approval.triggers } } : {}),
  };
}

/** Rolling 24 h / 7 d remainders of every capped scope of a key's chain. */
export async function remainingFor(keyId: string): Promise<Record<string, unknown>[]> {
  const chain = await readKeyChain(keyId);
  if (!chain) return [];
  const capped = chain.levels.filter((level) => level.policy?.caps?.dailyUsd !== undefined || level.policy?.caps?.weeklyUsd !== undefined);
  if (capped.length === 0) return [];
  const usage = await spendLedger().usage(capped.map((level) => level.id), Date.now());
  return capped.map((level) => {
    const used = usage.get(level.id) ?? { dayUsdMicros: 0n, weekUsdMicros: 0n };
    const caps = level.policy?.caps ?? {};
    const left = (cap: string | undefined, spent: bigint) => (cap === undefined ? null : usd(capMicros(cap) > spent ? capMicros(cap) - spent : 0n));
    return { scope: level.id, dailyRemainingUsd: left(caps.dailyUsd, used.dayUsdMicros), weeklyRemainingUsd: left(caps.weeklyUsd, used.weekUsdMicros) };
  });
}

/** A refusal of the gate as a plan_intent answer (outcome deny with rule ids) instead of an error. */
export function deniedPlan(error: unknown): Record<string, unknown> | null {
  const details = policyErrorDetails(error);
  if (!details || !(error instanceof PlatformError)) return null;
  return {
    outcome: "deny",
    code: error.code,
    decisionId: details.decisionId,
    keyId: details.keyId,
    violations: details.violations.map((violation) => ({ rule: violation.rule, message: violation.message, ...(violation.path ? { path: violation.path } : {}) })),
    retryAt: details.retryAt,
    ...(details.approval ? { approval: { url: details.approval.url, status: details.approval.status ?? "pending" } } : {}),
  };
}

const INTENT_INPUT = {
  text: { type: "string", minLength: 1, maxLength: 1000, description: "The intent in plain English." },
  actions: { type: "array", minItems: 1, maxItems: 8, items: { type: "object" }, description: "Structured alternative to `text` (as plan_intent)." },
  accounts: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", maxLength: 128 }, description: "The user's CAIP-10 accounts, one per network family involved." },
  defaultNetwork: { type: "string", maxLength: 24 },
  constraints: { type: "object" },
} as const;

export const GET_POLICY_TOOL: KletiaTool = {
  name: "get_policy",
  description:
    "Read the rule book that binds the connecting API key (and its parents and project): mode, networks, kinds, venues, recipients, limits, caps with what is used and left in the rolling 24 h and 7 d windows, the timetable and the approval threshold. Call it before planning: a refusal names the rule ids it broke.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: annotations("Read my rule book", true, true, false),
  async run(_args, caller) {
    const auth = await toolAuth(caller);
    if (!auth.keyId || auth.tier === "operator") return { keyId: caller.keyId, ruleBook: false, note: "Operator keys are not bound by rule books." };
    const now = Date.now();
    const chain = await readKeyChain(auth.keyId, now);
    if (!chain) throw new HttpError(401, "API_KEY_REQUIRED", "This tool needs an API key: connect with Authorization: Bearer <key>.");
    const record = chain.record;
    const modes = chain.levels.map((level) => level.policy?.mode ?? (level.defaults === "agent" && !level.policy ? "dry-run" : "live"));
    const mode = POLICY_MODES[Math.max(...modes.map((entry) => POLICY_MODES.indexOf(entry)))] ?? "live";
    return {
      keyId: auth.keyId,
      kind: auth.keyKind ?? "project",
      expiresAt: record?.expiresAt ?? null,
      active: chain.keyActive,
      mode,
      chain: chainLinks(chain.levels).map((link) => `${link.scope}:${link.id}@v${link.version}`),
      levels: chain.levels.map((level) => ({ scope: level.scope, id: level.id, defaults: level.defaults, ...plainLevel(level.policy, now) })),
      permissions: auth.keyKind === "agent" ? effectivePermissions(chain.levels.map((level) => ({ policy: level.policy, defaults: level.defaults }))) : "project keys are not limited by permissions",
      remaining: await remainingFor(auth.keyId),
      note: "Rolling caps count every intent and payload; splitting amounts, adding accounts or using names does not get around a rule.",
    };
  },
};

export const CHECK_INTENT_TOOL: KletiaTool = {
  name: "check_intent",
  description:
    "Explain how the connecting key's rule book judges an intent before planning it for real: every rule with pass, fail or trigger, the observed value and the limit, the effective constraints, spend windows and the timetable. Nothing is stored and nothing can be signed.",
  inputSchema: { type: "object", properties: INTENT_INPUT, required: ["accounts"], additionalProperties: false },
  annotations: annotations("Check an intent against my rule book", true, false, true),
  async run(args, caller) {
    const auth = await toolAuth(caller);
    if (typeof args.text !== "string" && !Array.isArray(args.actions)) {
      throw invalidRequest("Provide text or actions.", [{ path: "text", message: "Required unless actions are given." }]);
    }
    const result = await evaluatePolicyRequest(auth, { request: args, stage: "plan" });
    const evaluation = result.evaluation as { outcome: string; notionalUsd: string | null; rules: { rule: string; status: string; message?: string; observed?: string; limit?: string; path?: string }[]; warnings: string[]; usage: unknown; schedule: unknown };
    const intent = result.intent as IntentGraph | null;
    return {
      outcome: evaluation.outcome,
      complete: intent !== null,
      notionalUsd: evaluation.notionalUsd,
      rules: evaluation.rules.map((rule) => ({ rule: rule.rule, status: rule.status, ...(rule.observed ? { observed: rule.observed } : {}), ...(rule.limit ? { limit: rule.limit } : {}), ...(rule.path ? { path: rule.path } : {}) })),
      warnings: evaluation.warnings,
      usage: evaluation.usage,
      schedule: evaluation.schedule,
      planned: intent ? { title: intent.summary.title, steps: intent.steps.length, networks: intent.summary.networks } : null,
      planError: result.planError,
    };
  },
};

export const CREATE_INTENT_TOOL: KletiaTool = {
  name: "create_intent",
  description:
    "Store an intent owned by the connecting API key, so the key's signer service can execute it by id. Nothing is prepared or signed here and no calldata is returned. The key's rule book judges it: a refusal names the rule ids; an intent above the approval threshold is held and the result carries the approval link to give to a human. Send clientReference to make retries idempotent.",
  inputSchema: {
    type: "object",
    properties: { ...INTENT_INPUT, clientReference: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,80}$", description: "Idempotency reference: the same value returns the intent created before." } },
    required: ["accounts"],
    additionalProperties: false,
  },
  annotations: annotations("Store an intent (no signing)", false, true, true),
  async run(args, caller) {
    const auth = await toolAuth(caller);
    if (!auth.keyId || auth.tier === "operator") throw new HttpError(401, "API_KEY_REQUIRED", "create_intent needs a developer or agent API key.");
    await assertAgentPermission(auth, "mcpCreateIntents");
    if (typeof args.text !== "string" && !Array.isArray(args.actions)) {
      throw invalidRequest("Provide text or actions.", [{ path: "text", message: "Required unless actions are given." }]);
    }
    const { intent, replayed } = await createIntentDetailed(args, { ownerKeyId: auth.keyId });
    if (!replayed) rememberIntentOwner(intent.id, auth.keyId);
    return {
      intentId: intent.id,
      replayed,
      status: intent.status,
      title: intent.summary.title,
      expiresAt: intent.expiresAt,
      ...(intent.policy ? { policy: stampSummary(intent.policy) } : {}),
      ...(intent.policy?.approval ? { approval: { url: intent.policy.approval.url, status: "pending", expiresAt: intent.policy.approval.expiresAt } } : {}),
      execute: {
        link: `${kletiaWebOrigin()}/embed#intent=${intent.id}`,
        note: "Your signer service executes intent ids; Kletia never returns calldata here.",
      },
    };
  },
};

export const GET_APPROVAL_TOOL: KletiaTool = {
  name: "get_approval",
  description: "Read the status of an approval (apr_…) a held intent is waiting for: pending, approved, rejected or expired, with the ceiling and expiry. Reading it never approves anything.",
  inputSchema: {
    type: "object",
    properties: { approvalId: { type: "string", pattern: APPROVAL_ID_PATTERN.source, description: "apr_ followed by 32 hex characters (the fragment of the approval link)." } },
    required: ["approvalId"],
    additionalProperties: false,
  },
  annotations: annotations("Read an approval", true, true, false),
  async run(args) {
    const id = typeof args.approvalId === "string" ? args.approvalId : "";
    if (!APPROVAL_ID_PATTERN.test(id)) throw invalidRequest("approvalId must be apr_ followed by 32 hex characters.", [{ path: "approvalId", message: "Invalid approval id." }]);
    const record = await approvalStore().get(id);
    if (!record) throw new PlatformError("APPROVAL_NOT_FOUND", "No approval with this id.", 404);
    const view = await approvalView(record);
    return { id: view.id, status: view.status, intentId: view.intentId, expiresAt: view.expiresAt, ceilingUsd: view.ceilingUsd, triggers: view.triggers, decidedAt: view.decidedAt };
  },
};

export const POLICY_TOOLS: readonly KletiaTool[] = [GET_POLICY_TOOL, CHECK_INTENT_TOOL, CREATE_INTENT_TOOL, GET_APPROVAL_TOOL];
