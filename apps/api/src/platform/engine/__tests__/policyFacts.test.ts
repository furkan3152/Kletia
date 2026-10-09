/**
 * Rule Book facts from planned graphs (policy design §4.1, §5.2): root and
 * funded steps from edges, extra costs, recipients, BYOC call facts, merged
 * bridge + swap steps, slippage from the step ref, conservative prices only.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CHAINS, type AssetAmount, type IntentGraph } from "@kletia/core";
import { configurePolicyPricing } from "../policy/pricing.js";
import { policyFactsDetailed, policyFactsFromGraph, policyNeedsPricing, stepExposureUsdMicros } from "../policy/facts.js";
import { createIntent } from "../service.js";
import { ACCOUNTS, EVM_ADDRESS, OTHER_EVM_ADDRESS, resetEngine } from "./helpers.js";
import { installMarket, ruleBook, standardPrices, type FakeMarket } from "./policyHarness.js";

const ETH_BASE: AssetAmount = { asset: "eip155:8453/slip44:60", symbol: "ETH", decimals: 18, amount: "1000000000000000", formatted: "0.001" } as AssetAmount;

describe("policy facts", () => {
  let market: FakeMarket;

  beforeEach(() => {
    resetEngine();
    market = installMarket();
    standardPrices(market, { eth: 3_000, sol: 150 });
  });

  afterEach(() => configurePolicyPricing(null));

  it("marks funded steps from edges and counts only root inputs in the fresh value", async () => {
    const graph = await createIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS }, { dryRun: true });
    assert.equal(graph.steps.length, 2);
    const facts = await policyFactsFromGraph(graph, { stage: "plan", stored: false, price: true });
    const [bridge, swap] = facts.steps;
    assert.ok(bridge && swap);
    assert.equal(bridge.root, true);
    assert.equal(swap.root, false);
    assert.equal(bridge.destinationNetwork, "solana");
    assert.equal(bridge.input?.usdMicros, 50_000_000n);
    assert.equal(facts.intent.notionalUsdMicros, 50_000_000n, "the swap spends what the bridge produced");
    assert.equal(facts.intent.crossNetwork, true);
    assert.deepEqual([...facts.intent.networks].sort(), ["base", "solana"]);
    assert.equal(stepExposureUsdMicros(facts, bridge.id), 50_000_000n);
    assert.equal(stepExposureUsdMicros(facts, swap.id), 0n, "a funded step adds only its extra costs");
  });

  it("describes a merged bridge + swap as one cross-network step into the final asset", async () => {
    const graph = await createIntent({
      actions: [
        { kind: "bridge", network: "base", from: "USDC", to: "USDC", toNetwork: "solana", amount: "20" },
        { kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max" },
      ],
      accounts: ACCOUNTS,
    }, { dryRun: true });
    assert.equal(graph.steps.length, 1, "merged");
    const facts = await policyFactsFromGraph(graph, { stage: "plan", stored: false, price: true });
    const step = facts.steps[0];
    assert.ok(step);
    assert.equal(step.kind, "bridge");
    assert.equal(step.network, "base");
    assert.equal(step.destinationNetwork, "solana");
    assert.equal(step.output?.symbol, "SOL");
    assert.equal(step.output?.category, "native");
    assert.equal(step.root, true);
  });

  it("prices extra costs and adds them to the fresh value and the exposure", async () => {
    const planned = await createIntent({ text: "bridge 10 USDC from base to arbitrum", accounts: ACCOUNTS }, { dryRun: true });
    const graph: IntentGraph = { ...planned, steps: planned.steps.map((step) => ({ ...step, extraCosts: [ETH_BASE] })) };
    const facts = await policyFactsFromGraph(graph, { stage: "prepare", stored: true, price: true });
    const step = facts.steps[0];
    assert.ok(step);
    assert.equal(step.extraCosts[0]?.usdMicros, 3_000_000n, "0.001 ETH at $3,000");
    assert.equal(facts.intent.notionalUsdMicros, 13_000_000n);
    assert.equal(stepExposureUsdMicros(facts, step.id), 13_000_000n);
  });

  it("flags external recipients and keeps the own account on other EVM chains own", async () => {
    const external = await createIntent({ text: `send 10 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS }, { dryRun: true });
    const facts = await policyFactsFromGraph(external, { stage: "plan", stored: false });
    assert.equal(facts.steps[0]?.external, true);
    assert.equal(facts.steps[0]?.recipient, `${CHAINS.base.id}:${OTHER_EVM_ADDRESS}`);
    const bridge = await createIntent({ text: "bridge 10 USDC from base to arbitrum", accounts: ACCOUNTS }, { dryRun: true });
    const own = await policyFactsFromGraph(bridge, { stage: "plan", stored: false });
    assert.equal(own.steps[0]?.external, false, `the bridge pays ${EVM_ADDRESS} on Arbitrum`);
  });

  it("carries BYOC call facts and the slippage the step was planned with", async () => {
    const planned = await createIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, constraints: { maxSlippageBps: 75 } }, { dryRun: true });
    const facts = await policyFactsFromGraph(planned, { stage: "plan", stored: false });
    assert.equal(facts.steps[0]?.slippageBps, 75, "from the step ref, not inferred");
    const call: IntentGraph = {
      ...planned,
      steps: planned.steps.map((step) => ({
        ...step,
        kind: "call" as const,
        call: { contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", target: "0xBEEF000000000000000000000000000000008183", revision: 3, definitionHash: `sha256:${"ab".repeat(32)}` } as never,
      })),
    };
    const callFacts = await policyFactsFromGraph(call, { stage: "plan", stored: false });
    assert.deepEqual(callFacts.steps[0]?.contract, { id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", target: "0xBEEF000000000000000000000000000000008183" });
  });

  it("never trusts adapters' advisory USD: without pricing every amount is unpriced", async () => {
    const graph = await createIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS }, { dryRun: true });
    assert.ok(graph.steps[0]?.expectedOutput?.usd !== undefined, "the adapter reported a USD value");
    const facts = await policyFactsFromGraph(graph, { stage: "plan", stored: false });
    assert.equal(facts.steps[0]?.input?.usdMicros, null);
    assert.equal(facts.steps[0]?.output?.usdMicros, null);
    assert.equal(facts.intent.notionalUsdMicros, null);
    assert.equal(market.calls.ethCall + market.calls.jupiter, 0, "nothing was read");
  });

  it("leaves amounts unpriced when the oracle has no fresh source, with oracle warnings surfaced", async () => {
    market.jupiter.clear();
    const graph = await createIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS }, { dryRun: true });
    const detailed = await policyFactsDetailed(graph, { stage: "plan", stored: false, price: true });
    assert.equal(detailed.facts.steps[0]?.input?.usdMicros, null, "SOL has no fresh source");
    assert.equal(detailed.facts.steps[0]?.output?.usdMicros, 1_000_000n * 150n, "USDC is priced by Chainlink");
    assert.equal(stepExposureUsdMicros(detailed.facts, "s1"), null);
    assert.equal(detailed.prices.get(graph.steps[0]?.input?.asset as string), null);
  });

  it("knows which rule books need prices", () => {
    assert.equal(policyNeedsPricing([null, ruleBook({ networks: { allow: ["base"] } })]), false);
    assert.equal(policyNeedsPricing([ruleBook({ caps: { dailyUsd: "100" } })]), true);
    assert.equal(policyNeedsPricing([ruleBook({ limits: { maxExtraCostUsd: "5" } })]), true);
    assert.equal(policyNeedsPricing([ruleBook({ confirm: { aboveUsd: "50" } })]), true);
  });
});
