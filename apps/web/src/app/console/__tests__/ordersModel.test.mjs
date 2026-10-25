// The Orders view's model: the form to the /v1/orders body (and the problem
// shown instead), grouping and summaries of listed orders, list failures,
// what each step asks of the wallet, and typed data in the shape wallets
// sign. Run with
//   node --test apps/web/src/app/console/__tests__/ordersModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { protocolBadge } from "../../pages/protocols/protocolBadge.ts";
import { deskLocationOf } from "../hooks/deskUrl.ts";
import { composerVerdict } from "../state/deskModel.ts";
import {
  EMPTY_ORDER_FORM,
  failureLine,
  filledPercent,
  formatPeriod,
  groupOrders,
  invertPrice,
  orderErrorMessage,
  orderRequestBody,
  priceOrientation,
  orderSummary,
  ownerFor,
  stepAction,
  walletOnly,
  walletTypedData,
} from "../orders/ordersModel.ts";

const SOL = "9v3JUtVwZ6N7MLRonkCdLVjpuP3tMJBJvo9ATWRpXhj9";
const EVM = "0x0ab2e96e042a7402af586bdd1e12020a0a8011e7";
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function amount(formatted, symbol, raw) {
  return { symbol, formatted, amount: raw };
}

function order(extra) {
  return {
    id: "jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G",
    protocol: "jupiter-trigger",
    mechanism: "limit",
    network: "solana",
    owner: SOL,
    status: "open",
    sell: amount("25", "USDC", "25000000"),
    buy: amount("702.730179", "61V8…pump", "702730179"),
    sold: amount("10", "USDC", "10000000"),
    bought: amount("0", "61V8…pump", "0"),
    createdAt: "2026-10-23T10:00:00.000Z",
    expiresAt: null,
    schedule: null,
    cancellable: true,
    ...extra,
  };
}

test("a limit form becomes the API body; buy-side limits count the amount bought", () => {
  const form = { ...EMPTY_ORDER_FORM, sell: "USDC", buy: "JUP", side: "buy", amount: "1000", price: "0.8", expiryDays: "7" };
  assert.deepEqual(orderRequestBody(form, SOL, NOW), {
    body: { owner: SOL, network: "solana", sell: "USDC", buy: "JUP", amount: "1000", kind: "limit", amountIn: "buy", price: "0.8", expiresAt: NOW / 1000 + 7 * 86_400 },
  });
  assert.deepEqual(orderRequestBody({ ...form, expiryDays: "" }, SOL, NOW).body.expiresAt, undefined);
});

test("a DCA form sends period and count, never a price", () => {
  const form = { ...EMPTY_ORDER_FORM, mode: "dca", sell: "USDC", buy: "SOL", amount: "500", price: "9", period: "day", count: "10" };
  assert.deepEqual(orderRequestBody(form, SOL, NOW), { body: { owner: SOL, network: "solana", sell: "USDC", buy: "SOL", amount: "500", kind: "dca", period: "day", count: 10 } });
});

test("the form names its first problem and sends nothing", () => {
  assert.match(orderRequestBody(EMPTY_ORDER_FORM, null).problem, /Connect a Solana wallet/u);
  assert.match(orderRequestBody({ ...EMPTY_ORDER_FORM, network: "base" }, null).problem, /^Connect an EVM wallet to place orders on base\.$/u);
  assert.equal(orderRequestBody({ ...EMPTY_ORDER_FORM, amount: "0" }, SOL).problem, "Enter a positive amount.");
  assert.equal(orderRequestBody({ ...EMPTY_ORDER_FORM, amount: "1" }, SOL).problem, "Enter the limit price.");
  assert.equal(orderRequestBody({ ...EMPTY_ORDER_FORM, buy: "sol", amount: "1", price: "1" }, SOL).problem, "Sell and buy different assets.");
  assert.equal(orderRequestBody({ ...EMPTY_ORDER_FORM, amount: "1", price: "1", expiryDays: "400" }, SOL).problem, "Expiry is 1-365 days, or empty.");
  assert.equal(orderRequestBody({ ...EMPTY_ORDER_FORM, mode: "dca", amount: "1", count: "1" }, SOL).problem, "Split the DCA into 2-1000 parts.");
});

test("the signing wallet follows the network", () => {
  assert.equal(ownerFor("solana", { evm: EVM, solana: SOL }), SOL);
  assert.equal(ownerFor("arbitrum", { evm: EVM, solana: SOL }), EVM);
  assert.equal(ownerFor("base", { evm: null, solana: SOL }), null);
});

