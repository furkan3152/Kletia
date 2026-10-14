/**
 * Journey surfaces of the SDK: `intents.create({ journey })`,
 * `intents.journey`, `intents.stop`, `executeIntent`'s `onJourney` and the
 * `journeyAnswers` gate before the wallet, plus `portfolios` and
 * `KletiaApiError.details`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KletiaApiError, KletiaClient, KletiaExecutionError, executeIntent } from "../dist/index.js";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-j", ...headers },
  });
}

function recorder(handler, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      return handler(parsed, init, calls);
    },
  });
  return { client, calls };
}

const journeyOf = (intentId, consequences = [], digest = "sha256:1") => ({
  spec: "kletia.journey/v1",
  intentId,
  computedAt: "2026-10-14T13:33:44.120Z",
  stage: "plan",
  basis: { intentUpdatedAt: "2026-10-14T13:33:41.802Z", previewDigest: null, reads: "live", factsAt: null },
  stops: [],
  legs: [],
  now: { stopIds: [], legId: "s1", waitingFor: "signature" },
  consequences,
  blockers: consequences.filter((entry) => entry.severity === "block").map((entry) => entry.id),
  digest,
});

const gasBlocker = {
  id: "gas-to-continue:out:s1:base",
  kind: "gas-to-continue",
  severity: "block",
  stopId: "out:s1",
  legIds: ["s1"],
  title: "No ETH on Base to sign leg 2",
  detail: "x",
  certainty: "simulated-assumed-funds",
  facts: {},
  source: "test",
  options: [
    { id: "gas-topup", label: "Add gas", recommended: true, costUsd: 0.07, effect: "x", action: { type: "acknowledge" } },
    { id: "bring-gas", label: "I will send ETH", recommended: false, costUsd: null, effect: "x", action: { type: "acknowledge" } },
  ],
  prompt: { question: "How should ETH get there?", defaultOptionId: "gas-topup" },
  collapsed: false,
};

test("intents.create({ journey: true }) asks for the preview and the journey and returns all three", async () => {
  const { client, calls } = recorder(() => jsonResponse(200, { intent: { id: "int_j" }, preview: { digest: "sha256:p" }, journey: journeyOf("int_j") }));
  const result = await client.intents.create({ text: "bridge 100 USDC from solana to base", accounts: [ACCOUNT] }, { journey: true, dryRun: true, journeyReads: "none" });
  assert.equal(result.intent.id, "int_j");
  assert.equal(result.preview.digest, "sha256:p");
  assert.equal(result.journey.intentId, "int_j");
  const query = calls[0].url.searchParams;
  assert.equal(query.get("journey"), "true");
  assert.equal(query.get("preview"), "true", "the journey implies the preview");
  assert.equal(query.get("dryRun"), "true");
  assert.equal(query.get("journeyReads"), "none");

  // Without the flag nothing changes: no journey query, the intent alone.
  const plain = recorder(() => jsonResponse(200, { intent: { id: "int_p" } }));
  const intent = await plain.client.intents.create({ text: "swap 1 SOL to USDC", accounts: [ACCOUNT] }, { dryRun: true });
  assert.equal(intent.id, "int_p");
  assert.equal(plain.calls[0].url.searchParams.has("journey"), false);
});

test("intents.journey reads GET …/journey with refresh and reads; intents.stop posts and returns { intent, journey }", async () => {
  const { client, calls } = recorder((url) => {
    if (url.pathname.endsWith("/journey")) return jsonResponse(200, { journey: journeyOf("int_s") });
    if (url.pathname.endsWith("/stop")) return jsonResponse(200, { intent: { id: "int_s", status: "partially_completed" }, journey: journeyOf("int_s", [], "sha256:2") });
    return jsonResponse(404, { error: { code: "NOT_FOUND", message: "x" } });
  }, { apiKey: "kl_dev_test" });
  const journey = await client.intents.journey("int_s", { refresh: true, reads: "none" });
  assert.equal(journey.spec, "kletia.journey/v1");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, "/v1/intents/int_s/journey");
  assert.equal(calls[0].url.searchParams.get("refresh"), "true");
  assert.equal(calls[0].url.searchParams.get("reads"), "none");
  const stopped = await client.intents.stop("int_s");
  assert.equal(stopped.intent.status, "partially_completed");
  assert.equal(stopped.journey.digest, "sha256:2");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url.pathname, "/v1/intents/int_s/stop");
  assert.ok(calls[1].headers["idempotency-key"], "a keyed stop carries an Idempotency-Key, so a retry replays it");
});

test("intents.stop is not retried without a key; INTENT_IN_FLIGHT reaches the caller with Retry-After", async () => {
  const { client, calls } = recorder(() => jsonResponse(409, { error: { code: "INTENT_IN_FLIGHT", message: "A step is in flight" } }, { "retry-after": "7" }));
  await assert.rejects(client.intents.stop("int_f"), (error) => error instanceof KletiaApiError && error.code === "INTENT_IN_FLIGHT" && error.retryAfterSeconds === 7);
  assert.equal(calls.length, 1, "a public-tier stop is sent once");
});

/** An intent with one ready Solana step that settles once submitted. */
function harness({ journeys, consequences = [gasBlocker] }) {
  let status = "ready";
  const graph = () => ({
    spec: "kletia.intent/v1",
    id: "int_g",
    status: status === "settled" ? "completed" : "planned",
    updatedAt: "2026-10-14T00:00:00.000Z",
    request: { accounts: [ACCOUNT] },
    steps: [{ id: "s1", index: 0, kind: "swap", title: "Swap", network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account: ACCOUNT, protocol: "jupiter", mode: "wallet", dependsOn: [], status, evidence: [] }],
  });
  const log = [];
  const { client } = recorder((url) => {
    log.push(url.pathname);
    if (url.pathname.endsWith("/journey")) {
      journeys.count += 1;
      return journeys.respond ? journeys.respond(graph()) : jsonResponse(200, { journey: journeyOf("int_g", status === "ready" ? consequences : [], `sha256:${status}`) });
    }
    if (url.pathname.endsWith("/prepare")) {
      status = "awaiting_signature";
      return jsonResponse(200, { intent: graph(), payload: { vm: "svm", transactions: [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "swap" }], expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "x" } });
    }
    if (url.pathname.endsWith("/submit")) {
      status = "settled";
      return jsonResponse(200, { intent: graph() });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  const signed = [];
  const solana = { address: SOL, async signAndSendTransaction() { signed.push(1); return "5".repeat(88); } };
  return { client, graph, log, signed, solana };
}

test("journeyAnswers: an unanswered block consequence of the step stops before prepare and the wallet", async () => {
  const journeys = { count: 0 };
  const h = harness({ journeys });
  const seen = [];
  let blocked = null;
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana }, {
    onJourney: (journey) => seen.push(journey.digest),
    journeyAnswers: {},
    onJourneyBlocked: (blockers, step) => {
      blocked = { ids: blockers.map((entry) => entry.id), step: step.id };
    },
  });
  assert.equal(final.status, "planned", "returned like a declined preview");
  assert.deepEqual(blocked, { ids: ["gas-to-continue:out:s1:base"], step: "s1" });
  assert.equal(h.signed.length, 0, "no wallet prompt");
  assert.ok(!h.log.some((path) => path.endsWith("/prepare")), "nothing was prepared");
  assert.deepEqual(seen, ["sha256:ready"], "onJourney saw the plan's journey once");
});

