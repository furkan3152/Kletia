/**
 * Earn ranking: venues ranked on smoothed 7-day rates net of the tier's risk
 * allowance, with the deviation check, the TVL floor, the migration rule and
 * stake providers by rate. Fixed APYs; offline (the snapshot's readers are
 * replaced; nothing reads a network).
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getYieldVenue, type JourneyVenueFacts, type NetworkKey, type YieldVenue } from "@kletia/core";
import { venueCandidates } from "../clarify/catalog.js";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision, TurnInput } from "../clarify/index.js";
import { configureSnapshotReaders, extendSnapshotReaders, readSnapshot, type SnapshotReaders, type StakeMetricsReading } from "../solver/snapshot.js";
import {
  apyDeviates,
  bestRatedStake,
  comparableApy,
  migrationVerdict,
  rankedByRate,
  rankStakeProviders,
  rankStakeReadings,
  rankYieldReadings,
  rankYieldVenues,
  stakeProvidersOf,
  type YieldReading,
} from "../solver/yieldRank.js";

const venue = (id: string): YieldVenue => {
  const found = getYieldVenue(id);
  assert.ok(found, id);
  return found;
};

interface Fixed {
  readonly apy?: number | null;
  readonly smoothed?: number | null;
  readonly tvl?: number | null;
  readonly paused?: boolean;
  readonly full?: boolean;
}

/** A reading where the current rate equals the 7-day rate unless said, on a venue far above every floor. */
function reading(fixed: Fixed): YieldReading {
  const smoothed = fixed.smoothed === undefined ? fixed.apy ?? null : fixed.smoothed;
  return {
    status: "known",
    apy: fixed.apy === undefined ? smoothed : fixed.apy,
    smoothedApy: smoothed,
    tvlUsd: fixed.tvl === undefined ? 1_000_000_000 : fixed.tvl,
    capRemaining: fixed.full ? "0" : null,
    paused: fixed.paused ?? false,
    frozen: false,
  };
}

function rank(network: NetworkKey, symbol: string, fixed: Readonly<Record<string, Fixed>>, q: Partial<Parameters<typeof rankYieldReadings>[0]> = {}) {
  return rankYieldReadings({ network, ...q }, venueCandidates(network, "deposit", symbol), (entry) => (fixed[entry.id] ? reading(fixed[entry.id] as Fixed) : null));
}

const pick = (ranked: ReturnType<typeof rank>) => ranked.find((entry) => entry.compared)?.venue.id;

const BASE = {
  "base:aave-v3:usdc": { apy: 0.041, tvl: 300_000_000 },
  "base:morpho:steakhouse-prime-usdc": { apy: 0.05, tvl: 272_000_000 },
  "base:compound-v3:usdc": { apy: 0.038, tvl: 60_000_000 },
} satisfies Record<string, Fixed>;

