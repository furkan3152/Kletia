/**
 * Journey facts: reads go through holdings (gas balances, gas prices, rent,
 * token accounts), a failed read is null in the facts and becomes R1 "could
 * not read" (never an omission), the deadline is respected, demo accounts
 * are never read, fee estimates fill quoted steps.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildJourney, type IntentGraph, type IntentPreview, type JourneyVenueFacts } from "@kletia/core";
import { configureHoldingsReaders } from "../holdings.js";
import { configureJourneyVenueReader, readJourneyFacts } from "../journey/facts.js";
import { configurePreviewPricer } from "../preview/index.js";

function journeyFixture(name: string): { graph: IntentGraph; preview: IntentPreview } {
  const url = new URL(`../../../../../../packages/core/test/fixtures/journey/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as { graph: IntentGraph; preview: IntentPreview };
}

const EMPTY_EVM = "0xde4bd9c9350682d24a10f5a4e4129cc4ba770d5e";
const EMPTY_SOL = "CmScyaDDQjK7wgsCc2GWjWew68ZZLVzFpidArohV58Rw";

function stubVenue(overrides: Partial<JourneyVenueFacts> = {}): JourneyVenueFacts {
  return { name: "Aave V3 USDC", apy: 0.0397, utilization: 0.9, exitLiquidity: "18126363000000", capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date().toISOString(), ...overrides };
}

beforeEach(() => {
  configurePreviewPricer({ price: async (asset) => (asset.includes("slip44:60") ? 2480 : asset.includes("slip44:501") ? 106 : 1) });
  configureJourneyVenueReader(async () => stubVenue());
});

afterEach(() => {
  configureHoldingsReaders(null);
  configureJourneyVenueReader(null);
  configurePreviewPricer(null);
});

describe("journey facts", () => {
  it("a failing balance read is null and becomes R1 'could not read', never omitted", async () => {
    const reads: string[] = [];
    configureHoldingsReaders({
      evmBalance: async (network) => {
        reads.push(`evm:${network}`);
        throw new Error("rpc down");
      },
      solanaBalance: async () => 2_000_000_000n,
      gasPrice: async () => 6_000_000n,
      solanaRent: async (_network, bytes) => (bytes === 0 ? 650_240n : 1_488_440n),
      solanaTokenAccountExists: async () => false,
    });
    const { graph, preview } = journeyFixture("p2-empty");
    const facts = await readJourneyFacts(graph, preview, { deadlineMs: 2_000 });
    assert.equal(facts.reads, "live");
    assert.equal(facts.native[`base:${EMPTY_EVM}`], null);
    assert.equal(facts.native[`solana:${EMPTY_SOL}`]?.amount, "2000000000");
    assert.ok(reads.includes("evm:base"));
    assert.equal(facts.gasPrice.base?.wei, "6000000");
    assert.deepEqual(facts.solanaRent && [facts.solanaRent.walletLamports, facts.solanaRent.tokenAccountLamports], ["650240", "1488440"]);
    // The quoted Solana step gets an estimate; the simulated Base step keeps its preview fee lines.
    assert.equal(facts.fees.s1?.certainty, "estimated");
    assert.equal(facts.fees.s1?.amount, "105000");
    assert.equal(facts.fees.s2?.amount, (1_635_126_489_996n + 14_385_324_332n).toString());
    assert.equal(facts.prices["eip155:8453/slip44:60"]?.usd, 2480);
    assert.equal(facts.venues["base:aave-v3:usdc"]?.apy, 0.0397);
    assert.equal(facts.gasOptions.s1?.topup, true);
    assert.ok(facts.exitFees.base);
    const journey = buildJourney(graph, preview, facts, facts.at);
    const r1 = journey.consequences.find((entry) => entry.id === "gas-to-continue:out:s1");
    assert.equal(r1?.severity, "warn");
    assert.match(r1?.title ?? "", /Could not read your ETH balance on Base/u);
  });

  it("matches balances of checksummed EVM accounts (keys are lower-case)", async () => {
    configureHoldingsReaders({
      evmBalance: async () => 3_128_820_000_000_000_000n,
      solanaBalance: async () => 5_000_000_000n,
      gasPrice: async () => 6_000_000n,
      solanaRent: async (_network, bytes) => (bytes === 0 ? 650_240n : 1_488_440n),
      solanaTokenAccountExists: async () => true,
    });
    const { graph, preview } = journeyFixture("p2-full");
    const facts = await readJourneyFacts(graph, preview, { deadlineMs: 2_000 });
    assert.equal(facts.native["base:0xd8da6bf26964af9d7eed9e03e53415d37aa96045"]?.amount, "3128820000000000000");
    assert.equal(facts.native["solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]?.amount, "5000000000");
    const journey = buildJourney(graph, preview, facts, facts.at);
    assert.equal(journey.consequences.filter((entry) => entry.kind === "gas-to-continue").length, 0);
  });

  it("respects the deadline: a hanging read is reported unknown in time", async () => {
    configureHoldingsReaders({
      evmBalance: async () => 0n,
      solanaBalance: () => new Promise<bigint>(() => undefined),
      gasPrice: async () => 6_000_000n,
      solanaRent: async () => 650_240n,
      solanaTokenAccountExists: async () => true,
    });
    configureJourneyVenueReader(() => new Promise<JourneyVenueFacts>(() => undefined));
    const { graph, preview } = journeyFixture("p2-empty");
    const started = Date.now();
    const facts = await readJourneyFacts(graph, preview, { deadlineMs: 400 });
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
    assert.equal(facts.native[`solana:${EMPTY_SOL}`], null);
    assert.equal(facts.native[`base:${EMPTY_EVM}`]?.amount, "0");
    assert.equal(facts.venues["base:aave-v3:usdc"], null);
  });

  it("reads none skips every account read and says so once", async () => {
    let touched = 0;
    configureHoldingsReaders({
      evmBalance: async () => {
        touched += 1;
        return 0n;
      },
      solanaBalance: async () => {
        touched += 1;
        return 0n;
      },
      gasPrice: async () => 6_000_000n,
      solanaRent: async () => 650_240n,
    });
    const { graph, preview } = journeyFixture("p5-empty");
    const none = await readJourneyFacts(graph, preview, { reads: "none", deadlineMs: 1_000 });
    assert.equal(none.reads, "none");
    assert.deepEqual(none.native, {});
    assert.equal(touched, 0);
    const journey = buildJourney(graph, preview, none, none.at);
    assert.ok(journey.consequences.some((entry) => entry.id === "gas-to-continue:reads-none"));
  });
});
