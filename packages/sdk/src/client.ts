import type {
  AnyKletiaEvent,
  AssetDescriptor,
  IntentGraph,
  IntentRequest,
  NetworkKey,
  ProtocolDescriptor,
  ProtocolId,
} from "@kletia/core";
import { KletiaApiError, type ApiIssue } from "./errors.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  newIdempotencyKey,
  retryClass,
  retryDelayMs,
  sleep,
} from "./retry.js";
import { readServerSentEvents } from "./sse.js";
import type {
  ApiKeyRecord,
  ApiKeySummary,
  CreateIntentOptions,
  ErrorCatalogResponse,
  HealthReport,
  NetworkCapabilities,
  PortfolioResponse,
  PreparedStep,
  QuoteRequest,
  QuoteResponse,
  RequestOptions,
  RotatedApiKey,
  UsageReport,
  UsageWindow,
  VenuesResponse,
  WebhookDelivery,
  WebhookRecord,
} from "./types.js";
import { watchIntent, type WatchIntentOptions } from "./watch.js";

export const DEFAULT_BASE_URL = "https://api.kletiaai.xyz";
export const SDK_VERSION = "0.1.0";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KletiaClientOptions {
  /** API origin, without the `/v1` suffix. Defaults to the hosted Kletia API. */
  readonly baseUrl?: string;
  /**
   * Developer or operator key (`kl_dev_…`). Optional for public endpoints.
   * Server-side only: never ship it in browser bundles; from the browser use
   * the public tier or a `baseUrl` that proxies through your server.
   */
  readonly apiKey?: string;
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
}

export interface WaitForIntentOptions extends Omit<WatchIntentOptions, "signal"> {
  readonly signal?: AbortSignal;
  /** Give up after this many milliseconds (default 20 minutes) with `WAIT_TIMEOUT`. */
  readonly timeoutMs?: number;
}

/** Internal per-call behaviour that is not part of the public request options. */
interface CallBehaviour {
  /** A 404 after a retry means an earlier attempt already removed the resource. */
  readonly goneAfterRetryIsDone?: boolean;
  /**
   * The call can end the secret that authenticates it (a key rotating or
   * revoking itself). When an attempt whose outcome is unknown is followed by
   * a 401 or KEY_SECRET_ROTATED, that attempt may have run, and its response
   * cannot be replayed to this secret: report OUTCOME_UNKNOWN, not the 401.
   */
  readonly mayEndOwnSecret?: "rotate" | "revoke";
}

/** An attempt that failed this way may still have run on the server. */
function mayHaveRun(error: KletiaApiError): boolean {
  return error.status === 0 || error.status >= 500 || error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS";
}

