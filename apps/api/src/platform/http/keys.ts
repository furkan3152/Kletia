/**
 * API key self-management: list, issue siblings, rotate and revoke the keys
 * of the caller's project, and agent keys (Rule Book, policy design §8).
 *
 * - GET /v1/keys: the project's keys (never secrets; `last4` only); an agent
 *   key sees itself and its subtree.
 * - POST /v1/keys with a developer key: a sibling key in the same project
 *   (at most 5 active project keys per project). Agent keys never issue
 *   project keys (AGENT_KEY_FORBIDDEN).
 * - POST /v1/keys `{ name, sandbox: true }`: the key is issued with a
 *   key-level rule book that keeps it on the testnet lane
 *   (`networks.lanes: ["testnet"]`), written in the same request through the
 *   policy store, so the Rule Book enforces it like any other rule book. If
 *   that write fails the key is revoked again (never left unrestricted).
 *   Every listed key shows its `lane` (testnet, production or any), derived
 *   from the active rule books of its chain.
 * - POST /v1/projects/current/publishable-keys (projects.ts): a publishable
 *   key (`kl_pub_`, browsers) under the calling project key, with a key-level
 *   rule book derived from the project defaults, written in the same request
 *   (revoked again if that write fails). At most 5 active per project.
 * - POST /v1/keys/{id}/children: an agent key (`kl_agt_`) under `{id}` with
 *   its first rule book (a document, a template, or the observer), at most
 *   2 levels below a project key, 100 active per project, expiring in 1 h to
 *   365 d and never after its parent.
 * - PATCH /v1/keys/{id} `{ expiresAt }`: an ancestor shortens at once;
 *   extending is a loosening, applied at once only when the key's rule book
 *   has no amendment delay.
 * - POST /v1/keys/{id}/rotate: new secret, same id. The previous secret keeps
 *   authenticating for `graceSeconds` (default 24 h, 0 = revoke it now), but
 *   only the newest previous secret: rotating again ends the earlier grace.
 * - DELETE /v1/keys/{id}: revoke the key and its whole subtree in one write
 *   (idempotent). Their webhooks and delivery logs are deleted with them;
 *   repeating the call finishes a cleanup that failed, and authentication
 *   checks every ancestor anyway.
 *
 * Project keys manage every key of the project; agent keys only their own
 * descendants (never themselves, never project keys). Operator keys
 * (configuration) are immutable: 409 KEY_NOT_MANAGEABLE. A secret inside its
 * grace window authenticates but cannot manage keys (403 KEY_SECRET_ROTATED),
 * so a leaked secret cannot take a rotated key over.
 */
import { CHAINS, PROJECT_LIMITS, POLICY_LANES, POLICY_LIMITS, POLICY_TEMPLATES, policyFromTemplate, validatePolicy, type PolicyDocument, type PolicyLane, type PolicyTemplateId, type PolicyWarning } from "@kletia/core";
import { PlatformError } from "../errors.js";
import {
  apiKeyStore,
  forgetCachedKey,
  issueAgentKey,
  issueDeveloperKey,
  issuePublishableKey,
  keyKindOf,
  keyLive,
  newSecretFor,
  type ApiKeyKind,
  type ApiKeyRecord,
  type IssuedAgentKey,
  type IssuedApiKey,
  type IssuedPublishableKey,
  type KeyTier,
} from "./auth.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "./context.js";
import { deliveryStore } from "./deliveries.js";
import { assertAgentPermission, agentForbidden } from "./policies/agentGuard.js";
import { publishKeyEvent, recordKeyDecision, announceAmended } from "./policies/announce.js";
import { readKeyChain } from "./policies/chain.js";
import { policyStore, projectScope, subjectKey } from "./policies/store.js";
import { deleteWebhooksOfKey } from "./webhooks.js";

