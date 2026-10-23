// Hand-offs on the desk (round 9): a sentence read as a perps trade, a native
// order or an automation opens that view prefilled, and the desk commands
// open the Perps view. Run with
//   node --test apps/web/src/app/console/__tests__/handoffModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { automationPrefill, handoffLine, orderPrefill, perpsPrefill } from "../handoff/handoffModel.ts";
import { EMPTY_ORDER_FORM } from "../orders/ordersModel.ts";
import { DEFAULT_TICKET } from "../perps/perpsModel.ts";
import { composerVerdict } from "../state/deskModel.ts";

test("a perps hand-off fills the ticket; close and reduce point at the position", () => {
  const open = perpsPrefill({ market: "ETH", side: "long", action: "open", collateral: "100", leverage: 5 });
  assert.deepEqual(open.ticket, { ...DEFAULT_TICKET, symbol: "ETH", side: "long", venue: "best", collateral: "100", leverage: 5 });
  assert.equal(open.position, null);
  const named = perpsPrefill({ market: "BTC", side: "short", action: "open", collateral: "50", sizeUsd: "500", leverage: 10, venue: "hyperliquid" });
  assert.equal(named.ticket.venue, "hyperliquid");
  const close = perpsPrefill({ market: "SOL", side: "short", action: "decrease", sizeUsd: "100" });
  assert.deepEqual(close.position, { action: "decrease", symbol: "SOL", side: "short", sizeUsd: "100" });
});

test("an order hand-off fills the Orders form, or says why the form cannot hold it", () => {
  const limit = orderPrefill({ action: "create", protocol: "cow-protocol", network: "base", order: { kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", network: "base" } }, EMPTY_ORDER_FORM, 0);
  assert.ok("form" in limit);
  assert.equal(limit.form.mode, "limit");
  assert.equal(limit.form.network, "base");
  assert.equal(limit.form.price, "4000");
  const dca = orderPrefill({ action: "create", protocol: "jupiter-recurring", network: "solana", order: { kind: "dca", sell: "USDC", buy: "SOL", amount: "500", period: "day", count: 10, network: "solana" } }, EMPTY_ORDER_FORM, 0);
  assert.ok("form" in dca);
  assert.equal(dca.form.count, "10");
  assert.equal(dca.form.period, "day");
  const monthly = orderPrefill({ action: "create", protocol: "jupiter-recurring", network: "solana", order: { kind: "dca", sell: "USDC", buy: "SOL", amount: "500", period: "month", count: 3 } }, EMPTY_ORDER_FORM, 0);
  assert.ok("problem" in monthly);
  const cancel = orderPrefill({ action: "cancel", orderId: "jupiter-trigger:solana:abc" }, EMPTY_ORDER_FORM, 0);
  assert.match("problem" in cancel ? cancel.problem : "", /jupiter-trigger:solana:abc/u);
  const expiring = orderPrefill({ action: "create", protocol: "jupiter-trigger", network: "solana", order: { kind: "limit", sell: "SOL", buy: "USDC", amount: "1", price: "200", expiresAt: new Date(7 * 86_400_000).toISOString() } }, EMPTY_ORDER_FORM, 0);
  assert.equal("form" in expiring ? expiring.form.expiryDays : "", "7");
});

test("an automation hand-off carries the validated draft, and the thread says nothing was signed", () => {
  const draft = { trigger: { kind: "schedule", every: { unit: "week", count: 1 }, startAt: "2026-10-05T09:00:00.000Z" }, action: { kind: "intent", text: "swap 50 USDC to ETH on base", accounts: [] }, limits: { expiresAt: "2027-04-03T00:00:00.000Z" } };
  assert.equal(automationPrefill({ draft }), draft);
  assert.match(handoffLine({ surface: "perps", summary: "Long ETH 5x with 100 USDC" }), /Opened in Perps.*Nothing was signed here/u);
});

test("show my perps and show my positions open the Perps view", () => {
  assert.deepEqual(composerVerdict("show my perps"), { kind: "command", view: "perps" });
  assert.deepEqual(composerVerdict("Show my positions"), { kind: "command", view: "perps" });
});
