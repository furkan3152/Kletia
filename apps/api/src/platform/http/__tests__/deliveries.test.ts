/**
 * Webhook test deliveries and the per-webhook delivery log: signed
 * webhook.test events through the stub transport, outcome classification,
 * the per-webhook test limit, attempts and retries recorded by the
 * dispatcher, drops recorded as queue_full, ownership, cascade on delete,
 * and the store contract (memory, plus Postgres when KLETIA_TEST_DATABASE_URL
 * is set).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { verifyWebhookSignature, type IntentGraph } from "@kletia/core";
import { configurePlatform } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import type { WebhookTransport } from "../dispatcher.js";
import { assertError, call, serve, useTestEnvironment, waitFor, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler, startPlatformBackground } = await import("../index.js");
const deliveries = await import("../deliveries.js");
const { WebhookDispatcher, WEBHOOK_MAX_QUEUED_PER_OWNER } = await import("../dispatcher.js");
const { publishIntentEvent } = await import("../../index.js");
const { rememberIntentOwner } = await import("../owners.js");
const { createWebhook } = await import("../webhooks.js");
const { closePlatformDatabase } = await import("../db.js");

type Delivery = import("../deliveries.js").WebhookDelivery;

interface Sent {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

const sent: Sent[] = [];
let respond: (sent: Sent) => number | Promise<number> = () => 204;
const transport: WebhookTransport = async (url, body, headers) => {
  const entry = { url: url.toString(), body, headers: { ...headers } };
  sent.push(entry);
  return respond(entry);
};

let server: TestServer;
let key: string;
let otherKey: string;
let stopBackground: () => void = () => undefined;

async function issue(name: string): Promise<string> {
  const reply = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key.key;
}

async function webhook(path: string, events?: string[]): Promise<{ id: string; secret: string }> {
  const reply = await call<{ webhook: { id: string; secret: string } }>(server, "POST", "/webhooks", {
    key,
    body: { url: `https://93.184.215.14/${path}`, ...(events ? { events } : {}) },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.webhook;
}

async function log(id: string, limit = 20): Promise<Delivery[]> {
  await deliveries.flushDeliveryLog();
  const reply = await call<{ deliveries: Delivery[] }>(server, "GET", `/webhooks/${id}/deliveries?limit=${limit}`, { key });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.deliveries;
}

before(async () => {
  resetEngine();
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  key = await issue("hooks");
  otherKey = await issue("other");
  stopBackground = startPlatformBackground({ webhookTransport: transport, poller: { intervalMs: 60_000 } });
});

beforeEach(() => {
  sent.length = 0;
  respond = () => 204;
});

after(async () => {
  stopBackground();
  configurePlatform({ adapters: null });
  await server.close();
});

describe("POST /v1/webhooks/{id}/test", () => {
  it("sends one signed webhook.test event and records the outcome", async () => {
    const hook = await webhook("test-ok");
    const reply = await call<{ delivery: Delivery }>(server, "POST", `/webhooks/${hook.id}/test`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const { delivery } = reply.body;
    assert.match(delivery.id, /^whd_[0-9a-f]{24}$/u);
    assert.equal(delivery.status, "succeeded");
    assert.equal(delivery.httpStatus, 204);
    assert.equal(delivery.eventType, "webhook.test");
    assert.equal(delivery.test, true);
    assert.equal(delivery.attempt, 1);
    assert.ok(typeof delivery.durationMs === "number");
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.ok(request);
    const event = JSON.parse(request.body) as { id: string; type: string; data: { webhookId: string } };
    assert.equal(event.type, "webhook.test");
    assert.equal(event.data.webhookId, hook.id);
    assert.equal(event.id, delivery.eventId);
    assert.equal(request.headers["kletia-event-type"], "webhook.test");
    assert.equal(request.headers["kletia-webhook-id"], hook.id);
    assert.equal((await verifyWebhookSignature(hook.secret, request.body, request.headers["kletia-signature"])).valid, true);
    const logged = await log(hook.id);
    assert.deepEqual(logged.map((entry) => entry.id), [delivery.id]);
  });

  it("classifies endpoint failures without keeping their text", async () => {
    const hook = await webhook("test-fail");
    const outcomes: [() => number | Promise<number>, Partial<Delivery>][] = [
      [() => 500, { status: "failed", httpStatus: 500, error: "http_status" }],
      [() => 302, { status: "failed", httpStatus: 302, error: "redirect" }],
      [() => Promise.reject(new Error("Webhook delivery timed out.")), { status: "failed", error: "timeout" }],
      [() => Promise.reject(Object.assign(new Error("resolves to 10.0.0.1 internal-host.corp"), { code: "EWEBHOOKFORBIDDEN" })), { status: "failed", error: "forbidden_address" }],
    ];
    for (const [response, expected] of outcomes) {
      respond = response;
      const reply = await call<{ delivery: Delivery }>(server, "POST", `/webhooks/${hook.id}/test`, { key });
      assert.equal(reply.status, 200, "a failed attempt is still a successful test");
      for (const [field, value] of Object.entries(expected)) assert.equal(reply.body.delivery[field as keyof Delivery], value, field);
      assert.ok(!JSON.stringify(reply.body).includes("internal-host"), "error text is never returned");
    }
    // Five tests per minute per webhook.
    respond = () => 200;
    assert.equal((await call(server, "POST", `/webhooks/${hook.id}/test`, { key })).status, 200);
    const limited = assertError(await call(server, "POST", `/webhooks/${hook.id}/test`, { key }), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /5 test deliveries per minute/u);
    const stored = await log(hook.id);
    assert.deepEqual(stored.map((entry) => entry.error ?? entry.status), ["succeeded", "forbidden_address", "timeout", "redirect", "http_status"], "newest first");
  });

  it("never pauses a webhook for failed tests", async () => {
    const hook = await webhook("test-breaker", ["intent.created"]);
    respond = () => 503;
    for (let index = 0; index < 5; index += 1) await call(server, "POST", `/webhooks/${hook.id}/test`, { key });
    respond = () => 204;
    sent.length = 0;
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    assert.equal(created.status, 201);
    await waitFor(() => sent.some((entry) => entry.url.endsWith("test-breaker")), 2_000, "a real delivery right away");
  });

  it("is scoped to the owner key and validates ids", async () => {
    const hook = await webhook("test-owner");
    assertError(await call(server, "POST", `/webhooks/${hook.id}/test`, { key: otherKey }), 404, "WEBHOOK_NOT_FOUND");
    assertError(await call(server, "GET", `/webhooks/${hook.id}/deliveries`, { key: otherKey }), 404, "WEBHOOK_NOT_FOUND");
    assertError(await call(server, "POST", "/webhooks/wh_nope/test", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", `/webhooks/${hook.id}/deliveries?limit=0`, { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/webhooks/${hook.id}/test`), 401, "API_KEY_REQUIRED");
  });
});

describe("GET /v1/webhooks/{id}/deliveries", () => {
  it("records real attempts, retries with nextRetryAt and the final success", async () => {
    const hook = await webhook("log-retry", ["intent.created"]);
    respond = (entry) => (entry.url.endsWith("log-retry") && entry.headers["kletia-delivery-attempt"] === "1" ? 500 : 200);
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    await waitFor(async () => (await log(hook.id)).length >= 2, 4_000, "two attempts in the log");
    const [success, failure] = await log(hook.id);
    assert.equal(failure?.status, "failed");
    assert.equal(failure?.attempt, 1);
    assert.equal(failure?.httpStatus, 500);
    assert.equal(failure?.error, "http_status");
    assert.ok(failure?.nextRetryAt && Date.parse(failure.nextRetryAt) > Date.parse(failure.at));
    assert.equal(success?.status, "succeeded");
    assert.equal(success?.attempt, 2);
    assert.equal(success?.eventType, "intent.created");
    assert.equal(success?.intentId, created.body.intent.id);
    assert.equal(success?.eventId, failure?.eventId);
    assert.equal(success?.test, undefined);
  });

  it("goes away with the webhook", async () => {
    const hook = await webhook("log-delete");
    await call(server, "POST", `/webhooks/${hook.id}/test`, { key });
    assert.equal((await log(hook.id)).length, 1);
    assert.equal((await call(server, "DELETE", `/webhooks/${hook.id}`, { key })).status, 204);
    assert.deepEqual(await deliveries.deliveryStore().list(await keyIdOf(key), hook.id, 10), []);
  });
});

async function keyIdOf(raw: string): Promise<string> {
  const reply = await call<{ keys: { id: string; current: boolean }[] }>(server, "GET", "/keys", { key: raw });
  return reply.body.keys.find((entry) => entry.current)?.id ?? "";
}

describe("dispatcher drops", () => {
  it("records deliveries it drops as queue_full", async () => {
    const records: import("../deliveries.js").DeliveryRecord[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<number>((resolve) => {
      release = () => resolve(204);
    });
    const dispatcher = new WebhookDispatcher(() => blocked, (record) => records.push(record));
    const owner = `key_${randomBytes(12).toString("hex")}`;
    await createWebhook(owner, { url: `https://93.184.215.14/${owner}/drops`, events: ["intent.status_changed"] });
    dispatcher.start();
    try {
      for (let index = 0; index < WEBHOOK_MAX_QUEUED_PER_OWNER + 3; index += 1) {
        const intentId = `int_${randomBytes(16).toString("hex")}`;
        rememberIntentOwner(intentId, owner);
        publishIntentEvent("intent.status_changed", { intentId, status: "cancelled", previous: "planned" });
      }
      await waitFor(() => records.filter((record) => record.status === "dropped").length >= 2, 3_000, "drops recorded");
      const dropped = records.filter((record) => record.status === "dropped");
      assert.ok(dropped.every((record) => record.error === "queue_full" && record.ownerKeyId === owner));
    } finally {
      release();
      dispatcher.stop();
    }
  });
});

/* ------------------------------------------------------------ store contract */