export const MAX_ACTIVE_KEYS_PER_PROJECT = 5;
export const MAX_ACTIVE_PUBLISHABLE_KEYS_PER_PROJECT = PROJECT_LIMITS.activePublishableKeys;
export const MAX_ACTIVE_AGENT_KEYS_PER_PROJECT = POLICY_LIMITS.agentKeysPerProject;
export const MAX_AGENT_DEPTH = POLICY_LIMITS.maxAgentDepth;
export const DEFAULT_ROTATION_GRACE_SECONDS = 86_400;
export const MAX_ROTATION_GRACE_SECONDS = 604_800;
export const API_KEY_ID_PATTERN = /^key_[0-9a-f]{24}$/u;
const OPERATOR_KEY_ID_PATTERN = /^op_[0-9a-f]{16}$/u;

/** API representation of a stored key. */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly kind: ApiKeyKind;
  /** Parent of an agent key (null for project keys). */
  readonly parentId: string | null;
  /** Levels below the project key (0 for project keys). */
  readonly depth: number;
  readonly last4: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly previousExpiresAt: string | null;
  readonly revokedAt: string | null;
  /** When the key stops authenticating (always set on agent keys). */
  readonly expiresAt: string | null;
  /** Active rule book version of the key (null: none; an agent key without one is the observer). */
  readonly policyVersion: number | null;
  /** Active descendants (agent keys below this key). */
  readonly descendants: number;
  /** Lanes the key's active rule book chain allows: testnet only (a sandbox key), production only, or any. */
  readonly lane: KeyLane;
  /** True for the key that made this request. */
  readonly current: boolean;
}

export type KeyLane = "testnet" | "production" | "any";

/** An issued key with the lane its rule books allow (POST /v1/keys). */
export interface IssuedProjectKey extends IssuedApiKey {
  readonly lane: KeyLane;
}

/** The key-level rule book of a sandbox key (integrator design 4.5). */
export const SANDBOX_POLICY: PolicyDocument = Object.freeze({
  schema: "kletia.policy/v1",
  label: "Sandbox",
  networks: Object.freeze({ lanes: Object.freeze(["testnet"] as const) }),
}) as unknown as PolicyDocument;

/** Lanes one rule book allows: `networks.lanes`, narrowed by the lanes of `networks.allow`. */
function lanesOf(document: PolicyDocument | null | undefined): ReadonlySet<PolicyLane> {
  let lanes = new Set<PolicyLane>(document?.networks?.lanes ?? POLICY_LANES);
  const allow = document?.networks?.allow;
  if (allow) {
    const allowed = new Set(allow.map((network) => CHAINS[network].lane as PolicyLane));
    lanes = new Set([...lanes].filter((lane) => allowed.has(lane)));
  }
  return lanes;
}

/** The lane of a chain of rule books (project, ancestors, the key): what every level allows. */
export function laneOfChain(documents: readonly (PolicyDocument | null | undefined)[]): KeyLane {
  let lanes = new Set<PolicyLane>(POLICY_LANES);
  for (const document of documents) {
    const allowed = lanesOf(document);
    lanes = new Set([...lanes].filter((lane) => allowed.has(lane)));
  }
  if (lanes.has("testnet") && lanes.has("production")) return "any";
  // A chain that allows no lane at all plans nothing; it reads as production (nothing on the testnet lane either).
  return lanes.has("testnet") ? "testnet" : "production";
}

export interface RotatedApiKey extends IssuedApiKey {
  readonly rotatedAt: string;
  /** When the previous secret stops authenticating (null: it already has). */
  readonly previousExpiresAt: string | null;
}

interface Manager {
  readonly keyId: string;
  readonly projectId: string;
  readonly kind: ApiKeyKind;
}

function notManageable(): PlatformError {
  return new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys come from server configuration and cannot be listed, rotated or revoked through the API.", 409);
}

function keyNotFound(): HttpError {
  return new HttpError(404, "KEY_NOT_FOUND", "No active API key with this id in your project.");
}

/** Refusal of a server-only operation for a publishable (browser) key. */
export function publishableForbidden(message = "Publishable keys cannot manage keys. Use a server key."): PlatformError {
  return new PlatformError("PUBLISHABLE_KEY_FORBIDDEN", message, 403);
}

