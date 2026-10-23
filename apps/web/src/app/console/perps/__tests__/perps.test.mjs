// The Perps view's model: the ticket and its request, client checks, the
// market table, position rows (PnL, liquidation distance, close requests),
// the account a venue signs with, the signing run's states, and the view's
// copy rules (plain English, no emoji, no em dash).
import assert from "node:assert/strict";
import test from "node:test";

import { PERPS_VENUES } from "@kletia/core";

import { DESK_VIEW_PATHS, deskLocationOf } from "../../hooks/deskUrl.ts";
import { PERPS_COPY } from "../perpsCopy.ts";
import {
  DEFAULT_TICKET,
  collateralAmount,
  formatPnl,
  formatPrice,
  formatRate,
  leverageCap,
  marketRows,
  nextStep,
  perpsAccountFor,
  positionRequest,
  positionRows,
  preparedExpired,
  startRun,
  ticketProblems,
  ticketRequest,
  ticketSizeUsd,
  tradableSymbols,
  withStepState,
} from "../perpsModel.ts";

const market = (venue, symbol, overrides = {}) => ({
  venue,
  symbol,
  marketId: `${venue}-${symbol}`,
  network: venue === "drift-v2" ? "solana" : "arbitrum",
  markPrice: 2404.4,
  fundingRate1h: { long: 0.0000125, short: -0.0000125 },
  openInterestUsd: { long: 1.2e9, short: 1.3e9 },
  maxLeverage: 25,
  maintenanceMarginRate: 0.02,
  takerFeeRate: 0.00045,
  impactPer10kUsd: 0,
  minSizeUsd: 10,
  minCollateralUsd: 0,
  observedAt: 0,
  open: true,
  ...overrides,
});

const MARKETS = [market("hyperliquid", "ETH"), market("gmx-v2", "ETH", { maxLeverage: 100, fundingRate1h: { long: -0.00001, short: 0.00002 } }), market("hyperliquid", "SOL", { open: false })];

test("the ticket turns into the API request, with the venue pinned only for prepare", () => {
  const ticket = { ...DEFAULT_TICKET, collateral: "100.", leverage: 5 };
  assert.equal(collateralAmount("100."), "100");
  assert.equal(collateralAmount("1,5"), null);
  assert.equal(collateralAmount("0"), null);
  assert.equal(ticketSizeUsd(ticket), 500);
  assert.deepEqual(ticketRequest(ticket, null, null), { action: "open", symbol: "ETH", side: "long", collateral: { asset: "USDC", amount: "100" }, leverage: 5, slippageBps: 50 });
  assert.deepEqual(ticketRequest(ticket, "gmx-v2", "eip155:42161:0xabc").venue, "gmx-v2");
  assert.equal(ticketRequest(ticket, "gmx-v2", "eip155:42161:0xabc").account, "eip155:42161:0xabc");
});

test("leverage caps and client checks mirror the venues (the API checks again)", () => {
  assert.equal(leverageCap(PERPS_VENUES, MARKETS, { symbol: "ETH", venue: "best" }), 20, "never above the default rule book cap");
  assert.equal(leverageCap(PERPS_VENUES, [market("hyperliquid", "BTC", { maxLeverage: 10 })], { symbol: "BTC", venue: "hyperliquid" }), 10);
  assert.equal(leverageCap(PERPS_VENUES, MARKETS, { symbol: "DOGE", venue: "best" }), 1);
  assert.deepEqual(ticketProblems({ ...DEFAULT_TICKET, collateral: "" }, PERPS_VENUES, MARKETS), ["Enter the USDC collateral."]);
  assert.deepEqual(ticketProblems({ ...DEFAULT_TICKET, collateral: "4", venue: "hyperliquid", leverage: 2 }, PERPS_VENUES, MARKETS), ["Hyperliquid needs at least 5 USDC of collateral.", "Hyperliquid needs a position of at least 10 USD."]);
  assert.match(ticketProblems({ ...DEFAULT_TICKET, collateral: "100", leverage: 30 }, PERPS_VENUES, MARKETS)[0], /20x cap/u);
  assert.match(ticketProblems({ ...DEFAULT_TICKET, collateral: "100", venue: "drift-v2" }, PERPS_VENUES, MARKETS)[0], /read-only/u);
  assert.deepEqual(ticketProblems({ ...DEFAULT_TICKET, collateral: "100", leverage: 3 }, PERPS_VENUES, MARKETS), []);
});

