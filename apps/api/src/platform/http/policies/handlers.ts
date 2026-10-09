/**
 * Rule Book routes (policy design §11): rule books of keys and of the
 * project (versions, tighten now / loosen later, If-Match), static
 * validation, the simulator, the decision log, spend windows, approvals,
 * agent keys (children) and key expiry.
 *
 * Reads are scoped to the caller's subtree (project keys: the whole
 * project; agent keys: themselves and their descendants). Rule book writes
 * need a project key with its current secret; agent keys never write any
 * rule book, their own included.
 */
import type { Request, RequestHandler, Response } from "express";
import {
  comparePolicies,
  effectivePolicyDocument,
  OBSERVER_POLICY,
  policyHash,
  POLICY_DECISION_ID_PATTERN,
  validateIntentRequest,
  validatePolicy,
  type IntentGraph,
  type PolicyDecision,
  type PolicyDecisionOutcome,
  type PolicyDecisionStage,
  type PolicyDefaults,
  type PolicyDocument,
} from "@kletia/core";
import { PlatformError, toPlatformError } from "../../errors.js";
import { planIntent } from "../../index.js";
import { requireApiKey } from "../auth.js";
import { approvalIdParam, authOf, handle, HttpError, integerQuery, invalidRequest, isRecord, pathParam, queryParam, type AuthContext } from "../context.js";
import { idempotent } from "../idempotency.js";
import { createChildKey, keyIdParam, parseChildKeyRequest, parseKeyPatch, patchKey } from "../keys.js";
import { KeyWindowLimiter } from "../limits.js";
import { projectKeysOnly } from "./agentGuard.js";
import { announceAmended, announcePending, announcePromotions } from "./announce.js";
import { approvalStore, approvalView, decideApproval, listApprovals } from "./approvals.js";
import { chainLinks, inSubtree, readKeyChain, subtreeOf, type KeyChain } from "./chain.js";
import { decisionStore } from "./decisions.js";
import { ruleBookGate } from "./install.js";
import { spendLedger } from "./ledger.js";
import { policyStore, projectScope, type PolicyHeads, type PolicyScope, type PolicyVersion } from "./store.js";

export const POLICY_EVALUATIONS_PER_MINUTE = 30;
/** POST /v1/policy/evaluate: 30 per minute per key on top of the tier limit (§10.1 P21). */
export const policyEvaluateLimiter = new KeyWindowLimiter(POLICY_EVALUATIONS_PER_MINUTE, 60_000, "policy evaluations per minute");

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/* ------------------------------------------------------------------ views */

export interface PolicyVersionView {
  readonly scope: PolicyScope;
  readonly keyId?: string;
  readonly projectId?: string;
  readonly version: number;
  readonly hash: string | null;
  readonly status: PolicyVersion["status"];
  readonly document: PolicyDocument | null;
  readonly activatesAt: string | null;
  readonly loosened: readonly string[];
  readonly tightened: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

export function versionView(version: PolicyVersion): PolicyVersionView {
  return {
    scope: version.scope,
    ...(version.scope === "key" ? { keyId: version.subjectId } : { projectId: projectScope(version.subjectId) }),
    version: version.version,
    hash: version.hash,
    status: version.status,
    document: version.document,
    activatesAt: version.activatesAt,
    loosened: version.loosened,
    tightened: version.tightened,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
  };
}

function headsView(heads: PolicyHeads): Record<string, unknown> | null {
  if (!heads.active && !heads.pending) return null;
  const active = heads.active ? versionView(heads.active) : null;
  const pending = heads.pending
    ? { version: heads.pending.version, hash: heads.pending.hash, activatesAt: heads.pending.activatesAt, loosened: heads.pending.loosened, createdBy: heads.pending.createdBy, removal: heads.pending.document === null }
    : null;
  return { ...(active ?? { status: "none", version: null, hash: null, document: null }), pending };
}

/** The effective chain (root first) with each level's document as evaluated (defaults filled, display only). */
export function effectiveView(chain: KeyChain): Record<string, unknown> {
  const own = chain.levels[chain.levels.length - 1];
  return {
    keyActive: chain.keyActive,
    chain: chainLinks(chain.levels),
    defaults: own?.defaults ?? "project",
    levels: chain.levels.map((level) => ({
      scope: level.scope,
      id: level.id,
      version: level.version,
      hash: level.hash,
      defaults: level.defaults,
      document: level.policy || level.defaults === "agent" ? effectivePolicyDocument(level.policy ?? (level.defaults === "agent" ? OBSERVER_POLICY : null), level.defaults) : null,
    })),
  };
}

/* ---------------------------------------------------------------- callers */

interface Writer {
  readonly keyId: string;
  readonly projectId: string;
}

/** Rule book writes: a project key of the project with its current secret. */
function writer(auth: AuthContext): Writer {
  if (auth.tier === "operator") throw new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys have no project; rule books belong to projects and their keys.", 409);
  if (!auth.keyId || !auth.projectId) throw new HttpError(401, "API_KEY_REQUIRED", "Rule books require a developer API key.");
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Change rule books with the current secret.", 403);
  }
  return { keyId: auth.keyId, projectId: auth.projectId };
}

