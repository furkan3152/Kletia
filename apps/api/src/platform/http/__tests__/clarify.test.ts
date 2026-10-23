/**
 * Clarify turns over HTTP (clarify design §6): `POST /v1/intents?clarify=true`
 * with client-held and Kletia-held threads. Without the flag the endpoint is
 * the strict planner, byte for byte; with it: needs_input 200, planned 201
 * when stored (200 replayed, 200 on a dry run), cancelled 200, refusals with
 * their catalogue status and the thread unchanged; the commit turn replays by
 * clientReference; Idempotency-Key on remembered dry-run turns; expectedRev
 * and If-Match; owner scoping; secrets store nothing; the public tier cannot
 * remember. Offline: stub adapters and stub holdings (support.useClarifyWallet).
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/clarify.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClarifyThread, IntentGraph, ThreadRef } from "@kletia/core";
import { configurePlatform, getIntentStore } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useClarifyWallet, useTestEnvironment, type ErrorEnvelope, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const threads = await import("../threads.js");

interface Question {
  id: string;
  field: string;
  reason: string;
  purpose: boolean;
  options: { id: string; label: string; sentence?: string; recommended?: true }[];
}

interface TurnBody {
  status: "needs_input" | "planned" | "cancelled";
  turn: string;
  questions?: Question[];
  assumptions?: { field: string; source: string; material: boolean }[];
  draft?: { summary: string; missing: string[] };
  intent?: IntentGraph;
  preview?: unknown;
  journey?: unknown;
  sentence?: string;
  replayed?: boolean;
  thread: ClarifyThread | ThreadRef;
}

const PRIVATE_KEY = `0x${"4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"}`;

let server: TestServer;
let key: string;
let keyId: string;
let otherKey: string;

async function issue(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201);
  return reply.body.key;
}

/** The id of the intent the key stored under `reference` (the graph does not echo clientReference). */
async function storedUnder(reference: string): Promise<string | undefined> {
  return (await getIntentStore().findByClientReference(keyId, reference))?.id;
}

function turn(body: Record<string, unknown>, query = "dryRun=true", options: { key?: string; headers?: Record<string, string> } = {}): Promise<Reply<TurnBody>> {
  return call<TurnBody>(server, "POST", `/intents?clarify=true${query ? `&${query}` : ""}`, { body, ...(options.key ? { key: options.key } : {}), ...(options.headers ? { headers: options.headers } : {}) });
}

/** The body without the parts that differ between two identical requests (request id). */
function stable(reply: Reply<unknown>): string {
  const { requestId: _requestId, ...rest } = reply.body as Record<string, unknown>;
  return JSON.stringify(rest);
}

before(async () => {
  resetEngine();
  await useClarifyWallet();
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  ({ key, id: keyId } = await issue("clarify"));
  otherKey = (await issue("clarify-other")).key;
});

beforeEach(() => {
  threads.configureThreadClock(null);
});

after(async () => {
  threads.configureThreadClock(null);
  await useClarifyWallet(false);
  configurePlatform({ adapters: null });
  await server.close();
});

describe("POST /v1/intents without clarify", () => {
  it("is the strict planner, byte for byte (an incomplete sentence is still refused)", async () => {
    const body = { text: "swap SOL to USDC", accounts: ACCOUNTS };
    const plain = await call(server, "POST", "/intents?dryRun=true", { body });
    assertError(plain, 422, "INTENT_UNSUPPORTED");
    for (const flag of ["clarify=false", "clarify=0", "clarify="]) {
      const off = await call(server, "POST", `/intents?dryRun=true&${flag}`, { body });
      assert.equal(off.status, 422);
      assert.equal(stable(off), stable(plain), flag);
    }
    // The same sentence with the flag asks instead.
    const asked = await turn(body);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.status, "needs_input");
  });

  it("keeps the strict response shape for a complete sentence (no status, no thread)", async () => {
    const dry = await call<Record<string, unknown>>(server, "POST", "/intents?dryRun=true", { body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    assert.equal(dry.status, 200);
    assert.deepEqual(Object.keys(dry.body), ["intent"]);
    const stored = await call<Record<string, unknown>>(server, "POST", "/intents", { key, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS, clientReference: `strict-${randomUUID()}` } });
    assert.equal(stored.status, 201);
    assert.deepEqual(Object.keys(stored.body), ["intent"]);
  });
});

