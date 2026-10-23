/**
 * The perps service on recorded venue data: listing, positions, the scorer
 * behind planPerpsIntent, prepare for GMX and Hyperliquid, and every guard
 * (disabled venue, rule book, leverage caps, collateral minimums, stale
 * prices, wrong network, missing position).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectivePerps, GMX_V2_ARBITRUM, type PerpsStep } from "@kletia/core";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { GMX_EXCHANGE_ROUTER_ABI, GMX_READER_ABI } from "../../perps/gmx.js";
import { hyperliquidActionHash } from "../../perps/hyperliquid.js";
import { listPerpsMarkets, planPerpsIntent, preparePerps, quotePerps, readPerpsPositions, submitPerps } from "../../perps/service.js";
import { fixtureIo, GMX_FIXTURE, HL_FIXTURE } from "./perpsHarness.js";

const EVM = "0x1111111111111111111111111111111111111111";
const HOLDER = `eip155:42161:${GMX_FIXTURE.account}`;
const code = (expected: string, pattern?: RegExp) => (error: { code?: string; message: string }) => error.code === expected && (!pattern || pattern.test(error.message));

/** Reader.getAccountPositions of EVM answering "no positions". */
const NO_GMX_POSITIONS = {
  [`${GMX_V2_ARBITRUM.reader.toLowerCase()}:${encodeFunctionData({ abi: GMX_READER_ABI, functionName: "getAccountPositions", args: [getAddress(GMX_V2_ARBITRUM.dataStore), getAddress(EVM), 0n, 100n] })}`]:
    encodeFunctionResult({ abi: GMX_READER_ABI, functionName: "getAccountPositions", result: [] }),
};

const typedSteps = (steps: readonly PerpsStep[]) => steps.filter((step): step is Extract<PerpsStep, { kind: "typed-data" }> => step.kind === "typed-data");

describe("perps listing and positions", () => {
  it("lists GMX and Hyperliquid markets, none for halted Drift, and reports an unreadable venue instead of guessing", async () => {
    const view = await listPerpsMarkets(fixtureIo());
    assert.deepEqual([...new Set(view.markets.map((market) => market.venue))], ["gmx-v2", "hyperliquid"]);
    assert.deepEqual(view.unavailable, []);
    assert.equal(view.venues.find((venue) => venue.id === "drift-v2")!.enabled, false);
    const stale = await listPerpsMarkets(fixtureIo({ now: GMX_FIXTURE.now + 600_000 }));
    assert.deepEqual(stale.unavailable.map((entry) => [entry.venue, entry.code]), [["gmx-v2", "PERPS_PRICE_UNAVAILABLE"]]);
    assert.ok(stale.markets.every((market) => market.venue === "hyperliquid"));
  });

  it("reads GMX and Hyperliquid positions of an EVM account, Drift for a Solana one", async () => {
    const evm = await readPerpsPositions(HOLDER, fixtureIo());
    assert.equal(evm.positions.length, 1);
    assert.equal(evm.positions[0]!.venue, "gmx-v2");
    assert.ok(evm.positions[0]!.liquidationPrice !== null && evm.positions[0]!.unrealizedPnlUsd !== null);
    const user = HL_FIXTURE.clearinghouseState.user;
    const hl = await readPerpsPositions(`eip155:42161:${user}`, fixtureIo({ hyperliquidStates: { [user]: HL_FIXTURE.clearinghouseState.state }, calls: { [`${GMX_V2_ARBITRUM.reader.toLowerCase()}:${encodeFunctionData({ abi: GMX_READER_ABI, functionName: "getAccountPositions", args: [getAddress(GMX_V2_ARBITRUM.dataStore), getAddress(user), 0n, 100n] })}`]: encodeFunctionResult({ abi: GMX_READER_ABI, functionName: "getAccountPositions", result: [] }) } }));
    assert.deepEqual(hl.positions.map((position) => [position.venue, position.symbol, position.side]).sort(), [["hyperliquid", "ETH", "short"], ["hyperliquid", "PURR", "short"]]);
    const solana = await readPerpsPositions("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", fixtureIo());
    assert.deepEqual(solana.positions, []);
    await assert.rejects(readPerpsPositions("not-an-account", fixtureIo()), code("ACCOUNT_INVALID"));
  });
});

