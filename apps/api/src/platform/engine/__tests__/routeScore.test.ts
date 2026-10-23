/**
 * Route score (design B.1) and venue statistics (B.2): every term of the
 * value, floor eligibility, the selection rules (preferred protocols, the
 * multi-leg margin, ties, estimates), the circuit breaker that counts only
 * transport errors, 5xx, 429 and timeouts (red-team D7), haircuts bucketed by
 * size (D12), fill rates with their prior, and claimed floors counted
 * conservatively until 50 verified fills (D1).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { nativeAssetId, type AssetAmount } from "@kletia/core";
import { PlatformError, providerRateLimited } from "../../errors.js";
import { resolveAsset } from "../assets.js";
import { configurePriceReader, fixedPriceReader } from "../prices.js";
import {
  amountUsd,
  configureScoreFacts,
  extraCostsOutUnits,
  extraCostsUsd,
  FASTEST_LAMBDA_T_FACTOR,
  floorWithinSlippage,
  haircutPriorBps,
  isSolverFilled,
  LAMBDA_S_USD,
  LAMBDA_T_USD_PER_SECOND,
  legGasUsd,
  NON_FILL_LOCK_SECONDS,
  nonFillCostUsd,
  readAssetUsd,
  scoreLeg,
  selectRoute,
  strandCostUsd,
  type RankEntry,
  type ScoreInputs,
} from "../routing/score.js";
import {
  BREAKER_OPEN_MS,
  breakerState,
  fillRate,
  freezeVenueStats,
  haircut,
  isCountedFailure,
  MEASURED_FILLS,
  PRIOR_FILL_RATE,
  recordFill,
  recordOrder,
  recordQuote,
  resetVenueStats,
  shouldSkipVenue,
  sizeBucket,
  venueQuoteStats,
} from "../routing/venueStats.js";
import { resetRouting, TEST_SCORE_FACTS } from "./helpers.js";

beforeEach(() => {
  resetVenueStats();
  configureScoreFacts(TEST_SCORE_FACTS);
});

/** A same-asset bridge of 1,000 USDC Base -> Arbitrum quoted at 999 expected. */
function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    venue: "across",
    kind: "bridge",
    network: "base",
    destination: "arbitrum",
    expectedUnits: 999,
    minimumUnits: 998.5,
    floor: "onchain",
    priceOut: 1,
    inputUsd: 1_000,
    extraCostsUsd: 0,
    extraCostsOutUnits: 0,
    gasUsd: 0,
    seconds: 0,
    signatures: 1,
    sameAssetGroup: true,
    preference: "value",
    nonFillCostUsd: 0,
    strandCostUsd: 0,
    ...overrides,
  };
}

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} vs ${expected}`);
}

describe("route score terms (B.1)", () => {
  it("credits an on-chain floor's expected output in full and a claimed floor at half its gap (D1)", () => {
    close(scoreLeg(inputs()).value, 999 - (1 - PRIOR_FILL_RATE) * 0);
    const claimed = scoreLeg(inputs({ venue: "relay", floor: "claimed", minimumUnits: 994 }));
    assert.equal(claimed.claimedDiscounted, true);
    close(claimed.expectedEffUnits, 999 - 0.5 * 5);
    assert.equal(claimed.score.minimumKind, "claimed");
    // The claimed venue's +2 expected units do not beat an on-chain floor once its 5-unit gap is halved.
    assert.ok(scoreLeg(inputs({ venue: "relay", floor: "claimed", expectedUnits: 1_001, minimumUnits: 994 })).value < scoreLeg(inputs()).value);
  });

  it("stops discounting a claimed floor once its size bucket holds 50 verified fills, and uses the measured haircut", () => {
    for (let index = 0; index < MEASURED_FILLS; index += 1) {
      recordFill({ venue: "relay", kind: "bridge", network: "base", destination: "arbitrum", usd: 1_000, expected: 10_000n, actual: index % 2 === 0 ? 9_998n : 9_999n });
    }
    const measured = scoreLeg(inputs({ venue: "relay", floor: "claimed", minimumUnits: 994 }));
    assert.equal(measured.claimedDiscounted, false);
    assert.equal(measured.haircutMeasured, true);
    assert.ok(measured.haircutBps >= 1 && measured.haircutBps <= 2, String(measured.haircutBps));
    close(measured.expectedEffUnits, 999);
    // Another size bucket (log10 of USD) is still unmeasured (D12).
    const small = scoreLeg(inputs({ venue: "relay", floor: "claimed", minimumUnits: 994, inputUsd: 50 }));
    assert.equal(small.claimedDiscounted, true);
    assert.equal(sizeBucket(1_000), "3");
    assert.equal(sizeBucket(50), "1");
    assert.equal(sizeBucket(null), "u");
  });

  it("applies the haircut priors: 0 for on-chain floors and same-asset solver bridges, 3 bps for solver swaps (D12)", () => {
    assert.equal(haircutPriorBps({ floor: "onchain", solverFilled: false, sameAssetGroup: false, kind: "swap" }), 0);
    assert.equal(haircutPriorBps({ floor: "claimed", solverFilled: true, sameAssetGroup: true, kind: "bridge" }), 0);
    assert.equal(haircutPriorBps({ floor: "claimed", solverFilled: true, sameAssetGroup: false, kind: "bridge" }), 3);
    assert.equal(haircutPriorBps({ floor: "claimed", solverFilled: false, sameAssetGroup: false, kind: "swap" }), 3);
    const swap = scoreLeg(inputs({ venue: "relay", kind: "swap", network: "base", destination: "base", floor: "claimed", sameAssetGroup: false, expectedUnits: 1_000, minimumUnits: 1_000 }));
    close(swap.value, 1_000 * (1 - 3 / 10_000) - 0.25, 1e-6);
  });

  it("weighs a non-fill only for solver-filled legs, and never the whole output", () => {
    assert.equal(isSolverFilled("relay", "base", "arbitrum"), true);
    assert.equal(isSolverFilled("cctp-v2", "base", "arbitrum"), false, "CCTP's attested mint is not a solver fill");
    assert.equal(isSolverFilled("relay", "base", "base"), false);
    const nonFill = nonFillCostUsd({ venue: "debridge-dln", sourceGasUsd: 0.2, destinationCancelUsd: 0.5, preference: "value" });
    close(nonFill, 0.2 + 0.5 + LAMBDA_T_USD_PER_SECOND * NON_FILL_LOCK_SECONDS);
    close(nonFillCostUsd({ venue: "across", sourceGasUsd: 0.2, destinationCancelUsd: 0.5, preference: "value" }), 0.2 + LAMBDA_T_USD_PER_SECOND * NON_FILL_LOCK_SECONDS, 1e-9);
    const solver = scoreLeg(inputs({ nonFillCostUsd: nonFill }));
    close(solver.pFill, PRIOR_FILL_RATE);
    close(solver.value, 999 - (1 - PRIOR_FILL_RATE) * nonFill);
    const atomic = scoreLeg(inputs({ venue: "cctp-v2", nonFillCostUsd: nonFill }));
    assert.equal(atomic.pFill, 1);
    close(atomic.value, 999);
  });

  it("subtracts gas, priced extra costs, time, extra signatures and the tier's transit risk", () => {
    const scored = scoreLeg(inputs({ venue: "lifi", gasUsd: 0.4, extraCostsUsd: 2.5, seconds: 100, signatures: 3 }));
    // LI.FI is an extended-tier venue: max($1, 5 bps of $1,000) = $1.
    const expected = 999 - (1 - PRIOR_FILL_RATE) * 0 - 0.4 - 2.5 - LAMBDA_T_USD_PER_SECOND * 100 - LAMBDA_S_USD * 2 - 1;
    close(scored.value, expected);
    assert.equal(scored.score.gasUsd, 0.4);
    assert.equal(scored.score.feesUsd, 2.5);
    assert.equal(scored.score.signatures, 3);
    assert.equal(scored.score.riskUsd, 1);
    // Curated (Relay): max($0.25, 1 bps); core (Across): 0.
    assert.equal(scoreLeg(inputs({ venue: "relay", inputUsd: 100_000 })).score.riskUsd, 10);
    assert.equal(scoreLeg(inputs({ venue: "across", inputUsd: 100_000 })).score.riskUsd, 0);
    // "fastest" multiplies the price of time by 5.
    const fastest = scoreLeg(inputs({ seconds: 100, preference: "fastest" }));
    close(fastest.value, 999 - LAMBDA_T_USD_PER_SECOND * FASTEST_LAMBDA_T_FACTOR * 100);
  });

  it("compares in output units when neither side can be priced, leaving USD terms out for every candidate", () => {
    const units = scoreLeg(inputs({ priceOut: null, gasUsd: 5, seconds: 1_000, extraCostsOutUnits: 2 }));
    assert.equal(units.mode, "units");
    close(units.value, 999 - 2);
    assert.equal(units.score.valueUsd, 0);
  });

  it("prices the strand cost of a dependent leg at least $0.25 (D5)", () => {
    assert.equal(strandCostUsd(1_000, 0, 0.02), 0.25, "stablecoin carrier: volatility 0");
    close(strandCostUsd(100_000, 0.01, 0.05), 50);
  });
});

describe("floor eligibility (RC2)", () => {
  it("accepts a floor within the slippage of the expected output (1 bps and one unit of rounding) and refuses a looser one", () => {
    assert.equal(floorWithinSlippage(1_000_000n, 995_000n, 50), true);
    assert.equal(floorWithinSlippage(1_000_000n, 994_900n, 50), true, "within the 1 bps rounding tolerance");
    assert.equal(floorWithinSlippage(1_000_000n, 994_800n, 50), false);
    assert.equal(floorWithinSlippage(1_000_000n, 999_999n, 50), true, "a tighter floor is fine");
    assert.equal(floorWithinSlippage(0n, 0n, 50), true);
  });
});

describe("extra costs (RC3)", () => {
  it("prices costs in the output, the input or any asset the score can price; null when one stays unpriced", async () => {
    const usdc = await resolveAsset("base", "USDC");
    const aero = await resolveAsset("base", "AERO");
    const eth: AssetAmount = { asset: nativeAssetId("base"), symbol: "ETH", decimals: 18, amount: "1000000000000000", formatted: "0.001" };
    assert.equal(await extraCostsUsd([eth], { asset: usdc, price: 1 }, { asset: usdc, price: 1 }), 2.5);
    const aeroCost: AssetAmount = { asset: aero.id, symbol: "AERO", decimals: 18, amount: "2000000000000000000", formatted: "2" };
    assert.equal(await extraCostsUsd([aeroCost], { asset: usdc, price: 1 }, { asset: usdc, price: 1 }), 2);
    configureScoreFacts({ ...TEST_SCORE_FACTS, assetUsd: async () => null });
    assert.equal(await extraCostsUsd([aeroCost], { asset: usdc, price: 1 }, { asset: usdc, price: 1 }), null);
    // In output units: exact in the output asset, through the quote's rate in the input asset, else null.
    assert.equal(extraCostsOutUnits([aeroCost], aero, usdc, 0.5), 2);
    assert.equal(extraCostsOutUnits([{ ...aeroCost }], usdc, aero, 0.5), 1);
    assert.equal(extraCostsOutUnits([eth], usdc, aero, 0.5), null);
    assert.equal(amountUsd({ ...eth, usd: 3 }, 1), 3, "an amount's own usd wins");
  });

  it("prices gas from the transactions the quote counted (approval only when counted) at the network's gas price", () => {
    const withApproval = legGasUsd({ network: "ethereum", kind: "swap", venue: "uniswap-v3", nativeInput: false, transactions: 2, gasPriceWei: 20_000_000_000n, nativeUsd: 2_500 });
    const without = legGasUsd({ network: "ethereum", kind: "swap", venue: "uniswap-v3", nativeInput: false, transactions: 1, gasPriceWei: 20_000_000_000n, nativeUsd: 2_500 });
    assert.ok(withApproval !== null && without !== null && withApproval > without, `${withApproval} > ${without}`);
    close((withApproval as number) - (without as number), (60_000 * 20e9 / 1e18) * 2_500, 1e-6);
    assert.equal(legGasUsd({ network: "base", kind: "swap", venue: "uniswap-v3", nativeInput: false, transactions: 1, gasPriceWei: 1n, nativeUsd: null }), null);
    const solana = legGasUsd({ network: "solana", kind: "swap", venue: "jupiter", nativeInput: true, transactions: 1, gasPriceWei: null, nativeUsd: 150 });
    assert.ok(solana !== null && solana > 0 && solana < 0.05, String(solana));
  });
});

describe("selection (B.1)", () => {
  function entry(id: string, value: number, extra: Partial<RankEntry<string>> = {}): RankEntry<string> {
    return { item: id, value, mode: "usd", eligible: true, preferred: false, signatures: 1, seconds: 10, onchainFloor: false, order: 0, ...extra };
  }

  it("ranks by value, eligible before excluded, preferred protocols first", () => {
    const { winner, ordered } = selectRoute([entry("a", 100, { order: 0 }), entry("b", 101, { order: 1 }), entry("c", 200, { eligible: false, order: 2 })], { inputUsd: 1_000 });
    assert.equal(winner?.item, "b");
    assert.deepEqual(ordered.map((value) => value.item), ["b", "a", "c"]);
    const preferred = selectRoute([entry("a", 100, { preferred: true }), entry("b", 150, { order: 1 })], { inputUsd: 1_000 });
    assert.equal(preferred.winner?.item, "a", "a preferred venue wins whenever it is eligible");
    assert.equal(selectRoute([entry("x", 1, { eligible: false })], { inputUsd: 1 }).winner, null);
  });

  it("asks a route with more signed legs to beat the best single-leg route by max($0.50, 3 bps)", () => {
    const composite = entry("composite", 100.4, { legs: 3, signatures: 3, order: 1 });
    const oneShot = entry("one-shot", 100, { order: 0 });
    assert.equal(selectRoute([composite, oneShot], { inputUsd: 1_000 }).winner?.item, "one-shot");
    assert.equal(selectRoute([{ ...composite, value: 100.6 }, oneShot], { inputUsd: 1_000 }).winner?.item, "composite");
    // At $100,000 the margin is 3 bps = $30.
    assert.equal(selectRoute([{ ...composite, value: 125 }, { ...oneShot, value: 100 }], { inputUsd: 100_000 }).winner?.item, "one-shot");
    // An approval is a signature, not a leg: it is priced through gas and lambdaS, not by the margin.
    assert.equal(selectRoute([entry("approve", 100.2, { signatures: 2, order: 1 }), oneShot], { inputUsd: 1_000 }).winner?.item, "approve");
  });

  it("breaks ties within max($0.05, 0.5 bps) by signatures, then seconds, then an on-chain floor, then candidate order", () => {
    assert.equal(selectRoute([entry("a", 100.04, { signatures: 2 }), entry("b", 100, { order: 1 })], { inputUsd: 1_000 }).winner?.item, "b");
    assert.equal(selectRoute([entry("a", 100.04, { seconds: 30 }), entry("b", 100, { seconds: 10, order: 1 })], { inputUsd: 1_000 }).winner?.item, "b");
    assert.equal(selectRoute([entry("a", 100.04), entry("b", 100, { onchainFloor: true, order: 1 })], { inputUsd: 1_000 }).winner?.item, "b");
    assert.equal(selectRoute([entry("a", 100.0, { order: 1 }), entry("b", 100.0, { order: 0 })], { inputUsd: 1_000 }).winner?.item, "b");
    assert.equal(selectRoute([entry("a", 100.06), entry("b", 100, { onchainFloor: true, order: 1 })], { inputUsd: 1_000 }).winner?.item, "a", "outside the tie margin value decides");
  });

  it("never picks a cached estimate, and puts fewest signatures first when asked to", () => {
    assert.equal(selectRoute([entry("cached", 200, { estimate: true }), entry("fresh", 100, { order: 1 })], { inputUsd: 1_000 }).winner?.item, "fresh");
    assert.equal(selectRoute([entry("a", 120, { signatures: 2 }), entry("b", 100, { order: 1 })], { inputUsd: 1_000, preference: "fewest-signatures" }).winner?.item, "b");
  });
});

describe("venue statistics and the circuit breaker (B.2, D7)", () => {
  it("counts transport errors, 5xx, 429 and timeouts; never business refusals", () => {
    assert.equal(isCountedFailure(new PlatformError("RELAY_UNAVAILABLE", "down", 502)), true);
    assert.equal(isCountedFailure(providerRateLimited("Relay", 1)), true);
    assert.equal(isCountedFailure(new PlatformError("VENUE_TIMEOUT", "slow", 504)), true);
    assert.equal(isCountedFailure(new PlatformError("PROVIDER_INVALID_JSON", "html", 502)), true);
    assert.equal(isCountedFailure(new Error("socket hang up")), true);
    for (const code of ["ROUTE_UNAVAILABLE", "AMOUNT_TOO_SMALL", "ROUTE_UNSUPPORTED", "PRICE_IMPACT_TOO_HIGH"]) {
      assert.equal(isCountedFailure(new PlatformError(code, "no", 422)), false, code);
    }
    assert.equal(isCountedFailure(new PlatformError("PROVIDER_TRANSACTION_INVALID", "bad calldata", 502)), false, "a refused quote is not an outage");
  });

  it("opens after 5 consecutive counted failures, skips for 30 s, then lets one trial through", () => {
    const now = 1_000_000;
    for (let index = 0; index < 4; index += 1) recordQuote("relay", "base", "arbitrum", { ms: 10, error: new PlatformError("RELAY_UNAVAILABLE", "down", 502) }, now + index);
    assert.equal(breakerState("relay", "base", "arbitrum", now + 5), "closed");
    recordQuote("relay", "base", "arbitrum", { ms: 10, error: new PlatformError("RELAY_UNAVAILABLE", "down", 502) }, now + 5);
    assert.equal(breakerState("relay", "base", "arbitrum", now + 6), "open");
    assert.equal(shouldSkipVenue("relay", "base", "arbitrum", now + 6), true);
    assert.equal(breakerState("relay", "base", "solana", now + 6), "closed", "per network pair");
    const later = now + 5 + BREAKER_OPEN_MS;
    assert.equal(breakerState("relay", "base", "arbitrum", later), "half-open");
    assert.equal(shouldSkipVenue("relay", "base", "arbitrum", later), false, "one trial");
    assert.equal(shouldSkipVenue("relay", "base", "arbitrum", later), true, "only one at a time");
    recordQuote("relay", "base", "arbitrum", { ms: 10 }, later + 1);
    assert.equal(breakerState("relay", "base", "arbitrum", later + 2), "closed", "a success closes it");
  });

  it("never trips on business refusals, however many (a caller cannot switch the best venue off)", () => {
    const now = 2_000_000;
    for (let index = 0; index < 50; index += 1) recordQuote("relay", "base", "arbitrum", { ms: 10, error: new PlatformError("AMOUNT_TOO_SMALL", "small", 422) }, now + index);
    assert.equal(breakerState("relay", "base", "arbitrum", now + 60), "closed");
    const stats = venueQuoteStats("relay", "base", "arbitrum", now + 60);
    assert.equal(stats.attempts, 50);
    assert.equal(stats.failureRate, 0);
  });

  it("opens when more than half of at least 6 attempts in 2 minutes failed", () => {
    const now = 3_000_000;
    const fail = () => new PlatformError("LIFI_UNAVAILABLE", "down", 502);
    const pattern = [true, false, true, false, true, true];
    pattern.forEach((failed, index) => recordQuote("lifi", "base", "arbitrum", { ms: 10, ...(failed ? { error: fail() } : {}) }, now + index));
    assert.equal(breakerState("lifi", "base", "arbitrum", now + 10), "open", "4 of 6 counted");
    const stats = venueQuoteStats("lifi", "base", "arbitrum", now + 10);
    assert.equal(stats.p50Ms, 10);
  });

  it("blends the fill rate with its 0.98 prior and keeps the last 200 orders", () => {
    close(fillRate("debridge-dln", "arbitrum", "optimism").rate, PRIOR_FILL_RATE);
    for (let index = 0; index < 200; index += 1) recordOrder("debridge-dln", "arbitrum", "optimism", index % 10 !== 0);
    const reading = fillRate("debridge-dln", "arbitrum", "optimism");
    assert.equal(reading.orders, 200);
    close(reading.rate, (180 + PRIOR_FILL_RATE * 20) / 220);
  });

  it("weights the haircut median by USD and clips it to 0-50 bps", () => {
    for (let index = 0; index < MEASURED_FILLS; index += 1) {
      recordFill({ venue: "relay", kind: "bridge", network: "solana", destination: "base", usd: 5_000, expected: 10_000n, actual: 9_900n });
    }
    const reading = haircut("relay", "bridge", "solana", "base", 5_000, 3);
    assert.equal(reading.measured, true);
    assert.equal(reading.bps, 50, "100 bps measured, clipped to 50");
    assert.deepEqual(haircut("relay", "bridge", "solana", "base", 50, 3), { bps: 3, fills: 0, measured: false });
  });

  it("freezes for replays: records are ignored and trials are not consumed (I9)", () => {
    freezeVenueStats(true);
    recordOrder("relay", "base", "arbitrum", false);
    recordQuote("relay", "base", "arbitrum", { ms: 10, error: new PlatformError("RELAY_UNAVAILABLE", "down", 502) });
    assert.equal(fillRate("relay", "base", "arbitrum").orders, 0);
    assert.equal(venueQuoteStats("relay", "base", "arbitrum").attempts, 0);
    freezeVenueStats(false);
  });
});

describe("score prices (RC3)", () => {
  it("prices oracle-priced assets through an installed price reader, never the network", async () => {
    configureScoreFacts(null);
    configurePriceReader(fixedPriceReader({ WETH: 2_000, CBBTC: 50_000 }, 1_700_000_000_000));
    try {
      assert.equal(await readAssetUsd(await resolveAsset("base", "WETH")), 2_000);
      assert.equal(await readAssetUsd(await resolveAsset("base", "cbBTC")), 50_000);
      assert.equal(await readAssetUsd(await resolveAsset("base", "USDC")), 1, "USD stablecoins at par");
      assert.equal(await readAssetUsd(await resolveAsset("base", "AERO")), null, "a price the reader lacks stays unknown");
    } finally {
      configurePriceReader(null);
      resetRouting();
    }
  });
});
