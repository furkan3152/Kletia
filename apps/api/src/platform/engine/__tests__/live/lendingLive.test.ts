/**
 * Live dry run of the EVM yield venues (SparkLend, Spark Savings, Fluid, Yearn
 * V3). Read-only: one deposit and one withdrawal per venue family plan against
 * the pinned contracts, prepare from funded public holders (known SparkLend and
 * Yearn holders, otherwise EOAs found from recent Transfer logs) and the
 * engine's asset-change preview simulates exactly the prepared transactions
 * (eth_simulateV1, approvals included) and holds them to I1-I7. Withdrawals
 * check the exit selectors: SparkLend Pool.withdraw 0x69328dec, Yearn and Fluid
 * withdraw(uint256,address,address,uint256) 0xa318c1a4 and
 * redeem(uint256,address,address,uint256) 0x9f40a7b3. Nothing is signed or
 * sent.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/lendingLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CHAINS, findAssetBySymbol, getYieldVenue, type IntentActionSpec, type IntentGraph, type NetworkKey } from "@kletia/core";
import { configureAdapters } from "../../adapters/registry.js";
import { resetLendingMetricsCache } from "../../adapters/lending/metrics.js";
import { configurePolicyPricing } from "../../policy/pricing.js";
import { configurePlatform, createIntent, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";

const LIVE = process.env.KLETIA_LIVE === "1";

const RPC: Readonly<Record<string, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** A SparkLend spUSDC holder and a Yearn yvUSDC-1 holder. */
const SPARKLEND_HOLDER = "0xE18CE5fA31fC464d5F1cC4b3EEd497CDeA0B82d2";
const YEARN_HOLDER = "0x952b31960c97e76362ac340d07d183ada15e3d6e";

async function rpc(network: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC[network] as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${network} ${method}: ${body.error.message}`);
  return body.result;
}

const isEoa = async (network: string, address: string) => (await rpc(network, "eth_getCode", [address, "latest"])) === "0x";
const balanceOf = async (network: string, token: string, owner: string) =>
  BigInt(String(await rpc(network, "eth_call", [{ to: token, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"])));

/**
 * An EOA holding at least `minimum` of `token` (an ERC-20 or vault shares),
 * from Transfer logs scanned backwards in windows public RPCs serve without
 * archive access.
 */
async function holderOf(network: NetworkKey, token: string, minimum: bigint): Promise<string> {
  const latest = BigInt(String(await rpc(network, "eth_blockNumber", [])));
  const window = network === "ethereum" ? 800n : 4_000n;
  const seen = new Set<string>();
  for (let index = 0n; index < 40n && seen.size < 120; index += 1n) {
    const to = latest - index * window;
    const logs = (await rpc(network, "eth_getLogs", [{ address: token, fromBlock: `0x${(to - window + 1n).toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_TOPIC] }])) as { topics: string[] }[];
    for (const log of logs.slice(-200).reverse()) {
      const candidate = `0x${String(log.topics[2]).slice(26)}`;
      if (seen.has(candidate) || /^0x0{40}$/u.test(candidate)) continue;
      seen.add(candidate);
      if (!(await isEoa(network, candidate))) continue;
      if ((await balanceOf(network, token, candidate)) >= minimum) return candidate;
    }
  }
  assert.fail(`no holder of ${token} with ${minimum} base units found on ${network}`);
}

interface Case {
  readonly name: string;
  readonly venue: string;
  readonly kind: "deposit" | "withdraw";
  readonly amount: string;
  /** Who acts: a fixed holder, or found from the underlying's / the shares' Transfer logs. */
  readonly holder?: string;
  /** Expected first 4 bytes of the venue call. */
  readonly selector?: string;
}

