/**
 * Prediction markets on recorded Polymarket data: parsing (Gamma markets,
 * events and search, the CLOB book, Data API positions and history), the
 * EIP-712 order hash against @polymarket/clob-client-v2's own builder, the
 * L2 HMAC against the SDK's, the relay's signature guard, prepare's guards
 * and steps, the relay itself (sign-in, location check, venue refusals),
 * sessions, open orders, cancel and redemption.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectivePredictions, POLYMARKET_POLYGON, polymarketOrderAmounts, type PolymarketOrderDraft, type PredictionPrepared } from "@kletia/core";
import { decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PlatformError } from "../../errors.js";
import { clobL2Signature, orderHash, orderTicket, verifySignedOrder } from "../../predictions/signing.js";
import { openSession, sealSession } from "../../predictions/session.js";
import { marketsOfEvents, parseClobBook, parseGammaMarket, parseHistory, parsePositions } from "../../predictions/polymarket.js";
import {
  cancelPredictionOrder,
  DEFAULT_PREDICTIONS_POLICY,
  findPredictionMarkets,
  getPredictionMarket,
  listPredictionMarkets,
  listPredictionOrders,
  predictionSession,
  preparePrediction,
  prepareRedeem,
  quotePrediction,
  readPredictionPositions,
  resetPredictionsCache,
  submitPrediction,
} from "../../predictions/service.js";
import {
  BOOK_YES,
  CREDENTIALS,
  decodeErc20,
  EVENTS_POLITICS,
  HISTORY_YES,
  MARKET_666861,
  MARKET_FEES,
  MARKET_NEGRISK,
  NO_TOKEN,
  POSITIONS_OPEN,
  predictionFixtureIo,
  RECORDED_NOW,
  YES_TOKEN,
  type PredictionFixtureOptions,
} from "./predictionsHarness.js";

const P = POLYMARKET_POLYGON;
const wallet = privateKeyToAccount(generatePrivateKey());
const ACCOUNT = `eip155:137:${wallet.address}`;
const BUY = { marketId: "666861", outcome: "Yes", side: "buy", amountUsd: "20", account: ACCOUNT };
const FUNDED: PredictionFixtureOptions = { chain: { pusd: 100_000_000n } };

async function refusal(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function signOrder(prepared: PredictionPrepared): Promise<Hex> {
  const step = prepared.steps.find((entry) => entry.kind === "typed-data" && entry.purpose === "order");
  assert.ok(step && step.kind === "typed-data");
  return wallet.signTypedData({ ...step.typedData, domain: { ...step.typedData.domain, verifyingContract: step.typedData.domain.verifyingContract as Hex } } as never);
}

async function signIn(prepared: PredictionPrepared): Promise<{ timestamp: number; signature: Hex }> {
  const step = prepared.steps.find((entry) => entry.kind === "typed-data" && entry.purpose === "clob-auth");
  assert.ok(step && step.kind === "typed-data");
  const signature = await wallet.signTypedData(step.typedData as never);
  return { timestamp: Number(step.typedData.message.timestamp), signature };
}

describe("predictions: parsing recorded Polymarket answers", () => {
  it("reads a Gamma market: v1 CTF ids by outcome, tick size, fee schedule, event and link", () => {
    const market = parseGammaMarket(MARKET_666861);
    assert.ok(market);
    assert.equal(market.version, "v1");
    assert.deepEqual(market.outcomes.map((outcome) => [outcome.label, outcome.tokenId]), [["Yes", YES_TOKEN], ["No", NO_TOKEN]]);
    assert.equal(market.tickSize, "0.001");
    assert.equal(market.minOrderSize, 5);
    assert.deepEqual(market.fees, { rate: 0, exponent: 1, takerOnly: true });
    assert.equal(market.url, "https://polymarket.com/event/trump-out-as-president-before-2027");
    assert.equal(market.acceptingOrders && market.active && !market.closed, true);
    const fees = parseGammaMarket(MARKET_FEES);
    assert.deepEqual(fees?.fees, { rate: 0.05, exponent: 1, takerOnly: true });
    assert.equal(parseGammaMarket(MARKET_NEGRISK)?.negRisk, true);
  });

  it("fails closed on a market it cannot trade as read", () => {
    assert.equal(parseGammaMarket({ ...MARKET_666861, version: "v9" }), null, "unknown protocol version");
    assert.equal(parseGammaMarket({ ...MARKET_666861, orderPriceMinTickSize: 0.02 }), null, "unknown tick size");
    assert.equal(parseGammaMarket({ ...MARKET_666861, clobTokenIds: "[\"1\"]" }), null, "ids do not match the outcomes");
    // Protocol V2 markets trade positionIds, never the JSON clobTokenIds (docs, V2 API migration).
    const v2 = parseGammaMarket({ ...MARKET_666861, version: "v2" });
    assert.deepEqual(v2?.outcomes.map((outcome) => outcome.tokenId), MARKET_666861.positionIds);
    assert.equal(parseGammaMarket({ ...MARKET_FEES, feeSchedule: null })?.fees, null, "fees on, schedule unreadable: unknown");
  });

  it("flattens events, reads the book best first, positions and price history", () => {
    const markets = marketsOfEvents(EVENTS_POLITICS);
    assert.ok(markets.length > 5);
    assert.ok(markets.every((market) => market.eventTitle && market.category));
    const book = parseClobBook(BOOK_YES, YES_TOKEN, RECORDED_NOW);
    assert.equal(book.bids[0]!.price, 0.042);
    assert.equal(book.asks[0]!.price, 0.043);
    assert.ok(book.bids.every((level, index) => index === 0 || level.price < book.bids[index - 1]!.price));
    assert.ok(book.asks.every((level, index) => index === 0 || level.price > book.asks[index - 1]!.price));
    assert.throws(() => parseClobBook(BOOK_YES, NO_TOKEN, RECORDED_NOW), /did not answer for this outcome/u);
    const positions = parsePositions(POSITIONS_OPEN, "0xed107a85a4585a381e48c7f7ca4144909e7dd2e5");
    assert.equal(positions.length, 4);
    assert.deepEqual(positions.map((position) => position.outcome), ["No", "Yes", "No", "No"]);
    assert.equal(positions[3]!.title, "Trump out as President before 2027?");
    assert.ok(parseHistory(HISTORY_YES).length > 20);
  });

  it("lists markets and one market with books and history", async () => {
    resetPredictionsCache();
    const io = predictionFixtureIo();
    const list = await listPredictionMarkets({ category: "politics" }, io);
    assert.ok(list.markets.length > 0 && list.markets.every((market) => market.acceptingOrders));
    assert.deepEqual(list.venues.map((venue) => [venue.id, venue.enabled]), [["polymarket", true], ["limitless", false]]);
    const view = await getPredictionMarket("666861", io);
    assert.equal(view.outcomes[0]!.book?.asks[0]!.price, 0.043);
    assert.equal(view.outcomes[1]!.book, null, "the No book was not recorded: shown as unavailable, never guessed");
    assert.match(view.outcomes[1]!.unavailable ?? "", /no order book/u);
    assert.match(view.restrictionNote, /restricts trading in some places/u);
    await refusal(getPredictionMarket("999", io), "PREDICTION_MARKET_NOT_FOUND");
  });

  it("finds markets for sentence words: one exact match, several to pick from, never a guess", async () => {
    const io = predictionFixtureIo();
    const one = await findPredictionMarkets("trump out as president before 2027", io);
    assert.deepEqual(one.markets.map((market) => market.id), ["666861"]);
    assert.equal(one.exact, true);
    const many = await findPredictionMarkets("trump", io);
    assert.ok(many.markets.length > 1);
    const none = await findPredictionMarkets("words nobody recorded", io);
    assert.equal(none.markets.length, 0);
  });
});

describe("predictions: EIP-712 orders and the relay guard", () => {
  // The order of the docs' example, hashed by @polymarket/clob-client-v2 1.2.0 ExchangeOrderBuilderV2/V3.buildOrderHash.
  const vector: PolymarketOrderDraft = {
    salt: "479249096354", maker: getAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"), signer: getAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"),
    tokenId: YES_TOKEN, makerAmount: "5200000", takerAmount: "10000000", side: 0, signatureType: 0, timestamp: "1792829019509",
    metadata: `0x${"0".repeat(64)}`, builder: `0x${"0".repeat(64)}`, expiration: "0", orderType: "GTC", exchange: P.ctfExchange, domainVersion: "2",
  };

  it("hashes orders exactly as Polymarket's SDK does, per exchange", () => {
    assert.equal(orderHash(vector), "0xbb72ed73cc4e884b2a106ec41122977af4f4b2b98c158ce70c2690fcb460b1fa");
    assert.equal(orderHash({ ...vector, exchange: P.negRiskCtfExchange }), "0x37dc469a18909226767017fe89b4d412565d22079d3bfaf64a08e5220b216908");
    assert.equal(orderHash({ ...vector, exchange: P.exchangeV3, domainVersion: "3" }), "0x5759cc30f8b7a99ab65cad16225685d21e5f81d13d639546291328facc69ab36");
    assert.equal(orderHash({ ...vector, side: 1, makerAmount: "10000000", takerAmount: "5200000" }), "0x3ea5e82203f478294df91554e9f39f0a583e48f8bbfd5939cb5e2fd260029704");
  });

  it("signs L2 requests exactly as Polymarket's SDK does (buildPolyHmacSignature)", () => {
    assert.equal(clobL2Signature(CREDENTIALS.secret, 1792829020, "POST", "/order", "{\"a\":1}"), "PNoI76yMgA_DUzthAlfkEFf0D61ucAqCDv2MTy8W_yo=");
    assert.equal(clobL2Signature(CREDENTIALS.secret, 1792829020, "GET", "/data/orders"), "ZRPe-0JsXXjjsRtWikz9SMPeuugYNlasew11t0_cFFI=");
  });

  it("relays only the prepared order, unexpired, signed by the account", async () => {
    const order = { ...vector, maker: wallet.address, signer: wallet.address };
    const expiresAt = Math.floor(RECORDED_NOW / 1000) + 120;
    const ticket = orderTicket(order, expiresAt) as string;
    const typed = { domain: { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: P.ctfExchange as Hex }, types: { Order: [...(await import("@kletia/core")).POLYMARKET_ORDER_TYPES.Order] }, primaryType: "Order" as const, message: { ...order, side: 0, signatureType: 0 } };
    const signature = await wallet.signTypedData(typed as never);
    assert.equal(await verifySignedOrder(order, ticket, signature, wallet.address, RECORDED_NOW), orderHash(order));
    const fail = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => error instanceof PlatformError && error.code === "PREDICTION_SIGNATURE_INVALID");
    await fail(verifySignedOrder({ ...order, makerAmount: "5200001" }, ticket, signature, wallet.address, RECORDED_NOW));
    await fail(verifySignedOrder(order, ticket, signature, wallet.address, (expiresAt + 1) * 1000));
    await fail(verifySignedOrder(order, `${expiresAt}.${"A".repeat(43)}`, signature, wallet.address, RECORDED_NOW));
    const stranger = privateKeyToAccount(generatePrivateKey());
    await fail(verifySignedOrder(order, ticket, await stranger.signTypedData(typed as never), wallet.address, RECORDED_NOW));
    await fail(verifySignedOrder(order, ticket, "0x1234", wallet.address, RECORDED_NOW));
  });

  it("seals sessions for one account and refuses them elsewhere or late", () => {
    const sealed = sealSession(wallet.address, CREDENTIALS, RECORDED_NOW);
    assert.deepEqual({ ...openSession(wallet.address, sealed.session, RECORDED_NOW) }, { ...CREDENTIALS, expiresAt: sealed.expiresAt });
    assert.ok(!sealed.session.includes(CREDENTIALS.secret), "the secret never travels in clear");
    assert.throws(() => openSession(privateKeyToAccount(generatePrivateKey()).address, sealed.session, RECORDED_NOW), /not this account's/u);
    assert.throws(() => openSession(wallet.address, sealed.session, (sealed.expiresAt + 1) * 1000), /expired/u);
    assert.throws(() => openSession(wallet.address, undefined, RECORDED_NOW), /Sign in/u);
  });
});

describe("predictions: quote and prepare", () => {
  it("quotes an all-in market buy: max loss within the stake, payout 1 per share", async () => {
    const view = await quotePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo());
    assert.equal(view.quote.impliedProbability, 0.043);
    assert.equal(view.quote.maxLossUsd, 20);
    assert.equal(view.quote.payoutIfWinUsd, view.quote.shares);
    assert.ok(view.quote.shares > 400);
  });

  it("prepares exact approvals, the sign-in and the EOA order on the pinned exchange", async () => {
    const prepared = await preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo(FUNDED));
    assert.deepEqual(prepared.steps.map((step) => step.id), ["approve-pusd-exchange", "sign-in", "order"]);
    const approve = prepared.steps[0]!;
    assert.ok(approve.kind === "transaction" && approve.transaction.vm === "evm");
    assert.equal(approve.transaction.to, P.pusd);
    assert.deepEqual(decodeErc20(approve.transaction.data).args, [P.ctfExchange, 20_000_000n], "exact amount: the whole stake, fees included");
    assert.equal(prepared.order.exchange, P.ctfExchange);
    assert.equal(prepared.order.domainVersion, "2");
    assert.equal(prepared.order.maker, wallet.address);
    assert.equal(prepared.order.signatureType, 0);
    assert.equal(prepared.order.orderType, "FAK");
    assert.equal(prepared.order.makerAmount, "20000000");
    const price = (Number(prepared.quote.worstPrice)).toString();
    assert.equal(BigInt(prepared.order.takerAmount), polymarketOrderAmounts({ side: "buy", orderType: "market", amount: "20.00", price, tickSize: "0.001" })?.takerAmount);
    assert.equal(prepared.orderHash, orderHash(prepared.order));
    assert.match(prepared.warnings.join(" "), /lose the whole stake/u);
    const again = await preparePrediction({ ...BUY, hasSession: true }, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { pusd: 100_000_000n, allowances: { [`${P.pusd.toLowerCase()}:${P.ctfExchange.toLowerCase()}`]: 10n ** 12n } } }));
    assert.deepEqual(again.steps.map((step) => step.id), ["order"]);
  });

  it("wraps USDC.e when pUSD is short and refuses when neither covers the stake", async () => {
    const prepared = await preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { pusd: 5_000_000n, usdce: 50_000_000n } }));
    assert.deepEqual(prepared.steps.map((step) => step.id).slice(0, 3), ["approve-usdce", "wrap", "approve-pusd-exchange"]);
    const wrap = prepared.steps[1]!;
    assert.ok(wrap.kind === "transaction" && wrap.transaction.vm === "evm");
    const call = decodeFunctionData({ abi: parseAbi(["function wrap(address _asset, address _to, uint256 _amount)"]), data: wrap.transaction.data as Hex });
    assert.deepEqual(call.args, [P.usdce, wallet.address, 15_000_000n]);
    await refusal(preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { pusd: 1_000_000n, usdce: 1_000_000n } })), "PREDICTION_BALANCE_TOO_LOW");
  });

  it("refuses smart wallets, stakes above the rule book, unknown outcomes, small orders and agent keys", async () => {
    await refusal(preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { pusd: 10n ** 9n, code: "0x6080604052" } })), "PREDICTION_ACCOUNT_UNSUPPORTED");
    const capped = effectivePredictions([{ policy: { schema: "kletia.policy/v1", predictions: { maxStakeUsd: "10" } }, defaults: "project" }]);
    await refusal(preparePrediction(BUY, capped, predictionFixtureIo(FUNDED)), "PREDICTION_STAKE_TOO_HIGH");
    await refusal(quotePrediction({ ...BUY, outcome: "Maybe" }, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo()), "PREDICTION_OUTCOME_UNKNOWN");
    const small = { marketId: "666861", outcome: "Yes", side: "buy", orderType: "limit", shares: "1", limitPrice: "0.04", account: ACCOUNT };
    await refusal(preparePrediction(small, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo(FUNDED)), "PREDICTION_ORDER_TOO_SMALL");
    const agent = effectivePredictions([{ policy: null, defaults: "project" }, { policy: { schema: "kletia.policy/v1" }, defaults: "agent" }]);
    await refusal(quotePrediction(BUY, agent, predictionFixtureIo()), "PREDICTION_POLICY_DENIED");
    await refusal(quotePrediction({ ...BUY, venue: "limitless" }, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo()), "PREDICTION_VENUE_DISABLED");
    await refusal(quotePrediction({ ...BUY, marketId: "666861", outcome: "No" }, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo()), "PREDICTION_PRICE_UNAVAILABLE");
    await refusal(quotePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ now: RECORDED_NOW + 120_000 })), "PREDICTION_PRICE_UNAVAILABLE");
    await refusal(quotePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ markets: { "666861": { ...MARKET_666861, acceptingOrders: false } } })), "PREDICTION_MARKET_CLOSED");
  });

  it("sells only held shares, after the disclosed operator approval", async () => {
    const sell = { marketId: "666861", outcome: "Yes", side: "sell", shares: "100", account: ACCOUNT };
    await refusal(preparePrediction(sell, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo()), "PREDICTION_POSITION_NOT_FOUND");
    await refusal(preparePrediction(sell, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { shares: { [YES_TOKEN]: 50_000_000n } } })), "PREDICTION_BALANCE_TOO_LOW");
    const prepared = await preparePrediction(sell, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { shares: { [YES_TOKEN]: 100_000_000n } } }));
    const operator = prepared.steps[0]!;
    assert.ok(operator.kind === "transaction" && operator.transaction.vm === "evm");
    assert.equal(operator.transaction.to, P.conditionalTokens);
    assert.match(operator.disclosure ?? "", /operator approval .* every Polymarket outcome share/u);
    assert.equal(prepared.order.side, 1);
    assert.equal(prepared.order.makerAmount, "100000000");
    assert.equal(prepared.quote.maxLossUsd, 0);
  });
});

describe("predictions: sign-in, relay, orders, positions and redemption", () => {
  it("signs in through a verified ClobAuth and relays the signed order with L2 headers", async () => {
    const io = predictionFixtureIo(FUNDED);
    const prepared = await preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, io);
    const auth = await signIn(prepared);
    const signature = await signOrder(prepared);
    const result = await submitPrediction({ venue: "polymarket", account: ACCOUNT, order: prepared.order, ticket: prepared.ticket, signature, auth }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.equal(result.status, "accepted");
    assert.equal(result.orderStatus, "matched");
    assert.ok(result.session);
    const derive = io.requests.find((request) => request.url.endsWith("/auth/derive-api-key"));
    assert.deepEqual(derive?.init.headers, { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: auth.signature, POLY_TIMESTAMP: String(auth.timestamp), POLY_NONCE: "0" });
    const post = io.requests.find((request) => request.url.endsWith("/order") && request.init.method === "POST");
    assert.ok(post?.init.body);
    const body = JSON.parse(post.init.body) as { order: Record<string, unknown>; owner: string; orderType: string };
    assert.deepEqual(Object.keys(body.order), ["salt", "maker", "signer", "tokenId", "makerAmount", "takerAmount", "side", "signatureType", "timestamp", "expiration", "metadata", "builder", "signature"]);
    assert.equal(body.order.side, "BUY");
    assert.equal(body.order.signature, signature);
    assert.equal(body.owner, CREDENTIALS.apiKey);
    assert.equal(body.orderType, "FAK");
    const headers = post.init.headers as Record<string, string>;
    assert.equal(headers.POLY_SIGNATURE, clobL2Signature(CREDENTIALS.secret, Number(headers.POLY_TIMESTAMP), "POST", "/order", post.init.body));
    // The session from the sign-in relays the next order without signing in again.
    const next = await preparePrediction({ ...BUY, hasSession: true }, DEFAULT_PREDICTIONS_POLICY, io);
    const again = await submitPrediction({ account: ACCOUNT, order: next.order, ticket: next.ticket, signature: await signOrder(next), session: result.session }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.equal(again.session, undefined);
  });

  it("never sends a buy while the relay's location is restricted, and passes venue refusals on", async () => {
    const blocked = predictionFixtureIo({ ...FUNDED, geoblock: { blocked: true, ip: "203.0.113.9", country: "US", region: "OH" } });
    const prepared = await preparePrediction(BUY, DEFAULT_PREDICTIONS_POLICY, blocked);
    const body = { account: ACCOUNT, order: prepared.order, ticket: prepared.ticket, signature: await signOrder(prepared), auth: await signIn(prepared) };
    const geo = await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, blocked), "PREDICTION_GEOBLOCKED");
    assert.match(geo.message, /US-OH/u);
    assert.equal(blocked.requests.some((request) => request.url.endsWith("/order")), false, "nothing was posted");
    const rejected = predictionFixtureIo({ ...FUNDED, order: { status: 400, body: { success: false, errorMsg: "not enough balance / allowance" } } });
    assert.match((await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, rejected), "PREDICTION_RELAY_REJECTED")).message, /not enough balance/u);
    const region = predictionFixtureIo({ ...FUNDED, order: { status: 403, body: { error: "Trading restricted in your region" } } });
    await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, region), "PREDICTION_GEOBLOCKED");
    await refusal(submitPrediction({ ...body, auth: undefined }, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo(FUNDED)), "PREDICTION_SESSION_REQUIRED");
  });

  it("returns the sign-in to sign, then a session; lists and cancels orders with it", async () => {
    const io = predictionFixtureIo();
    const ask = await predictionSession({ account: ACCOUNT }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.equal(ask.typedData?.primaryType, "ClobAuth");
    const signature = await wallet.signTypedData(ask.typedData as never);
    const made = await predictionSession({ account: ACCOUNT, auth: { timestamp: Number(ask.typedData?.message.timestamp), signature } }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.ok(made.session);
    const orders = await listPredictionOrders({ account: ACCOUNT, session: made.session }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.deepEqual(orders.orders.map((order) => [order.side, order.shares, order.filledShares]), [["buy", 50, 10]]);
    const cancel = await cancelPredictionOrder({ account: ACCOUNT, session: made.session, orderId: orders.orders[0]!.id }, DEFAULT_PREDICTIONS_POLICY, io);
    assert.equal(cancel.canceled, true);
    await refusal(predictionSession({ account: ACCOUNT, auth: { timestamp: Number(ask.typedData?.message.timestamp) - 3600, signature } }, DEFAULT_PREDICTIONS_POLICY, io), "PREDICTION_SIGNATURE_INVALID");
  });

  it("reads positions of any holder and says whether Kletia can trade for it", async () => {
    const view = await readPredictionPositions({ holder: "0xed107a85a4585a381e48c7f7ca4144909e7dd2e5" }, predictionFixtureIo());
    assert.equal(view.positions.length, 4);
    assert.equal(view.truncated, true);
    assert.equal(view.tradable, true);
    const smart = await readPredictionPositions({ account: ACCOUNT }, predictionFixtureIo({ chain: { code: "0x6080" } }));
    assert.equal(smart.tradable, false);
  });

  it("redeems resolved v1 shares through the collateral adapter, never before resolution", async () => {
    const conditionId = String(MARKET_666861.conditionId);
    const body = { account: ACCOUNT, conditionId };
    await refusal(prepareRedeem(body, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { shares: { [YES_TOKEN]: 1_000_000n } } })), "PREDICTION_NOT_RESOLVED");
    const io = predictionFixtureIo({ chain: { payoutDenominator: 1n, shares: { [NO_TOKEN]: 7_500_000n } } });
    const redeem = await prepareRedeem(body, DEFAULT_PREDICTIONS_POLICY, io);
    assert.deepEqual(redeem.steps.map((step) => step.id), ["operator-0", "redeem"]);
    const step = redeem.steps[1]!;
    assert.ok(step.kind === "transaction" && step.transaction.vm === "evm");
    assert.equal(step.transaction.to, P.ctfCollateralAdapter);
    const call = decodeFunctionData({ abi: parseAbi(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"]), data: step.transaction.data as Hex });
    assert.deepEqual(call.args, [P.pusd, `0x${"0".repeat(64)}`, conditionId, [1n, 2n]]);
    await refusal(prepareRedeem(body, DEFAULT_PREDICTIONS_POLICY, predictionFixtureIo({ chain: { payoutDenominator: 1n } })), "PREDICTION_POSITION_NOT_FOUND");
  });
});
