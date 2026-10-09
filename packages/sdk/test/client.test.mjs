import assert from "node:assert/strict";
import test from "node:test";
import {
  KletiaApiError,
  KletiaClient,
  executeIntent,
  isKletiaError,
  retryClass,
} from "../dist/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers },
  });
}

const failure = (status, code, headers = { "retry-after": "0" }) => () =>
  jsonResponse(status, { error: { code, message: code } }, headers);

/** A client whose fetch answers from `script` in order (the last entry repeats) and records each call. */
function scripted(script, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return step(url, init);
    },
  });
  return { client, calls };
}

const intentBody = (id = "int_1", status = "planned") => ({ intent: { id, status, updatedAt: "2026-10-09T00:00:00.000Z", steps: [] } });
const ok = (body) => () => jsonResponse(200, body);

test("retryClass separates safe, idempotent, unsafe and prepare requests", () => {
  assert.equal(retryClass("GET", "/intents/int_1"), "safe");
  assert.equal(retryClass("DELETE", "/webhooks/wh_1"), "safe");
  assert.equal(retryClass("POST", "/quotes"), "safe");
  assert.equal(retryClass("POST", "/intents/int_1/refresh"), "safe");
  assert.equal(retryClass("POST", "/intents", { dryRun: "true" }), "safe");
  assert.equal(retryClass("POST", "/intents?dryRun=1"), "safe");
  assert.equal(retryClass("POST", "/intents"), "idempotent");
  assert.equal(retryClass("POST", "/intents/int_1/cancel"), "idempotent");
  assert.equal(retryClass("POST", "/intents/int_1/steps/s1/submit"), "idempotent");
  assert.equal(retryClass("POST", "/webhooks"), "idempotent");
  assert.equal(retryClass("POST", "/keys"), "idempotent");
  assert.equal(retryClass("POST", "/keys/key_1/rotate"), "idempotent");
  assert.equal(retryClass("POST", "/intents/int_1/steps/s1/prepare"), "prepare");
  assert.equal(retryClass("POST", "/intents/int_1/steps/s1/prepare/"), "prepare");
  assert.equal(retryClass("POST", "/Intents/int_1/Steps/s1/PREPARE"), "prepare");
  assert.equal(retryClass("POST", "/intents/int_1/steps/s1/%70repare"), "prepare");
  assert.equal(retryClass("POST", "/webhooks/wh_1/test"), "unsafe");
  assert.equal(retryClass("POST", "/mcp"), "unsafe");
});

test("GET is retried on 503 and network errors, honouring Retry-After", async () => {
  let thrown = 0;
  const { client, calls } = scripted([
    failure(503, "STORE_UNAVAILABLE"),
    () => {
      thrown += 1;
      throw new TypeError("fetch failed");
    },
    ok(intentBody()),
  ]);
  const intent = await client.intents.get("int_1");
  assert.equal(intent.id, "int_1");
  assert.equal(calls.length, 3);
  assert.equal(thrown, 1);
  assert.ok(calls.every((call) => call.headers["idempotency-key"] === undefined));
});

test("GET is not retried on a final error, and maxRetries: 0 disables retries", async () => {
  const notFound = scripted([failure(404, "INTENT_NOT_FOUND", {})]);
  await assert.rejects(notFound.client.intents.get("int_x"), (error) => error.code === "INTENT_NOT_FOUND");
  assert.equal(notFound.calls.length, 1);
  const unavailable = scripted([failure(503, "STORE_UNAVAILABLE")], { maxRetries: 0 });
  await assert.rejects(unavailable.client.networks());
  assert.equal(unavailable.calls.length, 1);
});

test("a Retry-After longer than 60 s is returned, not waited for", async () => {
  const { client, calls } = scripted([failure(429, "RATE_LIMITED", { "retry-after": "120" })]);
  await assert.rejects(client.networks(), (error) => error.code === "RATE_LIMITED" && error.retryAfterSeconds === 120);
  assert.equal(calls.length, 1);
});