const CASES: readonly Case[] = [
  { name: "SparkLend: supply 100 USDC", venue: "ethereum:sparklend:usdc", kind: "deposit", amount: "100" },
  { name: "SparkLend: withdraw 100 USDC (known holder)", venue: "ethereum:sparklend:usdc", kind: "withdraw", amount: "100", holder: SPARKLEND_HOLDER, selector: "0x69328dec" },
  { name: "SparkLend: withdraw all USDC (known holder)", venue: "ethereum:sparklend:usdc", kind: "withdraw", amount: "max", holder: SPARKLEND_HOLDER, selector: "0x69328dec" },
  { name: "Yearn V3: deposit 100 USDC into USDC-1", venue: "ethereum:yearn-v3:usdc-1", kind: "deposit", amount: "100" },
  { name: "Yearn V3: withdraw 10 USDC (known holder)", venue: "ethereum:yearn-v3:usdc-1", kind: "withdraw", amount: "10", holder: YEARN_HOLDER, selector: "0xa318c1a4" },
  { name: "Yearn V3: withdraw all USDC (known holder)", venue: "ethereum:yearn-v3:usdc-1", kind: "withdraw", amount: "max", holder: YEARN_HOLDER, selector: "0x9f40a7b3" },
  { name: "Spark Savings: deposit 100 USDC into sUSDC (Ethereum default)", venue: "ethereum:spark-savings:usdc", kind: "deposit", amount: "100" },
  { name: "Spark Savings: withdraw 10 USDC from sUSDC", venue: "ethereum:spark-savings:usdc", kind: "withdraw", amount: "10" },
  { name: "Spark Savings: deposit 100 USDC into spUSDC", venue: "ethereum:spark-savings:spusdc", kind: "deposit", amount: "100" },
  { name: "Spark Savings: withdraw 10 USDC from spUSDC", venue: "ethereum:spark-savings:spusdc", kind: "withdraw", amount: "10" },
  { name: "Spark Savings: deposit 100 USDC into sUSDC on Base", venue: "base:spark-savings:usdc", kind: "deposit", amount: "100" },
  { name: "Fluid: deposit 100 USDC on Base", venue: "base:fluid:usdc", kind: "deposit", amount: "100", selector: "0xbc157ac1" },
  { name: "Fluid: withdraw 10 USDC on Base", venue: "base:fluid:usdc", kind: "withdraw", amount: "10", selector: "0xa318c1a4" },
];

describe("EVM yield venues (live, read-only)", { skip: !LIVE }, () => {
  before(() => {
    configurePlatform({ store: new MemoryIntentStore() });
    configureAdapters(null);
    configurePolicyPricing(null);
    resetLendingMetricsCache();
  });
  after(() => configurePolicyPricing(null));

  for (const entry of CASES) {
    it(`${entry.name}: plans, prepares and simulates (I1-I7)`, { timeout: 180_000 }, async () => {
      const venue = getYieldVenue(entry.venue);
      assert.ok(venue && "receipt" in venue);
      const network = venue.network;
      const underlying = findAssetBySymbol(network, venue.asset);
      assert.ok(underlying?.address);
      const units = (value: string) => BigInt(value) * 10n ** BigInt(underlying.decimals);
      const holder = entry.holder ?? (entry.kind === "deposit"
        ? await holderOf(network, underlying.address, units(entry.amount) * 2n)
        // Shares are worth at least ~1 underlying here (share prices start at 1): twice the amount in share units covers it.
        : await holderOf(network, venue.receipt.address, BigInt(entry.amount === "max" ? "1" : entry.amount) * 2n * 10n ** BigInt(venue.receipt.decimals)));
      const action: IntentActionSpec = {
        kind: entry.kind, network, from: venue.asset, amount: entry.amount, protocol: venue.protocol, params: { venue: venue.slug },
      };
      let graph: IntentGraph;
      try {
        graph = await createIntent({ actions: [action], accounts: [`eip155:${CHAINS[network].evmChainId}:${holder}`] });
      } catch (error) {
        assert.fail(`${entry.name} did not plan for ${holder}: ${(error as Error).message}`);
      }
      const step = graph.steps[0];
      assert.ok(step);
      assert.equal(step.protocol, venue.protocol);
      assert.equal(step.venue, venue.id);
      console.log(`${entry.name}: holder ${holder}; "${step.title}"; minimum ${step.minimumOutput?.formatted} ${step.minimumOutput?.symbol}`);
      const { payload, intent } = await prepareStep(graph.id, "s1");
      const call = payload.transactions.find((transaction) => transaction.vm === "evm" && transaction.to.toLowerCase() === venue.target.toLowerCase());
      assert.ok(call && call.vm === "evm", "the prepared payload calls the pinned venue");
      if (entry.selector) assert.equal(call.data.slice(0, 10), entry.selector);
      const preview = payload.preview;
      assert.ok(preview, "the prepared payload carries its simulated preview");
      console.log(`  prepared ${payload.transactions.length} transaction(s); venue call ${call.data.slice(0, 10)}; preview ${preview.status} at block ${preview.block}`);
      assert.equal(preview.status, "simulated", JSON.stringify(preview.issues));
      assert.deepEqual(preview.issues.filter((issue) => issue.severity === "block"), []);
      const minimum = intent.steps[0]?.minimumOutput;
      assert.ok(minimum);
      const credit = preview.deltas.find((row) => row.asset.toLowerCase() === minimum.asset.toLowerCase());
      assert.ok(credit, `the simulation credits ${minimum.symbol}`);
      console.log(`  simulated credit ${credit.expected.formatted} ${credit.symbol} (minimum ${minimum.formatted})`);
      assert.ok(BigInt(credit.expected.amount) >= BigInt(minimum.amount), "credited at least the guaranteed minimum");
    });
  }
});
