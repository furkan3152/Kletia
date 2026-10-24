/**
 * Wallet history over HTTP (docs/platform/data.md): who may read
 * (wallet session over its tracked set, API key over named addresses),
 * tracking opt-in with wallet proofs, transactions with filters, cursor
 * paging and Kletia links, one transaction by id, PnL, the snapshot job and
 * its series, the assistant summary, extras, and the transactions export.
 * Offline: history providers, prices and Kamino from fixtures
 * (historyFixtures.ts); portfolio, lending, perps and order reads stubbed.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/dataHistoryRoutes.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DataPnl, DataPositions, DataSnapshotSeries, DataSummary, DataTracking, DataTransaction, DataTransactionPage, IntentGraph } from "@kletia/core";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { as, evmWallet, signIn, solanaWallet } from "./accountFlows.js";
import { fixtureFetcher } from "./historyFixtures.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configurePortfolioReaders, configurePreviewPricer, getIntentStore } = await import("../../index.js");
const { resetAccountLimiters } = await import("../accounts/handlers.js");
const { MemoryAccountStore, setAccountStore } = await import("../accounts/store.js");
const data = await import("../../data/index.js");
const { dataAddressBudget, dataKeyBudget } = await import("../limits.js");
const { configurePerpsIo } = await import("../../perps/io.js");
const { configureNativeOrderProviders } = await import("../../orders/registry.js");

const ME = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BASE_USDC = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_ETH = "eip155:8453/slip44:60";
let server: TestServer;
/** Two developer keys, issued once (key issuance is limited per address and hour). */
let KEY: { id: string; key: string };
let STRANGER: { id: string; key: string };

async function issueKey(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key;
}

const mount = () => serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));

before(async () => {
  resetEngine();
  server = await mount();
  KEY = await issueKey("history");
  STRANGER = await issueKey("stranger");
  await server.close();
});

after(() => {
  delete process.env.ETHERSCAN_API_KEY;
});

// A fresh router per test: the public tier's per-minute limit (desk sessions carry no key) starts over.
beforeEach(async () => {
  server = await mount();
  resetAccountLimiters();
  setAccountStore(new MemoryAccountStore());
  data.configureDataTrackingStore(new data.MemoryDataTrackingStore());
  data.configureHistoryFetch(fixtureFetcher());
  data.resetHistoricalPrices();
  data.resetTransactionCache();
  data.resetDataCache();
  dataKeyBudget.reset();
  dataAddressBudget.reset();
  process.env.ETHERSCAN_API_KEY = "test-key";
  configurePreviewPricer({ price: async (asset) => (asset === BASE_ETH ? 3_000 : asset === BASE_USDC ? 1 : null) });
  configurePortfolioReaders({
    holdings: async (_account, network) => network === "base"
      ? [{ asset: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, amount: "550000000", formatted: "550", usd: 550, priceSource: "usd-par", verified: true, isNative: false }]
      : [],
    positions: async (account, network) => ({ account, network, positions: [], unavailable: [], observedAt: "2026-10-24T08:00:00.000Z" }),
  });
  data.configureLendingReaders({
    aaveAccount: async () => ({ collateralBase: 0n, debtBase: 0n, healthFactor: 2n ** 256n - 1n }),
    aaveBaseUnit: async () => 100_000_000n,
    cometBorrow: async () => ({ borrowed: 0n, liquidatable: false }),
    kaminoObligations: async () => [],
  });
  data.configureEvmBlockLookup(async (_network, hash) => (hash.endsWith("02") ? 37000200 : null));
  configurePerpsIo({
    json: async () => { throw new Error("offline"); },
    arbitrumCall: async () => { throw new Error("offline"); },
    arbitrumGasPrice: async () => 1n,
    solanaAccounts: async (addresses) => addresses.map(() => null),
    now: () => Date.now(),
  });
  configureNativeOrderProviders([]);
});

