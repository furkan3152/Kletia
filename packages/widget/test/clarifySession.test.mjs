/**
 * The session's clarifying phase: text always plans through
 * `POST /v1/intents?clarify=true`; needs input, answer, planned;
 * superseded and post-reset answers are ignored; a refusal keeps the
 * card; assumption chips re-plan; journey blockers stop `execute()`
 * before the wallet until they are answered.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KletiaClient } from "@kletia/sdk";
import { INITIAL_INTENT_SESSION_STATE, createIntentSession, intentSessionReducer } from "../dist/hooks/index.js";
import { createWidgetClient } from "../dist/index.js";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
const THREAD = (rev, status = "needs_input") => ({ spec: "kletia.thread/v1", id: "th_aaaaaaaaaaaaaaaaaaaaaaaa", rev, status, policy: "2026-10.1", steps: [], open: [], corrections: [], turns: [], undo: [] });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const intent = (id, status = "planned", stepStatus = "ready", updatedAt = "2026-10-09T00:00:00.000Z") => ({
  spec: "kletia.intent/v1",
  id,
  status,
  updatedAt,
  summary: { title: "Swap" },
  steps: [{ id: "s1", index: 0, kind: "swap", title: "Swap", network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account: ACCOUNT, protocol: "jupiter", mode: "wallet", dependsOn: [], status: stepStatus, evidence: [] }],
});

const QUESTION = {
  id: "q.actions.0.amount", field: "actions[0].amount", kind: "amount", reason: "AMOUNT_MISSING", purpose: true,
  prompt: "How much SOL?", why: "You hold 2.5 SOL on Solana.",
  options: [{ id: "all", label: "All · 2.49 SOL" }, { id: "half", label: "Half · 1.25 SOL" }],
  allowsText: true, placeholder: "Amount in SOL",
};
const needsInput = (rev = 1) => ({ status: "needs_input", turn: "message", questions: [QUESTION], assumptions: [], draft: { summary: "Swap SOL to USDC on Solana", sentence: null, missing: ["actions[0].amount"], steps: [] }, thread: THREAD(rev) });
const ASSUMPTION = { id: "a.actions.0.network", field: "actions[0].network", label: "On Solana", reason: "Your largest SOL balance.", source: "balance", material: false, alternatives: [{ id: "base", label: "Base", network: "base" }] };
const planned = (graph, extra = {}) => ({ status: "planned", turn: "answer", intent: graph, assumptions: [ASSUMPTION], sentence: "swap 2.49 SOL to USDC on solana", thread: THREAD(2, "ready"), ...extra });

const JOURNEY = (intentId) => ({
  spec: "kletia.journey/v1",
  intentId,
  computedAt: "2026-10-09T00:00:00.000Z",
  stage: "plan",
  basis: { intentUpdatedAt: "2026-10-09T00:00:00.000Z", previewDigest: null, reads: "live", factsAt: null },
  stops: [],
  legs: [],
  now: { stopIds: [], legId: "s1", waitingFor: "signature" },
  consequences: [{
    id: "gas-to-continue:out:s1", kind: "gas-to-continue", severity: "block", stopId: "out:s1", legIds: ["s1"], title: "No SOL to sign", detail: "d", certainty: "estimated",
    facts: { need: "5000", have: "0" }, source: "Solana RPC", collapsed: false,
    options: [{ id: "bring-gas", label: "I will bring SOL myself", effect: "e", costUsd: null, recommended: false, action: { type: "acknowledge" } }],
    prompt: { question: "How should SOL get there?", defaultOptionId: null },
  }],
  blockers: ["gas-to-continue:out:s1"],
  digest: `sha256:${"a".repeat(64)}`,
});

/** A client over `METHOD /path` handlers; records every call with its query. */
function mockClient(routes, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const route = `${init.method} ${pathname}`;
      calls.push({ route, query: Object.fromEntries(searchParams), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
      const handler = routes[route];
      if (!handler) throw new Error(`unexpected ${route}`);
      return handler(init, calls.length);
    },
  });
  return { client, calls };
}

