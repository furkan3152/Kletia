// The desk's holdings snapshot: both portfolio response shapes, `usd`
// (never `usdValue`), stale readings and fundedFor.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHoldingsSnapshot,
  formatUsd,
  holdingLabels,
  laneTotals,
  MAX_FALLBACK_ACCOUNTS,
  mostFunded,
  parsePortfolio,
  parsePortfolioBatch,
  readPortfolios,
} from "../state/holdings.ts";

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OBSERVED = "2026-10-14T12:44:03.000Z";

const usdc = (formatted, amount, usd = Number(formatted)) => ({ asset: "usdc", symbol: "USDC", name: "USD Coin", decimals: 6, amount, formatted, usd, verified: true, isNative: false });
const eth = (formatted, amount, usd = null) => ({ asset: "eth", symbol: "ETH", name: "Ether", decimals: 18, amount, formatted, usd, verified: true, isNative: true });

/** The single-account route's body, exactly as `GET /v1/portfolio/{account}` returns it. */
const single = (network, chainRef, holdings) => ({
  account: chainRef.startsWith("solana") ? `${chainRef}:${SOL}` : `${chainRef}:${EVM}`,
  network,
  holdings,
  totalUsd: 999,
  unpricedCount: 0,
  observedAt: OBSERVED,
});

test("the single-account response is read from usd, never usdValue (the EvmLiveBalances bug)", () => {
  const portfolio = parsePortfolio(single("base", "eip155:8453", [
    usdc("120.4", "120400000"),
    { ...eth("0.002", "2000000000000000"), usdValue: 5 },
  ]));
  assert.equal(portfolio.network, "base");
  assert.equal(portfolio.account, `eip155:8453:${EVM}`);
  assert.equal(portfolio.totalUsd, 120.4, "priced holdings only, recomputed from usd");
  assert.equal(portfolio.unpriced, 1, "ETH has usdValue but usd null: unpriced");
  assert.deepEqual(portfolio.top.map((holding) => holding.symbol), ["USDC", "ETH"]);
  assert.equal(portfolio.top[1].usd, null);
  assert.equal(portfolio.stale, false);
  assert.equal(portfolio.observedAt, OBSERVED);
});

test("holdings print exactly as the API formats them, best first by USD then amount; zero balances are dropped", () => {
  const portfolio = parsePortfolio(single("solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", [
    { symbol: "BONK", decimals: 5, amount: "100000000", formatted: "1000", usd: null },
    { symbol: "SOL", decimals: 9, amount: "90000000", formatted: "0.09", usd: 13.5, isNative: true },
    usdc("2", "2000000"),
    { symbol: "JUP", decimals: 6, amount: "5000000000", formatted: "5000", usd: null },
    usdc("0", "0"),
  ]));
  assert.deepEqual(holdingLabels(portfolio), ["0.09 SOL", "2 USDC"]);
  assert.deepEqual(holdingLabels(portfolio, 9), ["0.09 SOL", "2 USDC", "5000 JUP", "1000 BONK"], "unpriced: larger amount first, exact across decimals");
  assert.equal(portfolio.totalUsd, 15.5);
  assert.equal(portfolio.unpriced, 2);
});

test("a portfolio whose account and network disagree, or that is not a portfolio, is rejected; bad holdings are dropped", () => {
  assert.equal(parsePortfolio({ ...single("base", "eip155:8453", []), network: "optimism" }), null);
  assert.equal(parsePortfolio({ account: "not-an-account", holdings: [] }), null);
  assert.equal(parsePortfolio({ account: `eip155:8453:${EVM}` }), null);
  assert.equal(parsePortfolio(null), null);
  const portfolio = parsePortfolio(single("base", "eip155:8453", [
    usdc("1", "1000000"),
    { symbol: "USDC", decimals: 6, amount: "1.5", formatted: "1.5", usd: 1.5 },
    { symbol: "USDC", decimals: 6, amount: "-1", formatted: "-1", usd: 1 },
    { symbol: "X", decimals: 99, amount: "1", formatted: "1", usd: 1 },
    { symbol: "Y", decimals: 6, amount: "1", formatted: "1", usd: Number.NaN },
    { symbol: "Z", decimals: 6, amount: "1", formatted: "1" },
    "junk",
  ]));
  assert.deepEqual(portfolio.top.map((holding) => holding.formatted), ["1"]);
});

