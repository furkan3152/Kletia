/**
 * GET /v1/intents/{id}/events: Server-Sent Events for one intent.
 *
 * 1. `retry: 3000`.
 * 2. Replay from the engine's per-intent buffer after Last-Event-ID (or
 *    ?since=); without either, the whole buffer (so `intent.created` arrives first).
 * 3. Live envelopes for this intent as they are published.
 * Heartbeat comment every 15 s; the stream ends after 30 minutes (clients
 * reconnect with Last-Event-ID) or when the client disconnects. Slow
 * consumers holding more than 1 MB of unsent data are disconnected.
 */
import type { Request, Response } from "express";
import { getIntent, readIntentEvents, subscribeIntentEvents, type IntentEvent } from "../index.js";
import { EVENT_ID_PATTERN, HttpError, intentIdParam, invalidRequest, queryParam, sendError } from "./context.js";
import { acquireStreamSlot } from "./limits.js";

export const SSE_RETRY_MS = 3_000;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_MAX_DURATION_MS = 30 * 60_000;
const MAX_BUFFERED_BYTES = 1_000_000;

export interface StreamOptions {
  readonly heartbeatMs?: number;
  readonly maxDurationMs?: number;
}

function frame(event: IntentEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function resumeAfter(req: Request): string | undefined {
  const header = req.get("last-event-id")?.trim();
  const since = header || queryParam(req, "since", 64);
  if (!since) return undefined;
  if (!EVENT_ID_PATTERN.test(since)) {
    throw invalidRequest("Last-Event-ID / since must be an event id (evt_ followed by 32 hex characters).", [
      { path: header ? "Last-Event-ID" : "since", message: "Invalid event id." },
    ]);
  }
  return since;
}

export async function streamIntentEvents(req: Request, res: Response, options: StreamOptions = {}): Promise<void> {
  const intentId = intentIdParam(req);
  const after = resumeAfter(req);
  await getIntent(intentId);
  // The client may have gone away while the intent was read: a "close" that
  // already fired is never emitted again, so nothing may be allocated for it.
  if (res.destroyed || res.writableEnded) return;
  if (req.method === "HEAD") {
    res.status(200).setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.end();
    return;
  }
  const release = acquireStreamSlot(req);
  if (!release) {
    throw new HttpError(429, "TOO_MANY_STREAMS", "Too many open event streams for this client. Close one and retry.", {
      headers: { "Retry-After": "30" },
    });
  }

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    release();
  };

  const write = (chunk: string) => {
    if (closed) return;
    res.write(chunk);
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      cleanup();
      res.destroy();
    }
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
    for (const event of readIntentEvents(intentId, after)) write(frame(event));
    unsubscribe = subscribeIntentEvents((event) => {
      if (event.data.intentId === intentId) write(frame(event));
    });
    heartbeat = setInterval(() => write(`: heartbeat ${new Date().toISOString()}\n\n`), options.heartbeatMs ?? SSE_HEARTBEAT_MS);
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
