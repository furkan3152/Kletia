/**
 * Recorded and constructed provider responses for the wallet history tests
 * (fixtures/history/*.json, each file says which it is), served through
 * `configureHistoryFetch` so no test reaches a provider.
 *
 * - solana-rpc-*.json, kamino-obligations.json, defillama.json: recorded
 *   read-only from the public endpoints on 2026-10-24;
 * - etherscan-base.json, helius-solana.json, alchemy-ethereum.json:
 *   constructed from the providers' documented schemas (no API keys here).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { HistoryFetcher } from "../../data/index.js";
import { PlatformError } from "../../errors.js";

const DIR = fileURLToPath(new URL("./fixtures/history/", import.meta.url));

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fs.readFileSync(`${DIR}${name}.json`, "utf8")) as T;
}

interface RpcCall {
  readonly request: { readonly method: string; readonly params: readonly unknown[] };
  readonly response: unknown;
}

export interface FixtureFetchLog {
  readonly urls: string[];
}

/** Every fixture file behind one fetcher; an unknown request fails like an unreachable provider. */
export function fixtureFetcher(log: FixtureFetchLog = { urls: [] }): HistoryFetcher {
  const etherscan = fixture<{ address: string; responses: Record<string, unknown>; missingKey: { body: unknown } }>("etherscan-base");
  const helius = fixture<{ address: string; body: unknown }>("helius-solana");
  const alchemy = fixture<{ fromAddress: unknown; toAddress: unknown }>("alchemy-ethereum");
  const rpcCalls = [...fixture<{ calls: RpcCall[] }>("solana-rpc-trader").calls, ...fixture<{ calls: RpcCall[] }>("solana-rpc-transfers").calls];
  const kamino = fixture<{ url: string; body: unknown }>("kamino-obligations");
  const llama = fixture<{ prices: Record<string, Record<string, { timestamp: number; price: number }>> }>("defillama").prices;
  return async (url, request) => {
    log.urls.push(url);
    const parsed = new URL(url);
    if (parsed.host === "api.etherscan.io") {
      if (parsed.searchParams.get("apikey") === "invalid-key") return etherscan.missingKey.body;
      if (parsed.searchParams.get("chainid") !== "8453") return { status: "0", message: "No transactions found", result: [] };
      // The same history for whichever wallet asks (tests sign in with fresh wallets).
      const asked = (parsed.searchParams.get("address") ?? "").toLowerCase();
      const body = etherscan.responses[parsed.searchParams.get("action") ?? ""] as { result: { blockNumber: string }[] };
      // Etherscan's paging: rows up to `endblock`, newest first, at most `offset`.
      const endblock = Number(parsed.searchParams.get("endblock"));
      const offset = Number(parsed.searchParams.get("offset"));
      const result = body.result.filter((row) => Number(row.blockNumber) <= endblock).slice(0, offset);
      return JSON.parse(JSON.stringify({ ...body, result }).replaceAll(etherscan.address, asked));
    }
    if (parsed.host.endsWith(".g.alchemy.com")) {
      if (parsed.host !== "eth-mainnet.g.alchemy.com") return { jsonrpc: "2.0", id: 1, result: { transfers: [] } };
      const params = (request.body as { params: [Record<string, unknown>] }).params[0];
      return "fromAddress" in params ? alchemy.fromAddress : alchemy.toAddress;
    }
    if (parsed.host === "api.helius.xyz") {
      if (parsed.searchParams.get("before")) return [];
      const asked = parsed.pathname.split("/")[3] ?? "";
      return JSON.parse(JSON.stringify(helius.body).replaceAll(helius.address, asked));
    }
    if (parsed.host === "coins.llama.fi") {
      // The recorded points per coin and asked timestamp, in batchHistorical's shape.
      const asked = JSON.parse(parsed.searchParams.get("coins") ?? "{}") as Record<string, number[]>;
      const coins: Record<string, { prices: { timestamp: number; price: number }[] }> = {};
      for (const [coin, stamps] of Object.entries(asked)) {
        const prices = stamps.flatMap((stamp) => (llama[coin]?.[String(stamp)] ? [llama[coin]![String(stamp)]!] : []));
        if (prices.length > 0) coins[coin] = { prices };
      }
      return { coins };
    }
    if (url.includes("/kamino-market/")) return url === kamino.url ? kamino.body : [];
    if (request.body && typeof request.body === "object" && "method" in request.body) {
      const body = request.body as { method: string; params: unknown[] };
      const call = rpcCalls.find((entry) => entry.request.method === body.method && entry.request.params[0] === body.params[0]);
      if (call) return call.response;
      if (body.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: 1, result: [] };
    }
    throw new PlatformError("FIXTURE_MISSING", `No fixture for ${parsed.host}${parsed.pathname}`, 502);
  };
}
