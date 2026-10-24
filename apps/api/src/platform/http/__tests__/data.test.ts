/**
 * Data API (docs/platform/data.md): aggregation math (net = wallet +
 * positions - debt, staking tokens counted once, allocation shares), null
 * with a reason for unpriced and unread values (never 0), lending health
 * warnings, the snapshot estimates, history of the calling key, market
 * yields, prices and status, the CSV / JSON export, validation and the data
 * budget. Offline: stubbed portfolio, lending, price, adapter and health
 * readers.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/data.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { CHAINS, formatAssetId, type IntentGraph, type NetworkKey, type VenuePosition, type YieldVenue } from "@kletia/core";
import { configurePlatform, configurePortfolioReaders, configurePreviewPricer, getIntentStore, PlatformError, type RawHolding } from "../../index.js";
import type { ProtocolAdapter } from "../../engine/adapters/types.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import {
  configureLendingReaders,
  configureRouteStatsSource,
  readDataPortfolio,
  resetDataCache,
  resetValueSnapshots,
} from "../../data/index.js";
import { recordValue, valueChanges, walletSetKey } from "../../data/snapshots.js";
import { parseWalletSet } from "../../data/wallets.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, type CallOptions, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { configureHealthProbe, createPlatformRouter, platformErrorHandler, PLATFORM_ROUTES } = await import("../index.js");
const { dataAddressBudget, dataKeyBudget } = await import("../limits.js");

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FAILING_SOL = "3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQq9uzBDy1E";
const BASE_ETH = "eip155:8453/slip44:60";
const BASE_USDC = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const JITOSOL = formatAssetId(CHAINS.solana, "token", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const MYSTERY = formatAssetId(CHAINS.solana, "token", "So11111111111111111111111111111111111111112");

const AAVE_USDC: VenuePosition = {
  venue: "base:aave-v3:usdc",
  network: "base",
  protocol: "aave-v3",
  name: "Aave V3 USDC",
  receipt: { asset: "eip155:8453/erc20:0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", symbol: "aBasUSDC", decimals: 6, amount: "50000000", formatted: "50" },
  underlying: { asset: BASE_USDC, symbol: "USDC", decimals: 6, amount: "50000000", formatted: "50" },
  rate: null,
  usd: 50,
  apy: 0.04,
  withdrawableNow: null,
  observedAt: "2026-10-23T12:00:00.000Z",
};

function holdingsFor(network: NetworkKey, address: string): RawHolding[] {
  if (network === "base") {
    return [
      { asset: BASE_ETH, symbol: "ETH", name: "Ether", decimals: 18, amount: "100000000000000000", formatted: "0.1", usd: null, verified: true, isNative: true },
      { asset: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, amount: "100000000", formatted: "100", usd: 100, priceSource: "usd-par", verified: true, isNative: false },
    ];
  }
  if (network === "solana") {
    if (address === FAILING_SOL) throw new PlatformError("RPC_UNAVAILABLE", "Solana RPC did not answer.", 502);
    return [
      { asset: JITOSOL, symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9, amount: "2000000000", formatted: "2", usd: 400, priceSource: "jupiter", verified: true, isNative: false },
      { asset: MYSTERY, symbol: "MYST", name: "Mystery", decimals: 9, amount: "5000000000", formatted: "5", usd: null, verified: false, isNative: false },
    ];
  }
  return [];
}

let server: TestServer;

function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
  // The operator key keeps the many reads here under the tier limit; `key: ""` sends none.
  return rawCall<T>(server, method, path, { key: OPERATOR_KEY, ...options });
}

async function developerKey(name = "data-dashboard"): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>("POST", "/keys", { key: "", body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key;
}

function intent(id: string, createdAt: string, address: string, status: IntentGraph["status"] = "completed"): IntentGraph {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status,
    request: { text: "swap 1 SOL to USDC", accounts: [`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${address}`] },
    summary: { title: "Swap 1 SOL to USDC", networks: ["solana"], inputs: [], outputs: [], signaturesRequired: 1, crossNetwork: false },
  } as unknown as IntentGraph;
}

function stubAdapter(protocol: "jupiter-lend" | "kamino", apy: number | null | Error): ProtocolAdapter {
  return {
    id: protocol,
    protocols: [protocol],
    label: protocol,
    supports: () => false,
    plan: async () => { throw new Error("not used"); },
    prepare: async () => { throw new Error("not used"); },
    verify: async () => { throw new Error("not used"); },
    venueCapacity: async (venue: YieldVenue) => {
      if (apy instanceof Error) throw apy;
      return { venue: venue.id, capRemaining: null, exitLiquidity: null, paused: false, frozen: false, shareRate: null, observedAt: "2026-10-23T12:00:00.000Z", apy };
    },
  } as unknown as ProtocolAdapter;
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configurePlatform({ adapters: null });
  configureHealthProbe(null);
  await server.close();
});

beforeEach(() => {
  resetDataCache();
  resetValueSnapshots();
  dataKeyBudget.reset();
  dataAddressBudget.reset();
  configurePreviewPricer({ price: async (asset) => (asset === BASE_ETH ? 2_500 : asset === BASE_USDC ? 1 : null) });
  configurePortfolioReaders({
    holdings: async (_account, network, address) => holdingsFor(network, address),
    positions: async (account, network) => ({
      account,
      network,
      positions: network === "base" ? [AAVE_USDC] : [],
      unavailable: network === "solana" ? [{ venue: "solana:kamino:usdc", code: "POSITION_UNAVAILABLE", message: "Kamino obligations are not listed yet." }] : [],
      observedAt: "2026-10-23T12:00:00.000Z",
    }),
  });
  configureLendingReaders({
    aaveAccount: async (network) => network === "base"
      ? { collateralBase: 5_000_000_000n, debtBase: 3_000_000_000n, healthFactor: 1_300_000_000_000_000_000n }
      : { collateralBase: 0n, debtBase: 0n, healthFactor: 2n ** 256n - 1n },
    aaveBaseUnit: async () => 100_000_000n,
    cometBorrow: async () => ({ borrowed: 0n, liquidatable: false }),
    kaminoObligations: async () => [],
  });
});

afterEach(() => {
  configurePortfolioReaders(null);
  configurePreviewPricer(null);
  configureLendingReaders(null);
  configureRouteStatsSource(null);
});

describe("data portfolio", () => {
  it("adds wallet and positions, subtracts debt, and counts staking tokens once", async () => {
    const reply = await call<{ portfolio: import("@kletia/core").DataPortfolio }>("GET", `/data/portfolio?evm=${EVM}&solana=${SOL}`);
    assert.equal(reply.status, 200);
    const { portfolio } = reply.body;
    assert.equal(portfolio.accounts.length, 6, "five EVM production networks and Solana");
    // Base: ETH 0.1 x 2500 = 250 plus USDC 100 (the other EVM networks are empty); Solana: JitoSOL 400, MYST unpriced.
    assert.equal(portfolio.totals.wallet.usd, 750);
    assert.equal(portfolio.totals.positions.usd, 50);
    assert.equal(portfolio.totals.debt.usd, 30);
    assert.equal(portfolio.totals.net.usd, 770);
    const staking = portfolio.positions.find((position) => position.kind === "staking");
    assert.equal(staking?.protocol, "jito");
    assert.equal(staking?.inWallet, true);
    const debt = portfolio.positions.find((position) => position.kind === "borrow");
    assert.equal(debt?.value.source, "aave-oracle");
    assert.equal(debt?.amount, null);
  });

  it("keeps unpriced values null with a reason and marks the totals partial", async () => {
    const { body } = await call<{ portfolio: import("@kletia/core").DataPortfolio }>("GET", `/data/portfolio?solana=${SOL}`);
    const mystery = body.portfolio.holdings.find((holding) => holding.symbol === "MYST");
    assert.equal(mystery?.value.usd, null);
    assert.match(mystery?.value.reason ?? "", /price/u);
    assert.equal(body.portfolio.totals.unpriced, 1);
    assert.equal(body.portfolio.totals.complete, false);
    assert.match(body.portfolio.totals.net.reason ?? "", /^Partial/u);
    assert.ok(body.portfolio.failures.some((failure) => failure.code === "POSITION_UNAVAILABLE"));
  });

  it("reports an unreadable account as a failure and its value as unknown, not zero", async () => {
    const { body } = await call<{ portfolio: import("@kletia/core").DataPortfolio }>("GET", `/data/portfolio?solana=${FAILING_SOL}`);
    assert.ok(body.portfolio.failures.some((failure) => failure.code === "RPC_UNAVAILABLE"));
    assert.equal(body.portfolio.totals.wallet.usd, null);
    assert.equal(body.portfolio.totals.net.usd, null);
    assert.ok(body.portfolio.totals.net.reason);
  });

  it("splits allocation by network, asset and protocol with shares of the priced gross value", async () => {
    const { body } = await call<{ portfolio: import("@kletia/core").DataPortfolio }>("GET", `/data/portfolio?evm=${EVM}&solana=${SOL}`);
    const { byNetwork, byAsset, byProtocol } = body.portfolio.allocation;
    assert.deepEqual(byNetwork.map((slice) => [slice.key, slice.usd]), [["base", 400], ["solana", 400]]);
    assert.equal(byNetwork.reduce((sum, slice) => sum + slice.share, 0), 1);
    assert.deepEqual(byAsset.map((slice) => slice.key), ["JITOSOL", "ETH", "USDC"]);
    assert.equal(byAsset.find((slice) => slice.key === "USDC")?.usd, 150);
    assert.deepEqual(byProtocol.map((slice) => slice.key), ["jito", "wallet", "aave-v3"]);
  });

  it("flags a health factor under 1.5 as a warning and leaves markets without debt out", async () => {
    const { body } = await call<{ portfolio: import("@kletia/core").DataPortfolio }>("GET", `/data/portfolio?evm=${EVM}&solana=${SOL}`);
    const loans = body.portfolio.health.filter((row) => row.protocol === "aave-v3");
    assert.equal(loans.length, 1);
    assert.equal(loans[0]?.healthFactor, 1.3);
    assert.equal(loans[0]?.status, "warning");
    assert.ok(body.portfolio.health.every((row) => row.status !== "no-debt"));
    // Kamino obligations without debt are left out like any market without a loan.
    assert.equal(body.portfolio.health.find((row) => row.protocol === "kamino"), undefined);
  });

  it("starts the estimates at the first reading and labels them", async () => {
    const set = parseWalletSet({ evm: EVM });
    const first = await readDataPortfolio(set);
    assert.equal(first.pnl.usd, null);
    assert.equal(first.pnl.estimate, true);
    assert.match(first.change24h.reason ?? "", /24 hours/u);
  });

  it("refuses requests without wallets, with too many or malformed addresses, and a bad lane", async () => {
    assertError(await call("GET", "/data/portfolio"), 400, "INVALID_REQUEST");
    assertError(await call("GET", `/data/portfolio?evm=${EVM},0x${"1".repeat(40)},0x${"2".repeat(40)}`), 400, "INVALID_REQUEST");
    assertError(await call("GET", "/data/portfolio?evm=0x123"), 400, "INVALID_REQUEST");
    assertError(await call("GET", `/data/portfolio?evm=${EVM}&lane=moon`), 400, "INVALID_REQUEST");
  });

  it("spends one unit of the data budget per account (60 a minute per address without a key)", async () => {
    // One EVM address on the production lane is five accounts: twelve reads spend 60 units.
    for (let index = 0; index < 12; index += 1) assert.equal((await call("GET", `/data/positions?evm=${EVM}`, { key: "" })).status, 200);
    const refused = assertError(await call("GET", `/data/positions?evm=${EVM}`, { key: "" }), 429, "RATE_LIMITED");
    assert.match(refused.error.message, /data reads per minute/u);
  });
});

describe("value snapshots", () => {
  it("compares with the reading closest to 24 hours ago and with the first reading", () => {
    const key = walletSetKey({ evm: [EVM], solana: [], lane: "production" });
    const start = Date.parse("2026-10-20T00:00:00Z");
    recordValue(key, 1_000, start);
    recordValue(key, 1_100, start + 10 * 60_000); // within 20 minutes: not kept
    recordValue(key, 1_200, start + 23 * 3_600_000);
    const now = start + 47 * 3_600_000;
    const { change24h, pnl } = valueChanges(key, 1_500, now);
    assert.equal(change24h.usd, 300);
    assert.equal(change24h.pct, 0.25);
    assert.equal(change24h.since, new Date(start + 23 * 3_600_000).toISOString());
    assert.equal(pnl.usd, 500);
    assert.equal(pnl.pct, 0.5);
    assert.equal(valueChanges(key, null, now).pnl.usd, null);
    assert.equal(valueChanges(key, 900, start + 72 * 3_600_000).change24h.usd, null, "no reading within two hours of a day ago");
  });

  it("keys a wallet set independent of order and EVM case", () => {
    assert.equal(
      walletSetKey({ evm: [EVM, `0x${"a".repeat(40)}`], solana: [SOL], lane: "production" }),
      walletSetKey({ evm: [`0x${"A".repeat(40)}`, EVM.toLowerCase()], solana: [SOL], lane: "production" }),
    );
  });
});

describe("data history", () => {
  it("needs an API key and lists the key's intents, receipts and links newest first, filtered by wallet", async () => {
    assertError(await call("GET", "/data/history", { key: "" }), 401, "API_KEY_REQUIRED");
    const owner = await developerKey();
    const store = getIntentStore();
    await store.create(intent("int_data_a", "2026-10-21T10:00:00.000Z", SOL), { ownerKeyId: owner.id });
    await store.create(intent("int_data_b", "2026-10-22T10:00:00.000Z", FAILING_SOL, "executing"), { ownerKeyId: owner.id });
    const all = await call<import("@kletia/core").DataHistory>("GET", "/data/history", { key: owner.key });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.entries.map((entry) => entry.id), ["int_data_b", "int_data_a"]);
    assert.equal(all.body.filtered, false);
    const mine = await call<import("@kletia/core").DataHistory>("GET", `/data/history?solana=${SOL}`, { key: owner.key });
    assert.deepEqual(mine.body.entries.map((entry) => entry.id), ["int_data_a"]);
    assert.equal(mine.body.filtered, true);
    const other = await developerKey("someone-else");
    assert.deepEqual((await call<import("@kletia/core").DataHistory>("GET", "/data/history", { key: other.key })).body.entries, []);
  });
});

describe("data markets", () => {
  it("lists yields best first, with unread rates null and a reason, and a deposit sentence", async () => {
    configurePlatform({ adapters: [stubAdapter("jupiter-lend", 0.061), stubAdapter("kamino", new PlatformError("RPC_UNAVAILABLE", "Kamino did not answer.", 502))] });
    try {
      const reply = await call<import("@kletia/core").DataYields>("GET", "/data/markets/yields?network=solana&asset=USDC");
      assert.equal(reply.status, 200);
      const [first, second] = reply.body.yields;
      assert.equal(first?.venue, "solana:jupiter-lend:usdc");
      assert.equal(first?.apy, 0.061);
      assert.equal(first?.depositText, "Deposit [EDIT AMOUNT] USDC into Jupiter Lend USDC on Solana");
      assert.equal(second?.protocol, "kamino");
      assert.equal(second?.apy, null);
      assert.ok(second?.reason);
      assert.ok(reply.body.failures.some((failure) => failure.subject === second?.venue));
    } finally {
      configurePlatform({ adapters: null });
    }
  });

  it("prices symbols with their source and leaves unknown symbols null with a reason", async () => {
    const reply = await call<import("@kletia/core").DataPrices>("GET", "/data/markets/prices?symbols=ETH,USDC,NOPE&network=base");
    assert.equal(reply.status, 200);
    const [eth, usdc, nope] = reply.body.prices;
    assert.equal(eth?.value.usd, 2_500);
    assert.equal(usdc?.value.source, "usd-par");
    assert.equal(nope?.value.usd, null);
    assert.ok(nope?.value.reason);
    assertError(await call("GET", "/data/markets/prices?symbols=a%20b"), 400, "INVALID_REQUEST");
  });

  it("reports network status and says when route statistics are not recorded", async () => {
    configureHealthProbe(async (network) => ({ network, chain: CHAINS[network].id, name: CHAINS[network].name, environment: CHAINS[network].environment, ok: network !== "polygon", latencyMs: 12, height: "99" }));
    resetDataCache();
    const reply = await call<import("@kletia/core").DataMarketStatus>("GET", "/data/markets/status");
    assert.equal(reply.body.networks.find((row) => row.network === "polygon")?.ok, false);
    assert.equal(reply.body.routes, null);
    assert.ok(reply.body.routesReason);
    configureRouteStatsSource(() => [{ venue: "across", network: "base", destination: "arbitrum", attempts: 4, p50Ms: 300, p95Ms: 900, failureRate: 0.25, rateLimited: 0, breaker: "closed" }]);
    resetDataCache();
    const withRoutes = await call<import("@kletia/core").DataMarketStatus>("GET", "/data/markets/status");
    assert.equal(withRoutes.body.routes?.[0]?.venue, "across");
  });
});

describe("data export", () => {
  it("downloads holdings as CSV with unknown values as empty cells", async () => {
    const reply = await call<string>("GET", `/data/export?dataset=holdings&solana=${SOL}`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type") ?? "", /^text\/csv/u);
    assert.match(reply.headers.get("content-disposition") ?? "", /attachment; filename="kletia-holdings-\d{4}-\d{2}-\d{2}\.csv"/u);
    const lines = reply.body.trimEnd().split("\r\n");
    assert.equal(lines[0], "account,network,asset,symbol,amount,usd,source,as_of,reason");
    const mystery = lines.find((line) => line.includes(",MYST,"));
    assert.match(mystery ?? "", /,5,,unpriced,,No price source covers this asset\.$/u);
  });

  it("exports positions as JSON and history only with a key", async () => {
    const json = await call<{ positions: unknown[] }>("GET", `/data/export?dataset=positions&format=json&evm=${EVM}`);
    assert.equal(json.status, 200);
    assert.ok(Array.isArray(json.body.positions));
    assertError(await call("GET", "/data/export?dataset=history", { key: "" }), 401, "API_KEY_REQUIRED");
    assertError(await call("GET", `/data/export?dataset=nope&evm=${EVM}`), 400, "INVALID_REQUEST");
  });
});

describe("data routes", () => {
  it("are all open to publishable keys except tracking, and only history requires a key", () => {
    const routes = PLATFORM_ROUTES.filter((route) => route.path.startsWith("/data/"));
    assert.equal(routes.length, 15);
    const reads = routes.filter((route) => route.path !== "/data/tracking");
    assert.ok(reads.every((route) => route.method === "get" && route.publishable === true));
    // Tracking takes a desk wallet session only: no key of any kind manages it.
    assert.ok(routes.filter((route) => route.path === "/data/tracking").every((route) => route.publishable === undefined && route.auth === "public"));
    assert.deepEqual(routes.filter((route) => route.auth === "key").map((route) => route.path), ["/data/history"]);
  });
});