test("reducer: needs input is the clarifying phase; a refusal keeps the card; planned keeps the assumptions; reset forgets", () => {
  let state = intentSessionReducer(INITIAL_INTENT_SESSION_STATE, { type: "turn_started", pending: { kind: "message" }, fresh: true });
  assert.equal(state.phase, "planning");
  state = intentSessionReducer(state, { type: "turn_succeeded", response: needsInput() });
  assert.equal(state.phase, "clarifying");
  assert.equal(state.clarify.questions[0].id, QUESTION.id);
  state = intentSessionReducer(state, { type: "turn_started", pending: { kind: "answer", questionId: QUESTION.id, optionId: "all" }, fresh: false });
  assert.deepEqual(state.clarify.pending, { kind: "answer", questionId: QUESTION.id, optionId: "all" });
  const refused = intentSessionReducer(state, { type: "turn_failed", error: new Error("ANSWER_INVALID") });
  assert.equal(refused.phase, "clarifying");
  assert.equal(refused.clarify.questions[0].id, QUESTION.id, "the card stays");
  assert.equal(refused.clarify.pending, null);
  const done = intentSessionReducer(state, { type: "turn_succeeded", response: planned(intent("int_a")) });
  assert.equal(done.phase, "planned");
  assert.equal(done.clarify.status, "planned");
  assert.equal(done.clarify.assumptions[0].id, ASSUMPTION.id);
  assert.equal(intentSessionReducer(done, { type: "reset" }), INITIAL_INTENT_SESSION_STATE);
  assert.equal(intentSessionReducer(done, { type: "turn_succeeded", response: { status: "cancelled", turn: "control", thread: THREAD(3, "cancelled") } }), INITIAL_INTENT_SESSION_STATE);
});

test("text plans with ?clarify=true; an answer sends the thread back and plans", async () => {
  const { client, calls } = mockClient({
    "POST /v1/intents": (_init, count) => jsonResponse(count === 1 ? 200 : 201, count === 1 ? needsInput() : planned(intent("int_b01"))),
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT], sourceNetwork: "solana", preview: true });
  session.attach();
  assert.equal(await session.plan("swap SOL to USDC"), null);
  assert.equal(session.getState().phase, "clarifying");
  assert.deepEqual(calls[0].query, { clarify: "true", preview: "true" });
  assert.deepEqual(calls[0].body, { accounts: [ACCOUNT], sourceNetwork: "solana", text: "swap SOL to USDC" });
  const graph = await session.answer({ questionId: QUESTION.id, optionId: "all" });
  assert.equal(graph.id, "int_b01");
  assert.equal(session.getState().phase, "planned");
  assert.deepEqual(calls[1].body.answer, { question: QUESTION.id, option: "all" });
  assert.equal(calls[1].body.thread.rev, 1);
  assert.equal(calls[1].body.accounts[0], ACCOUNT);
  assert.equal(calls[1].query.clarify, "true");
  // A question that is not open is never answered.
  assert.equal(await session.answer({ questionId: QUESTION.id, optionId: "half" }), null);
  assert.equal(calls.length, 2);
});

