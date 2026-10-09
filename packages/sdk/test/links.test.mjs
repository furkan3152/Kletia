import assert from "node:assert/strict";
import test from "node:test";
import { KletiaApiError, KletiaClient } from "../dist/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LINK = "lk_5f1c2a9b7e3d4c6a8b0e1f23";
const VISITOR = "eip155:42161:0x000000000000000000000000000000000000dEaD";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-l", ...headers } });
}

const definition = () => ({
  title: "Pay 25 USDC to Acme Store",
  publisher: { name: "Acme Store", website: "https://shop.acme.example" },
  destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: "eip155:8453:0x1111111111111111111111111111111111111111" }] },
  funding: { networks: ["base", "arbitrum"], assets: ["USDC"], amount: { mode: "deliver" } },
  maxUses: 1,
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  blink: false,
  metadata: { invoice: "A-1029" },
});

const view = { id: LINK, status: "active", revision: 1, title: "Pay 25 USDC to Acme Store", urls: { page: `https://kletiaai.xyz/go/${LINK}` } };

function recording(respond, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      const call = { method: init.method, path: pathname, search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

test("links.create validates locally first: an invalid definition never leaves the process", async () => {
  const { client, calls } = recording(() => jsonResponse(201, { link: view }), { apiKey: "kl_dev_test" });
  await assert.rejects(client.links.create({ ...definition(), title: "Kletia pay" }), (error) => {
    assert.ok(error instanceof KletiaApiError);
    assert.equal(error.code, "LINK_DEFINITION_INVALID");
    assert.equal(error.status, 0);
    assert.equal(error.issues[0].path, "title");
    assert.match(error.message, /nothing was sent/u);
    return true;
  });
  assert.equal(calls.length, 0);
  const { link } = await client.links.create(definition());
  assert.equal(link.id, LINK);
  assert.equal(calls[0].path, "/v1/links");
  assert.match(calls[0].headers["idempotency-key"], UUID, "a lost response is replayed, not created twice");
});

test("owner routes: list, get, tighten-only update, pause, resume with accept, delete, stats", async () => {
  const { client, calls } = recording((call) => {
    const route = `${call.method} ${call.path}`;
    if (route === "GET /v1/links") return jsonResponse(200, { links: [view] });
    if (route === `GET /v1/links/${LINK}`) return jsonResponse(200, { link: view });
    if (route === `PATCH /v1/links/${LINK}`) return jsonResponse(200, { link: { ...view, ...call.body } });
    if (route === `DELETE /v1/links/${LINK}`) return new Response(null, { status: 204 });
    if (route === `GET /v1/links/${LINK}/stats`) return jsonResponse(200, { stats: { linkId: LINK, window: "30d", totals: { intent: 3 }, daily: [], bySource: [], conversion: {} } });
    throw new Error(`unexpected ${route}`);
  }, { apiKey: "kl_dev_test" });
  assert.equal((await client.links.list({ status: "active", limit: 10 })).length, 1);
  assert.equal(calls.at(-1).search, "?status=active&limit=10");
  assert.equal((await client.links.get(LINK)).id, LINK);
  await client.links.update(LINK, { funding: { amount: { mode: "input", bounds: { USDC: { min: "20" } } } } });
  assert.match(calls.at(-1).headers["idempotency-key"], UUID);
  await client.links.pause(LINK);
  assert.deepEqual(calls.at(-1).body, { status: "paused" });
  await client.links.resume(LINK, { accept: ["recipient_changed"] });
  assert.deepEqual(calls.at(-1).body, { status: "active", accept: ["recipient_changed"] });
  await client.links.resume(LINK);
  assert.deepEqual(calls.at(-1).body, { status: "active" });
  await client.links.delete(LINK);
  assert.equal(calls.at(-1).method, "DELETE");
  const stats = await client.links.stats(LINK, { window: "30d" });
  assert.equal(stats.totals.intent, 3);
  assert.equal(calls.at(-1).search, "?window=30d");
  await assert.rejects(client.links.get("lk_nothex"), TypeError);
});

test("visitors without a key: quote (retried like a read) and createIntent (never retried, no Idempotency-Key)", async () => {
  let quoteFailures = 1;
  const { client, calls } = recording((call) => {
    if (call.path.endsWith("/quote")) {
      if (quoteFailures-- > 0) return jsonResponse(503, { error: { code: "PROVIDER_UNAVAILABLE", message: "busy" } });
      return jsonResponse(200, { intent: { id: "dry-run" }, preview: { digest: `sha256:${"a".repeat(64)}` } });
    }
    if (call.path.endsWith("/intents")) return jsonResponse(503, { error: { code: "PROVIDER_UNAVAILABLE", message: "busy" } });
    throw new Error(call.path);
  });
  const quoted = await client.links.quote(LINK, { source: { network: "arbitrum", asset: "USDC" } });
  assert.equal(quoted.preview.digest, `sha256:${"a".repeat(64)}`);
  assert.equal(calls.filter((call) => call.path.endsWith("/quote")).length, 2);
  assert.equal(calls[0].headers.authorization, undefined);
  await assert.rejects(client.links.createIntent(LINK, { accounts: [VISITOR], source: { network: "arbitrum", asset: "USDC" }, clientReference: "visit-1" }), (error) => error.code === "PROVIDER_UNAVAILABLE");
  const creates = calls.filter((call) => call.path.endsWith("/intents"));
  assert.equal(creates.length, 1, "a visitor intent is never retried automatically");
  assert.equal(creates[0].headers["idempotency-key"], undefined);
  assert.deepEqual(creates[0].body, { accounts: [VISITOR], source: { network: "arbitrum", asset: "USDC" }, clientReference: "visit-1" });
});

test("page and card URLs use the web origin; card() returns PNG bytes and refuses anything else", async () => {
  const client = new KletiaClient({ baseUrl: "http://localhost:3001", webOrigin: "https://staging.kletia.example", fetch: async (url) => {
    if (url.includes("variant=square")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    if (url.includes("lk_000000000000000000000000")) return jsonResponse(404, { error: { code: "LINK_NOT_FOUND", message: "unknown" } });
    return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  } });
  assert.equal(client.links.pageUrl(LINK), `https://staging.kletia.example/go/${LINK}`);
  assert.equal(client.links.cardUrl(LINK, "square"), `https://staging.kletia.example/go/${LINK}/card.png?variant=square`);
  assert.deepEqual([...(await client.links.card(LINK, { variant: "square" }))], [...PNG]);
  await assert.rejects(client.links.card(LINK), (error) => error.code === "INVALID_RESPONSE");
  await assert.rejects(client.links.card("lk_000000000000000000000000"), (error) => error.code === "LINK_NOT_FOUND" && error.status === 404);
  assert.equal(new KletiaClient({ fetch: async () => new Response() }).links.pageUrl(LINK), `https://kletiaai.xyz/go/${LINK}`);
});
