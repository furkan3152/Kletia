// The desk's tab history and store: redacted titles, a cap of 20 that drops
// finished tasks first, the one-time pick-up of Studio and Solana Ask
// resume records, and the store's signing lock.
import assert from "node:assert/strict";
import test from "node:test";

import {
  capTasks,
  DESK_SESSION_KEY,
  deskIntentSessionKey,
  importLegacyResumeRecords,
  isResumable,
  MAX_TASKS,
  parseTaskIndex,
  readTaskIndex,
  serializeTaskIndex,
  writeTaskIndex,
} from "../state/deskSession.ts";
import { createDeskStore, restoreTask, tasksNewestFirst } from "../state/deskStore.ts";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-10-14T12:00:00Z");

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

function ids() {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
}

function task(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    createdAt: NOW,
    sentence: `send 25.5 USDC to ${RECIPIENT} on base`,
    title: `Send 25.5 USDC to ${RECIPIENT} on Base`,
    departure: "base",
    lane: "production",
    engine: { kind: "platform" },
    intentId: "int_live_1",
    status: "review",
    question: { id: "q1", kind: "clarify", prompt: "Which one?", options: [], allowsText: true },
    turns: [{ kind: "sentence", at: NOW }, { kind: "answer", at: NOW, label: "USDC on Base" }],
    ends: { from: "base", to: "base" },
    ...overrides,
  };
}

const studioRecord = (intentId, savedAt = NOW - 60_000) =>
  JSON.stringify({ v: 1, intentId, savedAt, signing: { s1: "requested" }, references: { s1: ["5".repeat(64)] } });

test("the index keeps redacted titles only: the sentence, the question and the turns never reach storage", () => {
  const raw = serializeTaskIndex([task()]);
  assert.ok(!raw.includes("25.5"), "amounts are redacted");
  assert.ok(!raw.includes(RECIPIENT), "recipients are redacted");
  assert.ok(!raw.includes("Which one?"), "questions stay in memory");
  assert.ok(!raw.includes("USDC on Base"), "answers stay in memory");
  const [entry] = parseTaskIndex(raw);
  assert.equal(entry.title, "Send ••• USDC to ••• on Base");
  assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "departure", "ends", "engine", "id", "intentId", "lane", "status", "title"]);
  assert.equal(JSON.parse(raw).v, 1);
});

