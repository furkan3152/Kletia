/**
 * Admin rate limits (process-local). Mounted before the public /api/
 * limiter so admin reads do not spend the public budget.
 */
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { sha256Hex } from "../../platform/http/secrets.js";
import { parseCookies } from "./cookies.js";
import { AdminHttpError, sendAdminError } from "./errors.js";

function sessionKey(req: Request): string {
  for (const [name, value] of parseCookies(req.headers.cookie)) {
    if (name === "__Host-kletia_admin" || name === "kletia_admin") return `s:${sha256Hex(value).slice(0, 32)}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

function limiter(windowMs: number, limit: number, key: "ip" | "session" | "global"): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: key === "global" ? () => "global" : key === "session" ? sessionKey : (req) => ipKeyGenerator(req.ip ?? ""),
    handler: (_req, res) => sendAdminError(res, new AdminHttpError(429, "ADMIN_RATE_LIMITED", "Too many admin requests. Wait a moment and retry.")),
  });
}

export interface AdminLimiters {
  readonly nonce: RequestHandler;
  readonly verify: RequestHandler;
  readonly read: RequestHandler;
  readonly write: RequestHandler;
  readonly renderDeploy: RequestHandler;
  readonly rescan: RequestHandler;
}

export function createAdminLimiters(): AdminLimiters {
  return {
    nonce: limiter(60_000, 10, "ip"),
    verify: limiter(60_000, 10, "ip"),
    read: limiter(60_000, 240, "session"),
    write: limiter(60_000, 30, "session"),
    renderDeploy: limiter(10 * 60_000, 3, "global"),
    rescan: limiter(10 * 60_000, 6, "session"),
  };
}
