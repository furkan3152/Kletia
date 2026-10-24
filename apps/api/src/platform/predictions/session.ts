/**
 * Venue sessions: the Polymarket L2 credentials the CLOB derives from the
 * user's sign-in signature, sealed (AES-256-GCM under the platform secret,
 * `sealSecret`) for that one account and handed back to the client as an
 * opaque string. Kletia stores nothing: the client keeps the session for
 * the session's life (8 hours) and sends it with each relay; the server
 * opens it, uses it for that request, and never logs it. The credentials
 * place and cancel orders only; they cannot move funds.
 */
import { PREDICTION_LIMITS } from "@kletia/core";
import { PlatformError } from "../errors.js";
import { openSecret, sealingAvailable, sealSecret } from "../http/secrets.js";
import type { ClobCredentials } from "./signing.js";

const context = (account: string) => `predictions:polymarket:${account.toLowerCase()}`;
const SESSION_PATTERN = /^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]{20,2000}$/u;

export interface OpenSession extends ClobCredentials {
  /** Unix seconds after which the session is refused. */
  readonly expiresAt: number;
}

export function sealSession(account: string, credentials: ClobCredentials, nowMs: number): { readonly session: string; readonly expiresAt: number } {
  if (!sealingAvailable()) throw new PlatformError("PREDICTION_SESSION_UNAVAILABLE", "This server cannot seal venue credentials (KLETIA_PLATFORM_SECRET is not configured), so it relays no order.", 503);
  const expiresAt = Math.floor(nowMs / 1000) + PREDICTION_LIMITS.sessionTtlSeconds;
  const payload = JSON.stringify({ k: credentials.apiKey, s: credentials.secret, p: credentials.passphrase, e: expiresAt });
  return { session: sealSecret(payload, context(account)), expiresAt };
}

/** Opens a session sealed for `account`; PREDICTION_SESSION_REQUIRED when it is missing, foreign, malformed or expired. */
export function openSession(account: string, session: unknown, nowMs: number): OpenSession {
  const required = (message: string) => new PlatformError("PREDICTION_SESSION_REQUIRED", message, 400, [{ path: "session", message }]);
  if (typeof session !== "string" || !SESSION_PATTERN.test(session)) throw required("Sign in to Polymarket's order book first (POST /v1/predictions/session) and send the session it returns.");
  if (!sealingAvailable()) throw new PlatformError("PREDICTION_SESSION_UNAVAILABLE", "This server cannot open venue sessions (KLETIA_PLATFORM_SECRET is not configured).", 503);
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(session, context(account)));
  } catch {
    throw required("The session is not this account's (or this server's). Sign in again.");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.k !== "string" || typeof value.s !== "string" || typeof value.p !== "string" || typeof value.e !== "number") throw required("The session is malformed. Sign in again.");
  if (nowMs / 1000 > value.e) throw required("The session expired. Sign in again.");
  return { apiKey: value.k, secret: value.s, passphrase: value.p, expiresAt: value.e };
}