function reader(auth: AuthContext): { readonly keyId: string; readonly projectId: string } {
  if (auth.tier === "operator") throw new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys have no project; rule books belong to projects and their keys.", 409);
  if (!auth.keyId || !auth.projectId) throw new HttpError(401, "API_KEY_REQUIRED", "Rule books require a developer API key.");
  return { keyId: auth.keyId, projectId: auth.projectId };
}

async function subjectKeyOf(auth: AuthContext, id: string): Promise<{ readonly id: string; readonly defaults: PolicyDefaults }> {
  const record = await inSubtree(auth, keyIdParam(id));
  if (!record) throw new HttpError(404, "KEY_NOT_FOUND", "No API key with this id in your project (or your subtree).");
  return { id: record.id, defaults: record.kind === "agent" ? "agent" : "project" };
}

/** `If-Match: "sha256:…"` (quotes optional) or `none`; absent: unconditional. */
function ifMatchOf(req: Request): string | undefined {
  const raw = req.get("if-match")?.trim();
  if (!raw) return undefined;
  const value = raw.replace(/^W\//u, "").replace(/^"(.*)"$/u, "$1");
  if (value !== "none" && !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw invalidRequest("If-Match must be the rule book hash (\"sha256:…\") or \"none\".", [{ path: "If-Match", message: "Invalid hash." }]);
  }
  return value;
}

function documentBody(body: unknown, defaults: PolicyDefaults): { readonly document: PolicyDocument; readonly warnings: readonly unknown[] } {
  const input = isRecord(body) && isRecord(body.policy) && body.schema === undefined ? body.policy : body;
  const result = validatePolicy(input, { defaults });
  if (!result.ok) {
    throw new PlatformError("POLICY_INVALID", "The rule book is invalid; fix the fields listed in issues (validatePolicy in @kletia/core reports the same locally).", 400, result.issues.map((issue) => ({ path: issue.path, message: issue.message })));
  }
  return { document: result.value, warnings: result.warnings };
}

/* ------------------------------------------------------------- operations */

async function readPolicy(scope: PolicyScope, subjectId: string, chainOwner: string | null): Promise<Record<string, unknown>> {
  const now = Date.now();
  const heads = await policyStore().heads(scope, subjectId, now);
  if (heads.promoted.length > 0) announcePromotions(heads.promoted, now);
  const chain = chainOwner ? await readKeyChain(chainOwner, now) : undefined;
  return { policy: headsView(heads), ...(chain ? { effective: effectiveView(chain) } : {}) };
}

async function writePolicy(
  res: Response,
  auth: AuthContext,
  target: { readonly scope: PolicyScope; readonly subjectId: string; readonly defaults: PolicyDefaults },
  next: PolicyDocument | null,
  ifMatch: string | undefined,
  warnings: readonly unknown[],
): Promise<void> {
  const caller = writer(auth);
  const now = Date.now();
  const result = await policyStore().write({
    scope: target.scope,
    subjectId: target.subjectId,
    projectId: caller.projectId,
    next,
    defaults: target.defaults,
    createdBy: caller.keyId,
    ...(ifMatch !== undefined ? { ifMatch } : {}),
    now,
  });
  if (result.promoted.length > 0) announcePromotions(result.promoted, now);
  if (result.applied === "now") await announceAmended(result.version, caller.keyId, now);
  if (result.applied === "pending") await announcePending(result.version, caller.keyId, now);
  if (result.version.hash) res.setHeader("ETag", `"${result.version.hash}"`);
  sendJson(res, 200, {
    policy: versionView(result.version),
    applied: result.applied,
    tightened: result.comparison.tightened,
    loosened: result.comparison.loosened,
    supersededPending: result.supersededPending ? { version: result.supersededPending.version, hash: result.supersededPending.hash } : null,
    warnings,
  });
}

async function cancelPending(res: Response, auth: AuthContext, scope: PolicyScope, subjectId: string): Promise<void> {
  const caller = writer(auth);
  const cancelled = await policyStore().cancelPending(scope, subjectId, caller.projectId, Date.now());
  sendJson(res, 200, { policy: versionView(cancelled) });
}

/** POST /v1/policy/validate (public). */
export function validateHandler(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"policy\": {…}, \"against\"?: {…}, \"defaults\"?: \"project\" | \"agent\" }.", [{ path: "", message: "Expected an object." }]);
  const defaults: PolicyDefaults = body.defaults === "agent" ? "agent" : "project";
  if (body.defaults !== undefined && body.defaults !== "agent" && body.defaults !== "project") {
    throw invalidRequest("defaults must be project or agent.", [{ path: "defaults", message: "Expected project or agent." }]);
  }
  const input = body.policy ?? (body.schema !== undefined ? body : undefined);
  if (input === undefined) throw invalidRequest("Send the rule book as policy.", [{ path: "policy", message: "Required." }]);
  const result = validatePolicy(input, { defaults });
  const out: Record<string, unknown> = {
    valid: result.ok,
    issues: result.issues,
    warnings: result.warnings,
    ...(result.ok ? { document: result.value, hash: policyHash(result.value) } : {}),
  };
  if (body.against !== undefined && result.ok) {
    const against = body.against === null ? null : validatePolicy(body.against, { defaults });
    if (against && !against.ok) {
      out.against = { valid: false, issues: against.issues };
    } else {
      out.comparison = comparePolicies(against ? against.value : defaults === "agent" ? OBSERVER_POLICY : null, result.value, { defaults });
    }
  }
  return out;
}

