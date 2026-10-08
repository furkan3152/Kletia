/**
 * Typed loaders for the public Kletia Platform API v1 endpoints the web app
 * reads. Every loader takes the shared client and an AbortSignal so it can be
 * passed straight to `useApiResource` / `useApiAction`.
 */
import type {
  ApiKeyRecord,
  HealthReport,
  IntentGraph,
  IntentRequest,
  KletiaClient,
  NetworkCapabilities,
  QuoteRequest,
  QuoteResponse,
} from "@kletia/sdk";
import type { ProtocolDescriptor } from "@kletia/core";

import { PLATFORM_ORIGIN, sdkSignal } from "./kletiaClient";

export type { ApiKeyRecord, HealthReport, NetworkCapabilities, QuoteRequest, QuoteResponse };

export function fetchHealth(client: KletiaClient, signal?: AbortSignal): Promise<HealthReport> {
  return client.request<HealthReport>("GET", "/health", undefined, { signal: sdkSignal(signal) });
}

export async function fetchNetworks(
  client: KletiaClient,
  signal?: AbortSignal,
): Promise<NetworkCapabilities[]> {
  const body = await client.request<{ networks: NetworkCapabilities[] }>("GET", "/networks", undefined, {
    signal: sdkSignal(signal),
  });
  return Array.isArray(body?.networks) ? body.networks : [];
}

export async function fetchProtocols(
  client: KletiaClient,
  signal?: AbortSignal,
): Promise<ProtocolDescriptor[]> {
  const body = await client.request<{ protocols: ProtocolDescriptor[] }>("GET", "/protocols", undefined, {
    signal: sdkSignal(signal),
  });
  return Array.isArray(body?.protocols) ? body.protocols : [];
}

/** Minimal OpenAPI 3.1 shape the endpoint reference needs. */
export interface OpenApiOperation {
  readonly summary?: string;
  readonly description?: string;
  readonly operationId?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Record<string, readonly string[]>[];
}

export interface OpenApiDocument {
  readonly openapi?: string;
  readonly info?: { readonly title?: string; readonly version?: string };
  readonly paths?: Readonly<Record<string, Readonly<Record<string, OpenApiOperation | unknown>>>>;
}

export function fetchOpenApi(client: KletiaClient, signal?: AbortSignal): Promise<OpenApiDocument> {
  return client.request<OpenApiDocument>("GET", "/openapi.json", undefined, {
    signal: sdkSignal(signal),
  });
}

/** Plans an intent without persisting it (`POST /v1/intents?dryRun=true`). */
export async function planIntentDryRun(
  client: KletiaClient,
  signal: AbortSignal | undefined,
  request: IntentRequest,
): Promise<IntentGraph> {
  const body = await client.request<{ intent: IntentGraph }>("POST", "/intents", request, {
    signal: sdkSignal(signal),
    query: { dryRun: "true" },
  });
  return body.intent;
}

export function requestQuote(
  client: KletiaClient,
  signal: AbortSignal | undefined,
  request: QuoteRequest,
): Promise<QuoteResponse> {
  return client.request<QuoteResponse>("POST", "/quotes", request, { signal: sdkSignal(signal) });
}

export async function createDeveloperKey(
  client: KletiaClient,
  signal: AbortSignal | undefined,
  name: string,
): Promise<ApiKeyRecord> {
  const body = await client.request<{ key: ApiKeyRecord }>("POST", "/keys", { name }, {
    signal: sdkSignal(signal),
  });
  return body.key;
}

/** A raw HTTP exchange, used by the API explorer to show exactly what the API returned. */
export interface RawExchange {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly requestId: string | null;
  readonly contentType: string | null;
  readonly latencyMs: number;
  /** Parsed JSON when the body is JSON, otherwise the raw text (truncated). */
  readonly body: unknown;
}

const RAW_BODY_LIMIT = 200_000;

/**
 * Sends one request to `/v1{path}` with plain fetch so the explorer can show
 * the real status line and request id. Network failures reject.
 */
export async function rawPlatformRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<RawExchange> {
  const url = `${PLATFORM_ORIGIN}/v1${path}`;
  const startedAt = performance.now();
  const timeout = AbortSignal.timeout(20_000);
  const combined =
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: combined,
  });
  const text = await response.text();
  let parsed: unknown = text.length > RAW_BODY_LIMIT ? `${text.slice(0, RAW_BODY_LIMIT)}…` : text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the raw text.
    }
  } else {
    parsed = null;
  }
  return {
    method,
    url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    latencyMs: Math.round(performance.now() - startedAt),
    body: parsed,
  };
}