/** The calling developer key, allowed to manage its project; throws for operator keys and rotated-out secrets. */
function manager(auth: AuthContext): Manager {
  if (auth.tier === "operator") throw notManageable();
  if (auth.keyKind === "publishable" || auth.tier === "publishable") throw publishableForbidden();
  if (!auth.keyId || !auth.projectId || auth.tier !== "developer") {
    throw new HttpError(401, "API_KEY_REQUIRED", "Managing keys requires a developer API key.");
  }
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Manage keys with the current secret.", 403);
  }
  return { keyId: auth.keyId, projectId: auth.projectId, kind: auth.keyKind === "agent" ? "agent" : "project" };
}

/**
 * Issues a publishable key under the calling project key (projects.ts:
 * POST /v1/projects/current/publishable-keys) with `ruleBook` as its first
 * key-level rule book. Agent keys never issue them; a failed rule book write
 * revokes the key again (it never exists without its rule book).
 */
export async function issueProjectPublishableKey(auth: AuthContext, label: string, ruleBook: PolicyDocument): Promise<IssuedPublishableKey> {
  const caller = manager(auth);
  if (caller.kind !== "project") throw agentForbidden("Only project keys issue publishable keys.");
  const now = Date.now();
  const issued = await issuePublishableKey(label, { id: caller.keyId, projectId: caller.projectId }, MAX_ACTIVE_PUBLISHABLE_KEYS_PER_PROJECT, now);
  try {
    const written = await policyStore().write({ scope: "key", subjectId: issued.id, projectId: caller.projectId, next: ruleBook, defaults: "project", createdBy: caller.keyId, ifMatch: "none", now });
    if (written.applied !== "now") throw new Error(`publishable rule book ${written.applied}`);
    await announceAmended(written.version, caller.keyId, now);
  } catch (error) {
    await apiKeyStore()
      .revokeSubtree(issued.id, caller.projectId, new Date(now).toISOString())
      .catch((revokeError: unknown) => console.error("[platform] could not revoke a publishable key whose rule book failed:", revokeError instanceof Error ? revokeError.message : revokeError));
    forgetCachedKey(issued.id);
    if (error instanceof PlatformError || error instanceof HttpError) throw error;
    throw new PlatformError("STORE_UNAVAILABLE", "The publishable key's rule book could not be written; no key was issued. Try again.", 503);
  }
  await recordKeyDecision({ projectId: caller.projectId, keyId: issued.id, actorKeyId: caller.keyId, title: `Publishable key ${label.slice(0, 64)} created`, at: now });
  // key.created's kind lists project and agent in core events.ts; publishable keys report their own kind.
  publishKeyEvent("key.created", { projectId: projectScope(caller.projectId), keyId: issued.id, kind: "publishable" as "agent", parentId: caller.keyId, expiresAt: null });
  return issued;
}

/**
 * The key `id` the caller may manage: project keys any key of the project,
 * agent keys only their descendants (never themselves). Unknown, foreign
 * and out-of-subtree keys read as not found.
 */
async function managed(caller: Manager, id: string): Promise<ApiKeyRecord> {
  const record = await apiKeyStore().findById(id);
  if (!record || record.projectId !== caller.projectId) throw keyNotFound();
  if (caller.kind === "agent" && !(record.lineage ?? []).includes(caller.keyId)) {
    if (record.id === caller.keyId) throw agentForbidden("An agent key cannot manage itself; ask its parent or a project key.");
    throw keyNotFound();
  }
  return record;
}

/** Validates a key id path parameter. */
export function keyIdParam(value: string): string {
  if (OPERATOR_KEY_ID_PATTERN.test(value)) throw notManageable();
  if (!API_KEY_ID_PATTERN.test(value)) {
    throw invalidRequest("API key ids look like key_ followed by 24 hex characters.", [{ path: "id", message: "Invalid key id." }]);
  }
  return value;
}

