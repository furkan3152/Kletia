import {
  isContractId,
  isLinkId,
  isSessionId,
  PREVIEW_DIGEST_PATTERN,
  validateLinkDefinition,
  type AnyKletiaEvent,
  type AssetDescriptor,
  type ContractDefinition,
  type ContractInspection,
  type ContractTestRequest,
  type ContractTestResult,
  type ContractView,
  type IntentGraph,
  type IntentPreview,
  type IntentRequest,
  type LinkDefinition,
  type LinkOwnerView,
  type LinkStats,
  type LinkView,
  type NetworkKey,
  type PolicyDecision,
  type PolicyDefaults,
  type PolicyDocument,
  type ProtocolDescriptor,
  type ProtocolId,
  type SessionCreateRequest,
  type SessionView,
} from "@kletia/core";
import { KletiaApiError, KletiaPolicyError, KletiaPreviewChangedError, type ApiIssue, type PolicyErrorDetails } from "./errors.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  newIdempotencyKey,
  retryClass,
  retryDelayMs,
  sleep,
  type RetryClass,
} from "./retry.js";
import { decideWithWallet, type ApprovalWalletSigner, type WalletDecisionOptions } from "./approvals.js";
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
  ErrorCatalogResponse,
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
import { watchIntent, type WatchIntentOptions } from "./watch.js";

export const DEFAULT_BASE_URL = "https://api.kletiaai.xyz";
/** Origin of the Kletia web app (link pages, receipt pages, approval pages). */
export const DEFAULT_WEB_ORIGIN = "https://kletiaai.xyz";
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