test("an answer after reset is ignored, and so is a reply to one in flight", async () => {
  const gate = deferred();
  const { client, calls } = mockClient({
    "POST /v1/intents": async (_init, count) => {
      if (count === 2) await gate.promise;
      return jsonResponse(count === 1 ? 200 : 201, count === 1 ? needsInput() : planned(intent("int_late")));
    },
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  await session.plan("swap SOL to USDC");
  const inFlight = session.answer({ questionId: QUESTION.id, optionId: "all" });
  session.reset();
  gate.resolve();
  assert.equal(await inFlight, null);
  assert.equal(session.getState(), INITIAL_INTENT_SESSION_STATE);
  assert.equal(await session.answer({ questionId: QUESTION.id, optionId: "all" }), null);
  assert.equal(calls.length, 2, "nothing is sent after the reset");
});

test("a superseded turn's late response is ignored", async () => {
  const first = deferred();
  const { client } = mockClient({
    "POST /v1/intents": async (init) => {
      const body = JSON.parse(init.body);
      if (body.text === "swap SOL to USDC") {
        await first.promise;
        return jsonResponse(200, needsInput());
      }
      return jsonResponse(201, planned(intent("int_new")));
    },
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  const older = session.plan("swap SOL to USDC");
  const newer = await session.plan("swap 1 SOL to USDC");
  first.resolve();
  assert.equal(await older, null);
  assert.equal(newer.id, "int_new");
  assert.equal(session.getState().phase, "planned");
  assert.equal(session.getState().clarify.status, "planned");
});

test("a refused answer keeps the card and the thread; nothing is lost", async () => {
  const { client, calls } = mockClient({
    "POST /v1/intents": (_init, count) =>
      count === 1
        ? jsonResponse(200, needsInput())
        : jsonResponse(422, { error: { code: "ANSWER_INVALID", message: "Pick one of the question's options." } }),
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  await session.plan("swap SOL to USDC");
  assert.equal(await session.answer({ questionId: QUESTION.id, text: "lots" }), null);
  const state = session.getState();
  assert.equal(state.phase, "clarifying");
  assert.equal(state.error.code, "ANSWER_INVALID");
  assert.equal(state.clarify.questions[0].id, QUESTION.id);
  assert.equal(state.clarify.thread.rev, 1);
  assert.deepEqual(calls[1].body.answer, { question: QUESTION.id, text: "lots" });
});

test("chooseAssumption re-plans with the chosen alternative; unknown alternatives send nothing", async () => {
  const { client, calls } = mockClient({
    "POST /v1/intents": (_init, count) => jsonResponse(201, planned(intent(count === 1 ? "int_one" : "int_two"))),
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  await session.plan("swap 2.49 SOL to USDC");
  assert.equal(await session.chooseAssumption(ASSUMPTION.id, "optimism"), null);
  assert.equal(calls.length, 1);
  const graph = await session.chooseAssumption(ASSUMPTION.id, "base");
  assert.equal(graph.id, "int_two");
  assert.deepEqual(calls[1].body.assumption, { id: ASSUMPTION.id, option: "base" });
  assert.equal(calls[1].body.thread.rev, 2);
  // say() continues the thread (a follow-up), plan() starts a new one.
  await session.say("make it 2");
  assert.equal(calls[2].body.text, "make it 2");
  assert.ok(calls[2].body.thread);
  await session.plan("stake 1 SOL with jito");
  assert.equal(calls[3].body.thread, undefined);
});

test("journey blockers stop execute() before the wallet until they are answered", async () => {
  let signed = 0;
  const { client, calls } = mockClient({
    "POST /v1/intents": () => jsonResponse(201, { ...planned(intent("int_j")), journey: JOURNEY("int_j") }),
    "GET /v1/intents/int_j/journey": () => jsonResponse(200, { journey: JOURNEY("int_j") }),
    "POST /v1/intents/int_j/steps/s1/prepare": () =>
      jsonResponse(200, {
        intent: intent("int_j", "executing", "awaiting_signature", "2026-10-09T00:00:01.000Z"),
        payload: { vm: "svm", transactions: [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "swap" }], expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "x" },
      }),
    "POST /v1/intents/int_j/steps/s1/submit": () => jsonResponse(200, { intent: intent("int_j", "completed", "settled", "2026-10-09T00:00:02.000Z") }),
  });
  const signers = { solana: { address: SOL, async signAndSendTransaction() { signed += 1; return "5".repeat(88); } } };
  const session = createIntentSession(client, { accounts: [ACCOUNT], signers, journey: true });
  session.attach();
  await session.plan("swap 1 SOL to USDC");
  assert.equal(calls[0].query.journey, "true");
  assert.equal(session.getState().journey.intentId, "int_j");
  assert.equal(await session.execute(), null);
  assert.match(session.getState().error.message, /journey's open question/u);
  assert.equal(calls.some((call) => call.route.endsWith("/prepare")), false, "nothing was prepared");
  session.answerJourney("gas-to-continue:out:s1", "not-an-option");
  assert.deepEqual(session.getState().journeyAnswers, {});
  session.answerJourney("gas-to-continue:out:s1", "bring-gas");
  const final = await session.execute();
  assert.equal(final.status, "completed");
  assert.equal(signed, 1);
});

test("the publishableKey prop reaches the SDK as a bearer token, with the frame's host origin", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.headers);
    return jsonResponse(200, { networks: [] });
  };
  const key = `kl_pub_${"A1b2".repeat(8)}`;
  await createWidgetClient({ clientOptions: { baseUrl: "http://localhost:3001", fetch }, publishableKey: key }).networks();
  assert.equal(seen[0].authorization, `Bearer ${key}`);
  assert.equal(seen[0]["kletia-host-origin"], undefined);
  await createWidgetClient({ clientOptions: { baseUrl: "http://localhost:3001", fetch }, publishableKey: key, hostOrigin: "https://shop.example" }).networks();
  assert.equal(seen[1]["kletia-host-origin"], "https://shop.example");
  assert.throws(() => createWidgetClient({ clientOptions: { fetch }, publishableKey: "kl_dev_secret" }), /publishable key/u);
  const own = new KletiaClient({ baseUrl: "http://localhost:3001", fetch });
  assert.equal(createWidgetClient({ client: own, publishableKey: key }), own, "an explicit client wins");
});