function contract(name: string, make: () => import("../deliveries.js").DeliveryStore): void {
  describe(`${name} delivery store`, () => {
    const record = (webhookId: string, owner: string, at: string, extra: Partial<import("../deliveries.js").DeliveryRecord> = {}) => ({
      id: deliveries.newDeliveryId(),
      webhookId,
      ownerKeyId: owner,
      eventId: `evt_${randomBytes(16).toString("hex")}`,
      eventType: "intent.created",
      attempt: 1,
      status: "succeeded" as const,
      httpStatus: 204,
      durationMs: 12,
      at,
      ...extra,
    });

    it("lists newest first, per owner, and prunes by age", async () => {
      const store = make();
      const owner = `key_${randomBytes(12).toString("hex")}`;
      const webhookId = `wh_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      const old = record(webhookId, owner, new Date(now - 8 * 86_400_000).toISOString());
      const recent = record(webhookId, owner, new Date(now - 1_000).toISOString(), { status: "failed", error: "timeout", nextRetryAt: new Date(now + 5_000).toISOString() });
      const newest = record(webhookId, owner, new Date(now).toISOString(), { intentId: `int_${randomBytes(16).toString("hex")}` });
      await store.insert([old, recent, newest]);
      const listed = await store.list(owner, webhookId, 10);
      assert.deepEqual(listed.map((entry) => entry.id), [newest.id, recent.id, old.id]);
      assert.equal(listed[1]?.error, "timeout");
      assert.equal(listed[0]?.intentId, newest.intentId);
      assert.ok(!("ownerKeyId" in (listed[0] ?? {})), "the owner is never returned");
      assert.deepEqual(await store.list(`key_${"f".repeat(24)}`, webhookId, 10), [], "another owner sees nothing");
      assert.equal((await store.list(owner, webhookId, 1)).length, 1);
      await store.prune(now);
      assert.deepEqual((await store.list(owner, webhookId, 10)).map((entry) => entry.id), [newest.id, recent.id]);
      await store.deleteForWebhook(webhookId);
      assert.deepEqual(await store.list(owner, webhookId, 10), []);
    });
  });
}

contract("memory", () => new deliveries.MemoryDeliveryStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    });
    contract("postgres", () => new deliveries.PostgresDeliveryStore());
  });
} else {
  describe("postgres delivery store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
