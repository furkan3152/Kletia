/**
 * Perps venue builders and readers against recorded mainnet data and
 * known-good encodings: the Hyperliquid action hash and signature vectors of
 * hyperliquid-python-sdk `tests/signing_test.py`, GMX interface orders read
 * from Arbitrum (calldata compared byte for byte), and Drift accounts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GMX_V2_ARBITRUM, HYPERLIQUID_MAINNET, type GmxMarketPin } from "@kletia/core";
import { decodeFunctionData, getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { anchorDiscriminator, decodeDriftPerpMarket, driftPdas, driftTradeInstructions, encodeDriftOrderParams, readDriftMarkets } from "../../perps/drift.js";
import { GMX_EXCHANGE_ROUTER_ABI, gmxExecutionFee, gmxKey, gmxOrderTransaction, gmxPriceToUsd, gmxUsdToPrice, readGmxMarkets, readGmxRawPositions } from "../../perps/gmx.js";
import {
  canonicalHyperliquidAction,
  hyperliquidActionHash,
  hyperliquidDepositTransaction,
  hyperliquidOrderAction,
  hyperliquidPrice,
  hyperliquidSize,
  hyperliquidTypedData,
  readHyperliquidAssets,
  readHyperliquidPositions,
  relayHyperliquidAction,
  wireDecimal,
} from "../../perps/hyperliquid.js";
import { encodeMsgpack } from "../../perps/msgpack.js";
import { DRIFT_FIXTURE, DRIFT_RECORDED_AT, fixtureIo, GMX_FIXTURE, GMX_ORDERS, HL_FIXTURE } from "./perpsHarness.js";

const hex = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString("hex");

describe("Hyperliquid", () => {
  it("hashes an order exactly as the exchange (python SDK production vector)", () => {
    // test_phantom_agent_creation_matches_production: ETH (asset 4 then), buy 0.0147 at 1670.1 IOC, nonce 1677777606040.
    const action = hyperliquidOrderAction({ asset: 4, isBuy: true, price: wireDecimal("1670.10000000"), size: wireDecimal("0.01470000"), reduceOnly: false });
    assert.equal(hyperliquidActionHash(action, 1677777606040), "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
    const typed = hyperliquidTypedData(action, 1677777606040);
    assert.deepEqual(typed.domain, { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" });
    assert.equal(typed.message.source, "a");
  });

  it("builds typed data a real signature recovers from (python SDK order signature vector)", async () => {
    // test_l1_action_signing_order_matches (mainnet): ETH asset 1, buy 100 at 100, Gtc, nonce 0.
    const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    const typed = hyperliquidTypedData(action, 0);
    const signature = ("0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e" + "2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e" + "1c") as Hex;
    const signer = await recoverTypedDataAddress({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: typed.message.source!, connectionId: typed.message.connectionId as Hex },
      signature,
    });
    assert.deepEqual(typed.types, { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] });
    assert.equal(signer, "0x14791697260E4c9A71f18484C9f997B308e59325");
  });

  it("encodes MessagePack like python msgpack.packb", () => {
    assert.equal(hex(encodeMsgpack({ a: 1, b: true, c: null, d: "x" })), "84a161" + "01" + "a162" + "c3" + "a163" + "c0" + "a164" + "a178");
    assert.equal(hex(encodeMsgpack([127, 128, 255, 256, 65535, 65536, 4294967296n])), "97" + "7f" + "cc80" + "ccff" + "cd0100" + "cdffff" + "ce00010000" + "cf0000000100000000");
    assert.equal(hex(encodeMsgpack("a".repeat(32))).slice(0, 4), "d920");
    assert.throws(() => encodeMsgpack(1.5), /integers only/u);
    assert.throws(() => encodeMsgpack(-1), /negative/u);
  });

  it("formats prices on the 5 significant figure / (6 − szDecimals) grid and floors sizes", () => {
    assert.equal(hyperliquidPrice(2404.4321, 4, false), "2404.4");
    assert.equal(hyperliquidPrice(2404.4321, 4, true), "2404.5");
    assert.equal(hyperliquidPrice(81573.98, 5, false), "81573");
    assert.equal(hyperliquidPrice(123456.7, 5, true), "123457", "integers are always valid");
    assert.equal(hyperliquidPrice(104.2731, 2, false), "104.27");
    assert.equal(hyperliquidPrice(0.123456, 0, true), "0.12346");
    assert.equal(hyperliquidSize(0.0412345, 4), "0.0412");
    assert.equal(hyperliquidSize(3, 2), "3");
    assert.equal(wireDecimal("1670.10000000"), "1670.1");
    assert.equal(wireDecimal("-0"), "0");
  });

  it("reads the listed markets with their asset ids, and positions with the venue's own liquidation price", async () => {
    const io = fixtureIo();
    const assets = await readHyperliquidAssets(io);
    assert.deepEqual(assets.map((asset) => [asset.symbol, asset.asset, asset.szDecimals, asset.maxLeverage]), [["BTC", 0, 5, 40], ["ETH", 1, 4, 25], ["SOL", 5, 2, 20]]);
    const eth = assets[1]!.market;
    assert.equal(eth.markPrice, 2404.4);
    assert.equal(eth.maintenanceMarginRate, 0.02);
    assert.deepEqual(eth.fundingRate1h, { long: 0.0000125, short: -0.0000125 });
    const user = HL_FIXTURE.clearinghouseState.user;
    const positions = await readHyperliquidPositions(fixtureIo({ hyperliquidStates: { [user]: HL_FIXTURE.clearinghouseState.state } }), user);
    const short = positions.find((position) => position.symbol === "ETH")!;
    assert.equal(short.side, "short");
    assert.equal(short.sizeBase, 461.0276);
    assert.equal(short.entryPrice, 2753.55);
    assert.equal(short.liquidationPrice, 5655.6885996949);
    assert.equal(short.leverage, 25);
  });

  it("builds a Bridge2 deposit as a plain USDC transfer and refuses one below 5 USDC", () => {
    const deposit = hyperliquidDepositTransaction("0x1111111111111111111111111111111111111111", 25_000_000n);
    assert.equal(deposit.to, getAddress(HYPERLIQUID_MAINNET.usdc));
    assert.equal(deposit.data, "0xa9059cbb" + "0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df7" + (25_000_000).toString(16).padStart(64, "0"));
    assert.equal(deposit.chainId, 42161);
    assert.throws(() => hyperliquidDepositTransaction("0x1111111111111111111111111111111111111111", 4_999_999n), (error: { code?: string }) => error.code === "PERPS_COLLATERAL_TOO_LOW");
  });

  it("relays only canonical actions the account signed, with a recent nonce", async () => {
    const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    const signature = "0x" + "d65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e" + "2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e" + "1c";
    const io = fixtureIo({ now: 0 });
    const refused = async (input: Parameters<typeof relayHyperliquidAction>[1], pattern: RegExp) =>
      assert.rejects(relayHyperliquidAction(io, input), (error: { code?: string; message: string }) => error.code === "PERPS_SIGNATURE_INVALID" && pattern.test(error.message));
    await refused({ account: "0x14791697260E4c9A71f18484C9f997B308e59325", action, nonce: 0, signature }, /IOC/u);
    const ioc = canonicalHyperliquidAction({ ...action, orders: [{ ...action.orders[0], t: { limit: { tif: "Ioc" } } }] });
    await refused({ account: "0x14791697260E4c9A71f18484C9f997B308e59325", action: ioc, nonce: 0, signature }, /not from this account/u);
    await refused({ account: "0x14791697260E4c9A71f18484C9f997B308e59325", action: ioc, nonce: 3_600_000, signature }, /nonce/u);
    await refused({ account: "0x14791697260E4c9A71f18484C9f997B308e59325", action: ioc, nonce: 0, signature: "0x1234" }, /65-byte/u);
    await refused({ account: "0x14791697260E4c9A71f18484C9f997B308e59325", action: { type: "withdraw3" }, nonce: 0, signature }, /Relay only/u);
    assert.deepEqual(io.relayed, [], "nothing reached the exchange");
    // Key order is rebuilt: a client cannot reorder fields into different bytes.
    assert.deepEqual(Object.keys(canonicalHyperliquidAction({ grouping: "na", orders: ioc.orders, type: "order" })), ["type", "orders", "grouping"]);
  });
});

describe("GMX v2", () => {
  it("encodes orders byte for byte like the GMX interface (Arbitrum transactions)", () => {
    for (const example of GMX_ORDERS.examples.slice(1)) {
      const outer = decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: example.input as Hex });
      const [sendWnt, , createOrder] = (outer.args![0] as Hex[]).map((call) => decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: call }));
      const params = (createOrder!.args as readonly [{ addresses: { market: string; receiver: string }; numbers: { sizeDeltaUsd: bigint; initialCollateralDeltaAmount: bigint; acceptablePrice: bigint }; isLong: boolean }])[0];
      const pin: GmxMarketPin = { symbol: "TEST", marketToken: params.addresses.market, indexToken: params.addresses.market, indexDecimals: 18, longToken: params.addresses.market, shortToken: GMX_V2_ARBITRUM.usdc };
      const built = gmxOrderTransaction({
        account: example.from,
        pin,
        isLong: params.isLong,
        increase: true,
        sizeDeltaUsd: params.numbers.sizeDeltaUsd,
        collateralDelta: params.numbers.initialCollateralDeltaAmount,
        acceptablePrice: params.numbers.acceptablePrice,
        executionFee: (sendWnt!.args as readonly [string, bigint])[1],
      });
      // Kletia sets no UI fee receiver; the GMX interface marks its orders with 0xff…01. Everything else is identical.
      assert.equal(built.data, example.input.replace("ff00000000000000000000000000000000000001", "0".repeat(40)), example.hash);
      assert.equal(built.value, example.value);
      assert.equal(built.to, getAddress(GMX_V2_ARBITRUM.exchangeRouter));
    }
  });

  it("reads markets from the keeper API and the DataStore, and refuses a stale price", async () => {
    const markets = await readGmxMarkets(fixtureIo());
    assert.deepEqual(markets.map((market) => market.symbol), ["ETH", "BTC", "SOL"]);
    const eth = markets[0]!;
    assert.ok(eth.markPrice > 2000 && eth.markPrice < 3000, String(eth.markPrice));
    assert.equal(eth.maintenanceMarginRate, 0.005);
    assert.equal(eth.takerFeeRate, 0.0006);
    assert.equal(eth.maxLeverage, 100);
    // Annualized net rates (30 decimals) divided into hours; longs pay here.
    assert.ok(eth.fundingRate1h.long > 0 && eth.fundingRate1h.short < 0);
    assert.ok(eth.openInterestUsd!.long > 1e6);
    await assert.rejects(readGmxMarkets(fixtureIo({ now: GMX_FIXTURE.now + 600_000 })), (error: { code?: string }) => error.code === "PERPS_PRICE_UNAVAILABLE");
  });

  it("estimates the execution fee from the DataStore gas settings", async () => {
    const fee = await gmxExecutionFee(fixtureIo(), true);
    // (base + 3 × per oracle price + increase gas × multiplier) = 4,131,697 gas at the recorded settings, × gas price × 2.
    assert.equal(fee, 4_131_697n * BigInt(GMX_FIXTURE.gasPrice) * 2n);
    assert.ok(await gmxExecutionFee(fixtureIo(), false) > 0n);
    assert.equal(gmxKey("INCREASE_ORDER_GAS_LIMIT").length, 66);
  });

  it("decodes Reader.getAccountPositions of a real account", async () => {
    const { positions, unsupported } = await readGmxRawPositions(fixtureIo(), GMX_FIXTURE.account);
    assert.equal(positions.length, 1);
    assert.equal(unsupported, 0);
    assert.ok(positions[0]!.sizeInUsd > 0n && positions[0]!.collateralAmount > 0n);
  });

  it("converts prices between USD and 30-decimal contract units", () => {
    assert.equal(gmxUsdToPrice(2400.5, 18), 2_400_500_000_000_000n);
    assert.equal(gmxPriceToUsd(2_400_500_000_000_000n, 18), 2400.5);
    assert.equal(gmxUsdToPrice(81500, 8), 815_000_000_000_000_000_000_000_000n);
    assert.equal(gmxUsdToPrice(104.25, 9), 104_250_000_000_000_000_000_000n);
  });
});

describe("Drift v2 (read-only while halted)", () => {
  it("uses the program's Anchor discriminators (deposit matches mainnet deposits)", () => {
    assert.equal(hex(anchorDiscriminator("deposit")), "f223c68952e1f2b6");
    assert.equal(hex(anchorDiscriminator("place_perp_order")), "45a15dca787e4cb9");
  });

  it("encodes OrderParams in IDL order (market order, no trigger, auction left to the program)", () => {
    const params = encodeDriftOrderParams({ direction: "long", baseAssetAmount: 1_000_000_000n, price: 2_000_000_000n, marketIndex: 2, reduceOnly: false });
    assert.equal(hex(params), "00010000" + "00ca9a3b00000000" + "0094357700000000" + "0200" + "000000" + "00" + "00" + "00" + "00" + "00" + "00" + "00");
    assert.equal(hex(encodeDriftOrderParams({ direction: "short", baseAssetAmount: 1n, price: 1n, marketIndex: 0, reduceOnly: true })).slice(0, 8), "00010100");
  });

  it("decodes recorded perp markets and lists none while their oracle prices are stale", async () => {
    const sol = DRIFT_FIXTURE.accounts[await driftPdas.perpMarket(0)]!;
    const market = decodeDriftPerpMarket(Uint8Array.from(Buffer.from(sol.data, "base64")))!;
    assert.equal(market.marketIndex, 0);
    assert.equal(market.oracle, "3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz");
    assert.equal(market.oraclePrice, 83.94523);
    assert.equal(market.maintenanceMarginRate, 0.03);
    assert.equal(market.orderStepSize, 10_000_000n);
    assert.equal(market.lastTradeTs, 1_775_068_305, "no fill since April 1, 2026");
    assert.deepEqual(await readDriftMarkets(fixtureIo({ now: DRIFT_RECORDED_AT * 1000 }), 120), []);
    const live = await readDriftMarkets(fixtureIo({ now: (market.oraclePriceTs + 10) * 1000 }), 120);
    assert.deepEqual(live.map((entry) => entry.symbol).sort(), ["BTC", "ETH", "SOL"]);
  });

  it("assembles setup, deposit and order with remaining accounts oracles → spot → perp", async () => {
    const authority = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const instructions = await driftTradeInstructions(fixtureIo(), { authority, symbol: "ETH", side: "long", reduce: false, baseAmount: 12_345_678_901n, limitPrice: 2200, depositUsdc: 100_000_000n });
    assert.deepEqual(instructions.map((instruction) => hex(instruction.data!).slice(0, 16)), [hex(anchorDiscriminator("initialize_user_stats")), hex(anchorDiscriminator("initialize_user")), "f223c68952e1f2b6", "45a15dca787e4cb9"]);
    const order = instructions[3]!;
    const accounts = order.accounts!.map((account) => String(account.address));
    assert.deepEqual(accounts.slice(0, 3), [await driftPdas.state(), await driftPdas.user(authority), authority]);
    assert.equal(accounts[3], "93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR", "ETH-PERP oracle first");
    assert.equal(accounts[5], await driftPdas.spotMarket(0));
    assert.equal(accounts[6], await driftPdas.perpMarket(2));
    // 12.345678901 ETH floored to the 0.001 ETH step.
    assert.equal(hex(order.data!).slice(24, 40), Buffer.from(new BigUint64Array([12_345_000_000n]).buffer).toString("hex"));
  });
});
