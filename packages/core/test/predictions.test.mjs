import assert from "node:assert/strict";
import test from "node:test";
import {
  POLYMARKET_POLYGON,
  POLYMARKET_SIGNATURE_TYPES,
  POLYMARKET_WALLET_FACTORIES,
  PREDICTION_LIMITS,
  PREDICTION_VENUES,
  checkSubagentPolicy,
  comparePolicies,
  decimalUnits,
  effectivePolicyDocument,
  effectivePredictions,
  findOutcome,
  getPredictionVenue,
  getProtocol,
  impliedProbability,
  polymarketExchange,
  polymarketOrderAmounts,
  predictionFeeUsd,
  predictionStakeUsd,
  priceOnTick,
  quotePredictionOrder,
  unitsDecimal,
  validatePolicy,
  validatePredictionRequest,
  walkBook,
} from "../dist/index.js";

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≉ ${expected}`);

const market = (overrides = {}) => ({ venue: "polymarket", id: "666861", question: "Trump out as President before 2027?", fees: null, minOrderSize: 5, ...overrides });
const yes = { label: "Yes", tokenId: "59252515735652674747158950210016502214756531287333895140318848923768750410355" };
// Best levels first, as the API normalises the CLOB book.
const book = {
  bids: [{ price: 0.42, size: 100 }, { price: 0.41, size: 200 }],
  asks: [{ price: 0.43, size: 50 }, { price: 0.45, size: 100 }, { price: 0.5, size: 1000 }],
};

test("venues: Polymarket is live on Polygon, Limitless is listed as not added with its reason", () => {
  assert.deepEqual(PREDICTION_VENUES.map((venue) => [venue.id, venue.network, venue.enabled]), [["polymarket", "polygon", true], ["limitless", "base", false]]);
  assert.match(getPredictionVenue("limitless").disabledReason, /scoped API token/u);
  assert.equal(getProtocol("polymarket").category, "prediction");
  assert.equal(getProtocol("polymarket").execution, "service");
  assert.equal(getProtocol("kalshi"), null, "Kalshi is never integrated (KYC, custodial accounts)");
});

test("exchanges: v2 markets sign for ExchangeV3 (domain 3), v1 for CTF Exchange V2 or its neg-risk twin (domain 2)", () => {
  assert.deepEqual(polymarketExchange("v2", false), { address: POLYMARKET_POLYGON.exchangeV3, domainVersion: "3" });
  assert.deepEqual(polymarketExchange("v2", true), { address: POLYMARKET_POLYGON.exchangeV3, domainVersion: "3" });
  assert.deepEqual(polymarketExchange("v1", false), { address: "0xE111180000d2663C0091e4f400237545B87B996B", domainVersion: "2" });
  assert.deepEqual(polymarketExchange("v1", true), { address: "0xe2222d279d744050d28e00520010520000310F59", domainVersion: "2" });
});

test("fees: shares × rate × p(1 − p), symmetric around 50% (docs fee tables, 100 shares)", () => {
  const crypto = { rate: 0.07, exponent: 1, takerOnly: true };
  assert.equal(predictionFeeUsd(100, 0.5, crypto), 1.75);
  close(predictionFeeUsd(100, 0.3, crypto), 1.47);
  close(predictionFeeUsd(100, 0.7, crypto), 1.47);
  assert.equal(predictionFeeUsd(100, 0.5, { rate: 0.04, exponent: 1, takerOnly: true }), 1);
  assert.equal(predictionFeeUsd(100, 0.5, { rate: 0, exponent: 1, takerOnly: true }), 0, "geopolitics markets are fee-free");
  assert.equal(predictionFeeUsd(100, 0.5, null), 0);
  // Rounded to 5 decimals, the venue's precision.
  assert.equal(predictionFeeUsd(1, 0.01, crypto), 0.00069);
});

test("order amounts: the docs' worked examples in exact base units", () => {
  // Limit BUY of 10 shares at 0.52 (tick 0.01): 5.20 USD for 10 shares.
  const limitBuy = polymarketOrderAmounts({ side: "buy", orderType: "limit", amount: "10", price: "0.52", tickSize: "0.01" });
  assert.deepEqual(limitBuy, { makerAmount: 5_200_000n, takerAmount: 10_000_000n });
  // Market BUY of 10 USD with a maximum price of 0.52: 19.2307 shares, as @polymarket/clob-client-v2 1.2.0
  // getMarketOrderRawAmounts computes it (the docs' prose example prints 19.2308; the SDK is what Polymarket's
  // own clients sign, and a smaller takerAmount only keeps the maximum price).
  const marketBuy = polymarketOrderAmounts({ side: "buy", orderType: "market", amount: "10", price: "0.52", tickSize: "0.01" });
  assert.deepEqual(marketBuy, { makerAmount: 10_000_000n, takerAmount: 19_230_700n });
  // More SDK outputs (same helper): every tick size's rounding.
  const sdk = [
    ["20", "0.43", "0.001", 46_511_620n], ["19.6", "0.455", "0.001", 43_076_920n], ["7.33", "0.071", "0.001", 103_239_430n],
    ["100", "0.3333", "0.0001", 300_030_003n], ["5", "0.005", "0.005", 1_000_000_000n],
  ];
  for (const [amount, price, tickSize, shares] of sdk) {
    assert.equal(polymarketOrderAmounts({ side: "buy", orderType: "market", amount, price, tickSize }).takerAmount, shares, `${amount} at ${price}`);
  }
  assert.deepEqual(polymarketOrderAmounts({ side: "buy", orderType: "limit", amount: "33.33", price: "0.0475", tickSize: "0.0025" }), { makerAmount: 1_583_175n, takerAmount: 33_330_000n });
  // SELL 10 shares at 0.5: 10 shares for at least 5 USD.
  assert.deepEqual(polymarketOrderAmounts({ side: "sell", orderType: "market", amount: "10", price: "0.5", tickSize: "0.01" }), { makerAmount: 10_000_000n, takerAmount: 5_000_000n });
  // Sizes are cut to 2 decimals, prices to the tick's decimals (0.001 tick: 3).
  assert.deepEqual(polymarketOrderAmounts({ side: "sell", orderType: "limit", amount: "12.349", price: "0.043", tickSize: "0.001" }), { makerAmount: 12_340_000n, takerAmount: 530_620n });
  // Fail closed: an unknown tick size, a price of 0 or 1, a zero amount.
  assert.equal(polymarketOrderAmounts({ side: "buy", orderType: "market", amount: "10", price: "0.5", tickSize: "0.02" }), null);
  assert.equal(polymarketOrderAmounts({ side: "buy", orderType: "market", amount: "10", price: "1", tickSize: "0.01" }), null);
  assert.equal(polymarketOrderAmounts({ side: "buy", orderType: "market", amount: "0", price: "0.5", tickSize: "0.01" }), null);
});

test("decimals and the tick grid", () => {
  assert.equal(decimalUnits("12.3456789", 6), 12_345_678n);
  assert.equal(decimalUnits("-1", 6), null);
  assert.equal(unitsDecimal(19_230_800n, 6), "19.2308");
  assert.equal(priceOnTick(0.5237, "0.01", "up"), "0.53");
  assert.equal(priceOnTick(0.5237, "0.01", "down"), "0.52");
  assert.equal(priceOnTick(0.9999, "0.001", "up"), "0.999", "never 1");
  assert.equal(priceOnTick(0.0001, "0.001", "down"), "0.001", "never 0");
  assert.equal(priceOnTick(0.4, "0.005", "up"), "0.4");
  assert.equal(priceOnTick(0.29, "0.01", "down"), "0.29", "binary noise does not cut a tick");
  assert.equal(priceOnTick(0.57, "0.01", "up"), "0.57");
  assert.equal(priceOnTick(0.5, "0.03", "up"), null);
});

test("book walk: a buy spends USD level by level, a sell sells shares into the bids", () => {
  const buy = walkBook(book, "buy", 30);
  // 50 × 0.43 = 21.5 USD at the first level, 8.5 USD more at 0.45.
  close(buy.shares, 50 + 8.5 / 0.45);
  assert.equal(buy.lastPrice, 0.45);
  assert.equal(buy.complete, true);
  const sell = walkBook(book, "sell", 150);
  close(sell.notional, 100 * 0.42 + 50 * 0.41);
  assert.equal(walkBook({ bids: [], asks: [] }, "buy", 10), null);
  assert.equal(walkBook(book, "sell", 1_000).complete, false);
});

test("quote: a market buy is all-in (stake plus fee within the amount), max loss is the stake, payout 1 per share", () => {
  const fees = { rate: 0.05, exponent: 1, takerOnly: true };
  const quote = quotePredictionOrder(market({ fees }), yes, book, { side: "buy", orderType: "market", amountUsd: 20, slippageBps: 200 });
  assert.equal(quote.impliedProbability, 0.43);
  assert.ok(quote.notionalUsd + quote.feeUsd <= 20 + 1e-9, "notional plus fee stays within the stake");
  assert.equal(quote.maxLossUsd, Math.round((quote.notionalUsd + quote.feeUsd) * 100) / 100);
  assert.equal(quote.payoutIfWinUsd, quote.shares);
  close(quote.profitIfWinUsd, quote.shares - quote.notionalUsd - quote.feeUsd, 1e-2);
  assert.ok(quote.worstPrice >= 0.43 && quote.worstPrice <= 0.45 * 1.02 + 1e-9);
  // Fee-free market: the whole stake buys shares.
  const free = quotePredictionOrder(market(), yes, book, { side: "buy", orderType: "market", amountUsd: 20, slippageBps: 200 });
  assert.equal(free.notionalUsd, 20);
  assert.equal(free.feeUsd, 0);
  close(free.shares, Math.round((20 / 0.43) * 100) / 100);
});

test("quote: sells, limit orders, thin books and empty sides", () => {
  const sell = quotePredictionOrder(market(), yes, book, { side: "sell", orderType: "market", shares: 50, slippageBps: 100 });
  assert.equal(sell.maxLossUsd, 0);
  assert.equal(sell.notionalUsd, 21);
  assert.equal(sell.profitIfWinUsd, 21, "a sell's proceeds after fees");
  const limit = quotePredictionOrder(market(), yes, book, { side: "buy", orderType: "limit", shares: 10, limitPrice: 0.3, slippageBps: 200 });
  assert.equal(limit.notionalUsd, 3);
  assert.match(limit.warnings.join(" "), /rests until someone takes it/u);
  const thin = quotePredictionOrder(market(), yes, { bids: [], asks: [{ price: 0.5, size: 10 }] }, { side: "buy", orderType: "market", amountUsd: 100, slippageBps: 200 });
  assert.equal(thin.fillable, 0.05);
  assert.match(thin.warnings.join(" "), /covers only 5%/u);
  assert.equal(quotePredictionOrder(market(), yes, { bids: [], asks: [] }, { side: "buy", orderType: "market", amountUsd: 10, slippageBps: 200 }), null);
  const small = quotePredictionOrder(market({ minOrderSize: 5 }), yes, book, { side: "buy", orderType: "market", amountUsd: 1, slippageBps: 200 });
  assert.match(small.warnings.join(" "), /smallest order is 5 shares/u);
  assert.equal(impliedProbability(0), null);
  assert.equal(impliedProbability(0.37), 0.37);
});

test("validation: shapes per side and order type", () => {
  const ok = validatePredictionRequest({ marketId: "666861", outcome: " Yes ", side: "buy", amountUsd: "20" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { venue: "polymarket", marketId: "666861", outcome: "Yes", side: "buy", orderType: "market", amountUsd: "20" });
  const bad = (input) => validatePredictionRequest(input).issues.map((issue) => issue.path);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy" }), ["amountUsd"]);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "sell", amountUsd: "5" }), ["shares", "amountUsd"]);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy", orderType: "limit", shares: "10" }), ["limitPrice"]);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy", orderType: "limit", shares: "10", limitPrice: "1.2" }), ["limitPrice"]);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy", amountUsd: "0.5" }), ["amountUsd"]);
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy", amountUsd: "20", extra: 1 }), ["extra"]);
  assert.deepEqual(bad({ marketId: "x y", outcome: "Yes", side: "buy", amountUsd: "20" }), ["marketId"]);
  const safe = "0x1DaB69F26C401D587D9e4875e68Dd0D878818719";
  assert.equal(validatePredictionRequest({ marketId: "1", outcome: "Yes", side: "buy", amountUsd: "20", wallet: safe }).value.wallet, safe, "the Polymarket wallet that trades");
  assert.deepEqual(bad({ marketId: "1", outcome: "Yes", side: "buy", amountUsd: "20", wallet: "0x1234" }), ["wallet"]);
  assert.equal(predictionStakeUsd({ side: "buy", amountUsd: "20" }), 20);
  assert.equal(predictionStakeUsd({ side: "buy", shares: "10", limitPrice: "0.4" }), 4);
  assert.equal(predictionStakeUsd({ side: "sell", shares: "10" }), 0);
  assert.equal(findOutcome([{ label: "Yes" }, { label: "No" }], "no").label, "No");
  assert.equal(findOutcome([{ label: "Yes" }, { label: "No" }], "maybe"), null);
});

test("rule book: predictions section, agent default off, the chain's lowest cap and venue intersection", () => {
  const document = validatePolicy({ schema: "kletia.policy/v1", predictions: { enabled: true, maxStakeUsd: "50.00", venues: ["polymarket"] } });
  assert.equal(document.ok, true);
  assert.deepEqual(document.value.predictions, { enabled: true, maxStakeUsd: "50", venues: ["polymarket"] });
  assert.equal(validatePolicy({ schema: "kletia.policy/v1", predictions: { maxStakeUsd: "0.5" } }).ok, false);
  assert.equal(validatePolicy({ schema: "kletia.policy/v1", predictions: { venues: ["kalshi"] } }).ok, false);
  assert.equal(validatePolicy({ schema: "kletia.policy/v1", predictions: { odds: true } }).ok, false);
  // No rule book: enabled on the live venues with the default cap. Agents: off unless their rule book enables it.
  assert.deepEqual(effectivePredictions([]), { enabled: true, maxStakeUsd: PREDICTION_LIMITS.defaultMaxStakeUsd, venues: ["polymarket"], reason: null });
  const agent = effectivePredictions([{ policy: null, defaults: "project" }, { policy: { schema: "kletia.policy/v1" }, defaults: "agent" }]);
  assert.equal(agent.enabled, false);
  assert.match(agent.reason, /predictions\.enabled/u);
  const chain = effectivePredictions([
    { policy: { schema: "kletia.policy/v1", predictions: { maxStakeUsd: "100" } }, defaults: "project" },
    { policy: { schema: "kletia.policy/v1", predictions: { enabled: true, maxStakeUsd: "25" } }, defaults: "agent" },
  ]);
  assert.deepEqual(chain, { enabled: true, maxStakeUsd: 25, venues: ["polymarket"], reason: null });
  const denied = effectivePredictions([{ policy: { schema: "kletia.policy/v1", protocols: { deny: ["polymarket"] } }, defaults: "project" }]);
  assert.deepEqual(denied.venues, []);
  assert.equal(effectivePolicyDocument({ schema: "kletia.policy/v1" }, "agent").predictions.enabled, false);
  // Enabling or raising the cap loosens (waits the amendment delay); lowering it tightens.
  const looser = comparePolicies({ schema: "kletia.policy/v1", predictions: { maxStakeUsd: "10" } }, { schema: "kletia.policy/v1", predictions: { maxStakeUsd: "20" } });
  assert.deepEqual(looser.loosened, ["predictions.maxStakeUsd"]);
  const enable = comparePolicies({ schema: "kletia.policy/v1" }, { schema: "kletia.policy/v1", predictions: { enabled: true } }, { defaults: "agent" });
  assert.deepEqual(enable.loosened, ["predictions.enabled"]);
});

test("sub-agents: prediction markets only where the parent trades them, at no higher stake, on no other venue", () => {
  const parent = { policy: { schema: "kletia.policy/v1", predictions: { enabled: true, maxStakeUsd: "40", venues: ["polymarket"] } }, defaults: "agent", keyId: "key_parent" };
  const project = { policy: null, defaults: "project", keyId: "key_root" };
  const check = (predictions) => checkSubagentPolicy({ child: { schema: "kletia.policy/v1", mode: "live", predictions }, chain: [project, parent], childDepth: 2 });
  const paths = (result) => result.issues.map((issue) => issue.path).filter((path) => path.startsWith("predictions"));
  assert.deepEqual(paths(check({ enabled: true, maxStakeUsd: "40", venues: ["polymarket"] })), []);
  assert.deepEqual(paths(check({ enabled: true, maxStakeUsd: "80", venues: ["polymarket"] })), ["predictions.maxStakeUsd"]);
  assert.deepEqual(paths(check({ enabled: true, maxStakeUsd: "10" })), ["predictions.venues"]);
  const off = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", predictions: { enabled: true, maxStakeUsd: "1", venues: ["polymarket"] } }, chain: [project, { ...parent, policy: { schema: "kletia.policy/v1" } }], childDepth: 2 });
  assert.deepEqual(paths(off), ["predictions.enabled"]);
});

test("Polymarket wallets: factories from the docs' contract list and the SDKs' signature types", () => {
  // docs.polymarket.com/resources/contracts "Wallet Factory Contracts"; @polymarket/clob-client-v2 SignatureTypeV2.
  assert.equal(POLYMARKET_WALLET_FACTORIES.safeFactory.toLowerCase(), "0xaacfeea03eb1561c4e67d661e40682bd20e3541b");
  assert.equal(POLYMARKET_WALLET_FACTORIES.proxyFactory, "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052");
  assert.equal(POLYMARKET_WALLET_FACTORIES.depositWalletFactory, "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07");
  assert.equal(POLYMARKET_WALLET_FACTORIES.depositWalletBeacon, "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a");
  assert.deepEqual({ ...POLYMARKET_SIGNATURE_TYPES }, { eoa: 0, proxy: 1, safe: 2, deposit: 3 });
});
