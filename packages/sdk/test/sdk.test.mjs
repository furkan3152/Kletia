import assert from "node:assert/strict";
import test from "node:test";
import {
  KletiaApiError,
  KletiaClient,
  KletiaExecutionError,
  eip1193Signer,
  executeIntent,
  readServerSentEvents,
  walletStandardSolanaSigner,
} from "../dist/index.js";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM = "0x000000000000000000000000000000000000dEaD";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers },
  });
}

test("client sends auth header, normalizes base URL and parses errors", async () => {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001/v1/",
    apiKey: "kl_dev_test",
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/networks")) return jsonResponse(200, { networks: [{ key: "base" }] });
      return jsonResponse(422, { error: { code: "INTENT_UNSUPPORTED", message: "nope", issues: [{ path: "text", message: "x" }], hints: ["swap 1 SOL to USDC", 7] } });
    },
  });
  assert.equal(client.baseUrl, "http://localhost:3001");
  const networks = await client.networks();
  assert.equal(networks[0].key, "base");
  assert.equal(calls[0].init.headers.authorization, "Bearer kl_dev_test");
  await assert.rejects(
    client.intents.create({ text: "hello", accounts: [`eip155:8453:${EVM}`] }, { dryRun: true }),
    (error) => error instanceof KletiaApiError && error.code === "INTENT_UNSUPPORTED" && error.status === 422 && error.issues.length === 1 && error.hints.length === 1 && error.hints[0] === "swap 1 SOL to USDC" && error.requestId === "req-1",
  );
  assert.ok(calls[1].url.endsWith("/v1/intents?dryRun=true"));
});

test("client rejects plain HTTP for non-local hosts", () => {
  assert.throws(() => new KletiaClient({ baseUrl: "http://api.example.com", fetch: async () => jsonResponse(200, {}) }));
});

test("network failures become retryable KletiaApiError", async () => {
  const client = new KletiaClient({ fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(client.health(), (error) => error instanceof KletiaApiError && error.retryable && error.code === "NETWORK_ERROR");
});

test("SSE parser handles split frames, comments, ids and CRLF", async () => {
  const chunks = [": heartbeat\n\nid: evt_1\nevent: message\nda", "ta: {\"a\":1}\r\n\r\nid: evt_2\ndata: line1\ndata: line2\n\n"];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readServerSentEvents(stream)) events.push(event);
  assert.deepEqual(events, [
    { id: "evt_1", event: "message", data: "{\"a\":1}" },
    { id: "evt_2", data: "line1\nline2" },
  ]);
});

test("eip1193 signer switches chain, sends hex values and waits for receipts", async () => {
  const requests = [];
  let chain = "0x1";
  const provider = {
    async request({ method, params }) {
      requests.push(method);
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") { chain = params[0].chainId; return null; }
      if (method === "eth_sendTransaction") {
        assert.equal(params[0].value, "0xde0b6b3a7640000");
        return `0x${"ab".repeat(32)}`;
      }
      if (method === "eth_getTransactionReceipt") return { status: "0x1" };
      throw new Error(method);
    },
  };
  const signer = eip1193Signer(provider, EVM, { pollIntervalMs: 1 });
  const hash = await signer.sendTransaction({ vm: "evm", network: "base", chainId: 8453, from: EVM, to: EVM, data: "0x", value: "1000000000000000000", description: "t" });
  await signer.waitForTransaction(hash, 8453);
  assert.equal(chain, "0x2105");
  assert.ok(requests.includes("wallet_switchEthereumChain"));
  await assert.rejects(signer.sendTransaction({ vm: "evm", network: "base", chainId: 8453, from: `0x${"11".repeat(20)}`, to: EVM, data: "0x", value: "0", description: "t" }));
});

test("wallet-standard signer enforces fee payer and returns base58 signatures", async () => {
  const wallet = {
    name: "TestWallet",
    features: {
      "solana:signAndSendTransaction": {
        async signAndSendTransaction(input) {
          assert.equal(input.chain, "solana:mainnet");
          assert.ok(input.transaction instanceof Uint8Array);
          return [{ signature: new Uint8Array(64).fill(7) }];
        },
      },
    },
  };
  const signer = walletStandardSolanaSigner(wallet, { address: SOL, chains: ["solana:mainnet"] }, "solana:mainnet");
  const signature = await signer.signAndSendTransaction({ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "t" });
  assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/u);
  await assert.rejects(signer.signAndSendTransaction({ vm: "svm", network: "solana", feePayer: "11111111111111111111111111111111", transaction: "AQID", encoding: "base64", description: "t" }));
  assert.throws(() => walletStandardSolanaSigner(wallet, { address: SOL, chains: ["solana:devnet"] }, "solana:mainnet"));
});

