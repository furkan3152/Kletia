import {
  dataHistoryCsv,
  dataHoldingsCsv,
  dataPositionsCsv,
  dataTransactionsCsv,
  isThreadId,
  PREVIEW_DIGEST_PATTERN,
  PUBLISHABLE_KEY_PATTERN,
  validateLinkDefinition,
  type AccountId,
  type AnyKletiaEvent,
  type AssetDescriptor,
  type AssistantAnswer,
  type AssistantAskRequest,
  type ContractDefinition,
  type ContractInspection,
  type ContractTestRequest,
  type ContractTestResult,
  type ContractView,
  type DataExportDataset,
  type DataHistory,
  type DataMarketStatus,
  type DataPortfolio,
  type DataPnl,
  type DataPnlPeriod,
  type DataPositions,
  type DataPrices,
  type DataSnapshotRange,
  type DataSnapshotSeries,
  type DataSummary,
  type DataTransaction,
  type DataTransactionPage,
  type DataTxQuery,
  type DataYields,
  type IntentGraph,
  type IntentPreview,
  type IntentRequest,
  type IntentTurnRequest,
  type Journey,
  type LinkOwnerView,
  type LinkStats,
  type LinkView,
  type NetworkKey,
  type PolicyDecision,
  type PolicyDefaults,
  type PolicyDocument,
  type ProtocolDescriptor,
  type ProjectProfile,
  type ProjectView,
  type ProtocolId,
  type SessionCreateRequest,
  type SessionView,
} from "@kletia/core";
import { KletiaApiError } from "./errors.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  newIdempotencyKey,
  retryDelayMs,
  sleep,
} from "./retry.js";
import {
  decideWithWallet,
  type ApprovalWalletSigner,
  type WalletDecisionOptions,
} from "./approvals.js";
import { readServerSentEvents } from "./sse.js";
import type {
  ApiKeyRecord,
  ApiKeySummary,
  CreateChildKeyRequest,
  CreatedChildKey,
  IntentWithPreview,
  LinkIntentResponse,
  LinkPatch,
  LinkVisitorRequest,
  PolicyApprovalFilter,
  PolicyApprovalView,
  PolicyDecisionFilter,
  PolicyDecisionList,
  PolicyEvaluateRequest,
  PolicyEvaluateResponse,
  PolicyReadResponse,
  PolicySpendReport,
  PolicyValidateResponse,
  PolicyVersionView,
  PolicyWriteResponse,
  PrepareStepOptions,
  ReceiptKeySet,
  ReceiptListEntry,
  ReceiptLogBatchResponse,
  ReceiptLogBatchView,
  ReceiptResult,
  ReceiptShare,
  ReceiptShareCiphertext,
  ReceiptShareRequest,
  ReceiptDocumentView,
  ContractDefinitionPatch,
  ContractInspectQuery,
  ContractListFilter,
  ContractRegistration,
  ContractWithRevisions,
  CreateIntentOptions,
  CreateKeyOptions,
  ErrorCatalogResponse,
  IntentListFilter,
  IntentTurnOptions,
  IntentTurnResult,
  IntentWithJourney,
  JourneyOptions,
  PortfolioOptions,
  DataPricesFilter,
  DataWalletQuery,
  DataYieldsFilter,
  PortfoliosResponse,
  ProjectLogoContentType,
  ProjectSettingsPatch,
  PublishableKeyRecord,
  StoppedIntent,
  ThreadDetail,
  ThreadList,
  ThreadListFilter,
  HttpMethod,
  HealthReport,
  NetworkCapabilities,
  PortfolioResponse,
  PreparedStep,
  QuoteRequest,
  QuoteResponse,
  RequestOptions,
  RotatedApiKey,
  SessionIntentInput,
  SessionIntentResponse,
  UsageReport,
  UsageWindow,
  VenuesResponse,
  WebhookDelivery,
  WebhookRecord,
} from "./types.js";
import { watchIntent } from "./watch.js";
import type {
  CallBehaviour,
  CreateIntent,
  EventStreamOptions,
  FetchLike,
  GetReceiptOptions,
  KletiaClientOptions,
  LowLevelRequestOptions,
  StreamOptions,
  WaitForIntentOptions,
} from "./client/options.js";
import {
  abortedError,
  approvalSegment,
  contractSegment,
  encodeSegment,
  errorFromResponse,
  ifMatchHeader,
  linkSegment,
  mayHaveRun,
  normalizeBaseUrl,
  ownSecretEnded,
  RawBody,
  receiptSegment,
  retryAfterSeconds,
  sessionSegment,
  shareSegment,
  threadSegment,
  transportError,
} from "./client/http.js";
import {
  fetchPng,
  pageOrigin,
  publishableRefusal,
  RECEIPT_WAIT_CODES,
  requestRetryClass,
  retriesOption,
  turnRetryClass,
  walletQuery,
} from "./client/routes.js";

export type {
  CreateIntent,
  EventStreamOptions,
  GetReceiptOptions,
  KletiaClientOptions,
  LowLevelRequestOptions,
  ReceiptPendingInfo,
  StreamOptions,
  WaitForIntentOptions,
} from "./client/options.js";
export { turnRetryClass } from "./client/routes.js";

