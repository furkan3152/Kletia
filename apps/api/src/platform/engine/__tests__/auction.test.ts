/**
 * Cross-network venue auction: the route score (design B.1: expected value
 * after gas, priced extra costs, time, signatures, non-fill and tier risk),
 * eligibility (time limit, priceable costs), preference, timeouts, loser
 * evidence, the same ranking in POST /v1/quotes and the prepare-time
 * extra-cost guard.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { compareQuotes, configureAuctionSoftDeadline, configureVenueQuoteTimeout, netMinimumOutput, runVenueAuction, type VenueQuote } from "../auction.js";
import { configurePlanDeadline, withDeadline } from "../routing/deadline.js";
import { fullRequestKey, isNeutralAccount, neutralPrescreenAction, prescreenKey } from "../routing/quoteCache.js";
import { configureScoreFacts } from "../routing/score.js";
import { planIntent } from "../planner.js";
import { quoteRoutes } from "../quotes.js";
import { createIntent, prepareStep } from "../service.js";
import { bridgeAction } from "./crosschainFixtures.js";
import { ACCOUNTS, EVM_ACCOUNT, EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, SOL_ADDRESS, TEST_SCORE_FACTS } from "./helpers.js";
import { BRIDGE_STUBS, bridgeCalls, nativeCost, resetVenueEngine, venueScripts, type VenueScript } from "./venueStubs.js";

const BRIDGE = { kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "arbitrum" } as const;

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

/** The research snapshot (25 USDC Base -> Arbitrum): Relay fast, LI.FI best raw minimum but 18 min, DLN with a 0.001 ETH fixed fee. */
function snapshot(): void {
  venueScripts.relay = { minimumBps: 9_940, seconds: 1, transactions: 2, quoteId: `0x${"11".repeat(32)}` };
  venueScripts.lifi = { minimumBps: 9_975, seconds: 1_080, quoteId: `0x${"22".repeat(32)}` };
  venueScripts["debridge-dln"] = {
    minimumBps: 9_868,
    seconds: 11,
    extraCosts: (action) => [nativeCost(action.network, "1000000000000000", 2.49)],
    quoteId: `0x${"33".repeat(32)}`,
  };
}

function quoteDetails(step: IntentStep | undefined): string[] {
  return (step?.evidence ?? []).filter((entry) => entry.kind === "quote").map((entry) => entry.detail ?? "");
}

