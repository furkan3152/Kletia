/**
 * Webhook receivers for `@kletia/sdk/server`.
 *
 * Kletia signs every delivery with `Kletia-Signature: t=<unix>,v1=<hex>`, an
 * HMAC-SHA256 over `"<t>.<raw body>"`. The signature only verifies against
 * the exact bytes that were sent, so these helpers read the raw body
 * themselves and refuse a body some framework already parsed.
 *
 * Web Crypto only, with no `node:` imports: the same code runs on Node 20+,
 * Bun, Deno, edge runtimes and Workers.
 *
 * Delivery is at least once. Kletia retries failed deliveries (and a test or
 * a replay can repeat an event), so make `onEvent` idempotent: de-duplicate
 * by `event.id`, ideally in the same transaction as the side effect.
 */
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  type AnyKletiaEvent,
} from "@kletia/core";

export const WEBHOOK_EVENT_ID_HEADER = "kletia-event-id";
export const WEBHOOK_EVENT_TYPE_HEADER = "kletia-event-type";
export const WEBHOOK_ID_HEADER = "kletia-webhook-id";
export const WEBHOOK_ATTEMPT_HEADER = "kletia-delivery-attempt";
/** Kletia events are a few KB; anything far larger is not from Kletia. */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export type KletiaWebhookErrorReason =
  /** The signature header is missing or not `t=…,v1=…`. */
  | "malformed"
  /** The signature timestamp is outside the tolerance (a replay, or a skewed clock). */
  | "expired"
  /** No secret produced this signature. */
  | "mismatch"
  /** The signature is valid but the body is not a Kletia event envelope. */
  | "invalid_body"
  /** `Kletia-Event-Id` disagrees with the signed body. */
  | "header_mismatch"
  /** The body was parsed or consumed before verification (a server misconfiguration). */
  | "parsed_body"
  /** The body is larger than `maxBodyBytes`. */
  | "too_large"
  /** No secret was configured. */
  | "missing_secret";

export class KletiaWebhookError extends Error {
  readonly reason: KletiaWebhookErrorReason;

  constructor(reason: KletiaWebhookErrorReason, message: string) {
    super(message);
    this.name = "KletiaWebhookError";
    this.reason = reason;
  }
}

export type WebhookRawBody = string | Uint8Array | ArrayBuffer;
export type WebhookSecret = string | readonly string[];

export interface ConstructWebhookEventOptions {
  /** Accepted clock difference in seconds (default 300). */
  readonly toleranceSeconds?: number;
  /** Current time in milliseconds (tests). */
  readonly now?: number;
  /** Value of `Kletia-Event-Id`, checked against the signed body when given. */
  readonly eventIdHeader?: string | readonly string[] | null;
}

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function secretsOf(secret: WebhookSecret | undefined | null): string[] {
  const list = typeof secret === "string" ? [secret] : Array.isArray(secret) ? [...secret] : [];
  return list.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function rawText(rawBody: unknown): string {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
    try {
      return fatalDecoder.decode(rawBody);
    } catch {
      throw new KletiaWebhookError("invalid_body", "The webhook body is not valid UTF-8.");
    }
  }
  throw new KletiaWebhookError(
    "parsed_body",
    "The webhook body must be the raw request body (string, Buffer or Uint8Array), not a parsed object.",
  );
}

