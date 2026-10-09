/**
 * Network jobs of the asset-change preview (design §5.2): which steps share
 * one eth_simulateV1 request, what each block reads, where funds are assumed,
 * and that prepare-stage jobs never assume anything (S8). Pure: no RPC.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import type { IntentGraph, IntentStep } from "@kletia/core";
import type { PlannedStepPreview } from "../adapters/types.js";
import { planIntentWithPreviews } from "../planner.js";
import { buildEvmJobs, GAS_PRICE_ORACLE, MAX_JOB_BLOCKS, type StepTransactions } from "../preview/jobs.js";
import { ACCOUNT_BASE, FRIEND, installPreviewChain, resetPreviewEngine, STRANGER, USDC, type PreviewChain } from "./previewHarness.js";

let chain: PreviewChain;

beforeEach(() => {
  chain = installPreviewChain();
  resetPreviewEngine();
});

afterEach(() => chain.restore());

function sources(graph: IntentGraph, previews: ReadonlyMap<string, PlannedStepPreview>): Map<string, StepTransactions> {
  const out = new Map<string, StepTransactions>();
  for (const step of graph.steps) {
    const preview = previews.get(step.id);
    if (preview) out.set(step.id, { stepId: step.id, transactions: preview.transactions, origin: "planned" });
  }
  return out;
}

const GPO = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);

describe("network jobs", () => {
  it("puts consecutive steps of one account on one network into one request, one block per step", async () => {
    const { graph, previews } = await planIntentWithPreviews({
      actions: [
        { kind: "transfer", network: "base", from: "USDC", amount: "10", recipient: FRIEND },
        { kind: "transfer", network: "base", from: "USDC", amount: "5", recipient: STRANGER },
      ],
      accounts: [ACCOUNT_BASE],
    });
    const jobs = buildEvmJobs(graph, sources(graph, previews), "plan");
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0]?.blocks.map((block) => block.step.id), ["s1", "s2"]);
    const block = jobs[0]?.blocks[0];
    assert.ok(block);
    // balanceOf(owner) before, the transfer, balanceOf(owner) after, then GasPriceOracle.getL1Fee (Base is OP stack).
    assert.equal(block.calls.length, 4);
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: block.calls[0]?.data as Hex }).functionName, "balanceOf");
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: block.calls[1]?.data as Hex }).functionName, "transfer");
    assert.equal(block.calls[3]?.to, GAS_PRICE_ORACLE);
    assert.equal(decodeFunctionData({ abi: GPO, data: block.calls[3]?.data as Hex }).functionName, "getL1Fee");
    assert.deepEqual(block.index.before.map((entry) => entry.token), [USDC.base.toLowerCase()]);
    assert.equal(block.assumeFunds, null);
  });

  it("splits at a cross-network parent and assumes its funds only at plan", async () => {
    const { graph, previews } = await planIntentWithPreviews({
      actions: [
        { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", to: "USDC", amount: "100" },
        { kind: "swap", network: "arbitrum", from: "USDC", to: "WETH", amount: "max" },
      ],
      accounts: [ACCOUNT_BASE],
    });
    const plan = buildEvmJobs(graph, sources(graph, previews), "plan");
    assert.deepEqual(plan.map((job) => job.network), ["base", "arbitrum"]);
    const funded = plan[1]?.blocks[0];
    assert.deepEqual(funded?.assumeFunds, {
      asset: { asset: graph.steps[1]?.input?.asset, symbol: "USDC", decimals: 6 },
      amount: graph.steps[1]?.input?.amount,
    });
    // Arbitrum has no GasPriceOracle (its L1 component is read outside the block); approvals are read back.
    assert.equal(funded?.index.l1Fees.length, 0);
    assert.equal(funded?.index.allowances.length, 1);
    const prepare = buildEvmJobs(graph, sources(graph, previews), "prepare");
    assert.ok(prepare.every((job) => job.blocks.every((block) => block.assumeFunds === null)), "S8: no assumed funds at prepare");
  });

  it("never assumes the funds of a parent that already settled", async () => {
    const { graph, previews } = await planIntentWithPreviews({
      actions: [
        { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", to: "USDC", amount: "100" },
        { kind: "swap", network: "arbitrum", from: "USDC", to: "WETH", amount: "max" },
      ],
      accounts: [ACCOUNT_BASE],
    });
    const settled: IntentGraph = { ...graph, steps: graph.steps.map((step): IntentStep => (step.id === "s1" ? { ...step, status: "settled" } : step)) };
    const jobs = buildEvmJobs(settled, sources(settled, previews), "refresh");
    assert.equal(jobs.find((job) => job.network === "arbitrum")?.blocks[0]?.assumeFunds, null);
  });

  it(`caps a job at ${MAX_JOB_BLOCKS} blocks`, async () => {
    const { graph, previews } = await planIntentWithPreviews({
      actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "1", recipient: FRIEND }],
      accounts: [ACCOUNT_BASE],
    });
    const template = graph.steps[0] as IntentStep;
    const steps = Array.from({ length: MAX_JOB_BLOCKS + 1 }, (_, index): IntentStep => ({ ...template, id: `s${index + 1}`, index }));
    const many: IntentGraph = { ...graph, steps };
    const map = new Map(steps.map((step) => [step.id, { stepId: step.id, transactions: previews.get("s1")?.transactions ?? [], origin: "planned" as const }]));
    const jobs = buildEvmJobs(many, map, "plan");
    assert.deepEqual(jobs.map((job) => job.blocks.length), [MAX_JOB_BLOCKS, 1]);
  });
});
