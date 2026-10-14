/**
 * GET /v1/events: the key's events as Server-Sent Events (integrator design
 * 4.6), for local development and servers that prefer a
 * stream to webhooks.
 *
 * - Routing is the webhook dispatcher's (`dispatchTargets`): a stream sees
 *   exactly the events the key's webhooks would receive. `scope=self` (the
 *   default) is the key's own events; `scope=subtree` adds its descendant
 *   agent keys' events and, on project keys, the project-wide rule book
 *   events (like webhooks created with `scope: "subtree"`).
 * - `types=a,b` keeps only those event types (webhook event type names).
 * - Frames are `id`, `event` and `data` = the webhook envelope
 *   `{ id, type, at, data }`. `retry: 3000` first, a comment heartbeat every
 *   15 s, at most 30 minutes per stream.
 * - `Last-Event-ID` (or `?since=`) replays the matching events of the
 *   process's recent buffer (500 events, 10 minutes) after that id; an id no
 *   longer buffered replays the whole buffer (de-duplicate by event id).
 *   Without it the stream starts with live events. The buffer is per
 *   process: events from another instance are not replayed.
 * - At most 2 open streams per key (and the per-client SSE slots of
 *   limits.ts). The key and its ancestors are re-checked on every heartbeat:
 *   a revoked or expired key's stream ends.
 */
import type { Request, Response } from "express";
import { authOf, HttpError, invalidRequest, queryParam, sendError } from "./context.js";
import { dispatchTargets, liveOwner, subscribeDispatchedEvents, type DispatchedEvent, type RouteTarget } from "./dispatcher.js";
import { acquireStreamSlot } from "./limits.js";
import { frame, resumeAfter, SSE_HEARTBEAT_MS, SSE_MAX_DURATION_MS, SSE_RETRY_MS, type StreamOptions } from "./sse.js";
import { WEBHOOK_EVENT_TYPES, WEBHOOK_SCOPES, type WebhookEventType, type WebhookScope } from "./webhooks.js";

export const EVENT_STREAMS_PER_KEY = 2;
export const EVENT_STREAM_BUFFER_EVENTS = 500;
export const EVENT_STREAM_BUFFER_MS = 10 * 60_000;
const MAX_BUFFERED_BYTES = 1_000_000;
/** An intent's owner is recorded right after `intent.created`: resolve again after these delays. */
const OWNER_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

/* ---------------------------------------------------------------- buffer */

interface Buffered {
  readonly event: DispatchedEvent;
  readonly at: number;
}

const buffer: Buffered[] = [];
let stopBuffer: (() => void) | null = null;

function prune(now: number): void {
  while (buffer.length > EVENT_STREAM_BUFFER_EVENTS || (buffer[0] && now - buffer[0].at > EVENT_STREAM_BUFFER_MS)) buffer.shift();
}

/** Keeps the recent routed events for `Last-Event-ID` replay (once per process; idempotent). */
export function startEventStreamBuffer(): () => void {
  if (stopBuffer) return stopBuffer;
  const unsubscribe = subscribeDispatchedEvents((event) => {
    const now = Date.now();
    buffer.push({ event, at: now });
    prune(now);
  });
  const stop = () => {
    if (stopBuffer !== stop) return;
    stopBuffer = null;
    unsubscribe();
  };
  stopBuffer = stop;
  return stop;
}

/** Empties the replay buffer (tests). */
export function resetEventStreamBuffer(): void {
  buffer.length = 0;
}

/* --------------------------------------------------------------- routing */

export interface EventStreamFilter {
  readonly keyId: string;
  readonly scope: WebhookScope;
  /** null: every type. */
  readonly types: ReadonlySet<string> | null;
}

