/**
 * Projects owned by a signed-in wallet, and their keys.
 *
 * - A project becomes the wallet's when the wallet creates it (POST
 *   /v1/accounts/projects: a new project and its first key) or claims it
 *   (POST /v1/accounts/projects/claim with a project key of the project in
 *   `X-Kletia-Key` or `Authorization`, its current secret, not an agent or
 *   publishable key). A project has one owner for good: a claim of a project
 *   another wallet owns is 409 PROJECT_ALREADY_OWNED. A wallet owns at most
 *   20 projects.
 * - The owner lists the project's keys, issues project keys (also when every
 *   key was lost or revoked: that is how access comes back), rotates any key
 *   of the project (new secret, same id; the previous secret works during the
 *   grace window) and revokes any key with its subtree. These are the same
 *   store operations, limits, events and cleanups as the key routes in
 *   keys.ts; the actor is the wallet instead of a key.
 * - Projects the wallet does not own read as 404 PROJECT_NOT_FOUND, like
 *   projects that do not exist.
 */
import {
  ACCOUNT_LIMITS,
  accountProjectRawId,
  type AccountActivityView,
  type AccountKeyView,
  type AccountProjectView,
} from "@kletia/core";
import type { Request } from "express";
import { PlatformError } from "../../errors.js";
import { apiKeyStore, forgetCachedKey, issueDeveloperKey, keyKindOf, keyLive, newSecretFor, type ApiKeyRecord, type IssuedApiKey } from "../auth.js";
import { authOf, HttpError, invalidRequest, isRecord } from "../context.js";
import { deliveryStore } from "../deliveries.js";
import {
  keyIdParam,
  laneOfChain,
  MAX_ACTIVE_KEYS_PER_PROJECT,
  publishableForbidden,
  SANDBOX_POLICY,
  type KeyLane,
  type RotatedApiKey,
} from "../keys.js";
import { KeyWindowLimiter } from "../limits.js";
import { publishKeyEvent, recordKeyDecision, announceAmended } from "../policies/announce.js";
import { policyStore, projectScope, subjectKey } from "../policies/store.js";
import { projectStore } from "../projects.js";
import { deleteWebhooksOfKey } from "../webhooks.js";
import { accountNow, accountSessionOf, audit, auditFailure, displayWallet, type AccountSessionContext } from "./auth.js";
import { accountStore, projectLimitReached, type ProjectOwnerRecord } from "./store.js";

/** New projects per hour of one wallet (on top of the per-wallet project cap). */
export const projectCreations = new KeyWindowLimiter(ACCOUNT_LIMITS.projectsPerHourPerWallet, 60 * 60_000, "new projects per hour", 20_000, " per wallet");

export interface AccountIssuedKey extends IssuedApiKey {
  readonly lane: KeyLane;
}

function projectNotFound(): HttpError {
  return new HttpError(404, "PROJECT_NOT_FOUND", "No project with this id is owned by the signed-in wallet.");
}

function keyNotFound(): HttpError {
  return new HttpError(404, "KEY_NOT_FOUND", "No API key with this id in this project.");
}

function walletLabel(session: AccountSessionContext): string {
  return displayWallet(session.wallet.walletKind, session.wallet.address);
}

/** `prj_key_…` path parameter → the raw project id the wallet owns, else 404 (400 when malformed). */
export async function ownedProjectId(session: AccountSessionContext, param: string): Promise<string> {
  const raw = accountProjectRawId(param);
  if (!raw) throw invalidRequest("Project ids look like prj_key_ followed by 24 hex characters.", [{ path: "projectId", message: "Invalid project id." }]);
  const owner = await accountStore().ownerOf(raw);
  if (!owner || owner.walletKind !== session.wallet.walletKind || owner.address !== session.wallet.address) throw projectNotFound();
  return raw;
}

/* ------------------------------------------------------------ bodies */

/** `{ name, sandbox? }` (same rules as POST /v1/keys). */
export function parseNamedKeyRequest(body: unknown): { readonly name: string; readonly sandbox: boolean } {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"name\", \"sandbox\"? }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => key !== "name" && key !== "sandbox");
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw invalidRequest("Provide { \"name\": \"…\", \"sandbox\"?: true } with a name of 1-64 printable characters.", [
      { path: "name", message: "Expected 1-64 printable characters." },
    ]);
  }
  if (body.sandbox !== undefined && typeof body.sandbox !== "boolean") {
    throw invalidRequest("sandbox must be true or false.", [{ path: "sandbox", message: "Expected a boolean." }]);
  }
  return { name, sandbox: body.sandbox === true };
}

