/**
 * Request deadline: planning runs under one budget (15 s); every stage reads
 * what remains (per-venue timeouts, score facts), a nested deadline never
 * extends the outer one, and a spent budget fails closed with PLAN_TIMEOUT
 * (504), never with a partial plan.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PlatformError } from "../../errors.js";
import { configureAuctionSoftDeadline, configureVenueQuoteTimeout } from "../auction.js";
import {
  assertWithinDeadline,
  budgetMs,
  configurePlanDeadline,
  currentDeadline,
  PLAN_DEADLINE_MS,
  planDeadlineBudgetMs,
  raceBudget,
  remainingMs,
  withDeadline,
} from "../routing/deadline.js";
import { createIntent } from "../service.js";
import { ACCOUNTS } from "./helpers.js";
import { resetRouteEngine, resetVenueEngine, routeScripts, stubRouteVenue, venueScripts } from "./venueStubs.js";
import { COMPOSER_MIN_BUDGET_MS } from "../routing/composer.js";
import { configureRouteShapes } from "../routing/shapes.js";

const BRIDGE = { kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "arbitrum" } as const;

function isTimeout(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "PLAN_TIMEOUT" && error.status === 504;
}

describe("deadline propagation", () => {
  it("has a 15 s planning budget by default", () => {
    assert.equal(PLAN_DEADLINE_MS, 15_000);
    assert.equal(planDeadlineBudgetMs(), 15_000);
    assert.equal(remainingMs(), Number.POSITIVE_INFINITY, "no deadline outside a request");
    assert.equal(budgetMs(6_000), 6_000);
  });

  it("gives each stage the remaining budget, never more, and nests without extending", async () => {
    await withDeadline(500, "outer", async () => {
      assert.ok(remainingMs() <= 500 && remainingMs() > 400);
      assert.ok(budgetMs(6_000) <= 500, "a 6 s venue timeout is capped by the budget");
      await withDeadline(10_000, "inner", async () => {
        assert.ok(remainingMs() <= 500, "the inner deadline cannot extend the outer one");
        assert.equal(currentDeadline()?.label, "outer");
      });
    });
  });

  it("rejects with PLAN_TIMEOUT when the budget is spent, whatever the task does later", async () => {
    await assert.rejects(withDeadline(30, "test", () => new Promise((resolve) => setTimeout(resolve, 500))), isTimeout);
    await assert.rejects(withDeadline(30, "test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertWithinDeadline();
    }), isTimeout);
  });

  it("races a venue against its own timeout, or against the budget when less remains", async () => {
    const venueTimeout = () => new PlatformError("VENUE_TIMEOUT", "slow venue", 504);
    await assert.rejects(raceBudget(new Promise(() => undefined), 20, venueTimeout), (error: unknown) => error instanceof PlatformError && error.code === "VENUE_TIMEOUT");
    await assert.rejects(withDeadline(20, "test", () => raceBudget(new Promise(() => undefined), 5_000, venueTimeout)), isTimeout);
    assert.equal(await raceBudget(Promise.resolve(7), 20, venueTimeout), 7);
  });
});

describe("POST /v1/intents under the planning budget", () => {
  beforeEach(() => resetVenueEngine({ bridges: true }));
  afterEach(() => {
    configurePlanDeadline(null);
    configureAuctionSoftDeadline(null);
    configureVenueQuoteTimeout(null);
  });

  it("fails closed with PLAN_TIMEOUT when a sole venue never answers", async () => {
    configurePlanDeadline(80);
    venueScripts["debridge-dln"] = { minimumBps: 9_900, seconds: 1, hang: true };
    const started = Date.now();
    await assert.rejects(createIntent({ text: "bridge 25 USDC from base to arbitrum via debridge", accounts: ACCOUNTS, constraints: { maxFeeUsd: 5 } }), isTimeout);
    assert.ok(Date.now() - started < 2_000, "no 15 s wait");
  });

  it("caps an auction's per-venue timeout by what remains of the budget", async () => {
    configurePlanDeadline(150);
    configureAuctionSoftDeadline(10_000);
    for (const protocol of ["relay", "lifi", "debridge-dln"]) venueScripts[protocol] = { minimumBps: 9_900, seconds: 1, hang: true };
    await assert.rejects(createIntent({ actions: [BRIDGE], accounts: ACCOUNTS }), isTimeout);
  });

  it("plans normally within the budget", async () => {
    configurePlanDeadline(5_000);
    const graph = await createIntent({ actions: [BRIDGE], accounts: ACCOUNTS });
    assert.equal(graph.steps.length, 1);
  });
});

describe("composer under the planning budget", () => {
  const NETWORKS = ["base", "arbitrum", "solana"] as const;
  const USDC_TO_SOL = { actions: [{ kind: "swap" as const, network: "base" as const, toNetwork: "solana" as const, from: "USDC", to: "SOL", amount: "1000" }], accounts: ACCOUNTS };

  beforeEach(() => {
    resetRouteEngine([
      stubRouteVenue("relay", { kind: "bridge", networks: NETWORKS }),
      stubRouteVenue("cctp-v2", { kind: "bridge", networks: NETWORKS, sameFamilyOnly: true }),
      stubRouteVenue("jupiter", { kind: "swap", networks: ["solana"] }),
    ]);
    routeScripts.relay = { bps: 9_900 };
    routeScripts["cctp-v2"] = { bps: 9_990 };
    routeScripts.jupiter = { bps: 9_990 };
    configureRouteShapes("compare");
  });
  afterEach(() => {
    configureRouteShapes(null);
    configurePlanDeadline(null);
    configureAuctionSoftDeadline(null);
  });

  it("pre-screens composites only while enough budget remains", async () => {
    assert.ok(COMPOSER_MIN_BUDGET_MS <= 5_000);
    configurePlanDeadline(COMPOSER_MIN_BUDGET_MS - 1_000);
    const short = await createIntent(USDC_TO_SOL);
    assert.equal(short.steps.length, 1, "the one-shot alone");
    configurePlanDeadline(null);
    const full = await createIntent(USDC_TO_SOL);
    assert.equal(full.steps.length, 2, "the cheaper composite with the full budget");
  });

  it("cuts a composite whose leg answers too late, keeping budget to plan the one-shot", async () => {
    // 5.5 s budget: composites get at most 1.5 s before the 4 s planning reserve; the Solana leg takes 3 s.
    configurePlanDeadline(COMPOSER_MIN_BUDGET_MS + 500);
    routeScripts.jupiter = { bps: 9_990, delayMs: 3_000 };
    const started = Date.now();
    const graph = await createIntent(USDC_TO_SOL);
    assert.equal(graph.steps.length, 1, "the one-shot");
    assert.ok(Date.now() - started < 2_900, `took ${Date.now() - started} ms`);
    assert.ok(graph.interpretation.routes?.[0]?.compared.some((entry) => entry.excluded === "did not answer in time"), JSON.stringify(graph.interpretation.routes?.[0]?.compared));
  });

  it("fails closed with PLAN_TIMEOUT when no shape answers", async () => {
    configurePlanDeadline(COMPOSER_MIN_BUDGET_MS + 300);
    for (const protocol of ["relay", "cctp-v2", "jupiter"]) routeScripts[protocol] = { bps: 9_990, delayMs: 20_000 };
    await assert.rejects(createIntent(USDC_TO_SOL), isTimeout);
  });
});
