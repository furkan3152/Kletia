/**
 * Platform RPC clients over public fallbacks: every endpoint reports its
 * chain id before it serves a read, including endpoints the fallback only
 * reaches after the first one fails.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";

const POLYGON = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://1rpc.io/matic"] as const;
const POLYGON_BLOCK = 0x5b0a1c0;
const ETHEREUM_BLOCK = 0x18f0000;

/** Per endpoint: the chain id it reports and whether it is up. */
const endpoints = new Map<string, { chainId: string; up: boolean }>([
  [POLYGON[0], { chainId: "0x89", up: true }],
  [POLYGON[1], { chainId: "0x1", up: true }],
  [POLYGON[2], { chainId: "0x89", up: false }],
]);
const seen: string[] = [];
const realFetch = globalThis.fetch;
const configured = process.env.POLYGON_RPC_URL;

before(() => {
  delete process.env.POLYGON_RPC_URL;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const index = POLYGON.findIndex((entry) => url.startsWith(entry));
    const endpoint = endpoints.get(POLYGON[index] ?? "");
    if (!endpoint) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string } | { id: number; method: string }[];
    const calls = Array.isArray(body) ? body : [body];
    seen.push(...calls.map((call) => `${index}:${call.method}`));
    if (!endpoint.up) return new Response("bad gateway", { status: 502 });
    const answers = calls.map((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      result: call.method === "eth_chainId" ? endpoint.chainId : `0x${(endpoint.chainId === "0x89" ? POLYGON_BLOCK : ETHEREUM_BLOCK).toString(16)}`,
    }));
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  if (configured !== undefined) process.env.POLYGON_RPC_URL = configured;
});

it("attests each fallback endpoint on its own: a wrong-chain endpoint never answers after the first one fails", async () => {
  const { polygonPublicClient } = await import("../../../shared/config/networks.js");
  assert.equal(await polygonPublicClient.getBlockNumber({ cacheTime: 0 }), BigInt(POLYGON_BLOCK));
  assert.equal(await polygonPublicClient.getBlockNumber({ cacheTime: 0 }), BigInt(POLYGON_BLOCK));
  assert.deepEqual(seen, ["0:eth_chainId", "0:eth_blockNumber", "0:eth_blockNumber"], "attested once, then cached");
  // The first endpoint goes down; the next one reports chain 1 and the last one is down too.
  (endpoints.get(POLYGON[0]) as { up: boolean }).up = false;
  seen.length = 0;
  await assert.rejects(polygonPublicClient.getBlockNumber({ cacheTime: 0 }));
  assert.ok(seen.includes("1:eth_chainId"), "the fallback endpoint is asked for its chain id");
  assert.ok(!seen.includes("1:eth_blockNumber"), "and never serves the read");
  // Once a correct endpoint is back, it is attested before it serves.
  (endpoints.get(POLYGON[2]) as { up: boolean }).up = true;
  seen.length = 0;
  assert.equal(await polygonPublicClient.getBlockNumber({ cacheTime: 0 }), BigInt(POLYGON_BLOCK));
  assert.ok(seen.indexOf("2:eth_chainId") !== -1 && seen.indexOf("2:eth_chainId") < seen.indexOf("2:eth_blockNumber"), seen.join(" "));
});