describe("venue auction (planner)", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    snapshot();
  });
  afterEach(() => configureVenueQuoteTimeout(null));

  it("selects by value within the default 600 s and records every losing quote", async () => {
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "relay", "LI.FI is slower than 600 s and DLN nets less after its fee");
    assert.equal(step?.minimumOutput?.amount, "24850000");
    const details = quoteDetails(step);
    assert.match(details[0] ?? "", /^Quoted by Relay venue\. Selected over 2 other venue\(s\) by expected value/u);
    // Stub floors are not enforced on-chain: "quoted minimum", never "guaranteed" (D1).
    assert.ok(details.some((detail) => /Also quoted: LI\.FI: 25 USDC expected, 24\.9375 USDC quoted minimum, value \$[\d.]+, ~18 min.*not selected \(slower than the time limit\)/u.test(detail)), details.join("\n"));
    assert.ok(details.some((detail) => /Also quoted: deBridge DLN: 24\.795 USDC expected, 24\.67 USDC quoted minimum \(net 22\.18 after 0\.001 ETH\)/u.test(detail)), details.join("\n"));
    // Provider ids of losing venues never become references (references of quote evidence bind deposits).
    const references = step?.evidence.filter((entry) => entry.kind === "quote" && entry.reference).map((entry) => entry.reference);
    assert.deepEqual(references, [`0x${"11".repeat(32)}`]);
  });

  it("lets a slower venue win when constraints.maxSeconds allows it and it is worth the wait", async () => {
    // 18 minutes cost about $2.16 at $0.002/s: LI.FI wins only against a Relay quote that much worse.
    const close = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS, constraints: { maxSeconds: 1_200 } });
    assert.equal(close.steps[0]?.protocol, "relay");
    venueScripts.relay = { minimumBps: 9_000, seconds: 1, transactions: 2 };
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS, constraints: { maxSeconds: 1_200 } });
    assert.equal(graph.steps[0]?.protocol, "lifi");
    assert.equal(graph.steps[0]?.estimatedSeconds, 1_080);
  });

  it("ranks net output, then seconds, then transaction count", async () => {
    venueScripts.relay = { minimumBps: 8_000, seconds: 1 };
    const net = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(net.steps[0]?.protocol, "debridge-dln", "24.67 - 2.49 = 22.18 net beats Relay's 20.00");
    assert.deepEqual(net.steps[0]?.extraCosts?.map((cost) => `${cost.formatted} ${cost.symbol}`), ["0.001 ETH"]);

    venueScripts.relay = { minimumBps: 9_900, seconds: 20, transactions: 1 };
    venueScripts.lifi = { minimumBps: 9_900, seconds: 5, transactions: 2 };
    delete venueScripts["debridge-dln"];
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 5, transactions: 1 };
    const tie = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(tie.steps[0]?.protocol, "debridge-dln", "same net: 5 s beats 20 s, then 1 transaction beats 2");
  });

  it("prices extra costs in any asset it can (RC3) and excludes a venue whose costs stay unpriced", async () => {
    const aero = findAssetBySymbol("base", "AERO");
    assert.ok(aero);
    venueScripts.relay = { minimumBps: 9_000, seconds: 1 };
    venueScripts["debridge-dln"] = {
      minimumBps: 9_990,
      seconds: 5,
      extraCosts: () => [{ asset: aero.id, symbol: "AERO", decimals: 18, amount: "1000000000000000000", formatted: "1" }],
    };
    // AERO has a price: the 1 AERO fee is $1, and DLN's quote still wins after it.
    const priced = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(priced.steps[0]?.protocol, "debridge-dln");
    configureScoreFacts({ ...TEST_SCORE_FACTS, assetUsd: async () => null });
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "relay");
    assert.ok(quoteDetails(graph.steps[0]).some((detail) => /deBridge DLN.*not selected \(its extra costs could not be priced\)/u.test(detail)));
    assert.equal(await netMinimumOutput({ minimumOutput: graph.steps[0]?.minimumOutput as never, extraCosts: [] }), BigInt(graph.steps[0]?.minimumOutput?.amount ?? "0"));
  });

  it("puts preferred venues first and never quotes avoided ones", async () => {
    const preferred = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS, constraints: { preferProtocols: ["debridge-dln"] } });
    assert.equal(preferred.steps[0]?.protocol, "debridge-dln");
    const avoided = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS, constraints: { avoidProtocols: ["relay", "debridge-dln"] } });
    assert.equal(avoided.steps[0]?.protocol, "lifi", "the only venue left wins with a warning even past the default limit");
    assert.ok(avoided.steps[0]?.warnings?.some((warning) => /above the default 10 min/u.test(warning)));
    assert.equal(quoteDetails(avoided.steps[0]).length, 1, "no auction evidence for a single venue");
  });

  it("refuses when every quote is slower than an explicit maxSeconds", async () => {
    venueScripts.relay = { minimumBps: 9_940, seconds: 700 };
    venueScripts["debridge-dln"] = { minimumBps: 9_940, seconds: 900 };
    const error = await planError({ actions: [BRIDGE], accounts: ACCOUNTS, constraints: { maxSeconds: 600 } });
    assert.equal(error.code, "ROUTE_TOO_SLOW");
    const viaLifi = await planError({ text: "bridge 25 USDC from base to arbitrum via lifi", accounts: ACCOUNTS, constraints: { maxSeconds: 900 } });
    assert.equal(viaLifi.code, "ROUTE_TOO_SLOW", "an explicit limit also binds a named venue");
  });

  it("applies an explicit maxSeconds to a sole venue whose extra costs are also unpriced", async () => {
    const aero = findAssetBySymbol("base", "AERO");
    assert.ok(aero);
    const unpricedSlow: VenueScript = {
      minimumBps: 9_900,
      seconds: 75,
      extraCosts: () => [{ asset: aero.id, symbol: "AERO", decimals: 18, amount: "1000000000000000000", formatted: "1" }],
    };
    venueScripts["debridge-dln"] = unpricedSlow;
    const viaDln = { text: "bridge 25 USDC from base to arbitrum via debridge", accounts: ACCOUNTS };
    assert.equal((await planError({ ...viaDln, constraints: { maxSeconds: 30 } })).code, "ROUTE_TOO_SLOW");
    const kept = await planIntent(viaDln);
    assert.equal(kept.steps[0]?.protocol, "debridge-dln", "without a caller limit the sole venue is still kept");
    // POST /v1/quotes: a lone route past the caller's own limit is not the best route either.
    venueScripts.relay = { minimumBps: 9_900, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    venueScripts.lifi = { minimumBps: 9_900, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    const lone = { network: "base", from: "USDC", to: "USDC", toNetwork: "arbitrum", amount: "25" };
    assert.equal((await quoteRoutes({ ...lone, maxSeconds: 30 })).best, null);
    assert.equal((await quoteRoutes(lone)).best?.protocol, "debridge-dln");
  });

  it("honours a named venue (\"via lifi\") without an auction", async () => {
    const graph = await planIntent({ text: "bridge 25 USDC from base to arbitrum via lifi", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "lifi");
    assert.equal(quoteDetails(graph.steps[0]).length, 1);
  });

  it("times out a venue that does not quote and records it", async () => {
    configureVenueQuoteTimeout(50);
    venueScripts.relay = { minimumBps: 9_999, seconds: 1, hang: true };
    venueScripts.lifi = { minimumBps: 9_000, seconds: 1, fail: "LIFI_RATE_LIMITED" };
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "debridge-dln");
    const details = quoteDetails(graph.steps[0]);
    assert.ok(details.includes("Relay could not quote (VENUE_TIMEOUT)."), details.join("\n"));
    assert.ok(details.includes("LI.FI could not quote (LIFI_RATE_LIMITED)."), details.join("\n"));
  });

  it("surfaces the first venue error when nobody quotes", async () => {
    for (const protocol of ["relay", "lifi", "debridge-dln"]) venueScripts[protocol] = { minimumBps: 9_900, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    const error = await planError({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(error.code, "AMOUNT_TOO_SMALL");
  });

  it("runs the auction for bridges to and from the new networks", async () => {
    const graph = await planIntent({ text: "bridge 100 USDC from ethereum to base", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.network, "ethereum");
    assert.equal(graph.steps[0]?.account, `eip155:1:${EVM_ADDRESS}`);
    assert.equal(graph.steps[0]?.settlement?.destinationNetwork, "base");
    assert.equal(graph.steps[0]?.protocol, "relay");
  });
});

describe("auction ranking: on-chain floors break ties", () => {
  function quote(id: "relay" | "lifi", floor: "onchain" | "claimed" | undefined, minimum = "1000", seconds = 30, transactions = 1): VenueQuote {
    const adapter = { id, protocols: [id], label: id } as unknown as VenueQuote["adapter"];
    return {
      adapter,
      protocol: id,
      netMinimum: BigInt(minimum),
      slow: false,
      value: Number(minimum),
      score: { valueUsd: Number(minimum), expectedUsd: Number(minimum), minimumUsd: Number(minimum), minimumKind: floor ?? "claimed", gasUsd: 0, feesUsd: 0, seconds, signatures: transactions, riskUsd: 0 },
      haircutBps: 0,
      pFill: 1,
      planned: { minimumOutput: { amount: minimum }, estimatedSeconds: seconds, transactionCount: transactions, ...(floor ? { floor } : {}) } as VenueQuote["planned"],
    };
  }

  it("prefers an on-chain floor over a claimed one only when output, time and transactions tie", () => {
    const claimed = quote("relay", "claimed");
    const onchain = quote("lifi", "onchain");
    const order = [claimed.adapter, onchain.adapter];
    assert.deepEqual([claimed, onchain].sort((a, b) => compareQuotes(a, b, [], order)).map((entry) => entry.protocol), ["lifi", "relay"]);
    const unstated = quote("relay", undefined);
    assert.deepEqual([unstated, onchain].sort((a, b) => compareQuotes(a, b, [], order)).map((entry) => entry.protocol), ["lifi", "relay"], "an unstated floor counts as claimed");
    const richer = quote("relay", "claimed", "1001");
    assert.deepEqual([onchain, richer].sort((a, b) => compareQuotes(a, b, [], order)).map((entry) => entry.protocol), ["relay", "lifi"], "output first");
    const faster = quote("relay", "claimed", "1000", 10);
    assert.deepEqual([onchain, faster].sort((a, b) => compareQuotes(a, b, [], order)).map((entry) => entry.protocol), ["relay", "lifi"], "then seconds");
    assert.deepEqual([claimed, onchain].sort((a, b) => compareQuotes(a, b, ["relay"], order)).map((entry) => entry.protocol), ["relay", "lifi"], "a preferred venue still wins");
  });
});

describe("POST /v1/quotes ranking", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    snapshot();
  });

  it("ranks routes like the auction and flags ineligible ones", async () => {
    const result = await quoteRoutes({ network: "base", from: "USDC", to: "USDC", toNetwork: "arbitrum", amount: "25" });
    assert.deepEqual(result.routes.map((route) => `${route.protocol}:${route.eligible}`), ["relay:true", "debridge-dln:true", "lifi:false"]);
    assert.equal(result.best?.protocol, "relay");
    const dln = result.routes.find((route) => route.protocol === "debridge-dln");
    assert.equal(dln?.netMinimumOutput?.amount, "22180000");
    assert.equal(dln?.extraCosts?.[0]?.symbol, "ETH");
    assert.ok(result.routes.find((route) => route.protocol === "lifi")?.warnings.some((warning) => /slower than the time limit/u.test(warning)));
    const slow = await quoteRoutes({ network: "base", from: "USDC", to: "USDC", toNetwork: "arbitrum", amount: "25", maxSeconds: 2_000 });
    assert.equal(slow.routes.find((route) => route.protocol === "lifi")?.eligible, true, "eligible within the caller's limit");
    assert.equal(slow.best?.protocol, "relay", "but 18 minutes of waiting cost more than its better floor");
  });

  it("validates maxSeconds", async () => {
    await assert.rejects(quoteRoutes({ network: "base", from: "USDC", to: "USDC", toNetwork: "arbitrum", amount: "25", maxSeconds: 5 }), /invalid/u);
  });
});

describe("prepare holds extra costs to the plan", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 10, extraCosts: (action) => [nativeCost(action.network, "1000000000000000", 2.49)] };
  });

  it("prepares with the planned fee and refuses a higher one", async () => {
    // The $2.49 fixed fee is 10 % of 25 USDC: text requests need an explicit maxFeeUsd for that (design C.7).
    const intent = await createIntent({ text: "bridge 25 USDC from base to arbitrum via debridge", accounts: ACCOUNTS, constraints: { maxFeeUsd: 5 } });
    const step = intent.steps[0];
    assert.equal(step?.protocol, "debridge-dln");
    const prepared = await prepareStep(intent.id, "s1");
    const transaction = prepared.payload.transactions[0];
    assert.equal(transaction?.vm === "evm" ? transaction.value : null, "1000000000000000");
    assert.equal(transaction?.vm === "evm" ? transaction.to : null, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", "pinned DLN source from the registry");
    // Within the step's slippage (50 bps) is accepted; above it is refused.
    const dln = venueScripts["debridge-dln"] as VenueScript;
    venueScripts["debridge-dln"] = { ...dln, preparedCosts: (action) => [nativeCost(action.network, "1005000000000000", 2.5)] };
    await prepareStep(intent.id, "s1");
    venueScripts["debridge-dln"] = { ...dln, preparedCosts: (action) => [nativeCost(action.network, "1006000000000000", 2.5)] };
    await assert.rejects(prepareStep(intent.id, "s1"), (error: unknown) => error instanceof PlatformError && error.code === "QUOTE_MOVED" && /0\.001006 ETH/u.test(error.message));
    venueScripts["debridge-dln"] = { ...dln, preparedCosts: (action) => [nativeCost("base", "1", 0), { ...nativeCost(action.network, "1"), asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 }] };
    await assert.rejects(prepareStep(intent.id, "s1"), (error: unknown) => error instanceof PlatformError && error.code === "QUOTE_MOVED", "a cost the plan did not have");
  });
});

