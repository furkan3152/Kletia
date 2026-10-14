/**
 * Clarifying questions in the SDK (clarify design 7.1): `intents.turn` request
 * shapes and `status` narrowing, `threads.*`, the retry classes of turns and
 * the mapping of the clarify error codes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KletiaApiError, KletiaClient, turnRetryClass } from "../dist/index.js";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
const THREAD_ID = "th_abcdefghijklmnopqrstuvwx";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-c", ...headers } });
}

function recorder(script, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return step();
    },
  });
  return { client, calls };
}

const thread = (rev, status = "needs_input") => ({
  spec: "kletia.thread/v1",
  id: THREAD_ID,
  rev,
  status,
  policy: "2026-10.1",
  steps: [],
  open: status === "needs_input" ? ["actions[0].amount"] : [],
  corrections: [],
  turns: [],
  undo: [],
});

const needsInput = {
  status: "needs_input",
  turn: "message",
  questions: [
    {
      id: "q.actions.0.amount",
      field: "actions[0].amount",
      kind: "amount",
      reason: "AMOUNT_MISSING",
      purpose: true,
      prompt: "How much SOL?",
      why: "You hold 2.5 SOL on Solana.",
      options: [{ id: "all", label: "All · 2.49 SOL", sentence: "swap 2.49 SOL to USDC on solana" }],
      allowsText: true,
    },
  ],
  assumptions: [],
  draft: { summary: "Swap SOL to USDC on Solana", sentence: null, missing: ["actions[0].amount"], steps: [] },
  thread: thread(1),
};

const planned = {
  status: "planned",
  turn: "answer",
  sentence: "swap 2.49 SOL to USDC on solana",
  assumptions: [{ id: "a.actions.0.amount", field: "actions[0].amount", label: "All your SOL: 2.49", reason: "x", source: "balance", material: true, alternatives: [] }],
  intent: { id: "int_c", steps: [] },
  thread: thread(2, "ready"),
};

test("intents.turn posts ?clarify=true with dryRun and preview; the result narrows on status", async () => {
  const { client, calls } = recorder([() => jsonResponse(200, needsInput), () => jsonResponse(200, planned)]);
  const first = await client.intents.turn({ text: "swap SOL to USDC", accounts: [ACCOUNT] }, { dryRun: true, preview: true });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.pathname, "/v1/intents");
  assert.equal(calls[0].url.searchParams.get("clarify"), "true");
  assert.equal(calls[0].url.searchParams.get("dryRun"), "true");
  assert.equal(calls[0].url.searchParams.get("preview"), "true");
  assert.deepEqual(calls[0].body, { text: "swap SOL to USDC", accounts: [ACCOUNT] });
  assert.equal(first.status, "needs_input");
  if (first.status !== "needs_input") throw new Error("narrowing");
  const question = first.questions[0];
  const next = await client.intents.turn({ thread: first.thread, accounts: [ACCOUNT], answer: { question: question.id, option: "all" } }, { dryRun: true, journey: true });
  assert.deepEqual(calls[1].body.answer, { question: "q.actions.0.amount", option: "all" });
  assert.equal(calls[1].body.thread.rev, 1, "the client-held thread goes back exactly as returned");
  assert.equal(calls[1].url.searchParams.get("journey"), "true");
  assert.equal(calls[1].url.searchParams.get("preview"), "true", "the journey implies the preview");
  assert.equal(next.status, "planned");
  assert.equal(next.sentence, "swap 2.49 SOL to USDC on solana");
});

test("intents.turn refuses thread and threadId together, and malformed thread ids, before sending", async () => {
  const { client, calls } = recorder([() => jsonResponse(200, needsInput)]);
  await assert.rejects(client.intents.turn({ thread: thread(1), threadId: THREAD_ID }), TypeError);
  await assert.rejects(client.intents.turn({ threadId: "th_../../keys" }), TypeError);
  assert.equal(calls.length, 0);
});

test("turnRetryClass: Kletia-held turns need an Idempotency-Key, client-held dry runs are safe", () => {
  assert.equal(turnRetryClass({ text: "swap", remember: true }, { dryRun: true }), "idempotent");
  assert.equal(turnRetryClass({ threadId: THREAD_ID, answer: { question: "q.x", option: "all" } }, { dryRun: true }), "idempotent");
  assert.equal(turnRetryClass({ text: "swap" }, { dryRun: true }), "safe");
  assert.equal(turnRetryClass({ thread: thread(1) }, { dryRun: true }), "safe");
  assert.equal(turnRetryClass({ thread: thread(2, "ready") }), "idempotent", "a commit stores an intent");
});

test("retries: a keyless dry-run turn is retried; a keyless Kletia-held turn is not; a keyed one reuses its key", async () => {
  const flaky = () => jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "0" });
  const dry = recorder([flaky, () => jsonResponse(200, needsInput)]);
  const result = await dry.client.intents.turn({ text: "swap SOL to USDC", accounts: [ACCOUNT] }, { dryRun: true });
  assert.equal(result.status, "needs_input");
  assert.equal(dry.calls.length, 2);
  assert.equal(dry.calls[0].headers["idempotency-key"], undefined);

  const held = recorder([flaky, () => jsonResponse(200, needsInput)]);
  await assert.rejects(held.client.intents.turn({ threadId: THREAD_ID, answer: { question: "q.actions.0.amount", option: "all" } }, { dryRun: true }), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(held.calls.length, 1, "no Idempotency-Key, no retry: the thread may have moved");

  const keyed = recorder([flaky, () => jsonResponse(200, needsInput)], { apiKey: "kl_dev_test" });
  await keyed.client.intents.turn({ text: "swap SOL to USDC", accounts: [ACCOUNT], remember: true }, { dryRun: true });
  assert.equal(keyed.calls.length, 2);
  assert.ok(keyed.calls[0].headers["idempotency-key"]);
  assert.equal(keyed.calls[0].headers["idempotency-key"], keyed.calls[1].headers["idempotency-key"]);
});

test("clarify refusals map to KletiaApiError with catalogue metadata", async () => {
  for (const [status, code, category] of [
    [409, "THREAD_CONFLICT", "conflict"],
    [404, "THREAD_NOT_FOUND", "not_found"],
    [400, "THREAD_REQUIRES_API_KEY", "request"],
    [422, "ANSWER_INVALID", "intent"],
    [409, "QUESTION_NOT_OPEN", "conflict"],
    [400, "MESSAGE_SECRET_REFUSED", "request"],
  ]) {
    const { client } = recorder([() => jsonResponse(status, { error: { code, message: code } })]);
    const error = await client.intents.turn({ text: "swap SOL to USDC" }).catch((caught) => caught);
    assert.ok(error instanceof KletiaApiError, code);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.category, category, code);
    assert.equal(error.retryable, false, code);
  }
});

test("threads.list, get and delete call the key's thread routes; ids are checked first", async () => {
  const { client, calls } = recorder([
    () => jsonResponse(200, { threads: [{ id: THREAD_ID, rev: 2, status: "ready", expiresAt: "x", summary: "Swap", updatedAt: "y" }], nextCursor: null }),
    () => jsonResponse(200, { thread: thread(2, "ready"), response: planned }),
    () => new Response(null, { status: 204 }),
  ], { apiKey: "kl_dev_test" });
  const list = await client.threads.list({ status: "ready", limit: 5, cursor: "c1" });
  assert.equal(list.threads[0].id, THREAD_ID);
  assert.equal(calls[0].url.pathname, "/v1/threads");
  assert.equal(calls[0].url.searchParams.get("status"), "ready");
  assert.equal(calls[0].url.searchParams.get("limit"), "5");
  assert.equal(calls[0].url.searchParams.get("cursor"), "c1");
  const detail = await client.threads.get(THREAD_ID);
  assert.equal(detail.thread.rev, 2);
  assert.equal(calls[1].url.pathname, `/v1/threads/${THREAD_ID}`);
  await client.threads.delete(THREAD_ID);
  assert.equal(calls[2].method, "DELETE");
  assert.throws(() => client.threads.get("th_bad"), TypeError);
  await assert.rejects(client.threads.delete("../keys"), TypeError);
  assert.equal(calls.length, 3);
});
