/**
 * API keys and tier resolution.
 *
 * - Developer keys: `kl_dev_` + 32 base62 characters, issued by POST /v1/keys.
 *   Only sha256(key) is stored (memory, or Postgres `kletia_api_keys` when
 *   KLETIA_DATABASE_URL is set). The raw key is returned exactly once.
 * - Operator keys: raw keys in KLETIA_OPERATOR_API_KEYS (comma separated),
 *   hashed when the router is created and never stored.
 *
 * A request presents a key as `Authorization: Bearer <key>` or
 * `X-Kletia-Key: <key>`. No key means the public tier; a key that does not
 * authenticate is always 401 (never silently downgraded to public).
 */
import type { RequestHandler } from "express";
import { PlatformError } from "../errors.js";
import { authOf, HttpError, invalidRequest, isRecord, sendError, setAuth, type ApiTier } from "./context.js";
import { dbQuery, platformDatabaseUrl } from "./db.js";
import { clientIp, TIER_LIMITS } from "./limits.js";
import { randomBase62, randomHex, sha256Hex } from "./secrets.js";

export type KeyTier = Exclude<ApiTier, "public">;

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface IssuedApiKey {
  readonly id: string;
  readonly name: string;
  readonly tier: KeyTier;
  readonly createdAt: string;
  /** The raw key. Shown once; Kletia keeps only its SHA-256 hash. */
  readonly key: string;
}

export const DEVELOPER_KEY_PREFIX = "kl_dev_";
const DEVELOPER_KEY_PATTERN = /^kl_dev_[0-9A-Za-z]{32}$/u;
const MIN_OPERATOR_KEY_LENGTH = 24;
const MAX_KEY_LENGTH = 256;

/* ----------------------------------------------------------------- store */

interface ApiKeyStore {
  readonly kind: "memory" | "postgres";
  insert(record: ApiKeyRecord, keyHash: string): Promise<void>;
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
}

class MemoryApiKeyStore implements ApiKeyStore {
  readonly kind = "memory" as const;
  private readonly byHash = new Map<string, ApiKeyRecord>();

  constructor(private readonly maxKeys = 50_000) {}

  async insert(record: ApiKeyRecord, keyHash: string): Promise<void> {
    if (this.byHash.has(keyHash)) throw new PlatformError("KEY_COLLISION", "Key generation collided; try again.", 409);
    this.byHash.set(keyHash, record);
    while (this.byHash.size > this.maxKeys) {
      const oldest = this.byHash.keys().next().value;
      if (oldest === undefined) break;
      this.byHash.delete(oldest);
    }
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    return this.byHash.get(keyHash) ?? null;
  }
}

const API_KEYS_SCHEMA = {
  name: "kletia_api_keys",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_api_keys (
  id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('developer', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);`,
} as const;

interface ApiKeyRow {
  id: string;
  name: string;
  tier: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class PostgresApiKeyStore implements ApiKeyStore {
  readonly kind = "postgres" as const;

  async insert(record: ApiKeyRecord, keyHash: string): Promise<void> {
    const result = await dbQuery(
      API_KEYS_SCHEMA,
      `INSERT INTO kletia_api_keys (id, key_hash, name, tier, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [record.id, keyHash, record.name, record.tier, record.createdAt],
    );
    if (result.rowCount !== 1) throw new PlatformError("KEY_COLLISION", "Key generation collided; try again.", 409);
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const result = await dbQuery<ApiKeyRow>(
      API_KEYS_SCHEMA,
      "SELECT id, name, tier, created_at, revoked_at FROM kletia_api_keys WHERE key_hash = $1",
      [keyHash],
    );
    const row = result.rows[0];
    if (!row || (row.tier !== "developer" && row.tier !== "operator")) return null;
    return {
      id: row.id,
      name: row.name,
      tier: row.tier,
      createdAt: isoOf(row.created_at) ?? new Date(0).toISOString(),
      revokedAt: isoOf(row.revoked_at),
    };
  }
}

let keyStore: ApiKeyStore | null = null;

