/**
 * Calls of the developer account routes (/v1/accounts). The session token
 * travels in `Kletia-Account-Session`, never in a cookie; a project key is
 * sent only to claim its project. Retries are off: the portal shows every
 * answer as it came. Failures are PlatformErrors, like the SDK's.
 */
import type {
  AccountActivityView,
  AccountKeyView,
  AccountNonceResponse,
  AccountProjectView,
  AccountSessionView,
  AccountSignInResponse,
} from "@kletia/core";
import type { ApiIssue } from "@kletia/sdk";

import { PLATFORM_ORIGIN, type PlatformError } from "../../../../shared/platform/kletiaClient";

export const ACCOUNT_SESSION_HEADER = "Kletia-Account-Session";

export interface IssuedAccountKey {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly createdAt: string;
  readonly lane?: string;
}

export interface RotatedAccountKey extends IssuedAccountKey {
  readonly rotatedAt: string;
  readonly previousExpiresAt: string | null;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly token?: string;
  readonly apiKey?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function failure(status: number, code: string, message: string, issues: readonly ApiIssue[] = [], requestId: string | null = null): PlatformError {
  return { code, message, status, issues, requestId, retryable: status === 429 || status >= 500, unreachable: status === 0 };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers[ACCOUNT_SESSION_HEADER] = options.token;
  if (options.apiKey) headers["X-Kletia-Key"] = options.apiKey;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${PLATFORM_ORIGIN}/v1${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "omit",
      cache: "no-store",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw failure(0, "NETWORK_ERROR", "The Kletia API is unreachable from this browser right now.");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = (body ?? {}) as { error?: { code?: unknown; message?: unknown; issues?: unknown }; requestId?: unknown };
    throw failure(
      response.status,
      typeof envelope.error?.code === "string" ? envelope.error.code : "HTTP_ERROR",
      typeof envelope.error?.message === "string" ? envelope.error.message : `The Kletia API answered ${response.status}.`,
      Array.isArray(envelope.error?.issues) ? (envelope.error.issues as ApiIssue[]) : [],
      typeof envelope.requestId === "string" ? envelope.requestId : null,
    );
  }
  return body as T;
}

/** True for errors thrown by this client (as opposed to wallet or abort errors). */
export function isPlatformError(error: unknown): error is PlatformError {
  return typeof error === "object" && error !== null && "code" in error && "status" in error && "unreachable" in error;
}

const projectPath = (projectId: string) => `/accounts/projects/${encodeURIComponent(projectId)}`;

export const accountApi = {
  nonce: (body: { walletKind: "evm" | "solana"; address: string; chainId?: number }) =>
    request<AccountNonceResponse>("/accounts/nonce", { method: "POST", body }),
  signIn: (message: string, signature: string) => request<AccountSignInResponse>("/accounts/session", { method: "POST", body: { message, signature } }),
  session: (token: string, signal?: AbortSignal) =>
    request<{ session: AccountSessionView }>("/accounts/session", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.session),
  signOut: (token: string) => request<void>("/accounts/session", { method: "DELETE", token }),
  projects: (token: string, signal?: AbortSignal) =>
    request<{ projects: AccountProjectView[] }>("/accounts/projects", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.projects),
  createProject: (token: string, name: string, sandbox: boolean) =>
    request<{ project: AccountProjectView; key: IssuedAccountKey }>("/accounts/projects", { method: "POST", token, body: { name, sandbox } }),
  claim: (token: string, apiKey: string) =>
    request<{ project: AccountProjectView; claimed: boolean }>("/accounts/projects/claim", { method: "POST", token, apiKey }),
  keys: (token: string, projectId: string, signal?: AbortSignal) =>
    request<{ keys: AccountKeyView[] }>(`${projectPath(projectId)}/keys`, { token, ...(signal ? { signal } : {}) }).then((reply) => reply.keys),
  issueKey: (token: string, projectId: string, name: string, sandbox: boolean) =>
    request<{ key: IssuedAccountKey }>(`${projectPath(projectId)}/keys`, { method: "POST", token, body: { name, sandbox } }).then((reply) => reply.key),
  rotateKey: (token: string, projectId: string, keyId: string, graceSeconds: number) =>
    request<{ key: RotatedAccountKey }>(`${projectPath(projectId)}/keys/${encodeURIComponent(keyId)}/rotate`, { method: "POST", token, body: { graceSeconds } }).then(
      (reply) => reply.key,
    ),
  revokeKey: (token: string, projectId: string, keyId: string) =>
    request<void>(`${projectPath(projectId)}/keys/${encodeURIComponent(keyId)}`, { method: "DELETE", token }),
  activity: (token: string, signal?: AbortSignal) =>
    request<{ activity: AccountActivityView[] }>("/accounts/activity", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.activity),
};
