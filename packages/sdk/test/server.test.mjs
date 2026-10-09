import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  KletiaWebhookError,
  constructWebhookEvent,
  createWebhookHandler,
  expressWebhookHandler,
  honoWebhookHandler,
  memoryDeduplication,
  signWebhookPayload,
} from "../dist/server/index.js";

const SECRET = "whsec_0123456789abcdefghijklmnopqrstuv";
const OLD_SECRET = "whsec_previousSecretpreviousSecret00";
const EVENT = {
  id: "evt_0123456789abcdef0123456789abcdef",
  type: "intent.status_changed",
  at: "2026-10-09T12:00:00.000Z",
  data: { intentId: "int_1", status: "completed", previous: "settling" },
};
const BODY = JSON.stringify(EVENT);

async function signed(body = BODY, secret = SECRET, timestamp) {
  return signWebhookPayload(secret, body, timestamp);
}

async function deliveryRequest({ body = BODY, secret = SECRET, headers = {}, method = "POST" } = {}) {
  return new Request("https://example.test/webhooks/kletia", {
    method,
    headers: {
      "content-type": "application/json",
      "kletia-signature": await signed(body, secret),
      "kletia-event-id": EVENT.id,
      "kletia-webhook-id": "wh_1",
      "kletia-delivery-attempt": "2",
      ...headers,
    },
    ...(method === "POST" ? { body } : {}),
  });
}

const rejectsWith = (reason) => (error) => error instanceof KletiaWebhookError && error.reason === reason;

test("constructWebhookEvent verifies strings, Buffers and secret lists", async () => {
  const header = await signed();
  assert.deepEqual(await constructWebhookEvent(BODY, header, SECRET), EVENT);
  assert.deepEqual(await constructWebhookEvent(Buffer.from(BODY), [header], SECRET), EVENT);
  assert.deepEqual(await constructWebhookEvent(new TextEncoder().encode(BODY).buffer, header, [OLD_SECRET, SECRET]), EVENT);
  // Signed with the previous secret, during a rotation.
  assert.deepEqual(await constructWebhookEvent(BODY, await signed(BODY, OLD_SECRET), [SECRET, OLD_SECRET]), EVENT);
});

test("constructWebhookEvent fails closed with a reason", async () => {
  const header = await signed();
  await assert.rejects(constructWebhookEvent(BODY, header, "whsec_wrong"), rejectsWith("mismatch"));
  await assert.rejects(constructWebhookEvent(`${BODY} `, header, SECRET), rejectsWith("mismatch"));
  await assert.rejects(constructWebhookEvent(BODY, undefined, SECRET), rejectsWith("malformed"));
  await assert.rejects(constructWebhookEvent(BODY, "t=1,v1=zz", SECRET), rejectsWith("malformed"));
  await assert.rejects(constructWebhookEvent(BODY, await signed(BODY, SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET), rejectsWith("expired"));
  await assert.rejects(constructWebhookEvent(EVENT, header, SECRET), rejectsWith("parsed_body"));
  await assert.rejects(constructWebhookEvent(BODY, header, []), rejectsWith("missing_secret"));
  await assert.rejects(constructWebhookEvent(BODY, header, ""), rejectsWith("missing_secret"));
  await assert.rejects(constructWebhookEvent(BODY, header, SECRET, { eventIdHeader: "evt_other" }), rejectsWith("header_mismatch"));
  const notEnvelope = JSON.stringify({ hello: "world" });
  await assert.rejects(constructWebhookEvent(notEnvelope, await signed(notEnvelope), SECRET), rejectsWith("invalid_body"));
  const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
  await assert.rejects(constructWebhookEvent(invalidUtf8, header, SECRET), rejectsWith("invalid_body"));
});

test("createWebhookHandler round-trips a signed delivery and de-duplicates by event id", async () => {
  const received = [];
  const handler = createWebhookHandler({
    secret: SECRET,
    onEvent: (event, context) => {
      received.push({ type: event.type, intentId: event.data.intentId, context });
    },
    ...memoryDeduplication(),
  });
  const first = await handler(await deliveryRequest());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true });
  const again = await handler(await deliveryRequest());
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { received: true, duplicate: true });
  assert.deepEqual(received, [{ type: "intent.status_changed", intentId: "int_1", context: { webhookId: "wh_1", attempt: 2 } }]);
});

