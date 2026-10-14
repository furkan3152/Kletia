/**
 * Live dry run of the Kletia-encoded EVM swaps (protocols design 3.2, 3.3,
 * live validation item 1). Read-only: each case plans with the pinned
 * deployments, prepares from a funded public holder (an EOA found from
 * recent Transfer logs or block senders) and the engine's asset-change
 * preview simulates exactly the prepared transactions (eth_simulateV1) and
 * holds them to the invariants I1-I7. Nothing is signed or sent.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/dexLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CHAINS, findAssetBySymbol, type IntentGraph, type NetworkKey } from "@kletia/core";
import { resetDexCaches } from "../../adapters/dex/concentrated.js";
import { configureAdapters } from "../../adapters/registry.js";
import { configurePolicyPricing } from "../../policy/pricing.js";
import { configurePlatform, createIntent, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";

const LIVE = process.env.KLETIA_LIVE === "1";

const RPC: Readonly<Record<string, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(network: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC[network] as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${network} ${method}: ${body.error.message}`);
  return body.result;
}

const isEoa = async (network: string, address: string) => (await rpc(network, "eth_getCode", [address, "latest"])) === "0x";

/** An EOA holding at least `minimum` of the ERC-20, from recent Transfer logs (read-only). */
async function tokenHolder(network: NetworkKey, symbol: string, minimum: bigint): Promise<string> {
  const token = findAssetBySymbol(network, symbol)?.address;
  assert.ok(token, `${symbol} on ${network}`);
  const latest = BigInt(String(await rpc(network, "eth_blockNumber", [])));
  for (const span of [5n, 50n, 500n]) {
    const logs = (await rpc(network, "eth_getLogs", [{ address: token, fromBlock: `0x${(latest - span).toString(16)}`, toBlock: "latest", topics: [TRANSFER_TOPIC] }])) as { topics: string[] }[];
    const seen = new Set<string>();
    for (const log of logs.slice(-200).reverse()) {
      const candidate = `0x${String(log.topics[2]).slice(26)}`;
      if (seen.has(candidate) || seen.size > 40) continue;
      seen.add(candidate);
      if (!(await isEoa(network, candidate))) continue;
      const balance = BigInt(String(await rpc(network, "eth_call", [{ to: token, data: `0x70a08231${candidate.slice(2).padStart(64, "0")}` }, "latest"])));
      if (balance >= minimum) return candidate;
    }
  }
  assert.fail(`no ${symbol} holder with ${minimum} base units found on ${network}`);
}

/** An EOA holding at least `minimum` wei of the native asset, from the latest block's senders. */
async function nativeHolder(network: NetworkKey, minimum: bigint): Promise<string> {
  const block = (await rpc(network, "eth_getBlockByNumber", ["latest", true])) as { transactions: { from: string }[] };
  const seen = new Set<string>();
  for (const transaction of block.transactions) {
    if (seen.has(transaction.from)) continue;
    seen.add(transaction.from);
    if (!(await isEoa(network, transaction.from))) continue;
    if (BigInt(String(await rpc(network, "eth_getBalance", [transaction.from, "latest"]))) >= minimum) return transaction.from;
  }
  assert.fail(`no native holder with ${minimum} wei in the latest ${network} block`);
}

interface Case {
  readonly name: string;
  readonly network: NetworkKey;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly protocol: "uniswap-v3" | "aerodrome" | "velodrome";
  /** Base units the holder must have. */
  readonly holding: bigint;
}

const CASES: readonly Case[] = [
  ...(["ethereum", "base", "arbitrum", "optimism"] as const).map((network): Case => ({
    name: `swap 100 USDC to ETH on ${network}`, network, from: "USDC", to: "ETH", amount: "100", protocol: "uniswap-v3", holding: 100_000_000n,
  })),
  // Polygon's gas asset is POL: "ETH" there is the bridged WETH token.
  { name: "swap 100 USDC to ETH (WETH) on polygon", network: "polygon", from: "USDC", to: "WETH", amount: "100", protocol: "uniswap-v3", holding: 100_000_000n },
  { name: "swap 0.05 ETH to USDC on base via aerodrome", network: "base", from: "ETH", to: "USDC", amount: "0.05", protocol: "aerodrome", holding: 60_000_000_000_000_000n },
  { name: "swap 0.05 ETH to USDC on optimism via velodrome", network: "optimism", from: "ETH", to: "USDC", amount: "0.05", protocol: "velodrome", holding: 60_000_000_000_000_000n },
  // Slipstream native output: the router is the swap recipient and unwrapWETH9 pays the account.
  { name: "swap 100 USDC to ETH on base via aerodrome", network: "base", from: "USDC", to: "ETH", amount: "100", protocol: "aerodrome", holding: 100_000_000n },
  { name: "swap 1 wstETH to ETH on ethereum", network: "ethereum", from: "wstETH", to: "ETH", amount: "1", protocol: "uniswap-v3", holding: 10n ** 18n },
];

describe("EVM DEX swaps (live, read-only)", { skip: !LIVE }, () => {
  before(() => {
    configurePlatform({ store: new MemoryIntentStore() });
    configureAdapters(null);
    configurePolicyPricing(null);
    resetDexCaches();
  });
  after(() => configurePolicyPricing(null));

  for (const entry of CASES) {
    it(`${entry.name}: plans, prepares and simulates (I1-I7)`, { timeout: 120_000 }, async () => {
      const holder = entry.from === "ETH" ? await nativeHolder(entry.network, entry.holding) : await tokenHolder(entry.network, entry.from, entry.holding);
      const chainId = CHAINS[entry.network].evmChainId as number;
      let graph: IntentGraph;
      try {
        graph = await createIntent({
          actions: [{ kind: "swap", network: entry.network, from: entry.from, to: entry.to, amount: entry.amount, protocol: entry.protocol }],
          accounts: [`eip155:${chainId}:${holder}`],
        });
      } catch (error) {
        assert.fail(`${entry.name} did not plan: ${(error as Error).message}`);
      }
      const step = graph.steps[0];
      assert.ok(step);
      assert.equal(step.protocol, entry.protocol);
      console.log(`${entry.name}: holder ${holder}, expected ${step.expectedOutput?.formatted} ${step.expectedOutput?.symbol}, minimum ${step.minimumOutput?.formatted}`);
      console.log(`  ${(step.warnings ?? []).join(" | ")}`);
      const { payload, intent } = await prepareStep(graph.id, "s1");
      const minimum = intent.steps[0]?.minimumOutput;
      assert.ok(minimum);
      const preview = payload.preview;
      console.log(`  prepared ${payload.transactions.length} transaction(s) to ${payload.transactions.map((transaction) => transaction.vm === "evm" ? transaction.to : "?").join(", ")}; preview ${preview?.status} at block ${preview?.block} (${preview?.endpoint})`);
      assert.ok(preview, "the prepared payload carries its simulated preview");
      assert.equal(preview.status, "simulated", JSON.stringify(preview.issues));
      assert.deepEqual(preview.issues.filter((issue) => issue.severity === "block"), []);
      const credit = preview.deltas.find((row) => row.asset === step.minimumOutput?.asset);
      assert.ok(credit, `the simulation credits ${step.minimumOutput?.symbol}`);
      console.log(`  simulated credit ${credit.expected.formatted} ${credit.symbol} (minimum ${minimum.formatted})`);
      assert.ok(BigInt(credit.expected.amount) >= BigInt(minimum.amount), "credited at least the on-chain minimum");
    });
  }
});