describe("yieldRank: venues on smoothed rates", () => {
  it("ranks every venue of the asset before any cut: Morpho 5.0% (curated, 4.5% after risk) beats Aave 4.1% on Base", () => {
    const candidates = venueCandidates("base", "deposit", "USDC");
    assert.ok(candidates.length > 4, "Base lists more USDC venues than the old cut of 4");
    assert.ok(candidates.some((entry) => entry.id === "base:morpho:steakhouse-prime-usdc"), "the Morpho vault is a candidate");
    const ranked = rank("base", "USDC", BASE, { amountUsd: 100 });
    assert.equal(pick(ranked), "base:morpho:steakhouse-prime-usdc");
    const morpho = ranked[0]!;
    assert.equal(morpho.tier, "curated");
    assert.ok(Math.abs((morpho.adjustedApy as number) - 0.045) < 1e-12, "0.5 point holding penalty");
    assert.deepEqual(ranked.filter((entry) => entry.compared).map((entry) => entry.venue.id), ["base:morpho:steakhouse-prime-usdc", "base:aave-v3:usdc", "base:compound-v3:usdc"]);
    assert.ok(ranked.slice(3).every((entry) => !entry.compared && /could not be read/u.test(entry.why)), "unread venues are listed, not ranked as zero");
  });

  it("Fluid 7.0% (curated) beats Compound 5.1% (core) on Arbitrum", () => {
    const ranked = rank("arbitrum", "USDC", { "arbitrum:fluid:usdc": { apy: 0.07, tvl: 40_000_000 }, "arbitrum:compound-v3:usdc": { apy: 0.051, tvl: 80_000_000 } });
    assert.equal(pick(ranked), "arbitrum:fluid:usdc");
    assert.equal(ranked[1]?.venue.id, "arbitrum:compound-v3:usdc");
  });

  it("a current rate spiked more than 2x above its 7-day rate drops the venue (and a collapse below half)", () => {
    const spiked = rank("base", "USDC", { ...BASE, "base:morpho:steakhouse-prime-usdc": { apy: 0.12, smoothed: 0.05, tvl: 272_000_000 } });
    assert.equal(pick(spiked), "base:aave-v3:usdc");
    const morpho = spiked.find((entry) => entry.venue.id === "base:morpho:steakhouse-prime-usdc");
    assert.equal(morpho?.compared, false);
    assert.match(morpho?.why ?? "", /more than 2x away from its 7-day rate/u);
    assert.equal(apyDeviates(0.1, 0.05), false, "exactly 2x is kept");
    assert.equal(apyDeviates(0.1001, 0.05), true);
    assert.equal(apyDeviates(0.02, 0.05), true, "under half is dropped too");
    assert.equal(apyDeviates(0.01, 0), true, "a rate on a zero 7-day rate is a spike");
    assert.equal(apyDeviates(null, 0.05), false, "no current rate: the 7-day rate stands");
  });

  it("venues under their tier's TVL floor, or without a 7-day rate or TVL, are not compared", () => {
    const ranked = rank("base", "USDC", {
      "base:aave-v3:usdc": { apy: 0.041, tvl: 49_000_000 },
      "base:morpho:steakhouse-prime-usdc": { apy: 0.05, tvl: 9_000_000 },
      "base:compound-v3:usdc": { apy: 0.038, smoothed: null },
      "base:fluid:usdc": { apy: 0.06, tvl: null },
      "base:moonwell:usdc": { apy: 0.03, tvl: 10_000_000 },
    });
    assert.equal(pick(ranked), "base:moonwell:usdc", "curated floor $10M is met");
    const why = (id: string) => ranked.find((entry) => entry.venue.id === id)?.why ?? "";
    assert.match(why("base:aave-v3:usdc"), /under the \$50M floor for core/u);
    assert.match(why("base:morpho:steakhouse-prime-usdc"), /under the \$10M floor for curated/u);
    assert.match(why("base:compound-v3:usdc"), /7-day rate could not be read/u);
    assert.match(why("base:fluid:usdc"), /TVL\) could not be read/u);
  });

  it("paused or full venues are not compared, whatever they pay", () => {
    const ranked = rank("base", "USDC", { ...BASE, "base:morpho:steakhouse-prime-usdc": { apy: 0.05, tvl: 272_000_000, full: true }, "base:aave-v3:usdc": { apy: 0.041, tvl: 300_000_000, paused: true } });
    assert.equal(pick(ranked), "base:compound-v3:usdc");
    assert.equal(ranked.find((entry) => entry.venue.id === "base:aave-v3:usdc")?.capacityOk, false);
  });

  it("extended-tier venues are used only when the protocol is named", () => {
    const fixed = { "ethereum:yearn-v3:usdc-1": { apy: 0.2, tvl: 500_000_000 }, "ethereum:aave-v3:usdc": { apy: 0.04, tvl: 900_000_000 } };
    const unnamed = rank("ethereum", "USDC", fixed);
    assert.equal(pick(unnamed), "ethereum:aave-v3:usdc");
    assert.match(unnamed.find((entry) => entry.venue.protocol === "yearn-v3")?.why ?? "", /Extended-tier/u);
    const named = rank("ethereum", "USDC", fixed, { protocol: "yearn-v3" });
    assert.equal(pick(named), "ethereum:yearn-v3:usdc-1");
  });

  it("a named protocol's vaults are ranked by the same score; without rates its default vault stays (not by rate)", () => {
    const ranked = rank("base", "USDC", { "base:morpho:steakhouse-prime-usdc": { apy: 0.05, tvl: 272_000_000 }, "base:morpho:gauntlet-usdc-prime": { apy: 0.062, tvl: 120_000_000 } }, { protocol: "morpho" });
    assert.equal(pick(ranked), "base:morpho:gauntlet-usdc-prime");
    assert.ok(ranked.every((entry) => entry.venue.protocol === "morpho"));
    const unrated = rank("base", "USDC", {}, { protocol: "morpho" });
    assert.equal(pick(unrated), "base:morpho:steakhouse-prime-usdc");
    assert.equal(rankedByRate(unrated[0]!), false, "chosen because it was named, not by rate");
    assert.match(unrated[0]!.why, /protocol you named/u);
  });

  it("the only venue for an asset stays usable without a comparison; with several, none is picked", () => {
    const solana = rank("solana", "USDC", { "solana:kamino:usdc": { apy: 0.05, smoothed: null }, "solana:jupiter-lend:usdc": { apy: 0.06, smoothed: null } });
    assert.equal(pick(solana), undefined, "two venues, no 7-day rates: nothing is picked on a current rate");
    const only = rankYieldReadings({ network: "solana" }, [venue("solana:kamino:usdc")], () => reading({ apy: 0.05, smoothed: null }));
    assert.equal(only[0]?.compared, true);
    assert.equal(rankedByRate(only[0]!), false);
    assert.match(only[0]!.why, /^The only venue/u);
  });

  it("'safest' ranks by tier first; 'yield' ranks on the raw 7-day rate over core and curated", () => {
    const fixed = { ...BASE, "base:morpho:steakhouse-prime-usdc": { apy: 0.044, tvl: 272_000_000 } };
    assert.equal(pick(rank("base", "USDC", fixed)), "base:aave-v3:usdc", "4.4% curated is 3.9% after risk, under Aave 4.1%");
    assert.equal(pick(rank("base", "USDC", fixed, { prefer: "yield" })), "base:morpho:steakhouse-prime-usdc", "raw 7-day rate");
    assert.equal(pick(rank("base", "USDC", BASE, { prefer: "safest" })), "base:aave-v3:usdc", "core before curated");
  });

  it("a migration excludes its source venue and must beat it by more than the switching gas", () => {
    const source = venue("base:aave-v3:usdc");
    const ranked = rank("base", "USDC", BASE, { excludeVenueIds: [source.id], amountUsd: 250 });
    assert.ok(ranked.every((entry) => entry.venue.id !== source.id), "the source is never a target");
    const move = migrationVerdict({ ranked, source, sourceReading: reading(BASE["base:aave-v3:usdc"]), amountUsd: 250, switchingGasUsd: 0.03 });
    assert.equal(move.move, true);
    assert.equal(move.move && move.target.venue.id, "base:morpho:steakhouse-prime-usdc");
    // 0.4 point on $250 for 30 days is about $0.08: under $1 of gas it is not worth it.
    const costly = migrationVerdict({ ranked, source, sourceReading: reading(BASE["base:aave-v3:usdc"]), amountUsd: 250, switchingGasUsd: 1 });
    assert.equal(costly.move, false);
    assert.equal(!costly.move && costly.reason, "not-better");
    assert.match(costly.why, /does not cover the gas of switching/u);
    const best = migrationVerdict({ ranked, source, sourceReading: reading({ apy: 0.06, tvl: 300_000_000 }), amountUsd: 250, switchingGasUsd: 0.03 });
    assert.equal(!best.move && best.reason, "not-better");
    assert.match(best.why, /already pays the best rate/u);
    const unknown = migrationVerdict({ ranked, source, sourceReading: reading({ apy: 0.041, smoothed: null }), amountUsd: 250, switchingGasUsd: 0.03 });
    assert.equal(!unknown.move && unknown.reason, "not-compared");
  });

  it("comparableApy is the 7-day rate only when the venue passes every check on its own", () => {
    assert.equal(comparableApy(reading({ apy: 0.05, tvl: 272_000_000 }), "curated"), 0.05);
    assert.equal(comparableApy(reading({ apy: 0.2, smoothed: 0.05 }), "curated"), null);
    assert.equal(comparableApy(reading({ apy: 0.05, tvl: 5_000_000 }), "curated"), null);
    assert.equal(comparableApy(reading({ apy: 0.05, smoothed: null }), "core"), null);
    assert.equal(comparableApy(reading({ apy: 0.05, paused: true }), "core"), null);
    assert.equal(comparableApy(undefined, "core"), null);
  });
});

