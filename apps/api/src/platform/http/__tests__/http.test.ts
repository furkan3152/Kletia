/**
 * Platform API v1 over real HTTP: the router runs on an ephemeral port with
 * the engine's offline test seam (stub adapters, in-memory stores) and a
 * stubbed RPC health probe, so nothing here needs the network.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/*.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import express, { type Express, type Router } from "express";
import { CHAINS, NETWORK_KEYS, resolveErrorCode, verifyWebhookSignature, type IntentGraph, type NetworkKey } from "@kletia/core";
import { configurePlatform, getIntentStore, STEP_ID_PATTERN, type IntentStore } from "../../index.js";
import { MemoryIntentStore } from "../../engine/store.js";
import {
  ACCOUNTS,
  randomEvmHash,
  randomSolanaSignature,
  resetEngine,
  SOL_ADDRESS,
  stub,
  stubJupiter,
  STUB_ADAPTERS,
} from "../../engine/__tests__/helpers.js";
import type { PlatformRouterOptions } from "../router.js";
import type { WebhookTransport } from "../dispatcher.js";

/* ------------------------------------------------------------ environment */

const OPERATOR_KEY = "op_test_key_0123456789abcdefghijklmnop";
process.env.KLETIA_OPERATOR_API_KEYS = `${OPERATOR_KEY},short`;
delete process.env.KLETIA_DATABASE_URL;
delete process.env.KLETIA_PLATFORM_SECRET;
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

// Loaded after the environment is fixed: stores and keys are resolved lazily from it.
const platformHttp = await import("../index.js");
const { configureHealthProbe, createPlatformRouter, openStreamCount, platformErrorHandler, PLATFORM_ROUTES, startPlatformBackground } = platformHttp;
const { isPublicAddress } = await import("../netguard.js");

const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Public IPv4 literal (no DNS lookup needed) used as a webhook target. */
const PUBLIC_HOOK = "https://93.184.215.14/kletia-hooks";

function healthyProbe(network: NetworkKey) {
  const chain = CHAINS[network];
  return Promise.resolve({ network, chain: chain.id, name: chain.name, environment: chain.environment, ok: true, latencyMs: 1, height: "123" });
}

/* ------------------------------------------------------------ server helpers */

interface TestServer {
  readonly base: string;
  readonly port: number;
  close(): Promise<void>;
}

async function serve(mount: (app: Express) => void): Promise<TestServer> {
  const app = express();
  mount(app);
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

/** A fresh router (fresh rate-limit windows) mounted at /v1 the way the app mounts it. */
function servePlatform(options: PlatformRouterOptions = {}): Promise<TestServer> {
  return serve((app) => {
    app.use("/v1", createPlatformRouter(options), platformErrorHandler);
  });
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string; readonly issues?: readonly { path: string; message: string }[]; readonly hints?: readonly string[] };
  readonly requestId: string;
}

interface Reply<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