describe("destination account of cross-network steps", () => {
  beforeEach(() => resetVenueEngine({ bridges: true }));

  it("hands venues the user's own destination account, at plan and again at prepare, even with a third-party recipient", async () => {
    const intent = await createIntent({
      actions: [{ ...BRIDGE, toNetwork: "solana", recipient: OTHER_SOL_ADDRESS, protocol: "debridge-dln" }],
      accounts: ACCOUNTS,
    });
    assert.equal(intent.steps[0]?.protocol, "debridge-dln");
    const planned = bridgeCalls.at(-1);
    assert.equal(planned?.recipient.address, OTHER_SOL_ADDRESS);
    assert.equal(planned?.destinationAccount?.address, SOL_ADDRESS);
    await prepareStep(intent.id, "s1");
    const prepared = bridgeCalls.at(-1);
    assert.notEqual(prepared, planned);
    assert.equal(prepared?.destinationAccount?.address, SOL_ADDRESS, "actionForStep derives the same account from the intent");
  });

  it("leaves it unset when the intent has no account on the destination's VM", async () => {
    await planIntent({ actions: [{ ...BRIDGE, toNetwork: "solana", recipient: OTHER_SOL_ADDRESS, protocol: "debridge-dln" }], accounts: [EVM_ACCOUNT] });
    assert.equal(bridgeCalls.at(-1)?.destinationAccount, undefined);
  });
});

