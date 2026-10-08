import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { applySlippage, validateIntentGraph, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { actionForStep, planIntent } from "../planner.js";
import { decodeStepRef } from "../stepRef.js";
import { portionOf } from "../util.js";
import {
  ACCOUNTS,
  EVM_ACCOUNT,
  OTHER_EVM_ADDRESS,
  OTHER_SOL_ADDRESS,
  resetEngine,
  SOL_ACCOUNT,
  stub,
} from "./helpers.js";

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

function shape(graph: IntentGraph): string[] {
  return graph.steps.map((step) => `${step.id}:${step.kind}/${step.protocol}@${step.network}[${step.status}] deps=${step.dependsOn.join(",") || "-"}`);
}

describe("planner", () => {
  beforeEach(() => {
    resetEngine();
  });

  it("plans a single Solana swap into a ready one-step graph", async () => {
    const graph = await planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), ["s1:swap/jupiter@solana[ready] deps=-"]);
    assert.equal(graph.status, "planned");
    assert.equal(graph.interpretation.source, "grammar");
    assert.equal(graph.steps[0]?.account, SOL_ACCOUNT);
    assert.equal(graph.steps[0]?.input?.amount, "1000000000");
    assert.equal(graph.steps[0]?.expectedOutput?.amount, "150000000");
    assert.equal(graph.steps[0]?.minimumOutput?.amount, applySlippage("150000000", 50));
    assert.deepEqual(validateIntentGraph(graph), []);
    assert.equal(graph.summary.signaturesRequired, 1);
    assert.equal(graph.summary.crossNetwork, false);
  });

  it("chains a funded dependent step from the previous guaranteed minimum (half)", async () => {
    const graph = await planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), [
      "s1:bridge/relay@base[ready] deps=-",
      "s2:swap/jupiter@solana[pending] deps=s1",
    ]);
    assert.deepEqual(graph.edges, [{ from: "s1", to: "s2", kind: "funds" }]);
    const [bridge, swap] = graph.steps;
    assert.equal(bridge?.settlement?.kind, "cross-network");
    assert.equal(bridge?.settlement?.destinationNetwork, "solana");
    assert.equal(bridge?.recipient, SOL_ACCOUNT, "bridge pays the user's Solana account");
    assert.equal(swap?.input?.amount, portionOf(bridge?.minimumOutput?.amount ?? "0", 5_000));
    assert.equal(decodeStepRef(swap?.quoteRef)?.portionBps, 5_000);
    assert.deepEqual(graph.summary.networks, ["base", "solana"]);
    assert.equal(graph.summary.inputs.length, 1, "only the unfunded step contributes inputs");
    assert.ok(graph.warnings.some((warning) => warning.includes("asynchronously")));
    // Half of the bridged USDC stays with the user and is reported as an output.
    assert.ok(graph.summary.outputs.some((output) => output.symbol === "USDC"));
    assert.ok(graph.summary.outputs.some((output) => output.symbol === "JitoSOL"));
  });

  it("merges bridge + swap-everything into one Relay cross-network swap", async () => {
    const graph = await planIntent({
      actions: [
        { kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "solana", to: "USDC" },
        { kind: "swap", network: "solana", from: "USDC", to: "JitoSOL", amount: "max" },
      ],
      accounts: ACCOUNTS,
    });
    assert.deepEqual(shape(graph), ["s1:bridge/relay@base[ready] deps=-"]);
    assert.equal(graph.steps[0]?.minimumOutput?.symbol, "JitoSOL");
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.interpretation.optimizations?.length, 1);
    assert.match(graph.interpretation.optimizations?.[0] ?? "", /Merged bridge .* into one Relay cross-network swap into JitoSOL/u);
  });

  it("does not merge a partial swap or when Relay is avoided", async () => {
    const partial = await planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS });
    assert.equal(partial.steps.length, 2);
    const avoided = await planIntent({
      text: "bridge 50 USDC from base to solana then swap it to JitoSOL",
      accounts: ACCOUNTS,
      constraints: { avoidProtocols: ["relay"] },
    }).catch((error: unknown) => error);
    assert.ok(avoided instanceof PlatformError);
    assert.equal(avoided.code, "INTENT_UNSUPPORTED");
  });

  it("plans bridge + Aave deposit with the aToken as output", async () => {
    const graph = await planIntent({ text: "bridge 20 USDC from solana to base and deposit it into aave", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), [
      "s1:bridge/relay@solana[ready] deps=-",
      "s2:deposit/aave-v3@base[pending] deps=s1",
    ]);
    assert.equal(graph.steps[1]?.account, EVM_ACCOUNT);
    assert.equal(graph.steps[1]?.minimumOutput?.symbol, "aUSDC");
  });

  it("orders independent steps without a funds edge", async () => {
    const graph = await planIntent({ text: `swap 1 SOL to USDC; send 5 USDC to ${OTHER_SOL_ADDRESS}`, accounts: ACCOUNTS });
    assert.deepEqual(graph.edges, [{ from: "s1", to: "s2", kind: "orders" }]);
    assert.equal(graph.steps[1]?.recipient, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${OTHER_SOL_ADDRESS}`);
  });

  it("refuses to mix mainnet and testnet networks", async () => {
    const error = await planError({
      actions: [
        { kind: "transfer", network: "base", from: "USDC", amount: "1", recipient: OTHER_EVM_ADDRESS },
        { kind: "transfer", network: "solana-devnet", from: "SOL", amount: "1", recipient: OTHER_SOL_ADDRESS },
      ],
      accounts: ACCOUNTS,
    });
    assert.equal(error.code, "CAPITAL_LANE_MIXED");
    assert.equal(error.status, 422);
  });

  it("refuses a bridge across lanes", async () => {
    const error = await planError({
      actions: [{ kind: "bridge", network: "arbitrum-sepolia", from: "USDC", amount: "1", toNetwork: "base" }],
      accounts: ACCOUNTS,
    });
    assert.equal(error.code, "CAPITAL_LANE_MIXED");
  });

  it("asks for a Solana account when none is given", async () => {
    const error = await planError({ text: "swap 1 SOL to USDC", accounts: [EVM_ACCOUNT] });
    assert.equal(error.code, "ACCOUNT_REQUIRED");
    assert.equal(error.status, 422);
    assert.match(error.message, /Solana account/u);
  });

  it("asks for a Solana recipient account on a bridge to Solana", async () => {
    const error = await planError({ text: "bridge 25 USDC from base to solana", accounts: [EVM_ACCOUNT] });
    assert.equal(error.code, "ACCOUNT_REQUIRED");
  });

  it("refuses spending the output of a step that pays someone else", async () => {
    const transfer = await planError({ text: `send 5 USDC to ${OTHER_SOL_ADDRESS} then swap it to SOL`, accounts: ACCOUNTS });
    assert.equal(transfer.code, "INTENT_UNSUPPORTED");
    assert.match(transfer.message, /paid to/u);
    const bridge = await planError({
      actions: [
        { kind: "bridge", network: "base", from: "USDC", amount: "10", toNetwork: "solana", recipient: OTHER_SOL_ADDRESS },
        { kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max", params: { portionBps: 5000 } },
      ],
      accounts: ACCOUNTS,
    });
    assert.equal(bridge.code, "INTENT_UNSUPPORTED");
  });

  it("refuses self transfers, same-asset swaps and zero amounts", async () => {
    assert.equal((await planError({ text: "send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", accounts: ACCOUNTS })).code, "SELF_TRANSFER");
    assert.equal((await planError({ actions: [{ kind: "swap", network: "solana", from: "SOL", to: "SOL", amount: "1" }], accounts: ACCOUNTS })).code, "SWAP_SAME_ASSET");
    assert.equal((await planError({ actions: [{ kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "0.0000001" }], accounts: ACCOUNTS })).code, "AMOUNT_INVALID");
  });

  it("refuses a first step with max and a previous step on another network", async () => {
    assert.equal((await planError({ actions: [{ kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max" }], accounts: ACCOUNTS })).code, "INTENT_UNSUPPORTED");
    const crossed = await planError({
      actions: [
        { kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" },
        { kind: "swap", network: "base", from: "USDC", to: "ETH", amount: "max" },
      ],
      accounts: ACCOUNTS,
    });
    assert.equal(crossed.code, "INTENT_UNSUPPORTED");
    assert.match(crossed.message, /delivers them on Solana/u);
  });

  it("enforces constraints: fee limit, deadline, unsupported kinds, testnets", async () => {
    stub.feeUsd = 3;
    const fee = await planError({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, constraints: { maxFeeUsd: 1 } });
    assert.equal(fee.code, "FEE_LIMIT_EXCEEDED");
    const deadline = await planError({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, constraints: { deadline: 1 } });
    assert.equal(deadline.code, "DEADLINE_PASSED");
    const kind = await planError({ actions: [{ kind: "borrow", network: "base", from: "USDC", amount: "1" }], accounts: ACCOUNTS });
    assert.equal(kind.code, "INTENT_UNSUPPORTED");
    const testnet = await planError({
      actions: [{ kind: "transfer", network: "solana-devnet", from: "SOL", amount: "1", recipient: OTHER_SOL_ADDRESS }],
      accounts: ACCOUNTS,
      constraints: { allowTestnets: false },
    });
    assert.equal(testnet.code, "TESTNET_NOT_ALLOWED");
  });

  it("rejects malformed requests with field issues", async () => {
    const error = await planError({ text: "swap 1 SOL to USDC", accounts: ["not-an-account"] });
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.issues?.[0]?.path, "accounts[0]");
  });

  it("rebuilds a funded step's action from the parent's observed output", async () => {
    const graph = await planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS });
    const [bridge, swap] = graph.steps;
    assert.ok(bridge && swap && bridge.minimumOutput);
    const observed = { ...bridge.minimumOutput, amount: "40000000", formatted: "40" };
    const settled: IntentGraph = { ...graph, steps: [{ ...bridge, status: "settled", actualOutput: observed }, swap] };
    const action = actionForStep(settled, swap);
    assert.equal(action.amount, "20000000", "half of the observed 40 USDC");
    assert.equal(action.input.symbol, "USDC");
    assert.equal(action.account.address, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });
});
