/**
 * Platform errors. Every failure that leaves the engine is a PlatformError
 * with a stable UPPER_SNAKE_CASE code, an HTTP status and optional per-field
 * issues. 5xx errors never carry provider or stack details.
 */
import { BaseError as ViemBaseError } from "viem";
import { SolanaProviderError } from "../networks/solana/index.js";

export interface PlatformIssue {
  readonly path: string;
  readonly message: string;
}

export type PlatformErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503 | 504;

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

export class PlatformError extends Error {
  readonly code: string;
  readonly status: PlatformErrorStatus;
  readonly issues?: readonly PlatformIssue[];
  /** Optional user-facing hints (e.g. example phrases for INTENT_UNSUPPORTED). */
  readonly hints?: readonly string[];

  constructor(
    code: string,
    message: string,
    status: PlatformErrorStatus = 400,
    issues?: readonly PlatformIssue[],
    hints?: readonly string[],
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = CODE_PATTERN.test(code) ? code : "PLATFORM_ERROR";
    this.status = status;
    if (issues && issues.length > 0) this.issues = issues.slice(0, 20);
    if (hints && hints.length > 0) this.hints = hints.slice(0, 20);
  }

  toJSON(): {
    code: string;
    message: string;
    issues?: readonly PlatformIssue[];
    hints?: readonly string[];
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
      ...(this.hints ? { hints: this.hints } : {}),
    };
  }
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

/**
 * Maps any thrown value to a PlatformError. Client-side (4xx) provider
 * messages are user-facing and preserved; anything server-side is replaced
 * with a generic message so RPC URLs, keys and stacks never leak.
 */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  if (error instanceof SolanaProviderError) {
    const status = normalizeStatus(error.status);
    if (status >= 500) {
      return new PlatformError(
        CODE_PATTERN.test(error.code) ? error.code : "PROVIDER_UNAVAILABLE",
        "A Solana provider is temporarily unavailable. Try again shortly.",
        502,
      );
    }
    return new PlatformError(error.code, error.message.slice(0, 300), status);
  }
  if (error instanceof ViemBaseError) {
    return new PlatformError("RPC_UNAVAILABLE", "An EVM network read failed. Try again shortly.", 502);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new PlatformError("UPSTREAM_TIMEOUT", "An upstream provider timed out. Try again shortly.", 504);
  }
  return new PlatformError("INTERNAL_ERROR", "Unexpected platform error.", 500);
}

export function unsupported(message: string, hints?: readonly string[], issues?: readonly PlatformIssue[]): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, issues, hints);
}
