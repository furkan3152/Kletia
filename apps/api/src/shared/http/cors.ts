import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";

/**
 * CORS has two independent policies, chosen by request path:
 *
 * - First-party application API (everything except /v1): an exact origin
 *   allowlist with credentials. Built-in origins plus CORS_ORIGINS; local
 *   development origins only outside production. A disallowed origin is
 *   rejected with an error.
 * - Public platform API (/v1): any origin, never credentials. Integrators
 *   authenticate with an API key header, so the browser origin is not a
 *   trust signal there. The MCP endpoint (/v1/mcp) reflects the requested
 *   headers, because MCP clients send per-call `Mcp-Param-*` headers that
 *   cannot be listed; its Origin rule is enforced by the route itself.
 */

const productionOrigins = [
  "https://kletia.com",
  "https://www.kletia.com",
  "https://kletiaai.xyz",
  "https://www.kletiaai.xyz",
  "https://kletia-frontend.onrender.com",
];
const developmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:10000",
  "http://127.0.0.1:10000",
];
const builtInOrigins = [
  ...productionOrigins,
  ...(process.env.NODE_ENV === "production" ? [] : developmentOrigins),
];
function normalizeCorsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CORS_ORIGINS contains an invalid origin.");
  }
  const isLocalDevelopmentOrigin =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !isLocalDevelopmentOrigin)
  ) {
    throw new Error(
      "CORS_ORIGINS entries must be exact HTTPS origins; local HTTP is development-only.",
    );
  }
  return parsed.origin;
}
const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map(normalizeCorsOrigin);
export const allowedOrigins = [
  ...new Set([...builtInOrigins, ...configuredOrigins]),
];

/** First-party application API policy (all paths outside /v1). */
export const apiCorsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin is not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-PAYMENT",
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "Access-Control-Expose-Headers",
    "X-Kletia-Network",
    "X-Kletia-Chain-Id",
    "X-Kletia-Chain-Ref",
    "X-Kletia-Intent-Version",
    "X-Request-Id",
    "X-Client-Name",
    "X-Client-Version",
  ],
  exposedHeaders: [
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "X-PAYMENT-RESPONSE",
  ],
};

/** Path prefix of the public platform API. */
export const PLATFORM_API_PREFIX = "/v1";

/** Public platform API policy (/v1 and everything below it). */
export const platformCorsOptions: CorsOptions = {
  origin: "*",
  credentials: false,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Kletia-Key",
    "X-Request-Id",
    "Last-Event-ID",
    "X-Kletia-SDK",
    "Idempotency-Key",
  ],
  exposedHeaders: [
    "X-Request-Id",
    "RateLimit",
    "RateLimit-Policy",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "Retry-After",
    "Idempotent-Replayed",
  ],
  maxAge: 600,
};

/**
 * MCP endpoint policy (/v1/mcp): the platform policy, but request headers
 * are reflected (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and
 * `Mcp-Param-*`), and MCP response headers are exposed.
 */
export const mcpCorsOptions: CorsOptions = {
  ...platformCorsOptions,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: undefined,
  exposedHeaders: [...(platformCorsOptions.exposedHeaders as string[]), "MCP-Protocol-Version", "Mcp-Session-Id"],
};

/** True for the MCP endpoint (case-insensitive, like Express routing). */
export function isMcpPath(path: string): boolean {
  return /^\/v1\/mcp\/?$/iu.test(path);
}

/**
 * True for `/v1` and any path below it. Case-insensitive because Express
 * routing is case-insensitive by default, so `/V1/...` reaches the same
 * router and must get the same policy.
 */
export function isPlatformApiPath(path: string): boolean {
  return /^\/v1(?:\/|$)/iu.test(path);
}

/**
 * One CORS middleware for the whole app: /v1 gets the public platform
 * policy, every other path gets the unchanged first-party policy.
 */
export function createCorsMiddleware(): RequestHandler {
  const apiCors = cors(apiCorsOptions);
  const platformCors = cors(platformCorsOptions);
  const mcpCors = cors(mcpCorsOptions);
  return (req, res, next) =>
    isMcpPath(req.path)
      ? mcpCors(req, res, next)
      : isPlatformApiPath(req.path)
        ? platformCors(req, res, next)
        : apiCors(req, res, next);
}
