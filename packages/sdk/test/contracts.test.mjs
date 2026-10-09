import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_REVIEW_NOTICE } from "@kletia/core";
import { KletiaClient, KletiaExecutionError, executeIntent } from "../dist/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVM = "0x000000000000000000000000000000000000dEaD";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
const OTHER = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ASSET = `eip155:8453/erc20:${USDC}`;
const CT = "ct_5f1c2a9b7e3d4c6a8b0e1f23";
const CS = `cs_${"0123456789abcdef".repeat(2)}`;
const DEPOSIT = "0x6e553f65";

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-c", ...headers },
  });
}

const word = (hex) => hex.replace(/^0x/u, "").toLowerCase().padStart(64, "0");
const approveData = (spender, amount) => `0x095ea7b3${word(spender)}${word(BigInt(amount).toString(16))}`;
const depositData = (amount, receiver) => `${DEPOSIT}${word(BigInt(amount).toString(16))}${word(receiver)}`;

/* ---------------------------------------------------------- client routes */

/** A client whose fetch records each request and answers from `respond` (or a script of responders). */
function recording(respond, options = {}) {
  const calls = [];
  const script = Array.isArray(respond) ? respond : null;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      const call = { method: init.method, path: pathname, search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const responder = script ? script[Math.min(calls.length - 1, script.length - 1)] : respond;
      return responder(call);
    },
  });
  return { client, calls };
}

const definition = {
  vm: "evm",
  network: "base",
  address: VAULT,
  integrator: { name: "Acme Yield", website: "https://acme.example" },
  abi: [],
  actions: [],
};
const view = { id: CT, vm: "evm", network: "base", address: VAULT, status: "pending", revision: 1, activeRevision: null, pendingRevision: 1, activatesAt: "2026-10-09T12:15:00.000Z", actions: [] };