async function call<T = unknown>(
  server: TestServer,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  }
  const response = await fetch(`${server.base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await response.text();
  let parsed: unknown = text;
  if ((response.headers.get("content-type") ?? "").includes("json") && text) parsed = JSON.parse(text);
  return { status: response.status, headers: response.headers, body: parsed as T };
}

function assertError(reply: Reply<unknown>, status: number, code: string): ErrorEnvelope {
  const body = reply.body as ErrorEnvelope;
  assert.equal(reply.status, status, `expected ${status} ${code}, got ${reply.status} ${JSON.stringify(reply.body)}`);
  assert.equal(body.error?.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.match(body.requestId, UUID);
  assert.equal(reply.headers.get("x-request-id"), body.requestId, "envelope and header carry the same request id");
  assert.equal(reply.headers.get("cache-control"), "no-store");
  return body;
}

async function issueKey(server: TestServer, name = "tests"): Promise<string> {
  const reply = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key.key;
}

function rateLimitQuota(headers: Headers): number {
  const policy = headers.get("ratelimit-policy") ?? "";
  const match = /q=(\d+)/u.exec(policy);
  assert.ok(match, `RateLimit-Policy header present (got "${policy}")`);
  return Number(match[1]);
}

/* ------------------------------------------------------------ SSE helpers */

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
  readonly retry?: string;
}

interface SseClient {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Resolves with the next frame (or rejects after `timeoutMs`). */
  next(timeoutMs?: number): Promise<SseFrame>;
  /** Waits for the next frame matching `predicate`. */
  until(predicate: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  readonly ended: Promise<void>;
  close(): void;
}

function parseFrame(block: string): SseFrame {
  const frame: { id?: string; event?: string; data?: string; comment?: string; retry?: string } = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
    else if (line.startsWith("retry: ")) frame.retry = line.slice(7);
  }
  return frame;
}

function openSse(server: TestServer, path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: server.port, path: `/v1${path}`, headers: { accept: "text/event-stream", ...headers } });
    request.on("error", reject);
    request.on("response", (response: IncomingMessage) => {
      const frames: SseFrame[] = [];
      const waiters: ((frame: SseFrame) => void)[] = [];
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame = parseFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
          else frames.push(frame);
          index = buffer.indexOf("\n\n");
        }
      });
      const ended = new Promise<void>((done) => {
        response.on("close", () => done());
      });
      const next = (timeoutMs = 2_000) =>
        new Promise<SseFrame>((done, fail) => {
          const queued = frames.shift();
          if (queued) {
            done(queued);
            return;
          }
          const timer = setTimeout(() => fail(new Error("timed out waiting for an SSE frame")), timeoutMs);
          waiters.push((frame) => {
            clearTimeout(timer);
            done(frame);
          });
        });
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        next,
        until: async (predicate, timeoutMs = 2_000) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const frame = await next(Math.max(1, deadline - Date.now()));
            if (predicate(frame)) return frame;
          }
        },
        ended,
        close: () => request.destroy(),
      });
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

/* ------------------------------------------------------------ setup */

before(() => {
  resetEngine();
  configureHealthProbe(healthyProbe);
});

after(() => {
  configureHealthProbe(null);
  configurePlatform({ adapters: null });
});

/* ============================================================ health */

describe("GET /v1/health", () => {
  let server: TestServer;
  before(async () => {
    server = await servePlatform();
  });
  after(() => server.close());
  afterEach(() => configureHealthProbe(healthyProbe));

  it("reports API, per-network and storage health", async () => {
    const reply = await call<Record<string, unknown>>(server, "GET", "/health");
    assert.equal(reply.status, 200);
    const body = reply.body as {
      status: string;
      api: string;
      version: string;
      time: string;
      uptimeSeconds: number;
      networks: { network: string; chain: string; ok: boolean; latencyMs: number; height?: string; environment: string }[];
      storage: { intents: string; apiKeys: string; webhooks: string; contracts: string; sessions: string };
      webhooks: { status: string; sealing: string; dispatcher: unknown };
      contracts: { enabled: boolean; simulation: unknown };
    };
    assert.equal(body.status, "ok");
    assert.equal(body.api, "v1");
    assert.match(body.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(!Number.isNaN(Date.parse(body.time)));
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.deepEqual(body.networks.map((entry) => entry.network), [...NETWORK_KEYS]);
    for (const entry of body.networks) {
      assert.equal(entry.chain, CHAINS[entry.network as NetworkKey].id);
      assert.equal(entry.ok, true);
      assert.equal(entry.height, "123");
      assert.ok(entry.environment === "mainnet" || entry.environment === "testnet");
    }
    assert.deepEqual(body.storage, { intents: "memory", apiKeys: "memory", webhooks: "memory", contracts: "memory", sessions: "memory" });
    // A custom health probe also stands in for the live simulation probe (not probed: null).
    assert.deepEqual(body.contracts, { enabled: true, simulation: null });
    assert.equal(body.webhooks.status, "enabled", "the development sealing key enables webhooks outside production");
    assert.equal(body.webhooks.sealing, "development_fallback");
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  });

  it("degrades without throwing when a probe fails, and never leaks provider text", async () => {
    configureHealthProbe((network) => {
      if (network === "base") return Promise.reject(new Error("https://rpc.example/v2/SECRET-KEY exploded"));
      return healthyProbe(network);
    });
    const reply = await call<{ status: string; networks: { network: string; ok: boolean; detail?: string }[] }>(server, "GET", "/health");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.status, "degraded");
    const base = reply.body.networks.find((entry) => entry.network === "base");
    assert.equal(base?.ok, false);
    assert.equal(base?.detail, "RPC unavailable");
    assert.ok(!JSON.stringify(reply.body).includes("SECRET"));
  });

  it("echoes a valid X-Request-Id and replaces anything else", async () => {
    const id = "0F3C7E1A-2B4D-4C6E-8F90-A1B2C3D4E5F6";
    const echoed = await call(server, "GET", "/health", { headers: { "x-request-id": id } });
    assert.equal(echoed.headers.get("x-request-id"), id.toLowerCase());
    const junk = await call(server, "GET", "/health", { headers: { "x-request-id": "<script>alert(1)</script>" } });
    const replaced = junk.headers.get("x-request-id") ?? "";
    assert.match(replaced, UUID);
    assert.notEqual(replaced, id.toLowerCase());
  });
});

/* ============================================================ registries */

describe("registries", () => {
  let server: TestServer;
  before(async () => {
    server = await servePlatform();
  });
  after(async () => {
    configurePlatform({ adapters: STUB_ADAPTERS });
    await server.close();
  });

  interface NetworkView {
    key: NetworkKey;
    id: string;
    actions: string[];
    executableProtocols: string[];
    routes: { kind: string; protocol: string; toNetworks: NetworkKey[] }[];
  }

  it("derives network capabilities from the engine's active adapters", async () => {
    const reply = await call<{ networks: NetworkView[] }>(server, "GET", "/networks");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "public, max-age=60");
    const byKey = new Map(reply.body.networks.map((entry) => [entry.key, entry]));
    assert.deepEqual([...byKey.keys()], [...NETWORK_KEYS]);
    const solana = byKey.get("solana");
    assert.ok(solana);
    assert.equal(solana.id, CHAINS.solana.id);
    for (const kind of ["swap", "transfer", "bridge", "stake"]) assert.ok(solana.actions.includes(kind), `solana ${kind}`);
    const base = byKey.get("base");
    assert.ok(base);
    const bridge = base.routes.find((route) => route.kind === "bridge");
    assert.ok(bridge, "base bridges");
    assert.ok(bridge.toNetworks.includes("solana") && bridge.toNetworks.includes("arbitrum"));
    assert.ok(!bridge.toNetworks.includes("arbitrum-sepolia"), "mainnet routes never reach a testnet");
    assert.ok(base.actions.includes("deposit"));
  });

  it("follows configurePlatform({ adapters }) instead of advertising the built-in set", async () => {
    configurePlatform({ adapters: [stubJupiter] });
    const networks = await call<{ networks: NetworkView[] }>(server, "GET", "/networks");
    const solana = networks.body.networks.find((entry) => entry.key === "solana");
    assert.deepEqual(solana?.actions, ["swap", "stake"]);
    assert.deepEqual(networks.body.networks.find((entry) => entry.key === "base")?.actions, []);
    const protocols = await call<{ protocols: { id: string; executable: boolean }[] }>(server, "GET", "/protocols");
    const executable = protocols.body.protocols.filter((entry) => entry.executable).map((entry) => entry.id);
    assert.deepEqual(executable, ["jupiter"]);
    configurePlatform({ adapters: STUB_ADAPTERS });
    const restored = await call<{ protocols: { id: string; executable: boolean }[] }>(server, "GET", "/protocols");
    assert.ok(restored.body.protocols.filter((entry) => entry.executable).length >= 5);
  });

  it("filters assets by network key or CAIP-2 id and rejects unknown or repeated filters", async () => {
    const all = await call<{ assets: { network: string }[] }>(server, "GET", "/assets");
    assert.equal(all.status, 200);
    assert.ok(all.body.assets.length > 0);
    const byKey = await call<{ assets: { network: string }[] }>(server, "GET", "/assets?network=solana");
    assert.ok(byKey.body.assets.length > 0 && byKey.body.assets.every((asset) => asset.network === "solana"));
    const byCaip = await call<{ assets: { network: string }[] }>(server, "GET", `/assets?network=${encodeURIComponent(CHAINS.base.id)}`);
    assert.ok(byCaip.body.assets.length > 0 && byCaip.body.assets.every((asset) => asset.network === "base"));
    assertError(await call(server, "GET", "/assets?network=dogechain"), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/assets?network=base&network=solana"), 400, "INVALID_REQUEST");
  });
});

/* ============================================================ OpenAPI */

describe("GET /v1/openapi.json", () => {
  let server: TestServer;
  let document: { openapi: string; paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[] }>>; components: Record<string, Record<string, unknown>> };
  before(async () => {
    server = await servePlatform();
    const reply = await call<typeof document>(server, "GET", "/openapi.json");
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type") ?? "", /application\/json/u);
    document = reply.body;
  });
  after(() => server.close());

  const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

  function documentOperations(): Set<string> {
    const operations = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item)) if (HTTP_METHODS.has(method)) operations.add(`${method.toUpperCase()} ${path}`);
    }
    return operations;
  }

  /** Operations the mounted Express router actually serves (read from its route stack). */
  function routerOperations(router: Router): Set<string> {
    const operations = new Set<string>();
    const stack = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
    for (const layer of stack) {
      if (!layer.route) continue;
      const path = `/v1${layer.route.path.replace(/:([A-Za-z]+)/gu, "{$1}")}`;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled && method !== "_all") operations.add(`${method.toUpperCase()} ${path}`);
      }
    }
    return operations;
  }

  it("is OpenAPI 3.1 and documents exactly the routes the router serves", () => {
    assert.equal(document.openapi, "3.1.0");
    const served = routerOperations(createPlatformRouter());
    const documented = documentOperations();
    assert.ok(served.size >= 28, `router serves ${served.size} operations`);
    assert.deepEqual([...served].filter((operation) => !documented.has(operation)), [], "served but undocumented");
    assert.deepEqual([...documented].filter((operation) => !served.has(operation)), [], "documented but not served");
    const table = new Set(PLATFORM_ROUTES.map((route) => `${route.method.toUpperCase()} /v1${route.path.replace(/:([A-Za-z]+)/gu, "{$1}")}`));
    assert.deepEqual(table, served, "PLATFORM_ROUTES matches the mounted router");
  });

  it("resolves every $ref and declares every path parameter", () => {
    const missing: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          if (key === "$ref" && typeof entry === "string") {
            const [, section, name] = /^#\/components\/([^/]+)\/(.+)$/u.exec(entry) ?? [];
            if (!section || !name || !(name in (document.components[section] ?? {}))) missing.push(entry);
          } else visit(entry);
        }
      }
    };
    visit(document);
    assert.deepEqual(missing, []);
    const operationIds = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
      for (const [method, operation] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        assert.ok(operation.operationId && !operationIds.has(operation.operationId), `unique operationId on ${method} ${path}`);
        operationIds.add(operation.operationId);
        const declared = JSON.stringify(resolveParameters(operation.parameters));
        for (const name of names) {
          assert.ok(declared.includes(`"name":"${name}","in":"path"`), `${method} ${path} declares ${name}`);
        }
      }
    }
  });

  function resolveParameters(parameters: unknown[] | undefined): unknown[] {
    return (parameters ?? []).map((parameter) => {
      const reference = (parameter as { $ref?: string }).$ref;
      if (!reference) return parameter;
      const name = /^#\/components\/parameters\/(.+)$/u.exec(reference)?.[1] ?? "";
      return document.components.parameters?.[name];
    });
  }

  it("declares Idempotency-Key exactly on the operations that honour it", async () => {
    const key = await issueKey(server, "openapi-idempotency");
    const honoured: string[] = [];
    const refused: string[] = [];
    const sampleId = (path: string) =>
      path.startsWith("/keys")
        ? `key_${"0".repeat(24)}`
        : path.startsWith("/webhooks")
          ? `wh_${"0".repeat(24)}`
          : path.startsWith("/contracts")
            ? `ct_${"0".repeat(24)}`
            : path.startsWith("/sessions")
              ? `cs_${"0".repeat(32)}`
              : `int_${"0".repeat(32)}`;
    for (const route of PLATFORM_ROUTES.filter((entry) => entry.method === "post" || entry.method === "patch")) {
      const path = route.path.replace(":id", sampleId(route.path)).replace(":stepId", "s1");
      const reply = await call<ErrorEnvelope>(server, route.method.toUpperCase(), path, { key, body: {}, headers: { "idempotency-key": "not a valid key!" } });
      const code = (reply.body as Partial<ErrorEnvelope>).error?.code;
      const operation = `${route.method.toUpperCase()} /v1${route.path.replace(/:([A-Za-z]+)/gu, "{$1}")}`;
      if (code === "IDEMPOTENCY_KEY_INVALID") honoured.push(operation);
      if (code === "IDEMPOTENCY_NOT_SUPPORTED") refused.push(operation);
    }
    const declaring: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        if (JSON.stringify(resolveParameters(operation.parameters)).includes('"name":"Idempotency-Key"')) declaring.push(`${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(declaring.sort(), [...honoured].sort());
    assert.deepEqual(
      honoured.sort(),
      [
        "POST /v1/intents",
        "POST /v1/intents/{id}/cancel",
        "POST /v1/intents/{id}/steps/{stepId}/submit",
        "POST /v1/keys",
        "POST /v1/keys/{id}/rotate",
        "POST /v1/webhooks",
        "POST /v1/contracts",
        "PATCH /v1/contracts/{id}",
        "POST /v1/contracts/{id}/reverify",
        "POST /v1/sessions",
      ].sort(),
    );
    assert.deepEqual(refused, ["POST /v1/intents/{id}/steps/{stepId}/prepare"]);
  });

  it("names only catalogued error codes in its descriptions", () => {
    const text = JSON.stringify(document);
    const mentioned = new Set([...text.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/gu)].map((match) => match[1] as string));
    const ignored = new Set(["UPPER_SNAKE_CASE", "KLETIA_PLATFORM_SECRET", "KLETIA_OPERATOR_API_KEYS"]);
    const unknown = [...mentioned].filter((code) => !ignored.has(code) && !resolveErrorCode(code));
    assert.deepEqual(unknown, []);
  });

  it("uses the engine's step id format and documents 422 reference rejections on submit", () => {
    const schemas = document.components.schemas as Record<string, { pattern?: string }>;
    assert.equal(schemas.StepId?.pattern, STEP_ID_PATTERN.source);
    const submit = document.paths["/v1/intents/{id}/steps/{stepId}/submit"]?.post as unknown as { responses: Record<string, unknown>; description: string };
    assert.ok(submit.responses["422"], "submit documents 422");
    assert.match(submit.description, /REFERENCE_ALREADY_USED/u);
    const responses = document.components.responses as Record<string, { description: string }>;
    assert.doesNotMatch(responses.Conflict?.description ?? "", /REFERENCE_ALREADY_USED/u);
    assert.match(responses.Unprocessable?.description ?? "", /REFERENCE_ALREADY_USED/u);
  });
});

