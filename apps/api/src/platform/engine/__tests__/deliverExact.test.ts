/**
 * Exact delivery: the sizing loop (first guess, rescales, at most three runs,
 * the 50 bps cap on the first guess), the route pin (run 1 records, runs 2-3
 * replay its venues), `receiveExact` payments planned so the recipient receives
 * the stated amount, and the refusals: an amount that cannot be sized carries
 * `{ exactDelivery, statedAmount, quotedReceive }`, and `receiveExact` on
 * anything but a payment of one token family.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { toBaseUnits } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { planIntent } from "../planner.js";
import { currentRoutePin, DeliveryCandidateRejected, EXACT_DELIVERY_RUNS, RoutePin, sizeExactDelivery } from "../routing/deliverExact.js";
import { ACCOUNTS, OTHER_EVM_ADDRESS } from "./helpers.js";
import { bridgeCalls, resetVenueEngine, venueScripts } from "./venueStubs.js";

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

const unquotable = (detail: string, last: { minimumUnits: bigint } | null) =>
  new PlatformError("ROUTE_UNSUPPORTED", `unquotable: ${detail}`, 422, [], [], { quotedReceive: last ? last.minimumUnits.toString() : null });

describe("sizing loop", () => {
  it("accepts a first guess within 50 bps, else rescales; at most three runs", async () => {
    const asked: bigint[] = [];
    const sized = await sizeExactDelivery({
      targetUnits: 100_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        asked.push(input);
        check((input * 9_900n) / 10_000n);
        return input;
      },
      unquotable,
    });
    assert.equal(sized.runs, 2);
    assert.ok(sized.minimumUnits >= 100_000_000n);
    assert.equal(asked[0], 100_300_903n, "x0 = ceil(T x 10^4 / 9,970)");
    let runs = 0;
    const error = await failure(sizeExactDelivery({
      targetUnits: 100_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        runs += 1;
        check(99_999_999n);
        return input;
      },
      unquotable,
    }));
    assert.equal(runs, EXACT_DELIVERY_RUNS);
    assert.equal((error.details as { quotedReceive: string }).quotedReceive, "99999999");
  });

  it("lets other errors through and never accepts a run that reports no minimum", async () => {
    const route = await failure(sizeExactDelivery({ targetUnits: 1n, targetDecimals: 6, inputDecimals: 6, plan: async () => { throw new PlatformError("ROUTE_UNSUPPORTED", "no venue", 422); }, unquotable }));
    assert.equal(route.message, "no venue");
    const silent = await failure(sizeExactDelivery({ targetUnits: 1n, targetDecimals: 6, inputDecimals: 6, plan: async (input) => input, unquotable }));
    assert.match(silent.message, /reported no guaranteed minimum/u);
    assert.ok(new DeliveryCandidateRejected(1n, 2n) instanceof PlatformError);
  });

  it("records run 1's route and replays it for runs 2-3", async () => {
    const modes: string[] = [];
    const replayed: (string | undefined)[] = [];
    await sizeExactDelivery({
      targetUnits: 100_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check, run) => {
        const pin = currentRoutePin() as RoutePin;
        modes.push(pin.mode);
        if (run === 1) pin.recordVenue("leg", "relay");
        else replayed.push(pin.venue("leg"));
        pin.recordVenue("leg", "debridge-dln");
        check(run === 1 ? 90_000_000n : 100_100_000n);
        return input;
      },
      unquotable,
    });
    assert.deepEqual(modes, ["record", "replay"]);
    assert.deepEqual(replayed, ["relay"], "run 2 reuses run 1's venue; replay never overwrites it");
    assert.equal(currentRoutePin(), null, "the pin lives only inside the loop");
  });
});

describe("receiveExact payments in the planner", () => {
  beforeEach(() => resetVenueEngine({ bridges: true }));

  const PAY = (amount: string) => ({
    actions: [{ kind: "bridge" as const, network: "base" as const, toNetwork: "arbitrum" as const, from: "USDC", amount, recipient: OTHER_EVM_ADDRESS, receiveExact: true as const }],
    accounts: ACCOUNTS,
  });

  it("sizes the input so the recipient receives at least the stated amount", async () => {
    venueScripts.relay = { minimumBps: 9_990, seconds: 10 };
    venueScripts.lifi = { minimumBps: 9_900, seconds: 10 };
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 10 };
    const graph = await planIntent(PAY("100"));
    const step = graph.steps[0];
    assert.ok(step?.minimumOutput && step.input);
    assert.ok(BigInt(step.minimumOutput.amount) >= BigInt(toBaseUnits("100", 6)), step.minimumOutput.formatted);
    assert.ok(BigInt(step.input.amount) > BigInt(toBaseUnits("100", 6)), "the person pays the crossing's fees");
    assert.ok(step.recipient?.endsWith(OTHER_EVM_ADDRESS));
    assert.ok(step.warnings?.some((warning) => /^The recipient receives at least 100 USDC; 100\.\d+ USDC is sent/u.test(warning)), JSON.stringify(step.warnings));
  });

  it("re-quotes runs 2-3 on run 1's venue only", async () => {
    venueScripts.relay = { minimumBps: 9_900, seconds: 10 };
    venueScripts.lifi = { minimumBps: 9_800, seconds: 10 };
    venueScripts["debridge-dln"] = { minimumBps: 9_800, seconds: 10 };
    const graph = await planIntent(PAY("100"));
    assert.equal(graph.steps[0]?.protocol, "relay");
    // Run 1 auctions every venue; run 2 asks Relay alone.
    const after = bridgeCalls.slice(3);
    assert.ok(after.length >= 1);
    assert.ok(bridgeCalls.length === 4, `calls: ${bridgeCalls.length}`);
    assert.ok(BigInt(graph.steps[0]?.minimumOutput?.amount ?? "0") >= 100_000_000n);
  });

  it("delivers a same-network transfer's amount by construction", async () => {
    const graph = await planIntent({ actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: OTHER_EVM_ADDRESS, receiveExact: true }], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.input?.amount, "25000000");
  });

  it("refuses receiveExact on anything but a payment of one token family", async () => {
    const swap = await failure(planIntent({ actions: [{ kind: "swap", network: "base", from: "USDC", to: "ETH", amount: "10", receiveExact: true }], accounts: ACCOUNTS }));
    assert.equal(swap.code, "INVALID_REQUEST");
    const own = await failure(planIntent({ actions: [{ kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "10", receiveExact: true }], accounts: ACCOUNTS }));
    assert.equal(own.code, "INVALID_REQUEST", "no recipient: not a payment");
    const changing = await failure(planIntent({
      actions: [{ kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", to: "ETH", amount: "10", recipient: OTHER_EVM_ADDRESS, receiveExact: true }],
      accounts: ACCOUNTS,
    }));
    assert.equal(changing.code, "INTENT_UNSUPPORTED");
    assert.match(changing.message, /two tokens/u);
    const wrong = await failure(planIntent({ actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "1", recipient: OTHER_EVM_ADDRESS, receiveExact: "yes" }], accounts: ACCOUNTS }));
    assert.equal(wrong.code, "INVALID_REQUEST");
  });
});