test("journeyAnswers: an answer that is not one of the options does not open the gate", async () => {
  const h = harness({ journeys: { count: 0 } });
  await executeIntent(h.client, h.graph(), { solana: h.solana }, { journeyAnswers: { "gas-to-continue:out:s1:base": "sign-anyway" } });
  assert.equal(h.signed.length, 0);
});

test("journeyAnswers: answered blockers let the step run; onJourney is called again when the journey changes", async () => {
  const journeys = { count: 0 };
  const h = harness({ journeys });
  const seen = [];
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana }, {
    onJourney: (journey) => seen.push(journey.digest),
    journeyAnswers: { "gas-to-continue:out:s1:base": "bring-gas" },
  });
  assert.equal(final.status, "completed");
  assert.equal(h.signed.length, 1);
  assert.equal(seen[0], "sha256:ready");
  assert.ok(journeys.count >= 1);
});

test("a journey that cannot be read stops before signing (fail closed); one for another intent is refused", async () => {
  const unreadable = harness({ journeys: { count: 0, respond: () => jsonResponse(404, { error: { code: "INTENT_NOT_FOUND", message: "x" } }) } });
  await assert.rejects(
    executeIntent(unreadable.client, unreadable.graph(), { solana: unreadable.solana }, { journeyAnswers: {} }),
    (error) => error instanceof KletiaExecutionError && /journey of int_g could not be read/u.test(error.message),
  );
  assert.equal(unreadable.signed.length, 0);
  const foreign = harness({ journeys: { count: 0, respond: () => jsonResponse(200, { journey: journeyOf("int_other") }) } });
  await assert.rejects(executeIntent(foreign.client, foreign.graph(), { solana: foreign.solana }, { onJourney: () => {} }), /journey for another intent/u);
  assert.equal(foreign.signed.length, 0);
});

