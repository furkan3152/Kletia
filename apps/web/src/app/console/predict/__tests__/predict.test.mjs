// The Predict view's model (round 10): implied probabilities, market rows,
// book depth, the ticket and its request, quote rows that say the most you
// can lose, the user's Polymarket wallets (which one trades, balances,
// moves), open orders, position rows, the location note, the signing run,
// and the prediction hand-off prefill. Run with
//   node --test apps/web/src/app/console/predict/__tests__/predict.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handoffLine, handoffViewName, predictPrefill } from "../../handoff/handoffModel.ts";
import {
  bookDepth,
  DEFAULT_TICKET,
  formatCents,
  formatEnds,
  formatProbability,
  formatVolume,
  limitPrice,
  locationNote,
  marketRows,
  moveProblems,
  nextStep,
  openOrderRows,
  pickWallet,
  orderStatusLine,
  positionRows,
  quoteRows,
  startRun,
  ticketAmount,
  ticketProblems,
  ticketRequest,
  walletLine,
  walletRows,
  withStepState,
} from "../predictModel.ts";

const market = {
  venue: "polymarket", id: "666861", slug: "trump-out-as-president-before-2027", question: "Trump out as President before 2027?", eventId: "73969",
  eventTitle: "Trump out as President before 2027?", groupTitle: null, category: "Politics", image: null, endDate: "2027-01-01T04:59:00Z",
  active: true, closed: false, acceptingOrders: true, version: "v1", conditionId: "0x48b0", negRisk: false, tickSize: "0.001", minOrderSize: 5,
  outcomes: [{ label: "Yes", tokenId: "1", price: 0.0425 }, { label: "No", tokenId: "2", price: 0.9575 }],
  volumeUsd: 13_062_731, volume24hUsd: 14_833.7, liquidityUsd: 371_936, fees: { rate: 0, exponent: 1, takerOnly: true }, matchDelaySeconds: 0, resolved: false,
  url: "https://polymarket.com/event/trump-out-as-president-before-2027", description: null,
};

test("prices read as implied probabilities and cents; volumes and ends read short", () => {
  assert.equal(formatProbability(0.0425), "4.3%");
  assert.equal(formatProbability(0.9575), "96%");
  assert.equal(formatProbability(0.0004), "<0.1%");
  assert.equal(formatProbability(0.9996), ">99.9%");
  assert.equal(formatProbability(null), "-");
  assert.equal(formatCents(0.043), "4.3¢");
  assert.equal(formatVolume(14_833.7), "$14.8K");
  assert.equal(formatVolume(0), "$0");
  assert.equal(formatEnds("2027-01-01T04:59:00Z", Date.parse("2026-10-24T00:00:00Z")), "Ends Jan 1, 2027");
  assert.equal(formatEnds("2026-01-01T00:00:00Z", Date.parse("2026-10-24T00:00:00Z")), "Ended Jan 1, 2026");
  assert.equal(formatEnds(null, 0), "No end date");
});

test("market rows lead with the first outcome's probability; options of an event show both names", () => {
  const [row] = marketRows([market], Date.parse("2026-10-24T00:00:00Z"));
  assert.deepEqual(row, { id: "666861", title: "Trump out as President before 2027?", context: null, leading: { label: "Yes", probability: "4.3%" }, volume: "$14.8K", ends: "Ends Jan 1, 2027" });
  const [option] = marketRows([{ ...market, groupTitle: "Xi Jinping", eventTitle: "Who will Trump meet with in 2026?", question: "Will Trump meet with Xi Jinping in 2026?" }], 0);
  assert.equal(option.title, "Who will Trump meet with in 2026?: Xi Jinping");
  assert.equal(option.context, "Will Trump meet with Xi Jinping in 2026?");
});