interface EvaluateBody {
  readonly keyId?: string;
  readonly policy?: unknown;
  readonly request: unknown;
  readonly stage: "plan" | "prepare";
  readonly at?: number;
}

function parseEvaluateBody(body: unknown): EvaluateBody {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"request\": {…}, \"keyId\"?, \"policy\"?, \"stage\"?, \"at\"? }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => !["keyId", "policy", "request", "stage", "at"].includes(key));
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  if (body.request === undefined) throw invalidRequest("request is required (an intent request: text or actions, and accounts).", [{ path: "request", message: "Required." }]);
  const stage = body.stage === undefined ? "plan" : body.stage;
  if (stage !== "plan" && stage !== "prepare") throw invalidRequest("stage must be plan or prepare.", [{ path: "stage", message: "Expected plan or prepare." }]);
  let at: number | undefined;
  if (body.at !== undefined) {
    at = typeof body.at === "string" ? Date.parse(body.at) : Number.NaN;
    if (!Number.isFinite(at)) throw invalidRequest("at must be an ISO time.", [{ path: "at", message: "Invalid time." }]);
  }
  if (body.keyId !== undefined && typeof body.keyId !== "string") throw invalidRequest("keyId must be a key id.", [{ path: "keyId", message: "Invalid key id." }]);
  return {
    ...(typeof body.keyId === "string" ? { keyId: body.keyId } : {}),
    ...(body.policy !== undefined ? { policy: body.policy } : {}),
    request: body.request,
    stage,
    ...(at !== undefined ? { at } : {}),
  };
}

