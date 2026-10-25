/**
 * JSON Schema builders, shared patterns, response helpers and parameters.
 */
import { CONTRACT_ID_PATTERN, SESSION_ID_PATTERN } from "@kletia/core";
import { WEBHOOK_ID_PATTERN } from "../context.js";
import { API_KEY_ID_PATTERN } from "../keys.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
export const arrayOf = (items: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: "array", items, ...extra });
export const str = (extra: JsonObject = {}): JsonObject => ({ type: "string", ...extra });
export const int = (extra: JsonObject = {}): JsonObject => ({ type: "integer", ...extra });
export const num = (extra: JsonObject = {}): JsonObject => ({ type: "number", ...extra });
export const bool = (extra: JsonObject = {}): JsonObject => ({ type: "boolean", ...extra });
export const obj = (properties: JsonObject, required: readonly string[] = [], extra: JsonObject = {}): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  ...extra,
});

export const INTENT_STATUSES = ["planned", "executing", "settling", "completed", "partially_completed", "failed", "expired", "cancelled", "indeterminate"];
export const STEP_STATUSES = ["pending", "ready", "awaiting_signature", "submitted", "confirmed", "settling", "settled", "failed", "skipped", "indeterminate"];
export const ACCOUNT_EXAMPLE = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";


export const EVM_ADDRESS = "^0x[0-9a-fA-F]{40}$";
export const BASE58 = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
export const WEI = "^(0|[1-9][0-9]*)$";
export const DECIMAL = "^(0|[1-9][0-9]*)(\\.[0-9]+)?$";

export const REQUEST_ID_HEADER: JsonObject = { $ref: "#/components/headers/X-Request-Id" };

export function ok(schema: string, description: string, extraHeaders: JsonObject = {}): JsonObject {
  return {
    description,
    headers: {
      "X-Request-Id": REQUEST_ID_HEADER,
      RateLimit: { $ref: "#/components/headers/RateLimit" },
      "RateLimit-Policy": { $ref: "#/components/headers/RateLimit-Policy" },
      ...extraHeaders,
    },
    content: { "application/json": { schema: ref(schema) } },
  };
}

const ERROR_RESPONSES: Readonly<Record<string, string>> = {
  "400": "BadRequest",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "NotFound",
  "409": "Conflict",
  "410": "Gone",
  "413": "PayloadTooLarge",
  "415": "UnsupportedMediaType",
  "422": "Unprocessable",
  "429": "TooManyRequests",
  "500": "InternalError",
  "502": "BadGateway",
  "503": "Unavailable",
  "504": "GatewayTimeout",
};

/**
 * Error responses of one operation. Every operation may be called with a key
 * (authentication is optional everywhere), so 401 for a key that fails and 503
 * when key verification is unavailable are always possible.
 */
export function errors(...statuses: string[]): JsonObject {
  const out: JsonObject = {};
  for (const status of ["400", "401", "429", "500", "503", ...statuses]) {
    const name = ERROR_RESPONSES[status];
    if (name) out[status] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

/** A JSON success response whose body is one of `schemas`. */
export function oneOfResponse(schemas: readonly string[], description: string, extraHeaders: JsonObject = {}): JsonObject {
  const response = ok(schemas[0] as string, description, extraHeaders) as { content: { "application/json": { schema: JsonObject } } } & JsonObject;
  return { ...response, content: { "application/json": { schema: { oneOf: schemas.map((name) => ref(name)) } } } };
}

export function jsonBody(schema: string, required = true): JsonObject {
  return { required, content: { "application/json": { schema: ref(schema) } } };
}

export const KEY_REQUIRED: Json = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
export const intentIdParam: JsonObject = { $ref: "#/components/parameters/IntentId" };
export const stepIdParam: JsonObject = { $ref: "#/components/parameters/StepId" };
export const idempotencyKeyParam: JsonObject = { $ref: "#/components/parameters/IdempotencyKey" };
export const webhookIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: WEBHOOK_ID_PATTERN.source }) };
export const keyIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: API_KEY_ID_PATTERN.source }) };
export const contractIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: CONTRACT_ID_PATTERN.source }) };
export const sessionIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: SESSION_ID_PATTERN.source }) };
export const REPLAYED_HEADER: JsonObject = { "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" } };
export const IDEMPOTENCY_NOTE =
  " Honours `Idempotency-Key` (with an API key): a retry with the same key and request replays the stored response with `Idempotent-Replayed: true`.";

export function errorResponse(description: string): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: ref("Error") } },
  };
}

/** An error of POST /v1/mcp: a JSON-RPC error body, or (`orPlatform`) also the platform envelope from the router. */
export function mcpErrorResponse(description: string, orPlatform = false): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: orPlatform ? { oneOf: [ref("JsonRpcErrorResponse"), ref("Error")] } : ref("JsonRpcErrorResponse") } },
  };
}