function ownSecretEnded(action: "rotate" | "revoke", error: KletiaApiError): KletiaApiError {
  const happened =
    action === "rotate"
      ? "The rotation may have gone through: an earlier attempt got no answer, and the retry was refused because this client's secret no longer authenticates"
      : "The revoke may have gone through: an earlier attempt got no answer, and the retry was refused because this client's secret no longer authenticates";
  const consequence =
    action === "rotate"
      ? "If the key rotated itself, its new secret was only in the lost response and cannot be recovered."
      : "If the key revoked itself, it is revoked.";
  return new KletiaApiError({
    code: "OUTCOME_UNKNOWN",
    message: `${happened} (${error.code}). ${consequence}`,
    status: error.status,
    hints:
      action === "rotate"
        ? ["Check rotatedAt and last4 in the key list with another key of the project, and rotate from that key."]
        : ["Check revokedAt in the key list with another key of the project."],
    requestId: error.requestId,
    cause: error,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Kletia baseUrl must use HTTPS (HTTP is allowed only for localhost).");
  }
  return url.origin + url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

/** `Retry-After` as seconds (delta-seconds or an HTTP date), or null when absent. */
function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/u.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Builds the error for a non-2xx response from the API's JSON error envelope. */
function errorFromResponse(response: Response, parsed: unknown, fallbackMessage: string): KletiaApiError {
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  return new KletiaApiError({
    code: typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
    message: typeof error.message === "string" ? error.message : fallbackMessage,
    status: response.status,
    issues: Array.isArray(error.issues) ? (error.issues as ApiIssue[]) : [],
    hints: Array.isArray(error.hints)
      ? error.hints.filter((hint): hint is string => typeof hint === "string")
      : [],
    requestId: response.headers.get("x-request-id"),
    retryAfterSeconds: retryAfterSeconds(response),
    docs: typeof error.docs === "string" ? error.docs : null,
  });
}

function abortedError(signal: AbortSignal | undefined): KletiaApiError {
  return new KletiaApiError({
    code: "REQUEST_ABORTED",
    message: "The request was aborted.",
    status: 0,
    cause: signal?.reason,
  });
}

/** Maps a fetch failure (or a failed stream read) to a KletiaApiError. */
function transportError(error: unknown, signal: AbortSignal | undefined, timeout?: AbortSignal): KletiaApiError {
  if (signal?.aborted) return abortedError(signal);
  const timedOut = (error as Error)?.name === "TimeoutError" || timeout?.aborted === true;
  return new KletiaApiError({
    code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    message: timedOut ? "The Kletia API did not respond in time." : "The Kletia API is unreachable.",
    status: 0,
    cause: error,
  });
}

function encodeSegment(value: string, name: string): string {
  if (!value || value.length > 200) throw new Error(`${name} is required.`);
  return encodeURIComponent(value);
}

function retriesOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new RangeError("maxRetries must be an integer between 0 and 10.");
  return value;
}

/**
 * Typed client for Kletia Platform API v1.
 *
 * ```ts
 * const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });
 * const intent = await kletia.intents.create({ text: "swap 1 SOL to USDC", accounts: [solanaAccount] });
 * ```
 */
export class KletiaClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: KletiaClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = retriesOption(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    const fallback = (globalThis as { fetch?: FetchLike }).fetch;
    const fetchImpl = options.fetch ?? (fallback ? fallback.bind(globalThis) : undefined);
    if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
    this.fetchImpl = fetchImpl;
    this.extraHeaders = options.headers ?? {};
  }

  /** True when the client sends an API key (idempotency keys are generated only then). */
  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      "x-kletia-sdk": `js/${SDK_VERSION}`,
      ...this.extraHeaders,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  /**
   * Low-level request helper. Returns the parsed JSON body (null for an
   * empty one). Retries follow the policy in `retry.ts`: safe requests and
   * state-changing POSTs that carry an Idempotency-Key are repeated on
   * network errors, timeouts, 429 and retryable codes; prepare never is.
   */
  request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    init: LowLevelRequestOptions = {},
  ): Promise<T> {
    return this.call<T>(method, path, body, init, {});
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    init: LowLevelRequestOptions,
    behaviour: CallBehaviour,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const kind = retryClass(method, path, init.query);
    let idempotencyKey: string | null = null;
    let generated = false;
    if (kind === "prepare") {
      if (typeof init.idempotencyKey === "string") {
        throw new TypeError("Prepare does not accept an Idempotency-Key: every call builds fresh transactions and is never retried.");
      }
    } else if (typeof init.idempotencyKey === "string") {
      idempotencyKey = init.idempotencyKey;
    } else if (init.idempotencyKey !== false && kind === "idempotent" && this.apiKey) {
      idempotencyKey = newIdempotencyKey();
      generated = idempotencyKey !== null;
    }
    const defaultRetries = kind === "safe" || (kind === "idempotent" && idempotencyKey !== null) ? this.maxRetries : 0;
    let retries = kind === "prepare" ? 0 : retriesOption(init.maxRetries, defaultRetries);
    let earlierAttemptMayHaveRun = false;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.send<T>(method, url, body, idempotencyKey, init.signal);
      } catch (error) {
        if (!(error instanceof KletiaApiError)) throw error;
        if (generated && error.code === "IDEMPOTENCY_NOT_SUPPORTED") {
          // Refused before anything ran (the deployment cannot seal stored
          // secrets): send it once more without the key, and without retries.
          idempotencyKey = null;
          generated = false;
          retries = attempt;
          continue;
        }
        if (behaviour.goneAfterRetryIsDone && attempt > 1 && error.status === 404) return null as T;
        if (
          behaviour.mayEndOwnSecret &&
          earlierAttemptMayHaveRun &&
          (error.code === "INVALID_API_KEY" || error.code === "KEY_SECRET_ROTATED")
        ) {
          throw ownSecretEnded(behaviour.mayEndOwnSecret, error);
        }
        if (mayHaveRun(error)) earlierAttemptMayHaveRun = true;
        if (attempt > retries || !error.retryable || init.signal?.aborted) throw error;
        const delay = retryDelayMs(attempt, this.retryBaseDelayMs, error.retryAfterSeconds);
        if (delay === null) throw error;
        try {
          await sleep(delay, init.signal);
        } catch {
          throw abortedError(init.signal);
        }
      }
    }
  }

  /** One HTTP attempt. */
  private async send<T>(
    method: string,
    url: URL,
    body: unknown,
    idempotencyKey: string | null,
    userSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (userSignal?.aborted) throw abortedError(userSignal);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers({
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      throw transportError(error, userSignal, timeout);
    }
    const requestId = response.headers.get("x-request-id");
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw transportError(error, userSignal, timeout);
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new KletiaApiError({
          code: "INVALID_RESPONSE",
          message: "The Kletia API returned a non-JSON response.",
          status: response.status,
          requestId,
          retryAfterSeconds: retryAfterSeconds(response),
        });
      }
    }
    if (!response.ok) {
      throw errorFromResponse(response, parsed, `Request failed with status ${response.status}.`);
    }
    return parsed as T;
  }

  health(options: RequestOptions = {}): Promise<HealthReport> {
    return this.request<HealthReport>("GET", "/health", undefined, options);
  }

  async networks(options: RequestOptions = {}): Promise<NetworkCapabilities[]> {
    const body = await this.request<{ networks: NetworkCapabilities[] }>("GET", "/networks", undefined, options);
    return body.networks;
  }

  async protocols(options: RequestOptions = {}): Promise<ProtocolDescriptor[]> {
    const body = await this.request<{ protocols: ProtocolDescriptor[] }>("GET", "/protocols", undefined, options);
    return body.protocols;
  }

  async assets(network?: NetworkKey, options: RequestOptions = {}): Promise<AssetDescriptor[]> {
    const body = await this.request<{ assets: AssetDescriptor[] }>("GET", "/assets", undefined, {
      ...options,
      query: { network },
    });
    return body.assets;
  }

  /** EVM lending venues with supply APY, size and exit liquidity (`GET /v1/venues`), optionally filtered. */
  venues(
    filter: { readonly network?: NetworkKey; readonly protocol?: ProtocolId } = {},
    options: RequestOptions = {},
  ): Promise<VenuesResponse> {
    return this.request<VenuesResponse>("GET", "/venues", undefined, {
      ...options,
      query: { network: filter.network, protocol: filter.protocol },
    });
  }

  /** Best routes for one movement. Read-only, so it is retried like a GET. */
  quote(request: QuoteRequest, options: RequestOptions = {}): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/quotes", request, options);
  }

  portfolio(accountId: string, options: RequestOptions = {}): Promise<PortfolioResponse> {
    return this.request<PortfolioResponse>("GET", `/portfolio/${encodeSegment(accountId, "accountId")}`, undefined, options);
  }

  /** The error catalog (`GET /v1/errors`), the same table as `ERROR_CATALOG` in `@kletia/core`. */
  errors(options: RequestOptions = {}): Promise<ErrorCatalogResponse> {
    return this.request<ErrorCatalogResponse>("GET", "/errors", undefined, options);
  }

  /** Request counts, the live rate-limit window and intents of the calling key (key required). */
  usage(options: RequestOptions & { readonly window?: UsageWindow } = {}): Promise<UsageReport> {
    const { window, ...rest } = options;
    return this.request<UsageReport>("GET", "/usage", undefined, { ...rest, query: { window } });
  }

  /** The OpenAPI 3.1 document of this API. */
  openApi(options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/openapi.json", undefined, options);
  }

  readonly intents = {
    /**
     * Plan an intent into an executable graph. With an API key the call
     * carries an Idempotency-Key (generated unless given), so a retry after a
     * lost response returns the same intent instead of planning a second one.
     */
    create: async (
      request: IntentRequest,
      options: CreateIntentOptions & RequestOptions = {},
    ): Promise<IntentGraph> => {
      const { dryRun, ...rest } = options;
      const body = await this.request<{ intent: IntentGraph }>("POST", "/intents", request, {
        ...rest,
        query: { dryRun: dryRun ? "true" : undefined },
      });
      return body.intent;
    },
    get: async (id: string, options: RequestOptions = {}): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("GET", `/intents/${encodeSegment(id, "id")}`, undefined, options);
      return body.intent;
    },
    list: async (limit = 20, options: RequestOptions = {}): Promise<IntentGraph[]> => {
      const body = await this.request<{ intents: IntentGraph[] }>("GET", "/intents", undefined, {
        ...options,
        query: { limit: String(limit) },
      });
      return body.intents;
    },
    /**
     * Build wallet-ready transactions for a ready step. Never retried and
     * never sent with an Idempotency-Key: each call builds fresh transactions.
     */
    prepareStep: (id: string, stepId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<PreparedStep> =>
      this.request<PreparedStep>(
        "POST",
        `/intents/${encodeSegment(id, "id")}/steps/${encodeSegment(stepId, "stepId")}/prepare`,
        {},
        options.signal ? { signal: options.signal } : {},
      ),
    /** Report transaction hashes / signatures, in payload order, for on-chain verification. */
    submitStep: async (
      id: string,
      stepId: string,
      references: readonly string[],
      options: RequestOptions = {},
    ): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>(
        "POST",
        `/intents/${encodeSegment(id, "id")}/steps/${encodeSegment(stepId, "stepId")}/submit`,
        { references },
        options,
      );
      return body.intent;
    },
    refresh: async (id: string, options: RequestOptions = {}): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("POST", `/intents/${encodeSegment(id, "id")}/refresh`, {}, options);
      return body.intent;
    },
    cancel: async (id: string, options: RequestOptions = {}): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("POST", `/intents/${encodeSegment(id, "id")}/cancel`, {}, options);
      return body.intent;
    },
    /**
     * Stream intent events (Server-Sent Events over fetch, so it works in
     * browsers, Node 20+ and edge runtimes). Resolves when the stream ends
     * (the API closes streams after 30 minutes; reconnect with `lastEventId`)
     * or the signal aborts.
     */
    stream: async (
      id: string,
      onEvent: (event: AnyKletiaEvent) => void,
      options: StreamOptions = {},
    ): Promise<void> => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/intents/${encodeSegment(id, "id")}/events`, {
          method: "GET",
          headers: this.headers({
            accept: "text/event-stream",
            ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
          }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        throw transportError(error, options.signal);
      }
      if (!response.ok) {
        // Same error envelope as every other endpoint (TOO_MANY_STREAMS, INTENT_NOT_FOUND, …).
        const text = await response.text().catch(() => "");
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        throw errorFromResponse(response, parsed, "Event stream could not be opened.");
      }
      if (!response.body) {
        throw new KletiaApiError({
          code: `HTTP_${response.status}`,
          message: "Event stream could not be opened.",
          status: response.status,
          requestId: response.headers.get("x-request-id"),
        });
      }
      options.onOpen?.();
      const body = response.body;
      const messages = readServerSentEvents(body, options.signal);
      let ended = false;
      try {
        while (true) {
          let next: IteratorResult<{ readonly data: string }>;
          try {
            next = await messages.next();
          } catch (error) {
            if (options.signal?.aborted) return;
            // A dropped connection mid-stream; reconnect with the last event id.
            throw transportError(error, options.signal);
          }
          if (next.done) {
            ended = true;
            return;
          }
          if (!next.value.data) continue;
          let event: AnyKletiaEvent;
          try {
            event = JSON.parse(next.value.data) as AnyKletiaEvent;
          } catch {
            // Ignore malformed frames; the server only sends JSON envelopes.
            continue;
          }
          // Errors thrown by the callback reach the caller unchanged.
          onEvent(event);
        }
      } finally {
        if (!ended) {
          // Stopped early (abort or a throwing callback): close the connection.
          await messages.return(undefined).catch(() => undefined);
          await body.cancel().catch(() => undefined);
        }
      }
    },
    /**
     * Resolves with the intent once it reaches a terminal status (completed,
     * partially_completed, failed, expired or cancelled). Follows the event
     * stream, resuming with Last-Event-ID, and falls back to polling
     * `refresh` while the stream is unavailable. Rejects with `WAIT_TIMEOUT`
     * after `timeoutMs` and with `REQUEST_ABORTED` when `signal` aborts.
     */
    wait: async (id: string, options: WaitForIntentOptions = {}): Promise<IntentGraph> => {
      const { timeoutMs = 20 * 60_000, signal, ...rest } = options;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        return await watchIntent(this, id, { ...rest, signal: controller.signal });
      } catch (error) {
        if (timedOut) {
          throw new KletiaApiError({
            code: "WAIT_TIMEOUT",
            message: `Intent ${id} did not reach a terminal status within ${Math.round(timeoutMs / 1000)} s.`,
            status: 0,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  readonly webhooks = {
    /** Register a webhook. The signing secret is returned once, in `secret`. */
    create: async (
      input: { url: string; events?: readonly string[] },
      options: RequestOptions = {},
    ): Promise<WebhookRecord> => {
      const body = await this.request<{ webhook: WebhookRecord }>("POST", "/webhooks", input, options);
      return body.webhook;
    },
    list: async (options: RequestOptions = {}): Promise<WebhookRecord[]> => {
      const body = await this.request<{ webhooks: WebhookRecord[] }>("GET", "/webhooks", undefined, options);
      return body.webhooks;
    },
    /** Delete a webhook and its delivery log. */
    delete: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.call("DELETE", `/webhooks/${encodeSegment(id, "id")}`, undefined, options, { goneAfterRetryIsDone: true });
    },
    /**
     * Send a signed `webhook.test` event to the endpoint now and return the
     * delivery, whatever the endpoint answered. Not retried (each call sends
     * one more event; the API allows 5 per minute per webhook).
     */
    test: async (id: string, options: RequestOptions = {}): Promise<WebhookDelivery> => {
      const body = await this.request<{ delivery: WebhookDelivery }>("POST", `/webhooks/${encodeSegment(id, "id")}/test`, {}, options);
      return body.delivery;
    },
    /** Newest delivery attempts first (`limit` 1-100, default 20). */
    deliveries: async (
      id: string,
      options: RequestOptions & { readonly limit?: number } = {},
    ): Promise<WebhookDelivery[]> => {
      const { limit, ...rest } = options;
      const body = await this.request<{ deliveries: WebhookDelivery[] }>(
        "GET",
        `/webhooks/${encodeSegment(id, "id")}/deliveries`,
        undefined,
        { ...rest, query: { limit: limit === undefined ? undefined : String(limit) } },
      );
      return body.deliveries;
    },
  };

  readonly keys = {
    /**
     * Issue a developer key. The raw key is returned only once. Without an
     * API key this starts a new project; with a developer key it adds a key to
     * the caller's project (at most 5 active).
     */
    create: async (name: string, options: RequestOptions = {}): Promise<ApiKeyRecord> => {
      const body = await this.request<{ key: ApiKeyRecord }>("POST", "/keys", { name }, options);
      return body.key;
    },
    /** The keys of the caller's project. Secrets are never listed. */
    list: async (options: RequestOptions = {}): Promise<ApiKeySummary[]> => {
      const body = await this.request<{ keys: ApiKeySummary[] }>("GET", "/keys", undefined, options);
      return body.keys;
    },
    /**
     * New secret for a key, same id. The previous secret keeps authenticating
     * for `graceSeconds` (API default 86400; 0 ends it now) but cannot manage
     * keys. A key rotating itself with `graceSeconds: 0` cannot get a lost
     * response back (its secret stops authenticating at once): the call then
     * rejects with `OUTCOME_UNKNOWN`. Rotate a key from another key of the
     * project to avoid that.
     */
    rotate: async (
      id: string,
      options: RequestOptions & { readonly graceSeconds?: number } = {},
    ): Promise<RotatedApiKey> => {
      const { graceSeconds, ...rest } = options;
      const body = await this.call<{ key: RotatedApiKey }>(
        "POST",
        `/keys/${encodeSegment(id, "id")}/rotate`,
        graceSeconds === undefined ? {} : { graceSeconds },
        rest,
        { mayEndOwnSecret: "rotate" },
      );
      return body.key;
    },
    /**
     * Revoke a key (idempotent). A key may revoke itself; when the response to
     * that is lost, the retry is refused and the call rejects with
     * `OUTCOME_UNKNOWN` (the key is revoked).
     */
    revoke: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.call("DELETE", `/keys/${encodeSegment(id, "id")}`, undefined, options, { mayEndOwnSecret: "revoke" });
    },
  };
}