test("contracts methods call the documented routes and unwrap the documented envelopes", async () => {
  const { client, calls } = recording((call) => {
    const route = `${call.method} ${call.path}`;
    if (route === "POST /v1/contracts") return jsonResponse(201, { contract: view });
    if (route === "GET /v1/contracts") return jsonResponse(200, { contracts: [view] });
    if (route === "GET /v1/contracts/inspect") {
      return jsonResponse(200, { inspection: call.search.includes("programs") ? { vm: "svm", network: "solana", programs: [] } : { vm: "evm", network: "base", address: VAULT, functions: [] } });
    }
    if (route === `GET /v1/contracts/${CT}`) return jsonResponse(200, { contract: { ...view, revisions: [{ revision: 1, definitionHash: "ab", createdAt: "x" }] } });
    if (route === `PATCH /v1/contracts/${CT}`) return jsonResponse(200, { contract: { ...view, revision: 2 } });
    if (route === `DELETE /v1/contracts/${CT}`) return new Response(null, { status: 204 });
    if (route === `POST /v1/contracts/${CT}/test`) return jsonResponse(200, { test: { contract: CT, entry: call.body.entry, review: { kind: "evm-call" } } });
    if (route === `POST /v1/contracts/${CT}/reverify`) return jsonResponse(200, { contract: { ...view, revision: 3 } });
    throw new Error(`unexpected ${route}`);
  }, { apiKey: "kl_dev_test" });

  const registered = await client.contracts.register(definition);
  assert.equal(registered.contract.id, CT, "register returns { contract }");
  assert.deepEqual(calls[0].body, definition);
  assert.match(calls[0].headers["idempotency-key"], UUID);
  assert.equal(calls[0].headers.authorization, "Bearer kl_dev_test");

  const list = await client.contracts.list({ network: "base", status: "active" });
  assert.equal(list[0].id, CT);
  assert.equal(calls[1].search, "?network=base&status=active");
  await client.contracts.list();
  assert.equal(calls[2].search, "");

  const one = await client.contracts.get(CT);
  assert.equal(one.revisions[0].revision, 1);

  const updated = await client.contracts.update(CT, { actions: [] });
  assert.equal(updated.revision, 2);
  assert.equal(calls[4].method, "PATCH");
  assert.deepEqual(calls[4].body, { actions: [] });
  assert.match(calls[4].headers["idempotency-key"], UUID);

  assert.equal(await client.contracts.delete(CT), undefined);

  const result = await client.contracts.test(CT, { entry: "deposit", account: `eip155:8453:${EVM}`, amount: "100", params: { lockDays: "30" } });
  assert.equal(result.entry, "deposit");
  assert.deepEqual(calls[6].body, { entry: "deposit", account: `eip155:8453:${EVM}`, amount: "100", params: { lockDays: "30" } });
  assert.equal(calls[6].headers["idempotency-key"], undefined, "a test stores nothing, so it carries no key");

  assert.equal((await client.contracts.reverify(CT)).revision, 3);
  assert.deepEqual(calls[7].body, {});
  assert.match(calls[7].headers["idempotency-key"], UUID);

  assert.equal((await client.contracts.inspect({ network: "base", address: VAULT })).vm, "evm");
  assert.equal(calls[8].search, `?network=base&address=${VAULT}`);
  await client.contracts.inspect({ network: "solana", programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV"] });
  assert.equal(
    new URLSearchParams(calls[9].search).get("programs"),
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4,noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
  );
  assert.equal(calls.length, 10);
});

test("register, update and reverify are retried with one Idempotency-Key; tests are retried as reads", async () => {
  const unavailable = () => jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "0" });
  const registering = recording([unavailable, () => jsonResponse(201, { contract: view })], { apiKey: "kl_dev_test" });
  await registering.client.contracts.register(definition);
  assert.equal(registering.calls.length, 2);
  assert.equal(registering.calls[0].headers["idempotency-key"], registering.calls[1].headers["idempotency-key"]);

  const patching = recording([unavailable, () => jsonResponse(200, { contract: view })], { apiKey: "kl_dev_test" });
  await patching.client.contracts.update(CT, { visibility: "project" }, { idempotencyKey: "rename-1" });
  assert.deepEqual(patching.calls.map((call) => call.headers["idempotency-key"]), ["rename-1", "rename-1"]);

  const reverifying = recording([unavailable, () => jsonResponse(200, { contract: view })], { apiKey: "kl_dev_test" });
  await reverifying.client.contracts.reverify(CT);
  assert.equal(reverifying.calls.length, 2);

  const testing = recording([
    () => jsonResponse(503, { error: { code: "SIMULATION_UNAVAILABLE", message: "x" } }, { "retry-after": "0" }),
    () => jsonResponse(200, { test: { contract: CT } }),
  ], { apiKey: "kl_dev_test" });
  await testing.client.contracts.test(CT, { entry: "deposit", account: `eip155:8453:${EVM}` });
  assert.equal(testing.calls.length, 2);
  assert.ok(testing.calls.every((call) => call.headers["idempotency-key"] === undefined));

  // Without a key nothing is generated, so a state-changing call is sent once.
  const keyless = recording([unavailable]);
  await assert.rejects(keyless.client.contracts.register(definition), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(keyless.calls.length, 1);

  // A lost DELETE whose retry finds the registration gone is done.
  const deleting = recording([() => { throw new TypeError("socket hang up"); }, () => jsonResponse(404, { error: { code: "CONTRACT_NOT_FOUND", message: "x" } })], { apiKey: "kl_dev_test" });
  await deleting.client.contracts.delete(CT);
  assert.equal(deleting.calls.length, 2);
});

test("the low-level request helper accepts PATCH and classifies the contract routes", async () => {
  const { client, calls } = recording(() => jsonResponse(200, { contract: view }), { apiKey: "kl_dev_test" });
  await client.request("PATCH", `/v1/contracts/${CT}/`, { actions: [] });
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].headers["idempotency-key"], UUID);
  await client.request("POST", "/sessions", { actions: [] });
  assert.match(calls[1].headers["idempotency-key"], UUID);
  await client.request("POST", `/sessions/${CS}/intents`, { accounts: [] });
  assert.equal(calls[2].headers["idempotency-key"], undefined, "public session intents never carry a key");
});

test("malformed contract and session ids are refused before any request", async () => {
  const { client, calls } = recording(() => jsonResponse(200, {}), { apiKey: "kl_dev_test" });
  for (const id of ["", "ct_123", "..", "ct_5F1C2A9B7E3D4C6A8B0E1F23", `${CT}/test`, "int_1"]) {
    await assert.rejects(client.contracts.get(id), TypeError, JSON.stringify(id));
    await assert.rejects(client.contracts.delete(id), TypeError);
  }
  await assert.rejects(client.sessions.get("cs_123"), TypeError);
  await assert.rejects(client.sessions.createIntent("..", { accounts: [], hostOrigin: "https://acme.example" }), TypeError);
  assert.equal(calls.length, 0);
});