test("executeIntent prepares, signs, submits and waits for settlement", async () => {
  const account = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
  const step = (status) => ({ id: "s1", index: 0, kind: "swap", title: "Swap", network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account, protocol: "jupiter", mode: "wallet", dependsOn: [], status, evidence: [] });
  const graph = (status, stepStatus) => ({ spec: "kletia.intent/v1", id: "int_1", status, steps: [step(stepStatus)] });
  const log = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      log.push(`${init.method} ${new URL(url).pathname}`);
      if (url.endsWith("/prepare")) {
        return jsonResponse(200, { intent: graph("executing", "awaiting_signature"), payload: { vm: "svm", transactions: [{ vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: "swap" }], expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "x" } });
      }
      if (url.endsWith("/submit")) {
        assert.deepEqual(JSON.parse(init.body).references.length, 1);
        return jsonResponse(200, { intent: graph("settling", "settling") });
      }
      if (url.endsWith("/refresh")) return jsonResponse(200, { intent: graph("completed", "settled") });
      throw new Error(url);
    },
  });
  const solana = { address: SOL, async signAndSendTransaction() { return "5".repeat(88); } };
  const updates = [];
  const final = await executeIntent(client, graph("planned", "ready"), { solana }, { pollIntervalMs: 1, onUpdate: (intent) => updates.push(intent.status) });
  assert.equal(final.status, "completed");
  assert.deepEqual(log, ["POST /v1/intents/int_1/steps/s1/prepare", "POST /v1/intents/int_1/steps/s1/submit", "POST /v1/intents/int_1/refresh"]);
  assert.deepEqual(updates, ["planned", "settling", "completed"]);
  await assert.rejects(executeIntent(client, graph("planned", "ready"), {}), /needs a Solana wallet/u);
  await assert.rejects(executeIntent(client, graph("planned", "ready"), { solana: { ...solana, address: "11111111111111111111111111111111" } }), /connected wallet is different/u);
});

test("SSE parser keeps a CRLF split across chunks as one line ending", async () => {
  const chunks = ["data: a\r", "\ndata: b\r\n\r\n", "data: c\r\n\r", "\n"];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readServerSentEvents(stream)) events.push(event);
  assert.deepEqual(events, [{ data: "a\nb" }, { data: "c" }]);
});

test("intents.stream surfaces the API error envelope", async () => {
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async () => jsonResponse(429, { error: { code: "TOO_MANY_STREAMS", message: "Close a stream first." } }, { "retry-after": "30" }),
  });
  await assert.rejects(
    client.intents.stream("int_x", () => undefined),
    (error) => error instanceof KletiaApiError && error.code === "TOO_MANY_STREAMS" && error.message === "Close a stream first." && error.status === 429 && error.retryAfterSeconds === 30 && error.requestId === "req-1",
  );
});

