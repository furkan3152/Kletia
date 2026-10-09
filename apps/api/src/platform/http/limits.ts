/**
 * Rate limits for the public API (process-local, fixed 1-minute windows).
 *
 * | Tier      | Key            | Limit        |
 * |-----------|----------------|--------------|
 * | public    | client IP (/56 for IPv6) | 30/min |
 * | developer | API key id     | 300/min      |
 * | operator  | API key id     | 1200/min     |
 *
 * POST /v1/keys is additionally limited to 5 per hour per IP. Requests with a
 * rejected credential count against the caller's IP at the public limit, and
 * store lookups of uncached API keys are throttled per IP in auth.ts.
 *
 * Custom contracts, per API key on top of the tier limit: registrations,
 * PATCH and reverify share 20 per hour; `test` and `inspect` (and the MCP
 * `test_contract_action` tool) share 20 per minute.
 */
import type { Request, RequestHandler } from "express";
import { CONTRACT_LIMITS } from "@kletia/core";
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { authOf, HttpError, sendError, type ApiTier } from "./context.js";

export const TIER_LIMITS: Readonly<Record<ApiTier, number>> = Object.freeze({
  public: 30,
  developer: 300,
  operator: 1_200,
});

export const KEY_ISSUANCE_LIMIT_PER_HOUR = 5;

/** Rate-limit identity of the caller's address (IPv6 grouped to /56). */
export function clientIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function retryAfterSeconds(req: Request): number {
  const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
  const reset = info?.resetTime?.getTime();
  return reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60;
}

/**
 * One limiter for every tier: the key and the limit both come from the
 * authenticated tier. The handler's getKey("key:<id>") reads a key's current
 * window (GET /v1/usage).
 */
export function createTierLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: (req) => {
      const auth = authOf(req);
      return auth.rejection || !auth.keyId ? TIER_LIMITS.public : TIER_LIMITS[auth.tier];
    },
    keyGenerator: (req) => {
      const auth = authOf(req);
      return auth.keyId && !auth.rejection ? `key:${auth.keyId}` : `ip:${clientIp(req)}`;
    },
    identifier: (req) => {
      const auth = authOf(req);
      return auth.keyId && !auth.rejection ? auth.tier : "public";
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const auth = authOf(req);
      const tier = auth.keyId && !auth.rejection ? auth.tier : "public";
      const seconds = retryAfterSeconds(req);
      sendError(
        req,
        res,
        new HttpError(429, "RATE_LIMITED", `Rate limit of ${TIER_LIMITS[tier]} requests per minute exceeded for the ${tier} tier. Retry in ${seconds}s.`, {
          headers: { "Retry-After": String(seconds) },
        }),
      );
    },
  });
}

/** POST /v1/keys: 5 developer keys per hour per IP. */
export function createKeyIssuanceLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 60 * 60_000,
    limit: KEY_ISSUANCE_LIMIT_PER_HOUR,
    keyGenerator: (req) => `keys:${clientIp(req)}`,
    identifier: "key-issuance",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const seconds = retryAfterSeconds(req);
      sendError(
        req,
        res,
        new HttpError(429, "RATE_LIMITED", `At most ${KEY_ISSUANCE_LIMIT_PER_HOUR} API keys can be issued per hour from one address. Retry in ${seconds}s.`, {
          headers: { "Retry-After": String(seconds) },
        }),
      );
    },
  });
}

/* ------------------------------------------------------ contract limits */

export const CONTRACT_WRITES_PER_HOUR = CONTRACT_LIMITS.registrationsPerHour;
export const CONTRACT_TESTS_PER_MINUTE = CONTRACT_LIMITS.testsPerMinute;

interface Window {
  count: number;
  readonly startedAt: number;
}

/**
 * A fixed-window counter per API key, shared by HTTP routes and MCP tools
 * (process-local, like the tier limiter). `take` throws 429 RATE_LIMITED with
 * Retry-After when the key's window is spent.
 */
export class KeyWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly what: string,
    private readonly maxKeys = 20_000,
  ) {}

  take(keyId: string, now = Date.now()): void {
    let window = this.windows.get(keyId);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { count: 0, startedAt: now };
      this.windows.delete(keyId);
      this.windows.set(keyId, window);
      while (this.windows.size > this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest === undefined) break;
        this.windows.delete(oldest);
      }
    }
    if (window.count >= this.limit) {
      const seconds = Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
      throw new HttpError(429, "RATE_LIMITED", `At most ${this.limit} ${this.what} per API key. Retry in ${seconds}s.`, {
        headers: { "Retry-After": String(seconds) },
      });
    }
    window.count += 1;
  }

  reset(): void {
    this.windows.clear();
  }

  /** Express guard for keyed routes (mount after requireApiKey). */
  middleware(): RequestHandler {
    return (req, res, next) => {
      const keyId = authOf(req).keyId;
      if (!keyId) {
        next();
        return;
      }
      try {
        this.take(keyId);
      } catch (error) {
        sendError(req, res, error);
        return;
      }
      next();
    };
  }
}

/** Registrations, PATCH and reverify: 20 per hour per key. */
export const contractWriteLimiter = new KeyWindowLimiter(CONTRACT_WRITES_PER_HOUR, 60 * 60_000, "contract registrations, updates and reverifications per hour");
/** `test` and `inspect` (HTTP and MCP): 20 per minute per key. */
export const contractTestLimiter = new KeyWindowLimiter(CONTRACT_TESTS_PER_MINUTE, 60_000, "contract tests and inspections per minute");

/* ------------------------------------------------------- stream slots */

const MAX_STREAMS_PER_CLIENT = 10;
const MAX_STREAMS_TOTAL = 2_000;
const openStreams = new Map<string, number>();
let totalStreams = 0;

/**
 * Reserves an SSE slot for the caller; returns a release function or null when
 * the caller is at capacity. Every stream counts against the client IP, and a
 * keyed stream also against its key, so minting more keys does not raise one
 * address's share of the global pool.
 */
export function acquireStreamSlot(req: Request): (() => void) | null {
  const auth = authOf(req);
  const clients = [`ip:${clientIp(req)}`, ...(auth.keyId ? [`key:${auth.keyId}`] : [])];
  if (totalStreams >= MAX_STREAMS_TOTAL) return null;
  if (clients.some((client) => (openStreams.get(client) ?? 0) >= MAX_STREAMS_PER_CLIENT)) return null;
  for (const client of clients) openStreams.set(client, (openStreams.get(client) ?? 0) + 1);
  totalStreams += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalStreams -= 1;
    for (const client of clients) {
      const remaining = (openStreams.get(client) ?? 1) - 1;
      if (remaining <= 0) openStreams.delete(client);
      else openStreams.set(client, remaining);
    }
  };
}

/** Open SSE streams in this process (observability and tests). */
export function openStreamCount(): number {
  return totalStreams;
}