test("sessions: create with a key; read and turn into an intent without one", async () => {
  const session = { id: CS, status: "active", expiresAt: "x", embedUrl: `https://kletiaai.xyz/embed#session=${CS}` };
  const backend = recording(() => jsonResponse(201, { session }), { apiKey: "kl_dev_test" });
  const request = { actions: [{ kind: "call", network: "base", contract: CT, entry: "deposit", amount: "100" }], allowedOrigins: ["https://acme.example"], expiresInSeconds: 900 };
  const created = await backend.client.sessions.create(request);
  assert.equal(created.embedUrl, session.embedUrl);
  assert.equal(backend.calls[0].path, "/v1/sessions");
  assert.deepEqual(backend.calls[0].body, request);
  assert.match(backend.calls[0].headers["idempotency-key"], UUID);

  const browser = recording((call) =>
    call.method === "GET"
      ? jsonResponse(200, { session })
      : jsonResponse(201, { intent: { id: "int_s", status: "planned", steps: [] } }),
  );
  assert.equal((await browser.client.sessions.get(CS)).id, CS);
  assert.equal(browser.calls[0].headers.authorization, undefined);
  const accounts = [`eip155:8453:${EVM}`];
  const { intent } = await browser.client.sessions.createIntent(CS, { accounts, amount: "25", hostOrigin: "https://acme.example" });
  assert.equal(intent.id, "int_s");
  assert.equal(browser.calls[1].path, `/v1/sessions/${CS}/intents`);
  assert.deepEqual(browser.calls[1].body, { accounts, amount: "25", hostOrigin: "https://acme.example" });
  assert.equal(browser.calls[1].headers["idempotency-key"], undefined);
});

test("sessions.createIntent defaults hostOrigin to the page origin, needs it elsewhere, and is never retried", async () => {
  const { client, calls } = recording([
    () => jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "x" } }, { "retry-after": "0" }),
    () => jsonResponse(201, { intent: { id: "int_s" } }),
  ]);
  const accounts = [`eip155:8453:${EVM}`];
  await assert.rejects(client.sessions.createIntent(CS, { accounts }), (error) => error instanceof TypeError && /hostOrigin/u.test(error.message));
  assert.equal(calls.length, 0, "refused before the request");

  Object.defineProperty(globalThis, "location", { value: { origin: "https://shop.acme.example" }, configurable: true });
  try {
    await assert.rejects(client.sessions.createIntent(CS, { accounts }), (error) => error.code === "STORE_UNAVAILABLE");
    assert.equal(calls.length, 1, "uses the session up, so it is sent once");
    assert.equal(calls[0].body.hostOrigin, "https://shop.acme.example");
  } finally {
    delete globalThis.location;
  }
});

/* ------------------------------------------------------- executeIntent gate */

const review = (overrides = {}) => ({
  kind: "evm-call",
  integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: true },
  notices: [CONTRACT_REVIEW_NOTICE],
  contract: { network: "base", address: VAULT, explorerUrl: `https://basescan.org/address/${VAULT}`, source: "exact_match", registeredAt: "2026-10-09T10:00:00.000Z", revision: 1 },
  call: { label: "Deposit into Acme USDC vault", function: "deposit(uint256 assets, address receiver)", args: [] },
  approvals: [{
    token: { asset: USDC_ASSET, symbol: "USDC", decimals: 6 },
    spender: VAULT,
    amount: { asset: USDC_ASSET, symbol: "USDC", decimals: 6, amount: "100000000", formatted: "100" },
  }],
  simulation: { status: "ok", at: "prepare", assetChanges: [], warnings: [] },
  ...overrides,
});

const evmTransactions = () => [
  { vm: "evm", network: "base", chainId: 8453, from: EVM, to: USDC, data: approveData(VAULT, 100_000_000), value: "0", description: "Approve exactly 100 USDC" },
  { vm: "evm", network: "base", chainId: 8453, from: EVM, to: VAULT, data: depositData(100_000_000, EVM), value: "0", description: "Deposit" },
];