describe("POST /v1/intents?clarify=true with a client-held thread", () => {
  it("asks (200), plans the answer as a dry run (200), commits (201) and replays a retried commit (200)", async () => {

    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "needs_input");
    assert.equal(first.body.turn, "message");
    const question = first.body.questions?.[0] as Question;
    assert.equal(question.reason, "AMOUNT_MISSING");
    assert.equal(question.purpose, true);
    assert.deepEqual(question.options.map((option) => option.id), ["all", "half"]);
    assert.ok(question.options.every((option) => !option.recommended), "a gap question never suggests");
    assert.match(question.options[0]?.sentence ?? "", /^swap 2\.49 SOL to USDC/u, "options carry the sentence they lead to");
    const thread = first.body.thread as ClarifyThread;
    assert.equal(thread.spec, "kletia.thread/v1");
    assert.equal(thread.rev, 1);
    assert.ok(!JSON.stringify(thread).includes("swap SOL to USDC"), "the user's words are never kept");

    const answered = await turn({ thread, accounts: ACCOUNTS, answer: { question: question.id, option: "all" } }, "dryRun=true&preview=true");
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.status, "planned");
    assert.equal(answered.body.turn, "answer");
    assert.match(answered.body.sentence ?? "", /^swap 2\.49 SOL to USDC/u);
    assert.ok(answered.body.preview, "preview=true carries the preview");
    assert.equal(answered.body.intent?.interpretation.thread?.id, thread.id);
    assert.equal(await getIntentStore().get(answered.body.intent?.id as string), null, "a dry run stores nothing");

    const ready = answered.body.thread as ClarifyThread;
    const commit = await turn({ thread: ready, accounts: ACCOUNTS }, "", { key });
    assert.equal(commit.status, 201, JSON.stringify(commit.body));
    assert.equal(commit.body.status, "planned");
    assert.equal(commit.body.turn, "none");
    const intent = commit.body.intent as IntentGraph;
    assert.equal(await storedUnder(`thread:${thread.id}:r${ready.rev + 1}`), intent.id);

    // The same commit again (a retry): the same revision, the same clientReference, the same intent.
    const retry = await turn({ thread: ready, accounts: ACCOUNTS }, "", { key });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("idempotent-replayed"), "true");
    assert.equal(retry.body.intent?.id, intent.id);

  });

  it("uses the caller's clientReference with the revision", async () => {
    const reference = `order-${randomUUID().slice(0, 8)}`;
    const reply = await turn({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, clientReference: reference }, "", { key });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(await storedUnder(`${reference}:r1`), reply.body.intent?.id);
  });

  it("cancels (200) and refuses later turns on the cancelled thread with THREAD_CLOSED", async () => {
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS });
    const cancelled = await turn({ thread: first.body.thread, accounts: ACCOUNTS, text: "cancel" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.turn, "control");
    assertError(await turn({ thread: cancelled.body.thread, accounts: ACCOUNTS, text: "swap 1 SOL to USDC" }), 409, "THREAD_CLOSED");
  });

  it("answers refusals with their catalogue status", async () => {
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS });
    const thread = first.body.thread as ClarifyThread;
    assertError(await turn({ thread, accounts: ACCOUNTS, answer: { question: "q.actions.0.recipient", option: "x" } }), 409, "QUESTION_NOT_OPEN");
    assertError(await turn({ thread, accounts: ACCOUNTS, answer: { question: "q.actions.0.amount", option: "most" } }), 422, "ANSWER_INVALID");
    assertError(await turn({ thread: { ...thread, spec: "kletia.thread/v0" }, accounts: ACCOUNTS, text: "50" }), 400, "THREAD_INVALID");
    assertError(await turn({ thread, accounts: ACCOUNTS, answer: { question: "q.actions.0.amount", text: PRIVATE_KEY } }), 400, "MESSAGE_SECRET_REFUSED");
    assertError(await turn({ accounts: ACCOUNTS, text: `swap 1 SOL to USDC ${PRIVATE_KEY}` }), 400, "MESSAGE_SECRET_REFUSED");
    assertError(await turn({ accounts: ACCOUNTS, actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }] }), 400, "INVALID_REQUEST");
    assertError(await turn({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS }, "dryRun=maybe"), 400, "INVALID_REQUEST");
    // An unreadable sentence carries the grammar's example sentences, as on the strict path.
    const unreadable = assertError(await turn({ text: "make me rich quickly", accounts: ACCOUNTS }), 422, "INTENT_UNSUPPORTED");
    assert.ok((unreadable.error.hints?.length ?? 0) > 0);
    // The thread the client holds still works after every refusal.
    const answered = await turn({ thread, accounts: ACCOUNTS, answer: { question: "q.actions.0.amount", text: "1" } });
    assert.equal(answered.body.status, "planned", JSON.stringify(answered.body));
  });

  it("adds the journey with ?journey=true on a planned turn", async () => {
    const reply = await turn({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS }, "dryRun=true&journey=true&journeyReads=none");
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.ok(reply.body.preview, "the journey implies the preview");
    assert.ok("journey" in reply.body);
  });
});

