/**
 * Client options and per-call option shapes.
 */
import type { IntentGraph, IntentRequest } from "@kletia/core";
import type { RetryClass } from "../retry.js";
import type {
  IntentWithPreview,
  CreateIntentOptions,
  IntentWithJourney,
  RequestOptions,
} from "../types.js";
import type { WatchIntentOptions } from "../watch.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KletiaClientOptions {
  /** API origin, without the `/v1` suffix. Defaults to the hosted Kletia API. */
  readonly baseUrl?: string;
  /**
   * Developer or operator key (`kl_dev_…`). Optional for public endpoints.
   * Server-side only: never ship it in browser bundles; from the browser use
   * the public tier or a `baseUrl` that proxies through your server.
   */
  readonly apiKey?: string;
  /**
   * Publishable key (`kl_pub_…`): safe in browsers, sent as
   * `Authorization: Bearer kl_pub_…`. It plans intents, starts sessions
   * from the project's stored flows and reads the project profile; every
   * server-only method is refused locally with PUBLISHABLE_KEY_FORBIDDEN
   * before anything is sent. Never combined with `apiKey`.
   */
  readonly publishableKey?: string;
  /** Per-attempt timeout in milliseconds (default 20000). */
  readonly timeoutMs?: number;
  /**
   * Retries for requests that are safe to repeat (default 2): GET, DELETE,
   * quotes, dry runs and refresh, and state-changing POSTs that carry an
   * Idempotency-Key. Prepare is never retried. 0 disables retries.
   */
  readonly maxRetries?: number;
  /** First backoff delay in milliseconds (default 500, doubling per attempt, with jitter). */
  readonly retryBaseDelayMs?: number;
  /** Custom fetch implementation (tests, edge runtimes, proxies). */
  readonly fetch?: FetchLike;
  /** Extra headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Web origin used by `links.pageUrl` / `links.cardUrl` (default https://kletiaai.xyz). */
  readonly webOrigin?: string;
}

export interface StreamOptions {
  readonly signal?: AbortSignal;
  /** Resume after this event id (sent as Last-Event-ID). */
  readonly lastEventId?: string;
  /** Called once the stream is open, before the first event. */
  readonly onOpen?: () => void;
}

/** Options for the low-level `request` helper. */
export interface LowLevelRequestOptions extends RequestOptions {
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** Extra headers for this request (e.g. `If-Match`). `authorization` and `idempotency-key` cannot be set here. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WaitForIntentOptions extends Omit<WatchIntentOptions, "signal"> {
  readonly signal?: AbortSignal;
  /** Give up after this many milliseconds (default 20 minutes) with `WAIT_TIMEOUT`. */
  readonly timeoutMs?: number;
}

/** Options of `events.stream` (`GET /v1/events`, key required). */
export interface EventStreamOptions extends StreamOptions {
  /** `self` (default): the key's own events; `subtree`: also its agent and publishable keys' (and, for project keys, project-wide rule book events). */
  readonly scope?: "self" | "subtree";
  /** Only these event types (webhook event type names). */
  readonly types?: readonly string[];
}

/** `intents.create`: the intent, `{ intent, preview }` with `preview: true`, or `{ intent, preview, journey }` with `journey: true`. */
export interface CreateIntent {
  (request: IntentRequest, options: CreateIntentOptions & RequestOptions & { readonly journey: true }): Promise<IntentWithJourney>;
  (request: IntentRequest, options: CreateIntentOptions & RequestOptions & { readonly preview: true; readonly journey?: false }): Promise<IntentWithPreview>;
  (request: IntentRequest, options?: CreateIntentOptions & RequestOptions & { readonly preview?: false; readonly journey?: false }): Promise<IntentGraph>;
  (request: IntentRequest, options?: CreateIntentOptions & RequestOptions): Promise<IntentGraph | IntentWithPreview | IntentWithJourney>;
}

/** Options of `receipts.get`. */
export interface GetReceiptOptions extends RequestOptions {
  /** An earlier sequence instead of the latest receipt. */
  readonly sequence?: number;
  /**
   * Wait for the receipt: polls while it is pending (202, honouring
   * `retryAfterSeconds`) and while the intent is still running
   * (RECEIPT_NOT_READY). `true` waits up to 45 minutes; rejects with
   * `WAIT_TIMEOUT` after `timeoutMs`.
   */
  readonly wait?: boolean | { readonly timeoutMs?: number; readonly onPending?: (pending: ReceiptPendingInfo) => void };
}

/** What `receipts.get` waits for, as `onPending` sees it. */
export interface ReceiptPendingInfo {
  readonly reason: string;
  readonly expectedBy: string | null;
  readonly retryAfterSeconds: number;
}

/** Internal per-call behaviour that is not part of the public request options. */
export interface CallBehaviour {
  /** A 404 after a retry means an earlier attempt already removed the resource. */
  readonly goneAfterRetryIsDone?: boolean;
  /**
   * The call can end the secret that authenticates it (a key rotating or
   * revoking itself). When an attempt whose outcome is unknown is followed by
   * a 401 or KEY_SECRET_ROTATED, that attempt may have run, and its response
   * cannot be replayed to this secret: report OUTCOME_UNKNOWN, not the 401.
   */
  readonly mayEndOwnSecret?: "rotate" | "revoke";
  /** Retryable codes the caller handles itself (e.g. receipts.get waiting on RECEIPT_NOT_READY): never retried here. */
  readonly noRetryCodes?: ReadonlySet<string>;
  /** The retry class when it depends on the body (clarify turns), instead of the route's. */
  readonly retryClass?: RetryClass;
}