/** Mock API for one custom-contract step (EVM call by default, Solana Action with `vm: "svm"`). */
function callHarness({ intentId, vm = "evm", transactions, payloadReview } = {}) {
  const counts = { prepare: 0, submit: 0, send: 0 };
  let stepStatus = "ready";
  const evm = vm === "evm";
  const step = (reviewed) => ({
    id: "s1", index: 0, kind: evm ? "call" : "action", title: "Deposit into Acme USDC vault · Acme Yield",
    network: evm ? "base" : "solana", chain: evm ? "eip155:8453" : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    account: evm ? `eip155:8453:${EVM}` : `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`,
    protocol: evm ? "custom-call" : "solana-actions", mode: "wallet", dependsOn: [], status: stepStatus, evidence: [],
    input: evm ? { asset: USDC_ASSET, symbol: "USDC", decimals: 6, amount: "100000000", formatted: "100" } : undefined,
    call: {
      contract: CT, revision: 1, definitionHash: "ab", entry: "deposit", vm: evm ? "evm" : "svm",
      target: evm ? VAULT : "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      integrator: { name: "Acme Yield", domainVerified: true }, label: "Deposit into Acme USDC vault",
      ...(evm ? { function: "deposit(uint256,address)", selector: DEPOSIT, approvalSpender: VAULT } : {}),
      review: reviewed,
    },
  });
  const planReview = review({ simulation: { status: "ok", at: "plan", assetChanges: [], warnings: [] } });
  const prepareReview = payloadReview === undefined ? (evm ? review() : review({ kind: "solana-action", contract: undefined, call: undefined, approvals: [] })) : payloadReview;
  const graph = (reviewed = planReview) => ({ spec: "kletia.intent/v1", id: intentId, status: stepStatus === "settled" ? "completed" : "executing", steps: [step(reviewed)] });
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      if (url.endsWith("/prepare")) {
        counts.prepare += 1;
        stepStatus = "awaiting_signature";
        const prepared = transactions ?? (evm ? evmTransactions() : [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "Stake" }]);
        return jsonResponse(200, {
          intent: graph(prepareReview ?? planReview),
          payload: { vm, transactions: prepared, expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "x", ...(prepareReview ? { review: prepareReview } : {}) },
        });
      }
      if (url.endsWith("/submit")) {
        counts.submit += 1;
        stepStatus = "settled";
        return jsonResponse(200, { intent: graph(prepareReview) });
      }
      throw new Error(url);
    },
  });
  let nonce = 0;
  const signers = {
    evm: { address: EVM, async sendTransaction() { counts.send += 1; nonce += 1; return `0x${String(nonce).padStart(64, "a")}`; }, async waitForTransaction() {} },
    solana: { address: SOL, async signAndSendTransaction() { counts.send += 1; return "5".repeat(88); } },
  };
  return { client, counts, graph, signers, planReview, prepareReview };
}

test("executeIntent refuses a custom-contract step without onReview, before preparing it", async () => {
  const h = callHarness({ intentId: "int_noreview" });
  await assert.rejects(
    executeIntent(h.client, h.graph(), h.signers),
    (error) => error instanceof KletiaExecutionError && error.stepId === "s1" && /Acme Yield/u.test(error.message) && /onReview/u.test(error.message),
  );
  assert.deepEqual(h.counts, { prepare: 0, submit: 0, send: 0 });
});

test("onReview sees the prepare review before any wallet prompt; anything but true stops without signing", async () => {
  for (const answer of [false, "yes", undefined]) {
    const h = callHarness({ intentId: "int_declined" });
    const seen = [];
    const updates = [];
    const final = await executeIntent(h.client, h.graph(), h.signers, {
      onUpdate: (intent) => updates.push(intent.steps[0].status),
      onReview: async (step, shown, context) => {
        seen.push({ step, shown, context, sends: h.counts.send });
        return answer;
      },
    });
    assert.equal(final.steps[0].status, "awaiting_signature");
    assert.deepEqual(h.counts, { prepare: 1, submit: 0, send: 0 }, String(answer));
    assert.equal(seen.length, 1);
    const [{ step, shown, context, sends }] = seen;
    assert.equal(sends, 0, "asked before the wallet");
    assert.equal(step.id, "s1");
    assert.equal(shown.simulation.at, "prepare", "the review of the prepared transactions");
    assert.equal(context.planned.simulation.at, "plan");
    assert.equal(context.transactions.length, 2);
    assert.equal(context.intent.id, "int_declined");
    assert.equal(typeof context.expiresAt, "number");
    assert.deepEqual(updates, ["ready", "awaiting_signature"]);
  }
});

test("a confirmed review signs the exact approval and the call, then submits", async () => {
  const h = callHarness({ intentId: "int_confirmed" });
  let reviews = 0;
  const final = await executeIntent(h.client, h.graph(), h.signers, { onReview: () => { reviews += 1; return true; } });
  assert.equal(final.status, "completed");
  assert.equal(reviews, 1);
  assert.deepEqual(h.counts, { prepare: 1, submit: 1, send: 2 });

  // An allowance reset before the exact approval (USDT-style) is accepted too.
  const reset = callHarness({
    intentId: "int_reset",
    transactions: [{ ...evmTransactions()[0], data: approveData(VAULT, 0) }, ...evmTransactions()],
  });
  const done = await executeIntent(reset.client, reset.graph(), reset.signers, { onReview: () => true });
  assert.equal(done.status, "completed");
  assert.equal(reset.counts.send, 3);
});

