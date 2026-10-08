import type {
  AnyKletiaEvent,
  AssetDescriptor,
  IntentGraph,
  IntentRequest,
  NetworkKey,
  ProtocolDescriptor,
} from "@kletia/core";
import { KletiaApiError, type ApiIssue } from "./errors.js";
import { readServerSentEvents } from "./sse.js";
import type {
  ApiKeyRecord,
  CreateIntentOptions,
  HealthReport,
  NetworkCapabilities,
  PortfolioResponse,
  PreparedStep,
  QuoteRequest,
  QuoteResponse,
  WebhookRecord,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.kletiaai.xyz";
export const SDK_VERSION = "0.1.0";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KletiaClientOptions {
  /** API origin, without the `/v1` suffix. Defaults to the hosted Kletia API. */
  readonly baseUrl?: string;
  /** Developer or operator key (`kl_dev_…`). Optional for public endpoints. */
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds (default 20000). */
  readonly timeoutMs?: number;
  /** Custom fetch implementation (tests, edge runtimes, proxies). */
  readonly fetch?: FetchLike;
  /** Extra headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StreamOptions {
  readonly signal?: AbortSignal;
  /** Resume after this event id (sent as Last-Event-ID). */
  readonly lastEventId?: string;
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

function encodeSegment(value: string, name: string): string {
  if (!value || value.length > 200) throw new Error(`${name} is required.`);
  return encodeURIComponent(value);
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
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: KletiaClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    const fallback = (globalThis as { fetch?: FetchLike }).fetch;
    const fetchImpl = options.fetch ?? (fallback ? fallback.bind(globalThis) : undefined);
    if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
    this.fetchImpl = fetchImpl;
    this.extraHeaders = options.headers ?? {};
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

  /** Low-level request helper. Returns the parsed JSON body. */
  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    init: { signal?: AbortSignal; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === "TimeoutError" || timeout.aborted;
      throw new KletiaApiError({
        code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        message: timedOut ? "The Kletia API did not respond in time." : "The Kletia API is unreachable.",
        status: 0,
      });
    }
    const requestId = response.headers.get("x-request-id");
    const text = await response.text();
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
        });
      }
    }
    if (!response.ok) {
      const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
      throw new KletiaApiError({
        code: typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
        message: typeof error.message === "string" ? error.message : `Request failed with status ${response.status}.`,
        status: response.status,
        issues: Array.isArray(error.issues) ? (error.issues as ApiIssue[]) : [],
        requestId,
      });
    }
    return parsed as T;
  }

  health(): Promise<HealthReport> {
    return this.request<HealthReport>("GET", "/health");
  }

  async networks(): Promise<NetworkCapabilities[]> {
    const body = await this.request<{ networks: NetworkCapabilities[] }>("GET", "/networks");
    return body.networks;
  }

  async protocols(): Promise<ProtocolDescriptor[]> {
    const body = await this.request<{ protocols: ProtocolDescriptor[] }>("GET", "/protocols");
    return body.protocols;
  }

  async assets(network?: NetworkKey): Promise<AssetDescriptor[]> {
    const body = await this.request<{ assets: AssetDescriptor[] }>("GET", "/assets", undefined, {
      query: { network },
    });
    return body.assets;
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/quotes", request);
  }

  portfolio(accountId: string): Promise<PortfolioResponse> {
    return this.request<PortfolioResponse>("GET", `/portfolio/${encodeSegment(accountId, "accountId")}`);
  }

  readonly intents = {
    /** Plan an intent into an executable graph. */
    create: async (request: IntentRequest, options: CreateIntentOptions = {}): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("POST", "/intents", request, {
        query: { dryRun: options.dryRun ? "true" : undefined },
      });
      return body.intent;
    },
    get: async (id: string): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("GET", `/intents/${encodeSegment(id, "id")}`);
      return body.intent;
    },
    list: async (limit = 20): Promise<IntentGraph[]> => {
      const body = await this.request<{ intents: IntentGraph[] }>("GET", "/intents", undefined, {
        query: { limit: String(limit) },
      });
      return body.intents;
    },
    /** Build wallet-ready transactions for a ready step. */
    prepareStep: (id: string, stepId: string): Promise<PreparedStep> =>
      this.request<PreparedStep>(
        "POST",
        `/intents/${encodeSegment(id, "id")}/steps/${encodeSegment(stepId, "stepId")}/prepare`,
        {},
      ),
    /** Report transaction hashes / signatures, in payload order, for on-chain verification. */
    submitStep: async (id: string, stepId: string, references: readonly string[]): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>(
        "POST",
        `/intents/${encodeSegment(id, "id")}/steps/${encodeSegment(stepId, "stepId")}/submit`,
        { references },
      );
      return body.intent;
    },
    refresh: async (id: string): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("POST", `/intents/${encodeSegment(id, "id")}/refresh`, {});
      return body.intent;
    },
    cancel: async (id: string): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("POST", `/intents/${encodeSegment(id, "id")}/cancel`, {});
      return body.intent;
    },
    /**
     * Stream intent events (Server-Sent Events over fetch, so it works in
     * browsers, Node 20+ and edge runtimes). Resolves when the stream ends.
     */
    stream: async (
      id: string,
      onEvent: (event: AnyKletiaEvent) => void,
      options: StreamOptions = {},
    ): Promise<void> => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/intents/${encodeSegment(id, "id")}/events`, {
        method: "GET",
        headers: this.headers({
          accept: "text/event-stream",
          ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok || !response.body) {
        throw new KletiaApiError({
          code: `HTTP_${response.status}`,
          message: "Event stream could not be opened.",
          status: response.status,
          requestId: response.headers.get("x-request-id"),
        });
      }
      for await (const message of readServerSentEvents(response.body, options.signal)) {
        if (!message.data) continue;
        try {
          onEvent(JSON.parse(message.data) as AnyKletiaEvent);
        } catch {
          // Ignore malformed frames; the server only sends JSON envelopes.
        }
      }
    },
  };

  readonly webhooks = {
    create: async (input: { url: string; events?: readonly string[] }): Promise<WebhookRecord> => {
      const body = await this.request<{ webhook: WebhookRecord }>("POST", "/webhooks", input);
      return body.webhook;
    },
    list: async (): Promise<WebhookRecord[]> => {
      const body = await this.request<{ webhooks: WebhookRecord[] }>("GET", "/webhooks");
      return body.webhooks;
    },
    delete: async (id: string): Promise<void> => {
      await this.request("DELETE", `/webhooks/${encodeSegment(id, "id")}`);
    },
  };

  readonly keys = {
    /** Issue a developer key. The raw key is returned only once. */
    create: async (name: string): Promise<ApiKeyRecord> => {
      const body = await this.request<{ key: ApiKeyRecord }>("POST", "/keys", { name });
      return body.key;
    },
  };
}