describe("auction mechanics (design B.2)", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    snapshot();
  });
  afterEach(() => {
    configureAuctionSoftDeadline(null);
    configurePlanDeadline(null);
  });

  it("ranks at the soft deadline once a complete quote has arrived, listing the venue still pending", async () => {
    configureAuctionSoftDeadline(20);
    venueScripts.relay = { minimumBps: 9_990, seconds: 1, delayMs: 400 };
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "debridge-dln", "Relay would have won but did not answer in time");
    const route = graph.interpretation.routes?.[0];
    assert.deepEqual(route?.snapshot.cutByDeadline, ["relay"]);
    assert.ok(route?.compared.some((entry) => entry.label === "Relay" && entry.excluded === "did not answer in time"), JSON.stringify(route?.compared));
  });

  it("waits past the soft deadline for the first complete quote", async () => {
    configureAuctionSoftDeadline(10);
    venueScripts.relay = { minimumBps: 9_940, seconds: 1, delayMs: 60 };
    venueScripts["debridge-dln"] = { minimumBps: 9_990, seconds: 1, delayMs: 600 };
    venueScripts.lifi = { minimumBps: 9_990, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "relay");
    assert.deepEqual(graph.interpretation.routes?.[0]?.snapshot.cutByDeadline, ["debridge-dln"]);
  });

  it("skips a venue whose breaker opened on transport failures, and never on business refusals (D7)", async () => {
    venueScripts.relay = { minimumBps: 9_940, seconds: 1, fail: "RELAY_UNAVAILABLE", failStatus: 502 };
    for (let index = 0; index < 5; index += 1) await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const before = bridgeCalls.length;
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const asked = bridgeCalls.slice(before);
    assert.equal(asked.length, 2, "Relay is not asked while its breaker is open");
    const route = graph.interpretation.routes?.[0];
    assert.deepEqual(route?.snapshot.breakerSkipped, ["relay"]);
    assert.ok(route?.compared.some((entry) => entry.label === "Relay" && entry.excluded === "failing right now (skipped)"));

    resetVenueEngine({ bridges: true });
    snapshot();
    venueScripts.relay = { minimumBps: 9_940, seconds: 1, fail: "AMOUNT_TOO_SMALL" };
    for (let index = 0; index < 10; index += 1) await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const count = bridgeCalls.length;
    await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(bridgeCalls.length - count, 3, "business refusals never open the breaker");
  });

  it("retries a 429 once when it asks for at most 1 s and more than 2 s of budget remain", async () => {
    venueScripts.relay = { minimumBps: 9_940, seconds: 1, rateLimited: { times: 1, retryAfterSeconds: 1 } };
    const graph = await withDeadline(15_000, "test", () => planIntent({ actions: [BRIDGE], accounts: ACCOUNTS }));
    assert.equal(graph.steps[0]?.protocol, "relay", "the retry quoted");

    venueScripts.relay = { minimumBps: 9_940, seconds: 1, rateLimited: { times: 1, retryAfterSeconds: 1 } };
    const short = await withDeadline(1_500, "test", () => planIntent({ actions: [BRIDGE], accounts: ACCOUNTS }));
    assert.equal(short.steps[0]?.protocol, "debridge-dln", "no retry with 1.5 s left");
    assert.ok(short.interpretation.routes?.[0]?.compared.some((entry) => entry.label === "Relay" && entry.excluded === "rate limited"));
  });

  it("shares one provider call between identical concurrent requests, never across accounts (E2)", async () => {
    venueScripts.relay = { minimumBps: 9_940, seconds: 1, delayMs: 50 };
    const before = bridgeCalls.length;
    await Promise.all([planIntent({ actions: [BRIDGE], accounts: ACCOUNTS }), planIntent({ actions: [BRIDGE], accounts: ACCOUNTS })]);
    const same = bridgeCalls.slice(before);
    assert.equal(same.length, 3, "one call per venue for two identical requests");
    const other = `eip155:8453:${OTHER_EVM_ADDRESS}`;
    const start = bridgeCalls.length;
    await Promise.all([planIntent({ actions: [BRIDGE], accounts: ACCOUNTS }), planIntent({ actions: [BRIDGE], accounts: [other] })]);
    assert.equal(bridgeCalls.length - start, 6, "another account never shares a call");
  });

  it("records the route, its snapshot and every provider that saw the account", async () => {
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const route = graph.interpretation.routes?.[0];
    assert.ok(route);
    assert.deepEqual(route.steps, ["s1"]);
    assert.equal(route.shape, "bridge");
    assert.deepEqual(route.venues, ["relay"]);
    assert.equal(route.score.minimumKind, "claimed");
    assert.ok(route.score.valueUsd > 24 && route.score.valueUsd < 25, String(route.score.valueUsd));
    assert.match(route.reason, /^Relay venue|^Relay: /u);
    assert.match(route.reason, /quoted minimum/u, "a claimed floor is never called guaranteed (D1)");
    assert.deepEqual(route.snapshot.quotes.map((quote) => quote.venue).sort(), ["debridge-dln", "lifi", "relay"]);
    assert.ok(route.snapshot.gas.base, "the gas price used is part of the snapshot");
    assert.deepEqual(route.alternatives, []);
    assert.deepEqual(graph.interpretation.providersContacted, [
      { provider: "relay", sawAccount: true },
      { provider: "lifi", sawAccount: true },
      { provider: "debridge-dln", sawAccount: true },
    ]);
  });
});