describe("planPerpsIntent (the reader's entry point)", () => {
  it('"long ETH 5x with 100 USDC": the cheapest eligible venue, every other one with its reason', async () => {
    const plan = await planPerpsIntent({ market: "eth", side: "long", collateral: "100", leverage: 5 }, undefined, fixtureIo());
    assert.ok(plan.request.venue === "gmx-v2" || plan.request.venue === "hyperliquid");
    assert.deepEqual(plan.request.collateral, { asset: "USDC", amount: "100" });
    assert.equal(plan.quote!.sizeUsd, 500);
    assert.equal(plan.quote!.leverage, 5);
    assert.ok(plan.quote!.liquidationPrice! < plan.quote!.entryPrice);
    assert.match(plan.choices.find((choice) => choice.venue === "drift-v2")!.reason!, /halted/u);
  });

  it('"short SOL $200 at 3x on Drift" is refused (venue disabled); "close my ETH long" defers sizing to prepare', async () => {
    await assert.rejects(planPerpsIntent({ market: "SOL", side: "short", sizeUsd: "200", leverage: 3, venue: "drift-v2" }, undefined, fixtureIo()), code("PERPS_VENUE_DISABLED", /April 1, 2026/u));
    const plan = await planPerpsIntent({ market: "ETH", side: "long", action: "close" }, undefined, fixtureIo());
    assert.deepEqual(plan.request, { action: "close", symbol: "ETH", side: "long" });
    assert.equal(plan.quote, null);
  });

  it("refuses with each venue's reason when none can take it", async () => {
    await assert.rejects(planPerpsIntent({ market: "DOGE", side: "long", collateral: "100", leverage: 2 }, undefined, fixtureIo()), (error: { code?: string; details?: { choices: { venue: string }[] } }) => error.code === "PERPS_MARKET_UNSUPPORTED" && error.details!.choices.length === 3);
  });
});