afterEach(async () => {
  await server.close();
  delete process.env.ETHERSCAN_API_KEY;
  delete process.env.HELIUS_API_KEY;
  data.configureHistoryFetch(null);
  data.configureLendingReaders(null);
  data.configureEvmBlockLookup(null);
  data.configureDataTrackingStore(null);
  configurePerpsIo(null);
  configureNativeOrderProviders(null);
});

describe("history callers", () => {
  it("needs an API key or a desk wallet session", async () => {
    assertError(await call(server, "GET", `/data/transactions?evm=${ME}`), 401, "DATA_CALLER_REQUIRED");
    assertError(await call(server, "GET", "/data/summary"), 401, "DATA_CALLER_REQUIRED");
  });

  it("refuses a session from another origin and an untracked wallet", async () => {
    const token = await signIn(server, evmWallet());
    assertError(await call(server, "GET", "/data/transactions", { headers: as(token, "https://evil.example") }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
    assertError(await call(server, "GET", "/data/transactions", { headers: as(token) }), 404, "DATA_NOT_TRACKED");
  });
});

describe("tracking", () => {
  it("opts the session wallet in, adds a second wallet by its own sign-in, and opts out", async () => {
    const first = evmWallet();
    const second = solanaWallet();
    const token = await signIn(server, first);
    assert.deepEqual((await call<{ tracking: null }>(server, "GET", "/data/tracking", { headers: as(token) })).body, { tracking: null });
    const created = await call<{ tracking: DataTracking }>(server, "POST", "/data/tracking", { headers: as(token), body: {} });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.tracking.wallets, { evm: [first.address.toLowerCase()].map(() => created.body.tracking.wallets.evm[0]!), solana: [] });
    assertError(await call(server, "POST", "/data/tracking", { headers: as(token), body: { proofs: ["kl_acs_" + "x".repeat(43)] } }), 401, "DATA_PROOF_INVALID");

    const proof = await signIn(server, second);
    const added = await call<{ tracking: DataTracking }>(server, "POST", "/data/tracking", { headers: as(token), body: { proofs: [proof] } });
    assert.equal(added.status, 201);
    assert.deepEqual(added.body.tracking.wallets.solana, [second.address]);
    // The second wallet's own session now reads the same set.
    assert.equal((await call<{ tracking: DataTracking }>(server, "GET", "/data/tracking", { headers: as(proof) })).body.tracking.id, added.body.tracking.id);

    // A wallet belongs to one set: another owner cannot add it.
    const other = await signIn(server, evmWallet());
    assertError(await call(server, "POST", "/data/tracking", { headers: as(other), body: { proofs: [proof] } }), 409, "DATA_WALLET_TRACKED");

    // A member leaves; the creator deletes.
    assert.deepEqual((await call(server, "DELETE", "/data/tracking", { headers: as(proof) })).body, { deleted: false });
    assert.deepEqual((await call(server, "DELETE", "/data/tracking", { headers: as(token) })).body, { deleted: true });
    assert.deepEqual((await call(server, "GET", "/data/tracking", { headers: as(token) })).body, { tracking: null });
  });

  it("is never managed with an API key", async () => {
    const key = KEY.key;
    assertError(await call(server, "POST", "/data/tracking", { key, body: {} }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
  });
});

describe("transactions", () => {
  it("lists the classified history of named addresses for an API key, with coverage per account", async () => {
    const key = KEY.key;
    const reply = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const kinds = reply.body.transactions.map((tx) => tx.kind);
    assert.deepEqual(kinds, ["swap", "failed", "send", "bridge-out", "deposit", "approve", "swap", "receive"]);
    const swap = reply.body.transactions[6]!;
    assert.equal(swap.protocol?.id, "kyberswap");
    assert.equal(swap.legs.find((leg) => leg.asset.symbol === "USDC")!.usdAtTime !== null, true);
    assert.equal(swap.fee?.asset.symbol, "ETH");
    assert.match(swap.fee?.reason ?? "", /L1 data fee/u);
    assert.equal(reply.body.transactions[3]!.protocol?.id, "across");
    assert.ok(reply.body.coverage.every((entry) => entry.status === "ok" && entry.provider === "etherscan"));
    assert.equal(reply.body.cursor, null);
  });

  it("fails closed per account without a provider key, naming the variables", async () => {
    delete process.env.ETHERSCAN_API_KEY;
    const key = KEY.key;
    const reply = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}`, { key });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.transactions.length, 0);
    assert.ok(reply.body.coverage.every((entry) => entry.status === "not-configured" && entry.env?.includes("ETHERSCAN_API_KEY")));
  });

  it("filters by kind, asset and protocol, and pages with a cursor tied to the same filters", async () => {
    const key = KEY.key;
    const swaps = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&kind=swap`, { key });
    assert.deepEqual(swaps.body.transactions.map((tx) => tx.kind), ["swap", "swap"]);
    const usdc = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&asset=usdc&protocol=aave-v3`, { key });
    assert.deepEqual(usdc.body.transactions.map((tx) => tx.kind), ["deposit"]);
    const first = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&limit=3`, { key });
    assert.equal(first.body.transactions.length, 3);
    assert.ok(first.body.cursor);
    const second = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&limit=3&cursor=${first.body.cursor}`, { key });
    assert.deepEqual(second.body.transactions.map((tx) => tx.kind), ["bridge-out", "deposit", "approve"]);
    assertError(await call(server, "GET", `/data/transactions?evm=${ME}&kind=swap&cursor=${first.body.cursor}`, { key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", `/data/transactions?evm=${ME}&kind=teleport`, { key }), 400, "INVALID_REQUEST");
  });

  it("links a transaction to the key's own Kletia intent and receipt, never to another key's", async () => {
    const { key, id: keyId } = KEY;
    const hash = `0x${"0".repeat(63)}2`;
    const graph = { id: `int_${"a".repeat(32)}`, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", status: "completed", request: { accounts: [`eip155:8453:${ME}`] } } as unknown as IntentGraph;
    await getIntentStore().create(graph, { ownerKeyId: keyId });
    await getIntentStore().claimReferences([{ key: `eip155:8453:${hash}`, intentId: graph.id, stepId: "s1" }]);
    const mine = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&kletiaOnly=true`, { key });
    assert.deepEqual(mine.body.transactions.map((tx) => [tx.hash, tx.kletiaIntentId]), [[hash, graph.id]]);
    const theirs = await call<DataTransactionPage>(server, "GET", `/data/transactions?evm=${ME}&kletiaOnly=true`, { key: STRANGER.key });
    assert.equal(theirs.body.transactions.length, 0);
  });

  it("opens one transaction by id at its block, and 404s one that is not there", async () => {
    const key = KEY.key;
    const id = `base:0x${"0".repeat(63)}2`;
    const reply = await call<{ transaction: DataTransaction }>(server, "GET", `/data/transactions/${id}?evm=${ME}`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.transaction.kind, "swap");
    assertError(await call(server, "GET", `/data/transactions/base:0x${"0".repeat(63)}9?evm=${ME}`, { key }), 404, "DATA_TRANSACTION_NOT_FOUND");
  });

  it("serves a tracked set to its session, and exports the page as CSV, one row per leg", async () => {
    const wallet = evmWallet();
    const token = await signIn(server, wallet);
    await call(server, "POST", "/data/tracking", { headers: as(token), body: {} });
    const page = await call<DataTransactionPage>(server, "GET", "/data/transactions", { headers: as(token) });
    assert.equal(page.status, 200);
    assert.equal(page.body.transactions.length, 8);
    assert.ok(page.body.transactions.every((tx) => tx.account.toLowerCase().endsWith(wallet.address.toLowerCase())));
    const csv = await call<string>(server, "GET", "/data/export?dataset=transactions&format=csv", { headers: as(token) });
    assert.equal(csv.status, 200);
    const lines = (csv.body as string).trim().split("\r\n");
    assert.ok(lines[0]!.startsWith("time,network,hash,account,kind"));
    assert.equal(lines.length, 1 + 11, "8 transactions: three with two legs, the approve and the failed one as one row without legs");
  });
});