test("a review without an ok simulation, or no review at all, is refused before onReview", async () => {
  const cases = [
    { name: "unavailable", payloadReview: review({ simulation: { status: "unavailable", at: "prepare", assetChanges: [], warnings: ["down"] } }), message: /could not be simulated/u },
    { name: "missing", payloadReview: null, message: /no review/u },
    { name: "wrong kind", payloadReview: review({ kind: "solana-action" }), message: /does not belong/u },
    { name: "no notices", payloadReview: review({ notices: [] }), message: /no notices/u },
  ];
  for (const { name, payloadReview, message } of cases) {
    const h = callHarness({ intentId: `int_${name.replace(/\W/gu, "")}`, payloadReview });
    let called = false;
    await assert.rejects(
      executeIntent(h.client, h.graph(), h.signers, { onReview: () => { called = true; return true; } }),
      (error) => error instanceof KletiaExecutionError && /Refused to sign step s1/u.test(error.message) && message.test(error.message),
      name,
    );
    assert.equal(called, false, name);
    assert.equal(h.counts.send, 0, name);
  }
});

test("prepared transactions that differ from the review or the registration are never signed", async () => {
  const [approval, call] = evmTransactions();
  const cases = [
    { name: "call to another contract", transactions: [approval, { ...call, to: OTHER }], message: /not sent to the registered contract/u },
    { name: "another function", transactions: [approval, { ...call, data: `0xb6b55f25${word("64")}` }], message: /not the registered function/u },
    { name: "value not in the review", transactions: [approval, { ...call, value: "1" }], message: /different value/u },
    { name: "approval to another spender", transactions: [{ ...approval, data: approveData(OTHER, 100_000_000) }, call], message: /spender the registration does not pin/u },
    { name: "unlimited approval", transactions: [{ ...approval, data: approveData(VAULT, (1n << 256n) - 1n) }, call], message: /differs from the one the review shows/u },
    { name: "approval of another token", transactions: [{ ...approval, to: OTHER }, call], message: /token other than the step input/u },
    { name: "approval that is not approve()", transactions: [{ ...approval, data: `0xa9059cbb${word(OTHER)}${word("1")}` }, call], message: /not a token approval/u },
    { name: "approval with trailing data", transactions: [{ ...approval, data: `${approval.data}00` }, call], message: /not a token approval/u },
    { name: "reset only", transactions: [{ ...approval, data: approveData(VAULT, 0) }, call], message: /sets no allowance/u },
    { name: "two approvals", transactions: [approval, approval, call], message: /only an allowance reset/u },
    { name: "approval missing from the review", transactions: [approval, call], payloadReview: review({ approvals: [] }), message: /approvals differ/u },
    { name: "four transactions", transactions: [approval, approval, approval, call], message: /one to three/u },
    { name: "review of another contract", transactions: [approval, call], payloadReview: review({ contract: { ...review().contract, address: OTHER } }), message: /different contract/u },
  ];
  for (const { name, transactions, payloadReview, message } of cases) {
    const h = callHarness({ intentId: `int_${name.replace(/\W/gu, "")}`, transactions, payloadReview });
    let called = false;
    await assert.rejects(
      executeIntent(h.client, h.graph(), h.signers, { onReview: () => { called = true; return true; } }),
      (error) => error instanceof KletiaExecutionError && message.test(error.message),
      name,
    );
    assert.equal(called, false, `${name}: the user is never asked about a mismatching payload`);
    assert.equal(h.counts.send, 0, `${name}: no wallet prompt`);
  }
});

test("Solana Action steps go through onReview and sign exactly one transaction", async () => {
  const h = callHarness({ intentId: "int_action", vm: "svm" });
  const kinds = [];
  const final = await executeIntent(h.client, h.graph(), h.signers, { onReview: (_step, shown) => { kinds.push(shown.kind); return true; } });
  assert.equal(final.status, "completed");
  assert.deepEqual(kinds, ["solana-action"]);
  assert.equal(h.counts.send, 1);

  const tx = { vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "x" };
  const two = callHarness({ intentId: "int_action2", vm: "svm", transactions: [tx, tx] });
  await assert.rejects(executeIntent(two.client, two.graph(), two.signers, { onReview: () => true }), /signs one transaction, not 2/u);
  assert.equal(two.counts.send, 0);
});
