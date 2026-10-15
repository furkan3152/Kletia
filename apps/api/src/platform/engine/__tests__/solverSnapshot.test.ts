/**
 * Solver snapshot: holdings, positions, prices and APYs for a list of
 * Goals, read through stubbed readers. Offline: nothing here touches a
 * network.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  CHAINS,
  findAssetBySymbol,
  fromBaseUnits,
  nativeAssetId,
  type AccountId,
  type AssetId,
  type Goal,
  type JourneyVenueFacts,
  type NetworkKey,
  type VenuePosition,
} from "@kletia/core";
import { TurnFacts } from "../clarify/facts.js";
import type { WalletFacts } from "../holdings.js";
import type { AccountPortfolios } from "../portfolio.js";
import type { PriceQuoteView } from "../preview/pricer.js";
import {
  configureSnapshotReaders,
  holdingOf,
  positionAmount,
  readSnapshot,
  usablePrice,
  type SnapshotReaders,
} from "../solver/snapshot.js";

const EVM = "0x1111111111111111111111111111111111111111";
const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const ACCOUNTS = [`eip155:8453:${EVM}`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`] as AccountId[];
const T0 = Date.parse("2026-10-15T12:00:00Z");

function goal(partial: Partial<Goal> & Pick<Goal, "kind">): Goal {
  return { spend: {}, want: {}, holder: { t: "self" }, constraints: {}, confidence: "frame", ...partial };
}

function idOf(network: NetworkKey, symbol: string): AssetId {
  const listed = findAssetBySymbol(network, symbol);
  assert.ok(listed, `${symbol} on ${network}`);
  return listed.id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A portfolio of one account from a symbol -> decimal table (unlisted symbols are skipped). */
function portfolioOf(account: AccountId, table: Readonly<Record<string, string>>): AccountPortfolios {
  const network = (Object.values(CHAINS).find((chain) => account.startsWith(`${chain.id}:`))?.key ?? "base") as NetworkKey;
  const holdings = Object.entries(table).flatMap(([symbol, amount]) => {
    const listed = findAssetBySymbol(network, symbol);
    if (!listed) return [];
    const units = BigInt(Math.round(Number(amount) * 10 ** Math.min(listed.decimals, 9))) * 10n ** BigInt(Math.max(0, listed.decimals - 9));
    return [{
      asset: listed.id, symbol: listed.symbol, name: listed.name, decimals: listed.decimals, amount: units.toString(),
      formatted: fromBaseUnits(units, listed.decimals), usd: null, verified: true, isNative: listed.address === null,
      priceSource: "unpriced" as const, pricedAt: null,
    }];
  });
  return {
    portfolios: [{ account, network, holdings, totalUsd: 0, unpricedCount: 0, observedAt: new Date(T0).toISOString() }],
    failures: [],
    observedAt: new Date(T0).toISOString(),
  };
}

const noFacts: SnapshotReaders["facts"] = async (_accounts, needs) => ({
  balances: needs.map((need) => ({
    network: (need as { network: NetworkKey }).network, owner: "", asset: null, symbol: "", decimals: null, status: "unknown" as const, reason: "The balance could not be read.",
  })),
  gasPrices: [], rent: [], tokenAccounts: [], names: [], reads: 0, preview: false,
});

const fixedPrice = (at: number): SnapshotReaders["price"] => async (asset) => ({ usd: asset.includes("slip44") ? 3000 : 1, source: "jupiter", at: new Date(at).toISOString() });

function readers(overrides: Partial<SnapshotReaders>): Partial<SnapshotReaders> {
  return {
    facts: noFacts,
    portfolio: async () => { throw new Error("no sweep expected"); },
    positions: async () => { throw new Error("no positions expected"); },
    venue: async () => { throw new Error("no venue reads expected"); },
    price: fixedPrice(T0),
    ...overrides,
  };
}

afterEach(() => configureSnapshotReaders(null));