describe("pre-screen cache (design B.2, E1)", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    snapshot();
  });

  it("ranks cached quotes within 5 % of the size as estimates, re-quotes the top two fresh and never plans an estimate", async () => {
    const action = bridgeAction("base", "arbitrum");
    const options = { maxSeconds: 600, explicitMaxSeconds: false, prefer: [] };
    await runVenueAuction(BRIDGE_STUBS, action, options);
    const before = bridgeCalls.length;
    const result = await runVenueAuction(BRIDGE_STUBS, { ...action, amount: "25400000" }, { ...options, prescreen: true });
    const asked = bridgeCalls.slice(before);
    assert.equal(asked.length, 2, "only the top two were asked again");
    assert.ok(asked.every((call) => call.amount === "25400000"));
    assert.equal(result.winner.estimate, undefined);
    assert.equal(result.winner.protocol, "relay");
    const lifi = result.losers.find((quote) => quote.protocol === "lifi");
    assert.equal(lifi?.estimate, true, "the third stays a labelled estimate");
    assert.equal(lifi?.score.estimate, true);
    assert.equal(lifi?.planned.expectedOutput.amount, ((25_000_000n * 25_400_000n) / 25_000_000n).toString(), "scaled to the asked amount");
    // Outside the 5 % bucket nothing is cached: every venue is asked (Relay and
    // LI.FI with the neutral pre-screen address), then the leading neutral
    // estimate is asked again with the account before it can win.
    const start = bridgeCalls.length;
    const fresh = await runVenueAuction(BRIDGE_STUBS, { ...action, amount: "40000000" }, { ...options, prescreen: true });
    const calls = bridgeCalls.slice(start);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => isNeutralAccount(call.account)).length, 2, "relay and lifi pre-screened without the account");
    assert.equal(fresh.winner.estimate, undefined);
    const last = calls.at(-1);
    assert.ok(last && !isNeutralAccount(last.account), "the winner was re-quoted with the person's account");
  });

  it("keys the cache on every field but the amount: another recipient or slippage misses", () => {
    const action = bridgeAction("base", "arbitrum");
    const adapter = BRIDGE_STUBS[0] as (typeof BRIDGE_STUBS)[number];
    assert.equal(prescreenKey(adapter, action), prescreenKey(adapter, { ...action, amount: "25100000" }));
    assert.notEqual(prescreenKey(adapter, action), prescreenKey(adapter, { ...action, slippageBps: 30 }));
    assert.notEqual(prescreenKey(adapter, action), prescreenKey(adapter, bridgeAction("base", "arbitrum", { recipient: OTHER_EVM_ADDRESS })));
    assert.notEqual(prescreenKey(adapter, action), prescreenKey(adapter, { ...action, amount: "27000000" }));
    assert.notEqual(fullRequestKey(adapter, action), fullRequestKey(adapter, { ...action, amount: "25000001" }));
  });

  it("pre-screens account-independent venues with the neutral address, and only when the recipient is the person's own", () => {
    const action = bridgeAction("base", "arbitrum");
    const relay = { id: "relay" } as const;
    const neutral = neutralPrescreenAction(relay, action);
    assert.ok(neutral);
    assert.equal(isNeutralAccount(neutral.account), true);
    assert.equal(isNeutralAccount(neutral.recipient), true);
    assert.equal(neutralPrescreenAction({ id: "debridge-dln" }, action), null, "DLN's order authority needs the real account (AR1)");
    assert.equal(neutralPrescreenAction(relay, bridgeAction("base", "arbitrum", { recipient: OTHER_EVM_ADDRESS })), null, "a payment to someone else keeps its recipient");
  });
});
