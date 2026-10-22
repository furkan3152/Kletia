/**
 * Developer accounts on the in-memory stores: the shared flows
 * (accountFlows.ts), plus what only memory makes easy to force: session
 * expiry, an audit log that cannot be written, the production refusal
 * without a database, smart-wallet checks whose RPC fails, and the limits.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { accountFlows, as, evmWallet, nonceFor, PORTAL_ORIGIN, signIn } from "./accountFlows.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { resetAccountLimiters } = await import("../accounts/handlers.js");
const { configureAccountAuth } = await import("../accounts/auth.js");
const { MemoryAccountStore, setAccountStore } = await import("../accounts/store.js");

let server: TestServer;

beforeEach(async () => {
  resetAccountLimiters();
  configureAccountAuth(null);
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

afterEach(async () => {
  configureAccountAuth(null);
  await server.close();
});

describe("developer accounts (memory)", () => {
  accountFlows(() => server);

  it("ends a session after an hour without requests and eight hours after sign-in", async () => {
    let now = Date.now();
    configureAccountAuth({ now: () => new Date(now) });
    const token = await signIn(server, evmWallet());
    now += 59 * 60_000;
    assert.equal((await call(server, "GET", "/accounts/session", { headers: as(token) })).status, 200);
    now += 61 * 60_000;
    assertError(await call(server, "GET", "/accounts/session", { headers: as(token) }), 401, "ACCOUNT_SESSION_REQUIRED");

    const active = await signIn(server, evmWallet());
    for (let step = 0; step < 9; step += 1) {
      now += 50 * 60_000;
      assert.equal((await call(server, "GET", "/accounts/session", { headers: as(active) })).status, 200, `step ${step}`);
    }
    now += 50 * 60_000;
    assertError(await call(server, "GET", "/accounts/session", { headers: as(active) }), 401, "ACCOUNT_SESSION_REQUIRED");
  });

  it("refuses an expired sign-in message", async () => {
    let now = Date.now();
    configureAccountAuth({ now: () => new Date(now) });
    const wallet = evmWallet();
    const { message } = await nonceFor(server, wallet);
    now += 6 * 60_000;
    assertError(await call(server, "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await wallet.sign(message) } }), 401, "ACCOUNT_NONCE_INVALID");
  });

  it("fails closed when the audit log cannot be written (no session, no project)", async () => {
    const store = new MemoryAccountStore();
    setAccountStore(store);
    try {
      const wallet = evmWallet();
      const token = await signIn(server, wallet);
      store.failAuditWrites = true;
      const { message } = await nonceFor(server, wallet);
      assertError(await call(server, "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await wallet.sign(message) } }), 503, "STORE_UNAVAILABLE");
      assertError(await call(server, "POST", "/accounts/projects", { headers: as(token), body: { name: "unaudited" } }), 503, "STORE_UNAVAILABLE");
      store.failAuditWrites = false;
      const projects = await call<{ projects: unknown[] }>(server, "GET", "/accounts/projects", { headers: as(token) });
      assert.deepEqual(projects.body.projects, []);
      const rows = store.auditRows();
      assert.ok(rows.some((row) => row.action === "account.sign_in" && row.outcome === "ok" && row.address === wallet.address.toLowerCase()));
      assert.ok(rows.every((row) => row.requestId.length > 0));
    } finally {
      setAccountStore(null);
    }
  });

  it("records refused sign-ins without attributing them to the claimed wallet", async () => {
    const store = new MemoryAccountStore();
    setAccountStore(store);
    try {
      const wallet = evmWallet();
      const { message } = await nonceFor(server, wallet);
      await call(server, "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await evmWallet().sign(message) } });
      const denied = store.auditRows().find((row) => row.outcome === "denied");
      assert.equal(denied?.address, null);
      assert.equal(denied?.target.reason, "signature");
      assert.equal(denied?.target.claimed, wallet.address);
      const token = await signIn(server, wallet);
      const activity = await call<{ activity: { outcome: string }[] }>(server, "GET", "/accounts/activity", { headers: as(token) });
      assert.ok(activity.body.activity.every((row) => row.outcome !== "denied"));
    } finally {
      setAccountStore(null);
    }
  });

  it("answers 503 in production without a database instead of keeping ownership in memory", async () => {
    setAccountStore(null);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const wallet = evmWallet();
      const reply = await call(server, "POST", "/accounts/nonce", { headers: { origin: PORTAL_ORIGIN }, body: { walletKind: "evm", address: wallet.address, chainId: 8453 } });
      assertError(reply, 503, "STORE_UNAVAILABLE");
    } finally {
      process.env.NODE_ENV = previous;
      setAccountStore(null);
    }
  });

  it("never treats a smart-wallet signature as valid when the chain cannot be read", async () => {
    configureAccountAuth({
      evmClient: () =>
        ({
          verifyMessage: async () => {
            throw new Error("rpc down");
          },
        }) as never,
    });
    const wallet = evmWallet();
    const { message } = await nonceFor(server, wallet);
    // Not a 65-byte ECDSA signature: only the chain could accept it.
    const contractSignature = `0x${"ab".repeat(100)}`;
    assertError(await call(server, "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: contractSignature } }), 502, "RPC_UNAVAILABLE");
    configureAccountAuth({ evmClient: () => ({ verifyMessage: async () => false }) as never });
    const second = await nonceFor(server, wallet);
    assertError(await call(server, "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message: second.message, signature: contractSignature } }), 401, "ACCOUNT_SIGNATURE_INVALID");
  });

  it("limits sign-in messages per address and new projects per wallet", async () => {
    const wallet = evmWallet();
    for (let index = 0; index < 10; index += 1) await nonceFor(server, wallet);
    const refused = await call(server, "POST", "/accounts/nonce", { headers: { origin: PORTAL_ORIGIN }, body: { walletKind: "evm", address: wallet.address, chainId: 8453 } });
    assertError(refused, 429, "RATE_LIMITED");
    assert.ok(Number(refused.headers.get("retry-after")) > 0);

    resetAccountLimiters();
    const token = await signIn(server, evmWallet());
    for (let index = 0; index < 5; index += 1) {
      const created = await call(server, "POST", "/accounts/projects", { headers: as(token), body: { name: `p${index}` } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    assertError(await call(server, "POST", "/accounts/projects", { headers: as(token), body: { name: "p5" } }), 429, "RATE_LIMITED");
  });
});
