import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateIntentGraph, type AccountId, type ProtocolId } from "@kletia/core";
import { configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { compileIntentText } from "../grammar.js";
import { planIntent } from "../planner.js";
import { ACCOUNTS, resetEngine, STUB_ADAPTERS, stubJupiter } from "./helpers.js";

// These tests exercise the planner independently of provider fixtures. The
// protocol adapters have their own transaction/chain-verification suites.
function directDex(id: "raydium" | "orca"): ProtocolAdapter {
  return {
    ...stubJupiter,
    id,
    protocols: [id],
    label: id,
    supports: (route) => route.kind === "swap" && stubJupiter.supports(route),
    plan: async (action) => ({ ...await stubJupiter.plan(action), protocol: id }),
  };
}

beforeEach(() => {
  resetEngine();
  configureAdapters([...STUB_ADAPTERS, directDex("raydium"), directDex("orca")]);
});
afterEach(() => resetEngine());

describe("expanded protocol grammar and route binding", () => {
  const phrases: readonly [string, ProtocolId, string][] = [
    ["swap 1 SOL to USDC via raydium", "raydium", "solana"],
    ["swap 1 SOL to USDC on solana using orca", "orca", "solana"],
    ["swap 1 SOL to USDC through raydium on solana", "raydium", "solana"],
    ["buy SOL with 10 USDC with orca on solana", "orca", "solana"],
    ["deposit 10 USDC into spark", "spark", "ethereum"],
    ["withdraw all WETH from spark lend on ethereum", "spark", "ethereum"],
    ["deposit 10 USDC into yearn v3 usdc-1 on ethereum", "yearn-v3", "ethereum"],
    ["withdraw all USDC from yearn-v3 on ethereum", "yearn-v3", "ethereum"],
  ];
  for (const [text, protocol, network] of phrases) {
    it(`binds the named venue in ${text}`, () => {
      const [action] = compileIntentText(text, { accounts: ACCOUNTS as readonly AccountId[] }).actions;
      assert.equal(action?.protocol, protocol);
      assert.equal(action?.network, network);
    });
  }

  it("keeps a specifically named destination DEX out of the bridge auction", async () => {
    const graph = await planIntent({
      text: "bridge 25 USDC from base to solana then swap it to SOL via orca",
      accounts: ACCOUNTS,
    });
    assert.deepEqual(graph.steps.map((step) => [step.kind, step.protocol, step.status]), [
      ["bridge", "relay", "ready"], ["swap", "orca", "pending"],
    ]);
    assert.deepEqual(graph.steps[1]?.dependsOn, ["s1"]);
    assert.deepEqual(validateIntentGraph(graph), []);
  });

  it("respects a preferred direct DEX when considering bridge+swap optimization", async () => {
    const graph = await planIntent({
      text: "bridge 25 USDC from base to solana then swap it to SOL",
      accounts: ACCOUNTS,
      constraints: { preferProtocols: ["raydium"] },
    });
    assert.equal(graph.steps.length, 2);
    assert.equal(graph.steps[1]?.protocol, "raydium");
  });

  it("preserves a complex route's named venues, partial amounts and dependency order", async () => {
    const graph = await planIntent({
      text: "bridge 50 USDC from base to solana then swap half to SOL via raydium then swap half to USDC using orca then deposit it into aave on base",
      accounts: ACCOUNTS,
    }).catch((error: unknown) => error);
    // The final action cannot consume Solana funds on Base without a bridge.
    assert.ok(graph instanceof Error);
    assert.match(graph.message, /spends funds on Base.*delivers them on Solana/u);
    const valid = await planIntent({
      text: "bridge 50 USDC from base to solana then swap half to SOL via raydium then swap half to USDC using orca then bridge it to base then deposit it into aave",
      accounts: ACCOUNTS,
    });
    assert.deepEqual(valid.steps.map((step) => step.protocol), ["relay", "raydium", "orca", "relay", "aave-v3"]);
    assert.deepEqual(valid.steps.map((step) => step.dependsOn), [[], ["s1"], ["s2"], ["s3"], ["s4"]]);
    assert.equal(valid.summary.crossNetwork, true);
    assert.deepEqual(validateIntentGraph(valid), []);
  });

  it("never substitutes Jupiter when the named DEX is forbidden", async () => {
    await assert.rejects(planIntent({
      text: "swap 1 SOL to USDC via orca",
      accounts: ACCOUNTS,
      constraints: { avoidProtocols: ["orca"] },
    }), { code: "INTENT_UNSUPPORTED" });
  });
});