describe("prepare: GMX v2", () => {
  it("opens with an exact approval and an ExchangeRouter multicall whose value is the execution fee", async () => {
    const prepared = await preparePerps({ venue: "gmx-v2", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 5, account: HOLDER }, undefined, fixtureIo());
    assert.equal(prepared.account, HOLDER);
    const order = prepared.steps.at(-1)!;
    assert.equal(order.kind, "transaction");
    const tx = (order as Extract<PerpsStep, { kind: "transaction" }>).transaction as { to: string; data: Hex; value: string };
    assert.equal(tx.to, getAddress(GMX_V2_ARBITRUM.exchangeRouter));
    const calls = (decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: tx.data }).args![0] as Hex[]).map((call) => decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: call }));
    assert.deepEqual(calls.map((call) => call.functionName), ["sendWnt", "sendTokens", "createOrder"]);
    assert.equal(String((calls[0]!.args as readonly [string, bigint])[1]), tx.value);
    assert.equal((calls[1]!.args as readonly [string, string, bigint])[2], 100_000_000n);
    const params = (calls[2]!.args as readonly [{ numbers: { sizeDeltaUsd: bigint; acceptablePrice: bigint }; orderType: number; isLong: boolean }])[0];
    assert.equal(params.numbers.sizeDeltaUsd, 500n * 10n ** 30n);
    assert.equal(params.orderType, 2);
    assert.equal(params.isLong, true);
    // Acceptable price: the mark plus 50 bps, in 30 − 18 decimals.
    const mark = prepared.quote!.markPrice;
    assert.ok(Math.abs(Number(params.numbers.acceptablePrice) / 1e12 - mark * 1.005) < 0.01);
    assert.ok(prepared.quote!.fees.executionUsd! > 0);
    assert.ok(prepared.warnings.some((warning) => /keepers execute/u.test(warning)));
    if (prepared.steps.length === 2) assert.equal(prepared.steps[0]!.id, "approve");
  });

  it("closes the account's whole position with a MarketDecrease", async () => {
    const positions = await readPerpsPositions(HOLDER, fixtureIo());
    const held = positions.positions[0]!;
    const prepared = await preparePerps({ action: "close", venue: "gmx-v2", symbol: held.symbol, side: held.side, account: HOLDER }, undefined, fixtureIo());
    assert.equal(prepared.steps.length, 1);
    const tx = (prepared.steps[0] as Extract<PerpsStep, { kind: "transaction" }>).transaction as { data: Hex };
    const calls = (decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: tx.data }).args![0] as Hex[]).map((call) => decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: call }));
    assert.deepEqual(calls.map((call) => call.functionName), ["sendWnt", "createOrder"]);
    const params = (calls[1]!.args as readonly [{ numbers: { sizeDeltaUsd: bigint; initialCollateralDeltaAmount: bigint }; orderType: number }])[0];
    assert.equal(params.orderType, 4);
    assert.equal(params.numbers.initialCollateralDeltaAmount, 0n, "a full close returns all collateral");
    assert.ok(Math.abs(Number(params.numbers.sizeDeltaUsd / 10n ** 28n) / 100 - held.sizeUsd) < 0.02);
  });

  it("refuses a close without a position, a Solana account, and a stale price", async () => {
    await assert.rejects(preparePerps({ action: "close", venue: "gmx-v2", symbol: "ETH", side: "long", account: `eip155:42161:${EVM}` }, undefined, fixtureIo({ calls: NO_GMX_POSITIONS })), code("PERPS_POSITION_NOT_FOUND"));
    await assert.rejects(preparePerps({ venue: "gmx-v2", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 2, account: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, undefined, fixtureIo()), code("ACCOUNT_INVALID"));
    await assert.rejects(preparePerps({ venue: "gmx-v2", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 2, account: HOLDER }, undefined, fixtureIo({ now: GMX_FIXTURE.now + 600_000 })), code("PERPS_PRICE_UNAVAILABLE"));
  });
});

