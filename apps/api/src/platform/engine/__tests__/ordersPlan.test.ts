/**
 * planNativeOrder: the typed entry point the sentence reader calls, for the
 * three sentence shapes it serves, network inference, protocol choice,
 * refusals with per-field issues, and exact amount rounding (a seller never
 * receives less, a buyer never pays more than the stated price).
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/ordersPlan.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlatformError } from "../../errors.js";
import { planAmounts, planNativeOrder, priceUnits, type NativeOrderInput } from "../../orders/plan.js";

const NOW = 1_792_771_200;

function refused(input: NativeOrderInput, code: string, path?: string): PlatformError {
  try {
    planNativeOrder(input, NOW);
  } catch (error) {
    const platform = error as PlatformError;
    assert.equal(platform.code, code);
    if (path) assert.ok(platform.issues?.some((issue) => issue.path === path), `issue at ${path}: ${JSON.stringify(platform.issues)}`);
    return platform;
  }
  assert.fail(`expected ${code}`);
}

describe("planNativeOrder sentence shapes", () => {
  it('"sell 1 ETH at 4000" asks for the network (ETH and USDC are on three CoW networks)', () => {
    const error = refused({ kind: "limit", sell: "ETH", buy: "USDC", amount: "1", price: "4000" }, "ORDER_NETWORK_REQUIRED");
    assert.deepEqual(error.details?.candidates, ["ethereum", "arbitrum", "base"]);
    const plan = planNativeOrder({ kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", network: "base" }, NOW);
    assert.deepEqual(
      { protocol: plan.protocol, mechanism: plan.mechanism, network: plan.network, amountIn: plan.amountIn, price: plan.price },
      { protocol: "cow-protocol", mechanism: "limit", network: "base", amountIn: "sell", price: "4000" },
    );
  });

  it('"buy SOL with 500 USDC over 10 days" is a daily Jupiter Recurring DCA on Solana', () => {
    const plan = planNativeOrder({ kind: "dca", sell: "USDC", buy: "SOL", amount: "500", period: "day", count: 10 }, NOW);
    assert.deepEqual(
      { protocol: plan.protocol, mechanism: plan.mechanism, network: plan.network, periodSeconds: plan.periodSeconds, count: plan.count },
      { protocol: "jupiter-recurring", mechanism: "recurring", network: "solana", periodSeconds: 86_400, count: 10 },
    );
  });

  it('"limit buy 1000 JUP at 0.8" counts the amount in JUP and is a Jupiter Trigger order', () => {
    const plan = planNativeOrder({ kind: "limit", sell: "USDC", buy: "JUP", amount: "1000", amountIn: "buy", price: "0.8" }, NOW);
    assert.equal(plan.protocol, "jupiter-trigger");
    assert.deepEqual(planAmounts(plan, 6, 6), { sellAmount: 800_000_000n, buyAmount: 1_000_000_000n });
  });

  it("a DCA on an EVM network is a CoW TWAP", () => {
    const plan = planNativeOrder({ kind: "dca", sell: "USDC", buy: "WETH", amount: "1000", period: 3_600, count: 4, network: "arbitrum" }, NOW);
    assert.deepEqual([plan.protocol, plan.mechanism], ["cow-protocol", "twap"]);
  });
});

describe("planNativeOrder refusals", () => {
  it("lists every invalid field", () => {
    const error = refused({ kind: "limit", sell: "USDC", buy: "usdc", amount: "-1", network: "solana" } as NativeOrderInput, "ORDER_INVALID");
    assert.deepEqual(error.issues?.map((issue) => issue.path).sort(), ["amount", "buy", "price"]);
  });

  it("keeps DCA and limit fields apart", () => {
    refused({ kind: "limit", sell: "USDC", buy: "SOL", amount: "1", price: "1", count: 3 }, "ORDER_INVALID", "period");
    refused({ kind: "dca", sell: "USDC", buy: "SOL", amount: "100", period: "fortnight" as never, count: 2 }, "ORDER_INVALID", "period");
    refused({ kind: "dca", sell: "USDC", buy: "SOL", amount: "100", period: "day", count: 1 }, "ORDER_INVALID", "count");
    refused({ kind: "dca", sell: "USDC", buy: "SOL", amount: "100", period: "day", count: 2, amountIn: "buy" }, "ORDER_INVALID", "amountIn");
    refused({ kind: "limit", sell: "USDC", buy: "SOL", amount: "1", price: "1", expiresAt: NOW - 1 }, "ORDER_INVALID", "expiresAt");
  });

  it("names unsupported networks and asset pairs", () => {
    assert.equal(refused({ kind: "limit", sell: "USDC", buy: "WETH", amount: "1", price: "1", network: "polygon" }, "ORDER_UNSUPPORTED").details?.reason, "network");
    assert.equal(refused({ kind: "limit", sell: "SOL", buy: "WETH", amount: "1", price: "1" }, "ORDER_UNSUPPORTED").details?.reason, "assets");
  });

  it("accepts ISO expiries within a year", () => {
    assert.equal(planNativeOrder({ kind: "limit", sell: "USDC", buy: "SOL", amount: "1", price: "1", expiresAt: new Date((NOW + 60) * 1000).toISOString() }, NOW).expiresAt, NOW + 60);
  });
});

describe("order amounts", () => {
  it("rounds the seller's minimum up and the buyer's spend down", () => {
    // 1 WETH (18) at 4000.0000005 USDC (6): 4000.0000005 -> 4000000001 base units (up).
    assert.equal(priceUnits(10n ** 18n, 18, "4000.0000005", 6, "up"), 4_000_000_001n);
    assert.equal(priceUnits(10n ** 18n, 18, "4000.0000005", 6, "down"), 4_000_000_000n);
    const plan = planNativeOrder({ kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000.0000005", network: "base" }, NOW);
    assert.equal(planAmounts(plan, 18, 6).buyAmount, 4_000_000_001n);
  });

  it("refuses more decimals than the asset has and amounts that round to zero", () => {
    const plan = planNativeOrder({ kind: "limit", sell: "USDC", buy: "SOL", amount: "1.0000001", price: "1" }, NOW);
    assert.throws(() => planAmounts(plan, 6, 9), (error: unknown) => (error as PlatformError).code === "ORDER_INVALID");
    const tiny = planNativeOrder({ kind: "limit", sell: "USDC", buy: "SOL", amount: "1", amountIn: "buy", price: "0.0000000001" }, NOW);
    assert.throws(() => planAmounts(tiny, 6, 9), (error: unknown) => (error as PlatformError).code === "ORDER_INVALID");
  });
});