describe("solver snapshot: holdings", () => {
  it("reads exact balances for named goals and never reports unknown as zero", async () => {
    const usdcBase = idOf("base", "USDC");
    configureSnapshotReaders(readers({
      facts: async (_accounts, needs): Promise<WalletFacts> => ({
        balances: needs.map((need) => {
          const { network, asset } = need as { network: NetworkKey; asset: string };
          if (network === "base" && asset.toUpperCase() === "USDC") {
            return { network, owner: EVM, asset: usdcBase, symbol: "USDC", decimals: 6, status: "known" as const, amount: "120400000", formatted: "120.4" };
          }
          return { network, owner: EVM, asset: null, symbol: asset, decimals: null, status: "unknown" as const, reason: "The balance could not be read." };
        }),
        gasPrices: [], rent: [], tokenAccounts: [], names: [], reads: needs.length, preview: false,
      }),
    }));
    const snapshot = await readSnapshot(ACCOUNTS, [goal({
      kind: "relocate", op: "bridge",
      spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "500" }, from: { network: "base", custody: { kind: "wallet" } } },
      want: { at: { network: "arbitrum", custody: { kind: "wallet" } } },
    })], { now: T0 });
    assert.equal(snapshot.sweep.status, "skipped", "a named source network needs no sweep");
    const usdc = holdingOf(snapshot, "base", "usdc");
    assert.equal(usdc?.status, "known");
    assert.equal(usdc?.formatted, "120.4");
    assert.equal(usdc?.usd, 120.4);
    const gas = holdingOf(snapshot, "base", "ETH");
    assert.equal(gas?.status, "unknown");
    assert.equal(gas?.units, undefined);
    assert.equal(gas?.usd, null);
    assert.equal(gas?.reason, "read-failed");
    assert.equal(holdingOf(snapshot, "optimism", "USDC"), undefined, "not read is absent, not zero");
  });

  it("marks reads past the budget as unknown", async () => {
    const goals = ["USDC", "ETH", "WETH"].map((symbol) => goal({ kind: "convert", spend: { asset: { symbol }, from: { network: "base", custody: { kind: "wallet" } } } }));
    let asked = 0;
    configureSnapshotReaders(readers({ facts: async (accounts, needs, budget) => { asked = needs.length; return noFacts(accounts, needs, budget); } }));
    const snapshot = await readSnapshot(ACCOUNTS, goals, { balances: 2, now: T0 });
    assert.equal(asked, 2);
    assert.ok(snapshot.holdings.some((holding) => holding.reason === "budget" && holding.status === "unknown"));
  });

  it("sweeps every network of the lane for goals without a source network, with failures unknown", async () => {
    const seen: string[] = [];
    configureSnapshotReaders(readers({
      portfolio: async (account) => {
        seen.push(account);
        if (account.startsWith("eip155:10:")) throw new Error("rpc down");
        if (account.startsWith("eip155:8453:")) return portfolioOf(account, { USDC: "150", ETH: "0.01" });
        if (account.startsWith("eip155:42161:")) return portfolioOf(account, { USDC: "150" });
        if (account.startsWith("solana:")) return portfolioOf(account, { SOL: "2.5" });
        return portfolioOf(account, {});
      },
    }));
    const snapshot = await readSnapshot(ACCOUNTS, [goal({ kind: "consolidate", spend: { asset: { symbol: "USDC" }, amount: { t: "max" } }, want: { at: { network: "base", custody: { kind: "wallet" } } } })], { now: T0 });
    const swept = seen.map((account) => account.split(":").slice(0, 2).join(":")).sort();
    const production = Object.values(CHAINS).filter((chain) => chain.lane === "production").map((chain) => chain.id).sort();
    assert.deepEqual(swept, production, "every production network, no testnet");
    assert.equal(snapshot.sweep.status, "partial");
    assert.deepEqual(snapshot.sweep.failures, [{ network: "optimism", reason: "read-failed" }]);
    assert.equal(holdingOf(snapshot, "arbitrum", "USDC")?.formatted, "150");
    assert.equal(holdingOf(snapshot, "optimism", "USDC")?.status, "unknown");
    assert.equal(holdingOf(snapshot, "optimism", "USDC")?.units, undefined);
    // Listed but not reported by a successful sweep: unknown ("not-reported"), never zero.
    const absent = holdingOf(snapshot, "arbitrum", "ETH");
    assert.equal(absent?.status, "unknown");
    assert.equal(absent?.reason, "not-reported");
    assert.equal(holdingOf(snapshot, "base", "USDC")?.usd, 150);
  });

  it("sweeps at most 4 accounts at a time and stops at the deadline", async () => {
    let inFlight = 0;
    let peak = 0;
    configureSnapshotReaders(readers({
      portfolio: async (account) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await sleep(account.startsWith("solana:") ? 5_000 : 40);
          return portfolioOf(account, { USDC: "10" });
        } finally {
          inFlight -= 1;
        }
      },
    }));
    const started = Date.now();
    const snapshot = await readSnapshot(ACCOUNTS, [goal({ kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "max" } } })], { deadlineMs: 250, now: T0 });
    const elapsed = Date.now() - started;
    assert.ok(peak <= 4, `peak ${peak}`);
    assert.equal(snapshot.sweep.peakConcurrency, peak);
    assert.ok(elapsed < 1_000, `took ${elapsed} ms`);
    assert.ok(snapshot.sweep.failures.some((failure) => failure.network === "solana" && failure.reason === "deadline"));
    assert.equal(holdingOf(snapshot, "solana", "SOL")?.status, "unknown");
    assert.equal(holdingOf(snapshot, "base", "USDC")?.status, "known");
  });

  it("never reads preview accounts and reads nothing with reads: none", async () => {
    let reads = 0;
    configureSnapshotReaders(readers({ portfolio: async (account) => { reads += 1; return portfolioOf(account, {}); } }));
    const preview = ["eip155:8453:0x9B58BE768EAB41bD43C8293DDDB6bf3c0D066590"] as AccountId[];
    const snapshot = await readSnapshot(preview, [goal({ kind: "consolidate", spend: { asset: { class: "usd-stable" } } })], { now: T0 });
    assert.equal(reads, 0);
    assert.ok(snapshot.sweep.failures.every((failure) => failure.reason === "preview"));
    assert.equal(holdingOf(snapshot, "base", "USDC")?.reason, "preview");
    const none = await readSnapshot(ACCOUNTS, [goal({ kind: "consolidate" })], { reads: "none" });
    assert.equal(none.holdings.length, 0);
    assert.equal(none.sweep.status, "skipped");
  });
});

