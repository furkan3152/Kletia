// client.data.*: query building, local validation (nothing sent), publishable
// keys allowed, and exportCsv built from the JSON read with core's escaping.
import assert from "node:assert/strict";
import test from "node:test";
import { KletiaClient } from "../dist/index.js";

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-d" } });
}

function recording(respond, options = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    ...options,
    fetch: async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const call = { method: init.method, path: pathname, query: Object.fromEntries(searchParams), headers: init.headers };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

const holding = {
  account: `eip155:8453:${EVM}`, network: "base", asset: "eip155:8453/erc20:0x1", symbol: "=CMD", amount: "1", formatted: "1",
  value: { usd: null, source: "unpriced", asOf: null, reason: "No price source covers this asset." },
};
const portfolio = { holdings: [holding], positions: [], health: [], failures: [], accounts: [], asOf: "2026-10-23T00:00:00.000Z" };

test("data.portfolio and positions send the wallet set and unwrap the portfolio", async () => {
  const { client, calls } = recording((call) => jsonResponse(call.path.endsWith("/portfolio") ? { portfolio } : { positions: [], health: [], failures: [], accounts: [], asOf: "x" }));
  const read = await client.data.portfolio({ evm: EVM, solana: [SOL], lane: "production" });
  assert.equal(read.holdings[0].symbol, "=CMD");
  assert.deepEqual(calls[0], { method: "GET", path: "/v1/data/portfolio", query: { evm: EVM, solana: SOL, lane: "production" }, headers: calls[0].headers });
  await client.data.positions({ evm: [EVM, `0x${"1".repeat(40)}`] });
  assert.equal(calls[1].path, "/v1/data/positions");
  assert.equal(calls[1].query.evm, `${EVM},0x${"1".repeat(40)}`);
});

test("data reads refuse a missing wallet, too many addresses and a comma inside one, before sending", async () => {
  const { client, calls } = recording(() => jsonResponse({ portfolio }));
  await assert.rejects(client.data.portfolio({}), TypeError);
  await assert.rejects(client.data.portfolio({ evm: [EVM, EVM, EVM] }), RangeError);
  await assert.rejects(client.data.positions({ solana: `${SOL},${SOL}` }), TypeError);
  await assert.rejects(client.data.prices({ symbols: Array.from({ length: 21 }, (_, index) => `T${index}`) }), RangeError);
  assert.equal(calls.length, 0);
});

test("history, yields, prices and status build their queries", async () => {
  const { client, calls } = recording(() => jsonResponse({}));
  await client.data.history({ solana: SOL, limit: 20 });
  await client.data.yields({ network: "base", asset: "USDC" });
  await client.data.prices({ symbols: ["ETH", "SOL"] });
  await client.data.status();
  assert.deepEqual(calls.map((call) => [call.path, call.query]), [
    ["/v1/data/history", { solana: SOL, limit: "20" }],
    ["/v1/data/markets/yields", { network: "base", asset: "USDC" }],
    ["/v1/data/markets/prices", { symbols: "ETH,SOL" }],
    ["/v1/data/markets/status", {}],
  ]);
});

test("publishable keys may call every data read", async () => {
  const { client, calls } = recording(() => jsonResponse({ portfolio, yields: [], failures: [], asOf: "x" }), { publishableKey: `kl_pub_${"a".repeat(32)}` });
  await client.data.portfolio({ evm: EVM });
  await client.data.yields();
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers.authorization, /^Bearer kl_pub_/u);
});

test("exportCsv writes the dataset with empty cells for unknown values and a formula guard", async () => {
  const { client } = recording(() => jsonResponse({ portfolio }));
  const csv = await client.data.exportCsv("holdings", { evm: EVM });
  const [header, row] = csv.split("\r\n");
  assert.equal(header, "account,network,asset,symbol,amount,usd,source,as_of,reason");
  assert.equal(row, `eip155:8453:${EVM},base,eip155:8453/erc20:0x1,'=CMD,1,,unpriced,,No price source covers this asset.`);
});

