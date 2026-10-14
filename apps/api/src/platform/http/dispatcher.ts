/**
 * Webhook dispatcher.
 *
 * Subscribes to the engine's intent event envelopes, its receipt events
 * (`intent.receipt_issued`, routed like intent events), the contract
 * registration events (contracts.ts), the intent link events (links/), and
 * the Rule Book and key events (`policy.*`, `key.*`). For intents created
 * with an API key, each event is POSTed (body = the KletiaEvent JSON) to that
 * key's webhooks subscribed to the event type; contract and link events go to
 * the webhooks of the owning key (`data.ownerKeyId`) and never to another
 * key's. Rule Book and key events go to the subject key's webhooks.
 *
 * Subtree routing (policy design §11.4): webhooks created with
 * `scope: "subtree"` also receive these events for every descendant agent
 * key of their owner (each ancestor in the subject's lineage), and on
 * project keys the project-wide rule book events (no subject key).
 * Deliveries are signed with `Kletia-Signature: t=<unix>,v1=<hmac>`
 * (signWebhookPayload from @kletia/core).
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
 * Events of intents whose key was revoked are not routed (revoking also
 * deletes the key's webhooks; this covers a cleanup that failed). Every
 * attempt, retries included, re-reads the webhook and the live state of its
 * owner key and every ancestor: a deleted webhook, or a revoked or expired
 * owner or ancestor, gets no further attempt (the delivery is dropped).
 * When that state, the webhook or the intent's owner cannot be read (storage
 * failing), the delivery is deferred without spending an endpoint attempt:
 * 1 s doubling to 60 s, dropped as `deferred_too_long` after 120 deferrals.
 *
 * With Postgres, routing seals the body into a durable, bounded delivery
 * queue (webhookQueue.ts) before the first attempt. Workers claim fenced
 * leases, persist retries and attempt logs atomically, and recover
 * interrupted deliveries after a restart; a worker polls every 500 ms while
 * there is work and backs off to 5 s when idle (never past the next due
 * row). Receivers deduplicate by event id (at-least-once while retries
 * remain). The source mutation and routing are not one database transaction.
 *
 * Every drop is counted and logged. Every attempt and drop is also written to
 * the per-webhook delivery log (deliveries.ts) through a fire-and-forget
 * recorder, so the log never delays delivery.
 *
 * The routing itself (`dispatchTargets`, `subscribeDispatchedEvents`) is
 * shared with the authenticated event stream (GET /v1/events,
 * eventStream.ts), so a stream sees exactly the events the key's webhooks
 * would receive.
 */
import https from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { signWebhookPayload } from "@kletia/core";
import { subscribeIntentEvents, subscribePolicyEvents, subscribeReceiptEvents, type IntentEvent, type PolicyEvent, type ReceiptEvent } from "../index.js";
import { apiKeyStore, isKeyRevoked, keyKindOf, keyLive, loadOperatorKeys } from "./auth.js";
import { subscribeContractEvents, type ContractEvent } from "./contracts.js";
import { subscribeLinkEvents, type LinkEvent } from "./links/events.js";
import { subscribeKeyEvents, type KeyEvent } from "./policies/announce.js";
import { rawProjectId } from "./policies/store.js";
import { platformDatabaseUrl } from "./db.js";
import { classifyDeliveryError, classifyStatus, newDeliveryId, recordDelivery, type DeliveryRecord, type DeliveryError } from "./deliveries.js";
import { guardedLookup, isPublicAddress } from "./netguard.js";
import { resolveIntentOwner } from "./owners.js";
import { sealingAvailable } from "./secrets.js";
import { webhookSecret, webhooksForOwner } from "./webhooks.js";
import {
  PostgresWebhookQueue,
  WEBHOOK_MAX_DEFERRALS,
  WEBHOOK_QUEUE_IDLE_POLL_MS,
  WEBHOOK_QUEUE_POLL_MS,
  webhookDeferralDelayMs,
  type QueuedWebhook,
  type WebhookQueueSnapshot,
} from "./webhookQueue.js";

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
export const WEBHOOK_USER_AGENT = "Kletia-Webhooks/1.0 (+https://kletiaai.xyz)";

