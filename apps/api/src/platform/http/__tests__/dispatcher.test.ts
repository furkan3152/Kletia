/**
 * Webhook dispatcher isolation between API keys: per-key queues served
 * round-robin, per-key and per-webhook in-flight caps, per-key queue bounds,
 * the global bound as a backstop, and pausing of failing webhooks. Runs the
 * real dispatcher, webhook store and owner cache with a scripted transport;
 * nothing touches the network.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/dispatcher.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { WebhookDispatcher as Dispatcher, WebhookTransport } from "../dispatcher.js";

delete process.env.KLETIA_DATABASE_URL;
delete process.env.KLETIA_PLATFORM_SECRET;
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

// Loaded after the environment is fixed: stores and the sealing key are resolved lazily from it.
const { publishIntentEvent } = await import("../../index.js");
const {
  WebhookDispatcher,
  WEBHOOK_MAX_IN_FLIGHT_PER_OWNER,
  WEBHOOK_MAX_QUEUE,
  WEBHOOK_MAX_QUEUED_PER_OWNER,
  WEBHOOK_PAUSE_AFTER_FAILURES,
} = await import("../dispatcher.js");
const { rememberIntentOwner } = await import("../owners.js");
const { createWebhook } = await import("../webhooks.js");

/* ------------------------------------------------------------ helpers */

async function waitFor(condition: () => boolean, timeoutMs = 3_000, message = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function newOwner(): string {
  return `key_${randomBytes(12).toString("hex")}`;
}

/** Registers `count` webhooks for `owner` and returns their URLs. */
async function hooksFor(owner: string, count: number): Promise<string[]> {
  const urls: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = `https://93.184.215.14/${owner}/${index}`;
    await createWebhook(owner, { url, events: ["intent.status_changed"] });
    urls.push(url);
  }
  return urls;
}

/** Publishes one event for a fresh intent owned by `owner` (fans out to each of its webhooks). */
function emit(owner: string): void {
  const intentId = `int_${randomBytes(16).toString("hex")}`;
  rememberIntentOwner(intentId, owner);
  publishIntentEvent("intent.status_changed", { intentId, status: "cancelled", previous: "planned" });
}

/** Records every delivery attempt and the highest concurrency seen per webhook URL. */
function recordingTransport(respond: (url: string) => number | Promise<number>) {
  const calls: string[] = [];
  const active = new Map<string, number>();
  let maxPerWebhook = 0;
  const transport: WebhookTransport = async (url) => {
    const key = url.toString();
    calls.push(key);
    const now = (active.get(key) ?? 0) + 1;
    active.set(key, now);
    maxPerWebhook = Math.max(maxPerWebhook, now);
    try {
      return await respond(key);
    } finally {
      active.set(key, (active.get(key) ?? 1) - 1);
    }
  };
  return {
    transport,
    calls,
    count: (url: string) => calls.filter((entry) => entry === url).length,
    maxPerWebhook: () => maxPerWebhook,
  };
}

/** An endpoint that accepts the request and never answers until released. */
function hangingEndpoints() {
  const waiting: ((status: number) => void)[] = [];
  return {
    hang: () => new Promise<number>((resolve) => waiting.push(resolve)),
    waiting: () => waiting.length,
    release: (status = 204) => {
      for (const resolve of waiting.splice(0)) resolve(status);
    },
  };
}

/* ------------------------------------------------------------ tests */