describe("pnl, snapshots, summary and extras", () => {
  it("estimates FIFO PnL by asset with coverage", async () => {
    const key = KEY.key;
    const reply = await call<DataPnl>(server, "GET", `/data/pnl?evm=${ME}&period=all`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.method, "fifo");
    assert.equal(reply.body.estimate, true);
    const usdc = reply.body.assets.find((asset) => asset.key === "USDC")!;
    assert.ok(usdc.openQuantity > 0);
    assert.equal(typeof reply.body.totals.complete, "boolean");
    assertError(await call(server, "GET", `/data/pnl?evm=${ME}&period=1y`, { key }), 400, "INVALID_REQUEST");
  });

  it("writes one point an hour per tracked set, idempotently, and serves the series", async () => {
    const wallet = evmWallet();
    const token = await signIn(server, wallet);
    const opted = await call(server, "POST", "/data/tracking", { headers: as(token), body: {} });
    assert.equal(opted.status, 201, JSON.stringify(opted.body));
    const store = data.dataTrackingStore();
    const hour = Date.parse("2026-10-24T08:00:00.000Z");
    const read = async () => ({ totals: { net: { usd: 550, source: "kletia" as const, asOf: null }, complete: true } as never, asOf: "" });
    assert.deepEqual(await data.runSnapshotPass(hour + 60_000, store, read), { read: 1, written: 1, skipped: 0 });
    assert.deepEqual(await data.runSnapshotPass(hour + 120_000, store, read), { read: 0, written: 0, skipped: 1 }, "the same hour is not read twice");
    const failing = async () => { throw new Error("rpc down"); };
    assert.deepEqual(await data.runSnapshotPass(hour + 3_600_000, store, failing), { read: 1, written: 0, skipped: 0 }, "a failed read writes nothing");
    const later = async () => ({ totals: { net: { usd: 600, source: "kletia" as const, asOf: null }, complete: true } as never, asOf: "" });
    await data.runSnapshotPass(hour + 3_660_000, store, later);
    const series = await call<DataSnapshotSeries>(server, "GET", "/data/snapshots?range=all", { headers: as(token) });
    assert.equal(series.status, 200, JSON.stringify(series.body));
    assert.equal(series.body.tracked, true);
    assert.deepEqual(series.body.points.map((point) => point.usd), [600], "one daily point, the latest reading of the day");
    const tracking = (await data.trackingOf({ walletKind: "evm", address: wallet.address }))!;
    assert.deepEqual((await store.snapshots(tracking.id, "h", null)).map((point) => point.usd), [550, 600], "one point per hour");
    const key = KEY.key;
    const untracked = await call<DataSnapshotSeries>(server, "GET", `/data/snapshots?evm=${ME}`, { key });
    assert.equal(untracked.body.tracked, false);
    assert.equal(untracked.body.points.length, 0);
  });

  it("summarizes totals, risks, activity and sources for an assistant", async () => {
    const key = KEY.key;
    const reply = await call<{ summary: DataSummary }>(server, "GET", `/data/summary?evm=${ME}`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const { summary } = reply.body;
    assert.equal(summary.totals.netUsd, 550);
    assert.equal(summary.activity.last30d, 8);
    assert.equal(summary.activity.byKind.swap, 2);
    assert.ok(summary.sources.includes("etherscan"));
    assert.ok(Array.isArray(summary.risks));
    assert.equal(summary.pnl.estimate, true);
  });

  it("adds perps, orders, automations and agent spend with reasons when asked", async () => {
    const key = KEY.key;
    const reply = await call<DataPositions>(server, "GET", `/data/positions?evm=${ME}&extras=true`, { key });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const extras = reply.body.extras!;
    assert.equal(extras.perps.rows.length, 0);
    assert.ok(extras.perps.reason, "unreadable perps venues are named, never shown as no positions");
    assert.equal(extras.orders.rows.length, 0);
    assert.equal(extras.automations.reason, null);
    assert.equal(extras.agentSpend.reason, null);
    const plain = await call<DataPositions>(server, "GET", `/data/positions?evm=${ME}`, { key: OPERATOR_KEY });
    assert.equal(plain.body.extras, undefined);
  });
});
