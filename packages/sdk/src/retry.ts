/**
 * Retry policy for `KletiaClient.request`.
 *
 * - GET and DELETE are retried: repeating them changes nothing.
 * - POSTs that never change state (quotes, dry runs, refresh) are retried.
 * - POSTs that create or change state (intents, cancel, submit, webhooks,
 *   keys, rotate) are retried only with an `Idempotency-Key`, which the
 *   client generates when it holds an API key (the API scopes idempotency to
 *   the key; the public tier refuses the header). The API then replays the
 *   first response instead of running the request twice.
 * - Prepare is never retried and never carries an `Idempotency-Key`: every
 *   call builds fresh transactions from a new quote.
 * - Anything else (webhook tests, unknown routes) is not retried unless the
 *   caller asks for it with `maxRetries`.
 *
 * Backoff is exponential with jitter. `Retry-After` is honoured exactly; a
 * server asking for more than {@link MAX_RETRY_DELAY_MS} is not retried
 * early, the error is returned instead.
 */

export type RetryClass = "safe" | "idempotent" | "unsafe" | "prepare";

/** Longest wait between two attempts (also the largest `Retry-After` the client waits for). */
export const MAX_RETRY_DELAY_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

const SEGMENT = "[^/]+";
const route = (pattern: string) => new RegExp(`^${pattern}$`, "iu");
const PREPARE = route(`/intents/${SEGMENT}/steps/${SEGMENT}/prepare`);
const SAFE_POSTS = [route("/quotes"), route(`/intents/${SEGMENT}/refresh`)];
const IDEMPOTENT_POSTS = [
  route("/intents"),
  route(`/intents/${SEGMENT}/cancel`),
  route(`/intents/${SEGMENT}/steps/${SEGMENT}/submit`),
  route("/webhooks"),
  route("/keys"),
  route(`/keys/${SEGMENT}/rotate`),
];

function normalizePath(path: string): string {
  let pathname = path.split(/[?#]/u, 1)[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path; it then matches nothing and is treated as unsafe.
  }
  pathname = pathname.replace(/\/+$/u, "");
  return pathname.replace(/^\/v1(?=\/)/iu, "") || "/";
}

function isDryRun(path: string, query: Readonly<Record<string, string | undefined>>): boolean {
  const inline = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "").get("dryRun");
  const value = query.dryRun ?? inline ?? undefined;
  return value === "true" || value === "1";
}

/** How a request may be repeated, from its method and `/v1`-relative path. */
export function retryClass(
  method: string,
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
): RetryClass {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "DELETE") return "safe";
  if (verb !== "POST") return "unsafe";
  const pathname = normalizePath(path);
  if (PREPARE.test(pathname)) return "prepare";
  if (SAFE_POSTS.some((pattern) => pattern.test(pathname))) return "safe";
  if (IDEMPOTENT_POSTS.some((pattern) => pattern.test(pathname))) {
    // A dry run stores nothing (the API ignores Idempotency-Key for it).
    return pathname.toLowerCase() === "/intents" && isDryRun(path, query) ? "safe" : "idempotent";
  }
  return "unsafe";
}

/**
 * Delay before the next attempt, or null when the server asked for a wait
 * longer than {@link MAX_RETRY_DELAY_MS}. `attempt` is the 1-based number of
 * the attempt that just failed.
 */
export function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number | null {
  if (retryAfterSeconds !== null) {
    const requested = retryAfterSeconds * 1000;
    return requested > MAX_RETRY_DELAY_MS ? null : requested;
  }
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // "Equal jitter": half fixed, half random, so retries never bunch up at zero.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** A random UUID v4 for `Idempotency-Key`; null when the runtime has no Web Crypto. */
export function newIdempotencyKey(): string | null {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") return null;
  // randomUUID is limited to secure contexts in browsers; getRandomValues is not.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
