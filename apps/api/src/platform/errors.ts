/**
 * Platform errors. Every failure that leaves the engine is a PlatformError
 * with a stable UPPER_SNAKE_CASE code, an HTTP status and optional per-field
 * issues. 5xx errors never carry provider or stack details.
 */
import { isSolanaError } from "@solana/kit";
import { BaseError as ViemBaseError } from "viem";
import { SolanaProviderError } from "../networks/solana/index.js";
import { DEFAULT_PROVIDER_RETRY_AFTER_SECONDS, MAX_PROVIDER_RETRY_AFTER_SECONDS, PROVIDER_RATE_LIMITED } from "../shared/http/providerRetry.js";

export interface PlatformIssue {
  readonly path: string;
  readonly message: string;
}

export type PlatformErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503 | 504;

/** Structured context of an error (`error.details`), e.g. the candidate networks of SOURCE_REQUIRED. */
export type PlatformErrorDetails = Readonly<Record<string, unknown>>;

/** Largest serialised `details` object (UTF-8 bytes of its JSON); larger details are refused. */
export const MAX_ERROR_DETAILS_BYTES = 4_096;

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isPlainJson(entry, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isPlainJson(entry, depth + 1));
}

/**
 * The details an error may carry: a plain JSON object (no class instances,
 * functions, bigint or non-finite numbers) of at most 4 KB, frozen as a deep
 * copy. Anything else is refused (null) and never reaches the response.
 */
export function platformErrorDetails(value: unknown): PlatformErrorDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isPlainJson(value)) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_ERROR_DETAILS_BYTES) return null;
  return Object.freeze(JSON.parse(json) as Record<string, unknown>);
}

export class PlatformError extends Error {
  readonly code: string;
  readonly status: PlatformErrorStatus;
  readonly issues?: readonly PlatformIssue[];
  /** Optional user-facing hints (e.g. example phrases for INTENT_UNSUPPORTED). */
  readonly hints?: readonly string[];
  /** Optional structured context, serialised beside `issues` and `hints` (at most 4 KB, else left out). */
  readonly details?: PlatformErrorDetails;

  constructor(
    code: string,
    message: string,
    status: PlatformErrorStatus = 400,
    issues?: readonly PlatformIssue[],
    hints?: readonly string[],
    details?: PlatformErrorDetails,
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = CODE_PATTERN.test(code) ? code : "PLATFORM_ERROR";
    this.status = status;
    if (issues && issues.length > 0) this.issues = issues.slice(0, 20);
    if (hints && hints.length > 0) this.hints = hints.slice(0, 20);
    const accepted = details === undefined ? null : platformErrorDetails(details);
    if (accepted) this.details = accepted;
  }

  toJSON(): {
    code: string;
    message: string;
    issues?: readonly PlatformIssue[];
    hints?: readonly string[];
    details?: PlatformErrorDetails;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
      ...(this.hints ? { hints: this.hints } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/**
 * A provider still rate-limiting after the bounded in-request retries:
 * PROVIDER_RATE_LIMITED (503, retryable) with `retryAfterSeconds` (sent as
 * Retry-After). The message names the provider only.
 */
export function providerRateLimited(provider: string, retryAfterSeconds: number = DEFAULT_PROVIDER_RETRY_AFTER_SECONDS): PlatformError & { readonly retryAfterSeconds: number } {
  const seconds = Number.isFinite(retryAfterSeconds)
    ? Math.min(MAX_PROVIDER_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(retryAfterSeconds)))
    : DEFAULT_PROVIDER_RETRY_AFTER_SECONDS;
  const name = provider.replace(/[^\w .-]+/gu, "").slice(0, 40) || "A provider";
  const error = new PlatformError(
    "PROVIDER_RATE_LIMITED",
    `${name} is limiting requests right now. This is temporary: try again in ${seconds} s.`,
    503,
  );
  Object.defineProperty(error, "retryAfterSeconds", { value: seconds, enumerable: false });
  return error as PlatformError & { readonly retryAfterSeconds: number };
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

function normalizeStatus(status: number): PlatformErrorStatus {
  const allowed: readonly PlatformErrorStatus[] = [400, 401, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504];
  if ((allowed as readonly number[]).includes(status)) return status as PlatformErrorStatus;
  if (status >= 500) return 502;
  return 400;
}

/** Upstream log lines per minute; beyond it lines are dropped until the minute ends (an outage must not flood the log). */
const UPSTREAM_LOG_PER_MINUTE = 30;
let upstreamLogWindow = { startedAt: 0, lines: 0 };

/**
 * One provider error message reduced to something safe to log: URLs (which
 * can carry keyed RPC endpoints), long hex payloads (calldata, signatures),
 * long base58 strings and anything that looks like a key are removed, and
 * the result is one line of at most 160 characters.
 */
export function sanitizeUpstreamMessage(raw: string): string {
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "<url>")
    .replace(/0x[0-9a-f]{40,}/giu, "<hex>")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{43,}\b/gu, "<base58>")
    .replace(/\b(?:api[_-]?key|apikey|token|secret|key)\s*[=:]\s*\S+/giu, "<redacted>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

/** Logs one sanitized line for an upstream error mapped to RPC_UNAVAILABLE or PROVIDER_UNAVAILABLE. */
function logUpstream(family: "evm" | "solana", error: unknown): void {
  const now = Date.now();
  if (now - upstreamLogWindow.startedAt >= 60_000) upstreamLogWindow = { startedAt: now, lines: 0 };
  if (upstreamLogWindow.lines >= UPSTREAM_LOG_PER_MINUTE) return;
  upstreamLogWindow.lines += 1;
  const record = error as { readonly shortMessage?: unknown; readonly message?: unknown };
  const message = typeof record.shortMessage === "string" && record.shortMessage ? record.shortMessage : typeof record.message === "string" ? record.message : String(error);
  console.warn(`[platform] upstream ${family} error: ${sanitizeUpstreamMessage(message)}`);
}

/**
 * Maps any thrown value to a PlatformError. Client-side (4xx) provider
 * messages are user-facing and preserved; anything server-side is replaced
 * with a generic message so RPC URLs, keys and stacks never leak. Mapped
 * upstream failures log one sanitized line, so operators can see the cause.
 */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  if (error instanceof SolanaProviderError) {
    if (error.code === PROVIDER_RATE_LIMITED) return providerRateLimited(error.provider ?? "A Solana provider", error.retryAfterSeconds);
    const status = normalizeStatus(error.status);
    if (status >= 500) {
      logUpstream("solana", error);
      return new PlatformError(
        CODE_PATTERN.test(error.code) ? error.code : "PROVIDER_UNAVAILABLE",
        "A Solana provider is temporarily unavailable. Try again shortly.",
        502,
      );
    }
    return new PlatformError(error.code, error.message.slice(0, 300), status);
  }
  if (error instanceof ViemBaseError) {
    logUpstream("evm", error);
    return new PlatformError("RPC_UNAVAILABLE", "An EVM network read failed. Try again shortly.", 502);
  }
  if (isSolanaError(error)) {
    logUpstream("solana", error);
    return new PlatformError("RPC_UNAVAILABLE", "A Solana network read failed. Try again shortly.", 502);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new PlatformError("UPSTREAM_TIMEOUT", "An upstream provider timed out. Try again shortly.", 504);
  }
  console.error("[platform] unexpected error:", error instanceof Error ? (error.stack ?? error.message) : error);
  return new PlatformError("INTERNAL_ERROR", "Unexpected platform error.", 500);
}

export function unsupported(message: string, hints?: readonly string[], issues?: readonly PlatformIssue[]): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, issues, hints);
}