describe("POST /v1/intents?clarify=true with a Kletia-held thread", () => {
  it("needs an API key to remember (THREAD_REQUIRES_API_KEY)", async () => {
    assertError(await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }), 400, "THREAD_REQUIRES_API_KEY");
    assertError(await turn({ threadId: `th_${"a".repeat(24)}`, text: "50" }), 400, "THREAD_REQUIRES_API_KEY");
  });

  it("returns a ThreadRef, keeps the context, plans on a later turn and scopes the thread to its key", async () => {
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }, "dryRun=true", { key });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const ref = first.body.thread as ThreadRef;
    assert.deepEqual(Object.keys(ref).sort(), ["expiresAt", "id", "rev", "status"]);
    assert.equal(ref.rev, 1);
    assert.equal(ref.status, "needs_input");
    assert.ok(Date.parse(ref.expiresAt) > Date.now());

    // Another key and the public tier never see it.
    assertError(await turn({ threadId: ref.id, answer: { question: "q.actions.0.amount", option: "all" } }, "dryRun=true", { key: otherKey }), 404, "THREAD_NOT_FOUND");
    assertError(await call(server, "GET", `/threads/${ref.id}`, { key: otherKey }), 404, "THREAD_NOT_FOUND");
    assertError(await call(server, "DELETE", `/threads/${ref.id}`, { key: otherKey }), 404, "THREAD_NOT_FOUND");
    assertError(await call(server, "GET", `/threads/${ref.id}`), 401, "API_KEY_REQUIRED");

    // No accounts on the later turn: the thread kept them.
    const answered = await turn({ threadId: ref.id, expectedRev: 1, answer: { question: "q.actions.0.amount", option: "all" } }, "dryRun=true", { key });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.status, "planned");
    assert.deepEqual(answered.body.thread, { id: ref.id, rev: 2, status: "ready", expiresAt: (answered.body.thread as ThreadRef).expiresAt });

    const detail = await call<{ thread: ClarifyThread; ref: ThreadRef; context: { accounts: string[] }; response: Record<string, unknown> }>(server, "GET", `/threads/${ref.id}`, { key });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.ref.rev, 2);
    assert.equal(detail.body.ref.status, "ready");
    assert.deepEqual(detail.body.context.accounts, ACCOUNTS);
    assert.equal(detail.body.thread.spec, "kletia.thread/v1");
    assert.equal(detail.body.thread.id, ref.id);
    assert.equal(detail.body.thread.rev, 2);
    const last = detail.body.response;
    assert.equal(last.status, "planned");
    assert.equal(last.dryRun, true);
    assert.ok(!("intent" in last), "the stored last response keeps no intent graph");

    // The commit stores the intent and the thread lists it.
    const commit = await turn({ threadId: ref.id }, "", { key });
    assert.equal(commit.status, 201, JSON.stringify(commit.body));
    assert.equal(await storedUnder(`thread:${ref.id}:r3`), commit.body.intent?.id);
    const after = await call<{ intents: string[] }>(server, "GET", `/threads/${ref.id}`, { key });
    assert.deepEqual(after.body.intents, [commit.body.intent?.id]);

    const list = await call<{ threads: { id: string; summary: string }[]; nextCursor: string | null }>(server, "GET", "/threads?status=ready", { key });
    assert.equal(list.status, 200);
    assert.ok(list.body.threads.some((entry) => entry.id === ref.id && /swap 2\.49 SOL/u.test(entry.summary)));
    assert.ok(!(await call<{ threads: { id: string }[] }>(server, "GET", "/threads", { key: otherKey })).body.threads.some((entry) => entry.id === ref.id));

    const deleted = await call(server, "DELETE", `/threads/${ref.id}`, { key });
    assert.equal(deleted.status, 204);
    assertError(await call(server, "GET", `/threads/${ref.id}`, { key }), 404, "THREAD_NOT_FOUND");
    assertError(await turn({ threadId: ref.id }, "dryRun=true", { key }), 404, "THREAD_NOT_FOUND");
  });

  it("refuses a moved thread with THREAD_CONFLICT (expectedRev or If-Match) and leaves it unchanged on a refusal", async () => {
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }, "dryRun=true", { key });
    const ref = first.body.thread as ThreadRef;
    const stale = await turn({ threadId: ref.id, expectedRev: 0, text: "1" }, "dryRun=true", { key });
    const conflict = assertError(stale, 409, "THREAD_CONFLICT");
    assert.equal(conflict.error.details?.rev, 1);
    assertError(await turn({ threadId: ref.id, text: "1" }, "dryRun=true", { key, headers: { "if-match": "\"7\"" } }), 409, "THREAD_CONFLICT");
    assertError(await turn({ threadId: ref.id, expectedRev: 1, text: "1" }, "dryRun=true", { key, headers: { "if-match": "\"2\"" } }), 400, "INVALID_REQUEST");

    // Refusals change nothing: the stored thread keeps its revision.
    assertError(await turn({ threadId: ref.id, answer: { question: "q.actions.0.recipient", option: "x" } }, "dryRun=true", { key }), 409, "QUESTION_NOT_OPEN");
    assertError(await turn({ threadId: ref.id, answer: { question: "q.actions.0.amount", text: PRIVATE_KEY } }, "dryRun=true", { key }), 400, "MESSAGE_SECRET_REFUSED");
    const detail = await call<{ ref: ThreadRef }>(server, "GET", `/threads/${ref.id}`, { key });
    assert.equal(detail.body.ref.rev, 1);
    assert.equal(detail.body.ref.status, "needs_input");
    const ok = await turn({ threadId: ref.id, text: "1" }, "dryRun=true", { key, headers: { "if-match": "\"1\"" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((ok.body.thread as ThreadRef).rev, 2);
  });

  it("honours Idempotency-Key on dry-run turns that change the thread, and stores nothing for a secret", async () => {
    const id = randomUUID();
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }, "dryRun=true", { key, headers: { "idempotency-key": id } });
    assert.equal(first.status, 200);
    const again = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }, "dryRun=true", { key, headers: { "idempotency-key": id } });
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(again.body.thread, first.body.thread, "the retry did not create a second thread");
    const ref = first.body.thread as ThreadRef;

    const answerKey = randomUUID();
    const answer = { threadId: ref.id, answer: { question: "q.actions.0.amount", option: "half" } };
    const planned = await turn(answer, "dryRun=true", { key, headers: { "idempotency-key": answerKey } });
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    const replay = await turn(answer, "dryRun=true", { key, headers: { "idempotency-key": answerKey } });
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal((replay.body.thread as ThreadRef).rev, 2, "the replay did not run a second turn");
    assert.equal((await call<{ ref: ThreadRef }>(server, "GET", `/threads/${ref.id}`, { key })).body.ref.rev, 2);

    // A secret is refused before the key is reserved: the same key with another body is not "reused".
    const secretKey = randomUUID();
    assertError(await turn({ threadId: ref.id, answer: { question: "q.actions.0.amount", text: PRIVATE_KEY } }, "dryRun=true", { key, headers: { "idempotency-key": secretKey } }), 400, "MESSAGE_SECRET_REFUSED");
    const fresh = await turn({ threadId: ref.id, text: "make it 1" }, "dryRun=true", { key, headers: { "idempotency-key": secretKey } });
    assert.notEqual((fresh.body as unknown as Partial<ErrorEnvelope>).error?.code, "IDEMPOTENCY_KEY_REUSED");
    // Client-held dry runs stay free of Idempotency-Key, as strict dry runs are.
    const looseKey = randomUUID();
    const loose = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS }, "dryRun=true", { key, headers: { "idempotency-key": looseKey } });
    const looseAgain = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS }, "dryRun=true", { key, headers: { "idempotency-key": looseKey } });
    assert.equal(looseAgain.headers.get("idempotent-replayed"), null);
    assert.notEqual((looseAgain.body.thread as ClarifyThread).id, (loose.body.thread as ClarifyThread).id);
  });

  it("expires a thread after 30 minutes idle (THREAD_NOT_FOUND)", async () => {
    let now = Date.now();
    threads.configureThreadClock(() => now);
    const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true }, "dryRun=true", { key });
    const ref = first.body.thread as ThreadRef;
    now += 29 * 60_000;
    assert.equal((await call(server, "GET", `/threads/${ref.id}`, { key })).status, 200);
    now += 2 * 60_000;
    assertError(await call(server, "GET", `/threads/${ref.id}`, { key }), 404, "THREAD_NOT_FOUND");
    assertError(await turn({ threadId: ref.id, text: "1" }, "dryRun=true", { key }), 404, "THREAD_NOT_FOUND");
  });
});