test("orders group by state, newest first, and read as one line", () => {
  const groups = groupOrders([
    order({ id: "a", status: "filled", createdAt: "2026-10-20T00:00:00.000Z" }),
    order({ id: "b" }),
    order({ id: "c", status: "expired" }),
    order({ id: "d", status: "cancelled", createdAt: "2026-10-23T11:00:00.000Z" }),
    order({ id: "e", status: "unknown" }),
  ]);
  assert.deepEqual([groups.open, groups.filled, groups.closed, groups.unknown].map((group) => group.map((entry) => entry.id)), [["b"], ["a"], ["d", "c"], ["e"]]);
  assert.equal(orderSummary(order({})), "Sell 25 USDC for at least 702.730179 61V8…pump");
  assert.equal(filledPercent(order({})), 40);
  const dca = order({ mechanism: "recurring", buy: null, bought: amount("4.1", "SOL", "4100000000"), schedule: { perPart: amount("50", "USDC", "50000000"), periodSeconds: 86_400 } });
  assert.equal(orderSummary(dca), "50 USDC into SOL every day (25 USDC in total)");
  assert.equal(formatPeriod(1_200), "20 minutes");
  assert.equal(formatPeriod(90), "90 s");
});

test("unreadable protocols are named, never shown as no orders", () => {
  assert.equal(failureLine({ protocol: "cow-protocol", network: "base", code: "PROVIDER_UNAVAILABLE", message: "CoW is down." }), "Could not read CoW Protocol on base: CoW is down.");
});

test("steps say what the wallet does; Safe-only preparations stay in the Safe", () => {
  assert.equal(stepAction({ kind: "eip712" }), "Sign the order (no gas)");
  assert.equal(stepAction({ kind: "evm-transaction" }), "Send the approval");
  assert.equal(stepAction({ kind: "safe-transaction" }), "Execute in your Safe");
  assert.equal(walletOnly({ submit: "wallet" }), true);
});

test("typed data reaches the wallet with integers as bigint", () => {
  const typed = {
    domain: { name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" },
    types: { Order: [{ name: "sellAmount", type: "uint256" }, { name: "validTo", type: "uint32" }, { name: "kind", type: "string" }] },
    primaryType: "Order",
    message: { sellAmount: "500000000000000000", validTo: 1792770788, kind: "sell" },
  };
  const wallet = walletTypedData(typed);
  assert.equal(wallet.message.sellAmount, 500000000000000000n);
  assert.equal(wallet.message.validTo, 1792770788n);
  assert.equal(wallet.message.kind, "sell");
  assert.equal(typed.message.sellAmount, "500000000000000000", "the API payload is not mutated");
});

test("the Orders view has its path, its desk command and its protocol badge", () => {
  assert.deepEqual(deskLocationOf("/app/orders"), { view: "orders", toolId: null });
  assert.deepEqual(composerVerdict("show my orders"), { kind: "command", view: "orders" });
  assert.equal(protocolBadge({ category: "intent-network", surface: "orders", executable: false, capabilities: ["execute"] }).kind, "orders");
});

test("order failures say what happened in the API's words; other errors stay generic", () => {
  const relay = { code: "ORDER_RELAY_FAILED", status: 502, unreachable: false, message: "The order was not placed on CoW Protocol: it could not be reached. Nothing was sold. Try again shortly." };
  assert.equal(orderErrorMessage(relay), relay.message);
  assert.equal(orderErrorMessage({ code: "INTERNAL_ERROR", status: 500, unreachable: false, message: "Unexpected platform error." }), null);
  assert.equal(orderErrorMessage({ code: "ORDER_RELAY_FAILED", status: 0, unreachable: true, message: "x" }), null);
});

test("the limit price reads naturally (no stablecoin priced in a volatile asset), flips, and reaches the API in its orientation", () => {
  const usdcToWeth = { ...EMPTY_ORDER_FORM, network: "base", sell: "USDC", buy: "WETH", amount: "20", price: "2222" };
  assert.deepEqual(priceOrientation(usdcToWeth), { counted: "USDC", per: "WETH", api: false });
  // The API prices the amount's asset (USDC) in WETH: 1/2222, rounded so the seller gets at least the price typed.
  const body = orderRequestBody(usdcToWeth, EVM).body;
  assert.equal(body.price, invertPrice("2222", "up"));
  assert.match(body.price, /^0\.000450045004500450045004500450045/u);
  assert.ok(Number(body.price) * 2222 >= 1);
  // Selling SOL for USDC: the price of SOL in USDC, as the API takes it.
  assert.deepEqual(priceOrientation({ ...EMPTY_ORDER_FORM, price: "150" }), { counted: "USDC", per: "SOL", api: true });
  // The flip toggle turns it round, and the API still gets its own orientation.
  const flipped = { ...usdcToWeth, priceFlipped: true, price: "0.00045" };
  assert.deepEqual(priceOrientation(flipped), { counted: "WETH", per: "USDC", api: true });
  assert.equal(orderRequestBody(flipped, EVM).body.price, "0.00045");
  assert.equal(invertPrice("0.8", "down"), "1.25");
});
