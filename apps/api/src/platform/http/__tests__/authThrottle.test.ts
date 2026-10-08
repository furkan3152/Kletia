/**
 * Store lookups of unknown API keys are throttled per client IP before
 * Postgres is queried. KLETIA_DATABASE_URL points at a local listener that
 * counts and drops connections, so every lookup that reaches the store is one
 * counted connection (answered 503), and nothing needs a real database.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/authThrottle.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

const OPERATOR_KEY = "op_test_key_0123456789abcdefghijklmnop";

let connections = 0;
const database = net.createServer((socket) => {
  connections += 1;
  socket.destroy();
});
database.listen(0, "127.0.0.1");
await once(database, "listening");

process.env.KLETIA_DATABASE_URL = `postgres://kletia@127.0.0.1:${(database.address() as AddressInfo).port}/kletia`;
process.env.KLETIA_PLATFORM_SECRET = "throttle-test-secret-0123456789abcdef";
process.env.KLETIA_OPERATOR_API_KEYS = OPERATOR_KEY;
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

// Loaded after the environment is fixed: the key store is chosen lazily from it.
const { closePlatformDatabase, createPlatformRouter, platformErrorHandler, TIER_LIMITS } = await import("../index.js");

interface TestServer {
  readonly base: string;
  close(): Promise<void>;
}

/** A fresh router (fresh tier rate-limit windows) on an ephemeral port. */
async function servePlatform(): Promise<TestServer> {
  const app = express();
  app.use("/v1", createPlatformRouter(), platformErrorHandler);
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Reply {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly retryAfter: string | null;
}

async function get(server: TestServer, path: string, key?: string): Promise<Reply> {
  const response = await fetch(`${server.base}${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
  const body = (await response.json()) as { error?: { code: string; message: string } };
  return { status: response.status, code: body.error?.code, message: body.error?.message, retryAfter: response.headers.get("retry-after") };
}

/** A well-formed developer key that was never issued. */
function unknownKey(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `kl_dev_${[...randomBytes(32)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

describe("API key lookup throttle", () => {
  const quietError = console.error;
  before(() => {
    // Every refused connection is logged by the store; keep the output readable.
    console.error = () => undefined;
  });
  after(async () => {
    console.error = quietError;
    await closePlatformDatabase();
    database.close();
  });

  it("bounds store queries for unknown keys per IP, even when the tier limiter has a fresh window", async () => {
    const first = await servePlatform();
    try {
      const statuses: number[] = [];
      for (let index = 0; index < TIER_LIMITS.public + 10; index += 1) statuses.push((await get(first, "/protocols", unknownKey())).status);
      assert.deepEqual(statuses.slice(0, TIER_LIMITS.public), Array(TIER_LIMITS.public).fill(503), "lookups within the budget reach the (failing) store");
      assert.deepEqual(statuses.slice(TIER_LIMITS.public), Array(10).fill(429));
      assert.equal(connections, TIER_LIMITS.public, "throttled requests never open a database connection");
    } finally {
      await first.close();
    }

    // A new router has a fresh tier window; the lookup budget is per IP, not per window of one limiter.
    const second = await servePlatform();
    try {
      const throttled = await get(second, "/protocols", unknownKey());
      assert.equal(throttled.status, 429);
      assert.equal(throttled.code, "RATE_LIMITED");
      assert.match(throttled.message ?? "", /unrecognised API keys/u);
      assert.ok(Number(throttled.retryAfter) >= 1 && Number(throttled.retryAfter) <= 60, `Retry-After ${throttled.retryAfter}`);
      assert.equal(connections, TIER_LIMITS.public, "still no database connection");
      // Callers without a key and operator keys never need a lookup.
      assert.equal((await get(second, "/protocols")).status, 200);
      assert.equal((await get(second, "/protocols", OPERATOR_KEY)).status, 200);
    } finally {
      await second.close();
    }
  });
});