test("book depth: best levels first with relative bars and the spread", () => {
  const depth = bookDepth({ bids: [{ price: 0.042, size: 100 }, { price: 0.041, size: 400 }], asks: [{ price: 0.043, size: 200 }] });
  assert.deepEqual(depth.bids.map((row) => [row.price, row.depth]), [["4.2¢", 0.25], ["4.1¢", 1]]);
  assert.equal(depth.asks[0].shares, "200");
  assert.equal(depth.spread, "0.1¢");
  assert.equal(bookDepth({ bids: [], asks: [] }).spread, "-");
});

test("the ticket: amounts, limit prices in cents, problems and the request", () => {
  assert.equal(ticketAmount("$20"), "20");
  assert.equal(ticketAmount("20.555"), null);
  assert.equal(ticketAmount("0"), null);
  assert.equal(limitPrice("42"), "0.42");
  assert.equal(limitPrice("4.5"), "0.045");
  assert.equal(limitPrice("100"), null);
  assert.deepEqual(ticketProblems(DEFAULT_TICKET, null), ["Pick a market."]);
  const ticket = { ...DEFAULT_TICKET, marketId: "666861", outcome: "Yes", amount: "20" };
  assert.deepEqual(ticketProblems(ticket, market), []);
  assert.deepEqual(ticketProblems({ ...ticket, amount: "20000" }, market), ["The cap is $10,000.00 per order."]);
  assert.deepEqual(ticketProblems({ ...ticket, outcome: "Maybe" }, market), ["Pick an outcome."]);
  assert.deepEqual(ticketProblems(ticket, { ...market, acceptingOrders: false }), ["This market is not taking orders."]);
  assert.deepEqual(ticketRequest(ticket, null), { venue: "polymarket", marketId: "666861", outcome: "Yes", side: "buy", orderType: "market", amountUsd: "20", slippageBps: 200 });
  assert.deepEqual(ticketRequest({ ...ticket, side: "sell", orderType: "limit", amount: "50", limitCents: "6" }, "eip155:137:0xabc", true), {
    venue: "polymarket", marketId: "666861", outcome: "Yes", side: "sell", orderType: "limit", shares: "50", limitPrice: "0.06", account: "eip155:137:0xabc", hasSession: true,
  });
});

test("quote rows say the most you can lose before the payout, and a sell what you give up", () => {
  const quote = { venue: "polymarket", marketId: "666861", question: market.question, outcome: "Yes", tokenId: "1", side: "buy", orderType: "market", impliedProbability: 0.043, avgPrice: 0.043, worstPrice: 0.044, shares: 465.11, notionalUsd: 20, spendCapUsd: 20, feeUsd: 0, maxLossUsd: 20, payoutIfWinUsd: 465.11, profitIfWinUsd: 445.11, fillable: 1, warnings: [] };
  const rows = quoteRows(quote);
  assert.deepEqual(rows.map((row) => row.label), ["Implied probability now", "Average price", "Worst price accepted", "Shares you get", "Most you can lose", "Payout if Yes wins", "Profit if it wins", "Fees (estimate)"]);
  assert.equal(rows.find((row) => row.label === "Most you can lose").value, "$20.00");
  assert.equal(rows.find((row) => row.label === "Most you can lose").tone, "warn");
  assert.equal(rows.at(-1).value, "None on this market");
  const sell = quoteRows({ ...quote, side: "sell", maxLossUsd: 0, profitIfWinUsd: 19.5, feeUsd: 0.5 });
  assert.ok(sell.some((row) => row.label === "You give up if Yes wins"));
  assert.equal(sell.at(-1).value, "$0.50");
});