test("at most 20 tasks: finished ones go first, oldest first, and an executing task is never dropped", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${String(index).padStart(4, "0")}`,
    createdAt: NOW + index,
    status: index === 0 ? "executing" : index % 2 === 0 ? "completed" : "review",
  }));
  const { kept, dropped } = capTasks(tasks);
  assert.equal(kept.length, MAX_TASKS);
  assert.deepEqual(dropped.map((entry) => entry.id), ["task-0002", "task-0004", "task-0006", "task-0008", "task-0010"]);
  assert.ok(kept.some((entry) => entry.id === "task-0000"), "the executing task is kept");
  const active = Array.from({ length: 22 }, (_, index) => ({ id: `t-${index}`, createdAt: NOW + index, status: index === 0 ? "executing" : "review" }));
  assert.deepEqual(capTasks(active).dropped.map((entry) => entry.id), ["t-1", "t-2"], "with no finished task, the oldest of the rest go, never the executing one");
  assert.equal(capTasks(tasks.slice(0, 3)).dropped.length, 0);
});

test("a stored index is parsed strictly: bad entries, duplicates and unknown versions are dropped; titles are redacted again", () => {
  const good = { id: "00000000-0000-4000-8000-000000000001", createdAt: NOW, title: "Swap 1 SOL to USDC", departure: "auto", lane: "production", engine: { kind: "network", network: "arc", why: "tool" }, intentId: null, status: "engine", ends: null };
  const raw = JSON.stringify({
    v: 1,
    tasks: [
      good,
      good,
      { ...good, id: "x" },
      { ...good, id: "00000000-0000-4000-8000-000000000002", departure: "mars" },
      { ...good, id: "00000000-0000-4000-8000-000000000003", engine: { kind: "network", network: "polygon", why: "tool" } },
      { ...good, id: "00000000-0000-4000-8000-000000000004", status: "exploded" },
      { ...good, id: "00000000-0000-4000-8000-000000000005", intentId: "int <script>" },
      { ...good, id: "00000000-0000-4000-8000-000000000006", ends: { from: "base", to: "nowhere" } },
      { ...good, id: "00000000-0000-4000-8000-000000000007", title: `send 9 USDC to ${RECIPIENT}`, ends: { from: "base", to: "solana" }, origin: "studio" },
    ],
  });
  const entries = parseTaskIndex(raw);
  assert.deepEqual(entries.map((entry) => entry.id), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000007"]);
  assert.equal(entries[1].title, "send ••• USDC to •••");
  assert.equal(entries[1].origin, "studio");
  assert.deepEqual(entries[0].engine, { kind: "network", network: "arc", why: "tool" });
  for (const bad of [null, "", "{", JSON.stringify({ v: 2, tasks: [good] }), JSON.stringify({ v: 1, tasks: "no" }), JSON.stringify([good])]) {
    assert.deepEqual(parseTaskIndex(bad), [], String(bad));
  }
});

test("without a browser the default tab storage reads as empty and writes nothing", () => {
  assert.deepEqual(readTaskIndex(), []);
  assert.doesNotThrow(() => writeTaskIndex([task()]));
});

test("a pending Studio or Solana Ask record becomes a paused task once; the record moves unchanged and the old key is cleared", () => {
  const storage = memoryStorage({
    "kletia-studio-intent": studioRecord("int_live_studio"),
    "kletia-solana-ask-intent": studioRecord("int_live_ask"),
  });
  const newId = ids();
  const imported = importLegacyResumeRecords({ existing: [], storage, newId, now: NOW });
  assert.deepEqual(imported.map((entry) => [entry.title, entry.intentId, entry.status, entry.origin]), [
    ["Picked up from Studio", "int_live_studio", "paused", "studio"],
    ["Picked up from the Solana Ask tab", "int_live_ask", "paused", "solana-ask"],
  ]);
  assert.equal(storage.getItem("kletia-studio-intent"), null);
  assert.equal(storage.getItem("kletia-solana-ask-intent"), null);
  assert.equal(storage.getItem(deskIntentSessionKey(imported[0].id)), studioRecord("int_live_studio"), "signing marks and references move with the record");
  assert.ok(imported.every((entry) => isResumable(entry)));
  assert.deepEqual(importLegacyResumeRecords({ existing: imported, storage, newId, now: NOW }), [], "only once");
});

test("expired, malformed or already tracked legacy records are cleared without a task", () => {
  const storage = memoryStorage({
    "kletia-studio-intent": studioRecord("int_old", NOW - 25 * 60 * 60 * 1000),
    "kletia-solana-ask-intent": "{not json",
  });
  assert.deepEqual(importLegacyResumeRecords({ existing: [], storage, newId: ids(), now: NOW }), []);
  assert.equal(storage.items.size, 0);
  const tracked = memoryStorage({ "kletia-studio-intent": studioRecord("int_known") });
  assert.deepEqual(importLegacyResumeRecords({ existing: [{ intentId: "int_known" }], storage: tracked, newId: ids(), now: NOW }), []);
  assert.equal(tracked.items.size, 0);
});

test("after a reload a persisted intent comes back paused, previews and planning are not restored, questions are cleared", () => {
  const entry = (status, intentId = "int_live_1") => ({ id: "00000000-0000-4000-8000-000000000001", createdAt: NOW, title: "t", departure: "auto", lane: "production", engine: { kind: "platform" }, intentId, status, ends: null });
  assert.equal(restoreTask(entry("executing")).status, "paused");
  assert.equal(restoreTask(entry("review")).status, "paused");
  assert.equal(restoreTask(entry("paused")).status, "paused");
  assert.equal(restoreTask(entry("executing", null)).status, "cancelled", "nothing to resume without a persisted intent");
  assert.equal(restoreTask(entry("preview", null)), null);
  assert.equal(restoreTask(entry("planning", null)), null);
  assert.equal(restoreTask(entry("completed")).status, "completed");
  const question = restoreTask(entry("question", null));
  assert.equal(question.status, "question");
  assert.equal(question.question, null);
  assert.equal(question.sentence, "");
  assert.equal(question.restored, true);
});

test("the store restores the tab, picks up legacy records and writes the redacted index on every change", () => {
  const stored = JSON.stringify({ v: 1, tasks: [
    { id: "00000000-0000-4000-8000-000000000101", createdAt: NOW - 5000, title: "Bridge 25 USDC", departure: "base", lane: "production", engine: { kind: "platform" }, intentId: "int_live_9", status: "executing", ends: { from: "base", to: "solana" } },
    { id: "00000000-0000-4000-8000-000000000102", createdAt: NOW - 4000, title: "Swap 1 SOL", departure: "auto", lane: "production", engine: { kind: "platform" }, intentId: null, status: "preview", ends: null },
  ] });
  const storage = memoryStorage({ [DESK_SESSION_KEY]: stored, "kletia-studio-intent": studioRecord("int_live_studio") });
  const store = createDeskStore({ storage, newId: ids(), now: () => NOW, departureStorage: { read: () => "polygon", write: () => undefined } });
  const state = store.getState();
  assert.deepEqual(state.tasks.map((entry) => [entry.status, entry.intentId, entry.restored]), [
    ["paused", "int_live_9", true],
    ["paused", "int_live_studio", true],
  ]);
  assert.equal(state.departure, "polygon");
  assert.equal(state.signingTaskId, null, "nothing signs after a reload until the user resumes");
  const index = parseTaskIndex(storage.getItem(DESK_SESSION_KEY));
  assert.equal(index.length, 2);
  state.addTask({ sentence: `send 7 USDC to ${RECIPIENT} on arc`, departure: "arc" });
  const raw = storage.getItem(DESK_SESSION_KEY);
  assert.ok(!raw.includes(RECIPIENT) && !raw.includes(" 7 "), "the new task's title is redacted in the index");
  const added = store.getState().tasks.at(-1);
  assert.equal(added.sentence, `send 7 USDC to ${RECIPIENT} on arc`, "the sentence stays in memory");
  assert.equal(added.lane, "testnet");
  assert.equal(added.status, "planning");
  assert.equal(store.getState().focusedTaskId, added.id);
  assert.deepEqual(tasksNewestFirst(store.getState()).map((entry) => entry.id)[0], added.id);
});

test("one task signs at a time; the lock is released when its task leaves executing; a signing task is never removed", () => {
  const storage = memoryStorage();
  const store = createDeskStore({ storage, newId: ids(), now: () => NOW, departureStorage: { read: () => null, write: () => undefined } });
  const first = store.getState().addTask({ sentence: "swap 1 SOL to USDC", departure: "auto" });
  const second = store.getState().addTask({ sentence: "bridge 25 USDC from base to solana", departure: "auto" });
  assert.equal(store.getState().acquireSigning(first.id), true);
  store.getState().patchTask(first.id, { title: "Swap 1 SOL to USDC", intentId: "int_live_1" });
  assert.equal(store.getState().signingTaskId, first.id, "the lock survives updates before execution starts");
  assert.equal(store.getState().acquireSigning(first.id), true, "re-acquiring by the holder is fine");
  assert.equal(store.getState().acquireSigning(second.id), false, "a second task cannot sign while the first does");
  assert.equal(store.getState().acquireSigning("unknown"), false);
  store.getState().patchTask(first.id, { status: "executing" });
  assert.equal(store.getState().removeTask(first.id), false);
  store.getState().clearFinished();
  assert.ok(store.getState().tasks.some((entry) => entry.id === first.id));
  store.getState().patchTask(first.id, { status: "completed", intentId: "int_live_2" });
  assert.equal(store.getState().signingTaskId, null, "released when the task leaves executing");
  assert.equal(store.getState().acquireSigning(second.id), true);
  store.getState().releaseSigning(first.id);
  assert.equal(store.getState().signingTaskId, second.id, "only the holder releases");
  store.getState().patchTask(second.id, { status: "failed" });
  assert.equal(store.getState().signingTaskId, null, "a task that fails before executing releases the lock too");
  const third = store.getState().addTask({ sentence: "stake 1.5 SOL with marinade", departure: "auto" });
  store.getState().acquireSigning(third.id);
  store.getState().patchTask(third.id, { status: "executing" });
  store.getState().patchTask(third.id, { status: "paused" });
  assert.equal(store.getState().signingTaskId, null, "a paused execution gives the lock back; resuming acquires it again");
  store.getState().releaseSigning(third.id);
});

test("clearing finished tasks also forgets their resume records; the composer answers only an open question", () => {
  const storage = memoryStorage();
  const store = createDeskStore({ storage, newId: ids(), now: () => NOW, departureStorage: { read: () => null, write: () => undefined } });
  const done = store.getState().addTask({ sentence: "swap 1 SOL to USDC", departure: "auto" });
  storage.setItem(deskIntentSessionKey(done.id), studioRecord("int_live_3"));
  store.getState().patchTask(done.id, { status: "completed" });
  const asking = store.getState().addTask({ sentence: "send 5 USDC to vitalik.eth", departure: "auto" });
  store.getState().answer(asking.id);
  assert.equal(store.getState().answering, null, "no open question: nothing to answer");
  store.getState().patchTask(asking.id, { status: "question", question: { id: "q", kind: "clarify", prompt: "Which network?", options: [{ id: "base", label: "Base", network: "base" }], allowsText: true } });
  store.getState().answer(asking.id);
  assert.equal(store.getState().answering, asking.id);
  store.getState().patchTask(asking.id, { question: null, status: "planning", turn: { kind: "answer", at: NOW, label: "Base" } });
  assert.equal(store.getState().answering, null, "answering ends with the question");
  assert.equal(store.getState().tasks.find((entry) => entry.id === asking.id).turns.length, 2);
  store.getState().clearFinished();
  assert.equal(storage.getItem(deskIntentSessionKey(done.id)), null);
  assert.deepEqual(store.getState().tasks.map((entry) => entry.id), [asking.id]);
});

test("the departure is stored per browser and only valid values are accepted; tools pin an engine for the next task only", () => {
  const writes = [];
  const store = createDeskStore({ storage: memoryStorage(), newId: ids(), now: () => NOW, departureStorage: { read: () => "not-a-network", write: (value) => writes.push(value) } });
  assert.equal(store.getState().departure, "auto");
  store.getState().setDeparture("solana-devnet");
  store.getState().setDeparture("mars");
  assert.equal(store.getState().departure, "solana-devnet");
  assert.deepEqual(writes, ["solana-devnet"]);
  store.getState().pinEngine("arc");
  store.getState().pinEngine("polygon");
  assert.equal(store.getState().enginePin, "arc");
  store.getState().openTool("arc-contracts");
  assert.deepEqual([store.getState().view, store.getState().toolId], ["tools", "arc-contracts"]);
  const pinned = store.getState().addTask({ sentence: "stake 1 USDC in kletia staking", departure: "arc", engine: { kind: "network", network: "arc", why: "tool" } });
  assert.equal(store.getState().enginePin, null, "the pin applies to one task");
  assert.deepEqual(pinned.engine, { kind: "network", network: "arc", why: "tool" });
  store.getState().setView("desk");
  assert.equal(store.getState().toolId, null);
});
