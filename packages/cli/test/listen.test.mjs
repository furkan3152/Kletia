/**
 * `kletia listen`: the key's event stream is forwarded to a local receiver,
 * signed like webhook deliveries; the receiver verifies with
 * `constructWebhookEvent` (through expressWebhookHandler).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { expressWebhookHandler, memoryDeduplication } from "@kletia/sdk/server";
import { cli, stubServer } from "./helpers.mjs";

const SECRET = "whsec_listen_test_secret_0123456789abcdef";
const KEY = "kl_dev_listen_key_0123456789";

const event = (n, type, data = {}) => ({ id: `evt_${String(n).padStart(32, "0")}`, type, at: "2026-10-14T12:00:00.000Z", data });
const frame = (entry) => `id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`;

test("listen forwards signed events to a local receiver, resumes after the last event and skips duplicates", async () => {
  const opened = [];
  const api = await stubServer((req, res) => {
    if (req.method !== "GET" || req.path !== "/v1/events") return false;
    opened.push({ lastEventId: req.headers["last-event-id"], scope: req.url.searchParams.get("scope"), types: req.url.searchParams.get("types"), auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("retry: 3000\n\n");
    if (opened.length === 1) {
      res.write(frame(event(1, "contract.registered", { contractId: "ct_1" })));
      res.write(frame(event(2, "link.created", { linkId: "lk_1" })));
      // The API ends streams after 30 minutes; this one ends at once.
      res.end();
      return;
    }
    // After a reconnect the API replays from Last-Event-ID: one duplicate, one new event, then it stays open.
    res.write(frame(event(2, "link.created", { linkId: "lk_1" })));
    res.write(frame(event(3, "key.created", { keyId: "key_2" })));
  });
  const received = [];
  const handler = expressWebhookHandler({
    secret: SECRET,
    ...memoryDeduplication(),
    onEvent: async (verified) => {
      received.push(verified.type);
    },
  });
  const receiver = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const target = `http://127.0.0.1:${receiver.address().port}/webhooks/kletia`;
    const result = await cli(["listen", "--forward-to", target, "--scope", "subtree", "--wait", "3", "--json"], { base: api.base, env: { KLETIA_API_KEY: KEY, KLETIA_WEBHOOK_SECRET: SECRET } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(received, ["contract.registered", "link.created", "key.created"], "each event verified once, in order");
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => [line.type, line.status]), [["contract.registered", "200"], ["link.created", "200"], ["key.created", "200"]]);
    assert.ok(opened.length >= 2, "reconnected after the stream ended");
    assert.equal(opened[0].scope, "subtree");
    assert.equal(opened[0].auth, `Bearer ${KEY}`);
    assert.equal(opened[1].lastEventId, event(2, "x").id, "resumed after the last event");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET), "the secret is never printed");
  } finally {
    api.close();
    receiver.close();
  }
});

test("listen --event keeps only those types; a wrong secret is refused by the receiver", async () => {
  const api = await stubServer((req, res) => {
    if (req.path !== "/v1/events") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame(event(1, "contract.activated")));
    res.write(frame(event(2, "intent.created")));
  });
  const handler = expressWebhookHandler({ secret: "whsec_the_real_one_0123456789abcdef", onEvent: async () => {} });
  const receiver = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const target = `http://localhost:${receiver.address().port}/hook`;
    const result = await cli(["listen", "--forward-to", target, "--event", "contract.activated", "--wait", "1"], { base: api.base, env: { KLETIA_API_KEY: KEY, KLETIA_WEBHOOK_SECRET: SECRET } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(api.requests[0].url.searchParams.get("types"), "contract.activated");
    assert.match(result.stdout, /^400  contract\.activated  evt_/mu, "the receiver refused a signature made with another secret");
    assert.doesNotMatch(result.stdout, /intent\.created/u);
  } finally {
    api.close();
    receiver.close();
  }
});

test("listen refuses public targets, a missing secret, a missing key and bad flags before connecting", async () => {
  const env = { KLETIA_API_KEY: KEY, KLETIA_WEBHOOK_SECRET: SECRET };
  const remote = await cli(["listen", "--forward-to", "https://hooks.example/kletia"], { base: "http://127.0.0.1:9", env });
  assert.equal(remote.code, 64);
  assert.match(remote.stderr, /local endpoint/u);
  const noSecret = await cli(["listen", "--forward-to", "http://localhost:3000/x"], { base: "http://127.0.0.1:9", env: { KLETIA_API_KEY: KEY } });
  assert.equal(noSecret.code, 64);
  const noKey = await cli(["listen", "--forward-to", "http://localhost:3000/x"], { base: "http://127.0.0.1:9", env: { KLETIA_WEBHOOK_SECRET: SECRET } });
  assert.equal(noKey.code, 64);
  const scope = await cli(["listen", "--forward-to", "http://localhost:3000/x", "--scope", "all"], { base: "http://127.0.0.1:9", env });
  assert.equal(scope.code, 64);
});
