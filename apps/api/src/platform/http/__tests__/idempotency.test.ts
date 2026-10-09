/**
 * Idempotency-Key on keyed POSTs: replay, 422 on a reused key, 409 while the
 * first request runs, explicit refusals, nothing stored for 5xx, sealed
 * storage of secrets, and the store contract (memory, plus Postgres when
 * KLETIA_TEST_DATABASE_URL is set).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { IntentGraph } from "@kletia/core";
import { configurePlatform, getIntentStore } from "../../index.js";
import { MemoryIntentStore } from "../../engine/store.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const idempotency = await import("../idempotency.js");
const { closePlatformDatabase } = await import("../db.js");

const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };

let server: TestServer;
let key: string;

async function issue(name: string): Promise<string> {
  const reply = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key.key;
}

function headers(value: string): Record<string, string> {
  return { "idempotency-key": value };
}

before(() => {
  resetEngine();
});

beforeEach(async () => {
  resetEngine();
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  key = await issue("idempotency");
});

afterEach(async () => {
  await server.close();
});

after(() => {
  configurePlatform({ adapters: null });
});

describe("Idempotency-Key", () => {
  it("stores the first response and replays it for a retry", async () => {
    const id = randomUUID();
    const first = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("idempotent-replayed"), null);
    const retry = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) });
    assert.equal(retry.status, 201, "the stored status is replayed");
    assert.equal(retry.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(retry.body.intent, first.body.intent);
    assert.notEqual(retry.headers.get("x-request-id"), first.headers.get("x-request-id"));
    const listed = await call<{ intents: IntentGraph[] }>(server, "GET", "/intents", { key });
    assert.equal(listed.body.intents.length, 1, "one intent despite two requests");
    // A structured-field string with the same token is the same key.
    const quoted = await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(`"${id}"`) });
    assert.equal(quoted.headers.get("idempotent-replayed"), "true");
  });

  it("scopes keys per API key", async () => {
    const other = await issue("other");
    const id = randomUUID();
    const mine = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) });
    const theirs = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key: other, body: SWAP, headers: headers(id) });
    assert.equal(theirs.status, 201);
    assert.equal(theirs.headers.get("idempotent-replayed"), null);
    assert.notEqual(theirs.body.intent.id, mine.body.intent.id);
  });

  it("refuses a reused key with a different request (422) and an in-flight duplicate (409)", async () => {
    const id = randomUUID();
    await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) });
    const reused = assertError(
      await call(server, "POST", "/intents", { key, body: { ...SWAP, text: "swap 2 SOL to USDC" }, headers: headers(id) }),
      422,
      "IDEMPOTENCY_KEY_REUSED",
    );
    assert.equal(reused.error.issues?.[0]?.path, "Idempotency-Key");
    assertError(await call(server, "POST", "/intents?dryRun=false&x=1", { key, body: SWAP, headers: headers(id) }), 422, "IDEMPOTENCY_KEY_REUSED");

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowStore extends MemoryIntentStore {
      override async create(graph: IntentGraph, meta: { ownerKeyId?: string }): Promise<void> {
        await gate;
        return super.create(graph, meta);
      }
    }
    configurePlatform({ store: new SlowStore() });
    const slowId = randomUUID();
    const pending = call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP, headers: headers(slowId) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(slowId) });
    assertError(busy, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS");
    assert.equal(busy.headers.get("retry-after"), "1");
    release();
    const done = await pending;
    assert.equal(done.status, 201);
    const replay = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP, headers: headers(slowId) });
    assert.equal(replay.body.intent.id, done.body.intent.id);
  });

  it("never stores 5xx outcomes, so a retry runs again", async () => {
    class BrokenStore extends MemoryIntentStore {
      override async create(): Promise<void> {
        throw new Error("database exploded");
      }
    }
    const original = console.error;
    console.error = () => undefined;
    const id = randomUUID();
    try {
      configurePlatform({ store: new BrokenStore() });
      assertError(await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) }), 500, "INTERNAL_ERROR");
    } finally {
      console.error = original;
    }
    resetEngine();
    const retry = await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(id) });
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get("idempotent-replayed"), null);
  });

  it("stores final client errors and replays them", async () => {
    const id = randomUUID();
    const body = { text: "make me rich quickly", accounts: ACCOUNTS };
    assertError(await call(server, "POST", "/intents", { key, body, headers: headers(id) }), 422, "INTENT_UNSUPPORTED");
    const replay = assertError(await call(server, "POST", "/intents", { key, body, headers: headers(id) }), 422, "INTENT_UNSUPPORTED");
    assert.ok(replay.error.hints && replay.error.hints.length > 0);
  });

  it("covers cancel and submit, ignores dry runs, and refuses prepare and the public tier", async () => {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
    const intentId = created.body.intent.id;
    const cancelKey = randomUUID();
    const cancelled = await call<{ intent: IntentGraph }>(server, "POST", `/intents/${intentId}/cancel`, { key, headers: headers(cancelKey) });
    assert.equal(cancelled.status, 200);
    const again = await call<{ intent: IntentGraph }>(server, "POST", `/intents/${intentId}/cancel`, { key, headers: headers(cancelKey) });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(again.body.intent, cancelled.body.intent, "the stored response, not a fresh read");
    assertError(await call(server, "POST", `/intents/${intentId}/cancel`, { key, headers: headers(cancelKey), body: { reason: "x" } }), 422, "IDEMPOTENCY_KEY_REUSED");

    const dryKey = randomUUID();
    const dry = await call(server, "POST", "/intents?dryRun=true", { key, body: SWAP, headers: headers(dryKey) });
    const dryAgain = await call(server, "POST", "/intents?dryRun=true", { key, body: SWAP, headers: headers(dryKey) });
    assert.equal(dry.status, 200);
    assert.equal(dryAgain.headers.get("idempotent-replayed"), null, "dry runs are never stored");

    const fresh = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
    assertError(
      await call(server, "POST", `/intents/${fresh.body.intent.id}/steps/s1/prepare`, { key, headers: headers(randomUUID()) }),
      400,
      "IDEMPOTENCY_NOT_SUPPORTED",
    );
    assertError(await call(server, "POST", "/intents", { body: SWAP, headers: headers(randomUUID()) }), 400, "IDEMPOTENCY_KEY_REQUIRES_API_KEY");
    for (const bad of ["", "has space", "x".repeat(129), "\"unterminated", "a,b", "\"\""]) {
      assertError(await call(server, "POST", "/intents", { key, body: SWAP, headers: headers(bad) }), 400, "IDEMPOTENCY_KEY_INVALID");
    }
    assert.equal(getIntentStore().kind, "memory");
  });

  it("replays secrets only from sealed storage", async () => {
    const id = randomUUID();
    const first = await call<{ webhook: { id: string; secret: string } }>(server, "POST", "/webhooks", {
      key,
      body: { url: "https://93.184.215.14/idempotent" },
      headers: headers(id),
    });
    assert.equal(first.status, 201);
    const replay = await call<{ webhook: { id: string; secret: string } }>(server, "POST", "/webhooks", {
      key,
      body: { url: "https://93.184.215.14/idempotent" },
      headers: headers(id),
    });
    assert.equal(replay.status, 201, "replayed instead of 409 WEBHOOK_EXISTS");
    assert.equal(replay.body.webhook.secret, first.body.webhook.secret);
    const stored = JSON.stringify([...(idempotency.idempotencyStore() as unknown as { entries: Map<string, unknown> }).entries.values()]);
    assert.ok(!stored.includes(first.body.webhook.secret), "the webhook secret is not stored in clear");

    const rotateKey = randomUUID();
    const keys = await call<{ keys: { id: string }[] }>(server, "GET", "/keys", { key });
    const keyId = keys.body.keys[0]?.id ?? "";
    const rotated = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, { key, body: { graceSeconds: 60 }, headers: headers(rotateKey) });
    assert.equal(rotated.status, 200);
    const rotatedAgain = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, {
      key: rotated.body.key.key,
      body: { graceSeconds: 60 },
      headers: headers(rotateKey),
    });
    assert.equal(rotatedAgain.headers.get("idempotent-replayed"), "true");
    assert.equal(rotatedAgain.body.key.key, rotated.body.key.key, "a retried rotation returns the same new secret instead of rotating twice");
    // The rotated-out secret made the webhook request, so it may replay it; it never gets what the current secret created.
    const ownWebhook = await call<{ webhook: { secret: string } }>(server, "POST", "/webhooks", { key, body: { url: "https://93.184.215.14/idempotent" }, headers: headers(id) });
    assert.equal(ownWebhook.status, 201);
    assert.equal(ownWebhook.body.webhook.secret, first.body.webhook.secret);
    const currentId = randomUUID();
    const current = await call(server, "POST", "/webhooks", { key: rotated.body.key.key, body: { url: "https://93.184.215.14/current" }, headers: headers(currentId) });
    assert.equal(current.status, 201);
    assertError(
      await call(server, "POST", "/webhooks", { key, body: { url: "https://93.184.215.14/current" }, headers: headers(currentId) }),
      403,
      "KEY_SECRET_ROTATED",
    );
    const storedKeys = JSON.stringify([...(idempotency.idempotencyStore() as unknown as { entries: Map<string, unknown> }).entries.values()]);
    assert.ok(!storedKeys.includes(rotated.body.key.key), "API keys are not stored in clear");
    assert.ok(!storedKeys.includes(key), "secrets are not stored in clear");
  });

  it("replays a lost self-rotation to the secret that made it, and to no other rotated-out secret", async () => {
    const keys = await call<{ keys: { id: string }[] }>(server, "GET", "/keys", { key });
    const keyId = keys.body.keys[0]?.id ?? "";
    // The key rotates itself; the response is lost and the client retries with the only secret it has.
    const retryKey = randomUUID();
    const rotated = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, { key, body: { graceSeconds: 60 }, headers: headers(retryKey) });
    assert.equal(rotated.status, 200);
    const recovered = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, { key, body: { graceSeconds: 60 }, headers: headers(retryKey) });
    assert.equal(recovered.status, 200, "the old secret that made the request recovers the new secret");
    assert.equal(recovered.headers.get("idempotent-replayed"), "true");
    assert.equal(recovered.body.key.key, rotated.body.key.key, "the same new secret, not a second rotation");
    // The recovered secret works and manages keys again.
    assert.equal((await call(server, "GET", "/keys", { key: recovered.body.key.key })).status, 200);

    // Rotate again with the second secret: it becomes the rotated-out secret, and the first one stops authenticating.
    const second = recovered.body.key.key;
    const third = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, { key: second, body: { graceSeconds: 60 } });
    assert.equal(third.status, 200);
    assertError(
      await call(server, "POST", `/keys/${keyId}/rotate`, { key: second, body: { graceSeconds: 60 }, headers: headers(retryKey) }),
      403,
      "KEY_SECRET_ROTATED",
    );
    assertError(await call(server, "POST", `/keys/${keyId}/rotate`, { key, body: { graceSeconds: 60 }, headers: headers(retryKey) }), 401, "INVALID_API_KEY");
    const current = await call<{ key: { key: string } }>(server, "POST", `/keys/${keyId}/rotate`, { key: third.body.key.key, body: { graceSeconds: 60 }, headers: headers(retryKey) });
    assert.equal(current.status, 200, "the current secret still gets the replay");
    assert.equal(current.body.key.key, rotated.body.key.key);
  });
});

/* ------------------------------------------------------------ store contract */

