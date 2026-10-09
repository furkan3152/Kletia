/**
 * Origin rules for POST /v1/mcp (the MCP Streamable HTTP transport requires
 * servers to validate Origin; the SDK handler does not).
 *
 * - No Origin header: allowed (server-side agents and CLIs send none).
 * - `null`, malformed, or not an origin (path, credentials): 403.
 * - HTTPS origins: allowed (the endpoint takes no cookies and every tool is
 *   read-only, the same exposure as the public /v1 CORS policy), unless
 *   KLETIA_MCP_ALLOWED_ORIGINS lists exact origins, which then bound it.
 * - Plain HTTP: only localhost / 127.0.0.1 / [::1], and only outside production.
 * - A request addressed to a loopback host (a self-hosted local server) only
 *   accepts loopback origins.
 */
import type { Request, RequestHandler } from "express";
import { PlatformError } from "../../errors.js";
import { sendError } from "../context.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function forbidden(message: string): PlatformError {
  return new PlatformError("MCP_ORIGIN_FORBIDDEN", message, 403);
}

function exactOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin === "null" || url.origin !== value || url.username || url.password) return null;
  return url;
}

let configured: { readonly raw: string; readonly origins: ReadonlySet<string> } | null = null;

/** KLETIA_MCP_ALLOWED_ORIGINS as a set of exact origins (empty: no allowlist). Invalid entries are ignored with a warning. */
export function allowedMcpOrigins(): ReadonlySet<string> {
  const raw = process.env.KLETIA_MCP_ALLOWED_ORIGINS?.trim() ?? "";
  if (configured?.raw === raw) return configured.origins;
  const origins = new Set<string>();
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const url = exactOrigin(entry);
    if (url && (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) origins.add(url.origin);
    else console.warn("[platform] KLETIA_MCP_ALLOWED_ORIGINS entries must be exact origins; ignoring one entry.");
  }
  configured = { raw, origins };
  return origins;
}

function requestHostIsLoopback(req: Request): boolean {
  const host = (req.get("host") ?? "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0] ?? "";
  return LOOPBACK.has(name);
}

/** Throws 403 MCP_ORIGIN_FORBIDDEN unless the request's Origin may use the MCP endpoint. */
export function assertMcpOrigin(req: Request): void {
  const origin = req.get("origin");
  if (origin === undefined) return;
  const url = exactOrigin(origin.trim());
  if (!url) throw forbidden("The Origin header is not a valid origin.");
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol === "http:" && !(loopback && process.env.NODE_ENV !== "production")) {
    throw forbidden("Plain HTTP origins are only accepted from localhost during development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw forbidden("Only HTTPS origins may call the MCP endpoint.");
  if (requestHostIsLoopback(req) && !loopback) throw forbidden("A local MCP server only accepts local origins.");
  const allowlist = allowedMcpOrigins();
  if (allowlist.size > 0 && !allowlist.has(url.origin)) throw forbidden("This origin is not allowed to call the MCP endpoint.");
}

export const mcpOriginGuard: RequestHandler = (req, res, next) => {
  try {
    assertMcpOrigin(req);
  } catch (error) {
    sendError(req, res, error);
    return;
  }
  next();
};
