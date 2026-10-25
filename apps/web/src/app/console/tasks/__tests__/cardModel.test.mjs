// The printed plan card's model (Card machine): the route drawn from the real plan
// (only the networks and venues it touches), the three facts, and coins that never arrive before
// the API says a step settled. Run with
//   node --test apps/web/src/app/console/tasks/__tests__/cardModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  cardFacts,
  cardPhase,
  cardType,
  legProgress,
  plannedLine,
  quoteExpired,
  routeGeometry,
  routeLabel,
  routeReason,
  routesCompared,
  routeStops,
  signedShare,
} from "../cardModel.ts";

const usdc = (network, formatted) => ({ asset: `${network}/usdc`, symbol: "USDC", decimals: 6, amount: "0", formatted });
const eth = (formatted) => ({ asset: "eth", symbol: "ETH", decimals: 18, amount: "0", formatted });

// "bridge 25 USDC from base to arbitrum and swap half to ETH", as the local API planned it (trimmed).
const bridgeSwap = {
  id: "int_1",
  status: "planned",
  expiresAt: "2026-10-25T13:30:00.000Z",
  steps: [
    {
      id: "s2",
      index: 1,
      kind: "swap",
      title: "Swap 12.488343 USDC for ETH on Arbitrum One via Uniswap V3",
      network: "arbitrum",
      protocol: "uniswap-v3",
      status: "pending",
      dependsOn: ["s1"],
      input: usdc("arb", "12.488343"),
      expectedOutput: eth("0.005355003309839542"),
      minimumOutput: eth("0.005328228293290344"),
      settlement: { kind: "same-network" },
    },
    {
      id: "s1",
      index: 0,
      kind: "bridge",
      title: "Bridge 25 USDC from Base to Arbitrum One via Across",
      network: "base",
      protocol: "across",
      status: "ready",
      dependsOn: [],
      input: usdc("base", "25"),
      expectedOutput: usdc("arb", "24.989182"),
      minimumOutput: usdc("arb", "24.976687"),
      settlement: { kind: "cross-network", destinationNetwork: "arbitrum", expectedSeconds: 2 },
    },
  ],
  summary: {
    title: "Bridge 25 USDC from Base to Arbitrum One via Across → Swap 12.488343 USDC for ETH on Arbitrum One via Uniswap V3",
    inputs: [usdc("base", "25")],
    outputs: [usdc("arb", "12.494591"), eth("0.005355003309839542")],
    totalFeesUsd: 0.024,
    signaturesRequired: 4,
  },
  interpretation: {
    routes: [
      { steps: ["s1"], venues: ["across"], reason: "Across: Delivers about $0.07 more than Circle CCTP V2 after costs.", compared: [{}, {}, {}, {}] },
      { steps: ["s2"], venues: ["uniswap-v3"], reason: "Uniswap V3: Delivers about $0.24 more than Relay after costs.", compared: [{}, {}, {}] },
    ],
  },
};

test("the route has only the networks and venues the plan touches, in order", () => {
  const plan = routeStops(bridgeSwap);
  assert.deepEqual(
    plan.stops.map((stop) => `${stop.kind}:${stop.key}`),
    ["network:base", "venue:across", "network:arbitrum", "venue:uniswap-v3"],
  );
  assert.deepEqual(plan.legs, [
    { stepId: "s1", stops: [0, 1, 2] },
    { stepId: "s2", stops: [2, 3] },
  ]);
  assert.equal(plan.stops[3].label, "Uniswap");
  assert.equal(plan.stops[1].icon, "across");
  assert.equal(plan.stops[0].icon, "base");
  assert.match(routeLabel(plan), /^Route: Base, Across, Arbitrum, Uniswap V3$/u);
});

test("a one-network swap is a cartridge and a station; two steps on one network chain from the last venue", () => {
  const swap = routeStops({ steps: [{ ...bridgeSwap.steps[0], id: "a", index: 0, dependsOn: [], network: "solana", protocol: "jupiter" }] });
  assert.deepEqual(swap.stops.map((stop) => stop.key), ["solana", "jupiter"]);
  const twice = routeStops({
    steps: [
      { ...bridgeSwap.steps[0], id: "a", index: 0, dependsOn: [], network: "base", protocol: "uniswap-v3", settlement: null },
      { ...bridgeSwap.steps[0], id: "b", index: 1, kind: "deposit", dependsOn: ["a"], network: "base", protocol: "aave-v3", settlement: null },
    ],
  });
  assert.deepEqual(twice.stops.map((stop) => stop.key), ["base", "uniswap-v3", "aave-v3"]);
  assert.deepEqual(twice.legs[1].stops, [1, 2]);
});