export const DEFAULT_BASE_URL = "https://api.kletiaai.xyz";
/** Origin of the Kletia web app (link pages, receipt pages, approval pages). */
export const DEFAULT_WEB_ORIGIN = "https://kletiaai.xyz";
export const SDK_VERSION = "0.1.0";

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
  private readonly publishableKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  /** Origin of the web app for page and card URLs. */
  readonly webOrigin: string;

  constructor(options: KletiaClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    if (options.publishableKey !== undefined) {
      if (options.apiKey) throw new TypeError("Pass either apiKey (server) or publishableKey (browser), not both.");
      if (!PUBLISHABLE_KEY_PATTERN.test(options.publishableKey)) {
        throw new TypeError("publishableKey must be a publishable key (kl_pub_ followed by 32 letters and digits); secret keys never go in browser code.");
      }
    }
    this.apiKey = options.apiKey;
    this.publishableKey = options.publishableKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = retriesOption(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    const fallback = (globalThis as { fetch?: FetchLike }).fetch;
    const fetchImpl = options.fetch ?? (fallback ? fallback.bind(globalThis) : undefined);
    if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
    this.fetchImpl = fetchImpl;
    this.extraHeaders = options.headers ?? {};
    this.webOrigin = new URL(options.webOrigin ?? DEFAULT_WEB_ORIGIN).origin;
  }

  /** True when the client sends an API key (idempotency keys are generated only then; never for a publishable key). */
  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  /** True when the client sends a publishable key (`kl_pub_…`). */
  get hasPublishableKey(): boolean {
    return Boolean(this.publishableKey);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const key = this.apiKey ?? this.publishableKey;
    return {
      accept: "application/json",
      "x-kletia-sdk": `js/${SDK_VERSION}`,
      ...this.extraHeaders,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extra,
    };
  }

  /** With a publishable key, server-only calls are refused here: nothing is sent. */
  private assertAllowed(method: string, path: string, body: unknown): void {
    if (!this.publishableKey) return;
    const refusal = publishableRefusal(method, path, body);
    if (refusal) {
      throw new KletiaApiError({ code: "PUBLISHABLE_KEY_FORBIDDEN", message: `${refusal} (Refused by the SDK; nothing was sent.)`, status: 0 });
    }
  }

  /**
   * Low-level request helper. Returns the parsed JSON body (null for an
   * empty one). Retries follow the policy in `retry.ts` (plus the contract
   * and session routes): safe requests and state-changing requests that carry
   * an Idempotency-Key are repeated on network errors, timeouts, 429 and
   * retryable codes; prepare never is.
   */
  request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    init: LowLevelRequestOptions = {},
  ): Promise<T> {
    return this.call<T>(method, path, body, init, {});
  }

  private async call<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    init: LowLevelRequestOptions,
    behaviour: CallBehaviour,
  ): Promise<T> {
    this.assertAllowed(method, path, body instanceof RawBody ? undefined : body);
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const kind = behaviour.retryClass ?? requestRetryClass(method, path, init.query);
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
        return await this.send<T>(method, url, body, idempotencyKey, init.signal, init.headers);
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
        if (behaviour.noRetryCodes?.has(error.code)) throw error;
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
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    if (userSignal?.aborted) throw abortedError(userSignal);
    const own = Object.fromEntries(
      Object.entries(extraHeaders).filter(([name]) => !["authorization", "idempotency-key", "content-type"].includes(name.toLowerCase())),
    );
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
    const contentType = body === undefined ? null : body instanceof RawBody ? body.contentType : "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers({
          ...own,
          ...(contentType ? { "content-type": contentType } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        }),
        ...(body === undefined ? {} : { body: body instanceof RawBody ? new Uint8Array(body.bytes) : JSON.stringify(body) }),
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

  /**
   * Opens a Server-Sent Events stream and calls `onEvent` with each JSON
   * envelope until the stream ends, the signal aborts or the callback throws.
   */
  private async openEventStream(
    path: string,
    query: Readonly<Record<string, string | undefined>>,
    onEvent: (event: AnyKletiaEvent) => void,
    options: StreamOptions,
  ): Promise<void> {
    this.assertAllowed("GET", path, undefined);
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
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

  /** Holdings of one account (`positions: true` adds venue positions). */
  portfolio(accountId: string, options: RequestOptions & PortfolioOptions = {}): Promise<PortfolioResponse> {
    const { positions, ...rest } = options;
    return this.request<PortfolioResponse>("GET", `/portfolio/${encodeSegment(accountId, "accountId")}`, undefined, {
      ...rest,
      query: { positions: positions ? "true" : undefined },
    });
  }

  /**
   * Holdings of up to 12 accounts in one request (`GET /v1/portfolio?accounts=`),
   * in request order; an account that cannot be read is listed in `failures`.
   */
  portfolios(accounts: readonly (AccountId | string)[], options: RequestOptions & PortfolioOptions = {}): Promise<PortfoliosResponse> {
    if (accounts.length === 0 || accounts.length > 12) throw new RangeError("portfolios takes 1 to 12 accounts.");
    if (accounts.some((account) => typeof account !== "string" || !account || account.includes(","))) throw new TypeError("Accounts are CAIP-10 ids.");
    const { positions, ...rest } = options;
    return this.request<PortfoliosResponse>("GET", "/portfolio", undefined, {
      ...rest,
      query: { accounts: accounts.join(","), positions: positions ? "true" : undefined },
    });
  }

  /**
   * Dashboard data (`/v1/data/*`), read-only: a wallet set's holdings,
   * positions, health and activity across every network, plus venue yields,
   * prices and network status. Every value carries `source` and `asOf`;
   * unknown values are null with a `reason`. Publishable keys may call all
   * of them; `history` needs a key.
   */
  readonly data = {
    /** Holdings, positions, debts, totals, allocation and the value estimates of the wallets. */
    portfolio: async (wallets: DataWalletQuery, options: RequestOptions = {}): Promise<DataPortfolio> => {
      const body = await this.request<{ portfolio: DataPortfolio }>("GET", "/data/portfolio", undefined, { ...options, query: walletQuery(wallets, true) });
      return body.portfolio;
    },
    /** Positions, debts and lending health of the wallets; `extras` adds perps, open orders, automations and agent spend. */
    positions: async (wallets: DataWalletQuery & { readonly extras?: boolean }, options: RequestOptions = {}): Promise<DataPositions> => {
      const { extras, ...set } = wallets;
      return this.request<DataPositions>("GET", "/data/positions", undefined, { ...options, query: { ...walletQuery(set, true), extras: extras ? "true" : undefined } });
    },
    /**
     * On-chain history of the wallets (needs a key), newest first, classified and priced at the time.
     * Pass `cursor` from the previous page for older rows; `coverage` says which accounts were read.
     */
    transactions: (query: DataWalletQuery & Omit<DataTxQuery, "kletiaOnly"> & { readonly kletiaOnly?: boolean }, options: RequestOptions = {}): Promise<DataTransactionPage> => {
      const { evm, solana, lane, kletiaOnly, limit, ...filters } = query;
      return this.request<DataTransactionPage>("GET", "/data/transactions", undefined, {
        ...options,
        query: { ...walletQuery({ evm, solana, lane }, true), ...filters, kletiaOnly: kletiaOnly ? "true" : undefined, limit: limit === undefined ? undefined : String(limit) },
      });
    },
    /** One transaction (`<network>:<hash>`) of the wallets. */
    transaction: async (id: string, wallets: DataWalletQuery, options: RequestOptions = {}): Promise<DataTransaction> => {
      const body = await this.request<{ transaction: DataTransaction }>("GET", `/data/transactions/${encodeSegment(id, "id")}`, undefined, { ...options, query: walletQuery(wallets, true) });
      return body.transaction;
    },
    /** FIFO realized and unrealized PnL estimates by asset over `period` (default all). */
    pnl: (query: DataWalletQuery & { readonly period?: DataPnlPeriod }, options: RequestOptions = {}): Promise<DataPnl> => {
      const { period, ...wallets } = query;
      return this.request<DataPnl>("GET", "/data/pnl", undefined, { ...options, query: { ...walletQuery(wallets, true), period } });
    },
    /** Value series of a tracked set (untracked wallets: an empty series with `tracked: false`). */
    snapshots: (query: DataWalletQuery & { readonly range?: DataSnapshotRange }, options: RequestOptions = {}): Promise<DataSnapshotSeries> => {
      const { range, ...wallets } = query;
      return this.request<DataSnapshotSeries>("GET", "/data/snapshots", undefined, { ...options, query: { ...walletQuery(wallets, true), range } });
    },
    /** One compact object for an assistant: totals, top positions, risk flags, activity counts and PnL estimates. */
    summary: async (wallets: DataWalletQuery, options: RequestOptions = {}): Promise<DataSummary> => {
      const body = await this.request<{ summary: DataSummary }>("GET", "/data/summary", undefined, { ...options, query: walletQuery(wallets, true) });
      return body.summary;
    },
    /** The calling key's intents, receipts and links, newest first; with wallets, only intents planned for them. */
    history: async (filter: DataWalletQuery & { readonly limit?: number } = {}, options: RequestOptions = {}): Promise<DataHistory> => {
      const { limit, ...wallets } = filter;
      return this.request<DataHistory>("GET", "/data/history", undefined, {
        ...options,
        query: { ...walletQuery(wallets, false), lane: undefined, limit: limit === undefined ? undefined : String(limit) },
      });
    },
    /** Supply APYs of every venue, best first (unread rates last, null with a reason). */
    yields: (filter: DataYieldsFilter = {}, options: RequestOptions = {}): Promise<DataYields> =>
      this.request<DataYields>("GET", "/data/markets/yields", undefined, { ...options, query: { network: filter.network, asset: filter.asset, lane: filter.lane } }),
    /** USD prices of listed assets with source and reading time. */
    prices: async (filter: DataPricesFilter = {}, options: RequestOptions = {}): Promise<DataPrices> => {
      if (filter.symbols && (filter.symbols.length > 20 || filter.symbols.some((symbol) => !symbol || symbol.includes(",")))) throw new RangeError("prices takes 1 to 20 symbols.");
      return this.request<DataPrices>("GET", "/data/markets/prices", undefined, {
        ...options,
        query: { symbols: filter.symbols?.join(","), network: filter.network, lane: filter.lane },
      });
    },
    /** Network status, and route statistics when the deployment records them. */
    status: (options: RequestOptions = {}): Promise<DataMarketStatus> => this.request<DataMarketStatus>("GET", "/data/markets/status", undefined, options),
    /**
     * A dataset as CSV, built here from the JSON read with the same columns
     * and escaping as `GET /v1/data/export?format=csv`. `history` and `transactions` need a key.
     */
    exportCsv: async (dataset: DataExportDataset, query: DataWalletQuery & { readonly limit?: number } = {}, options: RequestOptions = {}): Promise<string> => {
      if (dataset === "history") return dataHistoryCsv(await this.data.history(query, options));
      if (dataset === "transactions") return dataTransactionsCsv(await this.data.transactions(query, options));
      const portfolio = await this.data.portfolio(query, options);
      return dataset === "holdings" ? dataHoldingsCsv(portfolio) : dataPositionsCsv(portfolio);
    },
  };

  /**
   * The portfolio assistant (`POST /v1/assistant/ask`): a question about the
   * user's own wallets answered from Kletia's data. Every number in
   * `answer.text` is one of `answer.facts` (with source and reading time); a
   * portfolio request that wants action returns `answer.action.sentences` to
   * plan with `intents.create`, which the user confirms and signs. Needs a
   * project or agent key and `wallets`.
   */
  readonly assistant = {
    ask: async (request: AssistantAskRequest, options: RequestOptions = {}): Promise<AssistantAnswer> => {
      if (typeof request.question !== "string" || request.question.trim().length === 0 || request.question.length > 500) throw new RangeError("question takes 1 to 500 characters.");
      const body = await this.request<{ answer: AssistantAnswer }>("POST", "/assistant/ask", request, options);
      return body.answer;
    },
  };

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
     * With `preview: true` it resolves with `{ intent, preview }`: the
     * plan-stage asset-change preview ("fare breakdown").
     */
    create: (async (request: IntentRequest, options: CreateIntentOptions & RequestOptions = {}): Promise<IntentGraph | IntentWithPreview | IntentWithJourney> => {
      const { dryRun, preview, journey, journeyReads, ...rest } = options;
      const body = await this.request<{ intent: IntentGraph; preview?: IntentPreview; journey?: Journey | null }>("POST", "/intents", request, {
        ...rest,
        query: {
          dryRun: dryRun ? "true" : undefined,
          // The journey is built on the plan-stage preview, so it implies one.
          preview: preview || journey ? "true" : undefined,
          journey: journey ? "true" : undefined,
          journeyReads: journey && journeyReads ? journeyReads : undefined,
        },
      });
      if (journey) return { intent: body.intent, preview: body.preview ?? null, journey: body.journey ?? null };
      return preview ? { intent: body.intent, preview: body.preview ?? null } : body.intent;
    }) as CreateIntent,
    /**
     * One clarify turn (`POST /v1/intents?clarify=true`): `needs_input` with
     * questions, `planned` with the intent (stored unless `dryRun`), or
     * `cancelled`; narrow on `status`. Send the returned `thread` back (or
     * `threadId` for a Kletia-held one) with an `answer` to continue; a turn
     * with the ready thread and no input is the commit. Retries follow
     * `turnRetryClass`.
     */
    turn: async (request: IntentTurnRequest, options: IntentTurnOptions & RequestOptions = {}): Promise<IntentTurnResult> => {
      const { dryRun, preview, journey, ...rest } = options;
      if (request.thread !== undefined && request.threadId !== undefined) throw new TypeError("Send either thread (client-held) or threadId (Kletia-held), not both.");
      if (request.threadId !== undefined && !isThreadId(request.threadId)) throw new TypeError("Thread ids look like th_ followed by 24 base32 characters.");
      return this.call<IntentTurnResult>(
        "POST",
        "/intents",
        request,
        {
          ...rest,
          query: {
            clarify: "true",
            dryRun: dryRun ? "true" : undefined,
            preview: preview || journey ? "true" : undefined,
            journey: journey ? "true" : undefined,
          },
        },
        { retryClass: turnRetryClass(request, { dryRun: dryRun === true }) },
      );
    },
    /**
     * A model-assisted reading consent (`POST /v1/reading-consent`), for
     * browser integrations only (a publishable key of a project with
     * `modelReading: "enabled"`): `once` for one message, `confirm` when the
     * person clicked "Yes, plan it" on a model reading. Server keys are
     * refused (CONFIRM_AUTHORITY_REQUIRED): an agent never consents or
     * confirms for the person. Send the token as `consent` on the next turn.
     */
    readingConsent: async (
      request: { readonly scope: "once" | "session" | "confirm"; readonly wallet: string; readonly text?: string; readonly threadId?: string },
      options: RequestOptions = {},
    ): Promise<{ token: string; expiresAt: string; scope: "once" | "session" | "confirm" }> =>
      this.request("POST", "/reading-consent", request, options),
    get: async (id: string, options: RequestOptions = {}): Promise<IntentGraph> => {
      const body = await this.request<{ intent: IntentGraph }>("GET", `/intents/${encodeSegment(id, "id")}`, undefined, options);
      return body.intent;
    },
    /**
     * Intents created with this key, newest first: `list(20)` or
     * `list({ limit, owner })` (`owner`: an agent or publishable key of the
     * caller's subtree).
     */
    list: async (limitOrFilter: number | IntentListFilter = 20, options: RequestOptions = {}): Promise<IntentGraph[]> => {
      const filter: IntentListFilter = typeof limitOrFilter === "number" ? { limit: limitOrFilter } : limitOrFilter;
      const limit = filter.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer between 1 and 100.");
      if (filter.owner !== undefined && (!filter.owner || filter.owner.length > 200)) throw new TypeError("owner must be a key id.");
      const body = await this.request<{ intents: IntentGraph[] }>("GET", "/intents", undefined, {
        ...options,
        query: { limit: String(limit), owner: filter.owner },
      });
      return body.intents;
    },
    /**
     * Where the money is after every step and what follows (`GET
     * /v1/intents/{id}/journey`). At most 30 reads per intent per minute;
     * `refresh` bypasses the fact caches at most once per 10 s.
     */
    journey: async (id: string, options: RequestOptions & JourneyOptions = {}): Promise<Journey> => {
      const { refresh, reads, ...rest } = options;
      const body = await this.request<{ journey: Journey }>("GET", `/intents/${encodeSegment(id, "id")}/journey`, undefined, {
        ...rest,
        query: { refresh: refresh ? "true" : undefined, reads },
      });
      return body.journey;
    },
    /**
     * End the intent at its current stop (`POST /v1/intents/{id}/stop`):
     * nothing further is signed and the money stays where the journey says.
     * 409 INTENT_IN_FLIGHT (retryable, Retry-After) while a step is moving or
     * holds a payload that may still be signed: never stop while you hold
     * broadcast references that were not submitted.
     */
    stop: async (id: string, options: RequestOptions = {}): Promise<StoppedIntent> => {
      const body = await this.request<{ intent: IntentGraph; journey?: Journey | null }>("POST", `/intents/${encodeSegment(id, "id")}/stop`, {}, options);
      return { intent: body.intent, journey: body.journey ?? null };
    },
    /**
     * Build wallet-ready transactions for a ready step. Never retried and
     * never sent with an Idempotency-Key: each call builds fresh transactions.
     * Pass `acknowledgedPreview` (the digest of the preview the user
     * approved): a materially worse payload is refused with
     * `KletiaPreviewChangedError` (409 PREVIEW_CHANGED, carrying the fresh
     * preview), and `previewAck` says whether the API still held that digest.
     */
    prepareStep: (id: string, stepId: string, options: PrepareStepOptions = {}): Promise<PreparedStep> => {
      const acknowledged = options.acknowledgedPreview;
      if (acknowledged !== undefined && !PREVIEW_DIGEST_PATTERN.test(acknowledged)) {
        throw new TypeError("acknowledgedPreview must be a preview digest (sha256: followed by 64 lower-case hex characters).");
      }
      return this.request<PreparedStep>(
        "POST",
        `/intents/${encodeSegment(id, "id")}/steps/${encodeSegment(stepId, "stepId")}/prepare`,
        acknowledged ? { acknowledgedPreview: acknowledged } : {},
        options.signal ? { signal: options.signal } : {},
      );
    },
    /**
     * Recompute the asset-change preview of a stored intent (`POST
     * /v1/intents/{id}/preview`, at most 6 per intent per minute).
     * `refreshQuotes` re-quotes ready steps (once per 20 s per intent).
     * Simulations only: nothing is prepared or signed.
     */
    preview: async (id: string, options: RequestOptions & { readonly refreshQuotes?: boolean } = {}): Promise<IntentPreview> => {
      const { refreshQuotes, ...rest } = options;
      const body = await this.request<{ preview: IntentPreview }>("POST", `/intents/${encodeSegment(id, "id")}/preview`, {}, {
        ...rest,
        query: { quotes: refreshQuotes ? "refresh" : undefined },
      });
      return body.preview;
    },
    /** The last preview computed for a stored intent (any stage); 404 PREVIEW_NOT_FOUND when none is kept. */
    getPreview: async (id: string, options: RequestOptions = {}): Promise<IntentPreview> => {
      const body = await this.request<{ preview: IntentPreview }>("GET", `/intents/${encodeSegment(id, "id")}/preview`, undefined, options);
      return body.preview;
    },
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
    stream: (id: string, onEvent: (event: AnyKletiaEvent) => void, options: StreamOptions = {}): Promise<void> =>
      this.openEventStream(`/intents/${encodeSegment(id, "id")}/events`, {}, onEvent, options),
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

  /**
   * Clarify threads Kletia holds for this key (`remember: true`). Owner
   * scoped: another key's thread is 404 THREAD_NOT_FOUND.
   */
  readonly threads = {
    /** The key's Kletia-held threads, newest first. */
    list: (filter: ThreadListFilter = {}, options: RequestOptions = {}): Promise<ThreadList> =>
      this.request<ThreadList>("GET", "/threads", undefined, {
        ...options,
        query: { status: filter.status, limit: filter.limit === undefined ? undefined : String(filter.limit), cursor: filter.cursor },
      }),
    /** One thread with the context it keeps and its last response. */
    get: (id: string, options: RequestOptions = {}): Promise<ThreadDetail> => this.request<ThreadDetail>("GET", `/threads/${threadSegment(id)}`, undefined, options),
    /** Forget a thread now (204; idempotent). */
    delete: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.call("DELETE", `/threads/${threadSegment(id)}`, undefined, options, { goneAfterRetryIsDone: true });
    },
  };

  /**
   * The key's events as they would reach its webhooks (`GET /v1/events`,
   * Server-Sent Events; key required). For local development and servers
   * that prefer a stream to webhooks; `kletia listen` forwards them signed.
   */
  readonly events = {
    /**
     * Resolves when the stream ends (the API closes it after 30 minutes;
     * reconnect with `lastEventId` and de-duplicate by event id) or the
     * signal aborts. At most 2 streams per key.
     */
    stream: (onEvent: (event: AnyKletiaEvent) => void, options: EventStreamOptions = {}): Promise<void> => {
      const { scope, types, ...rest } = options;
      if (types !== undefined && types.some((type) => typeof type !== "string" || !/^[a-z_.]{1,64}$/u.test(type))) throw new TypeError("types are event type names such as intent.status_changed.");
      return this.openEventStream("/events", { scope, types: types && types.length > 0 ? types.join(",") : undefined }, onEvent, rest);
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
     * the caller's project (at most 5 active). `sandbox: true` keeps the key
     * on the testnet lane (a key-level rule book written in the same request).
     */
    create: async (name: string, options: RequestOptions & CreateKeyOptions = {}): Promise<ApiKeyRecord> => {
      const { sandbox, ...rest } = options;
      const body = await this.request<{ key: ApiKeyRecord }>("POST", "/keys", { name, ...(sandbox ? { sandbox: true } : {}) }, rest);
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
    /**
     * Create an agent key under `parentId` (`POST /v1/keys/{id}/children`,
     * 201, idempotent). Its secret (`kl_agt_…`) is in `key.key`, shown once;
     * its first rule book is `policy` or a `template` (with `fill`), else the
     * observer. Revoking a key revokes its whole subtree.
     */
    createChild: (parentId: string, request: CreateChildKeyRequest, options: RequestOptions = {}): Promise<CreatedChildKey> =>
      this.request<CreatedChildKey>("POST", `/keys/${encodeSegment(parentId, "parentId")}/children`, request, options),
    /**
     * Change a key's expiry (`PATCH /v1/keys/{id}`): shortening applies at
     * once; extending is a loosening, refused while the key's rule book has
     * an amendment delay. `null` removes the expiry of a project key.
     */
    update: async (id: string, patch: { readonly expiresAt: string | null }, options: RequestOptions = {}): Promise<ApiKeySummary> => {
      const body = await this.request<{ key: ApiKeySummary }>("PATCH", `/keys/${encodeSegment(id, "id")}`, patch, options);
      return body.key;
    },
  };

  /**
   * Verifiable receipts of finished intents (owner routes take the intent id
   * as the capability, like `intents.get`). Verify them offline with
   * `verifyReceipt` from `@kletia/core` and on-chain with `reverifyReceipt`
   * from `@kletia/sdk/receipts`.
   */
  readonly receipts = {
    /**
     * The latest receipt of an intent (or `sequence`) with every disclosure
     * the owner keeps. `receipt` is null while it is pending (finality); pass
     * `wait` to poll until it is issued.
     */
    get: async (intentId: string, options: GetReceiptOptions = {}): Promise<ReceiptResult> => {
      const { sequence, wait, ...rest } = options;
      if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new RangeError("sequence must be a positive integer.");
      const path = `/intents/${encodeSegment(intentId, "intentId")}/receipt`;
      const query = { sequence: sequence === undefined ? undefined : String(sequence) };
      const waitOptions = typeof wait === "object" ? wait : {};
      const deadline = Date.now() + (waitOptions.timeoutMs ?? 45 * 60_000);
      for (;;) {
        let result: ReceiptResult;
        let delaySeconds: number;
        try {
          result = await this.call<ReceiptResult>("GET", path, undefined, { ...rest, query }, { noRetryCodes: RECEIPT_WAIT_CODES });
          if (result.receipt || !wait) return result;
          delaySeconds = result.pending?.retryAfterSeconds ?? 30;
          if (result.pending) waitOptions.onPending?.(result.pending);
        } catch (error) {
          if (!wait || !(error instanceof KletiaApiError) || error.code !== "RECEIPT_NOT_READY") throw error;
          delaySeconds = error.retryAfterSeconds ?? 60;
          waitOptions.onPending?.({ reason: "not_ready", expectedBy: null, retryAfterSeconds: delaySeconds });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new KletiaApiError({ code: "WAIT_TIMEOUT", message: `No receipt for ${intentId} was issued in time; it is still pending.`, status: 0 });
        }
        try {
          await sleep(Math.min(remaining, Math.max(1, Math.min(delaySeconds, 300)) * 1000), rest.signal);
        } catch {
          throw abortedError(rest.signal);
        }
      }
    },
    /** Every sequence of an intent's receipts (`supersededBy` links them). */
    list: async (intentId: string, options: RequestOptions = {}): Promise<ReceiptListEntry[]> => {
      const body = await this.request<{ receipts: ReceiptListEntry[] }>("GET", `/intents/${encodeSegment(intentId, "intentId")}/receipts`, undefined, options);
      return body.receipts;
    },
    /**
     * Share a receipt (`profile` or `groups`; default `route`, the skeleton
     * only). `share.url` carries the decryption key in its fragment and is
     * returned once: Kletia does not keep the key.
     */
    share: (intentId: string, request: ReceiptShareRequest = {}, options: RequestOptions = {}): Promise<{ share: ReceiptShare }> =>
      this.request<{ share: ReceiptShare }>("POST", `/intents/${encodeSegment(intentId, "intentId")}/receipt/shares`, request, options),
    /** Active shares of an intent's receipts (never their keys). */
    shares: async (intentId: string, options: RequestOptions = {}): Promise<ReceiptShare[]> => {
      const body = await this.request<{ shares: ReceiptShare[] }>("GET", `/intents/${encodeSegment(intentId, "intentId")}/receipt/shares`, undefined, options);
      return body.shares;
    },
    /** Revoke a share (idempotent); its link stops opening at once. */
    unshare: async (intentId: string, shareId: string, options: RequestOptions = {}): Promise<void> => {
      await this.request("DELETE", `/intents/${encodeSegment(intentId, "intentId")}/receipt/shares/${shareSegment(shareId)}`, undefined, options);
    },
    /** Delete the stored disclosures of every receipt of the intent and every share; the signed payloads remain. */
    withdraw: async (intentId: string, options: RequestOptions = {}): Promise<void> => {
      await this.request("DELETE", `/intents/${encodeSegment(intentId, "intentId")}/receipt/disclosures`, undefined, options);
    },
    /**
     * The API's receipt key set. Trust a key only when the web origin's
     * mirror lists the same one (`fetchReceiptKeys` in `@kletia/sdk/receipts`
     * checks both) or it is pinned in `@kletia/core`.
     */
    keys: (options: RequestOptions = {}): Promise<ReceiptKeySet> => this.request<ReceiptKeySet>("GET", "/receipts/keys", undefined, options),
    /** Latest transparency-log batches (`unanchored`: only those no anchor was recorded for). */
    log: async (options: RequestOptions & { readonly limit?: number; readonly unanchored?: boolean } = {}): Promise<ReceiptLogBatchView[]> => {
      const { limit, unanchored, ...rest } = options;
      const body = await this.request<{ batches: ReceiptLogBatchView[] }>("GET", "/receipts/log", undefined, {
        ...rest,
        query: { limit: limit === undefined ? undefined : String(limit), unanchored: unanchored ? "true" : undefined },
      });
      return body.batches;
    },
    /** One batch (`leaves` pages through its leaf digests, at most 1,000 at a time). */
    batch: (seq: number, options: RequestOptions & { readonly leaves?: boolean; readonly offset?: number; readonly limit?: number } = {}): Promise<ReceiptLogBatchResponse> => {
      if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError("Log batch numbers are positive integers.");
      const { leaves, offset, limit, ...rest } = options;
      return this.request<ReceiptLogBatchResponse>("GET", `/receipts/log/${seq}`, undefined, {
        ...rest,
        query: { leaves: leaves ? "true" : undefined, offset: offset === undefined ? undefined : String(offset), limit: limit === undefined ? undefined : String(limit) },
      });
    },
    /** The inclusion proof of a receipt digest (public: a digest reveals nothing). */
    inclusion: async (digest: string, options: RequestOptions = {}): Promise<NonNullable<ReceiptDocumentView["inclusion"]>> => {
      if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("digest must be 64 lower-case hex characters.");
      const body = await this.request<{ inclusion: NonNullable<ReceiptDocumentView["inclusion"]> }>("GET", "/receipts/log/inclusion", undefined, { ...options, query: { digest } });
      return body.inclusion;
    },
    /** A receipt's signed payload while its owner shares it (no disclosures); 404 otherwise. */
    shared: async (receiptId: string, options: RequestOptions = {}): Promise<ReceiptDocumentView> => {
      const body = await this.request<{ receipt: ReceiptDocumentView }>("GET", `/receipts/${receiptSegment(receiptId)}`, undefined, options);
      return body.receipt;
    },
    /** Whether a shared receipt was superseded by a newer sequence. */
    status: (receiptId: string, options: RequestOptions = {}): Promise<{ sequence: number; terminal: boolean; supersededBy: string | null }> =>
      this.request("GET", `/receipts/${receiptSegment(receiptId)}/status`, undefined, options),
    /** The encrypted disclosures of a share (decrypt with the link's key: `openShareUrl`). */
    shareCiphertext: (receiptId: string, shareId: string, options: RequestOptions = {}): Promise<ReceiptShareCiphertext> =>
      this.request<ReceiptShareCiphertext>("GET", `/receipts/${receiptSegment(receiptId)}/shares/${shareSegment(shareId)}`, undefined, options),
  };

  /**
   * Rule Books: policies of keys and of the project (versions, tighten now /
   * loosen later), the simulator, the decision log and spend windows. Every
   * method needs an API key; writes need a project key with its current
   * secret (agent keys never write a rule book).
   */
  readonly policies = {
    /** A key's rule book (active and pending versions) and its effective chain. */
    get: (keyId: string, options: RequestOptions = {}): Promise<PolicyReadResponse> =>
      this.request<PolicyReadResponse>("GET", `/keys/${encodeSegment(keyId, "keyId")}/policy`, undefined, options),
    /**
     * New version of a key's rule book. Tightening applies now; loosening
     * waits the active version's amendment delay (`applied: "pending"`).
     * `ifMatch` (the active hash, or `none`) refuses a concurrent change with
     * POLICY_CONFLICT. Carries an Idempotency-Key.
     */
    put: (keyId: string, document: PolicyDocument, options: RequestOptions & { readonly ifMatch?: string } = {}): Promise<PolicyWriteResponse> => {
      const { ifMatch, ...rest } = options;
      return this.request<PolicyWriteResponse>("PUT", `/keys/${encodeSegment(keyId, "keyId")}/policy`, document, { ...rest, headers: ifMatchHeader(ifMatch) });
    },
    /** Remove a key's rule book (a loosening of every field: it waits the amendment delay). Not retried automatically. */
    delete: (keyId: string, options: RequestOptions & { readonly ifMatch?: string } = {}): Promise<PolicyWriteResponse> => {
      const { ifMatch, ...rest } = options;
      return this.request<PolicyWriteResponse>("DELETE", `/keys/${encodeSegment(keyId, "keyId")}/policy`, undefined, { ...rest, headers: ifMatchHeader(ifMatch) });
    },
    /** Cancel a pending amendment of a key's rule book. */
    cancelPending: async (keyId: string, options: RequestOptions = {}): Promise<PolicyVersionView> => {
      const body = await this.request<{ policy: PolicyVersionView }>("DELETE", `/keys/${encodeSegment(keyId, "keyId")}/policy/pending`, undefined, options);
      return body.policy;
    },
    /** Version history, newest first (at most 100). */
    versions: async (keyId: string, options: RequestOptions & { readonly limit?: number } = {}): Promise<PolicyVersionView[]> => {
      const { limit, ...rest } = options;
      const body = await this.request<{ versions: PolicyVersionView[] }>("GET", `/keys/${encodeSegment(keyId, "keyId")}/policy/versions`, undefined, {
        ...rest,
        query: { limit: limit === undefined ? undefined : String(limit) },
      });
      return body.versions;
    },
    /** The project rule book, which bounds every key of the project. */
    project: {
      get: (options: RequestOptions = {}): Promise<PolicyReadResponse> => this.request<PolicyReadResponse>("GET", "/projects/current/policy", undefined, options),
      put: (document: PolicyDocument, options: RequestOptions & { readonly ifMatch?: string } = {}): Promise<PolicyWriteResponse> => {
        const { ifMatch, ...rest } = options;
        return this.request<PolicyWriteResponse>("PUT", "/projects/current/policy", document, { ...rest, headers: ifMatchHeader(ifMatch) });
      },
      delete: (options: RequestOptions & { readonly ifMatch?: string } = {}): Promise<PolicyWriteResponse> => {
        const { ifMatch, ...rest } = options;
        return this.request<PolicyWriteResponse>("DELETE", "/projects/current/policy", undefined, { ...rest, headers: ifMatchHeader(ifMatch) });
      },
      cancelPending: async (options: RequestOptions = {}): Promise<PolicyVersionView> => {
        const body = await this.request<{ policy: PolicyVersionView }>("DELETE", "/projects/current/policy/pending", undefined, options);
        return body.policy;
      },
    },
    /**
     * Static validation on the API (public): issues, warnings, the canonical
     * hash and, with `against`, what tightens and loosens. `validatePolicy`
     * and `comparePolicies` from `@kletia/core` do the same offline.
     */
    validate: (
      document: unknown,
      options: RequestOptions & { readonly against?: PolicyDocument | null; readonly defaults?: PolicyDefaults } = {},
    ): Promise<PolicyValidateResponse> => {
      const { against, defaults, ...rest } = options;
      return this.request<PolicyValidateResponse>(
        "POST",
        "/policy/validate",
        { policy: document, ...(against !== undefined ? { against } : {}), ...(defaults ? { defaults } : {}) },
        rest,
      );
    },
    /**
     * The simulator: plans the request as a dry run under the key's effective
     * constraints and explains every rule (also when the outcome is deny).
     * Logged with stage `evaluate`; never reserves or stores anything.
     */
    evaluate: (request: PolicyEvaluateRequest, options: RequestOptions = {}): Promise<PolicyEvaluateResponse> =>
      this.request<PolicyEvaluateResponse>("POST", "/policy/evaluate", request, options),
    /** The decision log of the caller's subtree, newest first, with the chain head (`verifyDecisionChain`). */
    decisions: (filter: PolicyDecisionFilter = {}, options: RequestOptions = {}): Promise<PolicyDecisionList> =>
      this.request<PolicyDecisionList>("GET", "/policy/decisions", undefined, {
        ...options,
        query: {
          keyId: filter.keyId,
          intentId: filter.intentId,
          outcome: filter.outcome,
          stage: filter.stage,
          since: filter.since,
          after: filter.after,
          limit: filter.limit === undefined ? undefined : String(filter.limit),
        },
      }),
    decision: async (id: string, options: RequestOptions = {}): Promise<PolicyDecision> => {
      const body = await this.request<{ decision: PolicyDecision }>("GET", `/policy/decisions/${encodeSegment(id, "id")}`, undefined, options);
      return body.decision;
    },
    /** Window usage and what remains for every scope of a key's chain (default: the calling key). */
    spend: async (keyId?: string, options: RequestOptions = {}): Promise<PolicySpendReport> => {
      const body = await this.request<{ spend: PolicySpendReport }>("GET", "/policy/spend", undefined, { ...options, query: { keyId } });
      return body.spend;
    },
  };

  /**
   * Approvals of intents a rule book holds (`confirm`). Decide with a project
   * key (`approve` / `reject`) or with a listed wallet (`approveWithWallet`,
   * EIP-712 on EVM, signMessage on Solana).
   */
  readonly approvals = {
    /** `role: "approver"`: approvals the caller may decide; `requester` (default): its subtree's requests. */
    list: async (filter: PolicyApprovalFilter = {}, options: RequestOptions = {}): Promise<PolicyApprovalView[]> => {
      const body = await this.request<{ approvals: PolicyApprovalView[] }>("GET", "/policy/approvals", undefined, {
        ...options,
        query: { role: filter.role, status: filter.status, limit: filter.limit === undefined ? undefined : String(filter.limit) },
      });
      return body.approvals;
    },
    /** One approval (public: the id is the capability; reading is not approving). */
    get: async (id: string, options: RequestOptions = {}): Promise<PolicyApprovalView> => {
      const body = await this.request<{ approval: PolicyApprovalView }>("GET", `/policy/approvals/${approvalSegment(id)}`, undefined, options);
      return body.approval;
    },
    /** Approve with this client's project key (never the requester's own key or an agent key). */
    approve: async (id: string, options: RequestOptions = {}): Promise<PolicyApprovalView> => {
      const body = await this.request<{ approval: PolicyApprovalView }>("POST", `/policy/approvals/${approvalSegment(id)}/approve`, {}, options);
      return body.approval;
    },
    /** Reject with this client's project key; the intent is cancelled. */
    reject: async (id: string, options: RequestOptions = {}): Promise<PolicyApprovalView> => {
      const body = await this.request<{ approval: PolicyApprovalView }>("POST", `/policy/approvals/${approvalSegment(id)}/reject`, {}, options);
      return body.approval;
    },
    /**
     * Decide with a listed wallet. Reads the approval, checks that its digest
     * is the one of the intent it names (`approvalDigest` from
     * `@kletia/core`), has the wallet sign exactly the core typed data (EVM)
     * or message (Solana), then sends the signature.
     */
    approveWithWallet: (id: string, signer: ApprovalWalletSigner, options: WalletDecisionOptions = {}): Promise<PolicyApprovalView> =>
      decideWithWallet(this, approvalSegment(id), "approve", signer, options),
    rejectWithWallet: (id: string, signer: ApprovalWalletSigner, options: WalletDecisionOptions = {}): Promise<PolicyApprovalView> =>
      decideWithWallet(this, approvalSegment(id), "reject", signer, options),
  };

  /**
   * Intent links (`lk_…`, served at `<web>/go/<id>`): a fixed destination
   * anyone can fund from the networks and assets you allow. Managing links
   * needs an API key; quotes and visitor intents are public.
   */
  readonly links = {
    /**
     * Create a link (`POST /v1/links`, 201, idempotent). The definition is
     * checked locally with `validateLinkDefinition` first; a refusal is a
     * `KletiaApiError` with status 0 (nothing was sent).
     */
    create: async (definition: unknown, options: RequestOptions = {}): Promise<{ link: LinkOwnerView }> => {
      const checked = validateLinkDefinition(definition);
      if (!checked.ok) {
        throw new KletiaApiError({
          code: checked.code,
          message: "The link definition is invalid (checked locally; nothing was sent).",
          status: 0,
          issues: checked.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        });
      }
      return this.request<{ link: LinkOwnerView }>("POST", "/links", definition, options);
    },
    /** The calling key's links. */
    list: async (filter: { readonly status?: "pending" | "active" | "paused" | "suspended" | "deleted"; readonly limit?: number } = {}, options: RequestOptions = {}): Promise<LinkOwnerView[]> => {
      const body = await this.request<{ links: LinkOwnerView[] }>("GET", "/links", undefined, {
        ...options,
        query: { status: filter.status, limit: filter.limit === undefined ? undefined : String(filter.limit) },
      });
      return body.links;
    },
    /** The public view, or the owner view (definition, pins, 7-day stats) for the publisher's keys. */
    get: async (id: string, options: RequestOptions = {}): Promise<LinkView | LinkOwnerView> => {
      const body = await this.request<{ link: LinkView | LinkOwnerView }>("GET", `/links/${linkSegment(id)}`, undefined, options);
      return body.link;
    },
    /** Tighten only: anything a visitor reviewed can only get stricter (else LINK_IMMUTABLE_FIELD). */
    update: async (id: string, patch: LinkPatch, options: RequestOptions = {}): Promise<LinkOwnerView> => {
      const body = await this.request<{ link: LinkOwnerView }>("PATCH", `/links/${linkSegment(id)}`, patch, options);
      return body.link;
    },
    pause: (id: string, options: RequestOptions = {}): Promise<LinkOwnerView> => this.links.update(id, { status: "paused" }, options),
    /** Resume; `accept` re-pins a changed recipient or contract (a new revision, with a new activation delay on mainnet). */
    resume: (id: string, input: { readonly accept?: readonly ("recipient_changed" | "contract_changed")[] } = {}, options: RequestOptions = {}): Promise<LinkOwnerView> =>
      this.links.update(id, { status: "active", ...(input.accept && input.accept.length > 0 ? { accept: input.accept } : {}) }, options),
    /** Withdraw a link (soft delete, idempotent); its page answers 410. */
    delete: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.call("DELETE", `/links/${linkSegment(id)}`, undefined, options, { goneAfterRetryIsDone: true });
    },
    /** Additive counters over 7, 30 or 90 days; nothing per visitor. */
    stats: async (id: string, input: { readonly window?: "7d" | "30d" | "90d" } = {}, options: RequestOptions = {}): Promise<LinkStats> => {
      const body = await this.request<{ stats: LinkStats }>("GET", `/links/${linkSegment(id)}/stats`, undefined, { ...options, query: { window: input.window } });
      return body.stats;
    },
    /** Indicative fare for a funding choice (public, never stored; cached 20 s). */
    quote: (id: string, request: Omit<LinkVisitorRequest, "clientReference">, options: RequestOptions = {}): Promise<LinkIntentResponse> =>
      this.request<LinkIntentResponse>("POST", `/links/${linkSegment(id)}/quote`, request, options),
    /** The visitor's intent (public), owned by the publisher's key and executed with `executeIntent`. */
    createIntent: (id: string, request: LinkVisitorRequest, options: RequestOptions = {}): Promise<LinkIntentResponse> =>
      this.request<LinkIntentResponse>("POST", `/links/${linkSegment(id)}/intents`, request, options),
    /** `<web>/go/<id>`. */
    pageUrl: (id: string): string => `${this.webOrigin}/go/${linkSegment(id)}`,
    /** `<web>/go/<id>/card.png` (`square` for the 600×600 card). */
    cardUrl: (id: string, variant: "wide" | "square" = "wide"): string =>
      `${this.webOrigin}/go/${linkSegment(id)}/card.png${variant === "square" ? "?variant=square" : ""}`,
    /** The share card as PNG bytes (`GET /v1/links/{id}/card.png`). */
    card: async (id: string, input: { readonly variant?: "wide" | "square" } = {}, options: Pick<RequestOptions, "signal"> = {}): Promise<Uint8Array> => {
      const url = `${this.baseUrl}/v1/links/${linkSegment(id)}/card.png${input.variant === "square" ? "?variant=square" : ""}`;
      return fetchPng(this.fetchImpl, url, this.headers({ accept: "image/png" }), this.timeoutMs, options.signal);
    },
  };

  /**
   * Custom contracts ("bring your own contract"): register your own EVM
   * contract functions or Solana Actions so intents can call them. Every
   * method needs an API key; registrations belong to that key.
   */
  readonly contracts = {
    /**
     * Register a contract (`POST /v1/contracts`, 201). Carries an
     * Idempotency-Key (generated unless given), so a retry after a lost
     * response returns the same registration. On mainnet networks the first
     * revision is `pending` until `activatesAt`. Check a definition locally
     * first with `validateContractDefinition` from `@kletia/core`: the API
     * reports the same issues.
     */
    register: (definition: ContractDefinition, options: RequestOptions = {}): Promise<ContractRegistration> =>
      this.request<ContractRegistration>("POST", "/contracts", definition, options),
    /** The key's registrations and project-visible ones of sibling keys. */
    list: async (filter: ContractListFilter = {}, options: RequestOptions = {}): Promise<ContractView[]> => {
      const body = await this.request<{ contracts: ContractView[] }>("GET", "/contracts", undefined, {
        ...options,
        query: { network: filter.network, vm: filter.vm, status: filter.status },
      });
      return body.contracts;
    },
    /** One registration; the owner also gets the ABI and its revision history. */
    get: async (id: string, options: RequestOptions = {}): Promise<ContractWithRevisions> => {
      const body = await this.request<{ contract: ContractWithRevisions }>("GET", `/contracts/${contractSegment(id)}`, undefined, options);
      return body.contract;
    },
    /**
     * Change a registration (`PATCH`, idempotent like `register`). Labels and
     * phrases change in place; anything else creates a new revision, pending
     * on mainnet until it activates while the current one keeps serving.
     */
    update: async (id: string, patch: ContractDefinitionPatch, options: RequestOptions = {}): Promise<ContractView> => {
      const body = await this.request<{ contract: ContractView }>("PATCH", `/contracts/${contractSegment(id)}`, patch, options);
      return body.contract;
    },
    /** Soft delete (idempotent). Intents planned on it stop preparing. */
    delete: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.call("DELETE", `/contracts/${contractSegment(id)}`, undefined, options, { goneAfterRetryIsDone: true });
    },
    /**
     * Dry run of one entry for an account: plan, prepare, simulation and the
     * review users will see. Nothing is stored and nothing is signed.
     */
    test: async (id: string, request: ContractTestRequest, options: RequestOptions = {}): Promise<ContractTestResult> => {
      const body = await this.request<{ test: ContractTestResult }>("POST", `/contracts/${contractSegment(id)}/test`, request, options);
      return body.test;
    },
    /**
     * Read the pins again after an intended upgrade (idempotent). Creates a
     * new revision when the code changed, which lifts a pin suspension once
     * it activates.
     */
    reverify: async (id: string, options: RequestOptions = {}): Promise<ContractView> => {
      const body = await this.request<{ contract: ContractView }>("POST", `/contracts/${contractSegment(id)}/reverify`, {}, options);
      return body.contract;
    },
    /**
     * What registration would pin and allow: code hash, proxy and
     * implementation, source verification and the ABI functions with
     * allow/deny marks (EVM), or program pins and verification (Solana).
     */
    inspect: async (query: ContractInspectQuery, options: RequestOptions = {}): Promise<ContractInspection> => {
      const programs = query.programs === undefined ? undefined : query.programs.join(",");
      const body = await this.request<{ inspection: ContractInspection }>("GET", "/contracts/inspect", undefined, {
        ...options,
        query: { network: query.network, address: query.address, programs },
      });
      return body.inspection;
    },
  };

  /**
   * Project settings, publishable keys and the domain proof. Reads need
   * a key of the project; writes need a project key with its current
   * secret.
   */
  readonly projects = {
    /** The project view: settings, version, `hash` (the If-Match value) and domain proof. */
    get: async (options: RequestOptions = {}): Promise<ProjectView> => {
      const body = await this.request<{ project: ProjectView }>("GET", "/projects/current", undefined, options);
      return body.project;
    },
    /**
     * Merge-patch the settings (`null` removes a field). `ifMatch` is the
     * `hash` the change is based on: a project changed meanwhile is refused
     * with 409 PROJECT_CONFLICT. Not retried automatically.
     */
    update: async (patch: ProjectSettingsPatch, options: RequestOptions & { readonly ifMatch: string }): Promise<ProjectView> => {
      const { ifMatch, ...rest } = options;
      if (typeof ifMatch !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(ifMatch)) throw new TypeError("ifMatch must be the project's hash (from projects.get).");
      const body = await this.request<{ project: ProjectView }>("PATCH", "/projects/current", patch, { ...rest, headers: { "if-match": `"${ifMatch}"` } });
      return body.project;
    },
    /** Fetch `https://<website>/.well-known/kletia.json` now and check that it lists this project. */
    verifyDomain: async (options: RequestOptions = {}): Promise<ProjectView> => {
      const body = await this.request<{ project: ProjectView }>("POST", "/projects/current/domain/verify", {}, options);
      return body.project;
    },
    /**
     * Issue a publishable key (`kl_pub_…`, shown once; at most 5 active per
     * project). It is meant for browsers: its rule book is derived from the
     * project defaults and it works only from the project's allowed origins.
     */
    createPublishableKey: async (input: { readonly label: string }, options: RequestOptions = {}): Promise<PublishableKeyRecord> => {
      if (typeof input?.label !== "string" || !input.label.trim() || input.label.length > 80) throw new TypeError("label is 1-80 characters.");
      const body = await this.request<{ key: PublishableKeyRecord }>("POST", "/projects/current/publishable-keys", { label: input.label }, options);
      return body.key;
    },
    /**
     * Upload the brand logo (verified projects): PNG or WebP bytes, at most
     * 64 KB, 32-512 px, aspect 1:1 to 4:1. Checked here only for type and
     * size; the API reads the image header.
     */
    setLogo: async (bytes: Uint8Array, contentType: ProjectLogoContentType, options: RequestOptions = {}): Promise<ProjectView> => {
      if (contentType !== "image/png" && contentType !== "image/webp") throw new TypeError("The logo must be image/png or image/webp.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 65_536) throw new RangeError("The logo must be 1 byte to 64 KB.");
      const body = await this.request<{ project: ProjectView }>("PUT", "/projects/current/logo", new RawBody(bytes, contentType), options);
      return body.project;
    },
    /** Remove the brand logo. */
    deleteLogo: async (options: RequestOptions = {}): Promise<void> => {
      await this.request("DELETE", "/projects/current/logo", undefined, options);
    },
  };

  /** What a publishable key reveals about its project (call it with `publishableKey`). */
  readonly publishable = {
    profile: async (options: RequestOptions = {}): Promise<ProjectProfile> => {
      const body = await this.request<{ profile: ProjectProfile }>("GET", "/publishable/profile", undefined, options);
      return body.profile;
    },
  };

  /**
   * Sessions: a fixed template of actions your backend creates with its key;
   * a page you list in `allowedOrigins` turns it into an intent for the
   * visitor's own accounts, without a key.
   */
  readonly sessions = {
    /**
     * Create a session (`POST /v1/sessions`, key required, idempotent). The
     * response carries `embedUrl`. With a publishable key, only from a stored
     * flow of the project: `{ flow, hostOrigin }`.
     */
    create: async (request: SessionCreateRequest | { readonly flow: string; readonly hostOrigin: string }, options: RequestOptions = {}): Promise<SessionView> => {
      const body = await this.request<{ session: SessionView }>("POST", "/sessions", request, options);
      return body.session;
    },
    /** The public view of a session (integrator, labels, amount bounds, expiry). */
    get: async (id: string, options: RequestOptions = {}): Promise<SessionView> => {
      const body = await this.request<{ session: SessionView }>("GET", `/sessions/${sessionSegment(id)}`, undefined, options);
      return body.session;
    },
    /**
     * Turn a session into an intent for the visitor's accounts (public; the
     * session id is the capability). `hostOrigin` defaults to the page's
     * origin in a browser and is required elsewhere. Never retried: each
     * call uses the session up.
     */
    createIntent: async (id: string, request: SessionIntentInput, options: RequestOptions = {}): Promise<SessionIntentResponse> => {
      const segment = sessionSegment(id);
      const hostOrigin = request.hostOrigin ?? pageOrigin();
      if (!hostOrigin) {
        throw new TypeError("hostOrigin is required outside a browser: pass the origin of the page the visitor is on.");
      }
      const body = await this.request<SessionIntentResponse>("POST", `/sessions/${segment}/intents`, { ...request, hostOrigin }, options);
      return { intent: body.intent };
    },
  };
}