test("keyed POST /intents carries one generated Idempotency-Key across retries", async () => {
  const { client, calls } = scripted(
    [
      failure(503, "STORE_UNAVAILABLE"),
      () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      () => jsonResponse(201, intentBody("int_new")),
    ],
    { apiKey: "kl_dev_test" },
  );
  const intent = await client.intents.create({ text: "swap 1 SOL to USDC", accounts: [] });
  assert.equal(intent.id, "int_new");
  assert.equal(calls.length, 3);
  const keys = calls.map((call) => call.headers["idempotency-key"]);
  assert.match(keys[0], UUID);
  assert.ok(keys.every((key) => key === keys[0]), "the same key on every attempt");
  assert.equal(calls[0].headers.authorization, "Bearer kl_dev_test");
});

test("a 409 IDEMPOTENCY_REQUEST_IN_PROGRESS is retried with the same key", async () => {
  const { client, calls } = scripted(
    [failure(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS"), () => jsonResponse(201, intentBody("int_replayed"), { "idempotent-replayed": "true" })],
    { apiKey: "kl_dev_test" },
  );
  const intent = await client.intents.create({ text: "x", accounts: [] }, { idempotencyKey: "order-1029" });
  assert.equal(intent.id, "int_replayed");
  assert.deepEqual(calls.map((call) => call.headers["idempotency-key"]), ["order-1029", "order-1029"]);
});

test("public-tier state-changing POSTs carry no key and are never retried", async () => {
  const { client, calls } = scripted([failure(503, "STORE_UNAVAILABLE"), () => jsonResponse(201, intentBody())]);
  await assert.rejects(client.intents.create({ text: "x", accounts: [] }), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"], undefined);
  // A transport failure is just as ambiguous: still one attempt.
  const network = scripted([() => { throw new TypeError("fetch failed"); }]);
  await assert.rejects(network.client.intents.cancel("int_1"), (error) => error.code === "NETWORK_ERROR" && error.retryable);
  assert.equal(network.calls.length, 1);
});

test("dry runs and quotes are retried without a key", async () => {
  const { client, calls } = scripted([failure(502, "RELAY_UNAVAILABLE"), ok(intentBody())], { apiKey: "kl_dev_test" });
  await client.intents.create({ text: "x", accounts: [] }, { dryRun: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/v1/intents?dryRun=true"));
  assert.equal(calls[0].headers["idempotency-key"], undefined);
  const quotes = scripted([failure(504, "UPSTREAM_TIMEOUT"), ok({ routes: [], best: null, quotedAt: "", unavailable: [] })]);
  await quotes.client.quote({ from: { network: "base", asset: "USDC", amount: "1" }, to: { network: "base", asset: "ETH" } });
  assert.equal(quotes.calls.length, 2);
});

test("prepare is never retried and never carries an Idempotency-Key", async () => {
  const { client, calls } = scripted([failure(503, "STORE_UNAVAILABLE")], { apiKey: "kl_dev_test", maxRetries: 5 });
  await assert.rejects(client.intents.prepareStep("int_1", "s1"), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"], undefined);
  // Not even when asked through the low-level helper.
  await assert.rejects(client.request("POST", "/intents/int_1/steps/s1/prepare", {}, { maxRetries: 3 }));
  assert.equal(calls.length, 2);
  await assert.rejects(
    client.request("POST", "/intents/int_1/steps/s1/prepare", {}, { idempotencyKey: "k1" }),
    (error) => error instanceof TypeError && /never retried/u.test(error.message),
  );
  assert.equal(calls.length, 2, "refused before any request");
});

test("idempotencyKey: false sends no key and disables retries of that POST", async () => {
  const { client, calls } = scripted([failure(503, "STORE_UNAVAILABLE")], { apiKey: "kl_dev_test" });
  await assert.rejects(client.intents.cancel("int_1", { idempotencyKey: false }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"], undefined);
});

test("webhook tests are not retried; deleting a webhook tolerates a 404 after a lost response", async () => {
  const tests = scripted([failure(503, "STORE_UNAVAILABLE")], { apiKey: "kl_dev_test" });
  await assert.rejects(tests.client.webhooks.test("wh_1"));
  assert.equal(tests.calls.length, 1);

  const deletion = scripted([() => { throw new TypeError("socket hang up"); }, failure(404, "WEBHOOK_NOT_FOUND", {})], { apiKey: "kl_dev_test" });
  await deletion.client.webhooks.delete("wh_1");
  assert.equal(deletion.calls.length, 2);
  assert.ok(deletion.calls.every((call) => call.method === "DELETE"));
  // A first-attempt 404 is still an error.
  const missing = scripted([failure(404, "WEBHOOK_NOT_FOUND", {})], { apiKey: "kl_dev_test" });
  await assert.rejects(missing.client.webhooks.delete("wh_1"), (error) => error.code === "WEBHOOK_NOT_FOUND");
});

test("a generated key refused with IDEMPOTENCY_NOT_SUPPORTED is dropped once, without further retries", async () => {
  const { client, calls } = scripted(
    [failure(400, "IDEMPOTENCY_NOT_SUPPORTED", {}), failure(503, "STORE_UNAVAILABLE")],
    { apiKey: "kl_dev_test" },
  );
  await assert.rejects(client.keys.create("ci"), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers["idempotency-key"], UUID);
  assert.equal(calls[1].headers["idempotency-key"], undefined);
  // A key the caller chose is never dropped silently.
  const explicit = scripted([failure(400, "IDEMPOTENCY_NOT_SUPPORTED", {})], { apiKey: "kl_dev_test" });
  await assert.rejects(explicit.client.keys.create("ci", { idempotencyKey: "mine" }), (error) => error.code === "IDEMPOTENCY_NOT_SUPPORTED");
  assert.equal(explicit.calls.length, 1);
});

test("aborting during a backoff stops retrying with REQUEST_ABORTED", async () => {
  const controller = new AbortController();
  const { client, calls } = scripted([
    () => {
      setTimeout(() => controller.abort(new Error("stop")), 5);
      return jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "30" });
    },
  ]);
  await assert.rejects(
    client.networks({ signal: controller.signal }),
    (error) => error instanceof KletiaApiError && error.code === "REQUEST_ABORTED" && !error.retryable,
  );
  assert.equal(calls.length, 1);
});

test("errors carry catalog codes, categories, docs links and catalog retryability", async () => {
  const { client } = scripted([
    () => jsonResponse(502, { error: { code: "RELAY_UNAVAILABLE", message: "down", docs: "https://example.test/developers#error-PROVIDER_UNAVAILABLE" } }),
  ], { maxRetries: 0 });
  const error = await client.networks().catch((caught) => caught);
  assert.ok(isKletiaError(error));
  assert.ok(isKletiaError(error, "RELAY_UNAVAILABLE"));
  assert.ok(isKletiaError(error, "PROVIDER_UNAVAILABLE"), "provider codes match their family");
  assert.ok(!isKletiaError(error, "RATE_LIMITED"));
  assert.ok(!isKletiaError(new Error("x")));
  assert.equal(error.category, "upstream");
  assert.equal(error.retryable, true);
  assert.equal(error.docsUrl, "https://example.test/developers#error-PROVIDER_UNAVAILABLE");

  const conflict = new KletiaApiError({ code: "INTENT_CONFLICT", message: "x", status: 409 });
  assert.equal(conflict.retryable, true, "catalog: retryable 409");
  assert.equal(conflict.category, "conflict");
  assert.equal(conflict.docsUrl, "https://kletiaai.xyz/developers#error-INTENT_CONFLICT");
  assert.equal(new KletiaApiError({ code: "QUOTE_MOVED", message: "x", status: 409 }).retryable, false);
  assert.equal(new KletiaApiError({ code: "PROVIDER_TRANSACTION_INVALID", message: "x", status: 502 }).retryable, false, "catalog overrides status");
  const unknown = new KletiaApiError({ code: "SOMETHING_NEW", message: "x", status: 503, docs: "javascript:alert(1)" });
  assert.equal(unknown.retryable, true);
  assert.equal(unknown.category, "unavailable");
  assert.equal(unknown.docsUrl, null, "only https docs links are kept");
  assert.equal(new KletiaApiError({ code: "NETWORK_ERROR", message: "x", status: 0 }).category, "network");
});

test("a catalogued non-retryable 5xx code is not retried", async () => {
  const { client, calls } = scripted([failure(502, "PROVIDER_TRANSACTION_INVALID")]);
  await assert.rejects(client.networks());
  assert.equal(calls.length, 1);
});

test("key, usage, webhook and error methods call the documented routes", async () => {
  const seen = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    apiKey: "kl_dev_test",
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      seen.push(`${init.method} ${pathname}${search}${init.body ? ` ${init.body}` : ""}`);
      if (pathname === "/v1/keys" && init.method === "GET") return jsonResponse(200, { keys: [{ id: "key_1", current: true }] });
      if (pathname.endsWith("/rotate")) return jsonResponse(200, { key: { id: "key_1", key: "kl_dev_new", previousExpiresAt: null } });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (pathname.endsWith("/test")) return jsonResponse(200, { delivery: { id: "dl_1", status: "failed", httpStatus: 405, test: true } });
      if (pathname.endsWith("/deliveries")) return jsonResponse(200, { deliveries: [{ id: "dl_1" }] });
      if (pathname === "/v1/usage") return jsonResponse(200, { keyId: "key_1", window: "7d" });
      if (pathname === "/v1/errors") return jsonResponse(200, { errors: [{ code: "RATE_LIMITED" }], families: [] });
      if (pathname === "/v1/venues") return jsonResponse(200, { venues: [{ venue: "base:aave-v3:usdc", supplyApy: 0.043 }], unavailable: [] });
      throw new Error(`unexpected ${pathname}`);
    },
  });
  assert.equal((await client.keys.list())[0].current, true);
  assert.equal((await client.keys.rotate("key_1", { graceSeconds: 0 })).key, "kl_dev_new");
  await client.keys.rotate("key_1");
  await client.keys.revoke("key_1");
  assert.equal((await client.webhooks.test("wh_1")).httpStatus, 405);
  assert.equal((await client.webhooks.deliveries("wh_1", { limit: 5 }))[0].id, "dl_1");
  assert.equal((await client.usage({ window: "7d" })).window, "7d");
  assert.equal((await client.errors()).errors[0].code, "RATE_LIMITED");
  assert.equal((await client.venues({ network: "base", protocol: "aave-v3" })).venues[0].venue, "base:aave-v3:usdc");
  await client.venues();
  assert.deepEqual(seen, [
    "GET /v1/keys",
    'POST /v1/keys/key_1/rotate {"graceSeconds":0}',
    "POST /v1/keys/key_1/rotate {}",
    "DELETE /v1/keys/key_1",
    "POST /v1/webhooks/wh_1/test {}",
    "GET /v1/webhooks/wh_1/deliveries?limit=5",
    "GET /v1/usage?window=7d",
    "GET /v1/errors",
    "GET /v1/venues?network=base&protocol=aave-v3",
    "GET /v1/venues",
  ]);
});

test("executeIntent reuses one Idempotency-Key per submission and does not nest retries", async () => {
  const account = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
  let stepStatus = "ready";
  const graph = () => ({
    spec: "kletia.intent/v1", id: "int_keyed", status: stepStatus === "settled" ? "completed" : "executing", updatedAt: "2026-10-09T00:00:00.000Z",
    steps: [{ id: "s1", index: 0, kind: "swap", title: "Swap", network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account, protocol: "jupiter", mode: "wallet", dependsOn: [], status: stepStatus, evidence: [] }],
  });
  const submits = [];
  const prepares = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    apiKey: "kl_dev_test",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      if (url.endsWith("/prepare")) {
        prepares.push(init.headers["idempotency-key"]);
        stepStatus = "awaiting_signature";
        return jsonResponse(200, { intent: graph(), payload: { vm: "svm", transactions: [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "swap" }], expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "x" } });
      }
      if (url.endsWith("/submit")) {
        submits.push(init.headers["idempotency-key"]);
        if (submits.length < 3) return jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "0" });
        stepStatus = "settled";
        return jsonResponse(200, { intent: graph() });
      }
      throw new Error(url);
    },
  });
  const solana = { address: SOL, async signAndSendTransaction() { return "5".repeat(88); } };
  const final = await executeIntent(client, graph(), { solana });
  assert.equal(final.status, "completed");
  assert.deepEqual(prepares, [undefined]);
  assert.equal(submits.length, 3, "executeIntent's own three attempts, not 3 x 3");
  assert.match(submits[0], UUID);
  assert.ok(submits.every((key) => key === submits[0]));
});

