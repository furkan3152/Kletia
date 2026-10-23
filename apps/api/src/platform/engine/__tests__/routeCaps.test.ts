/**
 * Plan size and fee sanity (design C.7, owner decisions O9 and O10): at most
 * 8 wallet signatures and 12 venue auctions per plan, counted after
 * expansion (PLAN_TOO_LARGE with the moves); for a request written as text
 * without `maxFeeUsd`, fees above 5 % of the value moved refuse with
 * FEE_LIMIT_EXCEEDED and its details (seam S7: the decision layer turns both
 * into questions). Structured actions keep today's `maxFeeUsd` semantics.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { PlatformError } from "../../errors.js";
import { planIntent } from "../planner.js";
import { assertFeeSanity, MAX_PLAN_AUCTIONS, MAX_PLAN_SIGNATURES, PlanBudget } from "../routing/caps.js";
import { ACCOUNTS } from "./helpers.js";
import { nativeCost, resetVenueEngine, venueScripts } from "./venueStubs.js";

async function refusal(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail("planned but should have been refused");
}

beforeEach(() => resetVenueEngine({ bridges: true }));

describe("plan size caps (C.7, C9)", () => {
  it("refuses a plan needing more than 8 wallet signatures, listing the moves", async () => {
    for (const protocol of ["relay", "lifi", "debridge-dln"]) venueScripts[protocol] = { minimumBps: 9_940, seconds: 1, transactions: 3 };
    const leg = (from: string, to: string) => ({ kind: "bridge", network: from, from: "USDC", amount: "1000", toNetwork: to });
    const fits = await planIntent({ actions: [leg("base", "arbitrum"), leg("optimism", "polygon")], accounts: ACCOUNTS });
    assert.equal(fits.summary.signaturesRequired, 6);
    const error = await refusal({ actions: [leg("base", "arbitrum"), leg("optimism", "polygon"), leg("ethereum", "base")], accounts: ACCOUNTS });
    assert.equal(error.code, "PLAN_TOO_LARGE");
    assert.equal(error.details?.signatures, 9);
    assert.equal(error.details?.auctions, 3);
    assert.equal((error.details?.moves as readonly string[]).length, 3);
    assert.match(error.message, /9 wallet signatures \(at most 8\)/u);
    assert.equal(MAX_PLAN_SIGNATURES, 8);
  });

  it("stops a plan at its 13th auction", () => {
    const budget = new PlanBudget();
    for (let index = 0; index < MAX_PLAN_AUCTIONS; index += 1) budget.startAuction(`move ${index + 1}`);
    assert.throws(() => budget.startAuction("one more"), (error: unknown) =>
      error instanceof PlatformError && error.code === "PLAN_TOO_LARGE" && error.details?.auctions === 13 && error.details?.signatures === null);
  });
});

describe("fee sanity (C.7, C7)", () => {
  it("refuses fees above 5 % of the value moved for a text request, with the details the decision layer needs", async () => {
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 10, extraCosts: () => [] };
    const text = { text: "bridge 25 USDC from base to arbitrum via debridge", accounts: ACCOUNTS };
    // Without a fixed fee the bridge stub reports no fees at all.
    assert.equal((await planIntent(text)).steps[0]?.protocol, "debridge-dln");
    venueScripts["debridge-dln"] = {
      minimumBps: 9_900,
      seconds: 10,
      extraCosts: (action) => (action.network === "base" ? [nativeCost("base", "1000000000000000", 2.49)] : []),
    };
    const error = await refusal(text);
    assert.equal(error.code, "FEE_LIMIT_EXCEEDED");
    assert.equal(error.details?.valueUsd, 25);
    assert.equal(error.details?.feeUsd, 2.49, "the fixed fee paid on top: 10 % of 25 USDC");
    assert.deepEqual(error.details?.cheaperShapes, []);
    assert.equal(error.issues?.[0]?.path, "constraints.maxFeeUsd");
    // An explicit maxFeeUsd replaces the 5 % rule (with its existing meaning: the steps' reported fees).
    assert.equal((await planIntent({ ...text, constraints: { maxFeeUsd: 3 } })).steps[0]?.protocol, "debridge-dln");
    // Structured actions keep today's semantics: no default 5 % gate (accepted risk AR6).
    const actions = await planIntent({ actions: [{ kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "arbitrum", protocol: "debridge-dln" }], accounts: ACCOUNTS });
    assert.equal(actions.steps[0]?.protocol, "debridge-dln");
    // A clarify turn (a thread in the interpretation) skips the gate until the
    // decision layer asks FEE_HIGH itself; it opts back in with feeSanity: true.
    const thread = { id: "thr_fee", rev: 1 };
    assert.equal((await planIntent(text, { interpretation: { thread } })).steps[0]?.protocol, "debridge-dln");
    await assert.rejects(planIntent(text, { interpretation: { thread }, feeSanity: true }), (rejected: unknown) =>
      rejected instanceof PlatformError && rejected.code === "FEE_LIMIT_EXCEEDED");
    await assert.doesNotReject(planIntent(text, { feeSanity: false }));
  });

  it("applies only when both sides are known, and refuses above the 5 % share only", () => {
    assert.doesNotThrow(() => assertFeeSanity({ feeUsd: 100, valueUsd: null }));
    assert.doesNotThrow(() => assertFeeSanity({ feeUsd: 5, valueUsd: 100 }));
    assert.throws(() => assertFeeSanity({ feeUsd: 5.01, valueUsd: 100 }), (error: unknown) => error instanceof PlatformError && error.code === "FEE_LIMIT_EXCEEDED");
  });
});