test("without onJourney or journeyAnswers no journey is fetched and nothing is gated", async () => {
  const journeys = { count: 0 };
  const h = harness({ journeys });
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana });
  assert.equal(final.status, "completed");
  assert.equal(journeys.count, 0);
});

test("portfolio(account, { positions }) and portfolios(accounts, { positions })", async () => {
  const { client, calls } = recorder((url) =>
    url.pathname === "/v1/portfolio"
      ? jsonResponse(200, { portfolios: [{ account: ACCOUNT, holdings: [], totalUsd: 0, unpricedCount: 0, observedAt: "x" }], failures: [{ account: "eip155:8453:0x1", code: "RPC_UNAVAILABLE", message: "x" }], observedAt: "x" })
      : jsonResponse(200, { account: ACCOUNT, holdings: [], positions: [], totalUsd: 0 }),
  );
  const one = await client.portfolio(ACCOUNT, { positions: true });
  assert.deepEqual(one.positions, []);
  assert.equal(calls[0].url.searchParams.get("positions"), "true");
  const many = await client.portfolios([ACCOUNT, "eip155:8453:0x1"], { positions: true });
  assert.equal(many.failures[0].code, "RPC_UNAVAILABLE");
  assert.equal(calls[1].url.pathname, "/v1/portfolio");
  assert.equal(calls[1].url.searchParams.get("accounts"), `${ACCOUNT},eip155:8453:0x1`);
  assert.equal(calls[1].url.searchParams.get("positions"), "true");
  assert.throws(() => client.portfolios([]), RangeError);
  assert.throws(() => client.portfolios(Array.from({ length: 13 }, () => ACCOUNT)), RangeError);
  assert.throws(() => client.portfolios(["a,b"]), TypeError);
});

test("KletiaApiError.details carries error.details (SOURCE_REQUIRED candidates); null when absent", async () => {
  const details = { asset: "USDC", amount: "25", toNetwork: "solana", candidates: [{ network: "base", balance: "30" }] };
  const { client } = recorder(() => jsonResponse(422, { error: { code: "SOURCE_REQUIRED", message: "Where does the USDC start?", details } }));
  const error = await client.intents.create({ text: "bridge 25 USDC to solana", accounts: [ACCOUNT] }, { dryRun: true }).catch((caught) => caught);
  assert.ok(error instanceof KletiaApiError);
  assert.deepEqual(error.details, details);
  const plain = recorder(() => jsonResponse(400, { error: { code: "INVALID_REQUEST", message: "x" } }));
  const other = await plain.client.health().catch((caught) => caught);
  assert.equal(other.details, null);
});