describe("webhook dispatcher isolation between keys", () => {
  let dispatcher: Dispatcher | null = null;
  let cleanup: () => void = () => undefined;

  afterEach(() => {
    dispatcher?.stop();
    dispatcher = null;
    cleanup();
    cleanup = () => undefined;
  });

  it("keeps delivering another key's events while one key's endpoints hang, and drops only that key's backlog", async () => {
    const attacker = newOwner();
    const victim = newOwner();
    const attackerHooks = await hooksFor(attacker, 10);
    const [victimHook] = await hooksFor(victim, 1);
    assert.ok(victimHook);
    const endpoints = hangingEndpoints();
    cleanup = () => endpoints.release();
    const recorder = recordingTransport((url) => (url === victimHook ? 204 : endpoints.hang()));
    dispatcher = new WebhookDispatcher(recorder.transport);
    dispatcher.start();

    emit(attacker);
    await waitFor(() => endpoints.waiting() > 0, 3_000, "the attacker's first deliveries");
    emit(victim);
    for (let index = 0; index < 149; index += 1) emit(attacker);
    const total = 150 * attackerHooks.length;
    const current = dispatcher;
    await waitFor(() => {
      const stats = current.stats();
      return stats.inFlight + stats.queued + stats.dropped === total;
    }, 3_000, "every attacker delivery to be routed");
    await waitFor(() => recorder.count(victimHook) === 1, 3_000, "the victim's delivery");

    const stats = dispatcher.stats();
    assert.equal(stats.inFlight, WEBHOOK_MAX_IN_FLIGHT_PER_OWNER, "one key holds at most its in-flight share");
    assert.equal(endpoints.waiting(), WEBHOOK_MAX_IN_FLIGHT_PER_OWNER);
    assert.equal(stats.queued, WEBHOOK_MAX_QUEUED_PER_OWNER, "the attacker's queue is capped");
    assert.equal(stats.dropped, total - WEBHOOK_MAX_IN_FLIGHT_PER_OWNER - WEBHOOK_MAX_QUEUED_PER_OWNER, "only the attacker's own deliveries were dropped");
    assert.equal(recorder.maxPerWebhook(), 1, "one delivery at a time per webhook");

    // A later event of the victim is not queued behind the attacker's backlog either.
    emit(victim);
    await waitFor(() => recorder.count(victimHook) === 2, 3_000, "the victim's second delivery");
    assert.equal(dispatcher.stats().delivered, 2);
  });

  it("serves keys round-robin and evicts from the longest queue when the global bound is hit", async () => {
    const attackers = Array.from({ length: 6 }, () => newOwner());
    const victim = newOwner();
    for (const attacker of attackers) await hooksFor(attacker, 2);
    const [victimHook] = await hooksFor(victim, 1);
    assert.ok(victimHook);
    const endpoints = hangingEndpoints();
    cleanup = () => endpoints.release();
    let attackersAnswer = false;
    let queuedWhenVictimServed = -1;
    const recorder = recordingTransport((url) => {
      if (url === victimHook) {
        queuedWhenVictimServed = current.stats().queued;
        return 204;
      }
      return attackersAnswer ? 204 : endpoints.hang();
    });
    const current: Dispatcher = new WebhookDispatcher(recorder.transport);
    dispatcher = current;
    current.start();

    // Six keys with two hanging webhooks each occupy every delivery slot.
    for (const attacker of attackers) emit(attacker);
    await waitFor(() => endpoints.waiting() === 8, 3_000, "all delivery slots to be taken");
    emit(victim);
    for (const attacker of attackers) for (let index = 0; index < 110; index += 1) emit(attacker);
    const total = attackers.length * 111 * 2 + 1;
    await waitFor(() => {
      const stats = current.stats();
      return stats.inFlight + stats.queued + stats.dropped === total;
    }, 3_000, "every delivery to be routed");
    const flooded = current.stats();
    assert.equal(flooded.queued, WEBHOOK_MAX_QUEUE, "the global bound holds");
    assert.ok(flooded.dropped > 0);
    assert.equal(recorder.count(victimHook), 0, "no slot was free yet");

    // As soon as slots free up, the victim is served in the first round instead of after ~1000 queued deliveries.
    attackersAnswer = true;
    endpoints.release();
    await waitFor(() => recorder.count(victimHook) === 1, 5_000, "the victim's delivery (it must not have been evicted)");
    assert.ok(queuedWhenVictimServed > WEBHOOK_MAX_QUEUE - 50, `victim served while ${queuedWhenVictimServed} deliveries were still queued`);
    assert.equal(recorder.maxPerWebhook(), 1, "one delivery at a time per webhook");
  });

  it("pauses a webhook after consecutive failures while the key's other webhooks keep flowing", async () => {
    const owner = newOwner();
    const [failing, healthy] = await hooksFor(owner, 2);
    assert.ok(failing && healthy);
    const recorder = recordingTransport((url) => (url === failing ? 500 : 204));
    const current: Dispatcher = new WebhookDispatcher(recorder.transport);
    dispatcher = current;
    current.start();

    const events = WEBHOOK_PAUSE_AFTER_FAILURES + 3;
    for (let index = 0; index < events; index += 1) emit(owner);
    await waitFor(() => recorder.count(healthy) === events, 3_000, "every delivery to the healthy webhook");
    await settle();
    assert.equal(recorder.count(failing), WEBHOOK_PAUSE_AFTER_FAILURES, "no attempts while paused");
    const stats = current.stats();
    assert.equal(stats.pausedWebhooks, 1);
    assert.equal(stats.queued, events - WEBHOOK_PAUSE_AFTER_FAILURES, "the paused webhook's deliveries wait in the queue");
    assert.equal(stats.scheduledRetries, WEBHOOK_PAUSE_AFTER_FAILURES, "each failed attempt is retried later");
    assert.equal(stats.dropped, 0);
  });
});