/* ------------------------------------------------------------ async reads */

const facts = (apy: number | null): JourneyVenueFacts => ({ name: "x", apy, utilization: null, exitLiquidity: null, capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date().toISOString() });

describe("yieldRank: bounded reads (rankYieldVenues, rankStakeProviders, snapshot)", () => {
  afterEach(() => configureSnapshotReaders(null));

  it("rankYieldVenues reads every candidate within the deadline; a late venue is not compared", async () => {
    const read: string[] = [];
    configureSnapshotReaders({
      venue: async (entry) => {
        read.push(entry.id);
        if (entry.id === "base:morpho:steakhouse-prime-usdc") await new Promise((resolve) => setTimeout(resolve, 400));
        return facts((BASE as Record<string, Fixed>)[entry.id]?.apy ?? null);
      },
      metrics: async (entry) => {
        const fixed = (BASE as Record<string, Fixed>)[entry.id];
        return { smoothedApy: fixed?.apy ?? null, apyWindowSeconds: 604_800, tvlUsd: fixed?.tvl ?? null };
      },
    });
    const started = Date.now();
    const ranked = await rankYieldVenues({ network: "base", symbol: "USDC", amountUsd: 100, deadlineMs: 100 });
    assert.ok(Date.now() - started < 380, "bounded by the deadline");
    assert.equal(read.length, venueCandidates("base", "deposit", "USDC").length, "every venue is read");
    assert.equal(ranked.find((entry) => entry.compared)?.venue.id, "base:aave-v3:usdc", "Morpho was late: not compared");
    assert.match(ranked.find((entry) => entry.venue.id === "base:morpho:steakhouse-prime-usdc")?.why ?? "", /could not be read in time/u);
  });

  it("the default deadline is 1.5 s and excluded venues are never read", async () => {
    const read: string[] = [];
    configureSnapshotReaders({
      venue: async (entry) => {
        read.push(entry.id);
        return facts(0.04);
      },
      metrics: async () => ({ smoothedApy: 0.04, apyWindowSeconds: 604_800, tvlUsd: 100_000_000 }),
    });
    const ranked = await rankYieldVenues({ network: "base", symbol: "USDC", excludeVenueIds: ["base:aave-v3:usdc"] });
    assert.ok(!read.includes("base:aave-v3:usdc"));
    assert.ok(ranked.every((entry) => entry.venue.id !== "base:aave-v3:usdc"));
  });

  it("test readers that replace venue reads never fall back to live metrics reads", async () => {
    configureSnapshotReaders({ venue: async () => facts(0.04) });
    const ranked = await rankYieldVenues({ network: "base", symbol: "USDC", deadlineMs: 200 });
    assert.ok(ranked.every((entry) => entry.smoothedApy === null && !entry.compared));
  });

  it("stake providers rank on the 7-day growth of their token net of the risk allowance; unread ones keep the default order", async () => {
    const providers = stakeProvidersOf("ETH", "ethereum");
    assert.ok(providers.length >= 3);
    assert.equal(providers[0]?.id, "lido", "Kletia's default first");
    const stakes: StakeMetricsReading[] = providers.map((provider) => ({
      provider: provider.id, network: "ethereum", lst: provider.symbol,
      smoothedApy: provider.symbol === "rETH" ? 0.034 : provider.symbol === "wstETH" ? 0.029 : null,
      tvlUsd: 5_000_000_000,
    }));
    const ranked = rankStakeReadings(providers, stakes);
    const reth = ranked.find((entry) => entry.lst === "rETH");
    const wsteth = ranked.find((entry) => entry.lst === "wstETH");
    assert.ok(reth && wsteth);
    const expected = (reth.adjustedApy as number) > (wsteth.adjustedApy as number) ? "rETH" : "wstETH";
    assert.equal(ranked[0]?.lst, expected, "the better risk-adjusted rate leads");
    assert.equal(bestRatedStake(providers, [])?.provider, undefined, "no readings: no rate claim, the default stays");
    configureSnapshotReaders({ venue: async () => facts(null), stakes: async () => stakes });
    const read = await rankStakeProviders({ network: "ethereum", input: "ETH" });
    assert.equal(read[0]?.lst, expected);
    configureSnapshotReaders({ venue: async () => facts(null) });
    const offline = await rankStakeProviders({ network: "ethereum", input: "ETH" });
    assert.equal(offline[0]?.provider, "lido", "nothing read: Kletia's default order");
    assert.ok(offline.every((entry) => entry.apy === null));
  });

  it("the solver snapshot carries smoothed-rate fields for every earn candidate and stake readings for ETH goals", async () => {
    configureSnapshotReaders({
      venue: async () => facts(0.04),
      metrics: async (entry) => ({ smoothedApy: entry.protocol === "morpho" ? 0.05 : 0.04, apyWindowSeconds: 604_800, tvlUsd: 100_000_000 }),
      stakes: async () => [{ provider: "lido", network: "ethereum", lst: "wstETH", smoothedApy: 0.029, tvlUsd: 9e9 }],
      portfolio: async () => { throw new Error("offline"); },
      facts: async (accounts, needs) => ({ balances: new Map(), names: new Map(), failures: [], accounts, needs } as never),
    });
    const goal = { kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "100" }, from: { network: "base", custody: { kind: "wallet" } } }, want: {}, holder: { t: "self" }, constraints: {}, confidence: "exact" } as const;
    const snapshot = await readSnapshot(["eip155:8453:0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C"], [goal as never], { balances: 0 });
    assert.equal(snapshot.apy.get("base:morpho:steakhouse-prime-usdc")?.smoothedApy, 0.05);
    assert.equal(snapshot.apy.get("base:aave-v3:usdc")?.tvlUsd, 100_000_000);
    const eth = { ...goal, spend: { asset: { symbol: "ETH" }, amount: { t: "exact", value: "1" }, from: { network: "ethereum", custody: { kind: "wallet" } } } };
    const staked = await readSnapshot(["eip155:1:0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C"], [eth as never], { balances: 0 });
    assert.equal(staked.stakes?.get("ETH")?.[0]?.lst, "wstETH");
  });
});

