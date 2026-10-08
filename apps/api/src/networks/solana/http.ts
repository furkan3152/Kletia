import { SOLANA_HTTP_TIMEOUT_MS } from "./config.js";

export class SolanaProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "SolanaProviderError";
  }
}

/** JSON fetch with a hard timeout and a bounded response size. */
export async function fetchProviderJson<T = unknown>(
  url: string,
  init: RequestInit & { provider: string; maxBytes?: number } ,
): Promise<T> {
  const { provider, maxBytes = 2_000_000, ...requestInit } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...requestInit,
      headers: { accept: "application/json", ...(requestInit.headers ?? {}) },
      signal: AbortSignal.timeout(SOLANA_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SolanaProviderError(
      `${provider} is unreachable: ${(error as Error).name === "TimeoutError" ? "timeout" : "network error"}.`,
      `${provider.toUpperCase().replace(/\W+/gu, "_")}_UNAVAILABLE`,
    );
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new SolanaProviderError(`${provider} response exceeded the size limit.`, "PROVIDER_RESPONSE_TOO_LARGE");
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new SolanaProviderError(`${provider} returned invalid JSON.`, "PROVIDER_INVALID_JSON");
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : `HTTP ${response.status}`;
    throw new SolanaProviderError(
      `${provider} rejected the request: ${message.slice(0, 200)}`,
      `${provider.toUpperCase().replace(/\W+/gu, "_")}_REJECTED`,
      response.status >= 500 ? 502 : 422,
    );
  }
  return body as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Short, JSON-safe description of an RPC error value. Solana transaction
 * errors can carry bigint fields (for example custom program error codes),
 * which plain JSON.stringify rejects.
 */
export function describeRpcError(value: unknown, maxLength = 200): string {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}
