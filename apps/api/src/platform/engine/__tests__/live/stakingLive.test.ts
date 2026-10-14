/**
 * Live dry run of EVM liquid staking. Read-only: each case plans "stake 1
 * ETH with <protocol>" against the pinned contracts, prepares from a
 * funded public holder (an EOA from the latest block's senders) and the
 * engine's asset-change preview simulates exactly the prepared transaction
 * (eth_simulateV1) and holds it to the invariants I1-I7. Nothing is signed
 * or sent.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/stakingLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CHAINS, type IntentGraph } from "@kletia/core";
import { configureAdapters } from "../../adapters/registry.js";
import { configurePolicyPricing } from "../../policy/pricing.js";
import { configurePlatform, createIntent, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";

const LIVE = process.env.KLETIA_LIVE === "1";
const RPC = "https://ethereum-rpc.publicnode.com";
const ONE = 10n ** 18n;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** An EOA holding at least `minimum` wei, from the latest block's senders. */
async function ethHolder(minimum: bigint): Promise<string> {
  const block = (await rpc("eth_getBlockByNumber", ["latest", true])) as { transactions: { from: string }[] };
  const seen = new Set<string>();
  for (const transaction of block.transactions) {
    if (seen.has(transaction.from)) continue;
    seen.add(transaction.from);
    if ((await rpc("eth_getCode", [transaction.from, "latest"])) !== "0x") continue;
    if (BigInt(String(await rpc("eth_getBalance", [transaction.from, "latest"]))) >= minimum) return transaction.from;
  }
  assert.fail(`no holder with ${minimum} wei in the latest Ethereum block`);
}

const CASES = [
  { text: "stake 1 ETH with lido", protocol: "lido", symbol: "wstETH", to: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", selector: "0x" },
  { text: "stake 1 ETH with rocket pool", protocol: "rocket-pool", symbol: "rETH", to: "0xce15294273cfb9d9b628f4d61636623decdf4fdc", selector: "0xd0e30db0" },
  { text: "stake 1 ETH with ether.fi", protocol: "etherfi", symbol: "weETH", to: "0xcfc6d9bd7411962bfe7145451a7ef71a24b6a7a2", selector: "0x" },
] as const;

describe("EVM liquid staking (live, read-only)", { skip: !LIVE }, () => {
  before(() => {
    configurePlatform({ store: new MemoryIntentStore() });
    configureAdapters(null);
    configurePolicyPricing(null);
  });
  after(() => configurePolicyPricing(null));

  for (const entry of CASES) {
    it(`${entry.text}: plans, prepares and simulates (I1-I7)`, { timeout: 120_000 }, async () => {
      const holder = await ethHolder(2n * ONE);
      let graph: IntentGraph;
      try {
        graph = await createIntent({ text: entry.text, accounts: [`eip155:${CHAINS.ethereum.evmChainId}:${holder}`] });
      } catch (error) {
        assert.fail(`${entry.text} did not plan: ${(error as Error).message}`);
      }
      const step = graph.steps[0];
      assert.ok(step);
      assert.equal(step.protocol, entry.protocol);
      assert.equal(step.minimumOutput?.symbol, entry.symbol);
      assert.ok((step.warnings ?? []).some((warning) => warning.startsWith(`Kletia does not unstake ${entry.symbol}`)), "the no-unstake warning");
      console.log(`${entry.text}: holder ${holder}, expected ${step.expectedOutput?.formatted} ${entry.symbol}, minimum ${step.minimumOutput?.formatted}`);
      const { payload, intent } = await prepareStep(graph.id, "s1");
      const transaction = payload.transactions[0];
      assert.ok(transaction?.vm === "evm");
      assert.equal(payload.transactions.length, 1);
      assert.equal(transaction.to.toLowerCase(), entry.to);
      assert.equal(transaction.value, ONE.toString());
      assert.ok(entry.selector === "0x" ? transaction.data === "0x" || entry.protocol === "etherfi" : transaction.data.startsWith(entry.selector));
      const preview = payload.preview;
      assert.ok(preview, "the prepared payload carries its simulated preview");
      console.log(`  prepared to ${transaction.to} (${transaction.data.slice(0, 10)}); preview ${preview.status} at block ${preview.block}`);
      assert.equal(preview.status, "simulated", JSON.stringify(preview.issues));
      assert.deepEqual(preview.issues.filter((issue) => issue.severity === "block"), []);
      const credit = preview.deltas.find((row) => row.asset === step.minimumOutput?.asset);
      assert.ok(credit, `the simulation credits ${entry.symbol}`);
      const minimum = intent.steps[0]?.minimumOutput;
      assert.ok(minimum);
      console.log(`  simulated credit ${credit.expected.formatted} ${credit.symbol} (minimum ${minimum.formatted})`);
      assert.ok(BigInt(credit.expected.amount) >= BigInt(minimum.amount), "credited at least the guaranteed minimum");
    });
  }
});