/**
 * An intent or receipt event (routed by the intent's key), a contract or link
 * event (routed by `data.ownerKeyId`), or a Rule Book / key event (routed by
 * the subject key, `data.keyId`).
 */
export type DispatchedEvent = IntentEvent | ReceiptEvent | ContractEvent | LinkEvent | PolicyEvent | KeyEvent;

function isContractEvent(event: DispatchedEvent): event is ContractEvent {
  return event.type.startsWith("contract.");
}

function isLinkEvent(event: DispatchedEvent): event is LinkEvent {
  return event.type.startsWith("link.");
}

function isPolicyOrKeyEvent(event: DispatchedEvent): event is PolicyEvent | KeyEvent {
  return event.type.startsWith("policy.") || event.type.startsWith("key.");
}

/** The intent an event is about, if any (delivery log). */
function eventIntentId(event: DispatchedEvent): string | undefined {
  const data = event.data as { readonly intentId?: unknown };
  return typeof data.intentId === "string" ? data.intentId : undefined;
}

/** One webhook owner to deliver to, and whether only its `subtree` webhooks qualify. */
export interface RouteTarget {
  readonly ownerKeyId: string;
  readonly subtreeOnly: boolean;
}

const LINEAGE_CACHE_MS = 60_000;
const lineageCache = new Map<string, { readonly lineage: readonly string[]; readonly expiresAt: number }>();

/** Ancestors of a key (lineage never changes; cached briefly, bounded). */
async function lineageOf(keyId: string): Promise<readonly string[]> {
  const now = Date.now();
  const cached = lineageCache.get(keyId);
  if (cached && cached.expiresAt > now) return cached.lineage;
  const record = await apiKeyStore().findById(keyId).catch(() => null);
  const lineage = record ? [...(record.lineage ?? [])] : [];
  lineageCache.set(keyId, { lineage, expiresAt: now + LINEAGE_CACHE_MS });
  while (lineageCache.size > 10_000) {
    const oldest = lineageCache.keys().next().value;
    if (oldest === undefined) break;
    lineageCache.delete(oldest);
  }
  return lineage;
}

/** The subject key and its ancestors (ancestors only through `subtree` webhooks). */
async function withAncestors(keyId: string): Promise<RouteTarget[]> {
  return [{ ownerKeyId: keyId, subtreeOnly: false }, ...(await lineageOf(keyId)).map((ancestor) => ({ ownerKeyId: ancestor, subtreeOnly: true }))];
}

/**
 * Whether a webhook owner may still receive deliveries, read fresh before
 * every attempt (no cache: revocation and expiry apply to queued retries at
 * once): an operator key still configured, or a key and every ancestor that
 * exist in one project, unrevoked and unexpired. A store failure throws.
 */
export async function liveOwner(keyId: string): Promise<boolean> {
  if (keyId.startsWith("op_")) return [...loadOperatorKeys().values()].some((key) => key.id === keyId);
  const keys = apiKeyStore();
  const key = await keys.findById(keyId);
  const now = Date.now();
  if (!key || !keyLive(key, now)) return false;
  const lineage = key.lineage ?? [];
  if (lineage.length === 0) return true;
  const ancestors = new Map((await keys.findMany(lineage)).map((ancestor) => [ancestor.id, ancestor]));
  return lineage.every((id) => {
    const ancestor = ancestors.get(id);
    return ancestor !== undefined && ancestor.projectId === key.projectId && keyLive(ancestor, now);
  });
}

/**
 * Owners whose webhooks (and event streams, eventStream.ts) may receive
 * `event`, with whether only their `subtree` subscriptions qualify:
 * contract events go to the owning key; link events to the owning key and
 * its ancestors; Rule Book and key events to the subject key, its ancestors
 * and the project's project keys; intent and receipt events to the intent's
 * key and its ancestors. Undefined while an intent's owner is not known yet
 * (the HTTP layer records it right after `intent.created`); [] for intents
 * created without a key.
 */
