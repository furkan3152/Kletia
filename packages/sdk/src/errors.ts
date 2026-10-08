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

  constructor(input: {
    code: string;
    message: string;
    status: number;
    issues?: readonly ApiIssue[];
    hints?: readonly string[];
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = "KletiaApiError";
    this.code = input.code;
    this.status = input.status;
    this.issues = input.issues ?? [];
    this.hints = input.hints ?? [];
    this.requestId = input.requestId ?? null;
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

  constructor(message: string, intentId: string, stepId: string, cause?: unknown) {
    super(message);
    this.name = "KletiaExecutionError";
    this.intentId = intentId;
    this.stepId = stepId;
    this.cause = cause;
  }
}