/** POST /v1/policy/evaluate: plans as a dry run under the effective constraints and explains every rule. */
export async function evaluatePolicyRequest(auth: AuthContext, body: unknown): Promise<Record<string, unknown>> {
  const caller = reader(auth);
  const parsed = parseEvaluateBody(body);
  const owner = await subjectKeyOf(auth, parsed.keyId ?? caller.keyId);
  const gate = ruleBookGate();
  if (!gate) throw new PlatformError("STORE_UNAVAILABLE", "Rule books are not enforced on this deployment (KLETIA_POLICIES_ENABLED=false), so nothing can be evaluated.", 503);
  let draft: PolicyDocument | null | undefined;
  if (parsed.policy !== undefined) draft = parsed.policy === null ? null : documentBody(parsed.policy, owner.defaults).document;
  const validated = validateIntentRequest(parsed.request);
  if (!validated.ok) throw invalidRequest("The intent request is invalid.", validated.issues);
  const narrowed = await gate.narrow(owner.id, validated.value, draft);
  let graph: IntentGraph | null = null;
  let planError: { readonly code: string; readonly message: string } | null = null;
  try {
    graph = await planIntent(narrowed, { ownerKeyId: owner.id });
  } catch (error) {
    const failure = toPlatformError(error);
    planError = { code: failure.code, message: failure.message };
  }
  const evaluation = await gate.simulate({
    ownerKeyId: owner.id,
    actorKeyId: caller.keyId,
    request: narrowed,
    graph,
    stage: parsed.stage,
    ...(parsed.at !== undefined ? { at: parsed.at } : {}),
    ...(draft !== undefined ? { draft } : {}),
  });
  // Without a plan only request-level rules ran: say so, so "allow" is never read as a full pass.
  const complete = graph !== null;
  return {
    evaluation: {
      keyId: owner.id,
      ...evaluation,
      complete,
      ...(complete ? {} : { warnings: [...evaluation.warnings, `Planning failed (${planError?.code ?? "unknown"}), so only request-level rules were evaluated; fix the request and evaluate again.`] }),
    },
    intent: graph,
    planError,
  };
}

function decisionFilters(req: Request): Omit<Parameters<ReturnType<typeof decisionStore>["list"]>[0], "projectId" | "keyIds"> {
  const outcome = queryParam(req, "outcome", 16);
  const stage = queryParam(req, "stage", 16);
  const since = queryParam(req, "since", 40);
  const after = queryParam(req, "after", 40);
  const keyId = queryParam(req, "keyId", 40);
  const intentId = queryParam(req, "intentId", 40);
  const outcomes: readonly PolicyDecisionOutcome[] = ["allow", "confirm", "deny", "approved", "rejected", "observed"];
  const stages: readonly PolicyDecisionStage[] = ["plan", "prepare", "submit", "evaluate", "approval", "amendment", "key"];
  if (outcome !== undefined && !outcomes.includes(outcome as PolicyDecisionOutcome)) throw invalidRequest(`outcome must be one of ${outcomes.join(", ")}.`, [{ path: "outcome", message: "Unknown outcome." }]);
  if (stage !== undefined && !stages.includes(stage as PolicyDecisionStage)) throw invalidRequest(`stage must be one of ${stages.join(", ")}.`, [{ path: "stage", message: "Unknown stage." }]);
  if (since !== undefined && Number.isNaN(Date.parse(since))) throw invalidRequest("since must be an ISO time.", [{ path: "since", message: "Invalid time." }]);
  if (after !== undefined && !POLICY_DECISION_ID_PATTERN.test(after)) throw invalidRequest("after must be a decision id (pdc_…).", [{ path: "after", message: "Invalid id." }]);
  return {
    ...(outcome ? { outcome: outcome as PolicyDecisionOutcome } : {}),
    ...(stage ? { stage: stage as PolicyDecisionStage } : {}),
    ...(since ? { since: new Date(Date.parse(since)).toISOString() } : {}),
    ...(after ? { after } : {}),
    ...(keyId ? { keyId } : {}),
    ...(intentId ? { intentId } : {}),
    limit: integerQuery(req, "limit", 50, 1, 200),
  };
}

async function listDecisions(auth: AuthContext, req: Request): Promise<{ decisions: PolicyDecision[]; head: unknown }> {
  reader(auth);
  const subtree = await subtreeOf(auth);
  const filters = decisionFilters(req);
  if (filters.keyId && subtree.keyIds !== null && !subtree.keyIds.includes(filters.keyId)) throw new HttpError(404, "KEY_NOT_FOUND", "No API key with this id in your subtree.");
  const projectId = projectScope(subtree.projectId);
  const decisions = await decisionStore().list({ projectId, ...(subtree.keyIds !== null ? { keyIds: subtree.keyIds } : {}), ...filters });
  return { decisions, head: await decisionStore().head(projectId) };
}

