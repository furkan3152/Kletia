/**
 * Smoke check of this example against an in-process stub of Kletia's /v1 on
 * 127.0.0.1: no network, no real key, nothing signed. `npm run check` (and
 * the repository's `npm run check:examples`, through `npm run build`) runs it.
 *
 * - The proxy refuses DELETE /v1/keys/… locally and forwards
 *   POST /v1/intents?dryRun=true with the server key, without the
 *   browser's cookies or Authorization.
 * - POST /api/checkout plans the order's amount, not the browser's.
 * - The webhook route verifies signatures and handles each event once.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { KletiaClient, signWebhookPayload } from "@kletia/sdk";
import { createApp } from "./server.mjs";

const KEY = "kl_dev_smoke_0123456789abcdefghijkl";
const SECRET = "whsec_smoke_0123456789abcdefghijkl";
const PAYER = "0x52908400098527886E0F7030069857D2E4169EE7";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const seen = [];
const stub = await listen((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://stub");
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.pathname === "/v1/intents") {
      const intent = { id: `int_${"0".repeat(32)}`, status: "planned", summary: { title: "Send 25 USDC" }, steps: [{ id: "s1" }] };
      res.statusCode = url.searchParams.get("dryRun") === "true" ? 200 : 201;
      return res.end(JSON.stringify(url.searchParams.get("preview") === "true" ? { intent, preview: null } : { intent }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "The stub does not serve this route." } }));
  });
});

const events = [];
const { handler } = createApp({ env: { KLETIA_API_KEY: KEY, KLETIA_BASE_URL: stub.url, KLETIA_WEBHOOK_SECRET: SECRET }, onEvent: async (event) => events.push(event.id) });
const shop = await listen(handler);

try {
  // 1. The proxy refuses key management locally.
  const refused = await fetch(`${shop.url}/api/kletia/v1/keys/key_1`, { method: "DELETE" });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "PROXY_ROUTE_FORBIDDEN");
  assert.equal(seen.length, 0, "nothing reached Kletia");

  // 2. The browser SDK plans a dry run through the proxy; the key is added server-side.
  const browser = new KletiaClient({ baseUrl: `${shop.url}/api/kletia`, maxRetries: 0, headers: { cookie: "session=visitor" } });
  const intent = await browser.intents.create({ text: "swap 1 SOL to USDC", accounts: [] }, { dryRun: true });
  assert.equal(intent.status, "planned");
  const forwarded = seen.at(-1);
  assert.equal(forwarded.path, "/v1/intents");
  assert.equal(forwarded.query.dryRun, "true");
  assert.equal(forwarded.headers.authorization, `Bearer ${KEY}`);
  assert.equal(forwarded.headers.cookie, undefined);

  // 3. Checkout: the server's amount and recipient, whatever the browser sends.
  const checkout = await fetch(`${shop.url}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "order-42", address: PAYER, amount: "0.01" }) });
  assert.equal(checkout.status, 201, await checkout.clone().text());
  const planned = seen.at(-1);
  assert.equal(planned.body.actions[0].amount, "25");
  assert.equal(planned.body.actions[0].network, "arbitrum-sepolia");
  assert.equal(planned.body.accounts[0], `eip155:421614:${PAYER}`);
  assert.equal((await fetch(`${shop.url}/api/checkout`, { method: "POST", body: JSON.stringify({ orderId: "order-0", address: PAYER }) })).status, 404);

  // 4. Webhooks: verified, de-duplicated, forged ones refused.
  const event = { id: `evt_${"1".repeat(32)}`, type: "intent.status_changed", at: "2026-10-14T12:00:00.000Z", data: { intentId: intent.id, previous: "executing", status: "completed" } };
  const body = JSON.stringify(event);
  const deliver = async (signature) =>
    (await fetch(`${shop.url}/webhooks/kletia`, { method: "POST", headers: { "content-type": "application/json", "kletia-signature": signature, "kletia-event-id": event.id }, body })).status;
  assert.equal(await deliver(await signWebhookPayload(SECRET, body)), 200);
  assert.equal(await deliver(await signWebhookPayload(SECRET, body)), 200, "a retried delivery is acknowledged");
  assert.deepEqual(events, [event.id], "and handled once");
  assert.equal(await deliver(await signWebhookPayload("whsec_someone_else_0123456789abcd", body)), 400);

  console.log("node-server smoke: ok");
} finally {
  shop.server.close();
  stub.server.close();
}