test("the batch response keeps successful reads and failures", () => {
  const batch = parsePortfolioBatch({
    portfolios: [
      single("base", "eip155:8453", [usdc("120.4", "120400000")]),
      single("solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", [usdc("2", "2000000")]),
      { account: "broken" },
    ],
    failures: [{ account: `eip155:10:${EVM}`, code: "RPC_UNAVAILABLE", message: "OP Mainnet did not answer." }, { nope: true }],
    observedAt: OBSERVED,
  });
  assert.deepEqual(batch.portfolios.map((portfolio) => portfolio.network), ["base", "solana"]);
  assert.deepEqual(batch.failures, [{ account: `eip155:10:${EVM}`, code: "RPC_UNAVAILABLE", message: "OP Mainnet did not answer." }]);
  assert.equal(batch.observedAt, OBSERVED);
  assert.deepEqual(parsePortfolioBatch({ nope: 1 }), { portfolios: [], failures: [], observedAt: null });
});

test("the snapshot keeps one lane; a failed account keeps its last reading marked stale, an unknown one stays unknown", () => {
  const first = buildHoldingsSnapshot({
    lane: "production",
    portfolios: [
      parsePortfolio(single("base", "eip155:8453", [usdc("120.4", "120400000")])),
      parsePortfolio(single("optimism", "eip155:10", [usdc("3", "3000000")])),
      parsePortfolio(single("arc", "eip155:5042002", [usdc("10", "10000000")])),
    ],
    observedAt: OBSERVED,
  });
  assert.deepEqual(Object.keys(first.byNetwork).sort(), ["base", "optimism"], "the test yard is not mixed into production");
  assert.equal(first.lane, "production");
  const second = buildHoldingsSnapshot({
    lane: "production",
    portfolios: [parsePortfolio(single("base", "eip155:8453", [usdc("100", "100000000")]))],
    failures: [
      { account: `eip155:10:${EVM}`, code: "RPC_UNAVAILABLE", message: "" },
      { account: `eip155:137:${EVM}`, code: "RPC_UNAVAILABLE", message: "" },
    ],
    previous: first,
    observedAt: "2026-10-14T12:45:00.000Z",
  });
  assert.equal(second.byNetwork.base.totalUsd, 100);
  assert.equal(second.byNetwork.base.stale, false);
  assert.equal(second.byNetwork.optimism.stale, true, "OP Mainnet keeps its last reading");
  assert.equal(second.byNetwork.optimism.observedAt, OBSERVED, "with the time it was read");
  assert.equal(second.byNetwork.polygon, undefined, "never read: unknown, not empty");
  assert.ok(Object.isFrozen(second.byNetwork));
});

test("fundedFor lists the networks holding at least the amount, best first, compared exactly", () => {
  const snapshot = buildHoldingsSnapshot({
    lane: "production",
    portfolios: [
      parsePortfolio(single("base", "eip155:8453", [usdc("120.4", "120400000"), eth("0.002", "2000000000000000")])),
      parsePortfolio(single("arbitrum", "eip155:42161", [usdc("24.999999", "24999999")])),
      parsePortfolio(single("ethereum", "eip155:1", [usdc("25", "25000000")])),
      parsePortfolio(single("solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", [usdc("300", "300000000")])),
    ],
    observedAt: OBSERVED,
  });
  assert.deepEqual(snapshot.fundedFor("USDC", "25"), ["solana", "base", "ethereum"], "largest balance first; 24.999999 is not 25");
  assert.deepEqual(snapshot.fundedFor("usdc", "300"), ["solana"], "symbols compare case-insensitively");
  assert.deepEqual(snapshot.fundedFor("ETH", "0.002"), ["base"]);
  assert.deepEqual(snapshot.fundedFor("ETH", "0.0020000000000000001"), [], "more precision than the asset has is never enough");
  assert.deepEqual(snapshot.fundedFor("USDC", "not a number"), []);
  assert.deepEqual(snapshot.fundedFor("WETH", "0"), []);
});

test("lane totals, the most funded network and USD formatting", () => {
  const snapshot = buildHoldingsSnapshot({
    lane: "production",
    portfolios: [
      parsePortfolio(single("base", "eip155:8453", [usdc("120.4", "120400000"), eth("0.002", "2000000000000000", 7.1)])),
      parsePortfolio(single("solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", [usdc("2", "2000000"), { symbol: "BONK", decimals: 5, amount: "1", formatted: "0.00001", usd: null }])),
    ],
    observedAt: OBSERVED,
  });
  assert.deepEqual(laneTotals(snapshot), { totalUsd: 129.5, unpriced: 1 });
  assert.equal(mostFunded(snapshot), "base");
  assert.equal(mostFunded(null), null);
  assert.equal(mostFunded(buildHoldingsSnapshot({ lane: "production", portfolios: [], observedAt: OBSERVED })), null);
  assert.equal(formatUsd(127.5), "$127.50");
  assert.equal(formatUsd(142030.2), "$142,030.20");
  assert.equal(formatUsd(null), null);
  assert.equal(formatUsd(Number.NaN), null);
});

