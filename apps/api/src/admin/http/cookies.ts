/**
 * Admin session cookie. Host-only (no Domain), HttpOnly, SameSite=Strict;
 * `__Host-` prefixed and Secure in production.
 */
import type { Request, Response } from "express";

export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function sessionCookieName(production: boolean): string {
  return production ? "__Host-kletia_admin" : "kletia_admin";
}

/** Parses the Cookie header into a map (first value wins, values URI-decoded when possible). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) value = value.slice(1, -1);
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

export function readSessionCookie(req: Request, production: boolean): string | null {
  const value = parseCookies(req.headers.cookie).get(sessionCookieName(production));
  return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function cookieAttributes(production: boolean, maxAge: number): string {
  return `Path=/; HttpOnly;${production ? " Secure;" : ""} SameSite=Strict; Max-Age=${maxAge}`;
}

export function setSessionCookie(res: Response, sessionId: string, production: boolean): void {
  res.append("Set-Cookie", `${sessionCookieName(production)}=${sessionId}; ${cookieAttributes(production, SESSION_MAX_AGE_SECONDS)}`);
}

export function clearSessionCookie(res: Response, production: boolean): void {
  res.append("Set-Cookie", `${sessionCookieName(production)}=; ${cookieAttributes(production, 0)}`);
}
