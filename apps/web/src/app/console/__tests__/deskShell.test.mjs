// The desk's URL state (console design 3.13), its slots (3.11), the holdings
// refresh schedule (3.9) and the preview accounts read from core. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_ACCOUNT_IDS } from "@kletia/core";

import {
  DESK_VIEW_PATHS,
  deskLocationOf,
  deskPathOf,
  readDeskSearch,
  searchWithDeparture,
  searchWithoutQuery,
} from "../hooks/deskUrl.ts";
import { HoldingsSchedule } from "../hooks/holdingsSchedule.ts";
import { DEFAULT_DESK_SLOTS, getDeskSlots, isDeskQuestion, registerDeskSlots, subscribeDeskSlots } from "../tasks/slots.ts";
import { PREVIEW_ACCOUNTS, previewAccountsForLane } from "../../../shared/platform/previewAccounts.ts";

test("every /app view maps to its path and back; unknown paths are the desk", () => {
  for (const [view, path] of Object.entries(DESK_VIEW_PATHS)) {
    assert.deepEqual(deskLocationOf(path), { view, toolId: null });
    assert.equal(deskPathOf({ view, toolId: null }), path);
  }
  assert.deepEqual(deskLocationOf("/app"), { view: "desk", toolId: null });
  assert.deepEqual(deskLocationOf("/app/"), { view: "desk", toolId: null });
  assert.deepEqual(deskLocationOf("/app/classic"), { view: "desk", toolId: null });
  assert.deepEqual(deskLocationOf("/app/tools/x402"), { view: "tools", toolId: "x402" });
  assert.deepEqual(deskLocationOf("/app/tools/%3Cscript%3E"), { view: "tools", toolId: null });
  assert.deepEqual(deskLocationOf("/app/tools/%E0%A4%A"), { view: "tools", toolId: null });
  assert.equal(deskPathOf({ view: "tools", toolId: "jupiter-swap" }), "/app/tools/jupiter-swap");
  assert.equal(deskPathOf({ view: "desk", toolId: null }), "/app");
});

test("?q plans once (removed afterwards); ?from takes a network key or auto, nothing else", () => {
  assert.deepEqual(readDeskSearch("?q=swap%201%20SOL%20to%20USDC&from=solana"), { q: "swap 1 SOL to USDC", from: "solana" });
  assert.deepEqual(readDeskSearch("?from=arc"), { q: null, from: "arc" });
  assert.deepEqual(readDeskSearch("?from=auto"), { q: null, from: "auto" });
  assert.deepEqual(readDeskSearch("?from=mars&q=%20%20"), { q: null, from: null });
  assert.equal(readDeskSearch(`?q=${"a".repeat(501)}`).q, null);
  assert.equal(searchWithoutQuery("?q=swap&from=base"), "?from=base");
  assert.equal(searchWithoutQuery("?q=swap"), "");
  assert.equal(searchWithDeparture("", "base"), "?from=base");
  assert.equal(searchWithDeparture("?from=base&x=1", "auto"), "?x=1");
});

test("slots render nothing by default; a registration wins and can be undone", () => {
  assert.equal(getDeskSlots(), DEFAULT_DESK_SLOTS);
  assert.equal(DEFAULT_DESK_SLOTS.Journey({}), null);
  assert.equal(DEFAULT_DESK_SLOTS.Question({}), null);
  let notified = 0;
  const unsubscribe = subscribeDeskSlots(() => {
    notified += 1;
  });
  const Journey = () => "journey";
  const restore = registerDeskSlots({ Journey });
  assert.equal(getDeskSlots().Journey, Journey);
  assert.equal(getDeskSlots().Question, DEFAULT_DESK_SLOTS.Question);
  restore();
  assert.equal(getDeskSlots(), DEFAULT_DESK_SLOTS);
  unsubscribe();
  assert.equal(notified, 2);
});

test("desk questions are clarify questions only", () => {
  const question = { id: "q1", kind: "clarify", prompt: "Which USDC?", options: [{ id: "a", label: "USDC" }], allowsText: false };
  assert.equal(isDeskQuestion(question), true);
  assert.equal(isDeskQuestion({ ...question, kind: "journey" }), false);
  assert.equal(isDeskQuestion({ ...question, kind: "source" }), false);
  assert.equal(isDeskQuestion({ ...question, options: [] }), false);
  assert.equal(isDeskQuestion({ ...question, options: [], allowsText: true }), true);
});

/** Manual timers for the schedule. */
function clock() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    fire() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, timer] of pending) timer.callback();
    },
    get size() {
      return timers.size;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a settled step's invalidations (a bridge sends two) read holdings exactly once", async () => {
  const timers = clock();
  const reads = [];
  const schedule = new HoldingsSchedule({ read: async (reason) => void reads.push(reason), ...timers });
  schedule.request("invalidated");
  schedule.request("invalidated");
  assert.equal(reads.length, 0);
  timers.fire();
  await tick();
  assert.deepEqual(reads, ["invalidated"]);
  assert.equal(timers.size, 0);
});

test("nothing is read while a task signs; what waited reads once when the lock is released", async () => {
  const timers = clock();
  const reads = [];
  const schedule = new HoldingsSchedule({ read: async (reason) => void reads.push(reason), ...timers });
  schedule.setSigning(true);
  schedule.request("invalidated");
  schedule.request("accounts");
  schedule.request("invalidated");
  timers.fire();
  await tick();
  assert.deepEqual(reads, []);
  schedule.setSigning(false);
  await tick();
  assert.deepEqual(reads, ["accounts"]);
  schedule.setSigning(true);
  schedule.setSigning(false);
  await tick();
  assert.equal(reads.length, 1, "no read without a request");
});

test("the refresh button reads at once; a request during a read runs once after it", async () => {
  const timers = clock();
  const reads = [];
  let release;
  const schedule = new HoldingsSchedule({
    read: (reason) => {
      reads.push(reason);
      return reads.length === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve();
    },
    ...timers,
  });
  schedule.request("manual");
  schedule.request("lane");
  schedule.request("accounts");
  assert.deepEqual(reads, ["manual"]);
  release();
  await tick();
  await tick();
  assert.deepEqual(reads, ["manual", "lane"], "the two waiting requests read once");
  schedule.dispose();
  schedule.request("manual");
  assert.equal(reads.length, 2);
});

test("preview accounts come from core and are homed per lane", () => {
  assert.deepEqual([PREVIEW_ACCOUNTS.evm, PREVIEW_ACCOUNTS.solana], [...PREVIEW_ACCOUNT_IDS]);
  assert.deepEqual(previewAccountsForLane("production"), [...PREVIEW_ACCOUNT_IDS]);
  const [evm, solana] = previewAccountsForLane("testnet");
  assert.ok(evm.startsWith("eip155:5042002:") && evm.endsWith(PREVIEW_ACCOUNTS.evm.split(":")[2]));
  assert.ok(solana.startsWith("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:"), solana);
});

test("the desk's view paths are the pre-rendered console views", async () => {
  const { CONSOLE_VIEW_PATHS } = await import("../../routes/routeTable.ts");
  assert.deepEqual(Object.values(DESK_VIEW_PATHS).sort(), [...CONSOLE_VIEW_PATHS].sort());
});
