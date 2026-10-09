/**
 * Cross-network venue auction: net guaranteed output (minimum minus priced
 * extra costs), time limit, preference, timeouts, loser evidence, the same
 * ranking in POST /v1/quotes and the prepare-time extra-cost guard.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configureVenueQuoteTimeout, netMinimumOutput } from "../auction.js";
import { planIntent } from "../planner.js";
import { quoteRoutes } from "../quotes.js";
import { createIntent, prepareStep } from "../service.js";
import { ACCOUNTS, EVM_ACCOUNT, EVM_ADDRESS, OTHER_SOL_ADDRESS, SOL_ADDRESS } from "./helpers.js";
import { bridgeCalls, nativeCost, resetVenueEngine, venueScripts, type VenueScript } from "./venueStubs.js";

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

  it("selects by net guaranteed output within the default 600 s and records every losing quote", async () => {
    const graph = await planIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "relay", "LI.FI is slower than 600 s and DLN nets less after its fee");
    assert.equal(step?.minimumOutput?.amount, "24850000");
    const details = quoteDetails(step);
    assert.match(details[0] ?? "", /^Quoted by Relay venue\. Selected over 2 other venue\(s\)/u);
    assert.ok(details.some((detail) => /Also quoted: LI\.FI: 24\.9375 USDC guaranteed, ~18 min.*not selected \(slower than the time limit\)/u.test(detail)), details.join("\n"));
    assert.ok(details.some((detail) => /Also quoted: deBridge DLN: 24\.67 USDC guaranteed \(net 22\.18 after 0\.001 ETH\)/u.test(detail)), details.join("\n"));
    // Provider ids of losing venues never become references (references of quote evidence bind deposits).
    const references = step?.evidence.filter((entry) => entry.kind === "quote" && entry.reference).map((entry) => entry.reference);
    assert.deepEqual(references, [`0x${"11".repeat(32)}`]);
  });

  it("lets a slower venue win when constraints.maxSeconds allows it", async () => {
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

  it("excludes a venue whose extra costs cannot be priced", async () => {
    const aero = findAssetBySymbol("base", "AERO");
    assert.ok(aero);
    venueScripts.relay = { minimumBps: 9_000, seconds: 1 };
    venueScripts["debridge-dln"] = {
      minimumBps: 9_990,
      seconds: 5,
      extraCosts: () => [{ asset: aero.id, symbol: "AERO", decimals: 18, amount: "1000000000000000000", formatted: "1" }],
    };
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
    assert.equal(slow.best?.protocol, "lifi");
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
    const intent = await createIntent({ text: "bridge 25 USDC from base to arbitrum via debridge", accounts: ACCOUNTS });
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
