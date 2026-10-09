/**
 * GET /v1/usage: per-key counts by route template and status class, the
 * hourly series, the live rate-limit window, intents by status and the
 * last-used time; plus the usage store contract (memory, and Postgres when
 * KLETIA_TEST_DATABASE_URL is set).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { configurePlatform } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const usage = await import("../usage.js");
const { closePlatformDatabase } = await import("../db.js");

type UsageReport = import("../usage.js").UsageReport;

let server: TestServer;

async function issue(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key;
}

before(async () => {
  resetEngine();
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  configurePlatform({ adapters: null });
  await server.close();
});

describe("GET /v1/usage", () => {
  it("counts the key's requests by route template and status class", async () => {
    const { id, key } = await issue("usage");
    const other = await issue("usage-other");
    for (let index = 0; index < 3; index += 1) assert.equal((await call(server, "GET", "/protocols", { key })).status, 200);
    assertError(await call(server, "GET", `/intents/int_${"0".repeat(32)}`, { key }), 404, "INTENT_NOT_FOUND");
    assertError(await call(server, "GET", "/nope", { key }), 404, "NOT_FOUND");
    const created = await call(server, "POST", "/intents", { key, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    assert.equal(created.status, 201);
    await call(server, "GET", "/protocols", { key: other.key });
    await call(server, "GET", "/protocols");

    const reply = await call<UsageReport>(server, "GET", "/usage", { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const report = reply.body;
    assert.equal(report.keyId, id);
    assert.equal(report.tier, "developer");
    assert.equal(report.window, "24h");
    const routes = new Map(report.byRoute.map((entry) => [entry.route, entry]));
    assert.equal(routes.get("GET /protocols")?.requests, 3, "only this key's requests");
    assert.equal(routes.get("GET /intents/:id")?.byStatusClass["4xx"], 1);
    assert.equal(routes.get("GET (unmatched)")?.requests, 1);
    assert.equal(routes.get("POST /intents")?.byStatusClass["2xx"], 1);
    assert.equal(report.totals.requests, 6);
    assert.deepEqual(report.totals.byStatusClass, { "2xx": 4, "4xx": 2 });
    assert.equal(report.series.length, 24);
    assert.equal(report.series.reduce((sum, entry) => sum + entry.requests, 0), 6);
    assert.equal(report.series.at(-1)?.requests, 6, "this hour is the last entry");
    assert.equal(report.rateLimit.limit, 300);
    assert.ok(report.rateLimit.remaining <= 300 - 7, `remaining ${report.rateLimit.remaining}`);
    assert.ok(report.rateLimit.resetAt && Date.parse(report.rateLimit.resetAt) > Date.now());
    assert.deepEqual(report.intents, { created: 1, byStatus: { planned: 1 } });

    const week = await call<UsageReport>(server, "GET", "/usage?window=7d", { key });
    assert.equal(week.body.series.length, 168);
    assert.ok(week.body.totals.requests >= 7, "the first report counts too");
    assertError(await call(server, "GET", "/usage?window=1y", { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/usage"), 401, "API_KEY_REQUIRED");

    const keys = await call<{ keys: { id: string; lastUsedAt: string | null }[] }>(server, "GET", "/keys", { key });
    assert.ok(keys.body.keys.find((entry) => entry.id === id)?.lastUsedAt, "last use is recorded");
  });

  it("reports operator keys at the operator limit", async () => {
    const reply = await call<UsageReport>(server, "GET", "/usage", { key: OPERATOR_KEY });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.tier, "operator");
    assert.equal(reply.body.rateLimit.limit, 1_200);
  });
});

/* ------------------------------------------------------------ store contract */

function contract(name: string, make: () => import("../usage.js").UsageStore): void {
  describe(`${name} usage store`, () => {
    it("sums counts per key, hour, route and class and prunes old hours", async () => {
      const store = make();
      const keyId = `key_${randomBytes(12).toString("hex")}`;
      const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const old = new Date(Date.parse(hour) - 9 * 86_400_000).toISOString();
      const row = { keyId, hour, route: "GET /protocols", statusClass: "2xx", count: 2 };
      await store.add([row, { ...row, statusClass: "4xx", count: 1 }, { ...row, hour: old, count: 5 }]);
      await store.add([{ ...row, count: 3 }]);
      const rows = await store.read(keyId, hour);
      const byClass = Object.fromEntries(rows.map((entry) => [entry.statusClass, entry.count]));
      assert.deepEqual(byClass, { "2xx": 5, "4xx": 1 });
      assert.equal((await store.read(keyId, old)).length, 3);
      await store.prune(new Date(Date.parse(hour) - 8 * 86_400_000).toISOString());
      assert.equal((await store.read(keyId, old)).length, 2);
      assert.deepEqual(await store.read(`key_${"f".repeat(24)}`, old), []);
    });
  });
}

contract("memory", () => new usage.MemoryUsageStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    });
    contract("postgres", () => new usage.PostgresUsageStore());
  });
} else {
  describe("postgres usage store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