function contract(name: string, make: () => import("../idempotency.js").IdempotencyStore): void {
  describe(`${name} idempotency store`, () => {
    const owner = `key_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
    const request = (key: string, fingerprint = "f1") => ({ owner, key, fingerprint, method: "POST", route: "POST /intents" });

    it("reserves once, reports in-progress, mismatch and replay", async () => {
      const store = make();
      const now = Date.now();
      const begun = await store.begin(request("a"), now);
      assert.equal(begun.state, "acquired");
      assert.equal((await store.begin(request("a"), now)).state, "in_progress");
      assert.equal((await store.begin(request("a", "f2"), now)).state, "mismatch");
      if (begun.state !== "acquired") return;
      await store.complete(owner, "a", begun.token, { status: 201, kind: "json", body: "{\"ok\":true}" });
      const replay = await store.begin(request("a"), now);
      assert.deepEqual(replay, { state: "replay", response: { status: 201, kind: "json", body: "{\"ok\":true}" } });
    });

    it("keeps the presenter of a stored secret-bearing response and drops it on takeover", async () => {
      const store = make();
      const now = Date.now();
      const begun = await store.begin(request("p"), now);
      assert.equal(begun.state, "acquired");
      if (begun.state !== "acquired") return;
      await store.complete(owner, "p", begun.token, { status: 200, kind: "sealed", body: "sealed-body", presenter: "presenter-hash" });
      assert.deepEqual(await store.begin(request("p"), now), {
        state: "replay",
        response: { status: 200, kind: "sealed", body: "sealed-body", presenter: "presenter-hash" },
      });
      const expired = now + idempotency.IDEMPOTENCY_TTL_MS + 1;
      const again = await store.begin(request("p"), expired);
      assert.equal(again.state, "acquired");
      if (again.state !== "acquired") return;
      await store.complete(owner, "p", again.token, { status: 200, kind: "sealed", body: "other" });
      assert.deepEqual(await store.begin(request("p"), expired), { state: "replay", response: { status: 200, kind: "sealed", body: "other" } });
    });

    it("releases unfinished reservations and ignores stale tokens", async () => {
      const store = make();
      const now = Date.now();
      const first = await store.begin(request("b"), now);
      assert.equal(first.state, "acquired");
      if (first.state !== "acquired") return;
      await store.release(owner, "b", "not-the-token");
      assert.equal((await store.begin(request("b"), now)).state, "in_progress");
      await store.release(owner, "b", first.token);
      const second = await store.begin(request("b"), now);
      assert.equal(second.state, "acquired");
      // The first request finishing late must not overwrite the new reservation.
      await store.complete(owner, "b", first.token, { status: 500, kind: "empty", body: "" });
      assert.equal((await store.begin(request("b"), now)).state, "in_progress");
    });

    it("takes over an abandoned reservation after its lock and forgets expired entries", async () => {
      const store = make();
      const now = Date.now();
      assert.equal((await store.begin(request("c"), now)).state, "acquired");
      assert.equal((await store.begin(request("c"), now + idempotency.IDEMPOTENCY_LOCK_MS + 1)).state, "acquired");
      assert.equal((await store.begin(request("c", "other"), now + idempotency.IDEMPOTENCY_LOCK_MS + 2)).state, "mismatch");
      const later = now + idempotency.IDEMPOTENCY_TTL_MS + idempotency.IDEMPOTENCY_LOCK_MS + 10;
      assert.equal((await store.begin(request("c", "other"), later)).state, "acquired", "an expired key can be reused");
      const removed = await store.prune(later + idempotency.IDEMPOTENCY_TTL_MS + 1);
      assert.ok(removed >= 1);
    });
  });
}

contract("memory", () => new idempotency.MemoryIdempotencyStore());

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
    contract("postgres", () => new idempotency.PostgresIdempotencyStore());
  });
} else {
  describe("postgres idempotency store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
