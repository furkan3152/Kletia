/**
 * Portfolios over HTTP (console design 4.2 WP-B, journey design 6.7 H5):
 * GET /v1/portfolio?accounts= keeps request order, removes duplicates,
 * reports a failing account in `failures` with 200, refuses 13 accounts
 * and invalid ids (issue path accounts[i]), reads 4 accounts at a time,
 * caches 15 s per account, costs one tier unit plus the per-IP budget of 60
 * account reads a minute (429 after); both routes take positions=true and
 * price gas assets with priceSource. Offline: stubbed chain readers and
 * prices.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/portfolioBatch.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { VenuePosition } from "@kletia/core";
import {
  configurePlatform,
  configurePortfolioReaders,
  configurePreviewPricer,
  PlatformError,
  type AccountPortfolio,
  type AccountPortfolios,
  type RawHolding,
} from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, type CallOptions, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { portfolioReadBudget, PORTFOLIO_ACCOUNT_READS_PER_MINUTE } = await import("../limits.js");

const ETH = "eip155:8453/slip44:60";
const USDC = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FAILING = "0x000000000000000000000000000000000000dEaD";

function account(index: number): string {
  return `eip155:8453:0x${index.toString(16).padStart(40, "0")}`;
}

function holdings(): RawHolding[] {
  return [
    { asset: ETH, symbol: "ETH", name: "Ether", decimals: 18, amount: "2000000000000000", formatted: "0.002", usd: null, verified: true, isNative: true },
    { asset: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, amount: "12500000", formatted: "12.5", usd: 12.5, priceSource: "usd-par", verified: true, isNative: false },
  ];
}

const POSITION: VenuePosition = {
  venue: "base:aave-v3:usdc",
  network: "base",
  protocol: "aave-v3",
  name: "Aave V3 USDC",
  receipt: { asset: "eip155:8453/erc20:0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", symbol: "aBasUSDC", decimals: 6, amount: "5000000", formatted: "5" },
  underlying: { asset: USDC, symbol: "USDC", decimals: 6, amount: "5000000", formatted: "5" },
  rate: null,
  usd: 5,
  apy: 0.04,
  withdrawableNow: null,
  observedAt: "2026-10-14T12:00:00.000Z",
};

let server: TestServer;
let reads: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let positionReads = 0;

function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
  return rawCall<T>(server, method, path, { key: OPERATOR_KEY, ...options });
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configurePlatform({ adapters: null });
  await server.close();
});

beforeEach(() => {
  reads = [];
  inFlight = 0;
  maxInFlight = 0;
  positionReads = 0;
  portfolioReadBudget.reset();
  configurePreviewPricer({ price: async (asset) => (asset === ETH ? 2_500 : null) });
  configurePortfolioReaders({
    holdings: async (accountId, _network, address) => {
      reads.push(accountId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (address.toLowerCase() === FAILING.toLowerCase()) throw new PlatformError("RPC_UNAVAILABLE", "Base RPC did not answer.", 502);
        return holdings();
      } finally {
        inFlight -= 1;
      }
    },
    positions: async (accountId, network) => {
      positionReads += 1;
      return {
        account: accountId,
        network,
        positions: [POSITION],
        unavailable: [{ venue: "base:moonwell:usdc", code: "POSITION_UNAVAILABLE", message: "Not readable yet." }],
        observedAt: "2026-10-14T12:00:00.000Z",
      };
    },
  });
});

afterEach(() => {
  configurePortfolioReaders(null);
  configurePreviewPricer(null);
});

describe("GET /v1/portfolio?accounts=", () => {
  it("keeps request order, removes duplicates and reports a failing account with 200", async () => {
    const failing = `eip155:8453:${FAILING}`;
    const mixedCase = account(0xabc).replace("abc", "ABC");
    const list = [account(0xabc), account(1), failing, mixedCase, account(1), account(2)];
    const reply = await call<AccountPortfolios>("GET", `/portfolio?accounts=${list.join(",")}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.portfolios.map((portfolio) => portfolio.account), [account(0xabc), account(1), account(2)]);
    assert.deepEqual(reply.body.failures, [{ account: failing, code: "RPC_UNAVAILABLE", message: "Base RPC did not answer." }]);
    assert.equal(reads.length, 4, "each unique account read once");
    assert.ok(Date.parse(reply.body.observedAt) > 0);
    assert.equal(reply.headers.get("cache-control"), "no-store");
  });

  it("refuses a missing list, 13 accounts and an invalid id (issue path accounts[i])", async () => {
    assertError(await call("GET", "/portfolio"), 400, "INVALID_REQUEST");
    assertError(await call("GET", "/portfolio?accounts="), 400, "INVALID_REQUEST");
    const thirteen = Array.from({ length: 13 }, (_, index) => account(index + 1)).join(",");
    assertError(await call("GET", `/portfolio?accounts=${thirteen}`), 400, "INVALID_REQUEST");
    const invalid = assertError(await call("GET", `/portfolio?accounts=${account(1)},not-an-account`), 400, "INVALID_REQUEST");
    assert.equal(invalid.error.issues?.[0]?.path, "accounts[1]");
    assert.equal(reads.length, 0, "nothing read for a refused request");
  });

  it("reads at most 4 accounts at a time and caches each account for 15 s", async () => {
    const twelve = Array.from({ length: 12 }, (_, index) => account(index + 1)).join(",");
    const first = await call<AccountPortfolios>("GET", `/portfolio?accounts=${twelve}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.portfolios.length, 12);
    assert.equal(maxInFlight, 4);
    const second = await call<AccountPortfolios>("GET", `/portfolio?accounts=${account(1)},${account(2)}`);
    assert.equal(second.status, 200);
    assert.equal(reads.length, 12, "served from the per-account cache");
  });

  it("costs one tier unit per request plus one unit per account of the per-IP budget (429 after 60)", async () => {
    const before = await rawCall(server, "GET", `/portfolio?accounts=${account(20)}`);
    const after = await rawCall(server, "GET", `/portfolio?accounts=${account(21)},${account(22)},${account(23)}`);
    const remaining = (reply: Reply<unknown>) => Number(/r=(\d+)/u.exec(reply.headers.get("ratelimit") ?? "")?.[1]);
    assert.equal(remaining(before) - remaining(after), 1, "three accounts cost one request of the tier");
    portfolioReadBudget.reset();
    const twelve = Array.from({ length: 12 }, (_, index) => account(index + 100)).join(",");
    for (let spent = 0; spent < PORTFOLIO_ACCOUNT_READS_PER_MINUTE; spent += 12) {
      assert.equal((await call("GET", `/portfolio?accounts=${twelve}`)).status, 200, `after ${spent} reads`);
    }
    const limited = await call("GET", `/portfolio?accounts=${account(1)}`);
    const body = assertError(limited, 429, "RATE_LIMITED");
    assert.match(body.error.message, /portfolio account reads per minute/u);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  it("prices the gas asset with its source and adds positions with positions=true", async () => {
    const reply = await call<AccountPortfolios>("GET", `/portfolio?accounts=${account(1)}&positions=true`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const portfolio = reply.body.portfolios[0] as AccountPortfolio;
    const eth = portfolio.holdings.find((holding) => holding.symbol === "ETH");
    assert.equal(eth?.usd, 5, "0.002 ETH at $2,500");
    assert.equal(eth?.priceSource, "chainlink");
    assert.ok(eth?.pricedAt && Date.parse(eth.pricedAt) > 0);
    assert.equal(portfolio.holdings.find((holding) => holding.symbol === "USDC")?.priceSource, "usd-par");
    assert.equal(portfolio.totalUsd, 17.5);
    assert.equal(portfolio.unpricedCount, 0);
    assert.deepEqual(portfolio.positions, [POSITION]);
    assert.equal(portfolio.positionsUnavailable?.[0]?.code, "POSITION_UNAVAILABLE");
    assert.equal(positionReads, 1);
  });
});

describe("GET /v1/portfolio/{accountId} (H5)", () => {
  it("prices gas assets, labels unpriced holdings and adds positions only when asked", async () => {
    configurePreviewPricer({ price: async () => null });
    const plain = await call<AccountPortfolio>("GET", `/portfolio/${account(1)}`);
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const eth = plain.body.holdings.find((holding) => holding.symbol === "ETH");
    assert.equal(eth?.usd, null, "unpriced, never 0");
    assert.equal(eth?.priceSource, "unpriced");
    assert.equal(eth?.pricedAt, null);
    assert.equal(plain.body.unpricedCount, 1);
    assert.equal("positions" in plain.body, false);
    assert.equal(positionReads, 0);
    configurePreviewPricer({ price: async (asset) => (asset === ETH ? 2_500 : null) });
    const withPositions = await call<AccountPortfolio>("GET", `/portfolio/${account(1)}?positions=true`);
    assert.equal(withPositions.status, 200);
    assert.equal(withPositions.body.holdings.find((holding) => holding.symbol === "ETH")?.usd, 5);
    assert.equal(withPositions.body.positions?.[0]?.venue, "base:aave-v3:usdc");
    assertError(await call("GET", `/portfolio/${account(1)}?positions=maybe`), 400, "INVALID_REQUEST");
  });
});
