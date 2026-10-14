/**
 * Live dry run of the Across and Circle CCTP V2 bridges (protocols design
 * 3.4 / 3.5, live validation item 1, crosschainLive additions). Read-only:
 * each case plans from the prompt against the real Across and Iris APIs and
 * the pinned contracts, prepares from a funded public USDC holder on Base (an
 * EOA found from recent Transfer logs) and the engine's asset-change preview
 * simulates exactly the prepared approval and deposit / burn (eth_simulateV1)
 * and holds them to the invariants I1-I7. Nothing is signed or sent.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/bridgesLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { CHAINS, findAssetBySymbol, type IntentGraph } from "@kletia/core";
import { configureAdapters } from "../../adapters/registry.js";
import { configurePolicyPricing } from "../../policy/pricing.js";
import { configurePlatform, createIntent, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";

const LIVE = process.env.KLETIA_LIVE === "1";
const BASE_RPC = "https://base-rpc.publicnode.com";
const SOLANA_RPC = process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const HUNDRED = 100_000_000n;

async function jsonRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** An EOA on Base holding at least `minimum` USDC base units, from recent Transfer logs (read-only). */
async function baseUsdcHolder(minimum: bigint): Promise<string> {
  const token = findAssetBySymbol("base", "USDC")?.address;
  assert.ok(token);
  const latest = BigInt(String(await jsonRpc(BASE_RPC, "eth_blockNumber", [])));
  for (const span of [5n, 50n, 500n]) {
    const logs = (await jsonRpc(BASE_RPC, "eth_getLogs", [{ address: token, fromBlock: `0x${(latest - span).toString(16)}`, toBlock: "latest", topics: [TRANSFER_TOPIC] }])) as { topics: string[] }[];
    const seen = new Set<string>();
    for (const log of logs.slice(-200).reverse()) {
      const candidate = `0x${String(log.topics[2]).slice(26)}`;
      if (seen.has(candidate) || seen.size > 40) continue;
      seen.add(candidate);
      if ((await jsonRpc(BASE_RPC, "eth_getCode", [candidate, "latest"])) !== "0x") continue;
      const balance = BigInt(String(await jsonRpc(BASE_RPC, "eth_call", [{ to: token, data: `0x70a08231${candidate.slice(2).padStart(64, "0")}` }, "latest"])));
      if (balance >= minimum) return candidate;
    }
  }
  assert.fail("no USDC holder with 100 USDC found on Base");
}

/** A Solana wallet (System-owned) whose USDC associated token account exists, from a recent USDC transfer. */
async function solanaUsdcWallet(): Promise<string> {
  const signatures = (await jsonRpc(SOLANA_RPC, "getSignaturesForAddress", [USDC_SOL, { limit: 20 }])) as { signature: string; err: unknown }[];
  for (const entry of signatures.filter((item) => item.err === null)) {
    const tx = (await jsonRpc(SOLANA_RPC, "getTransaction", [entry.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null)) as
      | { meta?: { postTokenBalances?: { mint: string; owner?: string }[] } }
      | null;
    for (const balance of tx?.meta?.postTokenBalances ?? []) {
      if (balance.mint !== USDC_SOL || !balance.owner) continue;
      const owner = (await jsonRpc(SOLANA_RPC, "getAccountInfo", [balance.owner, { encoding: "base64" }])) as { value: { owner: string; data: [string, string] } | null };
      if (!owner.value || owner.value.owner !== SYSTEM_PROGRAM || owner.value.data[0] !== "") continue;
      const [ata] = await findAssociatedTokenPda({ owner: address(balance.owner), mint: address(USDC_SOL), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const account = (await jsonRpc(SOLANA_RPC, "getAccountInfo", [String(ata), { encoding: "base64" }])) as { value: unknown };
      if (account.value) return balance.owner;
    }
  }
  assert.fail("no Solana wallet with a USDC account found in recent USDC transfers");
}

describe("Across and CCTP V2 bridges (live, read-only)", { skip: !LIVE }, () => {
  let holder = "";

  before(async () => {
    configurePlatform({ store: new MemoryIntentStore() });
    configureAdapters(null);
    configurePolicyPricing(null);
    holder = await baseUsdcHolder(HUNDRED);
  });
  after(() => configurePolicyPricing(null));

  async function planAndPrepare(text: string, accounts: string[], protocol: "across" | "cctp-v2"): Promise<void> {
    let graph: IntentGraph;
    try {
      graph = await createIntent({ text, accounts });
    } catch (error) {
      assert.fail(`${text} did not plan: ${(error as Error).message}`);
    }
    const step = graph.steps[0];
    assert.ok(step);
    const quotes = step.evidence.filter((entry) => entry.kind === "quote").map((entry) => entry.detail).join(" | ");
    console.log(`${text}: holder ${holder}, winner ${step.protocol}, expected ${step.expectedOutput?.formatted}, minimum ${step.minimumOutput?.formatted} ${step.minimumOutput?.symbol}`);
    console.log(`  quotes: ${quotes}`);
    console.log(`  ${(step.warnings ?? []).join(" | ")}`);
    assert.equal(step.protocol, protocol, `${protocol} should win: ${quotes}`);
    const { payload, intent } = await prepareStep(graph.id, "s1");
    const last = payload.transactions[payload.transactions.length - 1];
    assert.ok(last?.vm === "evm");
    console.log(`  prepared ${payload.transactions.length} transaction(s) to ${payload.transactions.map((transaction) => transaction.vm === "evm" ? transaction.to : "?").join(", ")} (${last.data.slice(0, 10)}); preview ${payload.preview?.status} at block ${payload.preview?.block}`);
    const preview = payload.preview;
    assert.ok(preview, "the prepared payload carries its simulated preview");
    assert.equal(preview.status, "simulated", JSON.stringify(preview.issues));
    assert.deepEqual(preview.issues.filter((issue) => issue.severity === "block"), []);
    const debit = preview.deltas.find((row) => row.asset === step.input?.asset);
    assert.ok(debit, "the simulation debits USDC");
    console.log(`  simulated USDC change ${debit.expected.formatted}; prepared minimum ${intent.steps[0]?.minimumOutput?.formatted}`);
  }

  it("bridge 100 USDC from base to arbitrum: Across wins, prepares and simulates", { timeout: 180_000 }, async () => {
    await planAndPrepare("bridge 100 USDC from base to arbitrum", [`eip155:${CHAINS.base.evmChainId}:${holder}`], "across");
  });

  it("bridge 100 USDC from base to solana via cctp: plans, prepares and simulates", { timeout: 180_000 }, async () => {
    const wallet = await solanaUsdcWallet();
    console.log(`  Solana recipient ${wallet}`);
    await planAndPrepare(
      "bridge 100 USDC from base to solana via cctp",
      [`eip155:${CHAINS.base.evmChainId}:${holder}`, `solana:${CHAINS.solana.reference}:${wallet}`],
      "cctp-v2",
    );
  });
});