function view(record: ApiKeyRecord, callerId: string, now: number, extra: { readonly policyVersion: number | null; readonly descendants: number; readonly lane: KeyLane }): ApiKeyView {
  const graceOpen = record.previousExpiresAt !== null && Date.parse(record.previousExpiresAt) > now;
  return {
    id: record.id,
    name: record.name,
    tier: record.tier,
    kind: keyKindOf(record),
    parentId: record.parentId ?? null,
    depth: (record.lineage ?? []).length,
    last4: record.last4,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    rotatedAt: record.rotatedAt,
    previousExpiresAt: graceOpen ? record.previousExpiresAt : null,
    revokedAt: record.revokedAt,
    expiresAt: record.expiresAt ?? null,
    policyVersion: extra.policyVersion,
    descendants: extra.descendants,
    lane: extra.lane,
    current: record.id === callerId,
  };
}

export async function listProjectKeys(auth: AuthContext): Promise<ApiKeyView[]> {
  const caller = manager(auth);
  const now = Date.now();
  const all = await apiKeyStore().listByProject(caller.projectId);
  const visible = caller.kind === "agent"
    ? all.filter((record) => record.id === caller.keyId || (record.lineage ?? []).includes(caller.keyId))
    : all;
  const lineageIds = new Set(visible.flatMap((record) => [record.id, ...(record.lineage ?? [])]));
  const { active } = await policyStore().activeMany(
    [
      { scope: "project" as const, subjectId: caller.projectId, projectId: caller.projectId },
      ...[...lineageIds].map((id) => ({ scope: "key" as const, subjectId: id, projectId: caller.projectId })),
    ],
    now,
  );
  const projectDocument = active.get(subjectKey("project", caller.projectId))?.document ?? null;
  return visible.map((record) =>
    view(record, caller.keyId, now, {
      policyVersion: active.get(subjectKey("key", record.id))?.version ?? null,
      descendants: all.filter((candidate) => keyLive(candidate, now) && (candidate.lineage ?? []).includes(record.id)).length,
      lane: laneOfChain([projectDocument, ...[...(record.lineage ?? []), record.id].map((id) => active.get(subjectKey("key", id))?.document ?? null)]),
    }));
}

/** The lane of one key's active chain (after issuance). */
async function laneOfKey(keyId: string, projectId: string, now: number): Promise<KeyLane> {
  const { active } = await policyStore().activeMany(
    [
      { scope: "project", subjectId: projectId, projectId },
      { scope: "key", subjectId: keyId, projectId },
    ],
    now,
  );
  return laneOfChain([active.get(subjectKey("project", projectId))?.document ?? null, active.get(subjectKey("key", keyId))?.document ?? null]);
}

/** Writes the sandbox rule book of a just-issued key; on failure revokes the key so it never exists unrestricted. */
async function restrictToSandbox(issued: IssuedApiKey, projectId: string, createdBy: string, now: number): Promise<void> {
  try {
    const written = await policyStore().write({ scope: "key", subjectId: issued.id, projectId, next: SANDBOX_POLICY, defaults: "project", createdBy, ifMatch: "none", now });
    if (written.applied !== "now") throw new Error(`sandbox rule book ${written.applied}`);
    await announceAmended(written.version, createdBy, now);
  } catch (error) {
    await apiKeyStore()
      .revokeSubtree(issued.id, projectId, new Date(now).toISOString())
      .catch((revokeError: unknown) => console.error("[platform] could not revoke a sandbox key whose rule book failed:", revokeError instanceof Error ? revokeError.message : revokeError));
    forgetCachedKey(issued.id);
    if (error instanceof PlatformError || error instanceof HttpError) throw error;
    throw new PlatformError("STORE_UNAVAILABLE", "The sandbox rule book could not be written; no key was issued. Try again.", 503);
  }
}

/**
 * POST /v1/keys: a new project without a key (or with an operator key), a
 * sibling with a developer key; `sandbox` keeps the key on the testnet lane.
 */
