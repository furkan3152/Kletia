import {
  describeError,
  errorDocsUrl,
  isRetryableError,
  resolveErrorCode,
  type KletiaErrorCategory,
  type KletiaErrorCode,
} from "@kletia/core";

export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

/** Codes the SDK raises itself, when there is no API error envelope. */
export type KletiaClientErrorCode =
  | "NETWORK_ERROR"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "INVALID_RESPONSE"
  | "WAIT_TIMEOUT"
  /** A key rotated or revoked itself, the response was lost and the retry was refused; `cause` is the refusal. */
  | "OUTCOME_UNKNOWN"
  | `HTTP_${number}`;

/** A catalogued API code (`ERROR_CATALOG` in `@kletia/core`), an SDK code, or a code newer than this SDK. */
export type KletiaApiErrorCode = KletiaErrorCode | KletiaClientErrorCode | (string & {});

/** The catalog category, or `network` when the API was never reached. */
export type KletiaApiErrorCategory = KletiaErrorCategory | "network";

/** SDK codes for a request that may not have reached the API; repeating it can succeed. */
const TRANSIENT_CLIENT_CODES: ReadonlySet<string> = new Set(["NETWORK_ERROR", "REQUEST_TIMEOUT"]);

function categoryForStatus(status: number): KletiaApiErrorCategory {
  if (status === 0) return "network";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "expired";
  if (status === 422) return "intent";
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 504) return "upstream";
  if (status === 503) return "unavailable";
  if (status >= 500) return "internal";
  return "request";
}

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** Error returned by the Kletia API (non-2xx) or raised while talking to it. */
export class KletiaApiError extends Error {
  readonly code: KletiaApiErrorCode;
  readonly status: number;
  readonly issues: readonly ApiIssue[];
  /** Guidance from the API, e.g. supported example phrases on INTENT_UNSUPPORTED. */
  readonly hints: readonly string[];
  readonly requestId: string | null;
  /** Seconds the API asked the caller to wait (`Retry-After`), when it sent one. */
  readonly retryAfterSeconds: number | null;
  /** Documentation for this code: the API's `error.docs` link, or the catalog entry's. */
  readonly docsUrl: string | null;

  constructor(input: {
    code: KletiaApiErrorCode;
    message: string;
    status: number;
    issues?: readonly ApiIssue[];
    hints?: readonly string[];
    requestId?: string | null;
    retryAfterSeconds?: number | null;
    docs?: string | null;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "KletiaApiError";
    this.code = input.code;
    this.status = input.status;
    this.issues = input.issues ?? [];
    this.hints = input.hints ?? [];
    this.requestId = input.requestId ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.docsUrl = httpsUrl(input.docs) ?? (resolveErrorCode(input.code) ? errorDocsUrl(input.code) : null);
  }

  /** Catalog category of the code (by HTTP status for codes this SDK does not know). */
  get category(): KletiaApiErrorCategory {
    return describeError(this.code)?.category ?? categoryForStatus(this.status);
  }

  /**
   * True when repeating the same request later can succeed: the API was
   * unreachable or timed out, or the catalog marks the code retryable (codes
   * this SDK does not know: 429 and 5xx).
   */
  get retryable(): boolean {
    if (this.status === 0) return TRANSIENT_CLIENT_CODES.has(this.code);
    return isRetryableError(this.code, this.status);
  }
}

/**
 * True when `error` is a `KletiaApiError`, optionally with `code`. Provider
 * codes match their catalog family too: `isKletiaError(e, "PROVIDER_UNAVAILABLE")`
 * is true for `RELAY_UNAVAILABLE`.
 */
export function isKletiaError(error: unknown, code?: KletiaApiErrorCode): error is KletiaApiError {
  if (!(error instanceof KletiaApiError)) return false;
  return code === undefined || error.code === code || resolveErrorCode(error.code) === code;
}

/** Raised by `executeIntent` when a wallet or the API rejects a step. */
export class KletiaExecutionError extends Error {
  readonly intentId: string;
  readonly stepId: string;
  override readonly cause: unknown;
  /**
   * Transactions the wallet already broadcast for this step that Kletia has
   * not accepted yet, in payload order. `executeIntent` keeps them and
   * submits them on its next run instead of asking the wallet to sign the
   * step again; from another process, pass them back as
   * `pendingReferences` (or call `intents.submitStep`).
   */
  readonly references?: readonly string[];

  constructor(
    message: string,
    intentId: string,
    stepId: string,
    cause?: unknown,
    references?: readonly string[],
  ) {
    super(message);
    this.name = "KletiaExecutionError";
    this.intentId = intentId;
    this.stepId = stepId;
    this.cause = cause;
    if (references && references.length > 0) this.references = references;
  }
}
