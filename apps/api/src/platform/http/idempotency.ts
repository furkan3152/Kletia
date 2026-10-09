/**
 * `Idempotency-Key` for keyed POSTs (draft-ietf-httpapi-idempotency-key-header).
 *
 * The first request with a key reserves `(API key id, Idempotency-Key)`, runs,
 * and its response is stored for 24 hours before it is written to the client;
 * a retry with the same key and the same request replays that response with
 * `Idempotent-Replayed: true`.
 *
 * - Same key, different request (method, route, path, query or body) → 422
 *   IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first request is still running → 409
 *   IDEMPOTENCY_REQUEST_IN_PROGRESS with `Retry-After: 1`. A reservation whose
 *   request never finished (a crashed process) is taken over after 120 s.
 * - Only final outcomes are stored: 5xx, 429 and retryable error codes
 *   (catalog) release the reservation so a retry runs again.
 * - Public tier → 400 IDEMPOTENCY_KEY_REQUIRES_API_KEY (an IP is not a safe
 *   scope); routes that re-quote on every call → 400 IDEMPOTENCY_NOT_SUPPORTED.
 * - Responses that carry a secret (API keys, webhook signing secrets) are
 *   stored sealed with the platform secret, together with a hash of the
 *   secret that made the request. They are replayed to a key's rotated-out
 *   secret only when that secret made the request (a key that rotated itself
 *   and lost the response can fetch its new secret; any other rotated-out
 *   secret gets 403 KEY_SECRET_ROTATED), and such routes refuse the header
 *   when sealing is unavailable. Intent responses over 256 KB are stored by
 *   reference and re-read on replay.
 *
 * Storage: memory (LRU, 50k entries) or Postgres `kletia_idempotency` when
 * KLETIA_DATABASE_URL is set; expired entries are pruned hourly.
 */
import type { Request, RequestHandler, Response } from "express";
import { isRetryableError } from "@kletia/core";
import { canonicalJson } from "../engine/util.js";
import { getIntent, INTENT_ID_PATTERN } from "../index.js";
import { PlatformError } from "../errors.js";
import { authOf, HttpError, isRecord, sendError } from "./context.js";
import { dbQuery, platformDatabaseUrl } from "./db.js";
import { openSecret, randomHex, sealingAvailable, sealSecret, sha256Hex } from "./secrets.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const IDEMPOTENCY_LOCK_MS = 120_000;
export const MAX_STORED_BODY_BYTES = 256 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

/* ----------------------------------------------------------------- parse */

/** The Idempotency-Key value: a bare token or a structured-field string of the same characters. Null when absent. */
export function parseIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let value = raw.trim();
  if (value.startsWith("\"")) {
    if (value.length < 3 || !value.endsWith("\"")) throw invalidKey();
    value = value.slice(1, -1);
  }
  if (!KEY_PATTERN.test(value)) throw invalidKey();
  return value;
}

function invalidKey(): HttpError {
  return new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 1-128 characters from A-Z a-z 0-9 _ . : - (optionally quoted), for example a UUID.", {
    issues: [{ path: IDEMPOTENCY_HEADER, message: "Invalid value." }],
  });
}

/* ----------------------------------------------------------------- store */

export type StoredBodyKind = "empty" | "json" | "sealed" | "intent_ref";

export interface StoredResponse {
  readonly status: number;
  readonly kind: StoredBodyKind;
  readonly body: string;
  /** Hash of the secret that made the request (secret-bearing responses only); see `presenterOf`. */
  readonly presenter?: string;
}

export type BeginResult =
  | { readonly state: "acquired"; readonly token: string }
  | { readonly state: "replay"; readonly response: StoredResponse }
  | { readonly state: "in_progress" }
  | { readonly state: "mismatch" };

export interface IdempotencyRequest {
  readonly owner: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly method: string;
  readonly route: string;
}

export interface IdempotencyStore {
  readonly kind: "memory" | "postgres";
  begin(request: IdempotencyRequest, now: number): Promise<BeginResult>;
  /** Stores the final response of the reservation identified by `token` (no-op when it was taken over). */
  complete(owner: string, key: string, token: string, response: StoredResponse): Promise<void>;
  /** Drops an unfinished reservation so the next request with the key runs again. */
  release(owner: string, key: string, token: string): Promise<void>;
  /** Deletes expired entries; returns how many. */
  prune(now: number): Promise<number>;
}