function firstHeader(value: string | readonly string[] | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verifies a delivery and returns its event. `secret` may be a list: during a
 * secret rotation pass the new and the old secret, and a delivery signed
 * with either verifies. Throws `KletiaWebhookError` with a `reason`.
 */
export async function constructWebhookEvent(
  rawBody: WebhookRawBody,
  signatureHeader: string | readonly string[] | null | undefined,
  secret: WebhookSecret,
  options: ConstructWebhookEventOptions = {},
): Promise<AnyKletiaEvent> {
  const secrets = secretsOf(secret);
  if (secrets.length === 0) throw new KletiaWebhookError("missing_secret", "No webhook signing secret is configured.");
  const text = rawText(rawBody);
  const verifyOptions = {
    toleranceSeconds: options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  let verified = false;
  for (const candidate of secrets) {
    const result = await verifyWebhookSignature(candidate, text, signatureHeader, verifyOptions);
    if (result.valid) {
      verified = true;
      break;
    }
    // Malformed and expired do not depend on the secret.
    if (result.reason === "malformed") throw new KletiaWebhookError("malformed", "The Kletia-Signature header is missing or malformed.");
    if (result.reason === "expired") throw new KletiaWebhookError("expired", "The Kletia-Signature timestamp is outside the tolerance.");
  }
  if (!verified) throw new KletiaWebhookError("mismatch", "The Kletia-Signature does not match the body.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KletiaWebhookError("invalid_body", "The webhook body is not JSON.");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.at !== "string" ||
    !isRecord(parsed.data)
  ) {
    throw new KletiaWebhookError("invalid_body", "The webhook body is not a Kletia event envelope.");
  }
  const headerId = firstHeader(options.eventIdHeader);
  if (headerId !== null && headerId !== parsed.id) {
    throw new KletiaWebhookError("header_mismatch", "Kletia-Event-Id does not match the signed event id.");
  }
  return parsed as unknown as AnyKletiaEvent;
}

/* ------------------------------------------------------------- handlers */

export interface WebhookDeliveryContext {
  /** `Kletia-Webhook-Id` (unsigned; informational). */
  readonly webhookId: string | null;
  /** `Kletia-Delivery-Attempt`, 1 for the first attempt (unsigned; informational). */
  readonly attempt: number | null;
}

export interface WebhookHandlerOptions {
  /** Signing secret (`whsec_…`), or several during a rotation. */
  readonly secret: WebhookSecret;
  /** Called once per verified, non-duplicate event. Throw to have Kletia retry the delivery. */
  readonly onEvent: (event: AnyKletiaEvent, context: WebhookDeliveryContext) => void | Promise<void>;
  /** Return true for an event id already processed: it is acknowledged without calling `onEvent`. */
  readonly isDuplicate?: (eventId: string, event: AnyKletiaEvent) => boolean | Promise<boolean>;
  /** Called after `onEvent` succeeded, e.g. to remember the id for `isDuplicate`. */
  readonly markProcessed?: (eventId: string, event: AnyKletiaEvent) => void | Promise<void>;
  /** Accepted clock difference in seconds (default 300). */
  readonly toleranceSeconds?: number;
  /** Largest body accepted (default 256 KB). */
  readonly maxBodyBytes?: number;
  /** Rejected deliveries and failed handlers (default: console.warn / console.error). */
  readonly onError?: (error: unknown) => void;
}

/** Framework-neutral outcome of one delivery. */
interface Outcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

type HeaderReader = (name: string) => string | readonly string[] | null | undefined;

const PARSED_BODY_HELP =
  "Kletia webhook handler needs the raw request body to verify the signature. " +
  "Express: mount express.raw({ type: \"application/json\" }) on this route, before any JSON parser. " +
  "Next.js pages router: export const config = { api: { bodyParser: false } }. " +
  "Fetch handlers: do not read the request body before the handler.";

function validateOptions(options: WebhookHandlerOptions): void {
  if (secretsOf(options.secret).length === 0) {
    throw new TypeError("createWebhookHandler: `secret` is required (the whsec_… value returned when the webhook was created).");
  }
  if (typeof options.onEvent !== "function") throw new TypeError("createWebhookHandler: `onEvent` is required.");
}

function report(options: WebhookHandlerOptions, error: unknown, level: "warn" | "error"): void {
  if (options.onError) {
    try {
      options.onError(error);
    } catch {
      // A failing logger must not change the response.
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (level === "error") console.error(`[kletia] webhook: ${message}`);
  else console.warn(`[kletia] webhook rejected: ${message}`);
}

async function processDelivery(
  options: WebhookHandlerOptions,
  rawBody: WebhookRawBody,
  header: HeaderReader,
): Promise<Outcome> {
  let event: AnyKletiaEvent;
  try {
    event = await constructWebhookEvent(rawBody, header(WEBHOOK_SIGNATURE_HEADER), options.secret, {
      ...(options.toleranceSeconds !== undefined ? { toleranceSeconds: options.toleranceSeconds } : {}),
      eventIdHeader: header(WEBHOOK_EVENT_ID_HEADER) ?? null,
    });
  } catch (error) {
    if (error instanceof KletiaWebhookError) {
      if (error.reason === "parsed_body") {
        report(options, new KletiaWebhookError("parsed_body", PARSED_BODY_HELP), "error");
        return { status: 500, body: { error: "parsed_body", message: PARSED_BODY_HELP } };
      }
      report(options, error, "warn");
      return { status: 400, body: { error: error.reason } };
    }
    throw error;
  }
  try {
    if (options.isDuplicate && (await options.isDuplicate(event.id, event))) {
      return { status: 200, body: { received: true, duplicate: true } };
    }
    const attempt = Number.parseInt(firstHeader(header(WEBHOOK_ATTEMPT_HEADER)) ?? "", 10);
    await options.onEvent(event, {
      webhookId: firstHeader(header(WEBHOOK_ID_HEADER)),
      attempt: Number.isSafeInteger(attempt) ? attempt : null,
    });
    await options.markProcessed?.(event.id, event);
  } catch (error) {
    // 500 makes Kletia retry the delivery; the handler's error text stays here.
    report(options, error, "error");
    return { status: 500, body: { error: "handler_failed" } };
  }
  return { status: 200, body: { received: true } };
}

function tooLarge(limit: number): Outcome {
  return { status: 413, body: { error: "too_large", message: `Webhook bodies are limited to ${limit} bytes.` } };
}

/** Reads a fetch body with a size limit (the Content-Length header may be absent or wrong). */
async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function declaredLength(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return Number(value.trim());
}

function jsonResponse(outcome: Outcome): Response {
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...outcome.headers },
  });
}

/**
 * A Fetch API webhook endpoint: `(request: Request) => Promise<Response>`.
 *
 * ```ts
 * // Next.js App Router: app/api/kletia/route.ts
 * export const POST = createWebhookHandler({
 *   secret: process.env.KLETIA_WEBHOOK_SECRET!,
 *   onEvent: async (event) => { if (event.type === "intent.status_changed") … },
 * });
 * ```
 *
 * Also Bun, Deno, Workers and Hono (`app.post("/kletia", (c) => handler(c.req.raw))`).
 * Answers 200 when the event was handled (or is a duplicate), 400 when the
 * delivery does not verify, 413 for oversized bodies, 405 for other methods
 * and 500 when `onEvent` throws (Kletia then retries).
 */
export function createWebhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response> {
  validateOptions(options);
  const limit = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse({ status: 405, body: { error: "method_not_allowed" }, headers: { allow: "POST" } });
    }
    if ((declaredLength(request.headers.get("content-length")) ?? 0) > limit) return jsonResponse(tooLarge(limit));
    if (request.bodyUsed) {
      report(options, new KletiaWebhookError("parsed_body", PARSED_BODY_HELP), "error");
      return jsonResponse({ status: 500, body: { error: "parsed_body", message: PARSED_BODY_HELP } });
    }
    const bytes = request.body ? await readLimited(request.body, limit) : new Uint8Array(0);
    if (!bytes) return jsonResponse(tooLarge(limit));
    return jsonResponse(await processDelivery(options, bytes, (name) => request.headers.get(name)));
  };
}

