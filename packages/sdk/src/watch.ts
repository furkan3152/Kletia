import type { AnyKletiaEvent, IntentGraph, IntentStatus, StepStatus } from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaApiError } from "./errors.js";
import { MAX_RETRY_DELAY_MS, sleep } from "./retry.js";

/** Intent statuses after which nothing else happens on their own. */
export const TERMINAL_INTENT_STATUSES: readonly IntentStatus[] = Object.freeze([
  "completed",
  "partially_completed",
  "failed",
  "expired",
  "cancelled",
]);

export function isIntentTerminal(intent: Pick<IntentGraph, "status">): boolean {
  return TERMINAL_INTENT_STATUSES.includes(intent.status);
}

/** Step states whose outcome is being observed on-chain (refresh advances them). */
const IN_FLIGHT: readonly StepStatus[] = ["submitted", "confirmed", "settling", "indeterminate"];

export type IntentWatchTransport = "stream" | "poll";

export interface WatchIntentOptions {
  /** Stops watching; the returned promise then rejects with `REQUEST_ABORTED`. */
  readonly signal?: AbortSignal;
  /** Every newer version of the intent, starting with the current one. */
  readonly onUpdate?: (intent: IntentGraph) => void;
  /** Every new event from the stream (de-duplicated by id across reconnects). */
  readonly onEvent?: (event: AnyKletiaEvent) => void;
  /** How the intent is being followed right now. */
  readonly onTransport?: (transport: IntentWatchTransport) => void;
  /** Resume the stream after this event id. */
  readonly lastEventId?: string;
  /** Poll interval while the stream is unavailable (default 4000 ms). */
  readonly pollIntervalMs?: number;
  /**
   * Refresh interval while the stream is open (default 30000 ms), so
   * settlement advances on API hosts without a background poller.
   */
  readonly streamRefreshMs?: number;
  /** False to poll only, without opening an event stream. */
  readonly stream?: boolean;
}

/** Cheap change detector: equal timestamps can still hide a step change. */
function fingerprint(intent: IntentGraph): string {
  return `${intent.updatedAt}|${intent.status}|${intent.steps.map((step) => `${step.status}:${step.evidence.length}`).join(",")}`;
}

/** Errors after which watching cannot succeed (the intent does not exist, the key is refused). */
function isFatal(error: unknown): boolean {
  if (!(error instanceof KletiaApiError)) return true;
  if (error.code === "REQUEST_ABORTED") return true;
  return !error.retryable && (error.status === 401 || error.status === 403 || error.status === 404);
}

/**
 * Follows an intent until it reaches a terminal status and resolves with it.
 *
 * Reads the intent, then follows its event stream (resuming with
 * Last-Event-ID after the API closes it or the connection drops) and
 * re-reads the intent after each event. While the stream is unavailable
 * (rate limited, unreachable, not supported) it polls instead: `refresh`
 * while a step is being settled, `get` otherwise. Rejects on a fatal API
 * error (unknown intent, refused key) and with `REQUEST_ABORTED` when
 * `signal` aborts.
 */
export function watchIntent(
  client: KletiaClient,
  intentId: string,
  options: WatchIntentOptions = {},
): Promise<IntentGraph> {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 4_000);
  const streamRefreshMs = Math.max(pollIntervalMs, options.streamRefreshMs ?? 30_000);
  const internal = new AbortController();
  const signal = internal.signal;
  let latest: IntentGraph | null = null;
  let lastEventId = options.lastEventId;
  const seen = new Set<string>();
  let streaming = false;
  let finished = false;
  let resolveWatch!: (intent: IntentGraph) => void;
  let rejectWatch!: (error: unknown) => void;
  const result = new Promise<IntentGraph>((resolve, reject) => {
    resolveWatch = resolve;
    rejectWatch = reject;
  });

  const finish = (outcome: { intent: IntentGraph } | { error: unknown }) => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener("abort", onAbort);
    internal.abort();
    if ("intent" in outcome) resolveWatch(outcome.intent);
    else rejectWatch(outcome.error);
  };
  const onAbort = () =>
    finish({
      error: new KletiaApiError({ code: "REQUEST_ABORTED", message: "Stopped watching the intent.", status: 0, cause: options.signal?.reason }),
    });

  const setTransport = (next: boolean) => {
    if (finished || streaming === next) return;
    streaming = next;
    options.onTransport?.(next ? "stream" : "poll");
  };

  const accept = (intent: IntentGraph) => {
    if (finished || intent.id !== intentId) return;
    if (latest && (intent.updatedAt < latest.updatedAt || fingerprint(intent) === fingerprint(latest))) return;
    latest = intent;
    options.onUpdate?.(intent);
    if (isIntentTerminal(intent)) finish({ intent });
  };

  // Reads are coalesced: an event during a read schedules one more read.
  let reading: Promise<void> | null = null;
  let dirty = false;
  const read = (refresh: boolean): Promise<void> => {
    if (reading) {
      dirty = true;
      return reading;
    }
    reading = (async () => {
      do {
        dirty = false;
        const intent = refresh
          ? await client.intents.refresh(intentId, { signal })
          : await client.intents.get(intentId, { signal });
        accept(intent);
      } while (dirty && !finished);
    })().finally(() => {
      reading = null;
    });
    return reading;
  };
  const readSafely = async (refresh: boolean) => {
    try {
      await read(refresh);
    } catch (error) {
      if (finished) return;
      if (isFatal(error)) finish({ error });
      // Transient: the next poll or event reads again.
    }
  };

  const onEvent = (event: AnyKletiaEvent) => {
    if (finished || typeof event?.id !== "string" || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 1_000) seen.delete(seen.values().next().value as string);
    lastEventId = event.id;
    options.onEvent?.(event);
    void readSafely(false);
  };

  const pollLoop = async () => {
    while (!finished) {
      try {
        await sleep(streaming ? streamRefreshMs : pollIntervalMs, signal);
      } catch {
        return;
      }
      const inFlight = latest?.steps.some((step) => IN_FLIGHT.includes(step.status)) ?? false;
      await readSafely(inFlight || streaming);
    }
  };

  const streamLoop = async () => {
    let failures = 0;
    while (!finished) {
      try {
        await client.intents.stream(intentId, onEvent, {
          signal,
          ...(lastEventId ? { lastEventId } : {}),
          onOpen: () => {
            failures = 0;
            setTransport(true);
          },
        });
        // The API closes streams after 30 minutes: reconnect with Last-Event-ID.
        setTransport(false);
        if (finished) return;
        continue;
      } catch (error) {
        setTransport(false);
        if (finished) return;
        if (error instanceof KletiaApiError && error.code === "INTENT_NOT_FOUND") {
          finish({ error });
          return;
        }
        // Not a transient failure (e.g. the deployment refuses streams): poll only.
        if (!(error instanceof KletiaApiError) || !error.retryable) return;
        failures += 1;
        const wait =
          error.retryAfterSeconds !== null
            ? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
            : Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** failures);
        try {
          await sleep(wait, signal);
        } catch {
          return;
        }
      }
    }
  };

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  if (!finished) {
    options.onTransport?.("poll");
    void (async () => {
      try {
        await read(false);
      } catch (error) {
        // The first read decides whether the intent can be watched at all.
        finish({ error });
        return;
      }
      if (finished) return;
      void pollLoop();
      if (options.stream !== false) void streamLoop();
    })();
  }
  return result;
}