/* ------------------------------------------------------------ views */

function keyView(record: ApiKeyRecord, now: number): AccountKeyView {
  const graceOpen = record.previousExpiresAt !== null && Date.parse(record.previousExpiresAt) > now;
  return {
    id: record.id,
    name: record.name,
    kind: keyKindOf(record),
    parentId: record.parentId ?? null,
    last4: record.last4,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    rotatedAt: record.rotatedAt,
    previousExpiresAt: graceOpen ? record.previousExpiresAt : null,
    revokedAt: record.revokedAt,
    expiresAt: record.expiresAt ?? null,
  };
}

async function projectView(owner: ProjectOwnerRecord, now: number): Promise<AccountProjectView> {
  const [keys, settings] = await Promise.all([apiKeyStore().listByProject(owner.projectId), projectStore().get(owner.projectId)]);
  const live = keys.filter((record) => keyLive(record, now));
  return {
    id: projectScope(owner.projectId),
    name: settings?.settings.brand?.name ?? null,
    source: owner.source,
    ownedSince: owner.createdAt,
    activeKeys: live.filter((record) => keyKindOf(record) === "project").length,
    activeChildKeys: live.filter((record) => keyKindOf(record) !== "project").length,
  };
}

export async function listOwnedProjects(req: Request): Promise<AccountProjectView[]> {
  const session = accountSessionOf(req);
  const owners = await accountStore().projectsOf(session.wallet.walletKind, session.wallet.address);
  const now = accountNow().getTime();
  return Promise.all(owners.map((owner) => projectView(owner, now)));
}

export async function listActivity(req: Request): Promise<AccountActivityView[]> {
  const session = accountSessionOf(req);
  return accountStore().listAudit(session.wallet.walletKind, session.wallet.address, ACCOUNT_LIMITS.activityRows);
}

/* ------------------------------------------------------------ keys */

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

/** Revokes a just-issued key again (its rule book or ownership could not be written). */
async function undoIssued(issued: IssuedApiKey, projectId: string, now: number, what: string): Promise<void> {
  await apiKeyStore()
    .revokeSubtree(issued.id, projectId, new Date(now).toISOString())
    .catch((error: unknown) => console.error(`[platform] could not revoke a key whose ${what} failed:`, error instanceof Error ? error.message : error));
  forgetCachedKey(issued.id);
}

/** The sandbox rule book of a just-issued key, as POST /v1/keys writes it; on failure the key is revoked again. */
async function restrictToSandbox(issued: IssuedApiKey, projectId: string, now: number): Promise<void> {
  try {
    const written = await policyStore().write({ scope: "key", subjectId: issued.id, projectId, next: SANDBOX_POLICY, defaults: "project", createdBy: issued.id, ifMatch: "none", now });
    if (written.applied !== "now") throw new Error(`sandbox rule book ${written.applied}`);
    await announceAmended(written.version, issued.id, now);
  } catch (error) {
    await undoIssued(issued, projectId, now, "sandbox rule book");
    if (error instanceof PlatformError || error instanceof HttpError) throw error;
    throw new PlatformError("STORE_UNAVAILABLE", "The sandbox rule book could not be written; no key was issued. Try again.", 503);
  }
}

/** POST /v1/accounts/projects: a new project, owned by the wallet, with its first project key. */
export async function createOwnedProject(req: Request, body: unknown): Promise<{ readonly project: AccountProjectView; readonly key: AccountIssuedKey }> {
  const session = accountSessionOf(req);
  const { name, sandbox } = parseNamedKeyRequest(body);
  const store = accountStore();
  const owned = await store.projectsOf(session.wallet.walletKind, session.wallet.address);
  if (owned.length >= ACCOUNT_LIMITS.projectsPerWallet) throw projectLimitReached(ACCOUNT_LIMITS.projectsPerWallet);
  projectCreations.take(`${session.wallet.walletKind}:${session.wallet.address}`);
  const entry = { wallet: session.wallet, action: "account.project.create" as const, target: { name: name.slice(0, 64), sandbox: String(sandbox) } };
  await audit(req, { ...entry, outcome: "ok" });
  const now = accountNow().getTime();
  let issued: IssuedApiKey;
  try {
    issued = await issueDeveloperKey(name);
  } catch (error) {
    await auditFailure(req, entry);
    throw error;
  }
  const record: ProjectOwnerRecord = {
    projectId: issued.id,
    walletKind: session.wallet.walletKind,
    address: session.wallet.address,
    source: "created",
    createdAt: new Date(now).toISOString(),
  };
  try {
    const claimed = await store.claimProject(record, ACCOUNT_LIMITS.projectsPerWallet);
    if (!claimed.inserted) throw new PlatformError("STORE_UNAVAILABLE", "The new project could not be recorded; no key was issued. Try again.", 503);
  } catch (error) {
    await undoIssued(issued, issued.id, now, "ownership");
    await auditFailure(req, { ...entry, projectId: issued.id });
    throw error;
  }
  if (sandbox) {
    try {
      await restrictToSandbox(issued, issued.id, now);
    } catch (error) {
      await store.releaseProject(issued.id, session.wallet.walletKind, session.wallet.address).catch(() => undefined);
      await auditFailure(req, { ...entry, projectId: issued.id });
      throw error;
    }
  }
  await recordKeyDecision({ projectId: issued.id, keyId: issued.id, actorKeyId: null, title: `Project created by wallet ${walletLabel(session)}`, at: now });
  return {
    project: await projectView(record, now),
    key: { ...issued, lane: sandbox ? "testnet" : await laneOfKey(issued.id, issued.id, now) },
  };
}