export async function dispatchTargets(event: DispatchedEvent): Promise<RouteTarget[] | undefined> {
  if (isContractEvent(event)) return [{ ownerKeyId: event.data.ownerKeyId, subtreeOnly: false }];
  if (isLinkEvent(event)) return withAncestors(event.data.ownerKeyId);
  if (isPolicyOrKeyEvent(event)) {
    const subject = event.data.keyId;
    const projectId = rawProjectId(event.data.projectId);
    const targets = subject ? await withAncestors(subject) : [];
    // Project keys that opted into their subtree see every rule book event of the project.
    const projectKeys = (await apiKeyStore().listByProject(projectId).catch(() => []))
      .filter((record) => keyKindOf(record) === "project" && !record.revokedAt)
      .map((record) => ({ ownerKeyId: record.id, subtreeOnly: true }));
    const seen = new Set<string>();
    return [...targets, ...projectKeys].filter((target) => {
      if (seen.has(target.ownerKeyId)) return false;
      seen.add(target.ownerKeyId);
      return true;
    });
  }
  const owner = await resolveIntentOwner(event.data.intentId);
  if (owner === undefined) return undefined;
  if (owner === null) return [];
  return withAncestors(owner);
}

/**
 * Subscribes to every event the dispatcher routes (intent, receipt,
 * contract, link, Rule Book and key events). Returns an unsubscribe function.
 */