/** Mock API for one Solana or EVM step whose server state is kept in memory. */
function executionHarness({ intentId, transactions = 1, vm = "svm", submitFailures = [], preparedAt, expiresAt, evmData }) {
  const account = vm === "svm" ? `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}` : `eip155:8453:${EVM}`;
  const counts = { prepare: 0, submit: 0, send: 0 };
  const submitted = [];
  let stepStatus = "ready";
  let refreshStatus;
  const failures = [...submitFailures];
  const step = () => ({
    id: "s1", index: 0, kind: "swap", title: "Swap", network: vm === "svm" ? "solana" : "base",
    chain: vm === "svm" ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" : "eip155:8453", account, protocol: "jupiter", mode: "wallet",
    dependsOn: [], status: stepStatus, evidence: [],
    ...(preparedAt && stepStatus !== "ready" ? { prepared: { quoteBinding: "x", preparedAt, expiresAt, transactions: [] } } : {}),
  });
  const graph = () => ({ spec: "kletia.intent/v1", id: intentId, status: stepStatus === "settled" ? "completed" : "executing", steps: [step()] });
  const payloadTransactions = () =>
    Array.from({ length: transactions }, (_, index) =>
      vm === "svm"
        ? { vm: "svm", network: "solana", feePayer: SOL, transaction: "AQID", encoding: "base64", description: `tx${index}` }
        : { vm: "evm", network: "base", chainId: 8453, from: EVM, to: EVM, data: evmData?.[index] ?? "0x", value: "0", description: `tx${index}` });
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      if (url.endsWith("/prepare")) {
        counts.prepare += 1;
        stepStatus = "awaiting_signature";
        return jsonResponse(200, { intent: graph(), payload: { vm, transactions: payloadTransactions(), expiresAt: expiresAt ?? Math.floor(Date.now() / 1000) + 60, quoteBinding: "x" } });
      }
      if (url.endsWith("/submit")) {
        counts.submit += 1;
        const failure = failures.shift();
        if (failure?.commit) stepStatus = "settling"; // stored, but the response is lost
        if (failure) return jsonResponse(failure.status, { error: { code: failure.code, message: failure.code } }, failure.headers ?? {});
        const { references } = JSON.parse(init.body);
        if (references.length !== transactions) {
          return jsonResponse(400, { error: { code: "REFERENCE_COUNT_MISMATCH", message: "count" } });
        }
        submitted.push(references);
        stepStatus = "settled";
        return jsonResponse(200, { intent: graph() });
      }
      if (url.endsWith(`/intents/${intentId}`)) return jsonResponse(200, { intent: graph() });
      if (url.endsWith("/refresh")) {
        if (refreshStatus) stepStatus = refreshStatus;
        return jsonResponse(200, { intent: graph() });
      }
      throw new Error(url);
    },
  });
  let nonce = 0;
  const solana = { address: SOL, async signAndSendTransaction() { counts.send += 1; nonce += 1; return String(nonce).padStart(88, "5"); } };
  return {
    client, counts, submitted, graph, solana,
    setStatus: (status) => { stepStatus = status; },
    setRefreshStatus: (status) => { refreshStatus = status; },
  };
}

test("executeIntent retries a retryable final submit instead of losing broadcast references", async () => {
  const h = executionHarness({
    intentId: "int_retry",
    submitFailures: [
      { status: 429, code: "RATE_LIMITED", headers: { "retry-after": "0" } },
      { status: 503, code: "UNAVAILABLE", headers: { "retry-after": "0" } },
    ],
  });
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana });
  assert.equal(final.status, "completed");
  assert.deepEqual(h.counts, { prepare: 1, submit: 3, send: 1 });
});

test("executeIntent never prepares a broadcast step again after the submit keeps failing", async () => {
  const unavailable = { status: 503, code: "UNAVAILABLE", headers: { "retry-after": "0" } };
  const h = executionHarness({ intentId: "int_held", submitFailures: [unavailable, unavailable, unavailable] });
  let caught;
  await assert.rejects(executeIntent(h.client, h.graph(), { solana: h.solana }), (error) => {
    caught = error;
    return error instanceof KletiaExecutionError;
  });
  assert.equal(caught.stepId, "s1");
  assert.equal(caught.references.length, 1);
  assert.ok(caught.cause instanceof KletiaApiError && caught.cause.code === "UNAVAILABLE");
  assert.deepEqual(h.counts, { prepare: 1, submit: 3, send: 1 });
  // The step is still awaiting_signature on the server; a retry reports the same references.
  const final = await executeIntent(h.client, "int_held", { solana: h.solana });
  assert.equal(final.status, "completed");
  assert.deepEqual(h.counts, { prepare: 1, submit: 4, send: 1 });
  assert.deepEqual(h.submitted, [caught.references]);
});

