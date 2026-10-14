/**
 * journeyFor (journey design §5 entry point, E9 and E10): venue capacity
 * read through the venue reader becomes R5 (a cap smaller than the deposit
 * or a pause blocks), results are cached for 15 s per (intent, updatedAt,
 * preview digest, reads), `refresh` bypasses the cache, and the platform
 * index exports the journey entry points (journey 11.3).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { JourneyVenueFacts } from "@kletia/core";
import { configureHoldingsReaders } from "../holdings.js";
import { configureJourneyVenueReader } from "../journey/facts.js";
import { journeyFor, resetJourneyCaches } from "../journey/index.js";
import { configurePreviewPricer } from "../preview/index.js";
import * as platform from "../../index.js";
import { readFileSync } from "node:fs";
import type { IntentGraph, IntentPreview } from "@kletia/core";

function journeyFixture(name: string): { graph: IntentGraph; preview: IntentPreview } {
  const url = new URL(`../../../../../../packages/core/test/fixtures/journey/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as { graph: IntentGraph; preview: IntentPreview };
}

function stubVenue(overrides: Partial<JourneyVenueFacts> = {}): JourneyVenueFacts {
  return { name: "Aave V3 USDC", apy: 0.0397, utilization: 0.9, exitLiquidity: "18126363000000", capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date().toISOString(), ...overrides };
}

let venueReads = 0;
let balanceReads = 0;
let venue: JourneyVenueFacts = stubVenue();

beforeEach(() => {
  resetJourneyCaches();
  venueReads = 0;
  balanceReads = 0;
  venue = stubVenue();
  configurePreviewPricer({ price: async (asset) => (asset.includes("slip44:60") ? 2480 : asset.includes("slip44:501") ? 106 : 1) });
  configureJourneyVenueReader(async () => {
    venueReads += 1;
    return venue;
  });
  configureHoldingsReaders({
    evmBalance: async () => {
      balanceReads += 1;
      return 10n ** 16n;
    },
    solanaBalance: async () => {
      balanceReads += 1;
      return 10n ** 9n;
    },
    gasPrice: async () => 6_000_000n,
    solanaRent: async (_network, bytes) => (bytes === 0 ? 650_240n : 1_488_440n),
    solanaTokenAccountExists: async () => true,
  });
});

afterEach(() => {
  configureHoldingsReaders(null);
  configureJourneyVenueReader(null);
  configurePreviewPricer(null);
  resetJourneyCaches();
});

describe("journeyFor", () => {
  it("E9: a supply cap smaller than the deposit, or a paused venue, is an R5 block", async () => {
    const { graph, preview } = journeyFixture("p2-empty");
    venue = stubVenue({ capRemaining: "1000000" });
    const capped = await journeyFor(graph, { preview });
    const r5 = capped.consequences.find((entry) => entry.id === "venue-capacity:out:s2");
    assert.equal(r5?.severity, "block");
    assert.ok(capped.blockers.includes("venue-capacity:out:s2"));
    assert.equal(r5?.facts.capRemaining, "1000000");
    resetJourneyCaches();
    venue = stubVenue({ paused: true });
    const paused = await journeyFor(graph, { preview });
    assert.equal(paused.consequences.find((entry) => entry.id === "venue-capacity:out:s2")?.severity, "block");
    assert.equal(paused.basis.previewDigest, preview.digest);
    assert.equal(paused.basis.reads, "live");
  });

  it("E10: two calls within 15 s read facts once; refresh and a new updatedAt read again", async () => {
    const { graph, preview } = journeyFixture("p2-empty");
    const first = await journeyFor(graph, { preview });
    const second = await journeyFor(graph, { preview });
    assert.equal(venueReads, 1);
    assert.equal(balanceReads, 2);
    assert.equal(second, first);
    await journeyFor(graph, { preview, refresh: true });
    assert.equal(venueReads, 2);
    await journeyFor({ ...graph, updatedAt: "2026-10-14T13:37:00.000Z" }, { preview });
    assert.equal(venueReads, 3);
    // reads=none is cached separately and reads no balances.
    const before = balanceReads;
    const none = await journeyFor(graph, { preview, reads: "none" });
    assert.equal(none.basis.reads, "none");
    assert.equal(balanceReads, before);
    resetJourneyCaches();
    await journeyFor(graph, { preview });
    assert.equal(venueReads, 5);
  });

  it("exports the journey entry points from the platform index (journey 11.3)", () => {
    assert.equal(typeof platform.journeyFor, "function");
    assert.equal(typeof platform.resetJourneyCaches, "function");
    assert.equal(typeof platform.readVenuePositions, "function");
    assert.equal(typeof platform.policyHeadroom, "function");
  });

  it("policyHeadroom: remainders per capped scope, the tightest caps and the owner's schedule", async () => {
    const schedule = { timezone: "UTC", windows: [{ days: ["mon"], from: "09:00", to: "17:00" }] };
    const chains = {
      chain: async (keyId: string) => keyId !== "key_1" ? undefined : {
        projectId: "prj_1",
        ownerKeyId: "key_1",
        lineage: [],
        keyActive: true,
        levels: [
          { scope: "project" as const, id: "prj_1", defaults: "project" as const, policy: { schema: "kletia.policy/v1", caps: { perStepUsd: "500", dailyUsd: "1000" } } as never, version: 1, hash: "sha256:a" },
          { scope: "key" as const, id: "key_1", defaults: "agent" as const, policy: { schema: "kletia.policy/v1", caps: { perStepUsd: "100", weeklyUsd: "2000" }, schedule } as never, version: 1, hash: "sha256:b" },
        ],
      },
    };
    const ledger = () => ({
      usage: async () => new Map([["prj_1", { dayUsdMicros: 250_500_000n, weekUsdMicros: 0n }], ["key_1", { dayUsdMicros: 0n, weekUsdMicros: 1_999_000_000n }]]),
    });
    const headroom = await platform.policyHeadroom("key_1", { chains, ledger } as never);
    assert.deepEqual(headroom?.scopes, [
      { scope: "prj_1", dailyRemainingUsd: "749.50", weeklyRemainingUsd: null },
      { scope: "key_1", dailyRemainingUsd: null, weeklyRemainingUsd: "1.00" },
    ]);
    assert.equal(headroom?.perStepUsd, "100.00");
    assert.equal(headroom?.dailyRemainingUsd, "749.50");
    assert.equal(headroom?.weeklyRemainingUsd, "1.00");
    assert.deepEqual(headroom?.schedule, schedule);
    assert.equal(await platform.policyHeadroom("key_unknown", { chains, ledger } as never), null);
    assert.equal(await platform.policyHeadroom("key_1", null), null);
  });
});
