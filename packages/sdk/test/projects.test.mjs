/**
 * Integrator surfaces of the client: the publishable key option and
 * `projects.*` (integrator design 4.8, built against the frozen contract;
 * the server lands with integrator-api-2), `publishable.profile`,
 * `intents.list({ limit, owner })` (P11), `keys.create(name, { sandbox })`
 * (P12) and `events.stream` (P9c).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KletiaApiError, KletiaClient } from "../dist/index.js";

const PUB = "kl_pub_0123456789ABCDEFGHIJabcdefghijkl";
const HASH = "a".repeat(64);

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-p", ...headers } });
}

function recorder(handler, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ url: new URL(url), method: init.method, headers: init.headers, body });
      return handler(new URL(url), init);
    },
  });
  return { client, calls };
}

const project = { id: "prj_1", version: 4, hash: HASH, settings: { schema: "kletia.project/v1" }, domain: { host: null, verified: false, checkedAt: null, file: "{}" }, updatedAt: "x", updatedBy: "key_1" };

test("publishableKey is sent as a bearer token; server-only methods are refused before anything is sent", async () => {
  const { client, calls } = recorder(() => jsonResponse(200, { intent: { id: "int_pub" }, profile: { projectId: "prj_1" } }), { publishableKey: PUB });
  assert.equal(client.hasApiKey, false, "no Idempotency-Keys from a browser key");
  assert.equal(client.hasPublishableKey, true);
  await client.intents.create({ text: "swap 1 SOL to USDC", accounts: [] }, { dryRun: true });
  assert.equal(calls[0].headers.authorization, `Bearer ${PUB}`);
  assert.equal(calls[0].headers["idempotency-key"], undefined);
  const profile = await client.publishable.profile();
  assert.equal(profile.projectId, "prj_1");
  assert.equal(calls[1].url.pathname, "/v1/publishable/profile");
  await client.sessions.create({ flow: "deposit", hostOrigin: "https://shop.example" });
  assert.deepEqual(calls[2].body, { flow: "deposit", hostOrigin: "https://shop.example" });

  const before = calls.length;
  for (const attempt of [
    () => client.keys.list(),
    () => client.keys.create("x"),
    () => client.webhooks.list(),
    () => client.contracts.list(),
    () => client.intents.list(5),
    () => client.usage(),
    () => client.projects.get(),
    () => client.policies.get("key_1"),
    () => client.threads.list(),
    () => client.events.stream(() => {}),
    () => client.sessions.create({ actions: [{ kind: "transfer", network: "base", amount: "1" }], allowedOrigins: ["https://shop.example"] }),
  ]) {
    await assert.rejects(attempt(), (error) => error instanceof KletiaApiError && error.code === "PUBLISHABLE_KEY_FORBIDDEN" && error.status === 0);
  }
  assert.equal(calls.length, before, "nothing was sent");
});

test("publishableKey must look like one and cannot be combined with apiKey", () => {
  assert.throws(() => new KletiaClient({ publishableKey: "kl_dev_0123456789ABCDEFGHIJabcdefghij" }), TypeError);
  assert.throws(() => new KletiaClient({ publishableKey: PUB, apiKey: "kl_dev_x" }), TypeError);
});

test("projects.get, update (If-Match), verifyDomain, createPublishableKey, setLogo and deleteLogo", async () => {
  const { client, calls } = recorder((url, init) => {
    if (url.pathname.endsWith("/publishable-keys")) return jsonResponse(201, { key: { id: "key_pub", key: PUB, label: "website", kind: "publishable", parentId: "key_1", createdAt: "x" } });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return jsonResponse(200, { project });
  }, { apiKey: "kl_dev_test" });
  assert.equal((await client.projects.get()).hash, HASH);
  assert.equal(calls[0].url.pathname, "/v1/projects/current");
  await client.projects.update({ allowedOrigins: ["https://shop.example"], brand: null }, { ifMatch: HASH });
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].headers["if-match"], `"${HASH}"`);
  assert.deepEqual(calls[1].body, { allowedOrigins: ["https://shop.example"], brand: null });
  await assert.rejects(client.projects.update({}, { ifMatch: "v4" }), TypeError);
  await client.projects.verifyDomain();
  assert.equal(calls[2].url.pathname, "/v1/projects/current/domain/verify");
  const key = await client.projects.createPublishableKey({ label: "website" });
  assert.equal(key.key, PUB);
  assert.deepEqual(calls[3].body, { label: "website" });
  assert.ok(calls[3].headers["idempotency-key"]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await client.projects.setLogo(png, "image/png");
  assert.equal(calls[4].method, "PUT");
  assert.equal(calls[4].url.pathname, "/v1/projects/current/logo");
  assert.equal(calls[4].headers["content-type"], "image/png");
  assert.deepEqual([...calls[4].body], [...png], "raw bytes, not JSON");
  await assert.rejects(client.projects.setLogo(png, "image/svg+xml"), TypeError);
  await assert.rejects(client.projects.setLogo(new Uint8Array(65_537), "image/webp"), RangeError);
  await client.projects.deleteLogo();
  assert.equal(calls[5].method, "DELETE");
});

test("a project PATCH is not retried after a failure whose outcome is unknown", async () => {
  const { client, calls } = recorder(() => jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "0" }), { apiKey: "kl_dev_test" });
  await assert.rejects(client.projects.update({ allowedOrigins: [] }, { ifMatch: HASH }));
  assert.equal(calls.length, 1);
});

test("intents.list takes a number or { limit, owner }", async () => {
  const { client, calls } = recorder(() => jsonResponse(200, { intents: [] }), { apiKey: "kl_dev_test" });
  await client.intents.list(7);
  await client.intents.list({ limit: 3 });
  await client.intents.list({ owner: "key_pub_1" });
  assert.equal(calls[0].url.searchParams.get("limit"), "7");
  assert.equal(calls[1].url.searchParams.get("limit"), "3");
  assert.equal(calls[2].url.searchParams.get("limit"), "20");
  assert.equal(calls[2].url.searchParams.get("owner"), "key_pub_1");
  await assert.rejects(client.intents.list({ limit: 0 }), RangeError);
});

test("keys.create(name, { sandbox: true }) asks for a sandbox key; without it the body is unchanged", async () => {
  const { client, calls } = recorder(() => jsonResponse(201, { key: { id: "key_s", name: "sandbox", tier: "developer", key: "kl_dev_x", lane: "testnet" } }));
  const key = await client.keys.create("sandbox", { sandbox: true });
  assert.equal(key.lane, "testnet");
  assert.deepEqual(calls[0].body, { name: "sandbox", sandbox: true });
  await client.keys.create("plain");
  assert.deepEqual(calls[1].body, { name: "plain" });
});

test("events.stream opens GET /v1/events with scope, types and Last-Event-ID and hands each envelope over", async () => {
  const frames = ['id: evt_1\ndata: {"id":"evt_1","type":"contract.registered","at":"x","data":{}}\n\n', 'id: evt_2\ndata: {"id":"evt_2","type":"link.created","at":"x","data":{}}\n\n'];
  const { client, calls } = recorder(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    { apiKey: "kl_dev_test" },
  );
  const seen = [];
  let opened = false;
  await client.events.stream((event) => seen.push(event.type), { scope: "subtree", types: ["contract.registered", "link.created"], lastEventId: "evt_0", onOpen: () => (opened = true) });
  assert.ok(opened);
  assert.deepEqual(seen, ["contract.registered", "link.created"]);
  assert.equal(calls[0].url.pathname, "/v1/events");
  assert.equal(calls[0].url.searchParams.get("scope"), "subtree");
  assert.equal(calls[0].url.searchParams.get("types"), "contract.registered,link.created");
  assert.equal(calls[0].headers["last-event-id"], "evt_0");
  assert.equal(calls[0].headers.accept, "text/event-stream");
  assert.throws(() => client.events.stream(() => {}, { types: ["bad type"] }), TypeError);

  const refused = recorder(() => jsonResponse(429, { error: { code: "TOO_MANY_STREAMS", message: "x" } }), { apiKey: "kl_dev_test" });
  await assert.rejects(refused.client.events.stream(() => {}), (error) => error.code === "TOO_MANY_STREAMS");
});
