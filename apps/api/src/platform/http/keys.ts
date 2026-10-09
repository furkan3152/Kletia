/**
 * API key self-management: list, issue siblings, rotate and revoke the keys
 * of the caller's project.
 *
 * - GET /v1/keys: the project's keys (never secrets; `last4` only).
 * - POST /v1/keys with a developer key: a sibling key in the same project
 *   (at most 5 active keys per project).
 * - POST /v1/keys/{id}/rotate: new secret, same id. The previous secret keeps
 *   authenticating for `graceSeconds` (default 24 h, 0 = revoke it now), but
 *   only the newest previous secret: rotating again ends the earlier grace.
 * - DELETE /v1/keys/{id}: revoke (idempotent).
 *
 * Operator keys (configuration) are immutable: 409 KEY_NOT_MANAGEABLE. A
 * secret inside its grace window authenticates but cannot manage keys (403
 * KEY_SECRET_ROTATED), so a leaked secret cannot take a rotated key over.
 */
import { PlatformError } from "../errors.js";
import {
  apiKeyStore,
  forgetCachedKey,
  issueDeveloperKey,
  newDeveloperSecret,
  type ApiKeyRecord,
  type IssuedApiKey,
  type KeyTier,
} from "./auth.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "./context.js";

export const MAX_ACTIVE_KEYS_PER_PROJECT = 5;
export const DEFAULT_ROTATION_GRACE_SECONDS = 86_400;
export const MAX_ROTATION_GRACE_SECONDS = 604_800;
export const API_KEY_ID_PATTERN = /^key_[0-9a-f]{24}$/u;
const OPERATOR_KEY_ID_PATTERN = /^op_[0-9a-f]{16}$/u;

/** API representation of a stored key. */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly last4: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly previousExpiresAt: string | null;
  readonly revokedAt: string | null;
  /** True for the key that made this request. */
  readonly current: boolean;
}

export interface RotatedApiKey extends IssuedApiKey {
  readonly rotatedAt: string;
  /** When the previous secret stops authenticating (null: it already has). */
  readonly previousExpiresAt: string | null;
}

interface Manager {
  readonly keyId: string;
  readonly projectId: string;
}

function notManageable(): PlatformError {
  return new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys come from server configuration and cannot be listed, rotated or revoked through the API.", 409);
}

function keyNotFound(): HttpError {
  return new HttpError(404, "KEY_NOT_FOUND", "No active API key with this id in your project.");
}

/** The calling developer key, allowed to manage its project; throws for operator keys and rotated-out secrets. */
function manager(auth: AuthContext): Manager {
  if (auth.tier === "operator") throw notManageable();
  if (!auth.keyId || !auth.projectId || auth.tier !== "developer") {
    throw new HttpError(401, "API_KEY_REQUIRED", "Managing keys requires a developer API key.");
  }
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Manage keys with the current secret.", 403);
  }
  return { keyId: auth.keyId, projectId: auth.projectId };
}

/** Validates a key id path parameter. */
export function keyIdParam(value: string): string {
  if (OPERATOR_KEY_ID_PATTERN.test(value)) throw notManageable();
  if (!API_KEY_ID_PATTERN.test(value)) {
    throw invalidRequest("API key ids look like key_ followed by 24 hex characters.", [{ path: "id", message: "Invalid key id." }]);
  }
  return value;
}

function view(record: ApiKeyRecord, callerId: string, now: number): ApiKeyView {
  const graceOpen = record.previousExpiresAt !== null && Date.parse(record.previousExpiresAt) > now;
  return {
    id: record.id,
    name: record.name,
    tier: record.tier,
    last4: record.last4,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    rotatedAt: record.rotatedAt,
    previousExpiresAt: graceOpen ? record.previousExpiresAt : null,
    revokedAt: record.revokedAt,
    current: record.id === callerId,
  };
}

export async function listProjectKeys(auth: AuthContext): Promise<ApiKeyView[]> {
  const caller = manager(auth);
  const now = Date.now();
  return (await apiKeyStore().listByProject(caller.projectId)).map((record) => view(record, caller.keyId, now));
}

/** POST /v1/keys: a new project without a key (or with an operator key), a sibling with a developer key. */
export async function issueKey(auth: AuthContext, name: string): Promise<IssuedApiKey> {
  if (auth.tier !== "developer") return issueDeveloperKey(name);
  const caller = manager(auth);
  return issueDeveloperKey(name, { id: caller.projectId, maxActive: MAX_ACTIVE_KEYS_PER_PROJECT });
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
  const secret = newDeveloperSecret();
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

export async function revokeKey(auth: AuthContext, id: string): Promise<void> {
  const caller = manager(auth);
  const outcome = await apiKeyStore().revoke(id, caller.projectId, new Date().toISOString());
  forgetCachedKey(id);
  if (outcome === "missing") throw keyNotFound();
}