/* ----------------------------------------------------------------- wait */

const frame = (event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const evt = (n, type, data) => ({ id: `evt_${String(n).padStart(32, "0")}`, type, at: "2026-10-09T00:00:00.000Z", data: { intentId: "int_w", ...data } });

function sseResponse(frames, { close = false, signal } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      for (const text of frames) controller.enqueue(encoder.encode(text));
      if (close) controller.close();
      signal?.addEventListener("abort", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("intents.wait follows the stream, resumes with Last-Event-ID and resolves at a terminal status", async () => {
  let version = 0;
  const statuses = ["executing", "settling", "completed"];
  const streams = [];
  const reads = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith("/events")) {
        streams.push(init.headers["last-event-id"] ?? null);
        if (streams.length === 1) return sseResponse([frame(evt(1, "intent.created", {}))], { close: true });
        version = 2;
        return sseResponse([frame(evt(2, "intent.status_changed", { status: "completed", previous: "settling" }))], { signal: init.signal });
      }
      reads.push(`${init.method} ${pathname}`);
      if (pathname === "/v1/intents/int_w") {
        const status = statuses[Math.min(version, 2)];
        if (version === 0) version = 1;
        return jsonResponse(200, { intent: { id: "int_w", status, updatedAt: `2026-10-09T00:00:0${version}.000Z`, steps: [] } });
      }
      throw new Error(pathname);
    },
  });
  const updates = [];
  const events = [];
  const final = await client.intents.wait("int_w", {
    onUpdate: (intent) => updates.push(intent.status),
    onEvent: (event) => events.push(event.type),
    pollIntervalMs: 60_000,
  });
  assert.equal(final.status, "completed");
  assert.deepEqual(streams, [null, evt(1).id], "reconnected after the stream ended, resuming after the last event");
  assert.deepEqual(events, ["intent.created", "intent.status_changed"]);
  assert.equal(updates.at(-1), "completed");
  assert.ok(reads.every((read) => read === "GET /v1/intents/int_w"));
});

