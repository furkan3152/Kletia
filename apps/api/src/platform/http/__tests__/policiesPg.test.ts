/**
 * The Rule Book HTTP flows (policyFlows.ts) on Postgres stores: API keys
 * with lineage and cascade revocation, rule book versions under the project
 * advisory lock, the exposure ledger, approvals and the hash-chained
 * decision log. Runs only when KLETIA_TEST_DATABASE_URL is set; the
 * environment is fixed before the router is imported, because every store
 * is selected lazily from it.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { configurePlatform, configurePolicyPricing, configurePolicyReads } from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { ruleBookFlows } from "./policyFlows.js";
import { serve, useTestEnvironment, type TestServer } from "./support.js";

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  describe("Rule Book on Postgres", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
} else {
  useTestEnvironment();
  process.env.KLETIA_DATABASE_URL = databaseUrl;
  // Sealed idempotent replays (child keys) need a configured platform secret once a database is set.
  process.env.KLETIA_PLATFORM_SECRET = "kletia-test-platform-secret-0123456789abcdef";
  const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
  const { closePlatformDatabase } = await import("../db.js");
  let server: TestServer;

  before(() => {
    resetEngine();
    const market = installMarket();
    standardPrices(market);
    configurePolicyReads({ pendingNonce: async () => 7n, solanaBlockHeight: async () => 500n });
  });

  beforeEach(async () => {
    server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  });

  afterEach(async () => {
    await server.close();
  });

  after(async () => {
    configurePlatform({ adapters: null });
    configurePolicyPricing(null);
    configurePolicyReads(null);
    delete process.env.KLETIA_DATABASE_URL;
    delete process.env.KLETIA_PLATFORM_SECRET;
    await closePlatformDatabase();
  });

  describe("Rule Book on Postgres", () => {
    ruleBookFlows(() => server);
  });
}