/** `intents.create`: the intent, or `{ intent, preview }` with `preview: true`. */
export interface CreateIntent {
  (request: IntentRequest, options: CreateIntentOptions & RequestOptions & { readonly preview: true }): Promise<IntentWithPreview>;
  (request: IntentRequest, options?: CreateIntentOptions & RequestOptions & { readonly preview?: false }): Promise<IntentGraph>;
  (request: IntentRequest, options?: CreateIntentOptions & RequestOptions): Promise<IntentGraph | IntentWithPreview>;
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
  /** Retryable codes the caller handles itself (e.g. receipts.get waiting on RECEIPT_NOT_READY): never retried here. */
  readonly noRetryCodes?: ReadonlySet<string>;
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
/** `error.policy` of a Rule Book refusal, when it has the documented shape. */
function policyDetails(value: unknown): PolicyErrorDetails | null {
  if (!isRecord(value) || !Array.isArray(value.violations)) return null;
  const stage = value.stage;
  const approval = isRecord(value.approval) && typeof value.approval.id === "string" && typeof value.approval.url === "string" ? value.approval : null;
  return {
    decisionId: typeof value.decisionId === "string" ? value.decisionId : null,
    stage: stage === "plan" || stage === "prepare" || stage === "evaluate" || stage === "sign" ? stage : "plan",
    outcome: "deny",
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    violations: value.violations.filter((entry): entry is PolicyErrorDetails["violations"][number] => isRecord(entry) && typeof entry.rule === "string" && typeof entry.message === "string"),
    retryAt: typeof value.retryAt === "string" ? value.retryAt : null,
    ...(approval
      ? {
          approval: {
            id: approval.id as string,
            url: approval.url as string,
            expiresAt: typeof approval.expiresAt === "string" ? approval.expiresAt : "",
            ...(typeof approval.ceilingUsd === "string" ? { ceilingUsd: approval.ceilingUsd } : {}),
            ...(approval.status === "pending" || approval.status === "approved" || approval.status === "rejected" || approval.status === "expired" ? { status: approval.status } : {}),
          },
        }
      : {}),
  };
}

/** Builds the error for a non-2xx response from the API's JSON error envelope. */
function errorFromResponse(response: Response, parsed: unknown, fallbackMessage: string): KletiaApiError {
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  const input = {
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
  };
  const policy = policyDetails(error.policy);
  if (policy) return new KletiaPolicyError({ ...input, policy });
  if (input.code === "PREVIEW_CHANGED" && isRecord(error.preview) && typeof error.preview.digest === "string") {
    const changes = Array.isArray(error.changes) ? error.changes.filter((entry) => isRecord(entry) && typeof entry.code === "string") : [];
    return new KletiaPreviewChangedError({ ...input, preview: error.preview as unknown as IntentPreview, changes: changes as unknown as KletiaPreviewChangedError["changes"] });
  }
  return new KletiaApiError(input);
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

/** A registration id path segment; anything else is refused before a request is made. */
function contractSegment(id: string): string {
  if (!isContractId(id)) throw new TypeError("Contract ids look like ct_ followed by 24 lower-case hex characters.");
  return id;
}

/** A session id path segment; anything else is refused before a request is made. */
function sessionSegment(id: string): string {
  if (!isSessionId(id)) throw new TypeError("Session ids look like cs_ followed by 32 lower-case hex characters.");
  return id;
}

/** A link id path segment; anything else is refused before a request is made. */
function linkSegment(id: string): string {
  if (!isLinkId(id)) throw new TypeError("Link ids look like lk_ followed by 24 lower-case hex characters.");
  return id;
}

/** A receipt id (`rcpt_…`) path segment. */
function receiptSegment(id: string): string {
  if (!/^rcpt_[0-9a-f]{32}$/u.test(id)) throw new TypeError("Receipt ids look like rcpt_ followed by 32 lower-case hex characters.");
  return id;
}

/** A receipt share id (`rsh_…`) path segment. */
function shareSegment(id: string): string {
  if (!/^rsh_[0-9a-f]{24}$/u.test(id)) throw new TypeError("Share ids look like rsh_ followed by 24 lower-case hex characters.");
  return id;
}

/** An approval id (`apr_…`) path segment. */
function approvalSegment(id: string): string {
  if (!/^apr_[0-9a-f]{32}$/u.test(id)) throw new TypeError("Approval ids look like apr_ followed by 32 lower-case hex characters.");
  return id;
}

/** `If-Match` value for a rule book write: the active hash (`sha256:…`) or `none`. */
function ifMatchHeader(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (value !== "none" && !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError('ifMatch must be the rule book hash ("sha256:…") or "none".');
  return { "if-match": `"${value}"` };
}

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
];

function requestRetryClass(method: string, path: string, query: Readonly<Record<string, string | undefined>> = {}): RetryClass {
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
const RECEIPT_WAIT_CODES: ReadonlySet<string> = new Set(["RECEIPT_NOT_READY"]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PNG_BYTES = 2 * 1024 * 1024;

/** GET of a PNG: API errors keep their envelope; anything that is not a PNG is refused. */
async function fetchPng(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number, userSignal?: AbortSignal): Promise<Uint8Array> {
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
function pageOrigin(): string | undefined {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof origin === "string" && origin !== "null" ? origin : undefined;
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
  /** Origin of the web app for page and card URLs. */
  readonly webOrigin: string;

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
    this.webOrigin = new URL(options.webOrigin ?? DEFAULT_WEB_ORIGIN).origin;
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
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const kind = requestRetryClass(method, path, init.query);
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
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers({
          ...own,
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
     * With `preview: true` it resolves with `{ intent, preview }`: the
     * plan-stage asset-change preview ("fare breakdown").
     */
    create: (async (request: IntentRequest, options: CreateIntentOptions & RequestOptions = {}): Promise<IntentGraph | IntentWithPreview> => {
      const { dryRun, preview, ...rest } = options;
      const body = await this.request<{ intent: IntentGraph; preview?: IntentPreview }>("POST", "/intents", request, {
        ...rest,
        query: { dryRun: dryRun ? "true" : undefined, preview: preview ? "true" : undefined },
      });
      return preview ? { intent: body.intent, preview: body.preview ?? null } : body.intent;
    }) as CreateIntent,
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
   * Sessions: a fixed template of actions your backend creates with its key;
   * a page you list in `allowedOrigins` turns it into an intent for the
   * visitor's own accounts, without a key.
   */
  readonly sessions = {
    /** Create a session (`POST /v1/sessions`, key required, idempotent). The response carries `embedUrl`. */
    create: async (request: SessionCreateRequest, options: RequestOptions = {}): Promise<SessionView> => {
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
