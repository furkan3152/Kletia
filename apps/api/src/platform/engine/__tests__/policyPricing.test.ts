/**
 * The Rule Book's conservative USD oracle: Chainlink decoding and
 * per-feed freshness, Jupiter liquidity and slot freshness, max of fresh
 * sources, the $1.00 floor, testnets at $0, fail closed for anything
 * unpriced, caching, and the feed table drift checks.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { ASSETS, CHAINS, getAsset, isSolanaAddress, type AssetDescriptor } from "@kletia/core";
import {
  ASSET_PRICE_SOURCES,
  CHAINLINK_FEEDS,
  CHAINLINK_GRACE_SECONDS,
  DERIVED_FEEDS,
  JUPITER_MINTS,
  normalizeAssetKey,
  priceSourcesFor,
  PYTH_FEEDS,
  PYTH_RECEIVER,
  SEQUENCER_GRACE_SECONDS,
  SEQUENCER_UPTIME_FEEDS,
  UNPRICED_SYMBOLS,
  WSTETH_ETHEREUM,
} from "../policy/feeds.js";
import {
  configurePolicyPricing,
  decodePythPriceUpdate,
  notionalUsdMicros,
  policyPrice,
  pythFeedAccount,
  quoteUsdNumber,
  toUsd18,
  usd18FromNumber,
} from "../policy/pricing.js";
import { nativeUsdPrice } from "../prices.js";
import { feed, feedKey, installMarket, jupiter, type FakeMarket } from "./policyHarness.js";

const ONE = 10n ** 18n;

/** An L2 sequencer uptime feed answer: 0 = up, 1 = down, status changed `sinceSeconds` ago. */
function sequencerStatus(market: FakeMarket, status: 0n | 1n, sinceSeconds: number) {
  return { decimals: 0, answer: status, updatedAt: Math.floor(market.now / 1000) - sinceSeconds };
}