describe("solver snapshot: positions", () => {
  const aaveBase = "base:aave-v3:usdc";

  function position(venue: string, units: string): VenuePosition {
    const usdc = findAssetBySymbol("base", "USDC");
    assert.ok(usdc);
    const amount = { asset: usdc.id, symbol: "USDC", decimals: 6, amount: units, formatted: fromBaseUnits(BigInt(units), 6) };
    return { venue, network: "base", protocol: "aave-v3", name: "Aave V3 USDC", receipt: amount, underlying: amount, rate: null, usd: Number(amount.formatted), apy: 0.04, withdrawableNow: amount, observedAt: new Date(T0).toISOString() };
  }

  it("reads positions only for exit goals, on at most 2 networks", async () => {
    let calls: NetworkKey[] = [];
    configureSnapshotReaders(readers({
      portfolio: async (account) => portfolioOf(account, {}),
      positions: async (account, network, options) => {
        calls.push(network);
        return { account, network, positions: (options.venues ?? []).includes(aaveBase) ? [position(aaveBase, "250000000")] : [], unavailable: [], observedAt: new Date(T0).toISOString() };
      },
      venue: async (venue): Promise<JourneyVenueFacts> => ({ name: venue.name, apy: 0.05, utilization: null, exitLiquidity: null, capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date(T0).toISOString() }),
    }));
    await readSnapshot(ACCOUNTS, [goal({ kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "10" }, from: { network: "base", custody: { kind: "wallet" } } } })], { now: T0 });
    assert.deepEqual(calls, [], "earn goals read no positions");

    calls = [];
    const named = await readSnapshot(ACCOUNTS, [goal({ kind: "exit", spend: { asset: { symbol: "USDC" }, amount: { t: "max" }, from: { network: "base", custody: { kind: "position", protocol: "aave-v3" } } } })], { now: T0 });
    assert.deepEqual(calls, ["base"]);
    assert.deepEqual(named.positionNetworks, ["base"]);
    assert.equal(positionAmount(named, "base", "aave-v3", "USDC"), "250");

    calls = [];
    const unnamed = await readSnapshot(ACCOUNTS, [goal({ kind: "exit", spend: { from: { custody: { kind: "position", protocol: "aave-v3" } } } })], { now: T0 });
    assert.equal(calls.length, 2, "at most 2 networks");
    assert.equal(unnamed.positionNetworks.length, 2);
    const beyond = unnamed.positions.filter((entry) => !unnamed.positionNetworks.includes(entry.network));
    assert.ok(beyond.length > 0 && beyond.every((entry) => entry.status === "unknown" && entry.reason === "not-read"));
  });

  it("keeps failed venues unknown and backs TurnFacts.position", async () => {
    configureSnapshotReaders(readers({
      positions: async (account, network, options) => ({
        account, network, positions: [position(aaveBase, "250000000")],
        unavailable: (options.venues ?? []).filter((venue) => venue !== aaveBase && venue.includes("morpho")).map((venue) => ({ venue, code: "RPC_TIMEOUT", message: "late" })),
        observedAt: new Date(T0).toISOString(),
      }),
    }));
    const snapshot = await readSnapshot(ACCOUNTS, [goal({ kind: "exit", spend: { from: { network: "base", custody: { kind: "position" } } } })], { now: T0 });
    assert.equal(positionAmount(snapshot, "base", "aave-v3", "USDC"), "250");
    assert.equal(positionAmount(snapshot, "base", "morpho", "USDC"), undefined, "a failed venue is unknown");
    assert.equal(positionAmount(snapshot, "base", "compound-v3", "USDC"), "0", "read, no position");
    const facts = new TurnFacts(ACCOUNTS);
    assert.equal(facts.position("base", "aave-v3", "USDC"), undefined, "no snapshot: unknown");
    facts.useSnapshot(snapshot);
    assert.equal(facts.position("base", "aave-v3", "USDC"), "250");
    assert.equal(facts.position("base", "compound-v3", "USDC"), undefined, "no position is not offered as an amount");
    assert.equal(facts.position("base", "morpho", "USDC"), undefined);
  });
});