test("market rows: grouped by symbol, cheapest long funding first, compact open interest", () => {
  const rows = marketRows(MARKETS, PERPS_VENUES);
  assert.deepEqual(rows.map((row) => [row.symbol, row.venueName, row.fundingTone]), [["ETH", "GMX v2", "earns"], ["ETH", "Hyperliquid", "pays"], ["SOL", "Hyperliquid", "pays"]]);
  assert.equal(rows[1].mark, "$2,404.40");
  assert.equal(rows[1].funding, "+0.0013%");
  assert.equal(rows[1].openInterest, "$2.50B");
  assert.equal(rows[2].open, false);
  assert.deepEqual(tradableSymbols(MARKETS), ["ETH"]);
  assert.equal(formatPrice(104.2731), "$104.2731");
  assert.equal(formatPrice(0.1234567), "$0.123457");
  assert.equal(formatRate(-0.0000125), "-0.0013%");
  assert.equal(formatPnl(12.3), "+$12.30");
  assert.equal(formatPnl(-4), "-$4.00");
});

test("position rows warn near liquidation, show PnL tone, and build close and reduce requests", () => {
  const short = { venue: "hyperliquid", symbol: "ETH", marketId: "ETH", network: "arbitrum", side: "short", sizeUsd: 1000, sizeBase: 0.4159, collateralUsd: 40, entryPrice: 2404.4, markPrice: 2500, leverage: 25, liquidationPrice: 2560, unrealizedPnlUsd: -39.76 };
  const drift = { ...short, venue: "drift-v2", collateralUsd: null, markPrice: null, liquidationPrice: null, unrealizedPnlUsd: null };
  const [row, halted] = positionRows([short, drift], PERPS_VENUES);
  assert.equal(row.nearLiquidation, true);
  assert.ok(Math.abs(row.liquidationDistancePct - 2.4) < 1e-9);
  assert.equal(row.pnl, "-$39.76");
  assert.equal(row.pnlTone, "loss");
  assert.equal(row.closable, true);
  assert.equal(halted.closable, false, "a disabled venue offers no close");
  assert.equal(halted.pnlTone, "unknown");
  assert.equal(halted.mark, "-");
  assert.deepEqual(positionRequest(short, "close", "eip155:42161:0xabc"), { action: "close", symbol: "ETH", side: "short", venue: "hyperliquid", account: "eip155:42161:0xabc" });
  assert.equal(positionRequest({ ...short, sizeUsd: 1000.03 }, "reduce", "eip155:42161:0xabc").sizeUsd, "500.01");
});

test("each venue signs with the wallet of its network", () => {
  const wallets = { evm: "0xabc", solana: "9WzD" };
  assert.equal(perpsAccountFor({ network: "arbitrum" }, wallets), "eip155:42161:0xabc");
  assert.equal(perpsAccountFor({ network: "solana" }, wallets), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzD");
  assert.equal(perpsAccountFor({ network: "arbitrum" }, { evm: null, solana: "9WzD" }), null);
});

test("the signing run moves one step at a time and stops at a failure", () => {
  const steps = [{ kind: "transaction", id: "deposit", title: "Deposit", transaction: {} }, { kind: "typed-data", id: "order", title: "Order", typedData: {}, relay: {} }];
  let run = startRun(steps);
  assert.equal(nextStep(run), 0);
  run = withStepState(run, 0, "done");
  assert.equal(nextStep(run), 1);
  run = withStepState(run, 1, "failed", "Hyperliquid refused the order: insufficient margin");
  assert.equal(nextStep(run), -1);
  assert.match(run.error, /insufficient margin/u);
  assert.equal(nextStep(withStepState(withStepState(startRun(steps), 0, "done"), 1, "done")), -1);
  assert.equal(preparedExpired(100, 99_000), false);
  assert.equal(preparedExpired(100, 100_000), true);
});

test("the Perps view has its own desk path", () => {
  assert.equal(DESK_VIEW_PATHS.perps, "/app/perps");
  assert.deepEqual(deskLocationOf("/app/perps"), { view: "perps", toolId: null });
});

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/u;
const PLAIN = /^[\x20-\x7E·…]*$/u;

function strings(value, path = "PERPS_COPY") {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") return [[`${path}()`, value(...Array.from({ length: value.length }, () => "3"))]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => strings(entry, `${path}.${key}`));
  return [];
}

test("every Perps string is plain English, with the risk copy present", () => {
  const all = strings(PERPS_COPY);
  assert.ok(all.length > 60);
  for (const [path, text] of all) {
    assert.ok(text.length > 0 && text === text.trim(), path);
    assert.ok(!EMOJI.test(text) && !text.includes("—") && PLAIN.test(text), `${path}: ${text}`);
  }
  assert.ok(Object.isFrozen(PERPS_COPY.risk.lines));
  assert.match(PERPS_COPY.risk.lines.join(" "), /liquidation price is an estimate/u);
});