/** The scripted market with every L2 sequencer up for two hours (readings on Arbitrum, OP and Base count). */
function install(): FakeMarket {
  const next = installMarket();
  for (const entry of Object.values(SEQUENCER_UPTIME_FEEDS)) next.chainlink.set(feedKey(entry), sequencerStatus(next, 0n, 7_200));
  return next;
}

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
    market = install();
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
    market = install();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdArbitrum), feed(2_500, { now: market.now, ageSeconds: heartbeat + CHAINLINK_GRACE_SECONDS + 5 }));
    assert.equal(await policyPrice(ref(asset("arbitrum", "ETH"))), null, "stale by heartbeat: unpriced");
    configurePolicyPricing(null);
    market = install();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), { decimals: 8, answer: 0n, updatedAt: Math.floor(market.now / 1000) });
    assert.equal(await policyPrice(ref(asset("arbitrum", "ARB"))), null, "zero answer");
    configurePolicyPricing(null);
    market = install();
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
    market = install();
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
    market = install();
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.usdcUsdArbitrum), feed(1.002, { now: market.now }));
    const high = await policyPrice(ref(asset("optimism", "USDC")));
    assert.ok(high);
    assert.equal(high.usd18, 1_002n * 10n ** 15n);
    assert.equal(high.floored, false);
    // EURC is a stablecoin but not a USD one: no floor.
    configurePolicyPricing(null);
    market = install();
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
    market = install();
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { blockId: Number(market.slot) - 901 }));
    assert.equal(await policyPrice(jup), null, "older than 900 slots");
    configurePolicyPricing(null);
    market = install();
    market.jupiter.set(JUPITER_MINTS.jup, jupiter(market, 0.3616, { blockId: Number(market.slot) - 900 }));
    const fresh = await policyPrice(jup);
    assert.ok(fresh, "exactly 900 slots behind is fresh");
    assert.equal(fresh.usd18, 3_616n * 10n ** 14n);
    configurePolicyPricing(null);
    market = install();
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
    assert.equal(first, 3, "the Base sequencer, decimals + latestRoundData");
    await policyPrice(aero);
    assert.equal(market.calls.ethCall, first, "cached");
    market.now += 31_000;
    market.chainlink.set(feedKey(CHAINLINK_FEEDS.aeroUsdBase), feed(0.81, { now: market.now }));
    await policyPrice(aero);
    assert.equal(market.calls.ethCall, first + 2, "sequencer and round re-read after 30 s; decimals stay cached");
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

  describe("L2 sequencer gating", () => {
    it("ignores Arbitrum, OP and Base readings while the sequencer is down", async () => {
      for (const [network, entry] of [["base", CHAINLINK_FEEDS.ethUsdBase], ["arbitrum", CHAINLINK_FEEDS.ethUsdArbitrum], ["optimism", CHAINLINK_FEEDS.ethUsdOptimism]] as const) {
        configurePolicyPricing(null);
        market = install();
        market.chainlink.set(feedKey(SEQUENCER_UPTIME_FEEDS[network]!), sequencerStatus(market, 1n, 7_200));
        market.chainlink.set(feedKey(entry), feed(2_500, { now: market.now }));
        assert.equal(await policyPrice(ref(asset(network, "ETH"))), null, `${network}: sequencer down`);
      }
    });

    it(`ignores them within ${SEQUENCER_GRACE_SECONDS} s of a restart and uses them after`, async () => {
      market.chainlink.set(feedKey(SEQUENCER_UPTIME_FEEDS.base!), sequencerStatus(market, 0n, SEQUENCER_GRACE_SECONDS - 60));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdBase), feed(2_500, { now: market.now }));
      assert.equal(await policyPrice(ref(asset("base", "ETH"))), null, "restarted 59 minutes ago");
      configurePolicyPricing(null);
      market = install();
      market.chainlink.set(feedKey(SEQUENCER_UPTIME_FEEDS.base!), sequencerStatus(market, 0n, SEQUENCER_GRACE_SECONDS + 60));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdBase), feed(2_500, { now: market.now }));
      const eth = await policyPrice(ref(asset("base", "ETH")));
      assert.ok(eth, "up for 61 minutes");
      assert.equal(eth.usd18, 2_500n * ONE);
    });

    it("fails closed when the uptime feed cannot be read, and never gates Ethereum or Polygon", async () => {
      for (const failure of ["revert", "throw"] as const) {
        configurePolicyPricing(null);
        market = install();
        market.chainlink.set(feedKey(SEQUENCER_UPTIME_FEEDS.arbitrum!), failure);
        market.chainlink.set(feedKey(CHAINLINK_FEEDS.arbUsdArbitrum), feed(0.4, { now: market.now }));
        assert.equal(await policyPrice(ref(asset("arbitrum", "ARB"))), null, `uptime feed ${failure}`);
      }
      configurePolicyPricing(null);
      market = installMarket();
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdEthereum), feed(2_500, { now: market.now }));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.polUsdPolygon), feed(0.1, { now: market.now }));
      assert.ok(await policyPrice(ref(asset("ethereum", "ETH"))), "Ethereum has no sequencer");
      assert.ok(await policyPrice(ref(asset("polygon", "POL"))), "Polygon PoS has no sequencer feed");
    });

    it("keeps the maximum of fresh sources: a gated L2 reading drops out, the others still count", async () => {
      market.chainlink.set(feedKey(SEQUENCER_UPTIME_FEEDS.arbitrum!), sequencerStatus(market, 1n, 60));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.solUsdEthereum), feed(110, { now: market.now }));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.solUsdArbitrum), feed(150, { now: market.now }));
      market.jupiter.set(JUPITER_MINTS.wsol, jupiter(market, 111));
      const sol = await policyPrice(ref(asset("solana", "SOL")));
      assert.ok(sol);
      assert.equal(sol.readings.length, 2, "the Arbitrum reading is ignored while its sequencer is down");
      assert.equal(sol.usd18, 111n * ONE);
    });
  });

  describe("liquid staking prices", () => {
    const RATE_ABI = parseAbi(["function stEthPerToken() view returns (uint256)"]);
    const FEED_ABI = parseAbi([
      "function decimals() view returns (uint8)",
      "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    ]);

    /** The scripted Chainlink market plus wstETH.stEthPerToken() (null: reverts). */
    function withRate(rate: bigint | null): void {
      const current = market;
      configurePolicyPricing({
        ethCall: async (network, to, data) => {
          if (network === "ethereum" && to.toLowerCase() === WSTETH_ETHEREUM.toLowerCase()) {
            return rate === null ? null : (encodeFunctionResult({ abi: RATE_ABI, functionName: "stEthPerToken", result: rate }) as Hex);
          }
          const entry = current.chainlink.get(`${network}:${to.toLowerCase()}`);
          if (entry === undefined || entry === "revert") return null;
          if (entry === "throw") throw new Error("rpc down");
          if (data.startsWith("0x313ce567")) return encodeFunctionResult({ abi: FEED_ABI, functionName: "decimals", result: entry.decimals }) as Hex;
          return encodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", result: [1n, entry.answer, BigInt(entry.updatedAt), BigInt(entry.updatedAt), 1n] }) as Hex;
        },
        now: () => current.now,
      });
    }

    it("prices wstETH as STETH / USD times stEthPerToken()", async () => {
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.stethUsdEthereum), feed(2_427.0683, { now: market.now }));
      withRate(1_246_316_517_415_262_462n);
      const wsteth = await policyPrice(ref(asset("ethereum", "wstETH")));
      assert.ok(wsteth);
      assert.equal(wsteth.readings[0]?.source, "derived");
      assert.equal(wsteth.readings[0]?.id, DERIVED_FEEDS.wstethUsd.id);
      // 2427.0683 x 1.246316517415262462, rounded up.
      assert.equal(wsteth.usd18, (2_427_068_300n * 10n ** 12n * 1_246_316_517_415_262_462n + ONE - 1n) / ONE);
      assert.ok(Math.abs(quoteUsdNumber(wsteth) - 3_024.896) < 0.01);
    });

    it("prices rETH and weETH as their ETH ratio times ETH / USD (18-decimal ratios read on-chain)", async () => {
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdEthereum), feed(2_500, { now: market.now }));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.rethEthEthereum), { decimals: 18, answer: 1_170_928_265_256_063_700n, updatedAt: Math.floor(market.now / 1000) - 80_000 });
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.weethEthEthereum), { decimals: 18, answer: 1_105_571_912_979_631_600n, updatedAt: Math.floor(market.now / 1000) - 50_000 });
      const reth = await policyPrice(ref(asset("ethereum", "rETH")));
      const weeth = await policyPrice(ref(asset("ethereum", "weETH")));
      assert.ok(reth && weeth);
      assert.equal(reth.usd18, 2_927_320_663_140_159_250_000n);
      assert.equal(weeth.usd18, 2_763_929_782_449_079_000_000n);
      assert.equal(reth.readings[0]?.observedAt, Math.floor(market.now / 1000) - 80_000, "the oldest factor dates the reading");
    });

    it("fails closed when a factor is stale or the exchange rate is unreadable or out of bounds", async () => {
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.ethUsdEthereum), feed(2_500, { now: market.now, ageSeconds: 3_600 + CHAINLINK_GRACE_SECONDS + 1 }));
      market.chainlink.set(feedKey(CHAINLINK_FEEDS.rethEthEthereum), { decimals: 18, answer: 1_170_000_000_000_000_000n, updatedAt: Math.floor(market.now / 1000) });
      assert.equal(await policyPrice(ref(asset("ethereum", "rETH"))), null, "stale ETH / USD");
      for (const rate of [null, 0n, 999_999_999_999_999_999n, 2n * ONE + 1n]) {
        configurePolicyPricing(null);
        market = install();
        market.chainlink.set(feedKey(CHAINLINK_FEEDS.stethUsdEthereum), feed(2_427, { now: market.now }));
        withRate(rate);
        assert.equal(await policyPrice(ref(asset("ethereum", "wstETH"))), null, `stEthPerToken ${rate}`);
      }
    });
  });

  describe("feed table", () => {
    it("has a source for every mainnet registry asset and none for testnets", () => {
      // Transfer-only assets (USDbC) have no venue route and no price source of their own.
      for (const descriptor of ASSETS) {
        const sources = priceSourcesFor(descriptor.id);
        if (descriptor.transferOnly) continue;
        // Listed mainnet assets without a verified feed stay unpriced (fail closed), by name only.
        if ((UNPRICED_SYMBOLS[descriptor.network as keyof typeof UNPRICED_SYMBOLS] ?? []).includes(descriptor.symbol)) {
          assert.equal(sources.length, 0, `${descriptor.symbol} on ${descriptor.network} is unpriced`);
          continue;
        }
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

/**
 * Pyth push feeds: decoding from the evidence bytes (Solana mainnet,
 * 2026-10-14) and every reason a reading is ignored.
 */
describe("Pyth push feeds", () => {
  // getAccountInfo of the SOL/USD and USDC/USD shard-0 push feeds (134 bytes each).
  const SOL_USD = "IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bV6HQW8CAAAA984pAAAAAAD4////foHPagAAAAB9gc9qAAAAALjQungCAAAAH00yAAAAAAD/BDsbAAAAAAA=";
  const USDC_USD = "IvEjY51+9M2+k5qDCfVkBxh//zCsVLFpSYvpn22OG/1CRGgM1PfR4gHqoCDGHMR5cSgTRhzhU4lKlqbACyHtDPwnmNH5qenJSmSo9QUAAAAAaI4BAAAAAAD4////WYHPagAAAABYgc9qAAAAAHOt9QUAAAAAkHoBAAAAAABNBDsbAAAAAAA=";
  const SOL_PUBLISHED = 1_791_983_998;
  const SOL_PRICE = 10_456_500_062n;
  const bytes = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));
  const sol = () => ref(asset("solana", "SOL"));
  let accounts: Map<string, { owner: string; data: Uint8Array }>;
  let now: number;
  let jupiterUsd: number | null;

  beforeEach(() => {
    accounts = new Map([[PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data: bytes(SOL_USD) }],
      [PYTH_FEEDS.usdcUsd.account, { owner: PYTH_RECEIVER, data: bytes(USDC_USD) }]]);
    now = (SOL_PUBLISHED + 10) * 1000;
    jupiterUsd = null;
    configurePolicyPricing({
      ethCall: async () => null,
      jupiterPrices: async (mints) => (jupiterUsd === null ? {} : Object.fromEntries(mints.map((mint) => [mint, { usdPrice: jupiterUsd, liquidity: 10_000_000, blockId: 100 }]))),
      solanaSlot: async () => 100n,
      solanaAccount: async (account) => accounts.get(account) ?? null,
      now: () => now,
    });
  });

  afterEach(() => configurePolicyPricing(null));

  it("decodes PriceUpdateV2 from the evidence bytes", () => {
    const update = decodePythPriceUpdate(bytes(SOL_USD));
    assert.deepEqual(update, {
      writeAuthority: PYTH_FEEDS.solUsd.account, verification: "full", feedId: PYTH_FEEDS.solUsd.feedId,
      price: SOL_PRICE, conf: 2_739_959n, exponent: -8, publishTime: SOL_PUBLISHED,
    });
    const usdc = decodePythPriceUpdate(bytes(USDC_USD));
    assert.equal(usdc?.feedId, PYTH_FEEDS.usdcUsd.feedId);
    assert.equal(usdc?.price, 99_985_508n);
    assert.equal(decodePythPriceUpdate(bytes(SOL_USD).subarray(0, 120)), null, "truncated");
    const wrong = bytes(SOL_USD); wrong[0] ^= 1;
    assert.equal(decodePythPriceUpdate(wrong), null, "another account type");
  });

  it("reads every feed from the shard-0 PDA of its feed id under the push oracle", async () => {
    for (const [name, entry] of Object.entries(PYTH_FEEDS)) assert.equal(await pythFeedAccount(entry.feedId), entry.account, name);
    for (const symbol of ["SOL", "USDC", "JitoSOL", "mSOL"]) {
      assert.ok(priceSourcesFor(asset("solana", symbol).id).some((source) => source.kind === "pyth"), symbol);
    }
    for (const network of ["ethereum", "base", "arbitrum", "optimism", "polygon"]) {
      const eth = ASSETS.find((entry) => entry.network === network && entry.group === "ETH");
      assert.ok(eth && priceSourcesFor(eth.id).includes(PYTH_FEEDS.ethUsd), network);
    }
  });

  it("prices SOL from a fresh, Full, owner-checked Pyth reading", async () => {
    const quote = await policyPrice(sol());
    assert.ok(quote);
    assert.deepEqual(quote.readings.map((reading) => [reading.source, reading.id, reading.observedAt]), [["pyth", PYTH_FEEDS.solUsd.account, SOL_PUBLISHED]]);
    assert.equal(quote.usd18, SOL_PRICE * 10n ** 10n);
  });

  it("ignores a wrong owner, a wrong feed id, a stale or future reading, a wide confidence and partial verification", async () => {
    const cases: [string, () => void][] = [
      ["owner", () => accounts.set(PYTH_FEEDS.solUsd.account, { owner: OTHER_OWNER, data: bytes(SOL_USD) })],
      ["feed id", () => accounts.set(PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data: bytes(USDC_USD) })],
      ["stale", () => { now = (SOL_PUBLISHED + 61) * 1000; }],
      ["future", () => { now = (SOL_PUBLISHED - 61) * 1000; }],
      ["confidence", () => {
        const data = bytes(SOL_USD);
        // conf (u64 at 81) just above 2 % of the price.
        new DataView(data.buffer).setBigUint64(81, SOL_PRICE * 200n / 10_000n + 1n, true);
        accounts.set(PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data });
      }],
      ["partial", () => {
        const full = bytes(SOL_USD);
        // verification_level Partial { num_signatures: 5 } shifts the message by one byte.
        accounts.set(PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data: Uint8Array.from([...full.subarray(0, 40), 0, 5, ...full.subarray(41, 133)]) });
      }],
      ["missing", () => accounts.delete(PYTH_FEEDS.solUsd.account)],
    ];
    for (const [name, apply] of cases) {
      configurePolicyPricing(null);
      now = (SOL_PUBLISHED + 10) * 1000;
      accounts.set(PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data: bytes(SOL_USD) });
      configurePolicyPricing({
        ethCall: async () => null,
        jupiterPrices: async () => ({}),
        solanaSlot: async () => 100n,
        solanaAccount: async (account) => accounts.get(account) ?? null,
        now: () => now,
      });
      apply();
      assert.equal(await policyPrice(sol()), null, name);
    }
    // At exactly 60 s and 2 % the reading still counts.
    now = (SOL_PUBLISHED + 60) * 1000;
    const data = bytes(SOL_USD);
    new DataView(data.buffer).setBigUint64(81, SOL_PRICE * 200n / 10_000n, true);
    accounts.set(PYTH_FEEDS.solUsd.account, { owner: PYTH_RECEIVER, data });
    configurePolicyPricing({ ethCall: async () => null, jupiterPrices: async () => ({}), solanaSlot: async () => 100n,
      solanaAccount: async (account) => accounts.get(account) ?? null, now: () => now });
    assert.ok(await policyPrice(sol()), "boundary");
  });

  it("keeps the maximum of fresh sources with Pyth beside Jupiter", async () => {
    jupiterUsd = 110;
    const high = await policyPrice(sol());
    assert.equal(high?.usd18, 110n * ONE);
    assert.deepEqual(high?.readings.map((reading) => reading.source).sort(), ["jupiter", "pyth"]);
    configurePolicyPricing({ ethCall: async () => null, solanaSlot: async () => 100n, now: () => now,
      jupiterPrices: async (mints) => Object.fromEntries(mints.map((mint) => [mint, { usdPrice: 100, liquidity: 10_000_000, blockId: 100 }])),
      solanaAccount: async (account) => accounts.get(account) ?? null });
    assert.equal((await policyPrice(sol()))?.usd18, SOL_PRICE * 10n ** 10n, "Pyth is higher");
  });

  it("never reads a Pyth account live through a partial transport without solanaAccount", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error("offline"); }) as typeof fetch;
    try {
      configurePolicyPricing({ ethCall: async () => null, jupiterPrices: async () => ({}), solanaSlot: async () => 100n, now: () => now });
      assert.equal(await policyPrice(sol()), null);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

const OTHER_OWNER = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";

