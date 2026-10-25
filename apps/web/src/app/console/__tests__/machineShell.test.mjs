// The machine shell (the Card machine): what the rail, the LCD and the panel read
// from the desk's real state. Nothing is invented: unknown readings are null ("—").
//   node --test apps/web/src/app/console/__tests__/machineShell.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  activeTask,
  balanceSummary,
  binderStack,
  cardKind,
  formatHeight,
  formatUptime,
  healthHeights,
  lcdRows,
  machineLegs,
  printerState,
  quoteCount,
  settledTasks,
  shortSerial,
  statusTone,
  todayRows,
} from "../shell/machine/machineModel.ts";

const task = (id, status, extra = {}) => ({ id, status, createdAt: extra.createdAt ?? 1, title: extra.title ?? "", sentence: extra.sentence ?? "", intentId: extra.intentId ?? null, ends: extra.ends ?? null, ...extra });

test("the binder is the settled tasks: the last three, newest on top, with a kind, a serial and the route", () => {
  const tasks = [
    task("a-0001", "completed", { createdAt: 1, title: "Swap 1 SOL to USDC", ends: { from: "solana", to: "solana" } }),
    task("b-0002", "failed", { createdAt: 2, title: "Bridge 5 USDC" }),
    task("c-0003", "completed", { createdAt: 3, title: "Bridge 100 USDC from Arbitrum to Base", ends: { from: "arbitrum", to: "base" } }),
    task("d-0004", "completed", { createdAt: 4, title: "Long ETH 3x" }),
    task("e-0005", "completed", { createdAt: 5, title: "Stake 1.5 SOL" }),
  ];
  assert.equal(settledTasks(tasks).length, 4);
  const stack = binderStack(tasks);
  assert.deepEqual(stack.map((card) => card.id), ["c-0003", "d-0004", "e-0005"], "oldest of the three at the back, newest on top");
  assert.deepEqual(stack.map((card) => card.kind), ["Bridge", "Perp", "Stake"]);
  assert.equal(stack[0].sub, "Arbitrum → Base");
  assert.equal(stack[0].serial, "0003");
  assert.equal(binderStack([]).length, 0);
  assert.equal(cardKind("Something else"), "Card");
  assert.equal(shortSerial("int_7f3ac21e"), "C21E");
});

test("the LCD prints quotes from tasks, the block height and uptime from health, and nothing it does not know", () => {
  const tasks = [task("a", "completed", { intentId: "int_1" }), task("b", "planning"), task("c", "review", { intentId: "int_2" })];
  assert.equal(quoteCount(tasks), 2);
  const rows = lcdRows({ tasks, heights: { base: "23481207" }, uptimeSeconds: 41 * 86400 + 6 * 3600 + 59 });
  assert.deepEqual(rows.map((row) => [row.label, row.value]), [["QUOTES", "2"], ["BASE BLK", "23,481,207"], ["UPTIME", "41D 06H"]]);
  const unknown = lcdRows({ tasks: [], heights: {}, uptimeSeconds: null });
  assert.deepEqual(unknown.map((row) => row.value), ["0", null, null]);
  assert.equal(formatHeight("12a"), null);
  assert.equal(formatUptime(3720), "01H 02M");
  assert.deepEqual(healthHeights([{ network: "base", height: "100" }, { network: "mars", height: "1" }, { network: "solana" }]), { base: "100" });
});

test("the printer works while a task plans or executes, jams only when the active task failed, idles otherwise", () => {
  const failed = task("f", "failed");
  assert.equal(printerState([task("a", "planning")], null), "working");
  assert.equal(printerState([failed], failed), "jam");
  assert.equal(printerState([task("a", "completed")], task("a", "completed")), "idle");
  assert.equal(printerState([], null), "idle");
  const tasks = [task("a", "completed"), task("b", "review"), task("c", "executing")];
  assert.equal(activeTask(tasks, "c", "a").id, "c", "the signing task first");
  assert.equal(activeTask(tasks, null, "a").id, "a", "then the focused one");
  assert.equal(activeTask(tasks, null, null).id, "c", "then the newest");
  assert.equal(statusTone(task("q", "question")), "magenta");
  assert.equal(statusTone(task("p", "planning")), "blue");
  assert.equal(statusTone(null), "on");
});

test("Now: a leg is done only when the API settled or confirmed its step", () => {
  const steps = [
    { id: "s2", index: 1, title: "Swap on Uniswap v4", network: "base", status: "pending", input: { symbol: "USDC", formatted: "750" } },
    { id: "s1", index: 0, title: "Bridge on Across", network: "arbitrum", status: "submitted", settlement: { destinationNetwork: "base" }, input: { symbol: "USDC", formatted: "1500" } },
    { id: "s3", index: 2, title: "Keep the rest", network: "base", status: "settled" },
  ];
  const legs = machineLegs(steps, { s2: "signing" });
  assert.deepEqual(legs.map((leg) => [leg.id, leg.state, leg.word]), [["s1", "active", "sent"], ["s2", "active", "signing"], ["s3", "done", "done"]]);
  assert.equal(legs[0].detail, "Arbitrum → Base · 1500 USDC");
  assert.equal(machineLegs([{ id: "x", index: 0, title: "t", network: "base", status: "pending" }])[0].state, "queued");
  assert.equal(machineLegs([{ id: "x", index: 0, title: "t", network: "base", status: "indeterminate" }])[0].word, "unknown");
});

test("balances come from the holdings read, largest first, with proportion bars; no read prints no total", () => {
  assert.deepEqual(balanceSummary(null), { total: null, rows: [], networks: 0 });
  const summary = balanceSummary({ base: { totalUsd: 9810.4, stale: false }, arbitrum: { totalUsd: 6412.8, stale: true }, polygon: { totalUsd: 0, stale: false } });
  assert.equal(summary.total, 16223.2);
  assert.equal(summary.networks, 3);
  assert.deepEqual(summary.rows.map((row) => [row.network, Math.round(row.share * 100)]), [["base", 100], ["arbitrum", 65]]);
  assert.equal(summary.rows[1].stale, true);
});

test("today on chain reads network health: answering, fastest and slowest (or who is down)", () => {
  assert.deepEqual(todayRows({}, null).map((row) => row.value), [null, null, null]);
  const rows = todayRows({ base: { ok: true, latencyMs: 80 }, solana: { ok: true, latencyMs: 210 }, polygon: { ok: false, latencyMs: 900 } }, ["base", "solana", "polygon"]);
  assert.deepEqual(rows.map((row) => [row.label, row.value]), [["Networks answering", "2 of 3"], ["Fastest RPC", "Base · 80 ms"], ["Not answering", "Polygon"]]);
});