/** Hono: `app.post("/webhooks/kletia", honoWebhookHandler({ secret, onEvent }))`. */
export function honoWebhookHandler(
  options: WebhookHandlerOptions,
): (context: { readonly req: { readonly raw: Request } }) => Promise<Response> {
  const handler = createWebhookHandler(options);
  return (context) => handler(context.req.raw);
}

/** The parts of a Node / Express request the handler reads. */
export interface NodeWebhookRequest {
  readonly method?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The raw body from `express.raw()` (Buffer), or a string; undefined when no body parser ran. */
  readonly body?: unknown;
  readonly readableEnded?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/** The parts of a Node / Express response the handler writes. */
export interface NodeWebhookResponse {
  statusCode: number;
  readonly headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

const textEncoder = new TextEncoder();

async function readNodeStream(request: NodeWebhookRequest, limit: number): Promise<Uint8Array | null> {
  const iterate = request[Symbol.asyncIterator];
  if (!iterate) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterator = iterate.call(request);
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    const chunk = typeof value === "string" ? textEncoder.encode(value) : value instanceof Uint8Array ? value : null;
    if (!chunk) continue;
    size += chunk.byteLength;
    if (size > limit) {
      await iterator.return?.();
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sendNode(response: NodeWebhookResponse, outcome: Outcome): void {
  if (response.headersSent) return;
  response.statusCode = outcome.status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  for (const [name, value] of Object.entries(outcome.headers ?? {})) response.setHeader(name, value);
  response.end(JSON.stringify(outcome.body));
}

/**
 * Express (and plain `node:http`, and the Next.js pages router) webhook
 * endpoint. Mount it with `express.raw`, before any JSON parser:
 *
 * ```ts
 * app.post("/webhooks/kletia", express.raw({ type: "application/json" }), expressWebhookHandler({ secret, onEvent }));
 * ```
 *
 * Without a body parser it reads the request stream itself. A body that was
 * already parsed into an object is refused with a 500 that says how to fix
 * the route, because its signature can no longer be checked.
 */
export function expressWebhookHandler(
  options: WebhookHandlerOptions,
): (request: NodeWebhookRequest, response: NodeWebhookResponse, next?: (error?: unknown) => void) => Promise<void> {
  validateOptions(options);
  const limit = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  return async (request, response, next) => {
    try {
      if ((request.method ?? "POST").toUpperCase() !== "POST") {
        sendNode(response, { status: 405, body: { error: "method_not_allowed" }, headers: { allow: "POST" } });
        return;
      }
      const header: HeaderReader = (name) => request.headers[name.toLowerCase()];
      if ((declaredLength(firstHeader(header("content-length"))) ?? 0) > limit) {
        sendNode(response, tooLarge(limit));
        return;
      }
      let raw: WebhookRawBody;
      const body = request.body;
      if (body instanceof Uint8Array || typeof body === "string") {
        raw = body;
      } else if (body === undefined && !request.readableEnded) {
        const bytes = await readNodeStream(request, limit);
        if (!bytes) {
          sendNode(response, tooLarge(limit));
          return;
        }
        raw = bytes;
      } else {
        report(options, new KletiaWebhookError("parsed_body", PARSED_BODY_HELP), "error");
        sendNode(response, { status: 500, body: { error: "parsed_body", message: PARSED_BODY_HELP } });
        return;
      }
      if (typeof raw !== "string" && raw.byteLength > limit) {
        sendNode(response, tooLarge(limit));
        return;
      }
      sendNode(response, await processDelivery(options, raw, header));
    } catch (error) {
      if (next) next(error);
      else {
        report(options, error, "error");
        sendNode(response, { status: 500, body: { error: "internal_error" } });
      }
    }
  };
}

/**
 * In-process de-duplication for small deployments and tests:
 * `createWebhookHandler({ secret, onEvent, ...memoryDeduplication() })`.
 * It forgets on restart and is not shared between instances; use your
 * database for anything that must hold across them.
 */
export function memoryDeduplication(maxEntries = 10_000): Pick<WebhookHandlerOptions, "isDuplicate" | "markProcessed"> {
  const processed = new Set<string>();
  return {
    isDuplicate: (eventId) => processed.has(eventId),
    markProcessed: (eventId) => {
      processed.add(eventId);
      if (processed.size > maxEntries) processed.delete(processed.values().next().value as string);
    },
  };
}
