import assert from "node:assert/strict";
import test from "node:test";
import { KletiaClient, KletiaExecutionError } from "@kletia/sdk";
import {
  INITIAL_INTENT_SESSION_STATE,
  createIntentFollower,
  createIntentSession,
  createRequestLoader,
  intentSessionReducer,
  leaseSigners,
} from "../dist/hooks/index.js";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

const preparedPayload = () => ({
  vm: "svm",
  transactions: [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "swap" }],
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  quoteBinding: "x",
});

/** A client over a router of `METHOD /path` handlers; records every call. */
function mockClient(routes) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      const route = `${init.method} ${pathname}`;
      calls.push({ route, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
      const handler = routes[route];
      if (!handler) throw new Error(`unexpected ${route}`);
      return handler(init);
    },
  });
  return { client, calls };
}

/* -------------------------------------------------------------- reducer */

test("intentSessionReducer moves through planning, execution and failures", () => {
  let state = intentSessionReducer(INITIAL_INTENT_SESSION_STATE, { type: "plan_started" });
  assert.equal(state.phase, "planning");
  state = intentSessionReducer(state, { type: "plan_succeeded", intent: intent("int_a") });
  assert.equal(state.phase, "planned");
  state = intentSessionReducer(state, { type: "execute_started" });
  assert.equal(state.phase, "executing");
  // Updates for another intent, or older versions, are ignored.
  assert.equal(intentSessionReducer(state, { type: "intent_updated", intent: intent("int_b", "executing") }), state);
  assert.equal(intentSessionReducer(state, { type: "intent_updated", intent: intent("int_a", "executing", "ready", "2026-10-08T00:00:00.000Z") }), state);
  state = intentSessionReducer(state, { type: "intent_updated", intent: intent("int_a", "executing", "awaiting_signature", "2026-10-09T00:00:01.000Z") });
  assert.equal(state.phase, "executing", "updates during execution keep the phase");
  const error = new Error("rejected");
  state = intentSessionReducer(state, { type: "execute_failed", error, pendingReferences: { s1: ["sig"] } });
  assert.equal(state.phase, "planned");
  assert.equal(state.error, error);
  assert.deepEqual(state.pendingReferences, { s1: ["sig"] });
  assert.equal(intentSessionReducer(state, { type: "references_held", intentId: "int_b", pendingReferences: { s2: ["x"] } }), state);
  state = intentSessionReducer(state, { type: "execute_succeeded", intent: intent("int_a", "completed", "settled", "2026-10-09T00:00:02.000Z") });
  assert.equal(state.phase, "finished");
  assert.deepEqual(state.pendingReferences, {});
  assert.equal(intentSessionReducer(state, { type: "reset" }), INITIAL_INTENT_SESSION_STATE);
  const failedPlan = intentSessionReducer(state, { type: "plan_failed", error });
  assert.deepEqual([failedPlan.phase, failedPlan.intent, failedPlan.error], ["idle", null, error]);
});

/* -------------------------------------------------------------- session */

test("plan sends the configured accounts, slippage and metadata, and refuses without accounts", async () => {
  const { client, calls } = mockClient({ "POST /v1/intents": () => jsonResponse(201, { intent: intent("int_plan") }) });
  const session = createIntentSession(client);
  session.attach();
  assert.equal(await session.plan("swap 1 SOL to USDC"), null);
  assert.equal(session.getState().phase, "idle");
  assert.match(session.getState().error.message, /Connect at least one account/u);
  assert.equal(calls.length, 0);

  session.configure({ accounts: [ACCOUNT], maxSlippageBps: 30, metadata: { orderId: "A-1" } });
  const planned = await session.plan("  swap 1 SOL to USDC ");
  assert.equal(planned.id, "int_plan");
  assert.equal(session.getState().phase, "planned");
  assert.deepEqual(calls[0].body, { text: "swap 1 SOL to USDC", accounts: [ACCOUNT], constraints: { maxSlippageBps: 30 }, metadata: { orderId: "A-1" } });
});

