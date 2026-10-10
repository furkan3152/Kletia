import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseDeterministicArcIntent, parseUserIntent } from "../../../shared/ai/parser.js";
import { assetResolverInternals, EntityResolutionError } from "../../../shared/assets/resolver.js";

const examples = [
  ["Unstake 2.5 native USDC from Kletia Legacy Staking on Arc Testnet and start the contract-defined cooldown; simulate it before wallet approval", "unstake", "2.5"],
  ["Claim all available rewards from Kletia Legacy Staking on Arc Testnet; simulate it before wallet approval", "claim_rewards", "0"],
  ["Claim my cooled-down unstaked native USDC from Kletia Legacy Staking on Arc Testnet; simulate it before wallet approval", "claim_unstaked", "0"],
  ["Repay 3 native USDC to Kletia Legacy Lending on Arc Testnet; prepare the route and simulate it before wallet approval", "lending_repay", "3"],
  ["Withdraw 4 KLET collateral from Kletia Legacy Lending on Arc Testnet; prepare the route and simulate it before wallet approval", "lending_withdraw", "4"],
  ["Remove 5 LP tokens from Kletia Legacy Swap on Arc Testnet; simulate it before wallet approval", "remove_liquidity", "5"],
] as const;

describe("Arc historical target binding", () => {
  for (const [prompt, action, amount] of examples) {
    it(`binds the explicit historical ${action} prompt and preserves the amount`, () => {
      for (const marker of ["Kletia Legacy", "Legacy Kletia"]) {
        const result = parseDeterministicArcIntent(prompt.replace("Kletia Legacy", marker));
        assert.equal(result?.isComplete, true);
        assert.equal(result?.action, action);
        assert.equal(result?.amount, amount);
        assert.equal(result?.protocol, "kletia legacy");
      }
      const current = parseDeterministicArcIntent(prompt.replace("Kletia Legacy", "Kletia"));
      assert.equal(current?.isComplete, true);
      assert.equal(current?.protocol, undefined);
    });
  }

  it("accepts the historical protocol in entity resolution only for Arc existing-position exits", () => {
    for (const [, action] of examples) {
      assert.equal(assetResolverInternals.resolveProtocol("arc", action, "kletia legacy")?.canonical, "kletia-arc-legacy");
    }
    for (const action of ["swap", "stake", "add_liquidity", "lending_deposit", "lending_borrow", "appkit_send"]) {
      assert.throws(() => assetResolverInternals.resolveProtocol("arc", action, "kletia legacy"), (error: unknown) => error instanceof EntityResolutionError && error.code === "PROTOCOL_ACTION_UNSUPPORTED");
    }
    for (const network of ["base", "arbitrum"] as const) {
      assert.throws(() => assetResolverInternals.resolveProtocol(network, "lending_repay", "kletia legacy"));
    }
  });

  it("preserves the independent Vault migration action", () => {
    const result = parseDeterministicArcIntent("Withdraw my full legacy Kletia Vault position for migration on Arc Testnet; preserve every other depositor's principal and simulate it before wallet approval");
    assert.equal(result?.action, "vault_legacy_withdraw");
    assert.equal(result?.protocol, undefined);
  });

  it("refuses explicit legacy new capital before preparing a route", () => {
    const result = parseDeterministicArcIntent("Stake 1 native USDC in Kletia Legacy Staking on Arc Testnet; prepare the route and simulate it before wallet approval");
    assert.equal(result?.isComplete, false);
    assert.match(result?.message || "", /exits and debt repayment only/u);
  });
});

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function mockSemanticResponse(protocol: string, action = "lending_repay") {
  process.env.OPENROUTER_API_KEY = "test-only-placeholder";
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isComplete: true, action, tokenIn: "USDC", amount: "2", protocol, message: "Prepared" }) } }] }), { headers: { "Content-Type": "application/json" } });
}

describe("Arc consented semantic target binding", () => {
  it("restores the historical target from the user message when a model drops the marker", async () => {
    mockSemanticResponse("kletia");
    const result = await parseUserIntent("Please repay 2 native USDC to Kletia Legacy Lending on Arc Testnet now", [], "arc", { semanticPlanner: "ai_assisted" });
    assert.equal(result.isComplete, true);
    assert.equal(result.protocol, "kletia legacy");
  });

  it("rejects an invented historical model target", async () => {
    mockSemanticResponse("kletia legacy");
    const result = await parseUserIntent("Please repay 2 native USDC to Kletia Lending on Arc Testnet now", [], "arc", { semanticPlanner: "ai_assisted" });
    assert.equal(result.isComplete, false);
    assert.match(result.message || "", /historical Arc target/u);
  });

  it("rejects a legacy family that does not match the repayment action", async () => {
    mockSemanticResponse("kletia");
    const result = await parseUserIntent("Please repay 2 native USDC to Kletia Legacy Staking on Arc Testnet now", [], "arc", { semanticPlanner: "ai_assisted" });
    assert.equal(result.isComplete, false);
    assert.match(result.message || "", /action must match/u);
  });
});
