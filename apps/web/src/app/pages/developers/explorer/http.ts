/**
 * Raw HTTP for the API explorer: plain fetch, so the viewer shows exactly
 * what the API answered (status, readable headers, body), including streams.
 */

export interface ExplorerRequest {
  readonly method: string;
  /** Absolute URL. */
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  /** Serialised JSON body, when the operation has one. */
  readonly body?: string;
}

export interface StreamFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export interface ExplorerExchange {
  /** Monotonic id of this exchange (keys the entrance motion). */
  readonly seq: number;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Headers the browser may read (CORS-exposed plus safelisted). */
  readonly headers: readonly (readonly [string, string])[];
  readonly contentType: string | null;
  readonly sizeBytes: number;
  /** Parsed JSON, raw text, or null for an empty body. */
  readonly body: unknown;
  readonly bodyText: string;
  /** Server-Sent Event frames when the response was a stream. */
  readonly frames: readonly StreamFrame[] | null;
  /** True when the explorer stopped reading a stream (time or frame limit). */
  readonly truncated: boolean;
}

export class ExplorerNetworkError extends Error {
  readonly kind: "timeout" | "network" | "aborted";
  constructor(kind: "timeout" | "network" | "aborted", message: string) {
    super(message);
    this.name = "ExplorerNetworkError";
    this.kind = kind;
  }
}

const TEXT_LIMIT = 400_000;
const STREAM_MS = 8_000;
const STREAM_FRAMES = 40;
const TIMEOUT_MS = 30_000;

let sequence = 0;

/** Splits an SSE payload into frames (comments and retry fields are dropped). */
export function parseEventStream(text: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const block of text.replace(/\r\n?/gu, "\n").split("\n\n")) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
      else if (field === "event") event = value;
    }
    if (data.length > 0 || event) {
      frames.push({ ...(id ? { id } : {}), ...(event ? { event } : {}), data: data.join("\n") });
    }
  }
  return frames;
}

async function readStream(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  const deadline = Date.now() + STREAM_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) {
        truncated = true;
        break;
      }
      let timer = 0;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = window.setTimeout(() => resolve("timeout"), remaining);
      });
      const next = await Promise.race([reader.read(), timeout]);
      window.clearTimeout(timer);
      if (next === "timeout") {
        truncated = true;
        break;
      }
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.length > TEXT_LIMIT || parseEventStream(text).length >= STREAM_FRAMES) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return { text, truncated };
}

/** Sends one request. Rejects with ExplorerNetworkError when no HTTP response arrives. */
export async function sendExplorerRequest(request: ExplorerRequest, signal: AbortSignal): Promise<ExplorerExchange> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers.map(([name, value]) => [name, value] as [string, string]),
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: combined,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    if (signal.aborted) throw new ExplorerNetworkError("aborted", "The request was cancelled.");
    if (timeout.aborted) throw new ExplorerNetworkError("timeout", "The Kletia API did not respond within 30 s.");
    throw new ExplorerNetworkError(
      "network",
      "The API is unreachable from this browser: offline, DNS, CORS or a blocked request.",
    );
  }
  const contentType = response.headers.get("content-type");
  const streaming = contentType?.includes("text/event-stream") ?? false;
  let text = "";
  let truncated = false;
  try {
    if (streaming) {
      ({ text, truncated } = await readStream(response, combined));
    } else {
      text = await response.text();
    }
  } catch {
    // A stream cut short still shows what arrived.
    truncated = true;
  }
  const latencyMs = Math.round(performance.now() - startedAt);
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  headers.sort(([a], [b]) => a.localeCompare(b));
  const frames = streaming ? parseEventStream(text) : null;
  let body: unknown = null;
  if (text) {
    const clipped = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
    body = clipped;
    if (!streaming && contentType?.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = clipped;
      }
    }
  }
  sequence += 1;
  return {
    seq: sequence,
    method: request.method,
    url: request.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    latencyMs,
    headers,
    contentType,
    sizeBytes: new TextEncoder().encode(text).byteLength,
    body,
    bodyText: text,
    frames,
    truncated,
  };
}

export interface RateLimitState {
  readonly policy: string | null;
  readonly remaining: number | null;
  readonly resetSeconds: number | null;
  readonly limit: number | null;
  readonly windowSeconds: number | null;
}

function parameter(header: string, key: string): number | null {
  const match = new RegExp(`(?:^|;)\\s*${key}=(\\d+)`, "u").exec(header);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/**
 * Reads the IETF draft-8 `RateLimit` (`"public"; r=29; t=60`) and
 * `RateLimit-Policy` (`"public"; q=30; w=60`) headers.
 */
export function parseRateLimit(headers: readonly (readonly [string, string])[]): RateLimitState | null {
  const get = (name: string) => headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  const state = get("ratelimit");
  const policy = get("ratelimit-policy");
  if (!state && !policy) return null;
  const name = /^\s*"([^"]+)"/u.exec(state ?? policy ?? "")?.[1] ?? null;
  return {
    policy: name,
    remaining: state ? parameter(state, "r") : null,
    resetSeconds: state ? parameter(state, "t") : null,
    limit: policy ? parameter(policy, "q") : null,
    windowSeconds: policy ? parameter(policy, "w") : null,
  };
}

/** The API error envelope, when the body is one. */
export function errorEnvelope(body: unknown): { code: string; message: string; docs?: string; hints?: string[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, docs, hints } = error as Record<string, unknown>;
  if (typeof code !== "string") return null;
  return {
    code,
    message: typeof message === "string" ? message : "",
    ...(typeof docs === "string" ? { docs } : {}),
    ...(Array.isArray(hints) ? { hints: hints.filter((hint): hint is string => typeof hint === "string") } : {}),
  };
}

/** A fresh Idempotency-Key value (UUID v4). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