/** POST /v1/accounts/projects/claim: links the project of the presented project key to the wallet. */
export async function claimOwnedProject(req: Request): Promise<{ readonly project: AccountProjectView; readonly claimed: boolean }> {
  const session = accountSessionOf(req);
  const auth = authOf(req);
  if (auth.tier === "operator") throw new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys belong to no project. Claim with a project key (kl_dev_).", 409);
  if (auth.keyKind === "publishable" || auth.tier === "publishable") throw publishableForbidden("Publishable keys cannot claim a project. Use a project key (kl_dev_).");
  if (auth.keyKind === "agent") throw new PlatformError("AGENT_KEY_FORBIDDEN", "Agent keys cannot claim a project. Use a project key (kl_dev_).", 403);
  if (auth.tier !== "developer" || !auth.keyId || !auth.projectId) {
    throw new HttpError(401, "API_KEY_REQUIRED", "Send a project key (kl_dev_) of the project in X-Kletia-Key to claim it.");
  }
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Claim with the current secret.", 403);
  }
  const projectId = auth.projectId;
  const store = accountStore();
  const current = await store.ownerOf(projectId);
  if (current) {
    if (current.walletKind === session.wallet.walletKind && current.address === session.wallet.address) {
      return { project: await projectView(current, accountNow().getTime()), claimed: false };
    }
    await audit(req, { wallet: session.wallet, action: "account.project.claim", outcome: "denied", projectId, keyId: auth.keyId, target: { reason: "owned" } });
    throw new PlatformError("PROJECT_ALREADY_OWNED", "Another wallet owns this project. Its owner manages its keys.", 409);
  }
  const entry = { wallet: session.wallet, action: "account.project.claim" as const, projectId, keyId: auth.keyId };
  await audit(req, { ...entry, outcome: "ok" });
  const now = accountNow().getTime();
  let result;
  try {
    result = await store.claimProject(
      { projectId, walletKind: session.wallet.walletKind, address: session.wallet.address, source: "claimed", createdAt: new Date(now).toISOString() },
      ACCOUNT_LIMITS.projectsPerWallet,
    );
  } catch (error) {
    await auditFailure(req, entry);
    throw error;
  }
  const mine = result.owner.walletKind === session.wallet.walletKind && result.owner.address === session.wallet.address;
  if (!mine) {
    // Another wallet won a concurrent claim.
    await auditFailure(req, entry);
    throw new PlatformError("PROJECT_ALREADY_OWNED", "Another wallet owns this project. Its owner manages its keys.", 409);
  }
  if (result.inserted) await recordKeyDecision({ projectId, keyId: auth.keyId, actorKeyId: auth.keyId, title: `Project claimed by wallet ${walletLabel(session)}`, at: now });
  return { project: await projectView(result.owner, now), claimed: result.inserted };
}

export async function listOwnedKeys(req: Request, projectParam: string): Promise<AccountKeyView[]> {
  const session = accountSessionOf(req);
  const projectId = await ownedProjectId(session, projectParam);
  const now = accountNow().getTime();
  return (await apiKeyStore().listByProject(projectId)).map((record) => keyView(record, now));
}

