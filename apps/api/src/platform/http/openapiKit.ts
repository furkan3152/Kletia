/**
 * Small builders for OpenAPI fragments that live next to their features
 * (preview, receipts) and are merged into the document by openapi.ts. Same
 * shapes as the document's own helpers.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
export const arrayOf = (items: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: "array", items, ...extra });
export const str = (extra: JsonObject = {}): JsonObject => ({ type: "string", ...extra });
export const int = (extra: JsonObject = {}): JsonObject => ({ type: "integer", ...extra });
export const num = (extra: JsonObject = {}): JsonObject => ({ type: "number", ...extra });
export const bool = (extra: JsonObject = {}): JsonObject => ({ type: "boolean", ...extra });
export const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
export const obj = (properties: JsonObject, required: readonly string[] = [], extra: JsonObject = {}): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  ...extra,
});

export const REQUEST_ID_HEADER: JsonObject = { $ref: "#/components/headers/X-Request-Id" };

/** A JSON success response with the standard headers. */
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

/** 204 without a body. */
export function noContent(description: string): JsonObject {
  return { description, headers: { "X-Request-Id": REQUEST_ID_HEADER } };
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

/** Error responses of one operation (400, 401, 429, 500 and 503 are always possible). */
export function errors(...statuses: string[]): JsonObject {
  const out: JsonObject = {};
  for (const status of ["400", "401", "429", "500", "503", ...statuses]) {
    const name = ERROR_RESPONSES[status];
    if (name) out[status] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

export function jsonBody(schema: string, required = true): JsonObject {
  return { required, content: { "application/json": { schema: ref(schema) } } };
}

export const intentIdParameter: JsonObject = { $ref: "#/components/parameters/IntentId" };
export const idempotencyKeyParameter: JsonObject = { $ref: "#/components/parameters/IdempotencyKey" };
export const KEY_REQUIRED: Json = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
