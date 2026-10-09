/**
 * Origin of the Kletia web app, used for links the API hands out: error docs
 * (`/developers#error-<CODE>`) and the MCP signing hand-off (`/studio?q=`).
 *
 * KLETIA_WEB_ORIGIN must be an exact HTTPS origin (plain HTTP only for
 * localhost outside production); anything else falls back to the hosted app,
 * so a misconfiguration can never point users at an arbitrary scheme.
 */
import { ERROR_DOCS_ORIGIN } from "@kletia/core";

let cached: { readonly raw: string | undefined; readonly origin: string } | null = null;

function parseOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowedScheme = url.protocol === "https:" || (url.protocol === "http:" && localhost && process.env.NODE_ENV !== "production");
  if (!allowedScheme || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

export function kletiaWebOrigin(): string {
  const raw = process.env.KLETIA_WEB_ORIGIN?.trim() || undefined;
  if (cached && cached.raw === raw) return cached.origin;
  const origin = raw ? parseOrigin(raw) : null;
  if (raw && !origin) console.warn("[platform] KLETIA_WEB_ORIGIN must be an exact HTTPS origin; using the hosted app.");
  cached = { raw, origin: origin ?? ERROR_DOCS_ORIGIN };
  return cached.origin;
}
