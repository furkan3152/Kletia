/**
 * Calls of the sub-agent routes (/v1/agents) from the portal: keyed reads and
 * actions with the key held in memory, and the owner wallet's challenge and
 * decision (no key: the signature is the authority; sent from this origin).
 * Retries are off: the portal shows every answer as it came. Failures are
 * PlatformErrors, like the SDK's.
 */
import type { ApiIssue } from "@kletia/sdk";

import { PLATFORM_ORIGIN, type PlatformError } from "../../../../shared/platform/kletiaClient";
import type { AgentNode, SubagentRequest } from "./agentTreeModel";

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly apiKey?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function failure(status: number, code: string, message: string, issues: readonly ApiIssue[] = [], requestId: string | null = null): PlatformError {
  return { code, message, status, issues, requestId, retryable: status === 429 || status >= 500, unreachable: status === 0 };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
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

const requestPath = (id: string) => `/agents/requests/${encodeURIComponent(id)}`;
const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;

export interface WalletIdentity {
  readonly walletKind: "evm" | "solana";
  readonly address: string;
  readonly chainId?: number;
}

export const agentsApi = {
  tree: (apiKey: string, signal?: AbortSignal) =>
    request<{ nodes: AgentNode[]; requests: SubagentRequest[] }>("/agents/tree", { apiKey, ...(signal ? { signal } : {}) }),
  /** With the project key in memory (empty body). */
  decideWithKey: (apiKey: string, id: string, decision: "approve" | "deny") =>
    request<{ request: SubagentRequest }>(`${requestPath(id)}/${decision}`, { method: "POST", apiKey, body: {} }).then((reply) => reply.request),
  challenge: (id: string, decision: "approve" | "deny", wallet: WalletIdentity) =>
    request<{ message: string; expiresAt: string }>(`${requestPath(id)}/challenge`, {
      method: "POST",
      body: { decision, walletKind: wallet.walletKind, address: wallet.address, ...(wallet.walletKind === "evm" ? { chainId: wallet.chainId } : {}) },
    }),
  decideWithWallet: (id: string, decision: "approve" | "deny", message: string, signature: string) =>
    request<{ request: SubagentRequest }>(`${requestPath(id)}/${decision}`, { method: "POST", body: { message, signature } }).then((reply) => reply.request),
  revoke: (apiKey: string, keyId: string) => request<{ keyId: string; revoked: string[] }>(`${agentPath(keyId)}/revoke`, { method: "POST", apiKey, body: {} }),
  pause: (apiKey: string, keyId: string) => request<{ keyId: string; mode: "paused"; version: number }>(`${agentPath(keyId)}/pause`, { method: "POST", apiKey, body: {} }),
  /** Public: how many requests wait in projects the wallet owns (the desk notice). */
  pending: (account: string, signal?: AbortSignal) =>
    request<{ pending: number }>(`/agents/pending?account=${encodeURIComponent(account)}`, signal ? { signal } : {}).then((reply) => reply.pending),
};