async function getDecision(auth: AuthContext, id: string): Promise<PolicyDecision> {
  reader(auth);
  if (!POLICY_DECISION_ID_PATTERN.test(id)) throw invalidRequest("Decision ids look like pdc_ followed by 24 hex characters.", [{ path: "id", message: "Invalid decision id." }]);
  const subtree = await subtreeOf(auth);
  const decision = await decisionStore().get(id);
  const visible = decision && decision.projectId === projectScope(subtree.projectId) && (subtree.keyIds === null || (decision.keyId !== null && subtree.keyIds.includes(decision.keyId)));
  if (!decision || !visible) throw new HttpError(404, "NOT_FOUND", "No decision with this id in your subtree.");
  return decision;
}

/** GET /v1/policy/spend: window usage and what remains for every scope of a key's chain. */
async function spendOf(auth: AuthContext, keyId: string | undefined): Promise<Record<string, unknown>> {
  const caller = reader(auth);
  const owner = await subjectKeyOf(auth, keyId ?? caller.keyId);
  const now = Date.now();
  const chain = await readKeyChain(owner.id, now);
  if (!chain) throw new HttpError(404, "KEY_NOT_FOUND", "No API key with this id.");
  const usage = await spendLedger().usage(chain.levels.map((level) => level.id), now);
  const usd = (micros: bigint) => `${micros / 1_000_000n}.${((micros % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
  const remaining = (cap: string | undefined, used: bigint) => {
    if (cap === undefined) return null;
    const [whole = "0", fraction = ""] = cap.split(".");
    const capMicros = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
    return usd(capMicros > used ? capMicros - used : 0n);
  };
  return {
    keyId: owner.id,
    at: new Date(now).toISOString(),
    scopes: chain.levels.map((level) => {
      const used = usage.get(level.id) ?? { dayUsdMicros: 0n, weekUsdMicros: 0n };
      const caps = level.policy?.caps;
      return {
        scope: level.id,
        kind: level.scope,
        capDailyUsd: caps?.dailyUsd ?? null,
        usedDailyUsd: usd(used.dayUsdMicros),
        remainingDailyUsd: remaining(caps?.dailyUsd, used.dayUsdMicros),
        capWeeklyUsd: caps?.weeklyUsd ?? null,
        usedWeeklyUsd: usd(used.weekUsdMicros),
        remainingWeeklyUsd: remaining(caps?.weeklyUsd, used.weekUsdMicros),
        perStepUsd: caps?.perStepUsd ?? null,
        perIntentUsd: caps?.perIntentUsd ?? null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ table */

export function policyHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /keys/:id/children": [
      requireApiKey,
      idempotent({ route: "POST /keys/:id/children", secret: true }),
      handle(async (req, res) => {
        const parentId = keyIdParam(pathParam(req, "id"));
        const request = parseChildKeyRequest(req.body);
        sendJson(res, 201, await createChildKey(authOf(req), parentId, request));
      }),
    ],
    "patch /keys/:id": [
      requireApiKey,
      handle(async (req, res) => {
        const id = keyIdParam(pathParam(req, "id"));
        sendJson(res, 200, { key: await patchKey(authOf(req), id, parseKeyPatch(req.body)) });
      }),
    ],
    "get /keys/:id/policy": [
      requireApiKey,
      handle(async (req, res) => {
        const auth = authOf(req);
        reader(auth);
        const subject = await subjectKeyOf(auth, pathParam(req, "id"));
        sendJson(res, 200, await readPolicy("key", subject.id, subject.id));
      }),
    ],
    "put /keys/:id/policy": [
      requireApiKey,
      projectKeysOnly,
      idempotent({ route: "PUT /keys/:id/policy" }),
      handle(async (req, res) => {
        const auth = authOf(req);
        const subject = await subjectKeyOf(auth, pathParam(req, "id"));
        const { document, warnings } = documentBody(req.body, subject.defaults);
        await writePolicy(res, auth, { scope: "key", subjectId: subject.id, defaults: subject.defaults }, document, ifMatchOf(req), warnings);
      }),
    ],
    "delete /keys/:id/policy": [
      requireApiKey,
      projectKeysOnly,
      handle(async (req, res) => {
        const auth = authOf(req);
        const subject = await subjectKeyOf(auth, pathParam(req, "id"));
        await writePolicy(res, auth, { scope: "key", subjectId: subject.id, defaults: subject.defaults }, null, ifMatchOf(req), []);
      }),
    ],
    "delete /keys/:id/policy/pending": [
      requireApiKey,
      projectKeysOnly,
      handle(async (req, res) => {
        const auth = authOf(req);
        const subject = await subjectKeyOf(auth, pathParam(req, "id"));
        await cancelPending(res, auth, "key", subject.id);
      }),
    ],
    "get /keys/:id/policy/versions": [
      requireApiKey,
      handle(async (req, res) => {
        const auth = authOf(req);
        reader(auth);
        const subject = await subjectKeyOf(auth, pathParam(req, "id"));
        const versions = await policyStore().versions("key", subject.id, integerQuery(req, "limit", 100, 1, 100));
        sendJson(res, 200, { versions: versions.map(versionView) });
      }),
    ],
    "get /projects/current/policy": [
      requireApiKey,
      handle(async (req, res) => {
        const auth = authOf(req);
        const caller = reader(auth);
        sendJson(res, 200, await readPolicy("project", caller.projectId, null));
      }),
    ],
    "put /projects/current/policy": [
      requireApiKey,
      projectKeysOnly,
      idempotent({ route: "PUT /projects/current/policy" }),
      handle(async (req, res) => {
        const auth = authOf(req);
        const caller = writer(auth);
        const { document, warnings } = documentBody(req.body, "project");
        await writePolicy(res, auth, { scope: "project", subjectId: caller.projectId, defaults: "project" }, document, ifMatchOf(req), warnings);
      }),
    ],
    "delete /projects/current/policy": [
      requireApiKey,
      projectKeysOnly,
      handle(async (req, res) => {
        const auth = authOf(req);
        const caller = writer(auth);
        await writePolicy(res, auth, { scope: "project", subjectId: caller.projectId, defaults: "project" }, null, ifMatchOf(req), []);
      }),
    ],
    "delete /projects/current/policy/pending": [
      requireApiKey,
      projectKeysOnly,
      handle(async (req, res) => {
        const auth = authOf(req);
        const caller = writer(auth);
        await cancelPending(res, auth, "project", caller.projectId);
      }),
    ],
    "post /policy/validate": [
      handle((req, res) => {
        sendJson(res, 200, validateHandler(req.body));
      }),
    ],
    "post /policy/evaluate": [
      requireApiKey,
      policyEvaluateLimiter.middleware(),
      handle(async (req, res) => {
        sendJson(res, 200, await evaluatePolicyRequest(authOf(req), req.body));
      }),
    ],
    "get /policy/decisions": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, await listDecisions(authOf(req), req));
      }),
    ],
    "get /policy/decisions/:id": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { decision: await getDecision(authOf(req), pathParam(req, "id")) });
      }),
    ],
    "get /policy/spend": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { spend: await spendOf(authOf(req), queryParam(req, "keyId", 40)) });
      }),
    ],
    "get /policy/approvals": [
      requireApiKey,
      handle(async (req, res) => {
        const auth = authOf(req);
        reader(auth);
        const role = queryParam(req, "role", 16) ?? "requester";
        if (role !== "approver" && role !== "requester") throw invalidRequest("role must be approver or requester.", [{ path: "role", message: "Expected approver or requester." }]);
        const status = queryParam(req, "status", 16);
        if (status !== undefined && !["pending", "approved", "rejected", "expired"].includes(status)) {
          throw invalidRequest("status must be pending, approved, rejected or expired.", [{ path: "status", message: "Unknown status." }]);
        }
        const subtree = await subtreeOf(auth);
        const records = await listApprovals(auth, role, status as "pending" | undefined, subtree.keyIds, integerQuery(req, "limit", 20, 1, 100));
        sendJson(res, 200, { approvals: await Promise.all(records.map((record) => approvalView(record))) });
      }),
    ],
    "get /policy/approvals/:id": [
      handle(async (req, res) => {
        const record = await approvalStore().get(approvalIdParam(req));
        if (!record) throw new PlatformError("APPROVAL_NOT_FOUND", "No approval with this id.", 404);
        sendJson(res, 200, { approval: await approvalView(record) });
      }),
    ],
    "post /policy/approvals/:id/approve": [
      handle(async (req, res) => {
        const { approval } = await decideApproval(approvalIdParam(req), "approve", authOf(req), req.body);
        sendJson(res, 200, { approval: await approvalView(approval) });
      }),
    ],
    "post /policy/approvals/:id/reject": [
      handle(async (req, res) => {
        const { approval } = await decideApproval(approvalIdParam(req), "reject", authOf(req), req.body);
        sendJson(res, 200, { approval: await approvalView(approval) });
      }),
    ],
  };
}