test("executeIntent releases held references once Kletia shows it accepted them", async () => {
  const lost = { status: 504, code: "GATEWAY_TIMEOUT", headers: { "retry-after": "0" }, commit: true };
  const h = executionHarness({ intentId: "int_lost", submitFailures: [lost, lost, lost] });
  await assert.rejects(executeIntent(h.client, h.graph(), { solana: h.solana }), (error) => error instanceof KletiaExecutionError && error.references?.length === 1);
  // The server had stored them; a later refresh rejects them (dropped) and the step needs a new signature.
  h.setRefreshStatus("awaiting_signature");
  const final = await executeIntent(h.client, "int_lost", { solana: h.solana }, { pollIntervalMs: 1 });
  assert.equal(final.status, "completed");
  assert.equal(h.counts.prepare, 2);
  assert.equal(h.counts.send, 2);
});

test("executeIntent submits pendingReferences from another run instead of signing again", async () => {
  const h = executionHarness({ intentId: "int_pending" });
  h.setStatus("awaiting_signature");
  const references = ["7".repeat(88)];
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana }, { pendingReferences: { s1: references } });
  assert.equal(final.status, "completed");
  assert.deepEqual(h.counts, { prepare: 0, submit: 1, send: 0 });
  assert.deepEqual(h.submitted, [references]);
});

test("executeIntent holds a value-moving partial broadcast but re-prepares after approvals only", async () => {
  // Solana step with two deposits: the first lands, the wallet rejects the second.
  const held = executionHarness({ intentId: "int_partial", transactions: 2 });
  let sends = 0;
  const rejectSecond = { address: SOL, async signAndSendTransaction() { sends += 1; if (sends === 2) throw new Error("User rejected"); return "6".repeat(88); } };
  await assert.rejects(
    executeIntent(held.client, held.graph(), { solana: rejectSecond }),
    (error) => error instanceof KletiaExecutionError && error.message === "User rejected" && error.references?.length === 1,
  );
  await assert.rejects(executeIntent(held.client, "int_partial", { solana: rejectSecond }), (error) => error instanceof KletiaExecutionError && error.references?.length === 1);
  assert.equal(held.counts.prepare, 1);
  assert.equal(sends, 2);

  // EVM approve + swap: the approval lands, the wallet rejects the swap; signing again is safe.
  const approve = `0x095ea7b3${"0".repeat(128)}`;
  const evmHarness = executionHarness({ intentId: "int_approve", vm: "evm", transactions: 2, evmData: [approve, "0xdeadbeef"] });
  let evmSends = 0;
  const evm = {
    address: EVM,
    async sendTransaction() { evmSends += 1; if (evmSends === 2) throw new Error("User rejected"); return `0x${String(evmSends).padStart(64, "a")}`; },
    async waitForTransaction() {},
  };
  await assert.rejects(executeIntent(evmHarness.client, evmHarness.graph(), { evm }), (error) => error instanceof KletiaExecutionError && error.references === undefined);
  const final = await executeIntent(evmHarness.client, "int_approve", { evm });
  assert.equal(final.status, "completed");
  assert.equal(evmHarness.counts.prepare, 2);
});

test("executeIntent measures payload expiry on the server's clock", async () => {
  // The device clock runs 10 minutes ahead of the API.
  const serverNow = Date.now() - 10 * 60_000;
  const h = executionHarness({
    intentId: "int_skew",
    preparedAt: new Date(serverNow).toISOString(),
    expiresAt: Math.floor(serverNow / 1000) + 90,
  });
  const final = await executeIntent(h.client, h.graph(), { solana: h.solana });
  assert.equal(final.status, "completed");
  assert.deepEqual(h.counts, { prepare: 1, submit: 1, send: 1 });

  const stale = executionHarness({
    intentId: "int_stale",
    preparedAt: new Date(serverNow).toISOString(),
    expiresAt: Math.floor(serverNow / 1000) - 1,
  });
  await assert.rejects(executeIntent(stale.client, stale.graph(), { solana: stale.solana }), /expired before signing/u);
  assert.equal(stale.counts.send, 0);
});