interface MemoryEntry {
  readonly fingerprint: string;
  readonly token: string;
  readonly lockedUntil: number;
  readonly expiresAt: number;
  readonly response?: StoredResponse;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly maxEntries = 50_000) {}

  private static id(owner: string, key: string): string {
    return `${owner}\u0000${key}`;
  }

  async begin(request: IdempotencyRequest, now: number): Promise<BeginResult> {
    const id = MemoryIdempotencyStore.id(request.owner, request.key);
    const existing = this.entries.get(id);
    if (existing && existing.expiresAt > now) {
      if (existing.fingerprint !== request.fingerprint) return { state: "mismatch" };
      if (existing.response) return { state: "replay", response: existing.response };
      if (existing.lockedUntil > now) return { state: "in_progress" };
    }
    const token = randomHex(16);
    this.entries.delete(id);
    this.entries.set(id, { fingerprint: request.fingerprint, token, lockedUntil: now + IDEMPOTENCY_LOCK_MS, expiresAt: now + IDEMPOTENCY_TTL_MS });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { state: "acquired", token };
  }

  async complete(owner: string, key: string, token: string, response: StoredResponse): Promise<void> {
    const id = MemoryIdempotencyStore.id(owner, key);
    const existing = this.entries.get(id);
    if (existing?.token === token) this.entries.set(id, { ...existing, response });
  }

  async release(owner: string, key: string, token: string): Promise<void> {
    const id = MemoryIdempotencyStore.id(owner, key);
    const existing = this.entries.get(id);
    if (existing?.token === token && !existing.response) this.entries.delete(id);
  }

  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