export async function issueKey(auth: AuthContext, name: string, options: { readonly sandbox?: boolean } = {}): Promise<IssuedProjectKey> {
  const now = Date.now();
  // A publishable key is never a stepping stone to a server key (and never starts a project of its own).
  if (auth.keyKind === "publishable" || auth.tier === "publishable") throw publishableForbidden("Publishable keys cannot issue API keys. Use a server key.");
  if (auth.tier !== "developer") {
    const issued = await issueDeveloperKey(name);
    // A new project: the key is its own project and writes its own first rule book.
    if (options.sandbox) await restrictToSandbox(issued, issued.id, issued.id, now);
    return { ...issued, lane: options.sandbox ? "testnet" : await laneOfKey(issued.id, issued.id, now) };
  }
  const caller = manager(auth);
  if (caller.kind === "agent") throw agentForbidden("Agent keys never issue project keys. Create a child with POST /v1/keys/{id}/children if your rule book grants permissions.createChildKeys.");
  const issued = await issueDeveloperKey(name, { id: caller.projectId, maxActive: MAX_ACTIVE_KEYS_PER_PROJECT });
  if (options.sandbox) await restrictToSandbox(issued, caller.projectId, caller.keyId, now);
  publishKeyEvent("key.created", { projectId: projectScope(caller.projectId), keyId: issued.id, kind: "project", parentId: null, expiresAt: null });
  return { ...issued, lane: await laneOfKey(issued.id, caller.projectId, now) };
}

