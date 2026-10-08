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
 * rejected credential count against the caller's IP at the public limit.
 */
import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { authOf, HttpError, sendError, type ApiTier } from "./context.js";

export const TIER_LIMITS: Readonly<Record<ApiTier, number>> = Object.freeze({
  public: 30,
  developer: 300,
  operator: 1_200,
});

export const KEY_ISSUANCE_LIMIT_PER_HOUR = 5;

function clientIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function retryAfterSeconds(req: Request): number {
  const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
  const reset = info?.resetTime?.getTime();
  return reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60;
}

/** One limiter for every tier: the key and the limit both come from the authenticated tier. */
export function createTierLimiter(): RequestHandler {
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

/* ------------------------------------------------------- stream slots */

const MAX_STREAMS_PER_CLIENT = 10;
const MAX_STREAMS_TOTAL = 2_000;
const openStreams = new Map<string, number>();
let totalStreams = 0;

/** Reserves an SSE slot for the caller; returns a release function or null when the caller is at capacity. */
export function acquireStreamSlot(req: Request): (() => void) | null {
  const auth = authOf(req);
  const client = auth.keyId ? `key:${auth.keyId}` : `ip:${clientIp(req)}`;
  const current = openStreams.get(client) ?? 0;
  if (current >= MAX_STREAMS_PER_CLIENT || totalStreams >= MAX_STREAMS_TOTAL) return null;
  openStreams.set(client, current + 1);
  totalStreams += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalStreams -= 1;
    const remaining = (openStreams.get(client) ?? 1) - 1;
    if (remaining <= 0) openStreams.delete(client);
    else openStreams.set(client, remaining);
  };
}

/** Open SSE streams in this process (observability and tests). */
export function openStreamCount(): number {
  return totalStreams;
}
