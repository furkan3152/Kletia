/**
 * Rule Book over HTTP (policy design PF3a/PF3b §15), memory stores: agent
 * keys (creation, `kl_agt_` authentication, depth, expiry, cascade
 * revocation, the agent permission matrix), rule book versions (tighten
 * now, loosen later, If-Match, cancel, lazy promotion, removal), the gate
 * installed by the router (deny with `error.policy`, holds with
 * Retry-After), approvals by a project key, an EIP-712 wallet signature and
 * a Solana message signature, the hash-chained decision log, validation,
 * the simulator and spend windows (policyFlows.ts, also run on Postgres by
 * policiesPg.test.ts); and the exposure ledger's atomic reservations
 * (memory, and Postgres when KLETIA_TEST_DATABASE_URL is set).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { configurePlatform, configurePolicyReads, configurePolicyPricing, MemorySpendLedger, type ExposureRecord, type SpendLedger } from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { ruleBookFlows } from "./policyFlows.js";
import { serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { closePlatformDatabase } = await import("../db.js");
const { PostgresSpendLedger } = await import("../policies/ledger.js");

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

after(() => {
  configurePlatform({ adapters: null });
  configurePolicyPricing(null);
  configurePolicyReads(null);
});

ruleBookFlows(() => server);

/* ------------------------------------------------------------ the ledger */

/** Unique per run (Postgres rows outlive a run). */
const RUN = randomBytes(6).toString("hex");

function exposure(index: number, owner: string, projectId: string, usd: number, now: number): ExposureRecord {
  return {
    id: `px_${RUN}${index.toString(16).padStart(12, "0")}`,
    projectId,
    ownerKeyId: owner,
    intentId: `int_${index.toString(16).padStart(32, "0")}`,
    stepId: "s1",
    network: "base",
    quoteBinding: index.toString(16).padStart(64, "0"),
    exclusiveKey: null,
    validUntilHeight: null,
    usdMicros: BigInt(usd) * 1_000_000n,
    decisionId: `pdc_${index.toString(16).padStart(24, "0")}`,
    createdAt: now,
  };
}

function ledgerContract(name: string, make: () => SpendLedger): void {
  describe(`${name} exposure ledger`, () => {
    it("never accepts more than the caps under 60 concurrent reservations, and replays idempotently", async () => {
      const ledger = make();
      const project = `prj_key_${randomBytes(12).toString("hex")}`;
      const agents = [`key_${randomBytes(12).toString("hex")}`, `key_${randomBytes(12).toString("hex")}`];
      const now = Date.now();
      const results = await Promise.all(Array.from({ length: 60 }, (_, index) => {
        const owner = agents[index % 2] as string;
        return ledger.reserve({
          exposure: exposure(index + 1, owner, project, 30, now),
          scopes: [project, owner],
          caps: [{ scope: project, dailyUsdMicros: 1_000_000_000n }, { scope: owner, dailyUsdMicros: 600_000_000n }],
          chain: [],
          now,
        });
      }));
      const accepted = results.filter((result) => result.ok).length;
      assert.equal(accepted, 33, "$990 of $1,000: exactly 33 reservations of $30");
      const usage = await ledger.usage([project, ...agents], now);
      assert.equal(usage.get(project)?.dayUsdMicros, 990_000_000n);
      const replay = await ledger.reserve({ exposure: exposure(1, agents[0] as string, project, 30, now), scopes: [project, agents[0] as string], caps: [], chain: [], now });
      assert.equal(replay.ok, true);
      assert.equal(replay.ok && replay.replayed, true);
      await ledger.abort(exposure(1, agents[0] as string, project, 30, now).id);
      assert.equal((await ledger.usage([project], now)).get(project)?.dayUsdMicros, 960_000_000n, "a dead exposure stops counting");
      const refused = results.find((result) => !result.ok);
      assert.ok(refused && !refused.ok && refused.reason === "cap" && refused.retryAt !== null && refused.retryAt > now);
    });

    it("counts exposures sharing a pinned nonce once, at their largest amount", async () => {
      const ledger = make();
      const project = `prj_key_${randomBytes(12).toString("hex")}`;
      const owner = `key_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      for (const [index, usd] of [[101, 100], [102, 120]] as const) {
        const record = { ...exposure(index, owner, project, usd, now), exclusiveKey: `evm:8453:0x4f183e308f24c81c05303821ad025812fbfd807d:${RUN}` };
        const result = await ledger.reserve({ exposure: record, scopes: [project, owner], caps: [{ scope: owner, dailyUsdMicros: 150_000_000n }], chain: [], now });
        assert.equal(result.ok, true);
      }
      assert.equal((await ledger.usage([owner], now)).get(owner)?.dayUsdMicros, 120_000_000n);
      await ledger.clearExclusive(`evm:8453:0x4f183e308f24c81c05303821ad025812fbfd807d:${RUN}`);
      assert.equal((await ledger.usage([owner], now)).get(owner)?.dayUsdMicros, 220_000_000n, "an overridden nonce counts every member");
    });
  });
}

ledgerContract("memory", () => new MemorySpendLedger());

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
    ledgerContract("postgres", () => new PostgresSpendLedger());
  });
} else {
  describe("postgres exposure ledger", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
