/**
 * Webhook dispatcher.
 *
 * Subscribes to the engine's intent event envelopes. For intents created with
 * an API key, each event is POSTed (body = the KletiaEvent JSON) to that key's
 * webhooks subscribed to the event type, signed with
 * `Kletia-Signature: t=<unix>,v1=<hmac>` (signWebhookPayload from @kletia/core).
 *
 * Delivery rules: 5 s timeout, redirects are never followed (3xx is a
 * failure), every socket lookup re-checks that the host is public, a failed
 * delivery is retried up to 3 times after 1 s, 5 s and 25 s. The queue is
 * bounded (1000); when full the oldest pending delivery is dropped and logged.
 */
import https from "node:https";
import { isIP } from "node:net";
import { signWebhookPayload } from "@kletia/core";
import { subscribeIntentEvents, type IntentEvent } from "../index.js";
import { guardedLookup, isPublicAddress } from "./netguard.js";
import { resolveIntentOwner } from "./owners.js";
import { sealingAvailable } from "./secrets.js";
import { webhookSecret, webhooksForOwner } from "./webhooks.js";

export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 5_000, 25_000]);
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_QUEUE = 1_000;
const CONCURRENCY = 8;
/** The owner of a just-created intent is recorded right after the engine emits `intent.created`. */
const OWNER_RETRY_DELAYS_MS: readonly number[] = [0, 250, 1_000];
const USER_AGENT = "Kletia-Webhooks/1.0 (+https://kletiaai.xyz)";

interface Delivery {
  readonly webhookId: string;
  readonly ownerKeyId: string;
  readonly url: string;
  readonly event: IntentEvent;
  readonly body: string;
  readonly attempt: number;
}

/** Posts one signed body; resolves with the HTTP status code. */
export type WebhookTransport = (url: URL, body: string, headers: Readonly<Record<string, string>>) => Promise<number>;

export const httpsTransport: WebhookTransport = (url, body, headers) =>
  new Promise<number>((resolve, reject) => {
    const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    if (url.protocol !== "https:" || (isIP(host) && !isPublicAddress(host))) {
      reject(new Error("Webhook target is not a public HTTPS endpoint."));
      return;
    }
    const request = https.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: guardedLookup,
        agent: false,
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // The response body is never read and redirects are never followed.
        response.destroy();
        resolve(status);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("Webhook delivery timed out.")), WEBHOOK_TIMEOUT_MS);
    request.on("timeout", () => request.destroy(new Error("Webhook delivery timed out.")));
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    request.end(body);
  });

export interface DispatcherStats {
  readonly running: boolean;
  readonly queued: number;
  readonly inFlight: number;
  readonly scheduledRetries: number;
  readonly delivered: number;
  readonly failed: number;
  readonly dropped: number;
}

export class WebhookDispatcher {
  private queue: Delivery[] = [];
  private active = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private delivered = 0;
  private failed = 0;
  private dropped = 0;
  private lastDropLog = 0;

  constructor(private readonly transport: WebhookTransport = httpsTransport) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeIntentEvents((event) => {
      // Deferred past the current microtasks so the HTTP layer has recorded the owner of a new intent.
      setImmediate(() => {
        this.route(event, 0).catch((error: unknown) => {
          console.warn("[platform] webhook routing failed:", error instanceof Error ? error.message : error);
        });
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue = [];
  }

  stats(): DispatcherStats {
    return {
      running: this.unsubscribe !== null,
      queued: this.queue.length,
      inFlight: this.active,
      scheduledRetries: this.timers.size,
      delivered: this.delivered,
      failed: this.failed,
      dropped: this.dropped,
    };
  }

  private later(delayMs: number, task: () => Promise<void> | void): void {
    if (this.timers.size >= WEBHOOK_MAX_QUEUE) {
      this.drop("too many pending retries");
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          console.warn("[platform] webhook task failed:", error instanceof Error ? error.message : error);
        });
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private drop(reason: string): void {
    this.dropped += 1;
    const now = Date.now();
    if (now - this.lastDropLog > 10_000) {
      this.lastDropLog = now;
      console.warn(`[platform] webhook delivery dropped (${reason}); ${this.dropped} dropped since start.`);
    }
  }

  private async route(event: IntentEvent, ownerAttempt: number): Promise<void> {
    if (!this.unsubscribe) return;
    const owner = await resolveIntentOwner(event.data.intentId);
    if (owner === undefined) {
      const delay = OWNER_RETRY_DELAYS_MS[ownerAttempt + 1];
      if (delay !== undefined) this.later(delay, () => this.route(event, ownerAttempt + 1));
      return;
    }
    if (owner === null) return;
    const hooks = (await webhooksForOwner(owner)).filter((hook) => hook.events.includes(event.type));
    if (hooks.length === 0) return;
    const body = JSON.stringify(event);
    for (const hook of hooks) {
      this.enqueue({ webhookId: hook.id, ownerKeyId: owner, url: hook.url, event, body, attempt: 1 });
    }
  }

  private enqueue(delivery: Delivery): void {
    this.queue.push(delivery);
    while (this.queue.length > WEBHOOK_MAX_QUEUE) {
      const oldest = this.queue.shift();
      if (oldest) this.drop(`queue full; oldest was ${oldest.event.type} ${oldest.event.id} for ${oldest.webhookId}`);
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.active += 1;
      void this.deliver(next).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async deliver(delivery: Delivery): Promise<void> {
    if (!this.unsubscribe || !sealingAvailable()) return;
    let status = 0;
    let reason = "";
    try {
      // The webhook may have been deleted since the event was queued.
      const hook = (await webhooksForOwner(delivery.ownerKeyId)).find((entry) => entry.id === delivery.webhookId);
      if (!hook) return;
      const signature = await signWebhookPayload(webhookSecret(hook), delivery.body);
      status = await this.transport(new URL(hook.url), delivery.body, {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "kletia-signature": signature,
        "kletia-event-id": delivery.event.id,
        "kletia-event-type": delivery.event.type,
        "kletia-webhook-id": delivery.webhookId,
        "kletia-delivery-attempt": String(delivery.attempt),
      });
      if (status >= 200 && status < 300) {
        this.delivered += 1;
        return;
      }
      reason = `HTTP ${status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message.slice(0, 120) : "delivery error";
    }
    const delay = WEBHOOK_RETRY_DELAYS_MS[delivery.attempt - 1];
    if (delay === undefined) {
      this.failed += 1;
      console.warn(`[platform] webhook ${delivery.webhookId} gave up on ${delivery.event.id} after ${delivery.attempt} attempts (${reason}).`);
      return;
    }
    this.later(delay, () => this.enqueue({ ...delivery, attempt: delivery.attempt + 1 }));
  }
}

let dispatcher: WebhookDispatcher | null = null;

/** Starts the process-wide dispatcher (idempotent). Returns a stop function. */
export function startWebhookDispatcher(transport?: WebhookTransport): () => void {
  if (!sealingAvailable()) {
    console.error("[platform] webhook dispatcher not started: KLETIA_PLATFORM_SECRET is not configured.");
    return () => undefined;
  }
  if (!dispatcher) {
    dispatcher = new WebhookDispatcher(transport);
    dispatcher.start();
  }
  const current = dispatcher;
  return () => {
    current.stop();
    if (dispatcher === current) dispatcher = null;
  };
}

export function webhookDispatcherStats(): DispatcherStats | null {
  return dispatcher?.stats() ?? null;
}
