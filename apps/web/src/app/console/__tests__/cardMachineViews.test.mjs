// Card machine views: the pure parts behind Trade, Portfolio and Automate.
// The price tape keeps only reads this browser made; leverage detents never collide; the
// liquidation sentence measures the move from entry; the binder files only settled tasks, with
// foils earned by facts; the schedule dial reads the real next run.
import assert from "node:assert/strict";
import test from "node:test";

import { leverageDetents, liquidationMove } from "../perps/perpsModel.ts";
import { addTapePoint, tapeChart } from "../trade/tapeModel.ts";
import { binderCounts, binderEntries, binderEntry, filterBinder, shareFileName } from "../dashboard/binderModel.ts";
import { dialCaption, scheduleFraction } from "../automations/automationModel.ts";

test("the tape keeps reads in time order, drops repeats and bad prices, and stays short", () => {
  let tape = addTapePoint([], { t: 1000, p: 2300 });
  tape = addTapePoint(tape, { t: 1000, p: 2301 });
  tape = addTapePoint(tape, { t: 900, p: 2302 });
  tape = addTapePoint(tape, { t: 2000, p: Number.NaN });
  tape = addTapePoint(tape, { t: 2000, p: 0 });
  tape = addTapePoint(tape, { t: 2000, p: 2310 });
  assert.deepEqual(tape, [{ t: 1000, p: 2300 }, { t: 2000, p: 2310 }]);
  let long = [];
  for (let index = 0; index < 300; index += 1) long = addTapePoint(long, { t: index + 1, p: 100 + index });
  assert.equal(long.length, 240);
  assert.equal(long[0].t, 61);
});

test("the tape chart fits the reads and the levels in one range, and draws no line from one read", () => {
  assert.equal(tapeChart([], []), null);
  const single = tapeChart([{ t: 1, p: 100 }], [{ id: "mark", label: "Mark", price: 100, tone: "mark" }]);
  assert.equal(single.path, null, "one read is not a line");
  assert.equal(single.levels.length, 1);
  const chart = tapeChart(
    [{ t: 1, p: 100 }, { t: 2, p: 110 }],
    [{ id: "liq", label: "Liq", price: 80, tone: "liq" }],
  );
  assert.ok(chart.path.startsWith("M0.00 "));
  assert.ok(chart.min < 80 && chart.max > 110, "padded around the liquidation level");
  const liq = chart.levels.find((level) => level.id === "liq");
  assert.ok(liq.y > 90 && liq.y < 100, "the liquidation line sits near the bottom, never on the edge");
  assert.equal(chart.head.x, 100);
});

test("leverage detents start at 1x, end at the cap and never crowd each other", () => {
  assert.deepEqual(leverageDetents(1), [1]);
  assert.deepEqual(leverageDetents(2), [1, 2]);
  assert.deepEqual(leverageDetents(20), [1, 5, 10, 20]);
  assert.deepEqual(leverageDetents(40), [1, 10, 20, 40]);
  for (const cap of [2, 3, 5, 7, 10, 20, 25, 40, 50, 100]) {
    const marks = leverageDetents(cap);
    assert.equal(marks[0], 1);
    assert.equal(marks[marks.length - 1], cap);
    assert.ok(marks.length <= 5);
    for (let index = 1; index < marks.length; index += 1) assert.ok(marks[index] > marks[index - 1]);
  }
});

test("the liquidation move is the distance from entry to the liquidation price, or none", () => {
  assert.equal(liquidationMove(2000, null), null);
  assert.equal(liquidationMove(0, 1500), null);
  assert.equal(liquidationMove(2000, 1360), 0.32);
  assert.equal(liquidationMove(100, 125), 0.25, "a short is liquidated above entry");
});

const task = (overrides) => ({
  id: "4f2c9a1e-0000-4000-8000-00000000c21e",
  createdAt: Date.UTC(2026, 9, 23, 10),
  sentence: "",
  title: "Swap 0.4 SOL to USDC",
  departure: "auto",
  lane: "production",
  engine: { kind: "platform" },
  intentId: "int_1",
  status: "completed",
  question: null,
  turns: [],
  ends: { from: "solana", to: "solana" },
  ...overrides,
});

test("the binder files settled tasks only, newest first, with their real route and a foil earned by crossing networks", () => {
  const tasks = [
    task({ id: "a-1", createdAt: 1, title: "Bridge 25 USDC from Base to Solana", ends: { from: "base", to: "solana" } }),
    task({ id: "a-2", createdAt: 3, status: "failed" }),
    task({ id: "a-3", createdAt: 2 }),
    task({ id: "a-4", createdAt: 4, status: "review" }),
  ];
  const entries = binderEntries(tasks);
  assert.deepEqual(entries.map((entry) => entry.id), ["a-3", "a-1"]);
  const bridge = entries[1];
  assert.equal(bridge.kind, "Bridge");
  assert.equal(bridge.group, "moves");
  assert.deepEqual(bridge.route, ["base", "solana"]);
  assert.equal(bridge.sub, "Base to Solana");
  assert.equal(bridge.foil, "holo");
  assert.equal(bridge.tag, "cross-chain");
  const swap = entries[0];
  assert.equal(swap.foil, null);
  assert.deepEqual(swap.route, ["solana"]);
  assert.equal(binderEntry(task({ ends: null })).sub, null, "no networks named: no route is invented");
  assert.deepEqual(binderEntry(task({ ends: null })).route, []);
});

test("binder filters and counts follow the card kinds", () => {
  const entries = binderEntries([
    task({ id: "s", title: "Swap 1 ETH to USDC" }),
    task({ id: "b", title: "Bridge 5 USDC to Arbitrum", ends: { from: "base", to: "arbitrum" } }),
    task({ id: "p", title: "Long ETH 3x on GMX" }),
    task({ id: "k", title: "Stake 1.5 SOL" }),
    task({ id: "x", title: "Check my balances" }),
  ]);
  const counts = binderCounts(entries);
  assert.deepEqual(counts, { all: 5, swaps: 1, moves: 1, trades: 1, earn: 1 });
  assert.deepEqual(filterBinder(entries, "earn").map((entry) => entry.id), ["k"]);
  assert.equal(filterBinder(entries, "all").length, 5, "all shows every card, other kinds too");
  assert.equal(shareFileName({ serial: "C21E" }), "kletia-card-C21E.png");
});

test("the schedule dial reads how far the period has run from the real next run, and parks otherwise", () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const weekly = { trigger: { kind: "schedule", every: { unit: "week", count: 1 } }, status: "active", nextRunAt: new Date(now + 1.75 * 86_400_000).toISOString() };
  assert.equal(scheduleFraction(weekly, now), 0.75);
  assert.equal(scheduleFraction({ ...weekly, status: "paused" }, now), null);
  assert.equal(scheduleFraction({ ...weekly, nextRunAt: null }, now), null);
  assert.equal(scheduleFraction({ trigger: { kind: "price", asset: "SOL", direction: "below", priceUsd: "120" }, status: "active", nextRunAt: null }, now), null);
  assert.equal(scheduleFraction({ ...weekly, nextRunAt: new Date(now - 1000).toISOString() }, now), 1, "an overdue run reads full, never past");
  assert.equal(dialCaption(weekly.trigger), "1 week");
  assert.equal(dialCaption({ kind: "schedule", every: { unit: "day", count: 2 } }), "2 days");
  assert.equal(dialCaption({ kind: "apy", asset: "USDC", minDeltaBps: 50 }), "rate");
});