const transaction = {
  id: "base:0x02", network: "base", hash: "0x02", account: `eip155:8453:${EVM}`, time: "2026-10-20T00:00:00.000Z", block: 1, kind: "swap", status: "success",
  legs: [
    { asset: { symbol: "ETH", address: null, decimals: 18, id: "eip155:8453/slip44:60" }, amount: "0.1", direction: "out", usdAtTime: 300, priceSource: "defillama" },
    { asset: { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, id: null }, amount: "250", direction: "in", usdAtTime: null, priceSource: null, reason: "No historical price was found for this time." },
  ],
  fee: null, counterparty: null, protocol: { id: "kyberswap", label: "KyberSwap", role: "aggregator-router" }, method: "swap",
  kletiaIntentId: null, kletiaReceiptId: null, source: "etherscan", explorerUrl: "https://basescan.org/tx/0x02",
};

test("transactions, transaction, pnl, snapshots and summary build their queries", async () => {
  const { client, calls } = recording((call) => jsonResponse(
    call.path.startsWith("/v1/data/transactions/") ? { transaction } : call.path.endsWith("/summary") ? { summary: { risks: [] } } : { transactions: [transaction], cursor: null, coverage: [], asOf: "x" },
  ));
  await client.data.transactions({ evm: EVM, kind: "swap", asset: "USDC", kletiaOnly: true, limit: 10, cursor: "abc" });
  const one = await client.data.transaction("base:0x02", { evm: EVM });
  assert.equal(one.kind, "swap");
  await client.data.pnl({ solana: SOL, period: "30d" });
  await client.data.snapshots({ evm: EVM, range: "7d" });
  const summary = await client.data.summary({ evm: EVM });
  assert.deepEqual(summary.risks, []);
  await client.data.positions({ evm: EVM, extras: true });
  assert.deepEqual(calls.map((call) => [call.path, call.query]), [
    ["/v1/data/transactions", { evm: EVM, kind: "swap", asset: "USDC", cursor: "abc", kletiaOnly: "true", limit: "10" }],
    ["/v1/data/transactions/base%3A0x02", { evm: EVM }],
    ["/v1/data/pnl", { solana: SOL, period: "30d" }],
    ["/v1/data/snapshots", { evm: EVM, range: "7d" }],
    ["/v1/data/summary", { evm: EVM }],
    ["/v1/data/positions", { evm: EVM, extras: "true" }],
  ]);
});

test("exportCsv writes transactions one row per leg, unknown prices as empty cells", async () => {
  const { client } = recording(() => jsonResponse({ transactions: [transaction], cursor: null, coverage: [], asOf: "x" }));
  const csv = await client.data.exportCsv("transactions", { evm: EVM });
  const rows = csv.trim().split("\r\n");
  assert.equal(rows.length, 3);
  assert.match(rows[1], /,swap,success,out,ETH,native,0\.1,300,/u);
  assert.match(rows[2], /,in,USDC,0x833589fcd6edb6e08f4c7c32d4f71b54bda02913,250,,/u);
});

test("assistant.ask posts the question and unwraps the answer", async () => {
  const answer = { route: "portfolio-question", status: "answered", text: "You hold 0.05 ETH.", facts: [], query: null, followUps: [], assumptions: [], gaps: [], wording: "template", understoodBy: "parser", wallets: [], asOf: "x" };
  const { client, calls } = recording(() => jsonResponse({ answer }));
  const read = await client.assistant.ask({ question: "how much ETH do I have?", wallets: { evm: [EVM] } });
  assert.equal(read.text, "You hold 0.05 ETH.");
  assert.deepEqual([calls[0].method, calls[0].path], ["POST", "/v1/assistant/ask"]);
  await assert.rejects(() => client.assistant.ask({ question: " " }), RangeError);
  assert.equal(calls.length, 1, "an empty question is refused locally");
});
