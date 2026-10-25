/**
 * Route tables (retry classes, publishable routes) and request helpers.
 */
import type { IntentTurnRequest } from "@kletia/core";
import { KletiaApiError } from "../errors.js";
import { retryClass, type RetryClass } from "../retry.js";
import type { DataWalletQuery } from "../types.js";
import type { FetchLike } from "./options.js";
import {
  abortedError,
  errorFromResponse,
  isRecord,
  transportError,
} from "./http.js";

/**
 * Retry classes of routes added after `retryClass`, layered over it:
 * registering, updating and re-verifying a contract, creating a session, a
 * child key, a receipt share, a link, and writing a rule book are replayed by
 * the API for the same Idempotency-Key; a contract test, a preview
 * recomputation, a policy validation and a link quote change nothing; an
 * approval decision replays the recorded decision. Turning a session or a
 * link into an intent stays unretried (public, no Idempotency-Key), and so do
 * the simulator (each call is logged and rate limited) and rule book removals
 * (a lost response could otherwise remove twice).
 */
const ROUTE_CLASSES: readonly { readonly method: string; readonly pattern: RegExp; readonly kind: RetryClass }[] = [
  { method: "POST", pattern: /^\/contracts$/iu, kind: "idempotent" },
  { method: "PATCH", pattern: /^\/contracts\/[^/]+$/iu, kind: "idempotent" },
  { method: "POST", pattern: /^\/contracts\/[^/]+\/reverify$/iu, kind: "idempotent" },
  { method: "POST", pattern: /^\/contracts\/[^/]+\/test$/iu, kind: "safe" },
  { method: "POST", pattern: /^\/sessions$/iu, kind: "idempotent" },
  { method: "POST", pattern: /^\/intents\/[^/]+\/preview$/iu, kind: "safe" },
  { method: "POST", pattern: /^\/intents\/[^/]+\/receipt\/shares$/iu, kind: "idempotent" },
  { method: "POST", pattern: /^\/keys\/[^/]+\/children$/iu, kind: "idempotent" },
  { method: "PATCH", pattern: /^\/keys\/[^/]+$/iu, kind: "safe" },
  { method: "PUT", pattern: /^\/keys\/[^/]+\/policy$/iu, kind: "idempotent" },
  { method: "PUT", pattern: /^\/projects\/current\/policy$/iu, kind: "idempotent" },
  { method: "DELETE", pattern: /^\/keys\/[^/]+\/policy(?:\/pending)?$/iu, kind: "unsafe" },
  { method: "DELETE", pattern: /^\/projects\/current\/policy(?:\/pending)?$/iu, kind: "unsafe" },
  { method: "POST", pattern: /^\/policy\/validate$/iu, kind: "safe" },
  { method: "POST", pattern: /^\/policy\/approvals\/[^/]+\/(?:approve|reject)$/iu, kind: "safe" },
  { method: "POST", pattern: /^\/links$/iu, kind: "idempotent" },
  { method: "PATCH", pattern: /^\/links\/[^/]+$/iu, kind: "idempotent" },
  { method: "POST", pattern: /^\/links\/[^/]+\/quote$/iu, kind: "safe" },
  // Stopping replays its first answer for the same Idempotency-Key.
  { method: "POST", pattern: /^\/intents\/[^/]+\/stop$/iu, kind: "idempotent" },
  // Projects: a stale If-Match after a lost response would answer
  // PROJECT_CONFLICT, so settings writes are not repeated automatically.
  { method: "PATCH", pattern: /^\/projects\/current$/iu, kind: "unsafe" },
  { method: "POST", pattern: /^\/projects\/current\/domain\/verify$/iu, kind: "safe" },
  { method: "POST", pattern: /^\/projects\/current\/publishable-keys$/iu, kind: "idempotent" },
  { method: "PUT", pattern: /^\/projects\/current\/logo$/iu, kind: "safe" },
];

/**
 * Retry class of a clarify turn: a turn that changes a Kletia-held thread
 * (`threadId`, or `remember` on the first turn) is repeated only with an
 * Idempotency-Key, dry run or not (the API replays the first answer for the
 * key); a dry-run turn on a client-held thread changes nothing and is safe
 * to repeat; a turn that stores an intent is repeated only with an
 * Idempotency-Key, like `intents.create`.
 */
export function turnRetryClass(request: IntentTurnRequest, options: { readonly dryRun?: boolean } = {}): RetryClass {
  if (request.threadId !== undefined || request.remember === true) return "idempotent";
  return options.dryRun ? "safe" : "idempotent";
}

/**
 * What a publishable key may call: the public tier, stored or dry-run
 * intents, sessions from stored flows and the project profile. Anything
 * else is refused before it is sent.
 */
