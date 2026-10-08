import assert from "node:assert/strict";
import test from "node:test";
import {
  KletiaApiError,
  KletiaClient,
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