/** POST /v1/accounts/projects/{projectId}/keys: a project key in an owned project (at most 5 active). */
export async function issueOwnedKey(req: Request, projectParam: string, body: unknown): Promise<AccountIssuedKey> {
  const session = accountSessionOf(req);
  const projectId = await ownedProjectId(session, projectParam);
  const { name, sandbox } = parseNamedKeyRequest(body);
  const entry = { wallet: session.wallet, action: "account.key.issue" as const, projectId, target: { name: name.slice(0, 64), sandbox: String(sandbox) } };
  await audit(req, { ...entry, outcome: "ok" });
  const now = accountNow().getTime();
  let issued: IssuedApiKey;
  try {
    issued = await issueDeveloperKey(name, { id: projectId, maxActive: MAX_ACTIVE_KEYS_PER_PROJECT });
    if (sandbox) await restrictToSandbox(issued, projectId, now);
  } catch (error) {
    await auditFailure(req, entry);
    throw error;
  }
  publishKeyEvent("key.created", { projectId: projectScope(projectId), keyId: issued.id, kind: "project", parentId: null, expiresAt: null });
  await recordKeyDecision({ projectId, keyId: issued.id, actorKeyId: null, title: `Key ${name.slice(0, 64)} issued by the owner wallet ${walletLabel(session)}`, at: now });
  return { ...issued, lane: sandbox ? "testnet" : await laneOfKey(issued.id, projectId, now) };
}

/** A key of the project by its id path parameter (any kind, revoked included), else 404 KEY_NOT_FOUND. */
async function keyOfProject(projectId: string, keyParam: string): Promise<ApiKeyRecord> {
  const id = keyIdParam(keyParam);
  const record = await apiKeyStore().findById(id);
  if (!record || record.projectId !== projectId) throw keyNotFound();
  return record;
}

export async function rotateOwnedKey(req: Request, projectParam: string, keyParam: string, graceSeconds: number): Promise<RotatedApiKey> {
  const session = accountSessionOf(req);
  const projectId = await ownedProjectId(session, projectParam);
  const target = await keyOfProject(projectId, keyParam);
  if (!keyLive(target, accountNow().getTime())) throw keyNotFound();
  const entry = { wallet: session.wallet, action: "account.key.rotate" as const, projectId, keyId: target.id, target: { graceSeconds: String(graceSeconds) } };
  await audit(req, { ...entry, outcome: "ok" });
  const secret = newSecretFor(target);
  const now = accountNow().getTime();
  const rotatedAt = new Date(now).toISOString();
  const previousExpiresAt = graceSeconds > 0 ? new Date(now + graceSeconds * 1000).toISOString() : null;
  let record: ApiKeyRecord | null;
  try {
    record = await apiKeyStore().rotate(target.id, projectId, secret.hash, secret.last4, rotatedAt, previousExpiresAt);
  } catch (error) {
    await auditFailure(req, entry);
    throw error;
  } finally {
    forgetCachedKey(target.id);
  }
  if (!record) {
    await auditFailure(req, entry);
    throw keyNotFound();
  }
  return { id: record.id, name: record.name, tier: record.tier, createdAt: record.createdAt, key: secret.key, rotatedAt, previousExpiresAt };
}

export async function revokeOwnedKey(req: Request, projectParam: string, keyParam: string): Promise<void> {
  const session = accountSessionOf(req);
  const projectId = await ownedProjectId(session, projectParam);
  const target = await keyOfProject(projectId, keyParam);
  const entry = { wallet: session.wallet, action: "account.key.revoke" as const, projectId, keyId: target.id };
  await audit(req, { ...entry, outcome: "ok" });
  const now = accountNow().getTime();
  let cascade: readonly string[];
  try {
    const result = await apiKeyStore().revokeSubtree(target.id, projectId, new Date(now).toISOString());
    cascade = result.cascade;
    for (const revoked of [target.id, ...cascade]) forgetCachedKey(revoked);
    if (result.outcome === "missing") throw keyNotFound();
    // Also on "already_revoked": a repeated revoke finishes a cleanup that failed.
    const descendants = (await apiKeyStore().listByProject(projectId)).filter((record) => (record.lineage ?? []).includes(target.id)).map((record) => record.id);
    for (const keyId of new Set([target.id, ...cascade, ...descendants])) {
      for (const webhookId of await deleteWebhooksOfKey(keyId)) {
        await deliveryStore()
          .deleteForWebhook(webhookId)
          .catch((error: unknown) => console.warn("[platform] webhook delivery log cleanup failed:", error instanceof Error ? error.message : error));
      }
    }
  } catch (error) {
    await auditFailure(req, entry);
    throw error;
  }
  if (cascade.length > 0) {
    await recordKeyDecision({ projectId, keyId: target.id, actorKeyId: null, title: `Key ${target.id} revoked by the owner wallet (${cascade.length} key(s) with its subtree)`, at: now });
    publishKeyEvent("key.revoked", { projectId: projectScope(projectId), keyId: target.id, cascade: [...cascade] });
  }
}
