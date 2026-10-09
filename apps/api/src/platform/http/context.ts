/**
 * Per-request state for the public API: request id, authentication result,
 * the error envelope and small input validators shared by every route.
 *
 * State lives in a WeakMap keyed by the Express request so nothing is added
 * to Express' global types and nothing outlives the request.
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { PlatformError, toPlatformError, type PlatformIssue } from "../errors.js";
import { INTENT_ID_PATTERN, MAX_STEP_TRANSACTIONS, STEP_ID_PATTERN } from "../index.js";
import { errorDocsLink } from "./errorsRoute.js";

export type ApiTier = "public" | "developer" | "operator";

export interface AuthContext {
  readonly tier: ApiTier;
  /** API key id (never the key itself). Absent on the public tier. */
  readonly keyId?: string;
  /** Project of a developer key: keys issued from one another share it. */
  readonly projectId?: string;
  /** The key authenticated with a secret that was rotated out and is inside its grace window. */
  readonly viaPreviousSecret?: true;
  /** SHA-256 of the presented developer secret (never the secret itself): tells a key's current and previous secrets apart. */
  readonly secretHash?: string;
  /** Set when the caller presented a credential that failed; the request is rejected after rate limiting. */
  readonly rejection?: HttpError | PlatformError;
}

interface RequestState {
  readonly requestId: string;
  auth: AuthContext;
}

const states = new WeakMap<Request, RequestState>();

const PUBLIC_AUTH: AuthContext = Object.freeze({ tier: "public" });

/**
 * An HTTP failure outside the engine's status set (405, 413, 415) or raised
 * by the HTTP layer itself. Serialised exactly like PlatformError.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: readonly PlatformIssue[];
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { issues?: readonly PlatformIssue[]; headers?: Readonly<Record<string, string>> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (options.issues && options.issues.length > 0) this.issues = options.issues.slice(0, 20);
    if (options.headers) this.headers = options.headers;
  }

  toJSON(): { code: string; message: string; issues?: readonly PlatformIssue[] } {
    return { code: this.code, message: this.message, ...(this.issues ? { issues: this.issues } : {}) };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function incomingRequestId(req: Request): string {
  const incoming = req.get("x-request-id")?.trim();
  return incoming && UUID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();
}

function state(req: Request): RequestState {
  let current = states.get(req);
  if (!current) {
    current = { requestId: incomingRequestId(req), auth: PUBLIC_AUTH };
    states.set(req, current);
  }
  return current;
}

/** First middleware: assigns the request id, default caching policy and empty auth. */
export const requestContext: RequestHandler = (req, res, next) => {
  res.setHeader("X-Request-Id", state(req).requestId);
  res.setHeader("Cache-Control", "no-store");
  // JSON and event streams only: never let a browser sniff a response into HTML.
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
};

export function requestIdOf(req: Request): string {
  return state(req).requestId;
}

export function authOf(req: Request): AuthContext {
  return state(req).auth;
}

export function setAuth(req: Request, auth: AuthContext): void {
  state(req).auth = auth;
}

/** Registry responses are identical for every caller and may be cached briefly. */
export function cachePublicly(res: Response, seconds = 60): void {
  res.setHeader("Cache-Control", `public, max-age=${seconds}`);
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly PlatformIssue[];
    readonly hints?: readonly string[];
    /** Documentation of the code in the error catalog (GET /v1/errors). */
    readonly docs?: string;
  };
  readonly requestId: string;
}

/**
 * Client errors raised by Express itself (e.g. a path parameter with broken
 * percent-encoding) carry a 4xx `status`. They become a generic 400 without
 * echoing the framework message.
 */
function frameworkClientError(error: unknown): HttpError | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number" || status < 400 || status > 499) return null;
  if (error instanceof URIError) return new HttpError(400, "INVALID_REQUEST", "The request path contains malformed percent-encoding.");
  return new HttpError(400, "INVALID_REQUEST", "The request could not be processed.");
}

function normalize(error: unknown): HttpError | PlatformError {
  if (error instanceof HttpError || error instanceof PlatformError) return error;
  return frameworkClientError(error) ?? toPlatformError(error);
}