export function parseRotateRequest(body: unknown): { graceSeconds: number } {
  if (body === undefined || body === null) return { graceSeconds: DEFAULT_ROTATION_GRACE_SECONDS };
  if (!isRecord(body)) throw invalidRequest("Body must be { \"graceSeconds\"?: 0-604800 }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => key !== "graceSeconds");
  if (unknown.length > 0) {
    throw invalidRequest("Only graceSeconds is accepted.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  }
  const grace = body.graceSeconds;
  if (grace === undefined) return { graceSeconds: DEFAULT_ROTATION_GRACE_SECONDS };
  if (typeof grace !== "number" || !Number.isInteger(grace) || grace < 0 || grace > MAX_ROTATION_GRACE_SECONDS) {
    throw invalidRequest(`graceSeconds must be an integer between 0 and ${MAX_ROTATION_GRACE_SECONDS}.`, [
      { path: "graceSeconds", message: `Expected 0-${MAX_ROTATION_GRACE_SECONDS}.` },
    ]);
  }
  return { graceSeconds: grace };
}

export async function rotateKey(auth: AuthContext, id: string, graceSeconds: number): Promise<RotatedApiKey> {
  const caller = manager(auth);
  const target = caller.kind === "agent" ? await managed(caller, id) : await apiKeyStore().findById(id);
  // Agent keys keep their recognisable prefix across rotations.
  const secret = newSecretFor(target ?? { kind: "project" });
  const now = Date.now();
  const rotatedAt = new Date(now).toISOString();
  const previousExpiresAt = graceSeconds > 0 ? new Date(now + graceSeconds * 1000).toISOString() : null;
  const record = await apiKeyStore().rotate(id, caller.projectId, secret.hash, secret.last4, rotatedAt, previousExpiresAt);
  forgetCachedKey(id);
  if (!record) throw keyNotFound();
  return {
    id: record.id,
    name: record.name,
    tier: record.tier,
    createdAt: record.createdAt,
    key: secret.key,
    rotatedAt,
    previousExpiresAt,
  };
}

async function deleteWebhooksOf(keyIds: readonly string[]): Promise<void> {
  for (const keyId of keyIds) {
    for (const webhookId of await deleteWebhooksOfKey(keyId)) {
      // The delivery log goes with the webhook (best effort; it is pruned after 7 days regardless).
      await deliveryStore()
        .deleteForWebhook(webhookId)
        .catch((error: unknown) => console.warn("[platform] webhook delivery log cleanup failed:", error instanceof Error ? error.message : error));
    }
  }
}

/** DELETE /v1/keys/{id}: the key and its whole subtree. */
export async function revokeKey(auth: AuthContext, id: string): Promise<void> {
  const caller = manager(auth);
  if (caller.kind === "agent") await managed(caller, id);
  const now = Date.now();
  const { outcome, cascade } = await apiKeyStore().revokeSubtree(id, caller.projectId, new Date(now).toISOString());
  for (const revoked of [id, ...cascade]) forgetCachedKey(revoked);
  if (outcome === "missing") throw keyNotFound();
  // Also on "already_revoked": a repeated revoke finishes a cleanup that failed (the error makes the client retry).
  const descendants = (await apiKeyStore().listByProject(caller.projectId)).filter((record) => (record.lineage ?? []).includes(id)).map((record) => record.id);
  await deleteWebhooksOf([...new Set([id, ...cascade, ...descendants])]);
  if (cascade.length > 0) {
    await recordKeyDecision({ projectId: caller.projectId, keyId: id, actorKeyId: caller.keyId, title: `Key ${id} revoked (${cascade.length} key(s) with its subtree)`, at: now });
    publishKeyEvent("key.revoked", { projectId: projectScope(caller.projectId), keyId: id, cascade: [...cascade] });
  }
}

/* ------------------------------------------------------------ agent keys */

export interface ChildKeyRequest {
  readonly name: string;
  readonly expiresInSeconds: number;
  readonly policy: PolicyDocument;
  readonly warnings: readonly PolicyWarning[];
}

const TEMPLATE_FILLS = ["accounts", "recipients", "approverWallets", "contracts"] as const;

function stringList(value: unknown, path: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string" || entry.length > 200)) {
    throw invalidRequest(`${path} must be a list of at most ${max} strings.`, [{ path, message: "Invalid list." }]);
  }
  return value as string[];
}

/** POST /v1/keys/{id}/children body: `{ name, expiresInSeconds?, policy? | template? + fill? }`. */
export function parseChildKeyRequest(body: unknown): ChildKeyRequest {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"name\", \"expiresInSeconds\"?, \"policy\"? | \"template\"? }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => !["name", "expiresInSeconds", "policy", "template", "fill"].includes(key));
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw invalidRequest("Provide name with 1-64 printable characters.", [{ path: "name", message: "Required, 1-64 printable characters." }]);
  }
  const ttl = body.expiresInSeconds ?? POLICY_LIMITS.agentDefaultTtlSeconds;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < POLICY_LIMITS.agentMinTtlSeconds || ttl > POLICY_LIMITS.agentMaxTtlSeconds) {
    throw invalidRequest(`expiresInSeconds must be an integer between ${POLICY_LIMITS.agentMinTtlSeconds} and ${POLICY_LIMITS.agentMaxTtlSeconds}.`, [
      { path: "expiresInSeconds", message: `Expected ${POLICY_LIMITS.agentMinTtlSeconds}-${POLICY_LIMITS.agentMaxTtlSeconds}.` },
    ]);
  }
  if (body.policy !== undefined && body.template !== undefined) {
    throw invalidRequest("Send policy or template, not both.", [{ path: "template", message: "Conflicts with policy." }]);
  }
  let result;
  if (body.template !== undefined) {
    if (typeof body.template !== "string" || !Object.hasOwn(POLICY_TEMPLATES, body.template)) {
      throw invalidRequest(`template must be one of ${Object.keys(POLICY_TEMPLATES).join(", ")}.`, [{ path: "template", message: "Unknown template." }]);
    }
    const fillInput = body.fill === undefined ? {} : body.fill;
    if (!isRecord(fillInput) || Object.keys(fillInput).some((key) => !(TEMPLATE_FILLS as readonly string[]).includes(key))) {
      throw invalidRequest(`fill accepts ${TEMPLATE_FILLS.join(", ")}.`, [{ path: "fill", message: "Invalid fill." }]);
    }
    const fill = {
      ...(fillInput.accounts !== undefined ? { accounts: stringList(fillInput.accounts, "fill.accounts", POLICY_LIMITS.accounts) } : {}),
      ...(fillInput.recipients !== undefined ? { recipients: stringList(fillInput.recipients, "fill.recipients", POLICY_LIMITS.recipients) } : {}),
      ...(fillInput.approverWallets !== undefined ? { approverWallets: stringList(fillInput.approverWallets, "fill.approverWallets", POLICY_LIMITS.approverWallets) } : {}),
      ...(fillInput.contracts !== undefined
        ? {
            contracts: (Array.isArray(fillInput.contracts) ? fillInput.contracts : []).slice(0, POLICY_LIMITS.contracts).map((entry) =>
              isRecord(entry) && typeof entry.id === "string"
                ? { id: entry.id, ...(Array.isArray(entry.entries) ? { entries: entry.entries.filter((name): name is string => typeof name === "string") } : {}) }
                : { id: "" }),
          }
        : {}),
    };
    result = policyFromTemplate(body.template as PolicyTemplateId, fill);
  } else {
    result = validatePolicy(body.policy ?? POLICY_TEMPLATES.observer.document, { defaults: "agent" });
  }
  if (!result.ok) {
    throw new PlatformError("POLICY_INVALID", body.template !== undefined
      ? `The ${String(body.template)} template needs ${POLICY_TEMPLATES[body.template as PolicyTemplateId].fill.join(", ") || "no"} fill values; fix the fields listed in issues.`
      : "The rule book is invalid; fix the fields listed in issues.", 400, result.issues.map((issue) => ({ path: issue.path, message: issue.message })));
  }
  return { name, expiresInSeconds: ttl, policy: result.value, warnings: result.warnings };
}