function apiKeyStore(): ApiKeyStore {
  keyStore ??= platformDatabaseUrl() ? new PostgresApiKeyStore() : new MemoryApiKeyStore();
  return keyStore;
}

export function apiKeyStoreKind(): "memory" | "postgres" {
  return apiKeyStore().kind;
}

/* ---------------------------------------------------------- operator keys */

interface OperatorKey {
  readonly id: string;
  readonly name: string;
}

let operatorKeys: ReadonlyMap<string, OperatorKey> | null = null;

/** Hashes KLETIA_OPERATOR_API_KEYS once. Keys shorter than 24 characters are ignored with a warning. */
export function loadOperatorKeys(): ReadonlyMap<string, OperatorKey> {
  if (operatorKeys) return operatorKeys;
  const map = new Map<string, OperatorKey>();
  const raw = (process.env.KLETIA_OPERATOR_API_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let ignored = 0;
  for (const key of raw) {
    if (key.length < MIN_OPERATOR_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/u.test(key)) {
      ignored += 1;
      continue;
    }
    const hash = sha256Hex(key);
    map.set(hash, { id: `op_${hash.slice(0, 16)}`, name: `operator-${map.size + 1}` });
  }
  if (ignored > 0) {
    console.warn(`[platform] ignored ${ignored} KLETIA_OPERATOR_API_KEYS entr${ignored === 1 ? "y" : "ies"} (need ${MIN_OPERATOR_KEY_LENGTH}-${MAX_KEY_LENGTH} characters, no spaces).`);
  }
  operatorKeys = map;
  return operatorKeys;
}

/* ------------------------------------------------------------- issuance */

export function parseKeyRequest(body: unknown): { name: string } {
  const name = isRecord(body) && typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw invalidRequest("Provide { \"name\": \"…\" } with 1-64 printable characters.", [
      { path: "name", message: "Required, 1-64 printable characters." },
    ]);
  }
  return { name };
}

