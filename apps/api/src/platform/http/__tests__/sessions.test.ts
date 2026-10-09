/**
 * Sessions over HTTP: creation by an integrator key (template validation, a
 * dry-run plan, embed URL with the id in the fragment), the public view, and
 * turning a session into an intent for a visitor (origin check, amount
 * bounds, expiry, single use under concurrency, the use given back when the
 * plan fails, the owner key and metadata of the intent), plus the memory and
 * (with KLETIA_TEST_DATABASE_URL) Postgres stores.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/sessions.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { IntentGraph, SessionView } from "@kletia/core";
import { setTimeout as sleep } from "node:timers/promises";
import { EVM_ACCOUNT, resetEngine, SOL_ACCOUNT, STUB_ADAPTERS, stubJupiter } from "../../engine/__tests__/helpers.js";
import { configurePlatform } from "../../engine/service.js";
import { PlatformError } from "../../errors.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_CONTRACTS_ENABLED;

const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureContractClock } = await import("../contracts.js");
const { configureContractEngine } = await import("../contractChecks.js");
const sessions = await import("../sessions.js");
const { issueDeveloperKey } = await import("../auth.js");

const START = Date.parse("2026-10-09T12:00:00.000Z");
let now = START;
const ORIGIN = "https://acme.example";
const SWAP = { kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" };

let server: TestServer;

async function issueKey(name: string): Promise<{ id: string; key: string }> {
  const issued = await issueDeveloperKey(name);
  return { id: issued.id, key: issued.key };
}

async function createSession(key: string, body: Record<string, unknown>): Promise<SessionView> {
  const reply = await call<{ session: SessionView }>(server, "POST", "/sessions", { key, body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.session;
}

function visitor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { accounts: [SOL_ACCOUNT], hostOrigin: ORIGIN, ...extra };
}

before(async () => {
  resetEngine();
  configureContractClock(() => now);
  configureContractEngine({
    engine: { simulationCapability: async () => ({}) },
    checks: { sourcify: async () => ({ verification: { status: "unknown", provider: "sourcify", checkedAt: null }, proxy: null, abi: null }) },
  });
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configureContractClock(null);
  configureContractEngine({ engine: null, checks: null });
  await server.close();
});

beforeEach(() => {
  now = START;
});

describe("POST /v1/sessions", () => {
  it("creates a session from a structured template and returns the embed URL with the id in the fragment", async () => {
    const owner = await issueKey("acme");
    const reply = await call<{ session: SessionView }>(server, "POST", "/sessions", {
      key: owner.key,
      body: {
        actions: [SWAP],
        amount: { action: 0, min: "0.1", max: "5" },
        allowedOrigins: [`${ORIGIN}/`, "http://localhost:5173"],
        expiresInSeconds: 600,
        metadata: { orderId: "A-1029" },
        clientReference: "order-A-1029",
      },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const session = reply.body.session;
    assert.match(session.id, /^cs_[0-9a-f]{32}$/u);
    assert.equal(session.status, "active");
    assert.equal(session.embedUrl, `https://kletiaai.xyz/embed#session=${session.id}`);
    assert.deepEqual(session.allowedOrigins, [ORIGIN, "http://localhost:5173"]);
    assert.equal(session.expiresAt, new Date(START + 600_000).toISOString());
    assert.deepEqual(session.amount, { action: 0, min: "0.1", max: "5", default: "1", symbol: "SOL" });
    assert.equal(session.maxIntents, 1);
    assert.equal(session.used, 0);
    assert.deepEqual(session.integrator, { name: "acme.example", domainVerified: false }, "without a contract step the identity is the first origin");
    assert.match(session.actions[0]?.label ?? "", /swap 1 SOL to USDC/u);
    const text = JSON.stringify(reply.body);
    assert.ok(!text.includes(owner.id), "never the key id");
  });

  it("validates the template", async () => {
    const owner = await issueKey("invalid");
    assertError(await call(server, "POST", "/sessions", { body: { actions: [SWAP], allowedOrigins: [ORIGIN] } }), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { text: "swap 1 SOL to USDC", actions: [SWAP], allowedOrigins: [ORIGIN] } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [SWAP], allowedOrigins: [] } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [SWAP], allowedOrigins: ["https://acme.example/path"] } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [SWAP], allowedOrigins: [ORIGIN], expiresInSeconds: 30 } }), 400, "INVALID_REQUEST");
    assertError(
      await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [SWAP], amount: { action: 0, min: "0.0000000001", max: "2" }, allowedOrigins: [ORIGIN] } }),
      400,
      "INVALID_REQUEST",
    );
    const metadata = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, "v"]));
    assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [SWAP], allowedOrigins: [ORIGIN], metadata } }), 400, "INVALID_REQUEST");
    // A template that cannot plan fails here, not in front of a visitor.
    assertError(
      await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [{ ...SWAP, to: "SOL" }], allowedOrigins: [ORIGIN] } }),
      422,
      "SWAP_SAME_ASSET",
    );
  });

  it("refuses contract steps the key cannot use, and every contract step while contracts are disabled", async () => {
    const owner = await issueKey("contracts");
    const call0 = { kind: "call", network: "base", contract: `ct_${"0".repeat(24)}`, entry: "deposit", amount: "10" };
    const unknown = assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [call0], allowedOrigins: [ORIGIN] } }), 422, "CONTRACT_UNKNOWN");
    assert.equal(unknown.error.issues?.[0]?.path, "actions[0].contract");
    process.env.KLETIA_CONTRACTS_ENABLED = "false";
    try {
      assertError(await call(server, "POST", "/sessions", { key: owner.key, body: { actions: [call0], allowedOrigins: [ORIGIN] } }), 503, "CONTRACTS_DISABLED");
    } finally {
      delete process.env.KLETIA_CONTRACTS_ENABLED;
    }
  });
});

describe("GET /v1/sessions/{id} and POST /v1/sessions/{id}/intents", () => {
  it("serves the public view and creates one intent for the visitor under the session owner's key", async () => {
    const owner = await issueKey("flow");
    const session = await createSession(owner.key, {
      actions: [SWAP],
      amount: { action: 0, min: "0.1", max: "5" },
      allowedOrigins: [ORIGIN],
      metadata: { orderId: "A-7" },
      clientReference: "order-A-7",
    });
    const view = await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.session.embedUrl, undefined, "the embed URL is only in the creation response");
    assert.ok(!JSON.stringify(view.body).includes(owner.id));
    assertError(await call(server, "GET", `/sessions/cs_${"0".repeat(32)}`), 404, "SESSION_NOT_FOUND");
    assertError(await call(server, "GET", "/sessions/cs_short"), 400, "INVALID_REQUEST");

    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor({ hostOrigin: "https://evil.example" }) }), 403, "SESSION_ORIGIN_FORBIDDEN");
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor({ amount: "6" }) }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor({ amount: "0.05" }) }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor({ amount: "1.0000000001" }) }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: { accounts: [SOL_ACCOUNT] } }), 400, "INVALID_REQUEST");

    const created = await call<{ intent: IntentGraph }>(server, "POST", `/sessions/${session.id}/intents`, { body: visitor({ amount: "2.5" }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const intent = created.body.intent;
    assert.equal(intent.metadata?.sessionId, session.id);
    assert.equal(intent.metadata?.orderId, "A-7");
    assert.equal(intent.request.clientReference, "order-A-7");
    assert.equal(intent.steps[0]?.input?.formatted, "2.5");
    assert.deepEqual(intent.request.accounts, [SOL_ACCOUNT]);
    // The integrator's key owns the intent (listing, webhooks).
    const listed = await call<{ intents: IntentGraph[] }>(server, "GET", "/intents", { key: owner.key });
    assert.deepEqual(listed.body.intents.map((entry) => entry.id), [intent.id]);

    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor() }), 409, "SESSION_USED");
    assert.equal((await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`)).body.session.status, "used");
  });

  it("allows exactly one intent per use under concurrency", async () => {
    const owner = await issueKey("race");
    const session = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN], maxIntents: 2 });
    const replies = await Promise.all(Array.from({ length: 8 }, () => call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor() })));
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 201, 409, 409, 409, 409, 409, 409]);
    assert.equal((await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`)).body.session.used, 2);
  });

  it("gives the use back when the plan fails, and expires", async () => {
    const owner = await issueKey("expiry");
    const session = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN], expiresInSeconds: 60 });
    // No Solana account: the plan fails and the session stays usable.
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: { accounts: [EVM_ACCOUNT], hostOrigin: ORIGIN } }), 422, "ACCOUNT_REQUIRED");
    assert.equal((await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`)).body.session.used, 0);
    now = START + 60_000;
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor() }), 410, "SESSION_EXPIRED");
    assert.equal((await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`)).body.session.status, "expired");
  });

  it("never hands one visitor's intent to another through a reused clientReference", async () => {
    const owner = await issueKey("reference");
    const first = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN], clientReference: "order-9" });
    const second = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN], clientReference: "order-9" });
    assert.equal((await call(server, "POST", `/sessions/${first.id}/intents`, { body: visitor() })).status, 201);
    const otherVisitor = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`;
    assertError(await call(server, "POST", `/sessions/${second.id}/intents`, { body: { accounts: [otherVisitor], hostOrigin: ORIGIN } }), 409, "CLIENT_REFERENCE_EXISTS");
    assert.equal((await call<{ session: SessionView }>(server, "GET", `/sessions/${second.id}`)).body.session.used, 0, "the use was given back");
  });

  it("numbers multi-use references by claimed use, so a concurrent failed plan never bricks the session", async () => {
    // A quote that takes a round trip and fails for one wallet: that visitor's use is given back while
    // another visitor's intent, claimed after it, already holds the next reference number.
    const unlucky = "HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg";
    const slowJupiter = {
      ...stubJupiter,
      plan: async (action: Parameters<typeof stubJupiter.plan>[0]) => {
        await sleep(60);
        if (action.account.address === unlucky) throw new PlatformError("QUOTE_UNAVAILABLE", "No route for this wallet right now.", 502);
        return stubJupiter.plan(action);
      },
    };
    configurePlatform({ adapters: [slowJupiter, ...STUB_ADAPTERS.filter((adapter) => adapter !== stubJupiter)] });
    // A router of its own: a fresh public-tier budget for the visitors of this test.
    const server = await serve((app) => {
      app.use("/v1", createPlatformRouter(), platformErrorHandler);
    });
    try {
      const owner = await issueKey("campaign");
      const session = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN], maxIntents: 10, clientReference: "campaign-7" });
      const failing = call(server, "POST", `/sessions/${session.id}/intents`, { body: { accounts: [`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${unlucky}`], hostOrigin: ORIGIN } });
      await sleep(10);
      const succeeding = call<{ intent: IntentGraph }>(server, "POST", `/sessions/${session.id}/intents`, { body: visitor() });
      const [failed, ok] = await Promise.all([failing, succeeding]);
      assertError(failed, 502, "QUOTE_UNAVAILABLE");
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.intent.request.clientReference, "campaign-7:2");
      // Later visitors: each gets a fresh number (3, 4, ...), never the given-back 1 or the taken 2.
      const later = [
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:6Ld9vWuj2dW1WJAxyukvuJ1zZM5cKgpkdaurKRt5T6iP",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:5wvVJvxnru7C5MZKKaSdf6fBSKrBMBzNJRb3qo4FCknK",
      ];
      const references: string[] = [];
      for (const account of later) {
        const reply = await call<{ intent: IntentGraph }>(server, "POST", `/sessions/${session.id}/intents`, { body: { accounts: [account], hostOrigin: ORIGIN } });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        references.push(reply.body.intent.request.clientReference ?? "");
      }
      assert.deepEqual(references, ["campaign-7:3", "campaign-7:4", "campaign-7:5"]);
      const view = (await call<{ session: SessionView }>(server, "GET", `/sessions/${session.id}`)).body.session;
      assert.equal(view.used, 4, "the failed visitor's use was given back; four intents exist");
      assert.equal(view.status, "active");
    } finally {
      configurePlatform({ adapters: STUB_ADAPTERS });
      await server.close();
    }
  });

  it("stops serving sessions of a revoked key", async () => {
    const owner = await issueKey("revoked");
    const session = await createSession(owner.key, { actions: [SWAP], allowedOrigins: [ORIGIN] });
    assert.equal((await call(server, "DELETE", `/keys/${owner.id}`, { key: owner.key })).status, 204);
    assertError(await call(server, "GET", `/sessions/${session.id}`), 404, "SESSION_NOT_FOUND");
    assertError(await call(server, "POST", `/sessions/${session.id}/intents`, { body: visitor() }), 404, "SESSION_NOT_FOUND");
  });
});

describe("session stores", () => {
  function record(owner: string, overrides: Partial<import("../sessions.js").SessionRecord> = {}): import("../sessions.js").SessionRecord {
    return {
      id: `cs_${randomBytes(16).toString("hex")}`,
      ownerKeyId: owner,
      template: { actions: [SWAP as never], labels: ["swap"], integrator: { name: "acme.example", domainVerified: false } },
      allowedOrigins: [ORIGIN],
      maxIntents: 1,
      used: 0,
      issued: 0,
      expiresAt: new Date(START + 60_000).toISOString(),
      createdAt: new Date(START).toISOString(),
      ...overrides,
    };
  }

  async function exercise(store: import("../sessions.js").SessionStore): Promise<void> {
    const owner = `key_${randomBytes(12).toString("hex")}`;
    const nowIso = new Date(START).toISOString();
    const first = record(owner, { maxIntents: 2 });
    await store.create(first, 2, nowIso);
    await store.create(record(owner), 2, nowIso);
    await assert.rejects(store.create(record(owner), 2, nowIso), (error: { code?: string; status?: number }) => error.code === "RATE_LIMITED" && error.status === 429);
    // Expired sessions do not count against the cap.
    const results = await Promise.all(Array.from({ length: 6 }, () => store.use(first.id, nowIso)));
    assert.equal(results.filter((result) => result.state === "used_ok").length, 2);
    assert.equal(results.filter((result) => result.state === "used").length, 4);
    assert.deepEqual(results.flatMap((result) => (result.state === "used_ok" ? [result.record.issued] : [])).sort(), [1, 2]);
    await store.release(first.id);
    assert.equal((await store.get(first.id))?.used, 1);
    assert.equal((await store.get(first.id))?.issued, 2, "a given-back use keeps its number");
    const again = await store.use(first.id, nowIso);
    assert.equal(again.state, "used_ok");
    assert.equal(again.state === "used_ok" ? again.record.issued : null, 3, "the next use is numbered after every number already handed out");
    assert.equal((await store.use(first.id, new Date(START + 61_000).toISOString())).state, "expired");
    assert.equal((await store.use(`cs_${"0".repeat(32)}`, nowIso)).state, "missing");
    await store.create(record(owner), 2, new Date(START + 61_000).toISOString());
    await store.prune(new Date(START + 120_000).toISOString());
    assert.equal(await store.get(first.id), null);
  }

  it("memory: cap, atomic use, release, expiry and pruning", async () => {
    await exercise(new sessions.MemorySessionStore());
  });

  const DATABASE_URL = process.env.KLETIA_TEST_DATABASE_URL?.trim();
  it("postgres: cap, atomic use, release, expiry and pruning", { skip: DATABASE_URL ? false : "KLETIA_TEST_DATABASE_URL not set" }, async () => {
    process.env.KLETIA_DATABASE_URL = DATABASE_URL;
    const { closePlatformDatabase } = await import("../db.js");
    try {
      await exercise(new sessions.PostgresSessionStore());
    } finally {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    }
  });
});