describe("solver snapshot: prices and APY", () => {
  it("re-reads stale prices and never uses a still-stale one", async () => {
    let reads = 0;
    let readingAt = T0;
    configureSnapshotReaders(readers({
      price: async (asset): Promise<PriceQuoteView | null> => {
        reads += 1;
        return { usd: asset.includes("slip44") ? 3000 : 1, source: "jupiter", at: new Date(readingAt).toISOString() };
      },
    }));
    const goals = [goal({ kind: "acquire", want: { asset: { symbol: "ETH" }, amount: { t: "exact", value: "1" }, at: { network: "base", custody: { kind: "wallet" } } } })];
    const eth = nativeAssetId("base");
    const first = await readSnapshot(ACCOUNTS, goals, { now: T0 });
    assert.equal(usablePrice(first, eth)?.usd, 3000);
    const afterFirst = reads;
    assert.ok(afterFirst >= 1);
    await readSnapshot(ACCOUNTS, goals, { now: T0 + 30_000 });
    assert.equal(reads, afterFirst, "a fresh price is not read again");
    readingAt = T0 + 61_000;
    const later = await readSnapshot(ACCOUNTS, goals, { now: T0 + 61_000 });
    assert.ok(reads > afterFirst, "a price older than priceMaxAgeMs is read again");
    assert.equal(later.prices.get(eth)?.at, T0 + 61_000);
    // The source still answers with an old reading: kept as stale, never usable.
    readingAt = T0;
    const stale = await readSnapshot(ACCOUNTS, goals, { now: T0 + 200_000 });
    assert.equal(stale.prices.get(eth)?.stale, true);
    assert.equal(usablePrice(stale, eth), null);
  });

  it("judges oracle readings by fetch time (the pricer holds them to the feed heartbeat)", async () => {
    let reads = 0;
    configureSnapshotReaders(readers({
      price: async (): Promise<PriceQuoteView | null> => {
        reads += 1;
        return { usd: 2700, source: "chainlink", at: new Date(T0 - 6 * 3600_000).toISOString() };
      },
    }));
    const wsteth = findAssetBySymbol("base", "wstETH");
    assert.ok(wsteth);
    const goals = [goal({ kind: "convert", spend: { asset: { symbol: "wstETH" }, from: { network: "base", custody: { kind: "wallet" } } } })];
    const first = await readSnapshot(ACCOUNTS, goals, { now: T0 });
    assert.equal(usablePrice(first, wsteth.id)?.usd, 2700);
    const count = reads;
    await readSnapshot(ACCOUNTS, goals, { now: T0 + 30_000 });
    assert.equal(reads, count, "fetched 30 s ago: not read again");
    await readSnapshot(ACCOUNTS, goals, { now: T0 + 61_000 });
    assert.ok(reads > count, "fetched more than 60 s ago: read again");
  });

  it("reads APY for at most 6 candidate venues of an earn goal, safest tier first", async () => {
    const read: string[] = [];
    configureSnapshotReaders(readers({
      venue: async (venue): Promise<JourneyVenueFacts> => {
        read.push(venue.id);
        if (venue.protocol === "morpho") throw new Error("down");
        return { name: venue.name, apy: 0.041, utilization: null, exitLiquidity: null, capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date(T0).toISOString() };
      },
    }));
    const snapshot = await readSnapshot(ACCOUNTS, [goal({ kind: "earn", spend: { asset: { symbol: "USDC" }, amount: { t: "exact", value: "100" }, from: { network: "base", custody: { kind: "wallet" } } } })], { now: T0 });
    assert.ok(read.length > 0 && read.length <= 6, `read ${read.length}`);
    assert.ok(read.every((id) => id.startsWith("base:")));
    assert.ok(read.includes("base:aave-v3:usdc"));
    const aave = snapshot.apy.get("base:aave-v3:usdc");
    assert.equal(aave?.status, "known");
    assert.equal(aave?.apy, 0.041);
    for (const [id, entry] of snapshot.apy) if (id.includes(":morpho:")) assert.ok(entry.status === "unknown" && entry.apy === null);
    // Known readings are cached for 60 s; failed ones are read again.
    const before = read.length;
    const failed = read.filter((id) => id.includes(":morpho:")).length;
    await readSnapshot(ACCOUNTS, [goal({ kind: "earn", spend: { asset: { symbol: "USDC" }, from: { network: "base", custody: { kind: "wallet" } } } })], { now: T0 + 10_000 });
    assert.equal(read.length - before, failed);
  });
});