/** Writes the v1 error envelope. Safe to call after headers were sent (the socket is closed instead). */
export function sendError(req: Request, res: Response, error: unknown): void {
  const failure = normalize(error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Errors raised before the router ran (e.g. an app-level JSON parser) still carry a request id.
  if (!res.getHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestIdOf(req));
  res.setHeader("Cache-Control", "no-store");
  if (failure instanceof HttpError && failure.headers) {
    for (const [name, value] of Object.entries(failure.headers)) res.setHeader(name, value);
  }
  if (failure.status === 401 && !res.getHeader("WWW-Authenticate")) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="kletia"');
  }
  const docs = errorDocsLink(failure.code);
  const body: ErrorBody = { error: { ...failure.toJSON(), ...(docs ? { docs } : {}) }, requestId: requestIdOf(req) };
  res.status(failure.status).json(body);
}

/* ------------------------------------------------------------ validation */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidRequest(message: string, issues: readonly PlatformIssue[] = []): PlatformError {
  return new PlatformError("INVALID_REQUEST", message, 400, issues);
}

/** Intent and step id formats come from the engine so both layers accept exactly the same ids. */
export { INTENT_ID_PATTERN, STEP_ID_PATTERN };
export const EVENT_ID_PATTERN = /^evt_[0-9a-f]{32}$/u;
export const WEBHOOK_ID_PATTERN = /^wh_[0-9a-f]{24}$/u;
/** One reference per prepared transaction; the engine prepares at most this many per step. */
export const MAX_REFERENCES = MAX_STEP_TRANSACTIONS;
export const MAX_REFERENCE_LENGTH = 128;

/** A single path parameter as a string (Express 5 may also yield arrays for wildcards). */
export function pathParam(req: Request, name: string): string {
  const value: unknown = req.params[name];
  return typeof value === "string" ? value : "";
}

export function intentIdParam(req: Request): string {
  const id = pathParam(req, "id");
  if (!INTENT_ID_PATTERN.test(id)) {
    throw invalidRequest("Intent ids look like int_ followed by 32 lowercase hex characters.", [
      { path: "id", message: "Invalid intent id." },
    ]);
  }
  return id;
}

export function stepIdParam(req: Request): string {
  const id = pathParam(req, "stepId");
  if (!STEP_ID_PATTERN.test(id)) {
    throw invalidRequest("Step ids look like s1, s2, ...", [{ path: "stepId", message: "Invalid step id." }]);
  }
  return id;
}

/** One optional string query parameter; repeated or nested values are rejected. */
export function queryParam(req: Request, name: string, maxLength = 128): string | undefined {
  const value: unknown = (req.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalidRequest(`Query parameter ${name} must be a single string.`, [{ path: name, message: "Invalid value." }]);
  }
  return value;
}

export function booleanQuery(req: Request, name: string): boolean {
  const value = queryParam(req, name, 8);
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw invalidRequest(`Query parameter ${name} must be true or false.`, [{ path: name, message: "Expected true or false." }]);
}

export function integerQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const value = queryParam(req, name, 6);
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value) || Number(value) < min || Number(value) > max) {
    throw invalidRequest(`Query parameter ${name} must be an integer between ${min} and ${max}.`, [
      { path: name, message: `Expected ${min}-${max}.` },
    ]);
  }
  return Number(value);
}

/** `{ references: string[] }` for submit: 1-8 non-empty strings of at most 128 characters. */
export function parseReferencesBody(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.references)) {
    throw invalidRequest("Body must be { \"references\": [\"0x…\" | \"<base58 signature>\"] }.", [
      { path: "references", message: "Required list of transaction hashes or signatures." },
    ]);
  }
  const references: unknown[] = body.references;
  if (references.length === 0 || references.length > MAX_REFERENCES) {
    throw invalidRequest(`references must contain 1-${MAX_REFERENCES} items.`, [
      { path: "references", message: `Expected 1-${MAX_REFERENCES} items.` },
    ]);
  }
  const issues: PlatformIssue[] = [];
  const parsed = references.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_REFERENCE_LENGTH || !/^[0-9A-Za-z]+$/u.test(value.trim())) {
      issues.push({ path: `references[${index}]`, message: `Must be an alphanumeric string of at most ${MAX_REFERENCE_LENGTH} characters.` });
      return "";
    }
    return value.trim();
  });
  if (issues.length > 0) throw invalidRequest("One or more references are malformed.", issues);
  return parsed;
}

/** Wraps an async handler so a rejection always reaches the router's error handler. */
export function handle(
  fn: (req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}