test("a superseded plan's late response is ignored and its request aborted", async () => {
  const first = deferred();
  let count = 0;
  const { client, calls } = mockClient({
    "POST /v1/intents": async () => {
      count += 1;
      if (count === 1) {
        await first.promise;
        return jsonResponse(201, { intent: intent("int_old") });
      }
      return jsonResponse(201, { intent: intent("int_new") });
    },
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  const older = session.plan("swap 1 SOL to USDC");
  const newer = await session.plan("swap 2 SOL to USDC");
  first.resolve();
  assert.equal(await older, null);
  assert.equal(newer.id, "int_new");
  assert.equal(session.getState().intent.id, "int_new");
  assert.equal(calls[0].signal.aborted, true);
});

test("execute signs with the leased signer and finishes; without signers it reports an error", async () => {
  let stepStatus = "ready";
  const { client } = mockClient({
    "POST /v1/intents": () => jsonResponse(201, { intent: intent("int_exec") }),
    "POST /v1/intents/int_exec/steps/s1/prepare": () => {
      stepStatus = "awaiting_signature";
      return jsonResponse(200, { intent: intent("int_exec", "executing", stepStatus, "2026-10-09T00:00:01.000Z"), payload: preparedPayload() });
    },
    "POST /v1/intents/int_exec/steps/s1/submit": () => jsonResponse(200, { intent: intent("int_exec", "completed", "settled", "2026-10-09T00:00:02.000Z") }),
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  await session.plan("swap 1 SOL to USDC");
  assert.equal(await session.execute(), null);
  assert.match(session.getState().error.message, /Connect a wallet/u);
  assert.equal(session.getState().phase, "planned");

  let signed = 0;
  const phases = [];
  session.subscribe(() => phases.push(session.getState().phase));
  session.configure({ accounts: [ACCOUNT], signers: { solana: { address: SOL, async signAndSendTransaction() { signed += 1; return "5".repeat(88); } } } });
  const final = await session.execute();
  assert.equal(final.status, "completed");
  assert.equal(signed, 1);
  assert.equal(session.getState().phase, "finished");
  assert.ok(phases.includes("executing"));
  assert.equal(await session.execute(), null, "a finished intent is not executed again");
});

test("unmounting during prepare never opens a wallet prompt and ignores late results", async () => {
  const prepare = deferred();
  const reached = deferred();
  const { client } = mockClient({
    "POST /v1/intents": () => jsonResponse(201, { intent: intent("int_unmount") }),
    "POST /v1/intents/int_unmount/steps/s1/prepare": async () => {
      reached.resolve();
      await prepare.promise;
      return jsonResponse(200, { intent: intent("int_unmount", "executing", "awaiting_signature", "2026-10-09T00:00:01.000Z"), payload: preparedPayload() });
    },
  });
  let prompts = 0;
  const session = createIntentSession(client, {
    accounts: [ACCOUNT],
    signers: { solana: { address: SOL, async signAndSendTransaction() { prompts += 1; return "5".repeat(88); } } },
  });
  const detach = session.attach();
  await session.plan("swap 1 SOL to USDC");
  const running = session.execute();
  await reached.promise;
  detach();
  prepare.resolve();
  assert.equal(await running, null);
  assert.equal(prompts, 0);
  assert.equal(session.getState().phase, "planned", "a remount finds a resting state");
  assert.equal(await session.plan("swap 1 SOL to USDC"), null, "a detached session takes no work");
});

test("broadcast references Kletia did not record are kept and resubmitted, never signed twice", async () => {
  let submits = 0;
  const { client } = mockClient({
    "POST /v1/intents": () => jsonResponse(201, { intent: intent("int_refs") }),
    "GET /v1/intents/int_refs": () => jsonResponse(200, { intent: intent("int_refs", "executing", "awaiting_signature", "2026-10-09T00:00:01.000Z") }),
    "POST /v1/intents/int_refs/steps/s1/prepare": () =>
      jsonResponse(200, { intent: intent("int_refs", "executing", "awaiting_signature", "2026-10-09T00:00:01.000Z"), payload: preparedPayload() }),
    "POST /v1/intents/int_refs/steps/s1/submit": (init) => {
      submits += 1;
      if (submits <= 3) return jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "down" } }, { "retry-after": "0" });
      assert.deepEqual(JSON.parse(init.body).references, ["7".repeat(88)]);
      return jsonResponse(200, { intent: intent("int_refs", "completed", "settled", "2026-10-09T00:00:02.000Z") });
    },
  });
  let prompts = 0;
  const session = createIntentSession(client, {
    accounts: [ACCOUNT],
    signers: { solana: { address: SOL, async signAndSendTransaction() { prompts += 1; return "7".repeat(88); } } },
  });
  session.attach();
  await session.plan("swap 1 SOL to USDC");
  await session.execute();
  const failed = session.getState();
  assert.ok(failed.error instanceof KletiaExecutionError);
  assert.deepEqual(failed.pendingReferences, { s1: ["7".repeat(88)] });
  assert.equal(failed.phase, "planned");
  const final = await session.execute();
  assert.equal(final.status, "completed");
  assert.equal(prompts, 1, "the wallet signed once");
  assert.deepEqual(session.getState().pendingReferences, {});
});

test("cancel cancels a planned intent on Kletia", async () => {
  const { client, calls } = mockClient({
    "POST /v1/intents": () => jsonResponse(201, { intent: intent("int_cancel") }),
    "POST /v1/intents/int_cancel/cancel": () => jsonResponse(200, { intent: intent("int_cancel", "cancelled", "skipped", "2026-10-09T00:00:01.000Z") }),
  });
  const session = createIntentSession(client, { accounts: [ACCOUNT] });
  session.attach();
  await session.plan("swap 1 SOL to USDC");
  const cancelled = await session.cancel();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(session.getState().phase, "finished");
  assert.deepEqual(calls.map((call) => call.route), ["POST /v1/intents", "POST /v1/intents/int_cancel/cancel"]);
  session.reset();
  assert.equal(session.getState(), INITIAL_INTENT_SESSION_STATE);
});

/* ---------------------------------------------------------------- lease */

test("leased signers refuse wallet requests once the lease ends", async () => {
  let evmSends = 0;
  let solanaSends = 0;
  const lease = leaseSigners({
    evm: { address: "0x1", async sendTransaction() { evmSends += 1; return "0xhash"; }, async waitForTransaction() {} },
    solana: { address: SOL, async signAndSendTransaction() { solanaSends += 1; return "sig"; } },
  });
  await assert.rejects(lease.signers.solana.signAndSendTransaction({}), (error) => error.name === "AbortError", "inactive before activate");
  const end = lease.activate();
  assert.equal(await lease.signers.evm.sendTransaction({}), "0xhash");
  end();
  await assert.rejects(lease.signers.evm.sendTransaction({}), (error) => error.name === "AbortError");
  await assert.rejects(lease.signers.solana.signAndSendTransaction({}), (error) => error.name === "AbortError");
  lease.activate();
  await assert.rejects(lease.signers.evm.sendTransaction({}), (error) => error.name === "AbortError", "an ended lease stays ended");
  assert.deepEqual([evmSends, solanaSends], [1, 0]);
  assert.equal(lease.signers.solana.address, SOL);
});

/* --------------------------------------------------------------- loader */

test("the request loader debounces, compares inputs by value and aborts superseded requests", async () => {
  const requests = [];
  const loader = createRequestLoader(
    (input, signal) =>
      new Promise((resolve) => {
        requests.push({ input, signal });
        setTimeout(() => resolve({ for: input.amount }), 5);
      }),
    { debounceMs: 20 },
  );
  const detach = loader.attach();
  loader.update({ amount: "1", asset: "SOL" });
  loader.update({ amount: "2", asset: "SOL" });
  loader.update({ asset: "SOL", amount: "2" });
  assert.equal(loader.getState().status, "loading");
  await tick(40);
  assert.equal(requests.length, 1, "one request after the debounce");
  assert.deepEqual(loader.getState().data, { for: "2" });
  assert.equal(loader.getState().status, "success");

  loader.update({ amount: "3", asset: "SOL" });
  await tick(22);
  assert.equal(requests.length, 2);
  loader.update({ amount: "4", asset: "SOL" });
  assert.equal(loader.getState().data, null, "no stale quote for a different input");
  assert.equal(requests[1].signal.aborted, true, "the superseded request is aborted");
  await tick(40);
  assert.deepEqual(loader.getState().data, { for: "4" });

  loader.update(null);
  assert.equal(loader.getState().status, "idle");
  loader.update({ amount: "5", asset: "SOL" });
  await tick(22);
  detach();
  assert.equal(requests.at(-1).signal.aborted, true, "unmount aborts the request in flight");
  await tick(10);
  assert.notDeepEqual(loader.getState().data, { for: "5" }, "and ignores its response");
});

test("the request loader reports errors and reloads on demand", async () => {
  let calls = 0;
  const loader = createRequestLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("upstream");
    return "ok";
  });
  loader.attach();
  loader.update("x");
  await tick();
  assert.equal(loader.getState().status, "error");
  assert.equal(loader.getState().error.message, "upstream");
  loader.reload();
  await tick();
  assert.equal(loader.getState().status, "success");
  assert.equal(loader.getState().data, "ok");
});