test("positions: rows with gain or loss, filtered by a sell hand-off's words", () => {
  const positions = [
    { venue: "polymarket", holder: "0x1", conditionId: "0xa", tokenId: "1", title: "Trump out as President before 2027?", slug: null, eventSlug: null, outcome: "No", outcomeIndex: 1, shares: 358302.5341, avgPrice: 0.92, currentPrice: 0.9575, valueUsd: 343074.67, costUsd: 331931.46, pnlUsd: 11143.2, redeemable: false, negRisk: false, endDate: "2027-01-01" },
    { venue: "polymarket", holder: "0x1", conditionId: "0xb", tokenId: "2", title: "UFC Fight Night: Malott vs. Buckley", slug: null, eventSlug: null, outcome: "Buckley", outcomeIndex: 1, shares: 7500, avgPrice: 0.4, currentPrice: 0, valueUsd: 0, costUsd: 3000, pnlUsd: -3000, redeemable: true, negRisk: false, endDate: null },
  ];
  const rows = positionRows(positions);
  assert.deepEqual(rows.map((row) => [row.outcome, row.pnlTone, row.redeemable]), [["No", "gain", false], ["Buckley", "loss", true]]);
  assert.equal(rows[0].shares, "358,302.53");
  assert.deepEqual(positionRows(positions, "trump").map((row) => row.conditionId), ["0xa"]);
  assert.deepEqual(positionRows(positions, "nothing like this"), []);
});

test("location: a restricted or unanswered check turns buying off and says Kletia does not work around it", () => {
  assert.equal(locationNote({ blocked: false, country: "PT", region: "11" }).canBuy, true);
  const blocked = locationNote({ blocked: true, country: "US", region: "OH" });
  assert.equal(blocked.canBuy, false);
  assert.match(blocked.text, /US-OH.*does not work around/u);
  assert.equal(locationNote(null).canBuy, false);
});

test("the signing run moves step by step and stops at a failure", () => {
  const steps = [{ kind: "transaction", id: "approve", title: "Approve" }, { kind: "typed-data", id: "order", title: "Order", purpose: "order" }];
  let run = startRun(steps);
  assert.equal(nextStep(run), 0);
  run = withStepState(run, 0, "done");
  assert.equal(nextStep(run), 1);
  run = withStepState(run, 1, "failed", "not enough balance / allowance");
  assert.equal(nextStep(run), -1);
  assert.equal(run.error, "not enough balance / allowance");
  assert.match(orderStatusLine("matched"), /Filled/u);
  assert.match(orderStatusLine("live"), /rests on the book/u);
});

test("prediction hand-offs: a question opens the search, a buy the ticket, a sell the positions", () => {
  const search = predictPrefill({ action: "search", query: "trump out as president" });
  assert.equal(search.search, "trump out as president");
  assert.equal(search.ticket, null);
  const buy = predictPrefill({ action: "buy", venue: "polymarket", marketId: "666861", market: market.question, outcome: "Yes", amountUsd: "20" });
  assert.deepEqual(buy.ticket, { marketId: "666861", outcome: "Yes", side: "buy", orderType: "market", amount: "20" });
  assert.match(buy.note("Buy 20 USD of Yes"), /lose the whole stake/u);
  const sell = predictPrefill({ action: "sell", query: "trump" });
  assert.equal(sell.positionFilter, "trump");
  assert.equal(handoffViewName("predictions"), "Predict");
  assert.match(handoffLine({ surface: "predictions", summary: "Odds on \"trump\"" }), /opened in Predict\. Nothing is bought or signed/u);
  assert.match(handoffLine({ surface: "predictions", summary: "Buy 20 USD of Yes" }), /Opened in Predict.*Nothing was signed here/u);
});

test("the view keeps the session in memory only and never reads browser storage", () => {
  const run = readFileSync(new URL("../usePredictRun.ts", import.meta.url), "utf8");
  const view = readFileSync(new URL("../PredictView.tsx", import.meta.url), "utf8");
  for (const source of [run, view]) assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u);
  assert.match(view, /checkGeoblock/u, "the location check runs from the browser");
});