test("intents.wait polls refresh while streams are refused and stops at the terminal status", async () => {
  let refreshes = 0;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith("/events")) return jsonResponse(429, { error: { code: "TOO_MANY_STREAMS", message: "x" } }, { "retry-after": "30" });
      if (pathname.endsWith("/refresh")) {
        refreshes += 1;
        const status = refreshes >= 2 ? "completed" : "settling";
        return jsonResponse(200, { intent: { id: "int_p", status, updatedAt: `2026-10-09T00:00:0${refreshes}.000Z`, steps: [{ id: "s1", status: status === "completed" ? "settled" : "settling", evidence: [] }] } });
      }
      return jsonResponse(200, { intent: { id: "int_p", status: "settling", updatedAt: "2026-10-09T00:00:00.000Z", steps: [{ id: "s1", status: "settling", evidence: [] }] } });
    },
  });
  const transports = [];
  const final = await client.intents.wait("int_p", { pollIntervalMs: 250, onTransport: (mode) => transports.push(mode) });
  assert.equal(final.status, "completed");
  assert.equal(refreshes, 2);
  assert.deepEqual(transports, ["poll"]);
});

test("intents.wait rejects for an unknown intent and times out with WAIT_TIMEOUT", async () => {
  const missing = new KletiaClient({ baseUrl: "http://localhost:3001", fetch: async () => jsonResponse(404, { error: { code: "INTENT_NOT_FOUND", message: "x" } }) });
  await assert.rejects(missing.intents.wait("int_none"), (error) => error.code === "INTENT_NOT_FOUND");
  const stuck = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) =>
      url.endsWith("/events")
        ? sseResponse([], { signal: init.signal })
        : jsonResponse(200, { intent: { id: "int_s", status: "planned", updatedAt: "2026-10-09T00:00:00.000Z", steps: [] } }),
  });
  await assert.rejects(stuck.intents.wait("int_s", { timeoutMs: 50 }), (error) => error.code === "WAIT_TIMEOUT");
  const controller = new AbortController();
  const waiting = stuck.intents.wait("int_s", { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === "REQUEST_ABORTED");
});

test("intents.stream passes callback errors through unchanged and closes the connection", async () => {
  let cancelled = false;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(frame(evt(1, "intent.created", {}))));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const failure = new Error("consumer bug");
  await assert.rejects(client.intents.stream("int_w", () => { throw failure; }), (error) => error === failure);
  assert.equal(cancelled, true);
  // A dropped connection is a retryable NETWORK_ERROR.
  const dropping = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async () =>
      new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("terminated")); } }), { status: 200 }),
  });
  await assert.rejects(dropping.intents.stream("int_w", () => undefined), (error) => error.code === "NETWORK_ERROR" && error.retryable);
});