/* -------------------------------------------------- the policy (threads) */

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
after(() => uninstallWallet());

let s8: Partial<SnapshotReaders> | null = null;
const metricsOf = (fixed: Readonly<Record<string, Fixed>>): Partial<SnapshotReaders> => ({
  venue: async (entry) => {
    const row = fixed[entry.id];
    if (!row) throw new Error("offline");
    return { ...facts(row.apy ?? null), paused: row.paused ?? false, capRemaining: row.full ? "0" : null };
  },
  metrics: async (entry) => {
    const row = fixed[entry.id];
    return { smoothedApy: row ? (row.smoothed === undefined ? row.apy ?? null : row.smoothed) : null, apyWindowSeconds: 604_800, tvlUsd: row ? (row.tvl === undefined ? 1e9 : row.tvl) : null };
  },
});

async function thread(wallet: string, ...inputs: (string | TurnInput)[]): Promise<{ decision?: TurnDecision; error?: { code: string; message: string } }[]> {
  const entry = { id: "t", category: "test", title: "t", wallet, turns: [] } as CorpusCase;
  const ctx = contextFor(corpus, entry);
  const out: { decision?: TurnDecision; error?: { code: string; message: string } }[] = [];
  let current: TurnDecision["thread"] | null = null;
  for (const input of inputs) {
    installWallet(corpus, wallet);
    if (s8) extendSnapshotReaders(s8);
    const result = await runTurn(current, typeof input === "string" ? { text: input } : input, ctx);
    out.push(result);
    if (result.decision) current = result.decision.thread;
  }
  return out;
}
const planOf = (step: { decision?: TurnDecision; error?: { code: string } } | undefined) => (step?.decision?.actions ? shape(step.decision.actions) : `${step?.decision?.status ?? step?.error?.code}`);

