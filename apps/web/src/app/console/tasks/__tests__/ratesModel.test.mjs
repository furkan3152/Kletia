// Read-only rate questions (GAPS 3.4): what a sentence asks for, the venue
// list read, and the rows shown. Run with
//   node --test apps/web/src/app/console/tasks/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { borrowEngineFor, depositSentence, formatApy, formatSize, parseVenues, rateQueryOf, ratesFor, venuesPath } from "../ratesModel.ts";

test("a question names its network, protocols, asset and whether it asks about borrowing", () => {
  const query = rateQueryOf("Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction");
  assert.equal(query.network, "base");
  assert.deepEqual(query.protocols, ["aave-v3", "compound-v3", "moonwell"]);
  assert.equal(query.asset, "USDC");
  assert.equal(query.borrow, false);
  assert.equal(venuesPath(query), "/v1/venues?network=base");
  const live = rateQueryOf("Show the live USDC supply and variable borrow rates from Aave V3 on Arbitrum without preparing a transaction");
  assert.equal(live.network, "arbitrum");
  assert.equal(live.borrow, true);
  assert.equal(borrowEngineFor(live), "arbitrum");
  const plain = rateQueryOf("compare yield");
  assert.equal(plain.network, null);
  assert.equal(venuesPath(plain), "/v1/venues");
  // An EVM departure narrows it; Solana or the test yard does not.
  assert.equal(rateQueryOf("compare yield", "optimism").network, "optimism");
  assert.equal(rateQueryOf("compare yield", "solana").network, null);
  assert.equal(rateQueryOf("compare yield", "arc").network, null);
  assert.equal(rateQueryOf("show lending rates on solana").solana, true);
  assert.equal(borrowEngineFor(rateQueryOf("compare borrow rates on polygon")), null);
});

const body = {
  venues: [
    { venue: "base:aave-v3:usdc", protocol: "aave-v3", network: "base", name: "Aave V3 USDC", asset: "USDC", supplyApy: 0.0387, totalSupplied: { formatted: "194800000.5" }, exitLiquidity: { formatted: "20600000" }, observedAt: "2026-10-22T20:30:00.000Z" },
    { venue: "base:moonwell:usdc", protocol: "moonwell", network: "base", name: "Moonwell USDC", asset: "USDC", supplyApy: 0.0512 },
    { venue: "base:aave-v3:weth", protocol: "aave-v3", network: "base", name: "Aave V3 WETH", asset: "WETH", supplyApy: 0.0095 },
    { venue: "arbitrum-sepolia:aave-v3:usdc", protocol: "aave-v3", network: "arbitrum-sepolia", name: "Aave V3 USDC", asset: "USDC", supplyApy: 0.0439 },
    { venue: "x", protocol: "aave-v3", network: "nowhere", name: "Bad", asset: "USDC", supplyApy: 0.5 },
    { venue: "base:fluid:usdc", protocol: "fluid", network: "base", name: "Fluid USDC", asset: "USDC", supplyApy: "high" },
    "nonsense",
  ],
};

test("the venue list is validated and filtered; the best supply rate comes first", () => {
  const rows = parseVenues(body);
  assert.equal(rows.length, 5);
  assert.equal(rows.find((row) => row.protocol === "fluid").supplyApy, null);
  assert.equal(parseVenues(null), null);
  assert.equal(parseVenues({ venues: "x" }), null);
  const usdc = ratesFor(rows, rateQueryOf("compare USDC yield on base"));
  assert.deepEqual(usdc.map((row) => row.venue), ["base:moonwell:usdc", "base:aave-v3:usdc", "base:fluid:usdc"]);
  assert.deepEqual(ratesFor(rows, rateQueryOf("show live Aave rates")).map((row) => row.venue), ["base:aave-v3:usdc", "base:aave-v3:weth"]);
  assert.deepEqual(ratesFor(rows, rateQueryOf("compare ETH yield on base")).map((row) => row.asset), ["WETH"]);
  // The test yard only when it is asked for.
  assert.equal(ratesFor(rows, rateQueryOf("compare yield")).some((row) => row.network === "arbitrum-sepolia"), false);
  assert.deepEqual(ratesFor(rows, rateQueryOf("compare yield on arbitrum sepolia")).map((row) => row.network), ["arbitrum-sepolia"]);
});

test("rates and sizes print short; a deposit is offered for stablecoins of known protocols", () => {
  assert.equal(formatApy(0.02466345), "2.47%");
  assert.equal(formatApy(1.3e-7), "under 0.01%");
  assert.equal(formatApy(0), "0.00%");
  assert.equal(formatApy(null), "not reported");
  assert.equal(formatSize("216623120.526068"), "216.6M");
  assert.equal(formatSize("97417.65"), "97.4K");
  assert.equal(formatSize("12.5"), "12.50");
  assert.equal(formatSize(null), "");
  const rows = parseVenues(body);
  assert.equal(depositSentence(rows[0]), "deposit 100 USDC into aave on base");
  assert.equal(depositSentence(rows[2]), null);
  assert.equal(depositSentence(rows.find((row) => row.protocol === "fluid")), null);
});