// --- Reading: one batch request, or at most six single reads on an older API ----

const PRODUCTION = [
  `eip155:8453:${EVM}`,
  `eip155:42161:${EVM}`,
  `eip155:1:${EVM}`,
  `eip155:10:${EVM}`,
  `eip155:137:${EVM}`,
  `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`,
];
const portfolioOf = (account) => ({ account, holdings: [usdc("1", "1000000")], observedAt: OBSERVED });

test("one batch request reads every account; duplicates are removed and missing or foreign accounts are never invented", async () => {
  const calls = [];
  const reads = await readPortfolios(
    {
      batch: async (accounts) => {
        calls.push(accounts);
        return {
          portfolios: [portfolioOf(accounts[0]), portfolioOf(accounts[2]), portfolioOf(`eip155:8453:0x000000000000000000000000000000000000dEaD`)],
          failures: [{ account: accounts[1], code: "RPC_UNAVAILABLE", message: "Arbitrum did not answer." }],
          observedAt: OBSERVED,
        };
      },
      single: async () => assert.fail("no single reads when the batch route answers"),
    },
    [...PRODUCTION.slice(0, 4), PRODUCTION[0]],
  );
  assert.deepEqual(calls, [PRODUCTION.slice(0, 4)], "one request, duplicates removed, request order kept");
  assert.equal(reads.source, "batch");
  assert.deepEqual(reads.portfolios.map((portfolio) => portfolio.network), ["base", "ethereum"], "a portfolio nobody asked for is ignored");
  assert.deepEqual(reads.failures.map((failure) => [failure.account.split(":")[1], failure.code]), [["42161", "RPC_UNAVAILABLE"], ["10", "NOT_READ"]]);
  assert.equal(reads.observedAt, OBSERVED);
});

test("an API without the batch route (404) is read one account at a time, at most the six production accounts", async () => {
  const singles = [];
  const reads = await readPortfolios(
    {
      batch: async () => null,
      single: async (account) => {
        singles.push(account);
        if (account.startsWith("eip155:10:")) throw Object.assign(new Error("OP Mainnet did not answer."), { code: "RPC_UNAVAILABLE" });
        if (account.startsWith("eip155:137:")) return { nope: true };
        return portfolioOf(account);
      },
    },
    [...PRODUCTION, `eip155:5042002:${EVM}`],
    { now: () => OBSERVED },
  );
  assert.equal(MAX_FALLBACK_ACCOUNTS, 6);
  assert.deepEqual(singles, PRODUCTION, "six reads, never a seventh");
  assert.equal(reads.source, "per-account");
  assert.deepEqual(reads.portfolios.map((portfolio) => portfolio.network), ["base", "arbitrum", "ethereum", "solana"]);
  assert.deepEqual(reads.failures.map((failure) => [failure.account.split(":")[1], failure.code]), [
    ["10", "RPC_UNAVAILABLE"],
    ["137", "INVALID_RESPONSE"],
    ["5042002", "NOT_READ"],
  ]);
  assert.equal(reads.failures[0].message, "OP Mainnet did not answer.");
});

test("skipBatch goes straight to single reads; any other batch error is thrown so the last snapshot stays", async () => {
  let batchCalls = 0;
  const reads = await readPortfolios({ batch: async () => { batchCalls += 1; return null; }, single: async (account) => portfolioOf(account) }, PRODUCTION.slice(0, 2), { skipBatch: true });
  assert.equal(batchCalls, 0);
  assert.equal(reads.portfolios.length, 2);
  await assert.rejects(
    readPortfolios({ batch: async () => { throw Object.assign(new Error("Rate limit reached."), { code: "RATE_LIMITED", status: 429 }); }, single: async () => assert.fail("no fallback on a 429") }, PRODUCTION),
    /Rate limit reached/u,
  );
  const empty = await readPortfolios({ batch: async () => assert.fail("nothing to read"), single: async () => assert.fail("nothing to read") }, []);
  assert.deepEqual([empty.portfolios, empty.failures, empty.source], [[], [], "batch"]);
});
