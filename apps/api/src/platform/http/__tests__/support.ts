/**
 * Shared HTTP test helpers: serve the /v1 router on an ephemeral port and
 * call it with fetch. Test files fix the environment (operator keys, no
 * database, no platform secret) before importing the router, because stores
 * and keys are resolved lazily from it.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";

export const OPERATOR_KEY = "op_test_key_0123456789abcdefghijklmnop";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** In-memory stores, the development sealing key and one operator key. Call before importing the router. */
export function useTestEnvironment(): void {
  process.env.KLETIA_OPERATOR_API_KEYS = OPERATOR_KEY;
  delete process.env.KLETIA_DATABASE_URL;
  delete process.env.KLETIA_PLATFORM_SECRET;
  delete process.env.KLETIA_MCP_ALLOWED_ORIGINS;
  delete process.env.KLETIA_WEB_ORIGIN;
  if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
}

export interface TestServer {
  readonly base: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function serve(mount: (app: Express) => void): Promise<TestServer> {
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

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly { path: string; message: string }[];
    readonly hints?: readonly string[];
    readonly docs?: string;
  };
  readonly requestId: string;
}

export interface Reply<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface CallOptions {
  readonly body?: unknown;
  readonly key?: string;
  readonly headers?: Record<string, string>;
  readonly raw?: string;
}

export async function call<T = unknown>(server: TestServer, method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
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

export function assertError(reply: Reply<unknown>, status: number, code: string): ErrorEnvelope {
  const body = reply.body as ErrorEnvelope;
  assert.equal(reply.status, status, `expected ${status} ${code}, got ${reply.status} ${JSON.stringify(reply.body)}`);
  assert.equal(body.error?.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.match(body.requestId, UUID);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  return body;
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000, message = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Runs `task` while holding a session-level Postgres advisory lock named `name`. `node --test`
 * runs test files in parallel processes against one shared test database, so sections that
 * depend on global state there (the receipt transparency log) serialise on this lock. Without a
 * database URL the task runs unlocked.
 */
export async function withDatabaseTestLock<T>(databaseUrl: string | undefined, name: string, task: () => Promise<T>): Promise<T> {
  if (!databaseUrl) return task();
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`kletia_test:${name}`]);
    return await task();
  } finally {
    await client.end().catch(() => undefined);
  }
}
