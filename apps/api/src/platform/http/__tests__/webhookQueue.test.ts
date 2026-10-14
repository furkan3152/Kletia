/**
 * The durable webhook queue on Postgres: sealing, deduplication, restart and
 * retry recovery, fencing, cross-worker concurrency and caps, fresh
 * authorization before every attempt, and the poison bounds (a body that no
 * longer opens never wedges the queue; a delivery that cannot be attempted
 * is deferred with back-off and dropped after the deferral bound). Runs with
 * KLETIA_TEST_DATABASE_URL; nothing touches the network.
 *
 *   KLETIA_TEST_DATABASE_URL=postgres://… node --import tsx --test src/platform/http/__tests__/webhookQueue.test.ts
 */
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { verifyWebhookSignature } from "@kletia/core";
import { useTestEnvironment, waitFor } from "./support.js";
import type { QueuedWebhook } from "../webhookQueue.js";
import type { DeliveryRecord } from "../deliveries.js";
import type { WebhookDispatcher as Dispatcher, WebhookTransport } from "../dispatcher.js";

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
useTestEnvironment();
const SECRET = "webhook-queue-test-secret-0123456789abcdef";
if (databaseUrl) {
  process.env.KLETIA_DATABASE_URL = databaseUrl;
  process.env.KLETIA_PLATFORM_SECRET = SECRET;
}

/**
 * Seals like secrets.ts under another platform secret: what a row written
 * before KLETIA_PLATFORM_SECRET changed looks like to the current process.
 */