const IDEMPOTENCY_SCHEMA = {
  name: "kletia_idempotency",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_idempotency (
  owner_key_id text NOT NULL,
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  token text NOT NULL,
  locked_until timestamptz,
  response_status integer,
  body_kind text,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_key_id, idem_key)
);
ALTER TABLE kletia_idempotency ADD COLUMN IF NOT EXISTS presenter_hash text;
CREATE INDEX IF NOT EXISTS kletia_idempotency_expiry_idx ON kletia_idempotency (expires_at);`,
} as const;

interface IdempotencyRow {
  request_hash: string;
  state: string;
  token: string;
  locked_until: Date | string | null;
  response_status: number | null;
  body_kind: string | null;
  response_body: string | null;
  presenter_hash: string | null;
  expires_at: Date | string;
}

const BODY_KINDS: readonly StoredBodyKind[] = ["empty", "json", "sealed", "intent_ref"];

export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly kind = "postgres" as const;

  async begin(request: IdempotencyRequest, now: number): Promise<BeginResult> {
    const at = new Date(now).toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomHex(16);
      const reserved = await dbQuery<{ token: string }>(
        IDEMPOTENCY_SCHEMA,
        `INSERT INTO kletia_idempotency (owner_key_id, idem_key, request_hash, method, route, state, token, locked_until, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, $8, $9)
         ON CONFLICT (owner_key_id, idem_key) DO UPDATE SET
           request_hash = EXCLUDED.request_hash, method = EXCLUDED.method, route = EXCLUDED.route, state = 'in_progress',
           token = EXCLUDED.token, locked_until = EXCLUDED.locked_until, response_status = NULL, body_kind = NULL,
           response_body = NULL, presenter_hash = NULL, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
         WHERE kletia_idempotency.expires_at <= EXCLUDED.created_at
            OR (kletia_idempotency.state = 'in_progress' AND kletia_idempotency.locked_until <= EXCLUDED.created_at
                AND kletia_idempotency.request_hash = EXCLUDED.request_hash)
         RETURNING token`,
        [
          request.owner,
          request.key,
          request.fingerprint,
          request.method,
          request.route,
          token,
          new Date(now + IDEMPOTENCY_LOCK_MS).toISOString(),
          at,
          new Date(now + IDEMPOTENCY_TTL_MS).toISOString(),
        ],
      );
      if (reserved.rows[0]?.token === token) return { state: "acquired", token };
      const existing = await dbQuery<IdempotencyRow>(
        IDEMPOTENCY_SCHEMA,
        `SELECT request_hash, state, token, locked_until, response_status, body_kind, response_body, presenter_hash, expires_at
         FROM kletia_idempotency WHERE owner_key_id = $1 AND idem_key = $2`,
        [request.owner, request.key],
      );
      const row = existing.rows[0];
      // Released between the two statements: reserve again.
      if (!row) continue;
      if (row.request_hash !== request.fingerprint) return { state: "mismatch" };
      if (row.state === "completed" && row.response_status !== null && BODY_KINDS.includes(row.body_kind as StoredBodyKind)) {
        const response: StoredResponse = { status: row.response_status, kind: row.body_kind as StoredBodyKind, body: row.response_body ?? "" };
        return { state: "replay", response: row.presenter_hash ? { ...response, presenter: row.presenter_hash } : response };
      }
      return { state: "in_progress" };
    }
    return { state: "in_progress" };
  }

  async complete(owner: string, key: string, token: string, response: StoredResponse): Promise<void> {
    await dbQuery(
      IDEMPOTENCY_SCHEMA,
      `UPDATE kletia_idempotency SET state = 'completed', response_status = $4, body_kind = $5, response_body = $6, presenter_hash = $7,
         locked_until = NULL
       WHERE owner_key_id = $1 AND idem_key = $2 AND token = $3`,
      [owner, key, token, response.status, response.kind, response.body, response.presenter ?? null],
    );
  }

  async release(owner: string, key: string, token: string): Promise<void> {
    await dbQuery(
      IDEMPOTENCY_SCHEMA,
      "DELETE FROM kletia_idempotency WHERE owner_key_id = $1 AND idem_key = $2 AND token = $3 AND state = 'in_progress'",
      [owner, key, token],
    );
  }

  async prune(now: number): Promise<number> {
    const result = await dbQuery(IDEMPOTENCY_SCHEMA, "DELETE FROM kletia_idempotency WHERE expires_at <= $1", [new Date(now).toISOString()]);
    return result.rowCount ?? 0;
  }
}

let store: IdempotencyStore | null = null;

export function idempotencyStore(): IdempotencyStore {
  store ??= platformDatabaseUrl() ? new PostgresIdempotencyStore() : new MemoryIdempotencyStore();
  return store;
}

export function idempotencyStoreKind(): "memory" | "postgres" {
  return idempotencyStore().kind;
}

/** Hourly pruning of expired entries (long-running hosts). Returns a stop function. */
export function startIdempotencyPruner(intervalMs = 60 * 60_000): () => void {
  const timer = setInterval(() => {
    idempotencyStore()
      .prune(Date.now())
      .catch((error: unknown) => {
        console.warn("[platform] idempotency prune failed:", error instanceof Error ? error.message : error);
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------ middleware */

export interface IdempotencyOptions {
  /** Route template, e.g. "POST /intents" (part of the request fingerprint). */
  readonly route: string;
  /** The response carries a secret: stored sealed, and the header is refused when sealing is unavailable. */
  readonly secret?: boolean;
  /** False to ignore the header for this request (it is safe to repeat, e.g. a dry run). */
  readonly applies?: (req: Request) => boolean;
}

function fingerprint(req: Request, route: string): string {
  return sha256Hex(canonicalJson({ method: req.method, route, params: req.params, query: req.query, body: req.body ?? null }));
}

/** An error envelope whose code says the same request may succeed later is never stored. */
function storable(status: number, body: unknown): boolean {
  if (status >= 500 || status === 429) return false;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return !isRetryableError(body.error.code, status);
  return true;
}

function sealContext(owner: string, key: string): string {
  return `idempotency:${owner}:${key}`;
}

/** Identifies the secret a request authenticated with (a hash of its hash; null without a developer secret). */
function presenterOf(req: Request): string | null {
  const { secretHash } = authOf(req);
  return secretHash ? sha256Hex(`idempotency-presenter:${secretHash}`) : null;
}

function encodeResponse(owner: string, key: string, status: number, body: unknown, secret: boolean, presenter: string | null): StoredResponse {
  if (secret) {
    const bound = presenter ? { presenter } : {};
    if (body === undefined) return { status, kind: "empty", body: "", ...bound };
    return { status, kind: "sealed", body: sealSecret(JSON.stringify(body), sealContext(owner, key)), ...bound };
  }
  if (body === undefined) return { status, kind: "empty", body: "" };
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, "utf8") > MAX_STORED_BODY_BYTES && isRecord(body) && isRecord(body.intent) && typeof body.intent.id === "string") {
    return { status, kind: "intent_ref", body: body.intent.id };
  }
  return { status, kind: "json", body: json };
}

async function decodeResponse(owner: string, key: string, response: StoredResponse): Promise<unknown> {
  switch (response.kind) {
    case "empty":
      return undefined;
    case "json":
      return JSON.parse(response.body) as unknown;
    case "sealed":
      return JSON.parse(openSecret(response.body, sealContext(owner, key))) as unknown;
    case "intent_ref":
      if (!INTENT_ID_PATTERN.test(response.body)) throw new Error("Stored intent reference is invalid.");
      return { intent: await getIntent(response.body) };
  }
}

async function replay(res: Response, owner: string, key: string, response: StoredResponse): Promise<void> {
  const body = await decodeResponse(owner, key, response);
  res.setHeader("Idempotent-Replayed", "true");
  res.status(response.status);
  if (body === undefined) res.end();
  else res.json(body);
}

/**
 * Honours Idempotency-Key on one route. Mount after authentication (and after
 * requireApiKey on keyed routes); without the header it does nothing.
 */
export function idempotent(options: IdempotencyOptions): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const key = parseIdempotencyKey(req.get(IDEMPOTENCY_HEADER));
      if (key === null || (options.applies && !options.applies(req))) {
        next();
        return;
      }
      const owner = authOf(req).keyId;
      if (!owner) {
        throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRES_API_KEY", "Idempotency-Key needs an API key: idempotency is scoped to the key. Send the request with your key, or without the header.", {
          issues: [{ path: IDEMPOTENCY_HEADER, message: "Requires an API key." }],
        });
      }
      if (options.secret && !sealingAvailable()) {
        throw new HttpError(400, "IDEMPOTENCY_NOT_SUPPORTED", "Idempotency-Key is unavailable on this endpoint until the deployment configures KLETIA_PLATFORM_SECRET.");
      }
      const store = idempotencyStore();
      const begun = await store.begin({ owner, key, fingerprint: fingerprint(req, options.route), method: req.method, route: options.route }, Date.now());
      if (begun.state === "mismatch") {
        throw new HttpError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request. Use a new key for a new request.", {
          issues: [{ path: IDEMPOTENCY_HEADER, message: "Reused with a different request." }],
        });
      }
      if (begun.state === "in_progress") {
        throw new HttpError(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still being processed. Retry shortly.", {
          headers: { "Retry-After": "1" },
        });
      }
      if (begun.state === "replay") {
        // A stored secret (a rotated key, a webhook signing secret) is replayed to a rotated-out secret only when
        // that same secret made the request: a key that rotated itself can recover a lost response, a leaked
        // older secret cannot read what the current one created. Entries without a recorded presenter never are.
        if (options.secret && authOf(req).viaPreviousSecret) {
          const presenter = presenterOf(req);
          if (!presenter || begun.response.presenter !== presenter) {
            throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated; responses that carry secrets are only replayed to the current secret or to the secret that made the request.", 403);
          }
        }
        await replay(res, owner, key, begun.response);
        return;
      }
      const { token } = begun;
      const presenter = presenterOf(req);
      let settled = false;
      const settle = async (status: number, body: unknown): Promise<void> => {
        settled = true;
        try {
          if (storable(status, body)) await store.complete(owner, key, token, encodeResponse(owner, key, status, body, options.secret === true, presenter));
          else await store.release(owner, key, token);
        } catch (error) {
          // The reservation stays in progress until its lock lapses; the response is still delivered.
          console.error("[platform] idempotency store write failed:", error instanceof Error ? error.message : error);
        }
      };
      // The response is stored before it is written, so a client that saw it can always replay it.
      const writeJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (settled) return writeJson(body);
        void settle(res.statusCode, body).finally(() => writeJson(body));
        return res;
      }) as Response["json"];
      res.on("finish", () => {
        if (!settled) void settle(res.statusCode, undefined);
      });
      next();
    })().catch((error: unknown) => sendError(req, res, error));
  };
}

/** For routes that must not be replayed (prepare re-quotes every call): refuses the header explicitly. */
export const idempotencyUnsupported: RequestHandler = (req, res, next) => {
  if (req.get(IDEMPOTENCY_HEADER) === undefined) {
    next();
    return;
  }
  sendError(req, res, new HttpError(400, "IDEMPOTENCY_NOT_SUPPORTED", "Idempotency-Key is not supported here: prepare builds fresh transactions from a new quote on every call. Send the request without it.", {
    issues: [{ path: IDEMPOTENCY_HEADER, message: "Not supported on this endpoint." }],
  }));
};