describe("prepare: Hyperliquid", () => {
  const ACCOUNT = `eip155:42161:${EVM}`;

  it("deposits through Bridge2 when margin is missing, sets isolated leverage, then an IOC order (typed data hashes match)", async () => {
    const prepared = await preparePerps({ venue: "hyperliquid", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 4.5, account: ACCOUNT }, undefined, fixtureIo());
    assert.deepEqual(prepared.steps.map((step) => step.id), ["deposit", "leverage", "order"]);
    assert.equal((prepared.steps[0] as Extract<PerpsStep, { kind: "transaction" }>).settleSeconds, 60);
    const [leverage, order] = typedSteps(prepared.steps);
    assert.deepEqual(leverage!.relay.action, { type: "updateLeverage", asset: 1, isCross: false, leverage: 5 }, "integer leverage, rounded up");
    const orderAction = order!.relay.action as { orders: { a: number; b: boolean; p: string; s: string; r: boolean }[] };
    assert.deepEqual({ ...orderAction.orders[0], p: undefined }, { a: 1, b: true, p: undefined, s: "0.1871", r: false, t: { limit: { tif: "Ioc" } } });
    assert.equal(orderAction.orders[0]!.p, "2416.4", "2404.4 + 50 bps, floored to the grid");
    for (const step of [leverage!, order!]) assert.equal(step.typedData.message.connectionId, hyperliquidActionHash(step.relay.action as never, step.relay.nonce));
    assert.equal(order!.relay.nonce, leverage!.relay.nonce + 1);
    assert.equal(prepared.quote!.leverage, 5);
    assert.ok(prepared.warnings.some((warning) => /chain id 1337/u.test(warning)));
  });

  it("closes a held short with a reduce-only buy of its exact size, and cancels by order id", async () => {
    const user = HL_FIXTURE.clearinghouseState.user;
    const io = fixtureIo({ hyperliquidStates: { [user]: HL_FIXTURE.clearinghouseState.state } });
    const prepared = await preparePerps({ action: "close", venue: "hyperliquid", symbol: "ETH", side: "short", account: `eip155:42161:${user}` }, undefined, io);
    const action = typedSteps(prepared.steps)[0]!.relay.action as { orders: { b: boolean; s: string; r: boolean }[] };
    assert.deepEqual([action.orders[0]!.b, action.orders[0]!.s, action.orders[0]!.r], [true, "461.0276", true]);
    await assert.rejects(preparePerps({ action: "close", venue: "hyperliquid", symbol: "ETH", side: "long", account: `eip155:42161:${user}` }, undefined, io), code("PERPS_POSITION_NOT_FOUND"));
    const cancel = await preparePerps({ action: "cancel", venue: "hyperliquid", symbol: "BTC", side: "long", orderId: 77, account: ACCOUNT }, undefined, io);
    assert.deepEqual(typedSteps(cancel.steps)[0]!.relay.action, { type: "cancel", cancels: [{ a: 0, o: 77 }] });
    assert.equal(cancel.quote, null);
  });

  it("guards leverage, collateral, policy, markets and venues before building", async () => {
    const io = fixtureIo();
    const base = { venue: "hyperliquid", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, account: ACCOUNT };
    await assert.rejects(preparePerps({ ...base, leverage: 30 }, undefined, io), code("PERPS_LEVERAGE_TOO_HIGH", /rule book's 20x/u));
    await assert.rejects(preparePerps({ ...base, leverage: 30 }, { ...effectivePerps([]), maxLeverage: 50 }, io), code("PERPS_LEVERAGE_TOO_HIGH", /Hyperliquid's 25x cap/u));
    await assert.rejects(preparePerps({ ...base, collateral: { asset: "USDC", amount: "4" }, leverage: 5 }, undefined, io), code("PERPS_COLLATERAL_TOO_LOW"));
    await assert.rejects(preparePerps({ ...base, collateral: { asset: "USDT", amount: "100" }, leverage: 2 }, undefined, io), code("PERPS_MARKET_UNSUPPORTED", /USDC/u));
    await assert.rejects(preparePerps({ ...base, symbol: "DOGE", leverage: 2 }, undefined, io), code("PERPS_MARKET_UNSUPPORTED"));
    const agent = effectivePerps([{ policy: null, defaults: "project" }, { policy: null, defaults: "agent" }]);
    await assert.rejects(preparePerps({ ...base, leverage: 2 }, agent, io), code("PERPS_POLICY_DENIED", /Agent keys/u));
    await assert.rejects(preparePerps({ ...base, leverage: 2 }, { ...effectivePerps([]), venues: ["gmx-v2"] }, io), code("PERPS_POLICY_DENIED", /Hyperliquid/u));
    await assert.rejects(preparePerps({ ...base, venue: "drift-v2", account: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", leverage: 2 }, undefined, io), code("PERPS_VENUE_DISABLED"));
    await assert.rejects(preparePerps({ ...base, leverage: 2, venue: undefined }, undefined, io), code("INVALID_REQUEST"));
    await assert.rejects(quotePerps({ action: "close", symbol: "ETH", side: "long" }, undefined, io), code("INVALID_REQUEST"));
  });

  it("relays only Hyperliquid actions, and only with a perps-enabled policy", async () => {
    await assert.rejects(submitPerps({ venue: "gmx-v2" }, undefined, fixtureIo()), code("INVALID_REQUEST"));
    await assert.rejects(submitPerps({ venue: "hyperliquid", account: ACCOUNT }, effectivePerps([{ policy: null, defaults: "agent" }]), fixtureIo()), code("PERPS_POLICY_DENIED"));
    await assert.rejects(submitPerps({ venue: "hyperliquid", account: ACCOUNT, action: { type: "order" }, nonce: 1, signature: "0x" }, undefined, fixtureIo()), code("PERPS_SIGNATURE_INVALID"));
  });
});