describe("yieldRank in the policy (ABS064, ABS025)", () => {
  afterEach(() => {
    s8 = null;
  });

  it("'put 100 usdc into the best yield on base' deposits into the best compared venue (Morpho), shown with the rates", async () => {
    s8 = metricsOf(BASE);
    const [step] = await thread("full", "put 100 usdc into the best yield on base");
    assert.equal(planOf(step), "deposit@base 100 USDC [morpho:steakhouse-prime-usdc]");
    const venueChip = step?.decision?.assumptions.find((entry) => entry.field === "actions[0].protocol");
    assert.ok(venueChip?.material, "the venue is a material chip");
    assert.match(venueChip?.label ?? "", /Steakhouse Prime USDC · 5% APY \(7-day\)/u);
    assert.match(venueChip?.reason ?? "", /best 7-day rate for its risk/u);
    assert.ok(venueChip?.alternatives.some((option) => option.id === "aave-v3" && /4\.1% APY \(7-day\)/u.test(option.label)));
  });

  it("a spiked Morpho rate does not win the pick", async () => {
    s8 = metricsOf({ ...BASE, "base:morpho:steakhouse-prime-usdc": { apy: 0.05, smoothed: 0.02, tvl: 272_000_000 } });
    const [step] = await thread("full", "put 100 usdc into the best yield on base");
    assert.equal(planOf(step), "deposit@base 100 USDC [aave-v3]");
  });

  it("'move my aave usdc to the best yield' never deposits back into Aave: it moves to the better venue", async () => {
    s8 = metricsOf(BASE);
    const [step] = await thread("full", "move my aave usdc to the best yield");
    const plan = planOf(step);
    assert.match(plan, /^withdraw@base max USDC \[aave-v3\] \| deposit@base max USDC \[morpho:steakhouse-prime-usdc\]$/u, plan);
  });

  it("a migration whose source already pays the best rate is refused, never planned back into the source", async () => {
    s8 = metricsOf({ ...BASE, "base:aave-v3:usdc": { apy: 0.06, tvl: 300_000_000 } });
    const [step] = await thread("full", "move my aave usdc to the best yield");
    assert.equal(step?.error?.code, "INTENT_UNSUPPORTED", planOf(step));
    assert.match(step?.error?.message ?? "", /already pays the best rate/u);
  });

  it("without 7-day rates a venue-less deposit asks (no pick on a current rate)", async () => {
    s8 = metricsOf({});
    const [step] = await thread("full", "put 100 usdc into the best yield on base");
    assert.deepEqual(step?.decision?.questions.map((q) => `${q.field}:${q.reason}`), ["actions[0].protocol:VENUE_MISSING"]);
  });

  it("a named protocol picks its best compared vault", async () => {
    s8 = metricsOf({ "base:morpho:steakhouse-prime-usdc": { apy: 0.05, tvl: 272_000_000 }, "base:morpho:gauntlet-usdc-prime": { apy: 0.062, tvl: 120_000_000 } });
    const [step] = await thread("full", "deposit 100 USDC into morpho on base");
    assert.equal(planOf(step), "deposit@base 100 USDC [morpho:gauntlet-usdc-prime]", JSON.stringify(step?.decision?.assumptions));
    const vaultChip = step?.decision?.assumptions.find((entry) => entry.field === "actions[0].venue");
    assert.equal(vaultChip?.source, "default");
    assert.match(vaultChip?.label ?? "", /6\.2% APY \(7-day\)/u);
  });

  it("an unnamed ETH stake takes the provider with the best compared 7-day rate; without readings Lido stays", async () => {
    const stakes = (reth: number | null): StakeMetricsReading[] => [
      { provider: "lido", network: "ethereum", lst: "wstETH", smoothedApy: 0.029, tvlUsd: 9e9 },
      { provider: "rocket-pool", network: "ethereum", lst: "rETH", smoothedApy: reth, tvlUsd: 3e9 },
    ];
    s8 = { stakes: async () => stakes(0.04) };
    const [rated] = await thread("wide", "stake 1 ETH on ethereum");
    const ratedPlan = planOf(rated);
    s8 = { stakes: async () => stakes(null) };
    const [fallback] = await thread("wide", "stake 1 ETH on ethereum");
    assert.match(planOf(fallback), /\{lido\}$/u, planOf(fallback));
    // rETH 4.0% beats wstETH 2.9% whatever Rocket Pool's tier allowance (at most 0.5 point for curated).
    assert.match(ratedPlan, /->rETH \{rocket-pool\}$/u, ratedPlan);
    const providerChip = rated?.decision?.assumptions.find((entry) => entry.field === "actions[0].provider");
    assert.match(providerChip?.label ?? "", /4% APY \(7-day\)/u);
    assert.match(providerChip?.reason ?? "", /best 7-day staking rate/u);
  });
});