test("the geometry spreads the stops across the art window and gives every step a rail", () => {
  const geometry = routeGeometry(routeStops(bridgeSwap));
  assert.equal(geometry.stops.length, 4);
  assert.equal(geometry.rails.length, 3);
  const xs = geometry.stops.map((stop) => stop.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "left to right");
  assert.ok(xs[0] - geometry.cart.w / 2 >= 0 && xs[3] + geometry.stationR <= 360, "inside the window");
  assert.equal(geometry.legs[0].from, xs[0]);
  assert.equal(geometry.legs[0].to, xs[2]);
});

test("the three facts read the plan: inputs, the last steps' minimums, totalFeesUsd", () => {
  const facts = cardFacts(bridgeSwap, null);
  assert.equal(facts.from, "25 USDC on Base becomes");
  assert.equal(facts.title, "12.4945 USDC + 0.005355 ETH");
  assert.equal(facts.pay, "25 USDC");
  assert.equal(facts.atLeast, "0.00532822 ETH");
  assert.equal(facts.fees, "$0.02");
  // The fare's totals win when the fare belongs to this plan (the review prints the same total).
  const fare = { intentId: "int_1", totals: { networkFeesUsd: 0.01, venueFeesUsd: 0.01, extraCostsUsd: 0 } };
  assert.equal(cardFacts(bridgeSwap, fare).fees, "$0.02");
  assert.equal(cardFacts(bridgeSwap, { ...fare, intentId: "other", totals: { networkFeesUsd: 3, venueFeesUsd: 0, extraCostsUsd: 0 } }).fees, "$0.02", "another plan's fare is ignored");
  assert.equal(cardType(bridgeSwap), "Bridge + swap");
  assert.match(routeReason(bridgeSwap), /^Across: Delivers/u);
  assert.equal(routesCompared(bridgeSwap), 9);
});

test("coins move only with the chain: wallet, in flight, settled; a crossing is not done when the source confirms", () => {
  const steps = bridgeSwap.steps;
  assert.deepEqual(legProgress(steps).map((leg) => leg.state), ["queued", "queued"]);
  assert.deepEqual(legProgress(steps, { s1: "signing" }).map((leg) => leg.state), ["wallet", "queued"]);
  const flying = legProgress([{ ...steps[1], status: "submitted" }, steps[0]], {});
  assert.equal(flying[0].state, "moving");
  assert.ok(flying[0].travelled > 0 && flying[0].travelled < 1);
  const confirmed = legProgress([{ ...steps[1], status: "confirmed" }, steps[0]]);
  assert.equal(confirmed[0].state, "moving", "a bridge confirmed on Base has not arrived on Arbitrum");
  const settled = legProgress([{ ...steps[1], status: "settled" }, { ...steps[0], status: "confirmed" }]);
  assert.deepEqual(settled.map((leg) => leg.state), ["done", "done"], "a same-network swap is done when confirmed");
  assert.equal(signedShare(settled), 1);
  assert.equal(signedShare(flying), 0.25);
  assert.equal(legProgress([{ ...steps[1], status: "failed" }])[0].state, "failed");
});

test("the card is settled only when the API completed the intent", () => {
  assert.equal(cardPhase(null), "dry");
  assert.equal(cardPhase({ status: "review", intentStatus: "planned" }), "review");
  assert.equal(cardPhase({ status: "executing", intentStatus: "executing" }), "signing");
  assert.equal(cardPhase({ status: "executing", intentStatus: "completed" }), "signing", "the run has not seen it yet");
  assert.equal(cardPhase({ status: "completed", intentStatus: "completed" }), "settled");
  assert.equal(cardPhase({ status: "failed", intentStatus: "failed" }), "stopped");
  assert.equal(quoteExpired(bridgeSwap, Date.parse("2026-10-25T13:31:00Z")), true);
  assert.equal(quoteExpired(bridgeSwap, Date.parse("2026-10-25T13:00:00Z")), false);
  assert.equal(plannedLine(2600, 14), "Planned in 2.6 s · 14 routes compared");
  assert.equal(plannedLine(800, null, "Read"), "Read in 0.8 s");
});
