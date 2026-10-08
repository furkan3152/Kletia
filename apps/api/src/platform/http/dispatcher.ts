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
 * delivery is retried up to 3 times after 1 s, 5 s and 25 s.
 *
 * Isolation between API keys (one key's slow or failing endpoints must not
 * delay or drop another key's deliveries):
 * - each owner key has its own FIFO queue and owners are served round-robin;
 * - an owner holds at most 200 queued deliveries (beyond that its own oldest
 *   is dropped), 2 deliveries in flight and 200 pending retries, and a
 *   webhook has at most one delivery in flight;
 * - the process-wide bound of 1000 queued deliveries is only a backstop and
 *   drops from the owner with the longest queue;
 * - a webhook whose last 5 attempts failed is paused for 30 s, doubling up to
 *   5 min while the probe after each pause fails; its deliveries wait in the
 *   owner's queue meanwhile.
 * Every drop is counted and logged.
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
/** Process-wide bound on queued deliveries (and on pending retry timers). */
export const WEBHOOK_MAX_QUEUE = 1_000;
export const WEBHOOK_MAX_QUEUED_PER_OWNER = 200;
export const WEBHOOK_MAX_IN_FLIGHT_PER_OWNER = 2;
export const WEBHOOK_MAX_RETRIES_PER_OWNER = 200;
/** Consecutive failed attempts after which a webhook is paused. */
export const WEBHOOK_PAUSE_AFTER_FAILURES = 5;
export const WEBHOOK_PAUSE_MS = 30_000;
export const WEBHOOK_MAX_PAUSE_MS = 5 * 60_000;
const CONCURRENCY = 8;
const MAX_TRACKED_WEBHOOKS = 10_000;
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

/** Consecutive failures of one webhook and the pause they caused. */
interface Breaker {
  failures: number;
  trips: number;
  pausedUntil: number;
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
  /** Webhooks currently paused after consecutive failures. */
  readonly pausedWebhooks: number;
}

export class WebhookDispatcher {
  /** Queued deliveries per owner key, oldest first; map order is the round-robin order. */
  private readonly queues = new Map<string, Delivery[]>();
  private queued = 0;
  private active = 0;
  private readonly activeByOwner = new Map<string, number>();
  private readonly busyWebhooks = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Delivery retries waiting for their timer, per owner, oldest first. */
  private readonly retries = new Map<string, Map<NodeJS.Timeout, Delivery>>();
  private readonly breakers = new Map<string, Breaker>();
  /** Timers that resume the queue when a paused webhook may be probed again. */
  private readonly wakeups = new Set<NodeJS.Timeout>();
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
    for (const timer of [...this.timers, ...this.wakeups]) clearTimeout(timer);
    this.timers.clear();
    this.wakeups.clear();
    this.retries.clear();
    this.queues.clear();
    this.queued = 0;
    this.breakers.clear();
  }

  stats(): DispatcherStats {
    const now = Date.now();
    let pausedWebhooks = 0;
    for (const breaker of this.breakers.values()) if (breaker.pausedUntil > now) pausedWebhooks += 1;
    return {
      running: this.unsubscribe !== null,
      queued: this.queued,
      inFlight: this.active,
      scheduledRetries: this.timers.size,
      delivered: this.delivered,
      failed: this.failed,
      dropped: this.dropped,
      pausedWebhooks,
    };
  }

  /** Runs `task` after `delayMs`; returns null (and counts a drop) when no timer can be scheduled. */
  private later(delayMs: number, task: () => Promise<void> | void): NodeJS.Timeout | null {
    if (this.timers.size >= WEBHOOK_MAX_QUEUE && !this.evictRetry()) {
      this.drop("too many pending retries");
      return null;
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
    return timer;
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
    const owner = delivery.ownerKeyId;
    let queue = this.queues.get(owner);
    if (!queue) {
      queue = [];
      this.queues.set(owner, queue);
    }
    queue.push(delivery);
    this.queued += 1;
    if (queue.length > WEBHOOK_MAX_QUEUED_PER_OWNER) this.evictOldest(owner, "queue full for this key");
    while (this.queued > WEBHOOK_MAX_QUEUE) {
      const longest = this.longestQueue();
      if (longest === null) break;
      this.evictOldest(longest, "queue full");
    }
    this.pump();
  }

  private evictOldest(owner: string, reason: string): void {
    const queue = this.queues.get(owner);
    const oldest = queue?.shift();
    if (!queue || !oldest) return;
    this.queued -= 1;
    if (queue.length === 0) this.queues.delete(owner);
    this.drop(`${reason}; oldest was ${oldest.event.type} ${oldest.event.id} for ${oldest.webhookId}`);
  }

  private longestQueue(): string | null {
    let longest: string | null = null;
    let length = 0;
    for (const [owner, queue] of this.queues) {
      if (queue.length > length) {
        longest = owner;
        length = queue.length;
      }
    }
    return longest;
  }

  private pump(): void {
    while (this.active < CONCURRENCY) {
      const next = this.takeNext();
      if (!next) return;
      this.startDelivery(next);
    }
  }

  /** Next delivery to start: owners in round-robin order, skipping busy owners and busy or paused webhooks. */
  private takeNext(): Delivery | null {
    const now = Date.now();
    for (const [owner, queue] of this.queues) {
      if ((this.activeByOwner.get(owner) ?? 0) >= WEBHOOK_MAX_IN_FLIGHT_PER_OWNER) continue;
      const index = queue.findIndex(
        (delivery) => !this.busyWebhooks.has(delivery.webhookId) && !((this.breakers.get(delivery.webhookId)?.pausedUntil ?? 0) > now),
      );
      if (index === -1) continue;
      const [next] = queue.splice(index, 1);
      this.queued -= 1;
      // The served owner moves to the back of the round-robin order.
      this.queues.delete(owner);
      if (queue.length > 0) this.queues.set(owner, queue);
      return next ?? null;
    }
    return null;
  }

  private startDelivery(delivery: Delivery): void {
    const owner = delivery.ownerKeyId;
    this.active += 1;
    this.activeByOwner.set(owner, (this.activeByOwner.get(owner) ?? 0) + 1);
    this.busyWebhooks.add(delivery.webhookId);
    void this.deliver(delivery).finally(() => {
      this.active -= 1;
      const remaining = (this.activeByOwner.get(owner) ?? 1) - 1;
      if (remaining <= 0) this.activeByOwner.delete(owner);
      else this.activeByOwner.set(owner, remaining);
      this.busyWebhooks.delete(delivery.webhookId);
      this.pump();
    });
  }

  private async deliver(delivery: Delivery): Promise<void> {
    if (!this.unsubscribe || !sealingAvailable()) return;
    let status = 0;
    let reason = "";
    let attempted = false;
    try {
      // The webhook may have been deleted since the event was queued.
      const hook = (await webhooksForOwner(delivery.ownerKeyId)).find((entry) => entry.id === delivery.webhookId);
      if (!hook) return;
      const signature = await signWebhookPayload(webhookSecret(hook), delivery.body);
      attempted = true;
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
        this.breakers.delete(delivery.webhookId);
        return;
      }
      reason = `HTTP ${status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message.slice(0, 120) : "delivery error";
    }
    // Only the endpoint's own failures count towards pausing it (not storage or signing errors).
    if (attempted) this.recordFailure(delivery.webhookId);
    const delay = WEBHOOK_RETRY_DELAYS_MS[delivery.attempt - 1];
    if (delay === undefined) {
      this.failed += 1;
      console.warn(`[platform] webhook ${delivery.webhookId} gave up on ${delivery.event.id} after ${delivery.attempt} attempts (${reason}).`);
      return;
    }
    this.retry(delivery, delay);
  }

  private recordFailure(webhookId: string): void {
    const breaker = this.breakers.get(webhookId) ?? { failures: 0, trips: 0, pausedUntil: 0 };
    breaker.failures += 1;
    if (breaker.failures >= WEBHOOK_PAUSE_AFTER_FAILURES) {
      const pauseMs = Math.min(WEBHOOK_PAUSE_MS * 2 ** breaker.trips, WEBHOOK_MAX_PAUSE_MS);
      breaker.trips += 1;
      // Half-open after the pause: the next failure pauses the webhook again, for longer.
      breaker.failures = WEBHOOK_PAUSE_AFTER_FAILURES - 1;
      breaker.pausedUntil = Date.now() + pauseMs;
      const wakeup = setTimeout(() => {
        this.wakeups.delete(wakeup);
        this.pump();
      }, pauseMs);
      wakeup.unref?.();
      this.wakeups.add(wakeup);
      console.warn(`[platform] webhook ${webhookId} paused for ${pauseMs / 1000}s after repeated delivery failures.`);
    }
    this.breakers.delete(webhookId);
    this.breakers.set(webhookId, breaker);
    while (this.breakers.size > MAX_TRACKED_WEBHOOKS) {
      const oldest = this.breakers.keys().next().value;
      if (oldest === undefined) break;
      this.breakers.delete(oldest);
    }
  }

  private retry(delivery: Delivery, delayMs: number): void {
    const owner = delivery.ownerKeyId;
    if ((this.retries.get(owner)?.size ?? 0) >= WEBHOOK_MAX_RETRIES_PER_OWNER) {
      this.drop(`too many pending retries for this key; ${delivery.event.type} ${delivery.event.id} for ${delivery.webhookId}`);
      return;
    }
    const timer = this.later(delayMs, () => {
      if (timer) this.forgetRetry(owner, timer);
      this.enqueue({ ...delivery, attempt: delivery.attempt + 1 });
    });
    if (!timer) return;
    let pending = this.retries.get(owner);
    if (!pending) {
      pending = new Map();
      this.retries.set(owner, pending);
    }
    pending.set(timer, delivery);
  }

  private forgetRetry(owner: string, timer: NodeJS.Timeout): void {
    const pending = this.retries.get(owner);
    if (!pending) return;
    pending.delete(timer);
    if (pending.size === 0) this.retries.delete(owner);
  }

  /** Backstop when the process-wide timer bound is hit: cancels the oldest retry of the owner with the most. */
  private evictRetry(): boolean {
    let owner: string | null = null;
    let most = 0;
    for (const [candidate, pending] of this.retries) {
      if (pending.size > most) {
        owner = candidate;
        most = pending.size;
      }
    }
    const oldest = owner === null ? undefined : this.retries.get(owner)?.entries().next().value;
    if (owner === null || !oldest) return false;
    const [timer, delivery] = oldest;
    clearTimeout(timer);
    this.timers.delete(timer);
    this.forgetRetry(owner, timer);
    this.drop(`too many pending retries; cancelled ${delivery.event.type} ${delivery.event.id} for ${delivery.webhookId}`);
    return true;
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
