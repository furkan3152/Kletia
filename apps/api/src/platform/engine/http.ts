import { PlatformError } from "../errors.js";
import { isRecord } from "./util.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export interface ProviderRequest {
  readonly provider: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  /** Return null instead of throwing for this HTTP status (e.g. 404 lookups). */
  readonly allowStatus?: readonly number[];
}

function providerCode(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/\W+/gu, "_")}_${suffix}`;
}

/** Fetches JSON with a hard timeout and size limit; maps failures to PlatformError. */
export async function fetchProviderJson(url: string, request: ProviderRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(request.headers ?? {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new PlatformError(
      providerCode(request.provider, "UNAVAILABLE"),
      `${request.provider} is temporarily unreachable. Try again shortly.`,
      502,
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new PlatformError("PROVIDER_RESPONSE_TOO_LARGE", `${request.provider} returned an oversized response.`, 502);
  }
  if (request.allowStatus?.includes(response.status)) return null;
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new PlatformError("PROVIDER_INVALID_JSON", `${request.provider} returned an invalid response.`, 502);
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 429) {
      throw new PlatformError(
        providerCode(request.provider, "UNAVAILABLE"),
        `${request.provider} is temporarily unavailable. Try again shortly.`,
        502,
      );
    }
    const message = isRecord(body) && typeof body.message === "string"
      ? body.message
      : isRecord(body) && typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `${request.provider} could not route this request: ${message.replace(/[\r\n]+/gu, " ").slice(0, 200)}`,
      422,
    );
  }
  return body;
}
