export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

/** Error returned by the Kletia API (non-2xx) or raised while talking to it. */
export class KletiaApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: readonly ApiIssue[];
  /** Guidance from the API, e.g. supported example phrases on INTENT_UNSUPPORTED. */
  readonly hints: readonly string[];
  readonly requestId: string | null;
  /** Seconds the API asked the caller to wait (`Retry-After`), when it sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    issues?: readonly ApiIssue[];
    hints?: readonly string[];
    requestId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = "KletiaApiError";
    this.code = input.code;
    this.status = input.status;
    this.issues = input.issues ?? [];
    this.hints = input.hints ?? [];
    this.requestId = input.requestId ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }

  /** True for failures worth retrying (network, timeout, 429, 5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
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