/* ============================================================ auth & tiers */

describe("authentication and tiers", () => {
  let server: TestServer;
  let developerKey: string;
  before(async () => {
    server = await servePlatform();
    developerKey = await issueKey(server);
  });
  after(() => server.close());

  it("issues developer keys once, as kl_dev_ + 32 base62 characters", async () => {
    const reply = await call<{ key: Record<string, unknown> }>(server, "POST", "/keys", { body: { name: "second" } });
    assert.equal(reply.status, 201);
    assert.match(String(reply.body.key.key), /^kl_dev_[0-9A-Za-z]{32}$/u);
    assert.match(String(reply.body.key.id), /^key_[0-9a-f]{24}$/u);
    assert.equal(reply.body.key.tier, "developer");
    assert.deepEqual(Object.keys(reply.body.key).sort(), ["createdAt", "id", "key", "name", "tier"]);
    assertError(await call(server, "POST", "/keys", { body: { name: "" } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/keys", { body: { name: "bad\u0000name" } }), 400, "INVALID_REQUEST");
  });

  it("serves the public tier without a key and the developer / operator tiers with one", async () => {
    assert.equal(rateLimitQuota((await call(server, "GET", "/protocols")).headers), 30);
    const developer = await call(server, "GET", "/protocols", { key: developerKey });
    assert.equal(developer.status, 200);
    assert.equal(rateLimitQuota(developer.headers), 300);
    const viaHeader = await call(server, "GET", "/protocols", { headers: { "x-kletia-key": developerKey } });
    assert.equal(rateLimitQuota(viaHeader.headers), 300);
    const operator = await call(server, "GET", "/protocols", { key: OPERATOR_KEY });
    assert.equal(rateLimitQuota(operator.headers), 1_200);
  });

  it("never downgrades a bad credential to the public tier", async () => {
    const unknown = assertError(await call(server, "GET", "/protocols", { key: `kl_dev_${"A".repeat(32)}` }), 401, "INVALID_API_KEY");
    assert.ok(!JSON.stringify(unknown).includes("kl_dev_A"), "the presented key is not echoed");
    const unknownReply = await call(server, "GET", "/protocols", { key: "short" });
    assertError(unknownReply, 401, "INVALID_API_KEY");
    assert.match(unknownReply.headers.get("www-authenticate") ?? "", /^Bearer/u);
    assertError(await call(server, "GET", "/protocols", { headers: { authorization: "Basic dXNlcjpwYXNz" } }), 401, "INVALID_AUTHORIZATION");
    assertError(
      await call(server, "GET", "/protocols", { headers: { authorization: `Bearer ${developerKey}`, "x-kletia-key": OPERATOR_KEY } }),
      401,
      "INVALID_AUTHORIZATION",
    );
    assertError(await call(server, "GET", "/protocols", { key: "x".repeat(300) }), 401, "INVALID_API_KEY");
  });

  it("requires a key for intent listing and webhooks", async () => {
    assertError(await call(server, "GET", "/intents"), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "GET", "/webhooks"), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", "/webhooks", { body: { url: PUBLIC_HOOK } }), 401, "API_KEY_REQUIRED");
    const listed = await call<{ intents: unknown[] }>(server, "GET", "/intents", { key: developerKey });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.intents, []);
  });
});

describe("rate limits", () => {
  it("limits the public tier to 30/min per IP with Retry-After", async () => {
    const server = await servePlatform();
    try {
      for (let index = 0; index < 30; index += 1) assert.equal((await call(server, "GET", "/protocols")).status, 200);
      const limited = assertError(await call(server, "GET", "/protocols"), 429, "RATE_LIMITED");
      assert.match(limited.error.message, /30 requests per minute/u);
    } finally {
      await server.close();
    }
  });

  it("counts requests with a rejected key against the caller's IP", async () => {
    const server = await servePlatform();
    try {
      for (let index = 0; index < 30; index += 1) {
        assert.equal((await call(server, "GET", "/protocols", { key: `kl_dev_${"B".repeat(32)}` })).status, 401);
      }
      const limited = await call(server, "GET", "/protocols");
      assertError(limited, 429, "RATE_LIMITED");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    } finally {
      await server.close();
    }
  });

  it("issues at most 5 developer keys per hour per IP", async () => {
    const server = await servePlatform();
    try {
      for (let index = 0; index < 5; index += 1) await issueKey(server, `k${index}`);
      const limited = assertError(await call(server, "POST", "/keys", { body: { name: "sixth" } }), 429, "RATE_LIMITED");
      assert.match(limited.error.message, /per hour/u);
    } finally {
      await server.close();
    }
  });
});

/* ============================================================ validation & errors */

describe("request validation and error envelope", () => {
  let server: TestServer;
  let key: string;
  let intentId: string;
  before(async () => {
    resetEngine();
    server = await servePlatform();
    key = await issueKey(server);
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body: SWAP, key });
    intentId = created.body.intent.id;
  });
  after(() => server.close());

  it("answers unknown paths with 404 and wrong methods with 405 + Allow", async () => {
    const missing = assertError(await call(server, "GET", "/nope", { key }), 404, "NOT_FOUND");
    assert.match(missing.error.message, /openapi\.json/u);
    const health = await call(server, "DELETE", "/health", { key });
    assertError(health, 405, "METHOD_NOT_ALLOWED");
    assert.equal(health.headers.get("allow"), "GET, HEAD");
    const intents = await call(server, "PUT", "/intents", { key, body: {} });
    assertError(intents, 405, "METHOD_NOT_ALLOWED");
    assert.deepEqual((intents.headers.get("allow") ?? "").split(", ").sort(), ["GET", "HEAD", "POST"]);
  });

  it("rejects malformed JSON, other media types and oversized bodies", async () => {
    assertError(await call(server, "POST", "/intents", { key, raw: "{\"text\":", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON");
    assertError(await call(server, "POST", "/intents", { key, raw: "\"just a string\"", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON");
    assertError(await call(server, "POST", "/intents", { key, raw: "text=swap", headers: { "content-type": "text/plain" } }), 415, "UNSUPPORTED_MEDIA_TYPE");
    const big = JSON.stringify({ text: "x".repeat(70 * 1024), accounts: ACCOUNTS });
    assertError(await call(server, "POST", "/intents", { key, raw: big, headers: { "content-type": "application/json" } }), 413, "PAYLOAD_TOO_LARGE");
  });

  it("enforces the 64 KB limit on chunked bodies, also behind an app-wide JSON parser", async () => {
    const chunked = async (target: TestServer) => {
      const chunk = new TextEncoder().encode(JSON.stringify({ text: "y".repeat(70 * 1024), accounts: ACCOUNTS }));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const response = await fetch(`${target.base}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      return { status: response.status, body: (await response.json()) as ErrorEnvelope };
    };
    const direct = await chunked(server);
    assert.equal(direct.status, 413);
    assert.equal(direct.body.error.code, "PAYLOAD_TOO_LARGE");
    const behindParser = await serve((app) => {
      app.use(express.json({ limit: "1mb" }));
      app.use("/v1", createPlatformRouter(), platformErrorHandler);
    });
    try {
      const reply = await chunked(behindParser);
      assert.equal(reply.status, 413);
      assert.equal(reply.body.error.code, "PAYLOAD_TOO_LARGE");
    } finally {
      await behindParser.close();
    }
  });

  it("formats errors from an app-wide JSON parser in the v1 envelope", async () => {
    const app = await serve((target) => {
      target.use(express.json());
      target.use("/v1", createPlatformRouter(), platformErrorHandler);
    });
    try {
      assertError(await call(app, "POST", "/intents", { raw: "{nope", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON");
    } finally {
      await app.close();
    }
  });

  it("validates intent, step and webhook ids before touching the engine", async () => {
    assertError(await call(server, "GET", "/intents/int_123", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", `/intents/int_${"0".repeat(32)}`, { key }), 404, "INTENT_NOT_FOUND");
    assertError(await call(server, "POST", `/intents/${intentId}/steps/s0/prepare`, { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intentId}/steps/s1000/prepare`, { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${intentId}/steps/s9/prepare`, { key }), 404, "STEP_NOT_FOUND");
    assertError(await call(server, "DELETE", "/webhooks/not-a-webhook", { key }), 400, "INVALID_REQUEST");
  });

  it("answers broken percent-encoding with 400, not 500", async () => {
    assertError(await call(server, "GET", "/intents/%E0%A4%A", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/portfolio/%ZZ", { key }), 400, "INVALID_REQUEST");
  });

  it("validates query parameters", async () => {
    assertError(await call(server, "GET", "/intents?limit=0", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/intents?limit=abc", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/intents?dryRun=maybe", { key, body: SWAP }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/portfolio/not-an-account", { key }), 400, "INVALID_REQUEST");
  });

  it("validates submit bodies against the engine's per-step transaction limit", async () => {
    const path = `/intents/${intentId}/steps/s1/submit`;
    assertError(await call(server, "POST", path, { key, body: {} }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", path, { key, body: { references: [] } }), 400, "INVALID_REQUEST");
    const tooMany = assertError(
      await call(server, "POST", path, { key, body: { references: Array.from({ length: 5 }, randomSolanaSignature) } }),
      400,
      "INVALID_REQUEST",
    );
    assert.match(tooMany.error.message, /1-4/u);
    const malformed = assertError(await call(server, "POST", path, { key, body: { references: ["0x12;drop"] } }), 400, "INVALID_REQUEST");
    assert.equal(malformed.error.issues?.[0]?.path, "references[0]");
  });

  it("returns INTENT_UNSUPPORTED with grammar hints instead of guessing", async () => {
    const reply = assertError(await call(server, "POST", "/intents", { key, body: { text: "make me rich quickly", accounts: ACCOUNTS } }), 422, "INTENT_UNSUPPORTED");
    assert.ok((reply.error.hints?.length ?? 0) > 0, "hints present");
  });

  it("accepts both quote body shapes and validates them", async () => {
    const nested = await call<{ routes: { protocol: string; network: string; toNetwork: string }[]; best: { protocol: string } | null }>(
      server, "POST", "/quotes",
      { key, body: { from: { network: "solana", asset: "SOL", amount: "1", account: `solana:${CHAINS.solana.reference}:${SOL_ADDRESS}` }, to: { asset: "USDC" } } },
    );
    assert.equal(nested.status, 200, JSON.stringify(nested.body));
    assert.equal(nested.body.best?.protocol, "jupiter");
    assert.equal(nested.body.routes[0]?.toNetwork, "solana", "to.network defaults to from.network");
    const flat = await call<{ best: { protocol: string } | null }>(server, "POST", "/quotes", { key, body: { network: "solana", from: "SOL", to: "USDC", amount: "1" } });
    assert.equal(flat.body.best?.protocol, "jupiter");
    const invalid = assertError(await call(server, "POST", "/quotes", { key, body: { network: "nowhere", from: "SOL", to: "USDC", amount: "-1" } }), 400, "INVALID_REQUEST");
    assert.ok((invalid.error.issues ?? []).some((issue) => issue.path === "network"));
  });

  it("never leaks internal error details", async () => {
    class BrokenStore extends MemoryIntentStore {
      override async get(): Promise<IntentGraph | null> {
        throw new Error("connect postgres://admin:hunter2@10.0.0.5/kletia failed");
      }
    }
    const original = console.error;
    console.error = () => undefined;
    try {
      configurePlatform({ store: new BrokenStore() });
      const reply = assertError(await call(server, "GET", `/intents/${intentId}`, { key }), 500, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(reply).includes("hunter2"));
    } finally {
      console.error = original;
      resetEngine();
    }
  });
});

/* ============================================================ intents end to end */

describe("intent lifecycle over HTTP", () => {
  let server: TestServer;
  let key: string;
  before(async () => {
    server = await servePlatform();
    key = await issueKey(server);
  });
  beforeEach(() => {
    resetEngine();
  });
  after(() => server.close());

  it("stores with 201, replays a clientReference with 200 + Idempotent-Replayed and dry-runs with 200", async () => {
    const body = { ...SWAP, clientReference: "order-1029" };
    const first = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("idempotent-replayed"), null);
    const replay = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.body.intent.id, first.body.intent.id);
    const keyless = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body });
    assert.equal(keyless.status, 201, "idempotency is scoped to API keys");
    assert.notEqual(keyless.body.intent.id, first.body.intent.id);
    const dry = await call<{ intent: IntentGraph }>(server, "POST", "/intents?dryRun=true", { key, body: SWAP });
    assert.equal(dry.status, 200);
    assertError(await call(server, "GET", `/intents/${dry.body.intent.id}`), 404, "INTENT_NOT_FOUND");
    const listed = await call<{ intents: IntentGraph[] }>(server, "GET", "/intents?limit=10", { key });
    assert.deepEqual(listed.body.intents.map((intent) => intent.id), [first.body.intent.id]);
  });

  it("prepares, refuses foreign references with 422 leaving the step unchanged, then settles", async () => {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
    const id = created.body.intent.id;
    const prepared = await call<{ payload: { vm: string; transactions: { feePayer?: string }[]; quoteBinding: string }; intent: IntentGraph }>(
      server, "POST", `/intents/${id}/steps/s1/prepare`, { key },
    );
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.payload.vm, "svm");
    assert.equal(prepared.body.payload.transactions[0]?.feePayer, SOL_ADDRESS);
    assert.equal(prepared.body.intent.steps[0]?.status, "awaiting_signature");
    const submit = `/intents/${id}/steps/s1/submit`;
    assertError(await call(server, "POST", submit, { key, body: { references: [randomEvmHash()] } }), 400, "REFERENCE_INVALID");
    stub.verify = () => ({ status: "failed", evidence: [], failure: { code: "REFERENCE_WRONG_SENDER", message: "fee payer is another account" } });
    const rejected = assertError(await call(server, "POST", submit, { key, body: { references: [randomSolanaSignature()] } }), 422, "REFERENCE_WRONG_SENDER");
    assert.equal(rejected.error.issues?.[0]?.path, "references");
    const unchanged = await call<{ intent: IntentGraph }>(server, "GET", `/intents/${id}`);
    assert.equal(unchanged.body.intent.steps[0]?.status, "awaiting_signature");
    assert.equal(unchanged.body.intent.steps[0]?.references, undefined);
    stub.verify = (context) => ({
      status: "confirmed",
      evidence: [{ kind: "transaction", network: "solana", reference: context.references[0] as string, observedAt: new Date().toISOString() }],
    });
    const settled = await call<{ intent: IntentGraph }>(server, "POST", submit, { key, body: { references: [randomSolanaSignature()] } });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.intent.status, "completed");
    assert.equal(settled.body.intent.steps[0]?.status, "settled");
    assertError(await call(server, "POST", `/intents/${id}/cancel`), 409, "INTENT_NOT_CANCELLABLE");
    assertError(await call(server, "POST", `/intents/${id}/steps/s1/prepare`), 409, "INTENT_COMPLETED");
    assert.equal((await call(server, "POST", `/intents/${id}/refresh`)).status, 200);
  });

  it("returns 409 for a step whose dependency has not settled", async () => {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", {
      key,
      body: { text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS },
    });
    assert.equal(created.status, 201);
    assertError(await call(server, "POST", `/intents/${created.body.intent.id}/steps/s2/prepare`), 409, "STEP_NOT_READY");
  });
});

/* ============================================================ SSE */

describe("GET /v1/intents/{id}/events (SSE)", () => {
  let server: TestServer;
  let key: string;
  before(async () => {
    resetEngine();
    server = await servePlatform({ stream: { heartbeatMs: 40, maxDurationMs: 60_000 } });
    key = await issueKey(server);
  });
  after(() => server.close());

  async function createIntentId(): Promise<string> {
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
    assert.equal(created.status, 201);
    return created.body.intent.id;
  }

  it("replays the buffer, streams live events and resumes after Last-Event-ID", async () => {
    const id = await createIntentId();
    const stream = await openSse(server, `/intents/${id}/events`, { authorization: `Bearer ${key}` });
    try {
      assert.equal(stream.status, 200);
      assert.match(String(stream.headers["content-type"]), /^text\/event-stream/u);
      assert.equal(stream.headers["cache-control"], "no-store, no-transform");
      assert.equal((await stream.next()).retry, "3000");
      const created = await stream.next();
      assert.equal(created.event, "intent.created");
      assert.match(created.id ?? "", /^evt_[0-9a-f]{32}$/u);
      const envelope = JSON.parse(created.data ?? "{}") as { id: string; type: string; data: { intentId: string } };
      assert.equal(envelope.id, created.id);
      assert.equal(envelope.data.intentId, id);
      const ready = await stream.until((frame) => frame.event === "intent.step_updated");
      assert.equal((JSON.parse(ready.data ?? "{}") as { data: { status: string } }).data.status, "ready");
      assert.ok((await stream.until((frame) => frame.comment?.startsWith("heartbeat") === true)).comment, "heartbeat comment");
      assert.equal((await call(server, "POST", `/intents/${id}/cancel`, { key })).status, 200);
      const skipped = await stream.until((frame) => frame.event === "intent.step_updated");
      assert.equal((JSON.parse(skipped.data ?? "{}") as { data: { status: string } }).data.status, "skipped");
      const cancelled = await stream.until((frame) => frame.event === "intent.status_changed");
      assert.equal((JSON.parse(cancelled.data ?? "{}") as { data: { status: string } }).data.status, "cancelled");
      const resumed = await openSse(server, `/intents/${id}/events`, { authorization: `Bearer ${key}`, "last-event-id": created.id ?? "" });
      try {
        assert.equal((await resumed.next()).retry, "3000");
        const first = await resumed.until((frame) => frame.event !== undefined);
        assert.notEqual(first.id, created.id, "events up to Last-Event-ID are not replayed");
        assert.equal(first.event, "intent.step_updated");
      } finally {
        resumed.close();
      }
      const since = await openSse(server, `/intents/${id}/events?since=${cancelled.id ?? ""}`, { authorization: `Bearer ${key}` });
      try {
        assert.equal((await since.next()).retry, "3000");
        assert.ok((await since.next()).comment?.startsWith("heartbeat"), "nothing after the newest event");
      } finally {
        since.close();
      }
    } finally {
      stream.close();
    }
    await waitFor(() => openStreamCount() === 0, 2_000, "stream slots released");
  });

  it("validates the intent id, the resume id and answers HEAD", async () => {
    assertError(await call(server, "GET", `/intents/int_${"f".repeat(32)}/events`, { key }), 404, "INTENT_NOT_FOUND");
    const id = await createIntentId();
    assertError(await call(server, "GET", `/intents/${id}/events?since=evt_bad`, { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", `/intents/${id}/events`, { key, headers: { "last-event-id": "nope" } }), 400, "INVALID_REQUEST");
    const head = await fetch(`${server.base}/intents/${id}/events`, { method: "HEAD", headers: { authorization: `Bearer ${key}` } });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /^text\/event-stream/u);
    assert.equal(openStreamCount(), 0, "HEAD holds no stream");
  });

  it("caps open streams per client and releases slots on disconnect", async () => {
    const id = await createIntentId();
    const streams: SseClient[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const stream = await openSse(server, `/intents/${id}/events`, { authorization: `Bearer ${key}` });
        assert.equal(stream.status, 200);
        streams.push(stream);
      }
      assert.equal(openStreamCount(), 10);
      const refused = await call(server, "GET", `/intents/${id}/events`, { key });
      assertError(refused, 429, "TOO_MANY_STREAMS");
      assert.equal(refused.headers.get("retry-after"), "30");
    } finally {
      for (const stream of streams) stream.close();
    }
    await waitFor(() => openStreamCount() === 0, 2_000, "all slots released");
  });

  it("allocates nothing for a client that disconnects while the intent is being read", async () => {
    const id = await createIntentId();
    const original: IntentStore = getIntentStore();
    assert.ok(await original.get(id), "intent stored");
    let reads = 0;
    class SlowStore extends MemoryIntentStore {
      override async get(intentId: string): Promise<IntentGraph | null> {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return original.get(intentId);
      }
    }
    configurePlatform({ store: new SlowStore() });
    try {
      for (let index = 0; index < 3; index += 1) {
        const request = http.get({ host: "127.0.0.1", port: server.port, path: `/v1/intents/${id}/events`, headers: { authorization: `Bearer ${key}` } });
        request.on("error", () => undefined);
        await waitFor(() => reads > index, 1_000, "the server to start reading the intent");
        request.destroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(openStreamCount(), 0, "no stream slot leaked");
    } finally {
      configurePlatform({ store: original });
    }
  });

  it("ends a stream at its maximum lifetime", async () => {
    const short = await servePlatform({ stream: { heartbeatMs: 1_000, maxDurationMs: 150 } });
    try {
      const shortKey = await issueKey(short);
      const created = await call<{ intent: IntentGraph }>(short, "POST", "/intents", { key: shortKey, body: SWAP });
      const stream = await openSse(short, `/intents/${created.body.intent.id}/events`, { authorization: `Bearer ${shortKey}` });
      const last = await stream.until((frame) => frame.comment?.includes("lifetime") === true, 2_000);
      assert.match(last.comment ?? "", /reconnect with Last-Event-ID/u);
      await stream.ended;
      await waitFor(() => openStreamCount() === 0, 1_000, "slot released at lifetime");
    } finally {
      await short.close();
    }
  });
});

/* ============================================================ webhooks */

describe("webhooks", () => {
  let server: TestServer;
  let key: string;
  let otherKey: string;
  const deliveries: { url: string; body: string; headers: Record<string, string> }[] = [];
  let respond: (attempt: number) => number = () => 204;
  let stopBackground: () => void = () => undefined;

  const transport: WebhookTransport = async (url, body, headers) => {
    deliveries.push({ url: url.toString(), body, headers: { ...headers } });
    return respond(Number(headers["kletia-delivery-attempt"]));
  };

  before(async () => {
    resetEngine();
    server = await servePlatform();
    key = await issueKey(server, "hooks");
    otherKey = await issueKey(server, "other");
    stopBackground = startPlatformBackground({ webhookTransport: transport, poller: { intervalMs: 60_000 } });
  });
  after(async () => {
    stopBackground();
    await server.close();
  });

  it("never seals persisted secrets with the published development key", async () => {
    const secretsModule = fileURLToPath(new URL("../secrets.ts", import.meta.url));
    const probe = `const m = await import(${JSON.stringify(secretsModule)}); process.stdout.write(m.platformSecretStatus());`;
    const run = async (env: Record<string, string>) => {
      const { KLETIA_DATABASE_URL: _db, KLETIA_PLATFORM_SECRET: _secret, NODE_ENV: _env, ...inherited } = process.env;
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: { ...inherited, ...env },
      });
      return stdout.trim();
    };
    assert.equal(await run({}), "development_fallback");
    assert.equal(await run({ KLETIA_DATABASE_URL: "postgres://kletia@127.0.0.1:1/never-connected" }), "missing");
    assert.equal(await run({ NODE_ENV: "production" }), "missing");
    assert.equal(await run({ NODE_ENV: "production", KLETIA_PLATFORM_SECRET: "too-short" }), "missing");
    assert.equal(await run({ NODE_ENV: "production", KLETIA_PLATFORM_SECRET: "s".repeat(32) }), "configured");
  });

  it("refuses non-HTTPS, credentialed, private, loopback, link-local and metadata targets", async () => {
    const cases: readonly (readonly [string, number, string])[] = [
      ["http://93.184.215.14/hook", 400, "INVALID_REQUEST"],
      ["https://user:pass@93.184.215.14/hook", 400, "INVALID_REQUEST"],
      ["https://93.184.215.14/hook#fragment", 400, "INVALID_REQUEST"],
      ["not a url", 400, "INVALID_REQUEST"],
      ["https://127.0.0.1/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://2130706433/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://0x7f.0.0.1/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://10.1.2.3:8443/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://192.168.1.10:8443/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://100.100.100.200/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://169.254.169.254/latest/meta-data", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://[::1]/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://[::ffff:127.0.0.1]/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://[fd00:ec2::254]/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://[fe80::1]/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://localhost/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://metadata.google.internal/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://intranet/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
      ["https://93.184.215.14:22/hook", 422, "WEBHOOK_URL_FORBIDDEN"],
    ];
    for (const [url, status, code] of cases) {
      const reply = await call(server, "POST", "/webhooks", { key, body: { url } });
      assert.equal(reply.status, status, `${url} -> ${JSON.stringify(reply.body)}`);
      assert.equal((reply.body as ErrorEnvelope).error.code, code, url);
    }
    assertError(await call(server, "POST", "/webhooks", { key, body: { url: PUBLIC_HOOK, events: ["intent.nope"] } }), 400, "INVALID_REQUEST");
  });

  it("classifies addresses for the connect-time guard", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:10.0.0.1", "fd00:ec2::254", "fe80::1", "64:ff9b::a00:1", "2002:7f00:1::"]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ["93.184.215.14", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
      assert.equal(isPublicAddress(address), true, address);
    }
    assert.equal(isPublicAddress("example.com"), false, "names are never addresses");
  });

  it("registers, lists without secrets, refuses duplicates, scopes per key and deletes", async () => {
    const created = await call<{ webhook: { id: string; url: string; secret?: string; events: string[] } }>(server, "POST", "/webhooks", { key, body: { url: PUBLIC_HOOK } });
    assert.equal(created.status, 201);
    assert.match(created.body.webhook.id, /^wh_[0-9a-f]{24}$/u);
    assert.match(created.body.webhook.secret ?? "", /^whsec_[0-9A-Za-z]{32}$/u);
    // Without `events`: every type that exists now, contract registration events included.
    assert.deepEqual(created.body.webhook.events, [
      "intent.created",
      "intent.status_changed",
      "intent.step_updated",
      "contract.registered",
      "contract.activated",
      "contract.suspended",
      "contract.reactivated",
    ]);
    const listed = await call<{ webhooks: Record<string, unknown>[] }>(server, "GET", "/webhooks", { key });
    assert.equal(listed.body.webhooks.length, 1);
    assert.equal("secret" in (listed.body.webhooks[0] ?? {}), false);
    assertError(await call(server, "POST", "/webhooks", { key, body: { url: PUBLIC_HOOK } }), 409, "WEBHOOK_EXISTS");
    assert.deepEqual((await call<{ webhooks: unknown[] }>(server, "GET", "/webhooks", { key: otherKey })).body.webhooks, []);
    assertError(await call(server, "DELETE", `/webhooks/${created.body.webhook.id}`, { key: otherKey }), 404, "WEBHOOK_NOT_FOUND");
    const removed = await call(server, "DELETE", `/webhooks/${created.body.webhook.id}`, { key });
    assert.equal(removed.status, 204);
    assertError(await call(server, "DELETE", `/webhooks/${created.body.webhook.id}`, { key }), 404, "WEBHOOK_NOT_FOUND");
  });

  it("delivers signed events for the key's intents only, and retries failures", async () => {
    const created = await call<{ webhook: { id: string; secret: string } }>(server, "POST", "/webhooks", {
      key,
      body: { url: `${PUBLIC_HOOK}/deliveries`, events: ["intent.created"] },
    });
    assert.equal(created.status, 201);
    const { id: webhookId, secret } = created.body.webhook;
    deliveries.length = 0;
    respond = () => 204;
    const keyless = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { body: SWAP });
    const owned = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key, body: SWAP });
    const foreign = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key: otherKey, body: SWAP });
    await waitFor(() => deliveries.length >= 1, 2_000, "a delivery");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deliveries.length, 1, "only intent.created of the key's own intent");
    const [delivery] = deliveries;
    assert.ok(delivery);
    const event = JSON.parse(delivery.body) as { id: string; type: string; data: { intentId: string } };
    assert.equal(event.type, "intent.created");
    assert.equal(event.data.intentId, owned.body.intent.id);
    assert.notEqual(event.data.intentId, keyless.body.intent.id);
    assert.notEqual(event.data.intentId, foreign.body.intent.id);
    assert.equal(delivery.url, `${PUBLIC_HOOK}/deliveries`);
    assert.equal(delivery.headers["kletia-event-id"], event.id);
    assert.equal(delivery.headers["kletia-event-type"], "intent.created");
    assert.equal(delivery.headers["kletia-webhook-id"], webhookId);
    assert.equal(delivery.headers["kletia-delivery-attempt"], "1");
    assert.equal(delivery.headers["content-type"], "application/json");
    const verification = await verifyWebhookSignature(secret, delivery.body, delivery.headers["kletia-signature"]);
    assert.equal(verification.valid, true);
    assert.equal((await verifyWebhookSignature(secret, `${delivery.body} `, delivery.headers["kletia-signature"])).valid, false);

    deliveries.length = 0;
    respond = (attempt) => (attempt === 1 ? 500 : 200);
    await call(server, "POST", "/intents", { key, body: SWAP });
    await waitFor(() => deliveries.length >= 2, 3_000, "a retried delivery");
    assert.deepEqual(deliveries.map((entry) => entry.headers["kletia-delivery-attempt"]), ["1", "2"]);
    assert.equal(deliveries[0]?.body, deliveries[1]?.body, "a retry re-sends the same event");
    assert.equal((await verifyWebhookSignature(secret, deliveries[1]?.body ?? "", deliveries[1]?.headers["kletia-signature"])).valid, true);
  });
});