export function subscribeDispatchedEvents(listener: (event: DispatchedEvent) => void): () => void {
  const unsubscribers = [
    subscribeIntentEvents(listener),
    subscribeContractEvents(listener),
    subscribeReceiptEvents(listener),
    subscribeLinkEvents(listener),
    subscribePolicyEvents(listener),
    subscribeKeyEvents(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

interface Delivery {
  readonly webhookId: string;
  readonly ownerKeyId: string;
  readonly url: string;
  readonly event: DispatchedEvent;
  readonly body: string;
  readonly attempt: number;
  /** Times this delivery could not be attempted (storage failing); bounded by WEBHOOK_MAX_DEFERRALS. */
  readonly deferrals?: number;
}

/** Consecutive failures of one webhook and the pause they caused. */
interface Breaker {
  failures: number;
  trips: number;
  pausedUntil: number;
}

/** Posts one signed body; resolves with the HTTP status code. */
export type WebhookTransport = (url: URL, body: string, headers: Readonly<Record<string, string>>) => Promise<number>;

/** Receives every attempt and drop for the delivery log; must not throw or block. */
export type DeliveryRecorder = (record: DeliveryRecord) => void;

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
  /**
   * Where deliveries wait. With `postgres`, `queued` and `scheduledRetries`
   * are the last snapshot of the shared queue; the other counters describe
   * this worker.
   */
  readonly storage: "memory" | "postgres";
}

export interface DispatcherOptions {
  /** Durable queue poll interval while there is work (default 500 ms). */
  readonly pollMs?: number;
  /** Base of the deferral back-off (default 1 s, doubling to 60 times this); tests shorten it. */
  readonly deferralBaseMs?: number;
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
  private unsubscribeContracts: (() => void) | null = null;
  private unsubscribeReceipts: (() => void) | null = null;
  private unsubscribeFeatures: (() => void)[] = [];
  private delivered = 0;
  private failed = 0;
  private dropped = 0;
  private lastDropLog = 0;
  /** The shared Postgres queue (null: in-memory queues). */
  private readonly durable: PostgresWebhookQueue | null;
  private durableTimer: NodeJS.Timeout | null = null;
  private polling = false;
  /** A poll was asked for while one was running: poll again right after it. */
  private pollAgain = false;
  private idlePollMs: number;
  private durableWaiting: WebhookQueueSnapshot = { queued: 0, retries: 0, nextDueMs: null };
  private readonly pollMs: number;
  private readonly deferralBaseMs: number;

  constructor(
    readonly transport: WebhookTransport = httpsTransport,
    private readonly recorder: DeliveryRecorder = recordDelivery,
    options: DispatcherOptions = {},
  ) {
    this.pollMs = Math.max(25, options.pollMs ?? WEBHOOK_QUEUE_POLL_MS);
    this.idlePollMs = this.pollMs;
    this.deferralBaseMs = Math.max(0, options.deferralBaseMs ?? 1_000);
    this.durable = platformDatabaseUrl()
      ? new PostgresWebhookQueue({
          queued: WEBHOOK_MAX_QUEUE,
          perOwner: WEBHOOK_MAX_QUEUED_PER_OWNER,
          concurrency: CONCURRENCY,
          perOwnerConcurrency: WEBHOOK_MAX_IN_FLIGHT_PER_OWNER,
        })
      : null;
  }

  start(): void {
    if (this.unsubscribe) return;
    const onEvent = (event: DispatchedEvent) => {
      // Deferred past the current microtasks so the HTTP layer has recorded the owner of a new intent.
      setImmediate(() => {
        this.route(event, 0).catch((error: unknown) => {
          console.warn("[platform] webhook routing failed:", error instanceof Error ? error.message : error);
        });
      });
    };
    this.unsubscribe = subscribeIntentEvents(onEvent);
    this.unsubscribeContracts = subscribeContractEvents(onEvent);
    this.unsubscribeReceipts = subscribeReceiptEvents(onEvent);
    this.unsubscribeFeatures = [subscribeLinkEvents(onEvent), subscribePolicyEvents(onEvent), subscribeKeyEvents(onEvent)];
    // Recovers work queued before a restart (or by another replica) right away.
    if (this.durable) void this.pollDurable();
  }

  stop(): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeContracts?.();
    this.unsubscribeContracts = null;
    this.unsubscribeReceipts?.();
    this.unsubscribeReceipts = null;
    for (const unsubscribe of this.unsubscribeFeatures) unsubscribe();
    this.unsubscribeFeatures = [];
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
      queued: this.durable ? this.durableWaiting.queued : this.queued,
      inFlight: this.active,
      scheduledRetries: this.durable ? this.durableWaiting.retries : this.timers.size,
      delivered: this.delivered,
      failed: this.failed,
      dropped: this.dropped,
      pausedWebhooks,
      storage: this.durable ? "postgres" : "memory",
    };
  }

  /** Runs `task` after `delayMs`; returns null (and counts a drop) when no timer can be scheduled. */
  private later(delayMs: number, task: () => Promise<void> | void, delivery?: Delivery): NodeJS.Timeout | null {
    if (this.timers.size >= WEBHOOK_MAX_QUEUE && !this.evictRetry()) {
      this.drop("too many pending retries", delivery);
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

  /** Hands one outcome to the delivery log; recording failures never affect delivery. */
  private record(delivery: Delivery, outcome: { status: DeliveryRecord["status"]; httpStatus?: number; durationMs?: number; error?: DeliveryError; nextRetryAt?: string }): void {
    try {
      this.recorder({
        id: newDeliveryId(),
        webhookId: delivery.webhookId,
        ownerKeyId: delivery.ownerKeyId,
        eventId: delivery.event.id,
        eventType: delivery.event.type,
        ...(eventIntentId(delivery.event) ? { intentId: eventIntentId(delivery.event) } : {}),
        attempt: delivery.attempt,
        status: outcome.status,
        ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.nextRetryAt ? { nextRetryAt: outcome.nextRetryAt } : {}),
        at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("[platform] webhook delivery log failed:", error instanceof Error ? error.message : error);
    }
  }

  private drop(reason: string, delivery?: Delivery): void {
    if (delivery) this.record(delivery, { status: "dropped", error: "queue_full" });
    this.dropped += 1;
    const now = Date.now();
    if (now - this.lastDropLog > 10_000) {
      this.lastDropLog = now;
      console.warn(`[platform] webhook delivery dropped (${reason}); ${this.dropped} dropped since start.`);
    }
  }

  /** Owners whose webhooks may receive `event`; undefined while an intent's owner is not known yet. */
  private targets(event: DispatchedEvent): Promise<RouteTarget[] | undefined> {
    return dispatchTargets(event);
  }

  private async route(event: DispatchedEvent, ownerAttempt: number): Promise<void> {
    if (!this.unsubscribe) return;
    const targets = await this.targets(event);
    if (targets === undefined) {
      const delay = OWNER_RETRY_DELAYS_MS[ownerAttempt + 1];
      if (delay !== undefined) this.later(delay, () => this.route(event, ownerAttempt + 1));
      return;
    }
    const body = JSON.stringify(event);
    for (const target of targets) {
      const hooks = (await webhooksForOwner(target.ownerKeyId)).filter(
        (hook) => (hook.events as readonly string[]).includes(event.type) && (!target.subtreeOnly || hook.scope === "subtree"),
      );
      if (hooks.length === 0) continue;
      // A revoked key's webhooks never receive events (a store failure throws: nothing is sent).
      if (await isKeyRevoked(target.ownerKeyId)) continue;
      for (const hook of hooks) {
        if (this.durable) {
          const intentId = eventIntentId(event);
          await this.durable.enqueue({
            webhookId: hook.id,
            ownerKeyId: target.ownerKeyId,
            eventId: event.id,
            eventType: event.type,
            body,
            ...(intentId ? { intentId } : {}),
          });
        } else {
          this.enqueue({ webhookId: hook.id, ownerKeyId: target.ownerKeyId, url: hook.url, event, body, attempt: 1 });
        }
      }
    }
    if (this.durable) void this.pollDurable();
  }

  /* -------------------------------------------------- durable (Postgres) */

  private scheduleDurable(delayMs: number): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = null;
    if (!this.unsubscribe) return;
    this.durableTimer = setTimeout(() => {
      this.durableTimer = null;
      void this.pollDurable();
    }, delayMs);
    this.durableTimer.unref?.();
  }

  /**
   * Claims due rows up to this worker's free slots and starts them. Polls
   * every `pollMs` while there is work; an empty poll doubles the interval up
   * to 5 s, but never sleeps past the next due row. Routing and finished
   * deliveries poll at once.
   */
  private async pollDurable(): Promise<void> {
    const queue = this.durable;
    if (!queue || !this.unsubscribe || !sealingAvailable()) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    this.pollAgain = false;
    let claimed = 0;
    try {
      const now = Date.now();
      const paused = [...this.breakers].filter(([, breaker]) => breaker.pausedUntil > now).map(([id]) => id);
      const jobs = await queue.claim(CONCURRENCY - this.active, [...new Set([...this.busyWebhooks, ...paused])]);
      claimed = jobs.length;
      for (const job of jobs) {
        if (!this.unsubscribe) {
          await queue.release(job, "shutdown");
          continue;
        }
        this.active += 1;
        this.busyWebhooks.add(job.webhookId);
        void this.deliverDurable(job)
          .catch((error: unknown) => {
            // The lease stays recoverable when storage failed while recording the
            // result: no success is silently acknowledged.
            console.warn("[platform] durable webhook delivery deferred:", error instanceof Error ? error.message : error);
          })
          .finally(() => {
            this.active -= 1;
            this.busyWebhooks.delete(job.webhookId);
            if (this.unsubscribe) void this.pollDurable();
          });
      }
      this.durableWaiting = await queue.waiting();
    } catch (error) {
      console.warn("[platform] webhook queue polling deferred:", error instanceof Error ? error.message : error);
    } finally {
      this.polling = false;
    }
    if (claimed > 0 || this.pollAgain) {
      this.idlePollMs = this.pollMs;
      this.scheduleDurable(this.pollAgain ? 0 : this.pollMs);
      return;
    }
    this.idlePollMs = Math.min(WEBHOOK_QUEUE_IDLE_POLL_MS, Math.max(this.pollMs, this.idlePollMs * 2));
    const nextDue = this.durableWaiting.nextDueMs;
    this.scheduleDurable(nextDue !== null && nextDue > 0 ? Math.min(this.idlePollMs, Math.max(this.pollMs, nextDue)) : this.idlePollMs);
  }

  /** Hands a job back after a failure before sending (bounded, see webhookQueue.ts). */
  private async deferDurable(queue: PostgresWebhookQueue, job: QueuedWebhook, reason: string): Promise<void> {
    const outcome = await queue.release(job);
    if (outcome !== "dropped") return;
    this.dropped += 1;
    console.warn(`[platform] webhook ${job.webhookId} dropped ${job.eventType} ${job.eventId} after ${WEBHOOK_MAX_DEFERRALS} deferrals (${reason}).`);
  }

  private async deliverDurable(job: QueuedWebhook): Promise<void> {
    const queue = this.durable;
    if (!queue) return;
    if (!this.unsubscribe || !sealingAvailable()) {
      await queue.release(job, "shutdown");
      return;
    }
    let attempted = false;
    let started = 0;
    let outcome: { status: DeliveryRecord["status"]; httpStatus?: number; durationMs?: number; error?: DeliveryError };
    let retryAt: string | undefined;
    try {
      // Deletion, revocation and expiry also apply to queued retries.
      const hook = (await webhooksForOwner(job.ownerKeyId, { fresh: true })).find((entry) => entry.id === job.webhookId);
      const origin = job.intentId ? await resolveIntentOwner(job.intentId) : null;
      // Unknown includes a failing intent store after a restart: keep the sealed job until it resolves.
      if (job.intentId && origin === undefined) {
        await this.deferDurable(queue, job, "intent owner unavailable");
        return;
      }
      if (!hook || !(await liveOwner(job.ownerKeyId)) || (job.intentId && origin === null)) {
        outcome = { status: "dropped" };
      } else {
        const signature = await signWebhookPayload(webhookSecret(hook), job.body);
        attempted = true;
        started = performance.now();
        const status = await this.transport(new URL(hook.url), job.body, {
          "content-type": "application/json",
          "user-agent": WEBHOOK_USER_AGENT,
          "kletia-signature": signature,
          "kletia-event-id": job.eventId,
          "kletia-event-type": job.eventType,
          "kletia-webhook-id": job.webhookId,
          "kletia-delivery-attempt": String(job.attempt),
        });
        outcome = { ...classifyStatus(status), httpStatus: status, durationMs: Math.round(performance.now() - started) };
      }
    } catch (error) {
      if (!attempted) {
        // A failing key or webhook store, or signing, never spends an endpoint
        // attempt and never falls through into sending without authorization.
        await this.deferDurable(queue, job, "storage unavailable");
        return;
      }
      outcome = { status: "failed", error: classifyDeliveryError(error), durationMs: Math.round(performance.now() - started) };
    }
    if (outcome.status === "failed") {
      this.recordFailure(job.webhookId);
      const delay = WEBHOOK_RETRY_DELAYS_MS[job.attempt - 1];
      if (delay !== undefined) retryAt = new Date(Math.max(Date.now() + delay, this.breakers.get(job.webhookId)?.pausedUntil ?? 0)).toISOString();
    }
    const value: DeliveryRecord = {
      id: newDeliveryId(),
      webhookId: job.webhookId,
      ownerKeyId: job.ownerKeyId,
      eventId: job.eventId,
      eventType: job.eventType,
      ...(job.intentId ? { intentId: job.intentId } : {}),
      attempt: job.attempt,
      ...outcome,
      ...(retryAt ? { nextRetryAt: retryAt } : {}),
      at: new Date().toISOString(),
    };
    if (await queue.finish(job, value, retryAt)) {
      if (outcome.status === "succeeded") {
        this.delivered += 1;
        this.breakers.delete(job.webhookId);
      } else if (outcome.status === "dropped") this.dropped += 1;
      else if (!retryAt) {
        this.failed += 1;
        console.warn(`[platform] webhook ${job.webhookId} gave up on ${job.eventId} after ${job.attempt} attempts.`);
      }
      // The queue wrote the log row in its own transaction; a custom recorder (tests) still sees every outcome.
      if (this.recorder !== recordDelivery) this.recorder(value);
    }
  }

  /* ------------------------------------------------------ memory queues */

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
    this.drop(`${reason}; oldest was ${oldest.event.type} ${oldest.event.id} for ${oldest.webhookId}`, oldest);
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
    let started = 0;
    let failure: { error: DeliveryError; httpStatus?: number } | null = null;
    try {
      // Deletion, revocation and expiry (of the owner or an ancestor) also apply to queued retries.
      const hook = (await webhooksForOwner(delivery.ownerKeyId, { fresh: true })).find((entry) => entry.id === delivery.webhookId);
      const intentId = eventIntentId(delivery.event);
      const origin = intentId ? await resolveIntentOwner(intentId) : null;
      if (intentId && origin === undefined) {
        this.defer(delivery, "intent owner unavailable");
        return;
      }
      if (!hook || !(await liveOwner(delivery.ownerKeyId)) || (intentId && origin === null)) {
        this.dropped += 1;
        this.record(delivery, { status: "dropped" });
        return;
      }
      const signature = await signWebhookPayload(webhookSecret(hook), delivery.body);
      attempted = true;
      started = performance.now();
      status = await this.transport(new URL(hook.url), delivery.body, {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        "kletia-signature": signature,
        "kletia-event-id": delivery.event.id,
        "kletia-event-type": delivery.event.type,
        "kletia-webhook-id": delivery.webhookId,
        "kletia-delivery-attempt": String(delivery.attempt),
      });
      const outcome = classifyStatus(status);
      if (outcome.status === "succeeded") {
        this.delivered += 1;
        this.breakers.delete(delivery.webhookId);
        this.record(delivery, { status: "succeeded", httpStatus: status, durationMs: Math.round(performance.now() - started) });
        return;
      }
      failure = { error: outcome.error ?? "http_status", httpStatus: status };
      reason = `HTTP ${status}`;
    } catch (error) {
      if (!attempted) {
        // A failing key or webhook store, or signing, never spends an endpoint attempt.
        this.defer(delivery, error instanceof Error ? error.message.slice(0, 120) : "storage unavailable");
        return;
      }
      failure = { error: classifyDeliveryError(error) };
      reason = error instanceof Error ? error.message.slice(0, 120) : "delivery error";
    }
    // Only the endpoint's own failures count towards pausing it (not storage or signing errors).
    if (attempted) this.recordFailure(delivery.webhookId);
    const delay = WEBHOOK_RETRY_DELAYS_MS[delivery.attempt - 1];
    if (failure) {
      this.record(delivery, {
        status: "failed",
        ...failure,
        durationMs: Math.round(performance.now() - started),
        ...(delay !== undefined ? { nextRetryAt: new Date(Date.now() + delay).toISOString() } : {}),
      });
    }
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

  /**
   * Tries `delivery` again later without spending an endpoint attempt: 1 s
   * doubling to 60 s; the last of WEBHOOK_MAX_DEFERRALS drops it as
   * `deferred_too_long` with its attempt number unchanged.
   */
  private defer(delivery: Delivery, reason: string): void {
    const deferrals = (delivery.deferrals ?? 0) + 1;
    if (deferrals >= WEBHOOK_MAX_DEFERRALS) {
      this.dropped += 1;
      this.record(delivery, { status: "dropped", error: "deferred_too_long" });
      console.warn(`[platform] webhook ${delivery.webhookId} dropped ${delivery.event.type} ${delivery.event.id} after ${deferrals} deferrals (${reason}).`);
      return;
    }
    this.retry({ ...delivery, deferrals }, webhookDeferralDelayMs(deferrals - 1, this.deferralBaseMs), false);
  }

  private retry(delivery: Delivery, delayMs: number, spendAttempt = true): void {
    const owner = delivery.ownerKeyId;
    if ((this.retries.get(owner)?.size ?? 0) >= WEBHOOK_MAX_RETRIES_PER_OWNER) {
      this.drop(`too many pending retries for this key; ${delivery.event.type} ${delivery.event.id} for ${delivery.webhookId}`, delivery);
      return;
    }
    const timer = this.later(
      delayMs,
      () => {
        if (timer) this.forgetRetry(owner, timer);
        this.enqueue({ ...delivery, attempt: delivery.attempt + (spendAttempt ? 1 : 0) });
      },
      delivery,
    );
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
    this.drop(`too many pending retries; cancelled ${delivery.event.type} ${delivery.event.id} for ${delivery.webhookId}`, delivery);
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

/** Transport for synchronous test deliveries: the running dispatcher's (tests inject one), else HTTPS. */
export function webhookDeliveryTransport(): WebhookTransport {
  return dispatcher?.transport ?? httpsTransport;
}
