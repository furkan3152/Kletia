import assert from "node:assert/strict";
import test from "node:test";
import { HOLDING_PENALTY_APY_POINTS, RISK_TIERS, TRANSIT_RISK, TVL_FLOOR_USD, riskAdjustedApy, transitRiskUsd, worstRiskTier } from "../dist/index.js";

test("risk: every tier has a transit cost, a holding penalty and a TVL floor; costs grow with the tier", () => {
  assert.deepEqual([...RISK_TIERS], ["core", "curated", "extended", "testnet"]);
  for (const tier of RISK_TIERS) {
    assert.ok(TRANSIT_RISK[tier] && HOLDING_PENALTY_APY_POINTS[tier] !== undefined && TVL_FLOOR_USD[tier] !== undefined, tier);
  }
  assert.ok(TRANSIT_RISK.core.minUsd <= TRANSIT_RISK.curated.minUsd && TRANSIT_RISK.curated.minUsd <= TRANSIT_RISK.extended.minUsd);
  assert.ok(HOLDING_PENALTY_APY_POINTS.core < HOLDING_PENALTY_APY_POINTS.curated && HOLDING_PENALTY_APY_POINTS.curated < HOLDING_PENALTY_APY_POINTS.extended);
  assert.ok(TVL_FLOOR_USD.core > TVL_FLOOR_USD.curated && TVL_FLOOR_USD.curated > TVL_FLOOR_USD.extended);
  assert.ok(Object.isFrozen(TRANSIT_RISK) && Object.isFrozen(TRANSIT_RISK.curated) && Object.isFrozen(HOLDING_PENALTY_APY_POINTS));
});

test("risk: transit is max(minimum, bps of the value moved); testnet and core cost nothing", () => {
  assert.equal(transitRiskUsd("core", 1_000_000), 0);
  assert.equal(transitRiskUsd("testnet", 1_000_000), 0);
  assert.equal(transitRiskUsd("curated", 1_000), 0.25);
  assert.equal(transitRiskUsd("curated", 10_000), 1);
  assert.equal(transitRiskUsd("extended", 100), 1);
  assert.equal(transitRiskUsd("extended", 100_000), 50);
  assert.equal(transitRiskUsd("extended", Number.NaN), 1, "an unpriced amount still pays the minimum");
  assert.equal(transitRiskUsd("curated", -5), 0.25);
});

test("risk: holding penalties lower a rate in APY points; an unknown rate stays unknown", () => {
  assert.equal(riskAdjustedApy("core", 0.041), 0.041);
  assert.ok(Math.abs((riskAdjustedApy("curated", 0.05) ?? 0) - 0.045) < 1e-12, "Morpho 5.0 % curated is 4.5 % adjusted");
  assert.ok(Math.abs((riskAdjustedApy("extended", 0.07) ?? 0) - 0.055) < 1e-12);
  assert.equal(riskAdjustedApy("core", null), null);
  assert.equal(riskAdjustedApy("curated", Number.NaN), null);
});

test("risk: a route is as risky as its riskiest venue", () => {
  assert.equal(worstRiskTier([]), "core");
  assert.equal(worstRiskTier(["core", "curated"]), "curated");
  assert.equal(worstRiskTier(["extended", "curated", "core"]), "extended");
});
