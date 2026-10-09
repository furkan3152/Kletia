/**
 * The Rule Book's conservative USD oracle (policy design §5.1): Chainlink
 * decoding and per-feed freshness, Jupiter liquidity and slot freshness,
 * max of fresh sources, the $1.00 floor, testnets at $0, fail closed for
 * anything unpriced, caching, and the feed table drift checks.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAddress } from "viem";
import { ASSETS, CHAINS, getAsset, isSolanaAddress, type AssetDescriptor } from "@kletia/core";
import { ASSET_PRICE_SOURCES, CHAINLINK_FEEDS, CHAINLINK_GRACE_SECONDS, JUPITER_MINTS, normalizeAssetKey, priceSourcesFor } from "../policy/feeds.js";
import { configurePolicyPricing, notionalUsdMicros, policyPrice, quoteUsdNumber, toUsd18, usd18FromNumber } from "../policy/pricing.js";
import { nativeUsdPrice } from "../prices.js";
import { feed, feedKey, installMarket, jupiter, type FakeMarket } from "./policyHarness.js";

const ONE = 10n ** 18n;

function asset(network: string, symbol: string): AssetDescriptor {
  const found = ASSETS.find((entry) => entry.network === network && entry.symbol === symbol);
  assert.ok(found, `${symbol} on ${network} is in the registry`);
  return found;
}

function ref(descriptor: AssetDescriptor) {
  return { asset: descriptor.id, symbol: descriptor.symbol, decimals: descriptor.decimals, network: descriptor.network };
}

describe("policy pricing", () => {
  let market: FakeMarket;

  beforeEach(() => {
    market = installMarket();
  });

  afterEach(() => configurePolicyPricing(null));

  it("decodes Chainlink answers with the decimals read on-chain (8 and 18)", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdBase), feed(2_498.47, { now: market.now }));
    const eth = await policyPrice(ref(asset("base", "ETH")));
    assert.ok(eth);
    assert.equal(eth.usd18, 2_498_470_000n * 10n ** 12n);
    assert.equal(eth.readings.length, 1);
    assert.equal(eth.readings[0]?.source, "chainlink");
    // JITOSOL / USD on Base has 18 decimals: never assumed.
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.jitosolUsdBase), feed(144.298924, { decimals: 18, now: market.now }));
    const jito = await policyPrice(ref(asset("solana", "JitoSOL")));
    assert.ok(jito);
    assert.equal(jito.usd18, 144_298_924n * 10n ** 12n);
  });

  it("drops readings older than the feed's heartbeat plus 300 s, and non-positive answers", async () => {
    const heartbeat = CHAINLINK_FEEDS.ethUsdArbitrum.heartbeatSeconds;
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdArbitrum), feed(2_500, { now: market.now, ageSeconds: heartbeat + CHAINLINK_GRACE_SECONDS - 5 }));
    assert.ok(await policyPrice(ref(asset("arbitrum", "ETH"))), "inside the grace");
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdArbitrum), feed(2_500, { now: market.now, ageSeconds: heartbeat + CHAINLINK_GRACE_SECONDS + 5 }));
    assert.equal(await policyPrice(ref(asset("arbitrum", "ETH"))), null, "stale by heartbeat: unpriced");
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), { decimals: 8, answer: 0n, updatedAt: Math.floor(market.now / 1000) });
    assert.equal(await policyPrice(ref(asset("arbitrum", "ARB"))), null, "zero answer");
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), { decimals: 8, answer: -5n, updatedAt: Math.floor(market.now / 1000) });
    assert.equal(await policyPrice(ref(asset("arbitrum", "ARB"))), null, "negative answer");
  });

  it("accepts a block time slightly ahead of the clock (Polygon skew)", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.polUsdPolygon), { decimals: 8, answer: 9_897_200n, updatedAt: Math.floor(market.now / 1000) + 3 });
    const pol = await policyPrice(ref(asset("polygon", "POL")));
    assert.ok(pol);
    assert.equal(pol.usd18, 98_972n * 10n ** 12n);
  });

  it("takes the maximum of fresh sources and warns when they disagree by more than 25 %", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.solUsdEthereum), feed(110, { now: market.now }));
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.solUsdArbitrum), feed(111.5, { now: market.now }));
    market.jupiter.set(JUPITER_MINTS.wsol, jupiter(market, 110.4));
    const sol = await policyPrice(ref(asset("solana", "SOL")));
    assert.ok(sol);
    assert.equal(sol.usd18, 1115n * 10n ** 17n);
    assert.equal(sol.readings.length, 3);
    assert.deepEqual(sol.warnings, []);
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.wifUsdArbitrum), feed(0.2, { now: market.now }));
    market.jupiter.set(JUPITER_MINTS.wif, jupiter(market, 0.3));
    const wif = await policyPrice(ref(asset("solana", "WIF")));
    assert.ok(wif);
    assert.equal(wif.usd18, 3n * 10n ** 17n, "the higher price wins (it can only tighten)");
    assert.match(wif.warnings[0] ?? "", /disagree/u);
  });

  it("floors USD stablecoins at $1.00 and never lowers them", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.usdcUsdBase), feed(0.99981, { now: market.now }));
    const usdc = await policyPrice(ref(asset("base", "USDC")));
    assert.ok(usdc);
    assert.equal(usdc.usd18, ONE);
    assert.equal(usdc.floored, true);
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.usdcUsdArbitrum), feed(1.002, { now: market.now }));
    const high = await policyPrice(ref(asset("optimism", "USDC")));
    assert.ok(high);
    assert.equal(high.usd18, 1_002n * 10n ** 15n);
    assert.equal(high.floored, false);
    // EURC is a stablecoin but not a USD one: no floor.
    configurePolicyPricing(null);
    market = installMarket();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.eurUsdEthereum), feed(1.12, { now: market.now }));
    const eurc = await policyPrice(ref(asset("base", "EURC")));
    assert.ok(eurc);
    assert.equal(eurc.usd18, 112n * 10n ** 16n);
  });

  it("fails closed: no fresh source means unpriced, even for USD stablecoins", async () => {
    assert.equal(await policyPrice(ref(asset("base", "USDC"))), null);
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.usdcUsdBase), "throw");
    assert.equal(await policyPrice(ref(asset("base", "USDC"))), null);
  });

  it("prices testnet assets at $0 without reading any source", async () => {
    for (const [network, symbol] of [["arbitrum-sepolia", "ETH"], ["arc", "USDC"], ["solana-devnet", "SOL"]] as const) {
      const quote = await policyPrice(ref(asset(network, symbol)));
      assert.ok(quote, `${symbol} on ${network}`);
      assert.equal(quote.usd18, 0n);
      assert.equal(quote.basis, "testnet");
    }
    assert.equal(market.calls.ethCall + market.calls.jupiter, 0);
  });

  it("applies Jupiter's liquidity floor and slot freshness", async () => {
    const jup = ref(asset("solana", "JUP"));
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { liquidity: 99_999 }));
    assert.equal(await policyPrice(jup), null, "thin liquidity");
    configurePolicyPricing(null);
    market = installMarket();
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { blockId: Number(market.slot) - 901 }));
    assert.equal(await policyPrice(jup), null, "older than 900 slots");
    configurePolicyPricing(null);
    market = installMarket();
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { blockId: Number(market.slot) - 900 }));
    const fresh = await policyPrice(jup);
    assert.ok(fresh, "exactly 900 slots behind is fresh");
    assert.equal(fresh.usd18, 3_616n * 10n ** 14n);
    configurePolicyPricing(null);
    market = installMarket();
    market.slot = null;
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { blockId: 1 }));
    assert.equal(await policyPrice(jup), null, "without the current slot freshness cannot be shown");
  });

  it("prices unlisted Solana mints through Jupiter only, unlisted EVM tokens never", async () => {
    const mint = "5ZfZAwP2m93waazg8DkrrVmsupeiPEvaEHowiUP7UAbJ";
    assert.ok(isSolanaAddress(mint));
    market.jupiter.set(mint, jupiter(market, 2));
    const unlisted = await policyPrice({ asset: `${CHAINS.solana.id}/token:${mint}` as never, symbol: "XYZ", decimals: 6, network: "solana" });
    assert.ok(unlisted);
    assert.equal(unlisted.usd18, 2n * ONE);
    assert.equal(await policyPrice({ asset: "eip155:8453/erc20:0x1111111111111111111111111111111111111111" as never, symbol: "FAKE", decimals: 18, network: "base" }), null);
    assert.equal(await policyPrice({ asset: "eip155:8453/erc20:0x1111111111111111111111111111111111111111" as never, symbol: "USDC", decimals: 6, network: "base" }), null, "a reported symbol never borrows a registry price");
  });

  it("refuses an asset id on another network than claimed", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdBase), feed(2_500, { now: market.now }));
    assert.equal(await policyPrice({ ...ref(asset("base", "ETH")), network: "arbitrum" }), null);
  });

  it("caches readings 30 s and failures 5 s", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.aeroUsdBase), feed(0.807288, { now: market.now }));
    const aero = ref(asset("base", "AERO"));
    await policyPrice(aero);
    const first = market.calls.ethCall;
    assert.equal(first, 2, "decimals + latestRoundData");
    await policyPrice(aero);
    assert.equal(market.calls.ethCall, first, "cached");
    market.now += 31_000;
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.aeroUsdBase), feed(0.81, { now: market.now }));
    await policyPrice(aero);
    assert.equal(market.calls.ethCall, first + 1, "re-read after 30 s; decimals stay cached");
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), "throw");
    const arb = ref(asset("arbitrum", "ARB"));
    assert.equal(await policyPrice(arb), null);
    const afterFailure = market.calls.ethCall;
    assert.equal(await policyPrice(arb), null);
    assert.equal(market.calls.ethCall, afterFailure, "failure cached");
    market.now += 6_000;
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), feed(0.18, { now: market.now }));
    assert.ok(await policyPrice(arb), "retried after 5 s");
  });

  it("gives up on a source after 2 s", async () => {
    market.delayMs = 2_300;
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.daiUsdEthereum), feed(0.9995, { now: market.now }));
    const started = Date.now();
    assert.equal(await policyPrice(ref(asset("base", "DAI"))), null);
    assert.ok(Date.now() - started < 2_250, "the deadline, not the slow source, ended the read");
  });

  it("computes notional in integer micro-dollars, rounded up", () => {
    const quote = { usd18: 2_498_470_000n * 10n ** 12n };
    assert.equal(notionalUsdMicros("1000000000000000000", 18, quote), 2_498_470_000n);
    assert.equal(notionalUsdMicros("1", 18, quote), 1n, "dust rounds up to one micro-dollar");
    assert.equal(notionalUsdMicros("1500000", 6, { usd18: ONE }), 1_500_000n);
    assert.equal(notionalUsdMicros("0", 6, { usd18: ONE }), 0n);
    assert.equal(toUsd18(144_298_924_000_000_000_001n, 18), 144_298_924_000_000_000_001n);
    assert.equal(toUsd18(12_345n, 20), 124n, "scaling down rounds up");
    assert.equal(usd18FromNumber(0.00000333), 3_330_000_000_000n);
    assert.equal(usd18FromNumber(-1), null);
    assert.equal(usd18FromNumber(Number.NaN), null);
    assert.equal(quoteUsdNumber({ usd18: 98_972n * 10n ** 12n }), 0.098972);
  });

  it("lets advisory fee prices fall back to the oracle for POL (Polygon fees are no longer unknown)", async () => {
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.polUsdPolygon), feed(0.098972, { now: market.now }));
    assert.equal(await nativeUsdPrice("polygon"), 0.098972);
  });

  describe("feed table", () => {
    it("has a source for every mainnet registry asset and none for testnets", () => {
      for (const descriptor of ASSETS) {
        const sources = priceSourcesFor(descriptor.id);
        if (CHAINS[descriptor.network].environment === "testnet") {
          assert.equal(ASSET_PRICE_SOURCES.has(normalizeAssetKey(descriptor.id)), false, `${descriptor.symbol} on ${descriptor.network}`);
        } else {
          assert.ok(sources.length >= 1, `${descriptor.symbol} on ${descriptor.network} has a price source`);
        }
      }
    });

    it("lists EIP-55 proxies on EVM mainnets with positive heartbeats and valid Jupiter mints", () => {
      for (const [name, entry] of Object.entries(CHAINLINK_FEEDS)) {
        assert.equal(getAddress(entry.address), entry.address, `${name} is checksummed`);
        assert.equal(CHAINS[entry.network].environment, "mainnet", `${name} reads a mainnet`);
        assert.ok(entry.heartbeatSeconds > 0 && entry.heartbeatSeconds <= 86_400, `${name} heartbeat`);
      }
      for (const [name, mint] of Object.entries(JUPITER_MINTS)) assert.ok(isSolanaAddress(mint), `${name} mint`);
      // The Jupiter id of each listed Solana token is its own mint.
      for (const descriptor of ASSETS.filter((entry) => entry.network === "solana" && entry.address)) {
        const jupiterSources = priceSourcesFor(descriptor.id).filter((source) => source.kind === "jupiter");
        assert.ok(jupiterSources.some((source) => source.kind === "jupiter" && source.mint === descriptor.address), `${descriptor.symbol} is priced by its own mint`);
      }
      assert.ok(getAsset(asset("solana", "SOL").id));
    });
  });
});