/* ------------------------------------------------------------- follower */

test("the intent follower polls without a stream until the intent is terminal", async () => {
  let reads = 0;
  const { client } = mockClient({
    "GET /v1/intents/int_f/events": () => jsonResponse(503, { error: { code: "STREAMS_DISABLED", message: "x" } }, { "retry-after": "60" }),
    "GET /v1/intents/int_f": () => {
      reads += 1;
      return jsonResponse(200, { intent: intent("int_f", reads >= 2 ? "completed" : "executing", reads >= 2 ? "settled" : "awaiting_signature", `2026-10-09T00:00:0${reads}.000Z`) });
    },
  });
  const follower = createIntentFollower(client, { pollIntervalMs: 250 });
  const detach = follower.attach();
  follower.follow("int_f");
  assert.equal(follower.getState().status, "loading");
  await tick(20);
  assert.equal(follower.getState().status, "polling");
  assert.equal(follower.getState().intent.status, "executing");
  await tick(400);
  assert.equal(follower.getState().status, "done");
  assert.equal(follower.getState().intent.status, "completed");
  follower.follow(null);
  assert.equal(follower.getState().status, "idle");
  detach();
});

test("the intent follower stops on unmount and reports unknown intents", async () => {
  const { client, calls } = mockClient({
    "GET /v1/intents/int_missing": () => jsonResponse(404, { error: { code: "INTENT_NOT_FOUND", message: "x" } }),
  });
  const follower = createIntentFollower(client);
  const detach = follower.attach();
  follower.follow("int_missing");
  await tick(20);
  assert.equal(follower.getState().status, "error");
  assert.equal(follower.getState().error.code, "INTENT_NOT_FOUND");
  detach();
  follower.follow("int_missing");
  assert.equal(calls.length, 1, "a detached follower starts nothing");
});

/* ------------------------------------------------------------------ SSR */

test("hooks render their initial state on the server", async (t) => {
  let React;
  let server;
  try {
    React = await import("react");
    server = await import("react-dom/server");
  } catch {
    t.skip("react-dom is not installed");
    return;
  }
  const { KletiaProvider, useKletiaIntent, useQuote, useIntent } = await import("../dist/hooks/index.js");
  const { client, calls } = mockClient({});
  function Probe() {
    const session = useKletiaIntent({ accounts: [ACCOUNT] });
    const quote = useQuote(null);
    const followed = useIntent(null);
    return React.createElement("p", null, `${session.phase}/${quote.status}/${followed.status}`);
  }
  const html = server.renderToString(React.createElement(KletiaProvider, { client }, React.createElement(Probe)));
  assert.equal(html, "<p>idle/idle/idle</p>");
  assert.equal(calls.length, 0, "nothing is fetched during server rendering");
  assert.throws(() => server.renderToString(React.createElement(Probe)), /KletiaProvider/u);
});
