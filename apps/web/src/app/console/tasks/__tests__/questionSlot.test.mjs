// The desk's question slot and per-task memory: one card per task (two independent questions in
// it at most), four chips then "Other…" except network questions, which show
// every network offered; the Editing chip only for planned tasks and
// follow-ups; turns carry the task's own thread; the thread stays in memory.
// Run with
//   node --test apps/web/src/app/console/tasks/__tests__/questionSlot.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { DESK_SESSION_KEY } from "../../state/deskSession.ts";
import { createDeskStore, isEditable } from "../../state/deskStore.ts";
import {
  answerLabel,
  deskQuestionFrom,
  editsTask,
  isNetworkQuestion,
  OTHER_OPTION_ID,
  QUESTION_CHIPS,
  questionCard,
  responseLabel,
  turnAnswer,
  turnRequest,
} from "../questionModel.ts";
import { isDeskQuestion } from "../slots.ts";

const THREAD = {
  spec: "kletia.thread/v1",
  id: "th_abcdefghijklmnopqrstuvwx",
  rev: 1,
  status: "needs_input",
  policy: "2026-10.1",
  steps: [],
  open: ["actions[0].amount"],
  corrections: [],
  turns: [{ role: "kletia", kind: "message", label: "Asked how much SOL" }],
  undo: [],
};

function needsInput(questions, summary = "Swap SOL to USDC on Solana") {
  return { status: "needs_input", turn: "message", questions, assumptions: [], draft: { summary, sentence: null, missing: [], steps: [] }, thread: THREAD };
}

const amount = {
  id: "q.actions.0.amount",
  field: "actions[0].amount",
  kind: "amount",
  reason: "AMOUNT_MISSING",
  purpose: false,
  prompt: "How much SOL?",
  why: "You hold 2.5 SOL on Solana.",
  options: [
    { id: "all", label: "All · 2.49 SOL", detail: "Keeps 0.01 SOL for network fees" },
    { id: "half", label: "Half · 1.25 SOL" },
  ],
  allowsText: true,
  placeholder: "Amount in SOL",
};

const NETWORKS = ["arbitrum", "ethereum", "optimism", "polygon", "solana"];
const destination = {
  id: "q.actions.0.toNetwork",
  field: "actions[0].toNetwork",
  kind: "choice",
  reason: "DESTINATION_MISSING",
  purpose: false,
  prompt: "Where should the USDC go?",
  why: "",
  options: NETWORKS.map((network) => ({ id: network, label: network, network })),
  allowsText: true,
};

const venue = {
  id: "q.actions.0.protocol",
  field: "actions[0].protocol",
  kind: "choice",
  reason: "VENUE_MISSING",
  purpose: true,
  prompt: "Where should 100 USDC earn yield on Base?",
  why: "Each venue has its own rate and risks; rates are variable.",
  options: ["aave-v3", "compound-v3", "moonwell", "morpho", "spark-savings", "fluid"].map((id, index) => ({ id, label: id, ...(index === 0 ? { recommended: true } : {}) })),
  allowsText: false,
};

test("B01: one question becomes one desk card with All and Half and free text", () => {
  const question = deskQuestionFrom(needsInput([amount]));
  assert.ok(isDeskQuestion(question), "the slot accepts it");
  assert.equal(question.kind, "clarify");
  assert.equal(question.prompt, "How much SOL?");
  assert.deepEqual(question.options.map((option) => option.id), ["all", "half"]);
  assert.equal(question.allowsText, true);
  const card = questionCard(question, false);
  assert.equal(card.title, "One question");
  assert.deepEqual(card.options.map((option) => option.id), ["all", "half"]);
  assert.deepEqual(turnAnswer(question, { optionId: "all" }), { question: "q.actions.0.amount", option: "all" });
  assert.deepEqual(turnAnswer(question, { text: " 0.5 " }), { question: "q.actions.0.amount", text: "0.5" });
  assert.equal(answerLabel(question, { optionId: "all" }), "All · 2.49 SOL");
  assert.equal(responseLabel(needsInput([amount])), "How much SOL?");
});

test("D06: two independent questions share one card per task; network questions show every network", () => {
  const question = deskQuestionFrom(needsInput([destination, amount], "Bridge USDC from Base"));
  assert.equal(question.questions.length, 2, "one card carries both questions");
  const card = questionCard(question, false);
  assert.equal(card.title, "Two quick details");
  assert.ok(isNetworkQuestion(destination));
  assert.deepEqual(card.questions[0].options.map((option) => option.id), NETWORKS, "no network hides behind Other…");
  assert.ok(card.questions[0].options.length > QUESTION_CHIPS);
  // An answer names its own question; without one it answers the first.
  assert.deepEqual(turnAnswer(question, { optionId: "solana", questionId: "q.actions.0.toNetwork" }), { question: "q.actions.0.toNetwork", option: "solana" });
  assert.deepEqual(turnAnswer(question, { text: "all", questionId: "q.actions.0.amount" }), { question: "q.actions.0.amount", text: "all" });
  assert.deepEqual(turnAnswer(question, { optionId: "solana", questionId: "q.someone.else" }), { question: "q.actions.0.toNetwork", option: "solana" });
  // A third question never makes a second card: the view keeps two at most.
  const three = deskQuestionFrom(needsInput([destination, amount, venue]));
  assert.equal(three.questions.length, 2);
});

test("I02: four chips and then Other…, which only expands the card and is never sent", () => {
  const question = deskQuestionFrom(needsInput([venue]));
  const card = questionCard(question, false);
  assert.equal(card.options.length, QUESTION_CHIPS + 1);
  assert.equal(card.options.at(-1).id, OTHER_OPTION_ID);
  assert.equal(card.options[0].recommended, true, "the suggested venue stays first and marked");
  assert.equal(turnAnswer(question, { optionId: OTHER_OPTION_ID }), null);
  assert.equal(questionCard(question, true).options.length, 6, "expanded: every venue");
});

