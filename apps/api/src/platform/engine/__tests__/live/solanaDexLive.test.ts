/**
 * Live dry run of the named Solana venues (protocols design 3.11, Codex
 * review 6.4 item 2). Read-only: the evidence pools of every label still
 * decode with the pinned layouts (owner, discriminator or size, mints,
 * vaults); "swap ... via raydium | orca | meteora" plans and prepares one
 * unsigned v0 transaction from a funded public wallet, with the pool CPI
 * proven by simulation and the asset-change preview simulated; an unnamed
 * swap still plans through Jupiter. Nothing is signed or sent.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/solanaDexLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CHAINS, type IntentGraph } from "@kletia/core";
import { configureAdapters } from "../../adapters/registry.js";
import { decodeDexPool, dexLabels } from "../../adapters/solanaDexClient.js";
import { readSolanaAccounts, SOLANA_PROGRAM_IDS } from "../../chains/solana.js";
import { configurePolicyPricing } from "../../policy/pricing.js";
import { configurePlatform, createIntent, prepareStep } from "../../service.js";
import { MemoryIntentStore } from "../../store.js";

const LIVE = process.env.KLETIA_LIVE === "1";
/** Public wallet holding SOL and USDC (the Codex review's probe owner). */
const OWNER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const ACCOUNT = `${CHAINS.solana.id}:${OWNER}`;
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** SOL / USDC pools Jupiter routed each label through on 2026-10-14 (protocols evidence and this package's probe). */
const EVIDENCE_POOLS: readonly (readonly ["raydium" | "orca" | "meteora", string, string])[] = [
  ["raydium", "Raydium", "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"],
  ["raydium", "Raydium CLMM", "CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq"],
  ["orca", "Whirlpool", "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"],
  ["meteora", "Meteora DLMM", "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"],
  ["meteora", "Meteora DAMM v2", "8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie"],
];

describe("named Solana DEX venues (live, read-only)", { skip: !LIVE }, () => {
  before(() => {
    configurePlatform({ store: new MemoryIntentStore() });
    configureAdapters(null);
    configurePolicyPricing(null);
  });
  after(() => configurePolicyPricing(null));

  it("decodes every evidence pool with its label's layout: program owner, mints SOL and USDC, distinct vaults", async () => {
    const states = await readSolanaAccounts("solana", EVIDENCE_POOLS.map(([, , pool]) => pool));
    for (const [index, [dex, label, pool]] of EVIDENCE_POOLS.entries()) {
      assert.ok(dexLabels(dex).includes(label), `${label} is enabled`);
      const decoded = decodeDexPool(dex, label, pool, states[index] ?? null);
      assert.deepEqual([decoded.mintA, decoded.mintB].sort(), [USDC, WSOL].sort(), `${label} mints`);
      assert.notEqual(decoded.vaultA, decoded.vaultB);
      const vaults = await readSolanaAccounts("solana", [decoded.vaultA, decoded.vaultB]);
      for (const vault of vaults) assert.equal(vault?.owner, SOLANA_PROGRAM_IDS.token, `${label} vaults are SPL token accounts`);
      console.log(`${label.padEnd(16)} ${pool} owner=${decoded.program} vaults=${decoded.vaultA},${decoded.vaultB}`);
    }
  });

  const CASES: readonly (readonly [string, string])[] = [
    ["swap 0.01 SOL to USDC via raydium", "raydium"],
    ["swap 0.01 SOL to USDC via orca", "orca"],
    ["swap 0.01 SOL to USDC via meteora", "meteora"],
    ["swap 1 USDC to SOL via raydium", "raydium"],
  ];
  /** The public mainnet RPC rate-limits bursts; space the cases out. */
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));
  for (const [text, protocol] of CASES) {
    it(`${text}: plans, prepares one transaction and simulates the pool CPI`, { timeout: 120_000 }, async () => {
      await pause();
      let graph: IntentGraph;
      try {
        graph = await createIntent({ text, accounts: [ACCOUNT], constraints: { maxSlippageBps: 50 } });
      } catch (error) {
        assert.fail(`${text} did not plan: ${(error as Error).message}`);
      }
      const step = graph.steps[0];
      assert.ok(step);
      assert.equal(graph.steps.length, 1);
      assert.equal(step.protocol, protocol);
      const { payload } = await prepareStep(graph.id, "s1");
      assert.equal(payload.transactions.length, 1);
      assert.ok(payload.transactions[0]?.vm === "svm");
      const preview = (payload as { preview?: { status?: string; simulation?: { status?: string } } }).preview;
      const status = preview?.simulation?.status ?? preview?.status;
      console.log(`${text}: ${step.title}; expected ${step.expectedOutput?.formatted}, minimum ${step.minimumOutput?.formatted}; ${step.warnings?.[0] ?? ""}; preview ${status}`);
      assert.equal(status, "simulated");
    });
  }

  it("an unnamed swap still plans through Jupiter", async () => {
    const graph = await createIntent({ text: "swap 0.01 SOL to USDC", accounts: [ACCOUNT] });
    assert.deepEqual(graph.steps.map((step) => step.protocol), ["jupiter"]);
  });
});
