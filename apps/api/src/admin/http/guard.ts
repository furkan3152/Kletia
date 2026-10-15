/**
 * Request guards of the admin API: admin enabled, store available, admin
 * origin, the X-Kletia-Admin header, and (for everything except the sign-in
 * routes) a valid session cookie.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { resolveSession } from "../auth/service.js";
import type { AdminDeps, AdminSessionContext } from "../deps.js";
import { clearSessionCookie, readSessionCookie } from "./cookies.js";
import { AdminHttpError } from "./errors.js";

declare module "express-serve-static-core" {
  interface Request {
    adminSession?: AdminSessionContext;
    adminOrigin?: string;
  }
}

export function disabledError(reason: string | null): AdminHttpError {
  if (reason === "store_missing") {
    return new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "The admin panel needs KLETIA_DATABASE_URL in production.");
  }
  return new AdminHttpError(503, "ADMIN_DISABLED", "The admin panel is off on this API. Set KLETIA_ADMIN_ADDRESSES or KLETIA_ADMIN_SOLANA_ADDRESSES.");
}

/** Enabled + store + origin + header. Sets req.adminOrigin. */
export function requireAdminRequest(deps: AdminDeps): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const config = deps.config();
    if (!config.enabled) return next(disabledError(config.disabledReason));
    try {
      deps.store();
    } catch {
      return next(new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "Admin storage is not available on this API."));
    }
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !config.origins.includes(origin)) {
      return next(new AdminHttpError(403, "ADMIN_ORIGIN_FORBIDDEN", "Open the admin panel on kletiaai.xyz."));
    }
    if (req.headers["x-kletia-admin"] !== "1") {
      return next(new AdminHttpError(403, "ADMIN_HEADER_REQUIRED", "Admin requests must send X-Kletia-Admin: 1."));
    }
    req.adminOrigin = origin;
    next();
  };
}

/** Loads the session when a valid cookie is present; never rejects. */
export function loadAdminSession(deps: AdminDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const sessionId = readSessionCookie(req, deps.config().production);
      if (sessionId && req.adminOrigin) {
        const session = await resolveSession(deps, sessionId, req.adminOrigin);
        if (session) req.adminSession = session;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 401 ADMIN_SESSION_REQUIRED (and clears the cookie) unless a session was loaded. */
export function requireAdminSession(deps: AdminDeps): RequestHandler {
  return (req, res, next) => {
    if (req.adminSession) return next();
    clearSessionCookie(res, deps.config().production);
    next(new AdminHttpError(401, "ADMIN_SESSION_REQUIRED", "Sign in with the admin wallet."));
  };
}

export function sessionOf(req: Request): AdminSessionContext {
  if (!req.adminSession) throw new AdminHttpError(401, "ADMIN_SESSION_REQUIRED", "Sign in with the admin wallet.");
  return req.adminSession;
}