function sealUnder(secret: string, plaintext: string, row: { id: string; owner_key_id: string; webhook_id: string; event_id: string; event_type: string; intent_id: string | null }): string {
  const key = createHash("sha256").update(secret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const context = JSON.stringify(["kletia.webhook-queue.v1", row.id, row.owner_key_id, row.webhook_id, row.event_id, row.event_type, row.intent_id]);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

describe("Postgres durable webhook delivery", { skip: !databaseUrl && "set KLETIA_TEST_DATABASE_URL" }, () => {
  let sql: pg.Client;
  let Queue: typeof import("../webhookQueue.js").PostgresWebhookQueue;
  let DispatcherClass: typeof import("../dispatcher.js").WebhookDispatcher;
  let queueModule: typeof import("../webhookQueue.js");
  let store: import("../webhookQueue.js").PostgresWebhookQueue;
  const workers: Dispatcher[] = [];
  const registrations: { owner: string; id: string }[] = [];
  const limits = { queued: 1000, perOwner: 200, concurrency: 8, perOwnerConcurrency: 2 };
  const hex = () => randomBytes(12).toString("hex");

  before(async () => {
    sql = new pg.Client({ connectionString: databaseUrl });
    await sql.connect();
    queueModule = await import("../webhookQueue.js");
    Queue = queueModule.PostgresWebhookQueue;
    ({ WebhookDispatcher: DispatcherClass } = await import("../dispatcher.js"));
    store = new Queue(limits);
    await store.claim(0); // Creates the queue and delivery log schema before the SQL assertions.
  });
  beforeEach(async () => {
    await sql.query("TRUNCATE kletia_webhook_queue");
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      worker.stop();
      await waitFor(() => worker.stats().inFlight === 0, 3000, "worker drained");
    }
    for (const registered of registrations.splice(0)) {
      await (await import("../webhooks.js")).deleteWebhook(registered.owner, registered.id);
    }
  });
  after(async () => {
    await sql.end();
    await (await import("../../index.js")).getIntentStore().close();
    await (await import("../db.js")).closePlatformDatabase();
    delete process.env.KLETIA_DATABASE_URL;
    delete process.env.KLETIA_PLATFORM_SECRET;
  });

  function input(ownerKeyId = `key_${hex()}`, webhookId = `wh_${hex()}`, eventId = `evt_${randomBytes(16).toString("hex")}`) {
    return { ownerKeyId, webhookId, eventId, eventType: "intent.status_changed", body: JSON.stringify({ id: eventId, private: "plaintext must stay sealed" }) };
  }
  function result(job: QueuedWebhook, status: DeliveryRecord["status"] = "succeeded"): DeliveryRecord {
    return { id: `whd_${hex()}`, ownerKeyId: job.ownerKeyId, webhookId: job.webhookId,
      eventId: job.eventId, eventType: job.eventType, attempt: job.attempt, status, at: new Date().toISOString() };
  }
  function worker(transport: WebhookTransport): Dispatcher {
    const value = new DispatcherClass(transport, undefined, { pollMs: 25 });
    workers.push(value);
    value.start();
    return value;
  }
  async function backlog() {
    const { queued, retries } = await store.waiting();
    return { queued, retries };
  }

  async function hook() {
    const { issueDeveloperKey } = await import("../auth.js");
    const issued = await issueDeveloperKey("durable-test");
    const owner = await (await import("../auth.js")).apiKeyStore().findById(issued.id);
    assert.ok(owner);
    const created = await (await import("../webhooks.js")).createWebhook(owner.id,
      { url: `https://93.184.215.14/${hex()}`, events: ["intent.status_changed"] });
    registrations.push({ owner: owner.id, id: created.id });
    return { owner, ...created };
  }
  async function emit(owner: string) {
    const id = `int_${randomBytes(16).toString("hex")}`;
    (await import("../owners.js")).rememberIntentOwner(id, owner);
    return (await import("../../index.js")).publishIntentEvent("intent.status_changed", { intentId: id, status: "cancelled", previous: "planned" });
  }
  /** Makes the engine store's owner lookup fail (a real Postgres error) for one intent while `failing()` holds. */
  async function unavailableOwner(context: import("node:test").TestContext, intentId: string, owner: string, failing: () => boolean) {
    const engineStore = (await import("../../index.js")).getIntentStore();
    assert.equal(engineStore.kind, "postgres");
    await engineStore.ownerOf(intentId); // Initialize the separate engine store.
    await sql.query("INSERT INTO kletia_intents(id,owner_key_id,status,graph) VALUES($1,$2,'cancelled','{}'::jsonb)", [intentId, owner]);
    context.after(async () => { await sql.query("DELETE FROM kletia_intents WHERE id=$1", [intentId]); });
    const ownerOf = engineStore.ownerOf.bind(engineStore);
    let lookups = 0;
    context.mock.method(engineStore, "ownerOf", async (id: string) => {
      if (id === intentId) {
        lookups += 1;
        // A real PostgreSQL failure on the engine connection path while the
        // independently pooled webhook and key stores remain available.
        if (failing()) await sql.query("SELECT owner_key_id FROM kletia_intent_owner_lookup_unavailable");
      }
      return ownerOf(id);
    });
    return { lookups: () => lookups };
  }

  it("seals payloads, deduplicates concurrent enqueues and removes payloads on completion", async () => {
    const request = input();
    const enqueues = await Promise.all(Array.from({ length: 12 }, () => store.enqueue(request)));
    assert.equal(enqueues.filter(Boolean).length, 1);
    const row = (await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue")).rows[0];
    assert.ok(!row.body_ciphertext.includes("plaintext"));
    assert.deepEqual(await backlog(), { queued: 1, retries: 0 });
    const [job] = await store.claim(8);
    assert.ok(job);
    assert.equal(job.body, request.body);
    assert.equal(job.deferrals, 0);
    assert.deepEqual(await backlog(), { queued: 0, retries: 0 });
    assert.equal(await store.finish(job, result(job)), true);
    assert.equal((await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue")).rows[0].body_ciphertext, null);
    assert.equal(await store.enqueue(request), false, "completed row remains a deduplication tombstone");
    assert.deepEqual(await store.waiting(), { queued: 0, retries: 0, nextDueMs: null });
  });

  it("shares owner/webhook concurrency limits between workers and fences expired claims", async () => {
    const owner = `key_${hex()}`;
    for (let index = 0; index < 5; index += 1) await store.enqueue(input(owner, `wh_${index}`));
    const second = new Queue(limits);
    const [a, b] = await Promise.all([store.claim(8), second.claim(8)]);
    const claimed = [...a, ...b];
    assert.equal(claimed.length, 2, "owner's two slots are shared across all workers");
    assert.equal(new Set(claimed.map((job) => job.id)).size, 2);
    assert.equal((await store.claim(8)).length, 0);

    const original = claimed[0];
    assert.ok(original);
    await sql.query("UPDATE kletia_webhook_queue SET leased_until=now()-interval '1 second' WHERE id=$1", [original.id]);
    const [reclaimed] = await second.claim(1);
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, original.id);
    assert.notEqual(reclaimed.leaseToken, original.leaseToken);
    assert.equal(original.deferrals, 0);
    assert.equal(reclaimed.deferrals, 1, "an interrupted claim counts as a deferral");
    assert.equal(await store.finish(original, result(original)), false, "stale worker cannot clear the recovered claim");
    assert.equal(await second.finish(reclaimed, result(reclaimed)), true);

    await sql.query("TRUNCATE kletia_webhook_queue");
    const sameHook = `wh_${hex()}`;
    await store.enqueue(input(owner, sameHook));
    await store.enqueue(input(owner, sameHook));
    const together = (await Promise.all([store.claim(8), second.claim(8)])).flat();
    assert.equal(together.length, 1, "one webhook has only one lease across workers");
  });

  it("never sends a body whose stored routing scope was changed, and keeps claiming", async () => {
    const request = input();
    await store.enqueue(request);
    const healthy = input();
    await store.enqueue(healthy);
    await sql.query("UPDATE kletia_webhook_queue SET owner_key_id=$1 WHERE event_id=$2", [`key_${hex()}`, request.eventId]);
    const jobs = await store.claim(8);
    assert.deepEqual(jobs.map((job) => job.eventId), [healthy.eventId], "changing the owner cannot redirect a sealed event body");
    const row = (await sql.query("SELECT body_ciphertext,completed_at,lease_token FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0];
    assert.equal(row.body_ciphertext, null);
    assert.ok(row.completed_at);
    assert.equal(row.lease_token, null);
    const logged = await sql.query("SELECT status,error,attempt FROM kletia_webhook_deliveries WHERE event_id=$1", [request.eventId]);
    assert.deepEqual(logged.rows, [{ status: "dropped", error: "payload_unreadable", attempt: 1 }]);
  });

  it("drops rows sealed under a previous platform secret without throwing, holding leases or blocking other owners", async () => {
    // Six rows of one owner were sealed before the secret changed; a fresh row of another owner is due last.
    const stale = Array.from({ length: 6 }, (_, index) => input("key_rotation_probe", `wh_rotated_${index}_${hex()}`));
    for (const request of stale) await store.enqueue(request);
    const rows = (await sql.query("SELECT id,owner_key_id,webhook_id,event_id,event_type,intent_id FROM kletia_webhook_queue")).rows;
    for (const row of rows) {
      await sql.query("UPDATE kletia_webhook_queue SET body_ciphertext=$2 WHERE id=$1", [row.id, sealUnder("the-previous-platform-secret-0123456789", "{}", row)]);
    }
    const fresh = input(`key_${hex()}`);
    await store.enqueue(fresh);
    await sql.query("UPDATE kletia_webhook_queue SET due_at=now()-interval '1 minute' WHERE owner_key_id='key_rotation_probe'");

    const first = await store.claim(4);
    assert.deepEqual(first.map((job) => job.eventId), [fresh.eventId], "the fresh row behind the stale ones is claimed");
    assert.equal(first[0]?.body, fresh.body);
    const states = await sql.query(
      "SELECT count(*) FILTER (WHERE completed_at IS NOT NULL AND body_ciphertext IS NULL AND lease_token IS NULL) AS dropped, count(*) FILTER (WHERE leased_until > now()) AS leased FROM kletia_webhook_queue",
    );
    assert.deepEqual(states.rows[0], { dropped: "6", leased: "1" }, "no lease is held by an unreadable row");
    const logged = await sql.query("SELECT error, count(*) FROM kletia_webhook_deliveries WHERE owner_key_id='key_rotation_probe' AND event_id = ANY($1) GROUP BY error",
      [stale.map((request) => request.eventId)]);
    assert.deepEqual(logged.rows, [{ error: "payload_unreadable", count: "6" }]);
    assert.deepEqual(await store.claim(4), [], "nothing is left to claim, and the claim does not throw");
    assert.deepEqual(await backlog(), { queued: 0, retries: 0 });
  });

  it("enforces the per-claim bound on unreadable rows and finishes them on later polls", async () => {
    for (let index = 0; index < 60; index += 1) await store.enqueue(input(`key_${hex()}`));
    await sql.query("UPDATE kletia_webhook_queue SET body_ciphertext='v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA'");
    assert.deepEqual(await store.claim(1), []);
    const open = Number((await sql.query("SELECT count(*) FROM kletia_webhook_queue WHERE completed_at IS NULL")).rows[0].count);
    assert.equal(open, 60 - 51, "one claim completes at most its limit plus 50 unreadable rows");
    assert.deepEqual(await store.claim(1), []);
    assert.equal(Number((await sql.query("SELECT count(*) FROM kletia_webhook_queue WHERE completed_at IS NULL")).rows[0].count), 0);
  });

  it("bounds one owner's backlog and commits eviction logs without dropping another owner's work", async () => {
    const small = new Queue({ ...limits, perOwner: 2, queued: 3 });
    const flooded = `key_${hex()}`;
    const oldest = input(flooded);
    await small.enqueue(oldest);
    await small.enqueue(input(flooded));
    await small.enqueue(input(flooded));
    const other = input();
    await small.enqueue(other);
    await small.enqueue(input(flooded));
    const active = await sql.query("SELECT owner_key_id,event_id FROM kletia_webhook_queue WHERE completed_at IS NULL");
    assert.equal(active.rows.length, 3);
    assert.ok(active.rows.some((row) => row.event_id === other.eventId));
    const dropped = await sql.query("SELECT status,error FROM kletia_webhook_deliveries WHERE event_id=$1", [oldest.eventId]);
    assert.deepEqual(dropped.rows, [{ status: "dropped", error: "queue_full" }]);
  });

  it("enforces the process-wide claim cap across workers", async () => {
    for (let index = 0; index < 12; index += 1) await store.enqueue(input());
    const second = new Queue(limits);
    const jobs = (await Promise.all([store.claim(8), second.claim(8)])).flat();
    assert.equal(jobs.length, 8);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 8);
    assert.equal((await second.claim(8)).length, 0);
  });

  it("defers with back-off, then drops a delivery as deferred_too_long at the bound with its attempt unchanged", async () => {
    const request = input();
    await store.enqueue(request);
    const [job] = await store.claim(1);
    assert.ok(job);
    assert.equal(await store.release(job), "released");
    const deferred = (await sql.query("SELECT deferrals, EXTRACT(EPOCH FROM (due_at - now())) AS wait, attempt, leased_until FROM kletia_webhook_queue WHERE id=$1", [job.id])).rows[0];
    assert.equal(deferred.deferrals, 1);
    assert.equal(deferred.attempt, 1, "a deferral never spends an endpoint attempt");
    assert.equal(deferred.leased_until, null);
    assert.ok(Number(deferred.wait) > 0.5 && Number(deferred.wait) <= 1.05, `first deferral waits about 1 s (${deferred.wait})`);
    assert.equal(await store.release(job), "lost", "a released lease cannot be released again");

    // Back-off doubles to 60 s.
    await sql.query("UPDATE kletia_webhook_queue SET deferrals=9, due_at=now() WHERE id=$1", [job.id]);
    const [later] = await store.claim(1);
    assert.ok(later);
    assert.equal(await store.release(later), "released");
    const capped = (await sql.query("SELECT deferrals, EXTRACT(EPOCH FROM (due_at - now())) AS wait FROM kletia_webhook_queue WHERE id=$1", [job.id])).rows[0];
    assert.equal(capped.deferrals, 10);
    assert.ok(Number(capped.wait) > 59 && Number(capped.wait) <= 60.05, `back-off is capped at 60 s (${capped.wait})`);

    await sql.query("UPDATE kletia_webhook_queue SET deferrals=$2, due_at=now() WHERE id=$1", [job.id, queueModule.WEBHOOK_MAX_DEFERRALS - 1]);
    const [last] = await store.claim(1);
    assert.ok(last);
    assert.equal(await store.release(last), "dropped");
    const row = (await sql.query("SELECT completed_at, body_ciphertext, attempt, deferrals FROM kletia_webhook_queue WHERE id=$1", [job.id])).rows[0];
    assert.ok(row.completed_at);
    assert.equal(row.body_ciphertext, null);
    assert.equal(row.attempt, 1);
    assert.equal(row.deferrals, queueModule.WEBHOOK_MAX_DEFERRALS);
    const logged = await sql.query("SELECT status,error,attempt FROM kletia_webhook_deliveries WHERE event_id=$1", [request.eventId]);
    assert.deepEqual(logged.rows, [{ status: "dropped", error: "deferred_too_long", attempt: 1 }]);

    // A shutdown hand-back keeps the due time and does not count.
    const other = input();
    await store.enqueue(other);
    const [held] = await store.claim(1);
    assert.ok(held);
    assert.equal(await store.release(held, "shutdown"), "released");
    const kept = (await sql.query("SELECT deferrals, due_at <= now() AS due FROM kletia_webhook_queue WHERE id=$1", [held.id])).rows[0];
    assert.deepEqual(kept, { deferrals: 0, due: true });
  });

  it("drops a claim interrupted past the deferral bound", async () => {
    const request = input();
    await store.enqueue(request);
    await sql.query("UPDATE kletia_webhook_queue SET deferrals=$1, lease_token='crashed', leased_until=now()-interval '1 second' WHERE event_id=$2",
      [queueModule.WEBHOOK_MAX_DEFERRALS - 1, request.eventId]);
    assert.deepEqual(await store.claim(1), []);
    const logged = await sql.query("SELECT status,error FROM kletia_webhook_deliveries WHERE event_id=$1", [request.eventId]);
    assert.deepEqual(logged.rows, [{ status: "dropped", error: "deferred_too_long" }]);
  });

  it("recovers a failed delivery after restart with the same body/id, a fresh signature and persisted attempt", async () => {
    const registered = await hook();
    let firstBody = "";
    worker(async (_url, body) => { firstBody = body; return 503; });
    const event = await emit(registered.owner.id);
    await waitFor(async () => (await sql.query("SELECT attempt FROM kletia_webhook_queue WHERE event_id=$1 AND leased_until IS NULL", [event.id])).rows[0]?.attempt === 2,
      3000, "failed attempt persisted");
    assert.deepEqual(await backlog(), { queued: 1, retries: 1 });
    workers[0]?.stop();
    await waitFor(() => workers[0]?.stats().inFlight === 0, 3000, "first worker drained");
    // Close the first worker's database pool as a process restart would; the
    // next worker must reconnect and load its body/attempt from storage.
    await (await import("../db.js")).closePlatformDatabase();
    let replay = 0;
    worker(async (_url, body, headers) => {
      assert.equal(body, firstBody);
      assert.equal(headers["kletia-event-id"], event.id);
      assert.equal(headers["kletia-delivery-attempt"], "2");
      assert.equal((await verifyWebhookSignature(registered.secret ?? "", body, headers["kletia-signature"])).valid, true);
      replay += 1;
      return 204;
    });
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      4000, "retry acknowledged");
    assert.equal(replay, 1);
    const logs = await sql.query("SELECT attempt,status FROM kletia_webhook_deliveries WHERE webhook_id=$1 ORDER BY at", [registered.id]);
    assert.deepEqual(logs.rows, [{ attempt: 1, status: "failed" }, { attempt: 2, status: "succeeded" }]);
  });

  it("two running dispatchers deduplicate a single event before transport", async () => {
    const registered = await hook();
    let sent = 0;
    const transport: WebhookTransport = async () => { sent += 1; return 204; };
    worker(transport);
    worker(transport);
    const event = await emit(registered.owner.id);
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      3000, "deduplicated delivery acknowledged");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sent, 1);
  });

  it("an idle worker backs off its polling and still picks up new work at once", async (context) => {
    const claim = context.mock.method(Queue.prototype, "claim");
    const idle = worker(async () => 204);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const polls = claim.mock.callCount();
    assert.ok(polls >= 2 && polls <= 8, `about five polls in the first idle second, not one per 25 ms (${polls})`);
    const registered = await hook();
    const event = await emit(registered.owner.id);
    const started = Date.now();
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      3000, "routed work delivered");
    assert.ok(Date.now() - started < 1_000, "routing polls at once");
    assert.equal(idle.stats().storage, "postgres");
  });

  it("preserves recovered work during an uncached intent-owner store failure without spending an attempt", async (context) => {
    const registered = await hook();
    const intentId = `int_${randomBytes(16).toString("hex")}`;
    let unavailable = true;
    const owner = await unavailableOwner(context, intentId, registered.owner.id, () => unavailable);
    const request = { ...input(registered.owner.id, registered.id), intentId };
    await store.enqueue(request); // No process owner cache, as after a restart.
    const attempts: string[] = [];
    worker(async (_url, _body, headers) => { attempts.push(headers["kletia-delivery-attempt"] ?? ""); return 204; });
    await waitFor(async () => {
      const row = (await sql.query("SELECT attempt,deferrals,leased_until,completed_at FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0];
      return owner.lookups() > 0 && row?.attempt === 1 && row.deferrals >= 1 && row.leased_until === null && row.completed_at === null;
    }, 3000, "failed owner lookup deferred its claim");
    const row = (await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0];
    assert.ok(row.body_ciphertext, "the retryable failure retained the sealed payload");
    assert.deepEqual(attempts, [], "no request left without a resolved origin");
    assert.equal((await sql.query("SELECT count(*) FROM kletia_webhook_deliveries WHERE webhook_id=$1", [registered.id])).rows[0].count, "0");
    unavailable = false;
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0]?.completed_at,
      4000, "the preserved first attempt delivered after recovery");
    assert.deepEqual(attempts, ["1"]);
    assert.deepEqual((await sql.query("SELECT attempt,status FROM kletia_webhook_deliveries WHERE webhook_id=$1", [registered.id])).rows,
      [{ attempt: 1, status: "succeeded" }]);
  });

  it("drops a delivery whose intent owner stays unreadable past the deferral bound, attempt still 1", async (context) => {
    const registered = await hook();
    const intentId = `int_${randomBytes(16).toString("hex")}`;
    await unavailableOwner(context, intentId, registered.owner.id, () => true);
    const request = { ...input(registered.owner.id, registered.id), intentId };
    await store.enqueue(request);
    await sql.query("UPDATE kletia_webhook_queue SET deferrals=$1 WHERE event_id=$2", [queueModule.WEBHOOK_MAX_DEFERRALS - 1, request.eventId]);
    let sent = 0;
    const current = worker(async () => { sent += 1; return 204; });
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0]?.completed_at,
      3000, "the delivery dropped at the bound");
    assert.equal(sent, 0);
    const row = (await sql.query("SELECT attempt, body_ciphertext FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0];
    assert.deepEqual(row, { attempt: 1, body_ciphertext: null });
    assert.deepEqual((await sql.query("SELECT attempt,status,error FROM kletia_webhook_deliveries WHERE webhook_id=$1", [registered.id])).rows,
      [{ attempt: 1, status: "dropped", error: "deferred_too_long" }]);
    await waitFor(() => current.stats().dropped === 1, 1000, "the worker counted the drop");
  });

  it("drops a recovered event with a definitively public origin", async (context) => {
    const registered = await hook();
    const intentId = `int_${randomBytes(16).toString("hex")}`;
    const engineStore = (await import("../../index.js")).getIntentStore();
    const ownerOf = engineStore.ownerOf.bind(engineStore);
    context.mock.method(engineStore, "ownerOf", async (id: string) => id === intentId ? null : ownerOf(id));
    const request = { ...input(registered.owner.id, registered.id), intentId };
    await store.enqueue(request);
    let sent = 0;
    worker(async () => { sent += 1; return 204; });
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0]?.completed_at,
      3000, "public origin discarded");
    assert.equal(sent, 0);
    assert.equal((await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0].body_ciphertext, null);
    assert.equal((await sql.query("SELECT status FROM kletia_webhook_deliveries WHERE webhook_id=$1", [registered.id])).rows[0].status, "dropped");
  });

  it("fresh authorization stops a retry even when a revoked key's webhook remains registered", async () => {
    const registered = await hook();
    let sent = 0;
    worker(async () => { sent += 1; return 503; });
    const event = await emit(registered.owner.id);
    await waitFor(async () => (await sql.query("SELECT attempt FROM kletia_webhook_queue WHERE event_id=$1 AND leased_until IS NULL", [event.id])).rows[0]?.attempt === 2,
      3000, "retry scheduled");
    await (await import("../auth.js")).apiKeyStore().revoke(registered.owner.id, registered.owner.projectId, new Date().toISOString());
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      4000, "revoked retry dropped");
    assert.equal(sent, 1);
    assert.equal((await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0].body_ciphertext, null);
  });

  it("checks an agent key's ancestor expiry on a retry", async () => {
    const registered = await hook();
    const auth = await import("../auth.js");
    const child = await auth.issueAgentKey("delivery-agent", registered.owner, new Date(Date.now() + 3600_000).toISOString(), 100);
    const childHook = await (await import("../webhooks.js")).createWebhook(child.id,
      { url: `https://93.184.215.14/${hex()}`, events: ["intent.status_changed"] });
    registrations.push({ owner: child.id, id: childHook.id });
    let sent = 0;
    worker(async () => { sent += 1; return 503; });
    const event = await emit(child.id);
    await waitFor(async () => (await sql.query("SELECT attempt FROM kletia_webhook_queue WHERE event_id=$1 AND leased_until IS NULL", [event.id])).rows[0]?.attempt === 2,
      3000, "agent retry scheduled");
    await auth.apiKeyStore().setExpiry(registered.owner.id, registered.owner.projectId, new Date(Date.now() - 1000).toISOString());
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      4000, "expired lineage stopped");
    assert.equal(sent, 1);
  });

  it("continues to deliver operator-owned intents with Postgres", async () => {
    const operator = [...(await import("../auth.js")).loadOperatorKeys().values()][0];
    assert.ok(operator);
    const registered = await (await import("../webhooks.js")).createWebhook(operator.id,
      { url: `https://93.184.215.14/${hex()}`, events: ["intent.status_changed"] });
    registrations.push({ owner: operator.id, id: registered.id });
    let sent = 0;
    worker(async (_url, _body, headers) => { if (headers["kletia-webhook-id"] === registered.id) sent += 1; return 204; });
    const event = await emit(operator.id);
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1 AND webhook_id=$2", [event.id, registered.id])).rows[0]?.completed_at,
      3000, "operator event delivered");
    assert.equal(sent, 1);
  });

  it("keeps the retry budget across workers and discards exhausted payloads", async () => {
    const registered = await hook();
    const attempts: number[] = [];
    worker(async (_url, _body, headers) => { attempts.push(Number(headers["kletia-delivery-attempt"])); return 503; });
    const event = await emit(registered.owner.id);
    for (let attempt = 1; attempt < 4; attempt += 1) {
      await waitFor(async () => (await sql.query("SELECT attempt FROM kletia_webhook_queue WHERE event_id=$1 AND leased_until IS NULL", [event.id])).rows[0]?.attempt === attempt + 1,
        3000, `attempt ${attempt} persisted`);
      await sql.query("UPDATE kletia_webhook_queue SET due_at=now() WHERE event_id=$1", [event.id]);
    }
    await waitFor(async () => (await sql.query("SELECT completed_at FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0]?.completed_at,
      3000, "retry budget exhausted");
    assert.deepEqual(attempts, [1, 2, 3, 4]);
    assert.equal((await sql.query("SELECT body_ciphertext FROM kletia_webhook_queue WHERE event_id=$1", [event.id])).rows[0].body_ciphertext, null);
  });

  it("cancels queued ciphertext on webhook deletion cleanup and pruning expires tombstones", async () => {
    const request = input();
    await store.enqueue(request);
    await (await import("../deliveries.js")).deliveryStore().deleteForWebhook(request.webhookId);
    const row = (await sql.query("SELECT body_ciphertext,completed_at FROM kletia_webhook_queue WHERE event_id=$1", [request.eventId])).rows[0];
    assert.equal(row.body_ciphertext, null);
    assert.ok(row.completed_at);
    assert.equal((await store.claim(8)).length, 0);
    await store.prune(Date.now() + 8 * 86_400_000);
    assert.equal((await sql.query("SELECT count(*) FROM kletia_webhook_queue")).rows[0].count, "0");
  });
});