// Recorded Polymarket wallets (fixtures/predictions/polymarket-wallets.json in the API tests): a Safe and a Deposit Wallet.
const SAFE = {
  address: "0x1DaB69F26C401D587D9e4875e68Dd0D878818719", kind: "safe", owner: "0xF6d143B21Ce3b07DAE3AE0fa23B65e0449e21dC0", signatureType: 2, tradable: true,
  verifiedBy: "Derived from your wallet with Polymarket's Safe factory (CREATE2); getOwners() on Polygon lists your wallet.", onProfile: true,
  balances: { pusd: "82.344286", usdce: "0.00255" }, actions: ["deposit", "withdraw", "wrap"], note: null,
};
const DEPOSIT = { ...SAFE, address: "0x2a4E00E43232136eD816a5439A3AE9c4CA4A653B", kind: "deposit", signatureType: 3, onProfile: false, balances: null, actions: ["deposit"], note: "relayer" };
const PROXY = { ...SAFE, address: "0x48Cd30F5939c7F192A6777F1Db222dF1af928D30", kind: "proxy", signatureType: 1, tradable: false, onProfile: false, actions: ["deposit"], note: "Magic" };

test("names the wallet that trades and its balances, and picks it as polymarket.com does", () => {
  assert.equal(walletLine(SAFE), "Your Polymarket wallet 0x1DaB…8719, owned by 0xF6d1…1dC0");
  const [safe, deposit, proxy] = walletRows([SAFE, DEPOSIT, PROXY]);
  assert.deepEqual([safe.kind, safe.balance, safe.tradable, safe.onProfile], ["Safe", "82.34 pUSD · 0.00 USDC.e", true, true]);
  assert.equal(deposit.balance, "Balance unavailable", "an unread balance is said, never shown as zero");
  assert.deepEqual([proxy.kind, proxy.tradable], ["Proxy wallet", false]);
  assert.equal(pickWallet([DEPOSIT, SAFE], null), SAFE, "the profile's wallet first");
  assert.equal(pickWallet([PROXY, DEPOSIT], null), DEPOSIT, "else the first that trades");
  assert.equal(pickWallet([SAFE, DEPOSIT], DEPOSIT.address.toLowerCase()), DEPOSIT, "the person's pick");
  assert.equal(pickWallet([SAFE], DEPOSIT.address), SAFE, "a pick no longer listed falls back");
  assert.equal(pickWallet([], null), null);
});

test("sends the wallet with prepare, and checks wallet moves before preparing them", () => {
  const ticket = { ...DEFAULT_TICKET, marketId: "666861", outcome: "Yes", amount: "20" };
  assert.equal(ticketRequest(ticket, "eip155:137:0xF6d143B21Ce3b07DAE3AE0fa23B65e0449e21dC0", false, SAFE.address).wallet, SAFE.address);
  assert.equal("wallet" in ticketRequest(ticket, null, false, SAFE.address), false, "a quote names no account or wallet");
  assert.deepEqual(moveProblems({ action: "withdraw", asset: "pUSD", amount: "10" }, SAFE), []);
  assert.deepEqual(moveProblems({ action: "withdraw", asset: "pUSD", amount: "10" }, DEPOSIT), ["Kletia does not build this move for this wallet; do it on polymarket.com."]);
  assert.deepEqual(moveProblems({ action: "wrap", asset: "pUSD", amount: "1" }, SAFE), ["Wrapping turns USDC.e into pUSD."]);
  assert.deepEqual(moveProblems({ action: "deposit", asset: "pUSD", amount: "-1" }, SAFE), ["Enter a positive amount (up to 6 decimals)."]);
  assert.deepEqual(moveProblems({ action: "deposit", asset: "pUSD", amount: "1" }, null), ["Pick your Polymarket wallet."]);
});

test("lists open orders with side, price and fill", () => {
  const [row] = openOrderRows([{ id: "0xabc", status: "LIVE", outcome: "Yes", side: "buy", price: 0.04, shares: 50, filledShares: 10 }]);
  assert.deepEqual(row, { id: "0xabc", side: "Buy", outcome: "Yes", price: "4¢", filled: "10 of 50", status: "live" });
});
