/**
 * Venue positions and capacity: Compound V3 and Moonwell read through
 * their adapters against in-process contract state; Aave, ERC-4626 and
 * Jupiter Lend through stub adapters (their real `positionOf` belongs to
 * other packages or needs the Solana reads); unknown reads are reported,
 * never empty positions.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Abi } from "viem";
import type { AccountId, AssetAmount, CometVenue, CTokenVenue, VenuePosition, YieldVenue } from "@kletia/core";
import type { ProtocolAdapter } from "../adapters/types.js";
import { compoundV3Adapter, COMET_ABI } from "../adapters/lending/compoundV3.js";
import { resetLendingMetricsCache } from "../adapters/lending/metrics.js";
import { COMPTROLLER_ABI, moonwellAdapter, MTOKEN_ABI, mTokenShareRate, PAYOUT_ABI } from "../adapters/lending/moonwell.js";
import { jlShareRate } from "../adapters/jupiterLend.js";
import { kaminoAdapter } from "../adapters/kamino.js";
import { configurePreviewPricer } from "../preview/index.js";
import { readVenuePositions } from "../journey/positions.js";
import { configurePlatform } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { EVM_ADDRESS } from "./helpers.js";
import { installLendingChain, mockToken, Revert, setBalance, tokenAddress, venue, type LendingChain } from "./lendingChain.js";

let chain: LendingChain;
const ACCOUNT = `eip155:8453:${EVM_ADDRESS}` as AccountId;

function amount(asset: string, symbol: string, decimals: number, units: bigint): AssetAmount {
  return { asset: asset as AssetAmount["asset"], symbol, decimals, amount: units.toString(), formatted: String(units) };
}

/** An adapter that reports a fixed position (Aave and ERC-4626 families; their own suites cover the real reads). */
function stubPositions(id: ProtocolAdapter["id"], positions: Record<string, VenuePosition | null | Error>): ProtocolAdapter {
  return {
    id,
    protocols: [id],
    label: id,
    supports: () => false,
    plan: async () => { throw new Error("not used"); },
    prepare: async () => { throw new Error("not used"); },
    verify: async () => { throw new Error("not used"); },
    positionOf: async (target: YieldVenue) => {
      const value = positions[target.id];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
  };
}

beforeEach(() => {
  chain = installLendingChain();
  resetLendingMetricsCache();
  configurePreviewPricer({ price: async (asset) => (asset.toLowerCase().includes("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") ? 1 : null) });
});

afterEach(() => {
  chain.restore();
  configurePreviewPricer(null);
  configurePlatform({ store: new MemoryIntentStore(), adapters: null });
});

function mockComet(position: bigint, cash: bigint, paused = { supply: false, withdraw: false }): CometVenue {
  const comet = venue<CometVenue>("base:compound-v3:usdc");
  const token = tokenAddress("base", "USDC");
  const usdc = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  setBalance(usdc, comet.target, cash);
  chain.contract(comet.target, COMET_ABI as unknown as Abi, {
    baseToken: () => token,
    decimals: () => 6,
    isSupplyPaused: () => paused.supply,
    isWithdrawPaused: () => paused.withdraw,
    balanceOf: () => position,
    getUtilization: () => 900_000_000_000_000_000n,
    getSupplyRate: () => 1_268_391_679n,
    totalSupply: () => 10n ** 13n,
  });
  return comet;
}

/** 0.02 USDC per mToken scaled 1e18 (6 vs 8 decimals). */
const RATE = 200_000_000_000_000n;

function mockMoonwell(tokens: bigint, cash: bigint, supplyCap = 0n, mintPaused = false): CTokenVenue {
  const market = venue<CTokenVenue>("base:moonwell:usdc");
  const token = tokenAddress("base", "USDC");
  chain.contract(market.target, [...MTOKEN_ABI, ...PAYOUT_ABI] as unknown as Abi, {
    wethUnwrapper: () => { throw new Revert(); },
    underlying: () => token,
    comptroller: () => market.comptroller,
    decimals: () => 8,
    getCash: () => cash,
    totalBorrows: () => 9n * cash,
    totalReserves: () => 0n,
    supplyRatePerTimestamp: () => 1_585_489_599n,
    exchangeRateCurrent: () => RATE,
    balanceOf: () => tokens,
  });
  chain.contract(market.comptroller, COMPTROLLER_ABI as unknown as Abi, {
    markets: () => [true, 800_000_000_000_000_000n],
    mintGuardianPaused: () => mintPaused,
    supplyCaps: () => supplyCap,
  });
  return market;
}

describe("readVenuePositions", () => {
  it("lists Comet, Moonwell, Aave and ERC-4626 positions valued in the underlying with the rate used", async () => {
    const usdc = tokenAddress("base", "USDC");
    const aave = venue<YieldVenue>("base:aave-v3:usdc");
    const vault = venue<YieldVenue>("base:morpho:steakhouse-prime-usdc");
    const aToken = amount(`eip155:8453/erc20:${"0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"}`, "aBasUSDC", 6, 1_234_567n);
    const shares = amount(`eip155:8453/erc20:${"0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9"}`, "steakUSDC", 18, 2n * 10n ** 18n);
    const now = new Date().toISOString();
    configurePlatform({
      store: new MemoryIntentStore(),
      adapters: [
        compoundV3Adapter,
        moonwellAdapter,
        stubPositions("aave-v3", {
          [aave.id]: { venue: aave.id, network: "base", protocol: "aave-v3", name: aave.name, receipt: aToken, underlying: amount(`eip155:8453/erc20:${usdc}`, "USDC", 6, 1_234_567n), rate: null, usd: null, apy: 0.04, withdrawableNow: null, observedAt: now },
        }),
        stubPositions("morpho", {
          [vault.id]: { venue: vault.id, network: "base", protocol: "morpho", name: vault.name, receipt: shares, underlying: amount(`eip155:8453/erc20:${usdc}`, "USDC", 6, 2_094_800n), rate: "1047400000000000000", usd: null, apy: 0.0463, withdrawableNow: null, observedAt: now },
        }),
      ],
    });
    mockComet(5_000_000n, 3_000_000n);
    mockMoonwell(50_000_000_000n, 10n ** 12n);
    const result = await readVenuePositions(ACCOUNT, "base", { venues: ["base:compound-v3:usdc", "base:moonwell:usdc", aave.id, vault.id] });
    const byVenue = new Map(result.positions.map((position) => [position.venue, position]));
    assert.deepEqual(result.unavailable, []);

    const comet = byVenue.get("base:compound-v3:usdc");
    assert.equal(comet?.underlying.amount, "5000000");
    assert.equal(comet?.rate, null);
    // Withdrawable now is bounded by the Comet's cash.
    assert.equal(comet?.withdrawableNow?.amount, "3000000");
    assert.equal(comet?.usd, 5);

    const moonwell = byVenue.get("base:moonwell:usdc");
    assert.equal(moonwell?.receipt.amount, "50000000000");
    // 500 mUSDC × 0.02 = 10 USDC.
    assert.equal(moonwell?.underlying.amount, "10000000");
    assert.equal(moonwell?.rate, mTokenShareRate(RATE, 8, 6).toString());
    assert.equal(moonwell?.rate, "20000000000000000");
    assert.equal(moonwell?.usd, 10);

    assert.equal(byVenue.get(aave.id)?.underlying.amount, "1234567");
    assert.equal(byVenue.get(aave.id)?.usd, 1.23);
    assert.equal(byVenue.get(vault.id)?.rate, "1047400000000000000");
    assert.equal(byVenue.get(vault.id)?.usd, 2.09);
  });

  it("reports failed reads, adapters without a position reader and Kamino obligations as unavailable, never as empty", async () => {
    configurePlatform({
      store: new MemoryIntentStore(),
      adapters: [compoundV3Adapter, moonwellAdapter, stubPositions("aave-v3", { "base:aave-v3:usdc": new Error("rpc down") })],
    });
    mockComet(0n, 1n);
    const result = await readVenuePositions(ACCOUNT, "base", { venues: ["base:compound-v3:usdc", "base:moonwell:usdc", "base:aave-v3:usdc", "base:fluid:usdc"] });
    // An empty Comet is no position (read fine, balance 0).
    assert.equal(result.positions.length, 0);
    const codes = new Map(result.unavailable.map((entry) => [entry.venue, entry.code]));
    assert.ok(codes.has("base:moonwell:usdc"), "the unmocked Moonwell read failed");
    assert.ok(codes.has("base:aave-v3:usdc"));
    assert.equal(codes.get("base:fluid:usdc"), "POSITION_UNAVAILABLE");
    const solana = await readVenuePositions("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as AccountId, "solana", { venues: ["solana:kamino:usdc"] });
    assert.deepEqual(solana.unavailable.map((entry) => [entry.venue, entry.code]), [["solana:kamino:usdc", "POSITION_UNAVAILABLE"]]);
    const demo = await readVenuePositions("eip155:8453:0x000000000000000000000000000000000000dEaD" as AccountId, "solana");
    assert.equal(demo.unavailable[0]?.code, "ACCOUNT_INVALID");
  });

  it("converts share prices to 18-decimal underlying-per-share rates", () => {
    // Jupiter Lend: 1.0213 USDC per jlUSDC (convertToAssets = units per 10^6).
    assert.equal(jlShareRate(1_021_300n, 6), 1_021_300_000_000_000_000n);
    // Moonwell WETH: rate scaled 1e(18 + 18 - 8); 0.02 WETH per mWETH.
    assert.equal(mTokenShareRate(200_000_000_000_000_000_000_000_000n, 8, 18), 20_000_000_000_000_000n);
  });
});

describe("venueCapacity", () => {
  it("Comet: pause flags, cash that can leave, no cap", async () => {
    const comet = mockComet(0n, 7_000_000n, { supply: true, withdraw: false });
    const capacity = await compoundV3Adapter.venueCapacity?.(comet);
    assert.equal(capacity?.paused, true);
    assert.equal(capacity?.capRemaining, null);
    assert.equal(capacity?.exitLiquidity, "7000000");
    assert.equal(capacity?.shareRate, null);
    const frozen = mockComet(0n, 7_000_000n, { supply: false, withdraw: true });
    assert.equal((await compoundV3Adapter.venueCapacity?.(frozen))?.exitLiquidity, "0");
  });

  it("Moonwell: supply cap headroom (0 = no cap), mint pause, cash and share rate", async () => {
    const market = mockMoonwell(0n, 1_000_000n, 15_000_000n, true);
    const capacity = await moonwellAdapter.venueCapacity?.(market);
    // Supplied = cash + borrows - reserves = 10 USDC; cap 15 USDC.
    assert.equal(capacity?.capRemaining, "5000000");
    assert.equal(capacity?.paused, true);
    assert.equal(capacity?.exitLiquidity, "1000000");
    assert.equal(capacity?.shareRate, "20000000000000000");
    assert.equal(capacity?.utilization, 0.9);
    const uncapped = mockMoonwell(0n, 1_000_000n, 0n);
    assert.equal((await moonwellAdapter.venueCapacity?.(uncapped))?.capRemaining, null);
  });

  it("adapters refuse venues of another kind (no guessing)", async () => {
    await assert.rejects(() => moonwellAdapter.venueCapacity!(venue<YieldVenue>("base:compound-v3:usdc")), /not a Moonwell market/u);
    await assert.rejects(() => kaminoAdapter.venueCapacity!(venue<YieldVenue>("base:compound-v3:usdc")), /not a Kamino reserve/u);
  });
});