export interface CreatedChildKey {
  readonly key: IssuedAgentKey & { readonly depth: number };
  readonly policy: { readonly scope: "key"; readonly keyId: string; readonly version: number; readonly hash: string | null; readonly status: string; readonly warnings: readonly PolicyWarning[] };
}

/** POST /v1/keys/{parentId}/children. */
export async function createChildKey(auth: AuthContext, parentId: string, request: ChildKeyRequest): Promise<CreatedChildKey> {
  const caller = manager(auth);
  const now = Date.now();
  if (caller.kind === "agent") {
    await assertAgentPermission(auth, "createChildKeys");
    if (parentId !== caller.keyId) await managed(caller, parentId);
  }
  const parent = await apiKeyStore().findById(parentId);
  if (!parent || parent.projectId !== caller.projectId) throw keyNotFound();
  if (keyKindOf(parent) === "publishable") throw publishableForbidden("Agent keys are never created under a publishable key; use a project key as the parent.");
  const parentChain = await readKeyChain(parentId, now);
  if (!parentChain || !parentChain.keyActive) throw keyNotFound();
  const depth = (parent.lineage ?? []).length + 1;
  if (depth > MAX_AGENT_DEPTH) {
    throw new PlatformError("KEY_DEPTH_EXCEEDED", `Agent keys sit at most ${MAX_AGENT_DEPTH} levels below a project key; ${parentId} is already at depth ${depth - 1}.`, 409);
  }
  const expires = now + request.expiresInSeconds * 1000;
  if (parent.expiresAt && Date.parse(parent.expiresAt) < expires) {
    throw invalidRequest(`An agent key cannot outlive its parent (${parent.expiresAt}); ask for at most ${Math.floor((Date.parse(parent.expiresAt) - now) / 1000)} seconds.`, [
      { path: "expiresInSeconds", message: "Later than the parent's expiry." },
    ]);
  }
  const issued = await issueAgentKey(request.name, parent, new Date(expires).toISOString(), MAX_ACTIVE_AGENT_KEYS_PER_PROJECT, now);
  // Version 1 of the agent's rule book (active at once: it is the first). A failure leaves the observer default.
  const written = await policyStore().write({
    scope: "key",
    subjectId: issued.id,
    projectId: caller.projectId,
    next: request.policy,
    defaults: "agent",
    createdBy: caller.keyId,
    now,
  });
  if (written.applied === "now") await announceAmended(written.version, caller.keyId, now);
  await recordKeyDecision({ projectId: caller.projectId, keyId: issued.id, actorKeyId: caller.keyId, title: `Agent key ${request.name.slice(0, 64)} created under ${parentId}`, at: now });
  publishKeyEvent("key.created", { projectId: projectScope(caller.projectId), keyId: issued.id, kind: "agent", parentId, expiresAt: issued.expiresAt });
  return {
    key: issued,
    policy: { scope: "key", keyId: issued.id, version: written.version.version, hash: written.version.hash, status: written.version.status, warnings: request.warnings },
  };
}

