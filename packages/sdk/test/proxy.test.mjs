/**
 * `createKletiaProxy` / `expressKletiaProxy` (integrator design 4.6, P9a):
 * the browser allowlist, header stripping, the body cap, SSE pass-through
 * and no redirect following. The upstream is a recording fetch stub; one
 * test runs the Express adapter on a real node:http server.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { KletiaClient } from "../dist/index.js";
import { BROWSER_PROXY_RULES, createKletiaProxy, expressKletiaProxy } from "../dist/server/index.js";

const KEY = "kl_dev_0123456789abcdefghijklmnopqrstuv";

function upstreamStub(answer = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "up-1", "set-cookie": "s=1" } })) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body ? new TextDecoder().decode(init.body) : undefined, redirect: init.redirect });
      return answer(new URL(url), init);
    },
  };
}

const browser = (path, init = {}) => new Request(`https://shop.example/api/kletia${path}`, init);

test("forwards a dry run with the server key and only allowlisted headers", async () => {
  const upstream = upstreamStub();
  const proxy = createKletiaProxy({ apiKey: KEY, baseUrl: "https://api.kletia.test", mount: "/api/kletia", fetch: upstream.fetch });
  const response = await proxy(
    browser("/v1/intents?dryRun=true&preview=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer kl_dev_visitor_supplied",
        "x-kletia-key": "kl_dev_other",
        cookie: "session=abc",
        origin: "https://evil.example",
        "x-request-id": "req-browser",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({ text: "swap 1 SOL to USDC", accounts: [] }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(upstream.calls.length, 1);
  const call = upstream.calls[0];
  assert.equal(call.url.toString(), "https://api.kletia.test/v1/intents?dryRun=true&preview=true");
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers.origin, undefined);
  assert.equal(call.headers["x-kletia-key"], undefined);
  assert.equal(call.headers["x-forwarded-for"], undefined);
  assert.equal(call.headers["x-request-id"], "req-browser");
  assert.equal(call.redirect, "manual", "redirects are never followed");
  assert.equal(JSON.parse(call.body).text, "swap 1 SOL to USDC");
  assert.equal(response.headers.get("set-cookie"), null, "upstream cookies never reach the browser");
  assert.equal(response.headers.get("x-request-id"), "up-1");
});

test("refuses everything outside the browser allowlist locally with 403 PROXY_ROUTE_FORBIDDEN", async () => {
  const upstream = upstreamStub();
  const proxy = createKletiaProxy({ apiKey: KEY, mount: "/api/kletia", fetch: upstream.fetch });
  for (const [method, path] of [
    ["GET", "/v1/keys"],
    ["DELETE", "/v1/keys/key_1"],
    ["DELETE", "/v1/webhooks/x"],
    ["POST", "/v1/contracts"],
    ["GET", "/v1/intents"],
    ["GET", "/v1/usage"],
    ["GET", "/v1/events"],
    ["PATCH", "/v1/projects/current"],
    ["GET", "/v1/threads"],
    ["POST", "/v1/sessions"],
    ["GET", "/v1/intents/int_1/../../keys"],
    ["GET", "/v1/intents/int_1%2f..%2f..%2fkeys"],
    ["GET", "/elsewhere/v1/health"],
    ["GET", "/health"],
  ]) {
    const response = await proxy(browser(path, { method, ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}) }));
    assert.equal(response.status, 403, `${method} ${path}`);
    const body = await response.json();
    assert.equal(body.error.code, "PROXY_ROUTE_FORBIDDEN");
  }
  assert.equal(upstream.calls.length, 0, "nothing reached Kletia");
});

test("Kletia-held clarify threads stay server-side; client-held turns pass", async () => {
  const upstream = upstreamStub();
  const proxy = createKletiaProxy({ apiKey: KEY, mount: "/api/kletia", fetch: upstream.fetch });
  const remember = await proxy(browser("/v1/intents?clarify=true", { method: "POST", body: JSON.stringify({ text: "swap SOL", remember: true }) }));
  assert.equal(remember.status, 403);
  const held = await proxy(browser("/v1/intents?clarify=true", { method: "POST", body: JSON.stringify({ threadId: "th_abcdefghijklmnopqrstuvwx" }) }));
  assert.equal(held.status, 403);
  const clientHeld = await proxy(browser("/v1/intents?clarify=true&dryRun=true", { method: "POST", body: JSON.stringify({ text: "swap SOL to USDC" }) }));
  assert.equal(clientHeld.status, 200);
  assert.equal(upstream.calls.length, 1);
});

test("caps request bodies with 413 (declared and streamed)", async () => {
  const upstream = upstreamStub();
  const proxy = createKletiaProxy({ apiKey: KEY, mount: "/api/kletia", maxBodyBytes: 32, fetch: upstream.fetch });
  const big = JSON.stringify({ text: "x".repeat(100) });
  const declared = await proxy(browser("/v1/intents", { method: "POST", headers: { "content-length": String(big.length) }, body: big }));
  assert.equal(declared.status, 413);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  const streamed = await proxy(browser("/v1/intents", { method: "POST", body: stream, duplex: "half" }));
  assert.equal(streamed.status, 413);
  assert.equal((await streamed.json()).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(upstream.calls.length, 0);
});

test("streams Server-Sent Events through as they arrive", async () => {
  let push;
  const upstream = upstreamStub(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
            push("retry: 3000\n\n");
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const proxy = createKletiaProxy({ apiKey: KEY, mount: "/api/kletia", fetch: upstream.fetch });
  const response = await proxy(browser("/v1/intents/int_1/events", { headers: { accept: "text/event-stream", "last-event-id": "evt_1" } }));
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(upstream.calls[0].headers["last-event-id"], "evt_1");
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /retry: 3000/u);
  push('id: evt_2\ndata: {"id":"evt_2"}\n\n');
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /evt_2/u, "the second frame arrives before the stream ends");
  await reader.cancel();
});

test("an upstream redirect is answered 502, never followed or passed on", async () => {
  const upstream = upstreamStub(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
  const proxy = createKletiaProxy({ apiKey: KEY, mount: "/api/kletia", fetch: upstream.fetch });
  const response = await proxy(browser("/v1/health"));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.equal(upstream.calls.length, 1);
});

test("options are checked: a server key is required, custom rules replace the browser list", async () => {
  assert.throws(() => createKletiaProxy({ apiKey: "kl_pub_x", mount: "/api/kletia" }), TypeError);
  assert.throws(() => createKletiaProxy({ apiKey: KEY, mount: "api" }), TypeError);
  assert.throws(() => createKletiaProxy({ apiKey: KEY, mount: "/api", baseUrl: "http://api.example" }), TypeError);
  assert.ok(BROWSER_PROXY_RULES.every((rule) => !/^\/(?:keys|webhooks|contracts|policy|projects|usage|threads|events)\b/u.test(rule.path)));
  const upstream = upstreamStub();
  const custom = createKletiaProxy({ apiKey: KEY, mount: "/k", allow: [{ method: "GET", path: "/intents" }], fetch: upstream.fetch });
  assert.equal((await custom(new Request("https://shop.example/k/v1/intents?limit=3"))).status, 200);
  assert.equal((await custom(new Request("https://shop.example/k/v1/health"))).status, 403);
});

test("expressKletiaProxy on node:http: the browser SDK plans through it and cannot list keys", async () => {
  // A slower upstream: the browser's request has finished sending by then, which must not cancel the call.
  const upstream = upstreamStub(async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return url.pathname === "/v1/intents" ? new Response(JSON.stringify({ intent: { id: "int_px", steps: [] } }), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
  });
  const handler = expressKletiaProxy({ apiKey: KEY, mount: "/api/kletia", baseUrl: "https://api.kletia.test", fetch: upstream.fetch });
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/kletia/")) return handler(req, res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const browserSdk = new KletiaClient({ baseUrl: `http://localhost:${server.address().port}/api/kletia`, maxRetries: 0 });
    const intent = await browserSdk.intents.create({ text: "swap 1 SOL to USDC", accounts: [] }, { dryRun: true });
    assert.equal(intent.id, "int_px");
    assert.equal(upstream.calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(upstream.calls[0].url.searchParams.get("dryRun"), "true");
    await assert.rejects(browserSdk.keys.list(), (error) => error.code === "PROXY_ROUTE_FORBIDDEN" && error.status === 403);
    assert.equal(upstream.calls.length, 1);
  } finally {
    server.close();
  }
});