test("E09: a transfer network question lists the networks with no suggestion", () => {
  const transfer = {
    ...destination,
    id: "q.actions.0.network",
    field: "actions[0].network",
    reason: "TRANSFER_NETWORK",
    prompt: "Which network should the 5 USDC go out on?",
    options: [{ id: "base", label: "Base", network: "base", recommended: true }, { id: "arbitrum", label: "Arbitrum One", network: "arbitrum" }],
  };
  const card = questionCard(deskQuestionFrom(needsInput([transfer])), false);
  assert.deepEqual(card.options.map((option) => option.id), ["base", "arbitrum"]);
  assert.ok(card.options.every((option) => option.recommended !== true), "never a suggestion where a wrong network loses funds");
});

test("nothing to show is not a question: planned, cancelled and empty asks", () => {
  assert.equal(deskQuestionFrom({ status: "cancelled", turn: "control", thread: THREAD }), null);
  assert.equal(deskQuestionFrom(needsInput([])), null);
  assert.equal(isDeskQuestion({ id: "x", kind: "journey", prompt: "Gas?", options: [{ id: "ok", label: "OK" }], allowsText: false }), false, "journey prompts never use the desk slot");
});

test("turns carry the task's own thread: the sentence first, then the thread with one input", () => {
  const context = { accounts: ["eip155:8453:0x1111111111111111111111111111111111111111"], sourceNetwork: "auto", metadata: { surface: "console" } };
  assert.deepEqual(turnRequest(context, null, { kind: "none" }, "swap SOL to USDC"), { ...context, text: "swap SOL to USDC" });
  const answer = turnRequest(context, THREAD, { kind: "answer", answer: { question: "q.actions.0.amount", option: "all" } }, "swap SOL to USDC");
  assert.equal(answer.thread, THREAD);
  assert.equal(answer.text, undefined, "an answer never resends the sentence");
  assert.deepEqual(answer.answer, { question: "q.actions.0.amount", option: "all" });
  assert.deepEqual(turnRequest(context, THREAD, { kind: "text", text: "make it 2" }, "x").text, "make it 2");
  assert.deepEqual(turnRequest(context, THREAD, { kind: "assumption", id: "a.actions.0.network", option: "arbitrum" }, "x").assumption, { id: "a.actions.0.network", option: "arbitrum" });
  const commit = turnRequest(context, THREAD, { kind: "none" }, "x");
  assert.equal("text" in commit || "answer" in commit || "assumption" in commit, false, "the commit turn has no input");
});

test("the Editing chip: only a planned task, only follow-ups (or when armed), never a complete sentence", () => {
  const planned = { status: "preview", engine: { kind: "platform" }, sentence: "swap 1 SOL to USDC" };
  assert.equal(editsTask("make it 2", planned, false), true, "L01: an edit");
  assert.equal(editsTask("undo", planned, false), true, "L14: a control");
  assert.equal(editsTask("cancel", planned, false), true, "L05: a control");
  assert.equal(editsTask("and send it to 0x1111111111111111111111111111111111111111", planned, false), true, "an append");
  assert.equal(editsTask("swap 1 SOL to USDC", planned, false), false, "a complete sentence is a new task");
  assert.equal(editsTask("swap 1 SOL to USDC", planned, true), true, "the Edit button arms the chip on purpose");
  assert.equal(editsTask("make it 2", { ...planned, status: "executing" }, false), false, "never while signing");
  assert.equal(editsTask("make it 2", { ...planned, engine: { kind: "network" } }, false), false);
  assert.equal(editsTask("make it 2", { ...planned, sentence: "" }, false), false, "a restored task has no sentence to edit");
  assert.equal(editsTask("make it 2", null, false), false);
});

function memoryStorage() {
  const items = new Map();
  return { items, getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => void items.set(key, String(value)), removeItem: (key) => void items.delete(key) };
}

test("TaskRecord.thread lives in memory only, per task, and the Editing chip follows the task's state", () => {
  const storage = memoryStorage();
  let counter = 0;
  const store = createDeskStore({ storage, newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, now: () => 1, departureStorage: { read: () => null, write: () => undefined } });
  const first = store.getState().addTask({ sentence: "swap SOL to USDC", departure: "auto" });
  const second = store.getState().addTask({ sentence: "bridge USDC from base", departure: "auto" });
  store.getState().patchTask(first.id, { thread: THREAD, status: "question", question: deskQuestionFrom(needsInput([amount])) });
  const tasks = store.getState().tasks;
  assert.equal(tasks.find((task) => task.id === first.id).thread, THREAD);
  assert.equal(tasks.find((task) => task.id === second.id).thread, null, "a task's thread never reaches another task");
  const persisted = storage.items.get(DESK_SESSION_KEY);
  assert.ok(persisted && !persisted.includes("kletia.thread") && !persisted.includes(THREAD.id), "the tab's index never stores the thread");
  assert.ok(!persisted.includes("How much SOL"), "nor the question");
  // Editing: armed only for a task that can still change, cleared when it starts signing.
  store.getState().patchTask(first.id, { status: "preview", question: null });
  assert.equal(isEditable(store.getState().tasks.find((task) => task.id === first.id)), true);
  store.getState().edit(first.id);
  assert.equal(store.getState().editing, first.id);
  store.getState().patchTask(first.id, { status: "executing" });
  assert.equal(store.getState().editing, null, "a signing task is never edited");
  store.getState().edit(first.id);
  assert.equal(store.getState().editing, null);
});