describe("hand-offs over HTTP (round 9)", () => {
  it("returns a perps trade as status handoff on a clarify turn, and as INTENT_HANDOFF on the strict path", async () => {
    const reply = await turn({ text: "long ETH 5x with 100 USDC", accounts: ACCOUNTS }, "dryRun=true", { key });
    assert.equal(reply.status, 200);
    const body = reply.body as unknown as { status: string; handoff: { surface: string; input: Record<string, unknown>; execution: string }; thread: ClarifyThread };
    assert.equal(body.status, "handoff");
    assert.equal(body.handoff.surface, "perps");
    assert.deepEqual(body.handoff.input, { market: "ETH", side: "long", action: "open", collateral: "100", leverage: 5 });
    assert.equal(body.handoff.execution, "signature");
    assert.deepEqual(body.thread.steps, [], "nothing is planned");
    const strict = await call<ErrorEnvelope>(server, "POST", "/intents", { body: { text: "long ETH 5x with 100 USDC", accounts: ACCOUNTS }, key });
    const error = assertError(strict, 422, "INTENT_HANDOFF");
    assert.equal((error.error.details as { handoff?: { surface?: string } } | undefined)?.handoff?.surface, "perps");
  });

  it("asks a missing leverage on the thread and takes the answer", async () => {
    const first = await turn({ text: "long ETH with 100 USDC", accounts: ACCOUNTS }, "dryRun=true", { key });
    assert.equal(first.body.status, "needs_input");
    assert.equal(first.body.questions?.[0]?.reason, "LEVERAGE_MISSING");
    const second = await turn({ thread: first.body.thread, accounts: ACCOUNTS, answer: { question: "q.handoff.leverage", option: "3" } }, "dryRun=true", { key });
    assert.equal((second.body as unknown as { status: string }).status, "handoff", JSON.stringify(second.body));
  });
});
