import assert from "node:assert/strict";
import test from "node:test";
import {
  PERPS_LIMITS,
  PERPS_VENUES,
  comparePolicies,
  effectivePerps,
  effectivePolicyDocument,
  getPerpsVenue,
  getProtocol,
  perpsAcceptablePrice,
  perpsLiquidationPrice,
  perpsPnlUsd,
  perpsQuote,
  perpsRequestAmounts,
  scorePerpsVenues,
  validatePerpsRequest,
  validatePolicy,
} from "../dist/index.js";

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≉ ${expected}`);

const market = (overrides = {}) => ({
  venue: "hyperliquid",
  symbol: "ETH",
  marketId: "ETH",
  network: "arbitrum",
  markPrice: 2000,
  fundingRate1h: { long: 0.0000125, short: -0.0000125 },
  openInterestUsd: { long: 1e9, short: 1e9 },
  maxLeverage: 25,
  maintenanceMarginRate: 0.02,
  takerFeeRate: 0.00045,
  impactPer10kUsd: 0,
  minSizeUsd: 10,
  minCollateralUsd: 0,
  observedAt: 1_792_770_000,
  open: true,
  ...overrides,
});

test("liquidation price: equity meets the maintenance margin (long and short)", () => {
  // 10x long at 2,000 with no maintenance margin: liquidated after a 10% drop.
  close(perpsLiquidationPrice({ side: "long", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0 }), 1800);
  close(perpsLiquidationPrice({ side: "short", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0 }), 2200);
  // With maintenance margin m: long (E − C/Q)/(1 − m), short (E + C/Q)/(1 + m).
  close(perpsLiquidationPrice({ side: "long", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0.02 }), 1800 / 0.98);
  close(perpsLiquidationPrice({ side: "short", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0.02 }), 2200 / 1.02);
  // Hyperliquid docs' formula: liq = price − side · margin_available / size / (1 − l · side), margin_available = C − m · notional.
  const hl = 2000 - (100 - 0.02 * 1000) / 0.5 / (1 - 0.02);
  close(perpsLiquidationPrice({ side: "long", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0.02 }), hl);
  // A 1x long cannot be liquidated by price; bad inputs give null.
  assert.equal(perpsLiquidationPrice({ side: "long", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 1000, maintenanceMarginRate: 0 }), null);
  assert.equal(perpsLiquidationPrice({ side: "long", entryPrice: 0, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 0.01 }), null);
  assert.equal(perpsLiquidationPrice({ side: "short", entryPrice: 2000, sizeUsd: 1000, collateralUsd: 100, maintenanceMarginRate: 1 }), null);
});

test("PnL, acceptable prices and quotes", () => {
  assert.equal(perpsPnlUsd("long", 2, 2000, 2100), 200);
  assert.equal(perpsPnlUsd("short", 2, 2000, 2100), -200);
  close(perpsAcceptablePrice("long", true, 2000, 50), 2010);
  close(perpsAcceptablePrice("short", true, 2000, 50), 1990);
  close(perpsAcceptablePrice("long", false, 2000, 50), 1990, 1e-12);
  close(perpsAcceptablePrice("short", false, 2000, 50), 2010);
  const quote = perpsQuote(market(), { action: "open", side: "long", sizeUsd: 500, collateralUsd: 100, slippageBps: 50 });
  assert.equal(quote.leverage, 5);
  assert.equal(quote.fees.openUsd, 0.23);
  assert.equal(quote.funding1hUsd, 0.0063);
  close(quote.acceptablePrice, 2010);
  close(quote.liquidationPrice, (2000 - (100 - 0.23) / 0.25) / 0.98);
  assert.deepEqual(quote.warnings, []);
  const risky = perpsQuote(market(), { action: "open", side: "short", sizeUsd: 2000, collateralUsd: 100, slippageBps: 50 });
  assert.match(risky.warnings[0], /20\.0x, a 5\.0% move/u);
  assert.match(risky.warnings[1], /only 2\.\d% from the entry/u);
});

test("venues: Drift is disabled with its reason, the others prepare; protocols are registered as perps", () => {
  assert.deepEqual(PERPS_VENUES.map((venue) => [venue.id, venue.enabled]), [["gmx-v2", true], ["hyperliquid", true], ["drift-v2", false]]);
  assert.match(getPerpsVenue("drift-v2").disabledReason, /April 1, 2026/u);
  for (const id of ["gmx-v2", "hyperliquid", "drift-v2"]) {
    assert.equal(getProtocol(id).category, "perps", id);
    assert.equal(getProtocol(id).execution, "service", id);
  }
  assert.deepEqual(getProtocol("drift-v2").capabilities, ["discover"]);
});

test("scorer: cheapest eligible venue first, the others with a reason", () => {
  const markets = [
    market(),
    market({ venue: "gmx-v2", marketId: "0x70d9", takerFeeRate: 0.0006, fundingRate1h: { long: 0.00002, short: -0.0001 }, maxLeverage: 100, maintenanceMarginRate: 0.005, minCollateralUsd: 2 }),
  ];
  const request = { action: "open", symbol: "ETH", side: "long", sizeUsd: 500, collateralUsd: 100, leverage: 5, slippageBps: 50 };
  const ranked = scorePerpsVenues(request, markets);
  assert.deepEqual(ranked.map((choice) => [choice.venue, choice.eligible]), [["hyperliquid", true], ["gmx-v2", true], ["drift-v2", false]]);
  assert.ok(ranked[0].costUsd < ranked[1].costUsd);
  assert.match(ranked[2].reason, /halted/u);
  // Shorts receive funding on GMX here and pay on Hyperliquid: GMX wins.
  assert.equal(scorePerpsVenues({ ...request, side: "short" }, markets)[0].venue, "gmx-v2");
  // Leverage above a market cap, a rule book's venue list and network filter each exclude.
  const capped = scorePerpsVenues({ ...request, leverage: 30 }, markets);
  assert.match(capped.find((choice) => choice.venue === "hyperliquid").reason, /above the 25x cap/u);
  assert.equal(capped[0].venue, "gmx-v2");
  assert.match(scorePerpsVenues({ ...request, allowedVenues: ["hyperliquid"] }, markets).find((choice) => choice.venue === "gmx-v2").reason, /rule book/u);
  assert.match(scorePerpsVenues({ ...request, leverage: 30, maxLeverage: 20 }, markets).find((choice) => choice.venue === "gmx-v2").reason, /20x cap/u);
  assert.match(scorePerpsVenues({ ...request, network: "solana" }, markets).find((choice) => choice.venue === "hyperliquid").reason, /runs on arbitrum/u);
  assert.match(scorePerpsVenues({ ...request, symbol: "DOGE" }, markets)[0].reason, /no DOGE market/u);
  assert.match(scorePerpsVenues({ ...request, sizeUsd: 5, collateralUsd: 1 }, markets).find((choice) => choice.venue === "gmx-v2").reason, /at least 10 USD of size/u);
});

test("request validation", () => {
  const ok = validatePerpsRequest({ symbol: "eth", side: "long", collateral: { asset: "usdc", amount: "100" }, leverage: 5 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { action: "open", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 5 });
  assert.deepEqual(perpsRequestAmounts(ok.value), { sizeUsd: 500, collateralUsd: 100, leverage: 5 });
  assert.deepEqual(perpsRequestAmounts({ sizeUsd: "200", collateral: { asset: "USDC", amount: "50" } }), { sizeUsd: 200, collateralUsd: 50, leverage: 4 });
  const paths = (input) => validatePerpsRequest(input).issues.map((issue) => issue.path);
  assert.deepEqual(paths({ symbol: "ETH", side: "long", leverage: 5 }), ["collateral"]);
  assert.deepEqual(paths({ symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "1" } }), ["sizeUsd"]);
  assert.deepEqual(paths({ action: "decrease", symbol: "ETH", side: "long" }), ["sizeUsd"]);
  assert.deepEqual(paths({ action: "close", symbol: "ETH", side: "short" }), []);
  assert.deepEqual(paths({ action: "cancel", symbol: "ETH", side: "long", venue: "gmx-v2", orderId: 1 }), ["orderId"]);
  assert.deepEqual(paths({ action: "cancel", symbol: "ETH", side: "long", venue: "hyperliquid", orderId: 1 }), []);
  assert.deepEqual(paths({ symbol: "ETH", side: "up", leverage: 500, slippageBps: 0, venue: "dydx", sizeUsd: "1e3", extra: 1 }).sort(), ["extra", "leverage", "side", "sizeUsd", "slippageBps", "venue"]);
  assert.deepEqual(paths({ action: "open", symbol: "ETH", side: "long", sizeUsd: String(PERPS_LIMITS.maxSizeUsd + 1), collateral: { asset: "USDC", amount: "1" } }), ["sizeUsd"]);
});

test("rule book perps section: validation, agent defaults, comparison and the chain view", () => {
  const valid = validatePolicy({ schema: "kletia.policy/v1", perps: { enabled: true, maxLeverage: 5, venues: ["hyperliquid", "gmx-v2"] } });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value.perps, { enabled: true, maxLeverage: 5, venues: ["gmx-v2", "hyperliquid"] });
  const invalid = validatePolicy({ schema: "kletia.policy/v1", perps: { enabled: "yes", maxLeverage: 51, venues: ["dydx"], other: 1 } });
  assert.deepEqual(invalid.issues.map((issue) => issue.path).sort(), ["perps.enabled", "perps.maxLeverage", "perps.other", "perps.venues[0]"].sort());

  assert.equal(effectivePolicyDocument(null, "agent").perps.enabled, false, "agents start without perps");
  assert.equal(effectivePolicyDocument({ schema: "kletia.policy/v1", perps: { enabled: true } }, "agent").perps.enabled, true);

  const loosened = comparePolicies({ schema: "kletia.policy/v1", perps: { maxLeverage: 5 } }, { schema: "kletia.policy/v1", perps: { maxLeverage: 10, enabled: false } });
  assert.ok(loosened.loosened.includes("perps.maxLeverage"));
  assert.ok(loosened.tightened.includes("perps.enabled"));
  assert.ok(comparePolicies(null, { schema: "kletia.policy/v1", perps: { venues: ["gmx-v2"] } }).tightened.includes("perps.venues"));

  const defaults = effectivePerps([]);
  assert.deepEqual(defaults, { enabled: true, maxLeverage: PERPS_LIMITS.defaultMaxLeverage, venues: ["gmx-v2", "hyperliquid", "drift-v2"], reason: null });
  const agent = effectivePerps([{ policy: null, defaults: "project" }, { policy: null, defaults: "agent" }]);
  assert.equal(agent.enabled, false);
  assert.match(agent.reason, /Agent keys/u);
  const granted = effectivePerps([
    { policy: { schema: "kletia.policy/v1", perps: { maxLeverage: 30 }, protocols: { deny: ["gmx-v2"] } }, defaults: "project" },
    { policy: { schema: "kletia.policy/v1", perps: { enabled: true, maxLeverage: 8, venues: ["gmx-v2", "hyperliquid"] } }, defaults: "agent" },
  ]);
  assert.deepEqual(granted, { enabled: true, maxLeverage: 8, venues: ["hyperliquid"], reason: null });
  assert.equal(effectivePerps([{ policy: { schema: "kletia.policy/v1", perps: { maxLeverage: 40 } }, defaults: "project" }]).maxLeverage, 40, "a rule book may raise the default cap");
  assert.match(effectivePerps([{ policy: { schema: "kletia.policy/v1", mode: "paused" }, defaults: "project" }]).reason, /paused/u);
  assert.deepEqual(effectivePerps([{ policy: { schema: "kletia.policy/v1", protocols: { allow: ["uniswap-v3"] } }, defaults: "project" }]).venues, [], "an allowlist without perps venues allows none");
});