test("createWebhookHandler answers 400, 405, 413 and 500 without calling onEvent wrongly", async () => {
  const warnings = [];
  let calls = 0;
  const handler = createWebhookHandler({
    secret: SECRET,
    maxBodyBytes: 1024,
    onEvent: () => {
      calls += 1;
    },
    onError: (error) => warnings.push(error.reason ?? error.message),
  });
  const forged = await handler(await deliveryRequest({ secret: "whsec_attacker" }));
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), { error: "mismatch" });
  assert.equal((await handler(await deliveryRequest({ method: "GET" }))).status, 405);
  const big = "x".repeat(2048);
  assert.equal((await handler(await deliveryRequest({ body: big }))).status, 413);
  // No Content-Length (a streamed body): the limit still holds.
  const streamed = new Request("https://example.test/hook", {
    method: "POST",
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } }),
    duplex: "half",
    headers: { "kletia-signature": await signed(big) },
  });
  assert.equal((await handler(streamed)).status, 413);
  const consumed = await deliveryRequest();
  await consumed.text();
  const parsed = await handler(consumed);
  assert.equal(parsed.status, 500);
  assert.match((await parsed.json()).message, /raw request body/u);
  assert.equal(calls, 0);
  assert.ok(warnings.includes("mismatch"));
  assert.throws(() => createWebhookHandler({ secret: "", onEvent: () => undefined }), /secret/u);
});

test("a throwing onEvent gets a 500 (Kletia retries) and is not marked processed", async () => {
  const dedupe = memoryDeduplication();
  let attempts = 0;
  const errors = [];
  const handler = createWebhookHandler({
    secret: SECRET,
    onEvent: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database down: postgres://user:pw@10.0.0.4");
    },
    onError: (error) => errors.push(error),
    ...dedupe,
  });
  const failed = await handler(await deliveryRequest());
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "handler_failed" }, "the handler's error text is not sent back");
  const retried = await handler(await deliveryRequest());
  assert.equal(retried.status, 200);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});

/** Minimal Node/Express response double. */
function nodeResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = "") {
      this.body = chunk;
      this.headersSent = true;
    },
  };
  return response;
}

async function nodeHeaders(body = BODY) {
  return {
    "content-type": "application/json",
    "kletia-signature": await signed(body),
    "kletia-event-id": EVENT.id,
  };
}

test("expressWebhookHandler accepts express.raw Buffers and strings", async () => {
  const types = [];
  const handler = expressWebhookHandler({ secret: SECRET, onEvent: (event) => types.push(event.type) });
  const response = nodeResponse();
  await handler({ method: "POST", headers: await nodeHeaders(), body: Buffer.from(BODY) }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { received: true });
  const text = nodeResponse();
  await handler({ method: "POST", headers: await nodeHeaders(), body: BODY }, text);
  assert.equal(text.statusCode, 200);
  assert.deepEqual(types, ["intent.status_changed", "intent.status_changed"]);
});

test("expressWebhookHandler refuses an already-parsed body with an explicit 500", async () => {
  const errors = [];
  let calls = 0;
  const handler = expressWebhookHandler({ secret: SECRET, onEvent: () => { calls += 1; }, onError: (error) => errors.push(error) });
  const response = nodeResponse();
  await handler({ method: "POST", headers: await nodeHeaders(), body: JSON.parse(BODY), readableEnded: true }, response);
  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.body);
  assert.equal(body.error, "parsed_body");
  assert.match(body.message, /express\.raw\(\{ type: "application\/json" \}\)/u);
  assert.equal(calls, 0);
  assert.equal(errors[0].reason, "parsed_body");
});

test("expressWebhookHandler reads the stream itself when no body parser ran (node:http, Next pages router)", async () => {
  const types = [];
  const handler = expressWebhookHandler({ secret: SECRET, onEvent: (event) => types.push(event.type) });
  const request = Readable.from([Buffer.from(BODY.slice(0, 10)), Buffer.from(BODY.slice(10))]);
  request.method = "POST";
  request.headers = await nodeHeaders();
  const response = nodeResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(types, ["intent.status_changed"]);
  // Oversized streams stop at the limit.
  const limited = expressWebhookHandler({ secret: SECRET, maxBodyBytes: 16, onEvent: () => undefined });
  const big = Readable.from([Buffer.from(BODY)]);
  big.method = "POST";
  big.headers = await nodeHeaders();
  const tooLarge = nodeResponse();
  await limited(big, tooLarge);
  assert.equal(tooLarge.statusCode, 413);
});

test("honoWebhookHandler verifies c.req.raw", async () => {
  const handler = honoWebhookHandler({ secret: [SECRET], onEvent: () => undefined });
  const response = await handler({ req: { raw: await deliveryRequest() } });
  assert.equal(response.status, 200);
});
