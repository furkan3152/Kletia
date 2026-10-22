/**
 * Developer account flows (accountFlows.ts) on Postgres stores: nonces,
 * sessions, project ownership and the audit log in kletia_account_* tables,
 * with API keys and rule books in Postgres too. Runs only when
 * KLETIA_TEST_DATABASE_URL is set; the environment is fixed before the router
 * is imported, because every store is selected lazily from it.
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { accountFlows, as, evmWallet, signIn } from "./accountFlows.js";
import { call, serve, useTestEnvironment, type TestServer } from "./support.js";

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  describe("developer accounts on Postgres", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
} else {
  useTestEnvironment();
  process.env.KLETIA_DATABASE_URL = databaseUrl;
  process.env.KLETIA_PLATFORM_SECRET = "kletia-test-platform-secret-0123456789abcdef";
  const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
  const { closePlatformDatabase, dbQuery } = await import("../db.js");
  const { resetAccountLimiters } = await import("../accounts/handlers.js");
  const { ACCOUNTS_SCHEMA, accountStore } = await import("../accounts/store.js");
  let server: TestServer;

  beforeEach(async () => {
    resetAccountLimiters();
    server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  });

  afterEach(async () => {
    await server.close();
  });

  after(async () => {
    delete process.env.KLETIA_DATABASE_URL;
    delete process.env.KLETIA_PLATFORM_SECRET;
    await closePlatformDatabase();
  });

  describe("developer accounts on Postgres", () => {
    accountFlows(() => server);

    it("stores only hashes of session tokens and keeps one owner per project under concurrent claims", async () => {
      assert.equal(accountStore().kind, "postgres");
      const token = await signIn(server, evmWallet());
      const stored = await dbQuery<{ count: string }>(ACCOUNTS_SCHEMA, "SELECT count(*)::text AS count FROM kletia_account_sessions WHERE id_hash = $1 OR id_hash = $2", [token, token.slice(7)]);
      assert.equal(stored.rows[0]?.count, "0");

      const project = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name: "contested" } });
      assert.equal(project.status, 201);
      const tokens = await Promise.all([signIn(server, evmWallet()), signIn(server, evmWallet()), signIn(server, evmWallet())]);
      const replies = await Promise.all(tokens.map((each) => call(server, "POST", "/accounts/projects/claim", { headers: as(each), key: project.body.key.key })));
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409, 409]);
      const owners = await dbQuery<{ count: string }>(ACCOUNTS_SCHEMA, "SELECT count(*)::text AS count FROM kletia_project_owners WHERE project_id = $1", [project.body.key.id]);
      assert.equal(owners.rows[0]?.count, "1");
    });
  });
}