const PUBLISHABLE_ROUTES: readonly { readonly method: string; readonly pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/(?:health|networks|protocols|assets|venues|errors|openapi\.json|status\/badge|publishable\/profile)$/iu },
  { method: "GET", pattern: /^\/portfolio(?:\/[^/]+)?$/iu },
  { method: "GET", pattern: /^\/data\/(?:portfolio|positions|history|export|transactions(?:\/[^/]+)?|pnl|snapshots|summary|markets\/(?:yields|prices|status))$/iu },
  { method: "POST", pattern: /^\/(?:quotes|intents|mcp|policy\/validate)$/iu },
  { method: "GET", pattern: /^\/intents\/[^/]+(?:\/(?:events|journey|preview|receipt|receipts|receipt\/shares))?$/iu },
  { method: "POST", pattern: /^\/intents\/[^/]+\/(?:refresh|cancel|stop|preview|receipt\/shares)$/iu },
  { method: "POST", pattern: /^\/intents\/[^/]+\/steps\/[^/]+\/(?:prepare|submit)$/iu },
  { method: "DELETE", pattern: /^\/intents\/[^/]+\/receipt\/(?:shares\/[^/]+|disclosures)$/iu },
  { method: "GET", pattern: /^\/receipts\/(?:keys|log|log\/inclusion|log\/[^/]+|[^/]+|[^/]+\/status|[^/]+\/shares\/[^/]+)$/iu },
  { method: "GET", pattern: /^\/policy\/approvals\/[^/]+$/iu },
  { method: "POST", pattern: /^\/policy\/approvals\/[^/]+\/(?:approve|reject)$/iu },
  { method: "GET", pattern: /^\/links\/[^/]+(?:\/(?:card\.png|page))?$/iu },
  { method: "POST", pattern: /^\/links\/[^/]+\/(?:quote|intents|report)$/iu },
  { method: "GET", pattern: /^\/blinks\/[^/]+$/iu },
  { method: "POST", pattern: /^\/blinks\/[^/]+(?:\/next)?$/iu },
  { method: "GET", pattern: /^\/sessions\/[^/]+$/iu },
  { method: "POST", pattern: /^\/sessions(?:\/[^/]+\/intents)?$/iu },
  { method: "GET", pattern: /^\/orders(?:\/[^/]+)?$/iu },
  { method: "POST", pattern: /^\/orders\/(?:quote|prepare|submit|[^/]+\/cancel)$/iu },
];

function routePath(path: string): string | null {
  let pathname = path.split(/[?#]/u, 1)[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return pathname.replace(/\/+$/u, "").replace(/^\/v1(?=\/)/iu, "");
}

/** Why a publishable key may not make this call, or null when it may. */
export function publishableRefusal(method: string, path: string, body: unknown): string | null {
  const pathname = routePath(path);
  const verb = method.toUpperCase();
  if (pathname === null || !PUBLISHABLE_ROUTES.some((route) => route.method === verb && route.pattern.test(pathname))) {
    return `${verb} ${pathname ?? path} is a server-only method: call it from your server with a secret key.`;
  }
  // Publishable keys start sessions only from the project's stored flows.
  if (verb === "POST" && /^\/sessions$/iu.test(pathname)) {
    if (!isRecord(body) || typeof body.flow !== "string" || Object.keys(body).some((key) => key !== "flow" && key !== "hostOrigin")) {
      return "A publishable key creates sessions only from a stored flow: send { flow, hostOrigin }.";
    }
  }
  return null;
}

export function requestRetryClass(method: string, path: string, query: Readonly<Record<string, string | undefined>> = {}): RetryClass {
  let pathname = path.split(/[?#]/u, 1)[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return retryClass(method, path, query);
  }
  pathname = pathname.replace(/\/+$/u, "").replace(/^\/v1(?=\/)/iu, "");
  const verb = method.toUpperCase();
  const route = ROUTE_CLASSES.find((candidate) => candidate.method === verb && candidate.pattern.test(pathname));
  return route ? route.kind : retryClass(method, path, query);
}

/** Codes `receipts.get` handles itself (never retried by the transport loop). */
export const RECEIPT_WAIT_CODES: ReadonlySet<string> = new Set(["RECEIPT_NOT_READY"]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PNG_BYTES = 2 * 1024 * 1024;

/** GET of a PNG: API errors keep their envelope; anything that is not a PNG is refused. */
export async function fetchPng(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number, userSignal?: AbortSignal): Promise<Uint8Array> {
  if (userSignal?.aborted) throw abortedError(userSignal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw transportError(error, userSignal, timeout);
  }
  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = null;
    }
    throw errorFromResponse(response, parsed, `Request failed with status ${response.status}.`);
  }
  if (bytes.length > MAX_PNG_BYTES || bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new KletiaApiError({ code: "INVALID_RESPONSE", message: "The Kletia API did not return a PNG image.", status: response.status, requestId: response.headers.get("x-request-id") });
  }
  return bytes;
}

/** The page's origin in a browser (`sessions.createIntent` default), else undefined. */
export function pageOrigin(): string | undefined {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof origin === "string" && origin !== "null" ? origin : undefined;
}

/** `evm`, `solana` and `lane` query values of a `data.*` read, checked locally (nothing is sent when they are wrong). */
export function walletQuery(wallets: DataWalletQuery, required: boolean): Record<string, string | undefined> {
  const list = (value: string | readonly string[] | undefined, name: "evm" | "solana"): string | undefined => {
    const values = value === undefined ? [] : typeof value === "string" ? [value] : [...value];
    if (values.length > 2) throw new RangeError(`data reads take at most 2 ${name} addresses.`);
    if (values.some((address) => typeof address !== "string" || !address.trim() || address.includes(","))) throw new TypeError(`${name} must be addresses.`);
    return values.length > 0 ? values.map((address) => address.trim()).join(",") : undefined;
  };
  const evm = list(wallets.evm, "evm");
  const solana = list(wallets.solana, "solana");
  if (required && evm === undefined && solana === undefined) throw new TypeError("Name at least one wallet: evm and/or solana.");
  return { evm, solana, lane: wallets.lane };
}

export function retriesOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new RangeError("maxRetries must be an integer between 0 and 10.");
  return value;
}
