/**
 * Upstream rate limits (HTTP 429 from a routing or data provider, e.g.
 * Jupiter's "Too many requests").
 *
 * A 429 from a provider is retried a bounded number of times with a short
 * backoff (honouring a small Retry-After), so one busy second does not fail
 * a plan. When the provider is still limiting after the last attempt the
 * caller reports `PROVIDER_RATE_LIMITED` (503, retryable) with a
 * Retry-After, never a non-retryable rejection.
 */

/** Code reported when a provider is still rate-limiting after the retries. */
export const PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED";

/** Retry-After sent to the client when the provider gave none (seconds). */
export const DEFAULT_PROVIDER_RETRY_AFTER_SECONDS = 2;
/** Largest Retry-After passed on to the client (seconds). */
export const MAX_PROVIDER_RETRY_AFTER_SECONDS = 60;

export interface ProviderRetrySettings {
  /** Wait before each retry (ms); its length is the number of retries. */
  readonly delaysMs: readonly number[];
  /** A Retry-After longer than this is not waited for in-request: the caller reports the limit instead. */
  readonly maxWaitMs: number;
  /** Sleeps `ms` (tests replace it). */
  readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULT_SETTINGS: ProviderRetrySettings = Object.freeze({
  delaysMs: Object.freeze([300, 900]),
  maxWaitMs: 1_500,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

let settings: ProviderRetrySettings = DEFAULT_SETTINGS;

/** Overrides the retry settings (tests); null restores the defaults. */
export function configureProviderRetry(next: Partial<ProviderRetrySettings> | null): void {
  settings = next ? { ...DEFAULT_SETTINGS, ...next } : DEFAULT_SETTINGS;
}

/**
 * Seconds a Retry-After header asks for (delta-seconds or an HTTP date),
 * or null when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/u.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The Retry-After (whole seconds, 1..60) to hand the client for a provider's 429 response. */
export function clientRetryAfterSeconds(response: Pick<Response, "headers"> | null): number {
  const asked = response ? parseRetryAfter(response.headers.get("retry-after")) : null;
  if (asked === null) return DEFAULT_PROVIDER_RETRY_AFTER_SECONDS;
  return Math.min(MAX_PROVIDER_RETRY_AFTER_SECONDS, Math.max(1, asked));
}

/**
 * Runs `attempt` (one HTTP request) and retries it while the provider answers
 * 429, at most `delaysMs.length` times. A Retry-After above `maxWaitMs` stops
 * the retries at once. Returns the last response (a 429 when every attempt
 * was limited); network errors propagate unchanged.
 */
export async function fetchWithRateLimitRetry(attempt: () => Promise<Response>): Promise<Response> {
  const { delaysMs, maxWaitMs, sleep } = settings;
  for (let retry = 0; ; retry += 1) {
    const response = await attempt();
    if (response.status !== 429 || retry >= delaysMs.length) return response;
    const asked = parseRetryAfter(response.headers.get("retry-after"));
    const waitMs = Math.max(delaysMs[retry] ?? 0, asked === null ? 0 : asked * 1000);
    if (waitMs > maxWaitMs) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(waitMs);
  }
}
