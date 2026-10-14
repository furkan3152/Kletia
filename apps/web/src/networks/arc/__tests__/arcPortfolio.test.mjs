// The Arc console portfolio guard: during a price-source outage the API still
// answers, with lending.healthFactor null and healthAvailability
// "unavailable"; the console must accept that response (and show the health
// factor as unavailable) instead of rejecting the whole portfolio. Run with
//   node --test apps/web/src/networks/arc/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { isArcPortfolioData } from "../../../shared/types.ts";

/** The shape GET /api/arc/portfolio returns (apps/api/src/networks/arc/handlers.ts getArcPortfolio). */
function portfolio(lending = {}) {
  return {
    network: "arc",
    chainId: 5_042_002,
    wallet: [
      { symbol: "USDC", name: "Native USDC", balance: "5000000000000000000", formatted: "5" },
      { symbol: "KLET", name: "Kletia Token", balance: "7000000000000000000", formatted: "7", address: "0xAe77D247c26258397653a020995E957Bc88E039A" },
    ],
    vault: {
      executionMode: "vault_v2",
      address: "0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d",
      principal: "1",
      accruedInterest: "0.1",
      pendingInterest: "0.01",
    },
    staking: { stakedAmount: "3", pendingUnstake: "1", pendingRewards: "0.02", cooldownRemaining: 0 },
    lending: {
      collateralKLET: "10",
      borrowedUSDC: "2",
      suppliedUSDC: "0",
      healthFactor: "1.5",
      healthAvailability: "available",
      ...lending,
    },
    routeAvailability: { status: "available_for_intent_planning" },
    observedAtBlock: "4242",
  };
}

test("an oracle outage (healthFactor null) keeps the Arc portfolio valid", () => {
  assert.equal(isArcPortfolioData(portfolio({ healthFactor: null, healthAvailability: "unavailable" })), true);
});

test("a readable health factor is accepted, with or without the availability field", () => {
  assert.equal(isArcPortfolioData(portfolio()), true);
  const legacy = portfolio();
  delete legacy.lending.healthAvailability;
  assert.equal(isArcPortfolioData(legacy), true, "API builds without healthAvailability still validate");
});

test("a malformed lending block is still refused", () => {
  const missing = portfolio();
  delete missing.lending.healthFactor;
  assert.equal(isArcPortfolioData(missing), false, "healthFactor must be present (string or null)");
  assert.equal(isArcPortfolioData(portfolio({ healthFactor: 1.5 })), false);
  assert.equal(isArcPortfolioData(portfolio({ healthAvailability: "maybe" })), false);
  assert.equal(isArcPortfolioData(portfolio({ collateralKLET: null })), false, "only the health factor may be unavailable");
});