function matches(targets: readonly RouteTarget[], filter: EventStreamFilter): boolean {
  return targets.some((target) => target.ownerKeyId === filter.keyId && (filter.scope === "subtree" || !target.subtreeOnly));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Whether `event` goes to the stream of `filter` (the dispatcher's routing; an unknown owner is retried briefly). */
export async function streamWants(event: DispatchedEvent, filter: EventStreamFilter): Promise<boolean> {
  if (filter.types && !filter.types.has(event.type)) return false;
  let targets = await dispatchTargets(event).catch(() => [] as RouteTarget[]);
  for (const delay of OWNER_RETRY_DELAYS_MS) {
    if (targets !== undefined) break;
    await sleep(delay);
    targets = await dispatchTargets(event).catch(() => [] as RouteTarget[]);
  }
  return targets !== undefined && matches(targets, filter);
}

/* ---------------------------------------------------------------- parsing */

/** `scope` (self | subtree) and `types` (comma-separated webhook event types) of GET /v1/events. */
export function parseEventStreamQuery(req: Request): { scope: WebhookScope; types: ReadonlySet<string> | null } {
  const rawScope = queryParam(req, "scope", 16);
  const scope = rawScope === undefined || rawScope === "" ? "self" : rawScope;
  if (!(WEBHOOK_SCOPES as readonly string[]).includes(scope)) {
    throw invalidRequest("scope must be self or subtree.", [{ path: "scope", message: "Expected self or subtree." }]);
  }
  const rawTypes = queryParam(req, "types", 2_000);
  if (rawTypes === undefined || rawTypes === "") return { scope: scope as WebhookScope, types: null };
  const types = rawTypes.split(",").map((type) => type.trim()).filter((type) => type !== "");
  const unknown = types.filter((type) => !WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType));
  if (types.length === 0 || unknown.length > 0) {
    throw invalidRequest(`types must be comma-separated event types: ${WEBHOOK_EVENT_TYPES.join(", ")}.`, [
      { path: "types", message: unknown.length > 0 ? `Unknown: ${unknown.slice(0, 5).map((type) => type.slice(0, 40)).join(", ")}.` : "Empty." },
    ]);
  }
  return { scope: scope as WebhookScope, types: new Set(types) };
}

/* ---------------------------------------------------------------- streams */

const openByKey = new Map<string, number>();

function acquireKeySlot(keyId: string): (() => void) | null {
  const open = openByKey.get(keyId) ?? 0;
  if (open >= EVENT_STREAMS_PER_KEY) return null;
  openByKey.set(keyId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (openByKey.get(keyId) ?? 1) - 1;
    if (remaining <= 0) openByKey.delete(keyId);
    else openByKey.set(keyId, remaining);
  };
}

/** GET /v1/events (mount after requireApiKey). */
export async function streamKeyEvents(req: Request, res: Response, options: StreamOptions = {}): Promise<void> {
  const keyId = authOf(req).keyId;
  if (!keyId) throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key.");
  const { scope, types } = parseEventStreamQuery(req);
  const after = resumeAfter(req);
  if (res.destroyed || res.writableEnded) return;
  if (req.method === "HEAD") {
    res.status(200).setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.end();
    return;
  }
  const releaseKey = acquireKeySlot(keyId);
  if (!releaseKey) {
    throw new HttpError(429, "TOO_MANY_STREAMS", `At most ${EVENT_STREAMS_PER_KEY} event streams per API key. Close one and retry.`, {
      headers: { "Retry-After": "30" },
    });
  }
  const releaseClient = acquireStreamSlot(req);
  if (!releaseClient) {
    releaseKey();
    throw new HttpError(429, "TOO_MANY_STREAMS", "Too many open event streams for this client. Close one and retry.", {
      headers: { "Retry-After": "30" },
    });
  }

  const filter: EventStreamFilter = { keyId, scope, types };
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;
  // Events are matched in arrival order: each waits for the previous one's routing.
  let queue: Promise<void> = Promise.resolve();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    releaseKey();
    releaseClient();
  };

  const write = (chunk: string) => {
    if (closed) return;
    res.write(chunk);
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      cleanup();
      res.destroy();
    }
  };

  const offer = (event: DispatchedEvent) => {
    queue = queue
      .then(async () => {
        if (!closed && (await streamWants(event, filter))) write(frame(event));
      })
      .catch(() => undefined);
  };

  try {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);

    res.on("close", cleanup);
    req.on("close", cleanup);
    if (res.destroyed) {
      cleanup();
      return;
    }

    write(`retry: ${SSE_RETRY_MS}\n\n`);
    // Replay and subscribe synchronously: no event can be published between the two.
    if (after !== undefined) {
      prune(Date.now());
      const index = buffer.findIndex((entry) => entry.event.id === after);
      for (const entry of buffer.slice(index + 1)) offer(entry.event);
    }
    unsubscribe = subscribeDispatchedEvents(offer);
    heartbeat = setInterval(() => {
      // The key (and its ancestors) must still be live; a store failure ends the stream too (fail closed).
      liveOwner(keyId)
        .then((live) => {
          if (live) {
            write(`: heartbeat ${new Date().toISOString()}\n\n`);
            return;
          }
          write(": the API key is no longer valid\n\n");
          cleanup();
          res.end();
        })
        .catch(() => {
          cleanup();
          res.end();
        });
    }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
    deadline = setTimeout(() => {
      write(": stream lifetime reached; reconnect with Last-Event-ID\n\n");
      cleanup();
      res.end();
    }, options.maxDurationMs ?? SSE_MAX_DURATION_MS);
    heartbeat.unref?.();
    deadline.unref?.();
  } catch (error) {
    cleanup();
    if (res.headersSent) res.destroy();
    else sendError(req, res, error);
  }
}

/** Open key event streams in this process (observability and tests). */
export function openKeyStreamCount(): number {
  let total = 0;
  for (const count of openByKey.values()) total += count;
  return total;
}