/** PATCH /v1/keys/{id} body: `{ expiresAt }` (ISO time or null for project keys). */
export function parseKeyPatch(body: unknown): { readonly expiresAt: string | null } {
  if (!isRecord(body) || !("expiresAt" in body) || Object.keys(body).length !== 1) {
    throw invalidRequest("Body must be { \"expiresAt\": \"<ISO time>\" | null }.", [{ path: "expiresAt", message: "Required, the only field." }]);
  }
  if (body.expiresAt === null) return { expiresAt: null };
  if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) {
    throw invalidRequest("expiresAt must be an ISO time or null.", [{ path: "expiresAt", message: "Invalid time." }]);
  }
  return { expiresAt: new Date(Date.parse(body.expiresAt)).toISOString() };
}

/** PATCH /v1/keys/{id}: shorten at once; extend only without an amendment delay (a loosening). */
export async function patchKey(auth: AuthContext, id: string, patch: { readonly expiresAt: string | null }): Promise<ApiKeyView> {
  const caller = manager(auth);
  const target = await managed(caller, id);
  const now = Date.now();
  if (!keyLive(target, now)) throw keyNotFound();
  const agent = keyKindOf(target) === "agent";
  const next = patch.expiresAt;
  if (agent && next === null) throw invalidRequest("Agent keys always expire.", [{ path: "expiresAt", message: "Required for agent keys." }]);
  if (next !== null) {
    const at = Date.parse(next);
    if (at <= now) throw invalidRequest("expiresAt must be in the future; revoke the key to stop it now.", [{ path: "expiresAt", message: "In the past." }]);
    if (agent && at > now + POLICY_LIMITS.agentMaxTtlSeconds * 1000) throw invalidRequest("Agent keys expire within 365 days.", [{ path: "expiresAt", message: "Too far ahead." }]);
    const parent = target.parentId ? await apiKeyStore().findById(target.parentId) : null;
    if (parent?.expiresAt && Date.parse(parent.expiresAt) < at) throw invalidRequest("A key cannot outlive its parent.", [{ path: "expiresAt", message: `Later than ${parent.expiresAt}.` }]);
  }
  const current = target.expiresAt ? Date.parse(target.expiresAt) : Number.POSITIVE_INFINITY;
  const wanted = next === null ? Number.POSITIVE_INFINITY : Date.parse(next);
  if (wanted > current) {
    // Extending is a loosening (§8.2): only at once when the key's rule book has no amendment delay.
    const heads = await policyStore().heads("key", id, now);
    const delay = heads.active?.document?.amendments?.delaySeconds ?? 0;
    if (delay > 0) {
      throw invalidRequest(`Extending this key's expiry is a loosening and its rule book delays loosening by ${delay} s; create a new key instead.`, [
        { path: "expiresAt", message: "Later than the current expiry." },
      ]);
    }
  }
  const updated = await apiKeyStore().setExpiry(id, caller.projectId, next);
  forgetCachedKey(id);
  if (!updated) throw keyNotFound();
  const { active } = await policyStore().activeMany([{ scope: "key", subjectId: id, projectId: caller.projectId }], now);
  const all = await apiKeyStore().listByProject(caller.projectId);
  const chain = await readKeyChain(id, now);
  return view(updated, caller.keyId, now, {
    policyVersion: active.get(subjectKey("key", id))?.version ?? null,
    descendants: all.filter((candidate) => keyLive(candidate, now) && (candidate.lineage ?? []).includes(id)).length,
    lane: laneOfChain((chain?.levels ?? []).map((level) => level.policy as PolicyDocument | null)),
  });
}
