/**
 * Per-client limits that must not be bypassed with free developer keys (SSE
 * stream slots, API key lookups), and the documented error responses of every
 * operation. Same offline seam as http.test.ts (stub adapters, memory stores).
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/clientLimits.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http, { type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import type { IntentGraph } from "@kletia/core";
import { configurePlatform } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import type { PlatformRouterOptions } from "../router.js";

delete process.env.KLETIA_DATABASE_URL;
delete process.env.KLETIA_PLATFORM_SECRET;
delete process.env.KLETIA_OPERATOR_API_KEYS;
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

// Loaded after the environment is fixed: stores and keys are resolved lazily from it.
const { buildOpenApiDocument, createPlatformRouter, openStreamCount, platformErrorHandler, TIER_LIMITS } = await import("../index.js");

/* ------------------------------------------------------------ helpers */

interface TestServer {
  readonly base: string;
  readonly port: number;
  close(): Promise<void>;
}

/** A fresh router (fresh tier rate-limit windows) on an ephemeral port. */
async function servePlatform(options: PlatformRouterOptions = {}): Promise<TestServer> {
  const app = express();
  app.use("/v1", createPlatformRouter(options), platformErrorHandler);
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Reply<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

async function call<T = { error?: { code: string; message: string } }>(
  server: TestServer,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${server.base}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    // An event stream never ends on its own.
    await response.body?.cancel();
    return { status: response.status, headers: response.headers, body: {} as T };
  }
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

async function issueKey(server: TestServer, name: string): Promise<string> {
  const reply = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key.key;
}

/** A well-formed developer key that was never issued. */
function unknownKey(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `kl_dev_${[...randomBytes(32)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

interface OpenStream {
  readonly status: number;
  close(): void;
}

/** Opens GET /intents/{id}/events and resolves with the status once headers arrive. */
function openStream(server: TestServer, intentId: string, key?: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const request: ClientRequest = http.get({
      host: "127.0.0.1",
      port: server.port,
      path: `/v1/intents/${intentId}/events`,
      headers: { accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, close: () => request.destroy() });
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000, message = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(() => {
  resetEngine();
});

after(() => {
  configurePlatform({ adapters: null });
});

/* ============================================================ SSE */

describe("SSE stream slots", () => {
  it("count keyed streams against the client IP too, so extra keys do not raise one address's share", async () => {
    const server = await servePlatform({ stream: { heartbeatMs: 60_000, maxDurationMs: 60_000 } });
    const streams: OpenStream[] = [];
    try {
      const keys = [await issueKey(server, "a"), await issueKey(server, "b"), await issueKey(server, "c")];
      const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", {
        key: keys[0],
        body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS },
      });
      assert.equal(created.status, 201);
      const id = created.body.intent.id;
      for (const key of [keys[0], keys[1]]) {
        for (let index = 0; index < 5; index += 1) {
          const stream = await openStream(server, id, key);
          streams.push(stream);
          assert.equal(stream.status, 200);
        }
      }
      assert.equal(openStreamCount(), 10);

      const viaThirdKey = await call(server, "GET", `/intents/${id}/events`, { key: keys[2] });
      assert.equal(viaThirdKey.status, 429);
      assert.equal(viaThirdKey.body.error?.code, "TOO_MANY_STREAMS");
      const keyless = await call(server, "GET", `/intents/${id}/events`);
      assert.equal(keyless.status, 429);
      assert.equal(keyless.body.error?.code, "TOO_MANY_STREAMS");

      streams.shift()?.close();
      await waitFor(() => openStreamCount() === 9, 2_000, "a released slot");
      const reopened = await openStream(server, id, keys[2]);
      streams.push(reopened);
      assert.equal(reopened.status, 200, "a freed slot of the address can be used with any key");
    } finally {
      for (const stream of streams) stream.close();
      await waitFor(() => openStreamCount() === 0, 2_000, "all slots released");
      await server.close();
    }
  });
});

/* ============================================================ OpenAPI */

describe("OpenAPI error responses", () => {
  it("documents 401 and 503 on every operation, since any request may present a key", () => {
    const document = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> };
    const missing: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!operation.operationId) continue;
        for (const status of ["401", "503"]) if (!operation.responses?.[status]) missing.push(`${status} ${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});

/* ============================================================ key lookups */

// Runs last: it spends this process's lookup budget for 127.0.0.1.
describe("API key lookup budget (memory store)", () => {
  it("charges only unknown keys, keeps cache hits free and fails closed once the budget is spent", async () => {
    const issuer = await servePlatform();
    const first = await servePlatform();
    const second = await servePlatform();
    try {
      const keys = [await issueKey(issuer, "k0"), await issueKey(issuer, "k1"), await issueKey(issuer, "k2"), await issueKey(issuer, "k3")];
      const unknown: string[] = [];
      for (let index = 0; index < TIER_LIMITS.public; index += 1) {
        // Valid keys looked up in between are given back to the budget.
        if (index % 10 === 0) assert.equal((await call(first, "GET", "/protocols", { key: keys[index / 10] })).status, 200);
        const key = unknownKey();
        unknown.push(key);
        const reply = await call(first, "GET", "/protocols", { key });
        assert.equal(reply.status, 401, `unknown key ${index + 1} is checked`);
        assert.equal(reply.body.error?.code, "INVALID_API_KEY");
      }

      // A fresh tier window does not reset the per-IP lookup budget.
      const throttled = await call(second, "GET", "/protocols", { key: unknownKey() });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.body.error?.code, "RATE_LIMITED");
      assert.ok(Number(throttled.headers.get("retry-after")) >= 1);
      // Cached results need no lookup: a verified key keeps working, a known-bad key is still 401.
      assert.equal((await call(second, "GET", "/protocols", { key: keys[0] })).status, 200);
      const known = await call(second, "GET", "/protocols", { key: unknown[0] });
      assert.equal(known.status, 401);
      assert.equal(known.body.error?.code, "INVALID_API_KEY");
      // A valid key that was never verified is not looked up either (fails closed until the window ends).
      const unverified = await call(second, "GET", "/protocols", { key: keys[3] });
      assert.equal(unverified.status, 429);
      assert.equal(unverified.body.error?.code, "RATE_LIMITED");
    } finally {
      await Promise.all([issuer.close(), first.close(), second.close()]);
    }
  });
});