export async function issueDeveloperKey(name: string): Promise<IssuedApiKey> {
  const key = `${DEVELOPER_KEY_PREFIX}${randomBase62(32)}`;
  const record: ApiKeyRecord = {
    id: `key_${randomHex(12)}`,
    name,
    tier: "developer",
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  await apiKeyStore().insert(record, sha256Hex(key));
  return { id: record.id, name: record.name, tier: record.tier, createdAt: record.createdAt, key };
}

/* --------------------------------------------------------------- lookup */

interface CachedLookup {
  readonly record: ApiKeyRecord;
  readonly expiresAt: number;
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_CACHED = 10_000;
/** Issued keys (valid or revoked). */
const lookupCache = new Map<string, CachedLookup>();
/** Unknown keys -> expiry, kept apart so random keys cannot evict issued ones. */
const unknownKeys = new Map<string, number>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/*
 * Store lookups for uncached developer keys, per client IP and 1-minute
 * window, at the public tier limit. The budget is taken before the store is
 * queried and given back when the key turns out to be valid, so cache hits and
 * valid keys cost nothing while unknown keys (or a failing store) cannot push
 * more than the limit of queries per IP into the shared pool.
 */
const LOOKUP_WINDOW_MS = 60_000;

interface LookupBudget {
  used: number;
  readonly windowStart: number;
}

const lookupBudgets = new Map<string, LookupBudget>();

/** Takes one lookup from the client's budget; throws 429 when it is spent. */
function reserveLookup(client: string, now: number): LookupBudget {
  let budget = lookupBudgets.get(client);
  if (!budget || now - budget.windowStart >= LOOKUP_WINDOW_MS) {
    budget = { used: 0, windowStart: now };
    remember(lookupBudgets, client, budget);
  }
  if (budget.used >= TIER_LIMITS.public) {
    const seconds = Math.max(1, Math.ceil((budget.windowStart + LOOKUP_WINDOW_MS - now) / 1000));
    throw new HttpError(429, "RATE_LIMITED", `Too many unrecognised API keys from this address. Retry in ${seconds}s.`, {
      headers: { "Retry-After": String(seconds) },
    });
  }
  budget.used += 1;
  return budget;
}

async function findDeveloperKey(keyHash: string, client: string, now: number): Promise<ApiKeyRecord | null> {
  const cached = lookupCache.get(keyHash);
  if (cached && cached.expiresAt > now) return cached.record;
  const unknownUntil = unknownKeys.get(keyHash);
  if (unknownUntil !== undefined && unknownUntil > now) return null;
  const budget = reserveLookup(client, now);
  const record = await apiKeyStore().findByHash(keyHash);
  if (record) {
    if (!record.revokedAt) budget.used = Math.max(0, budget.used - 1);
    unknownKeys.delete(keyHash);
    remember(lookupCache, keyHash, { record, expiresAt: now + POSITIVE_TTL_MS });
  } else {
    lookupCache.delete(keyHash);
    remember(unknownKeys, keyHash, now + NEGATIVE_TTL_MS);
  }
  return record;
}

function invalidKey(message = "The API key is invalid or revoked."): HttpError {
  return new HttpError(401, "INVALID_API_KEY", message);
}

/** Extracts the presented credential. Returns null when none was sent; throws 401 on a malformed header. */
function presentedKey(authorization: string | undefined, headerKey: string | undefined): string | null {
  let bearer: string | null = null;
  if (authorization !== undefined) {
    const match = /^Bearer[ ]+([^\s]+)[ ]*$/iu.exec(authorization);
    if (!match?.[1]) {
      throw new HttpError(401, "INVALID_AUTHORIZATION", "Authorization must be \"Bearer <api key>\".");
    }
    bearer = match[1];
  }
  const direct = headerKey?.trim() || null;
  if (bearer && direct && bearer !== direct) {
    throw new HttpError(401, "INVALID_AUTHORIZATION", "Authorization and X-Kletia-Key carry different keys.");
  }
  const key = bearer ?? direct;
  if (key !== null && key.length > MAX_KEY_LENGTH) throw invalidKey();
  return key;
}

/**
 * Resolves the caller's tier. Never responds itself: a failed credential is
 * recorded on the request and rejected by `enforceAuthentication` after the
 * rate limiter has counted it against the caller's IP. An uncached key is
 * looked up in the store only while the IP has lookup budget left (429
 * otherwise), so throttled requests never reach Postgres.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const key = presentedKey(req.get("authorization"), req.get("x-kletia-key"));
      if (key === null) return;
      const hash = sha256Hex(key);
      const operator = loadOperatorKeys().get(hash);
      if (operator) {
        setAuth(req, { tier: "operator", keyId: operator.id });
        return;
      }
      if (!DEVELOPER_KEY_PATTERN.test(key)) {
        setAuth(req, { tier: "public", rejection: invalidKey() });
        return;
      }
      const record = await findDeveloperKey(hash, clientIp(req), Date.now());
      if (!record || record.revokedAt) {
        setAuth(req, { tier: "public", rejection: invalidKey() });
        return;
      }
      setAuth(req, { tier: record.tier, keyId: record.id });
    } catch (error) {
      setAuth(req, {
        tier: "public",
        rejection: error instanceof HttpError || error instanceof PlatformError
          ? error
          : new PlatformError("STORE_UNAVAILABLE", "API key verification is temporarily unavailable.", 503),
      });
    }
  })().then(() => next(), next);
};

/** Rejects requests whose credential failed (runs after the rate limiter). */
export const enforceAuthentication: RequestHandler = (req, res, next) => {
  const { rejection } = authOf(req);
  if (rejection) {
    sendError(req, res, rejection);
    return;
  }
  next();
};

/** Route guard: developer or operator key required. */
export const requireApiKey: RequestHandler = (req, res, next) => {
  const auth = authOf(req);
  if (auth.tier === "public" || !auth.keyId) {
    sendError(
      req,
      res,
      new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key. Issue one with POST /v1/keys and send it as Authorization: Bearer <key>."),
    );
    return;
  }
  next();
};
