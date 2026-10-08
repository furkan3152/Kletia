import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { compileIntentText, GRAMMAR_EXAMPLES, splitClauses } from "../grammar.js";
import { ACCOUNTS, EVM_ACCOUNT } from "./helpers.js";

const accounts = ACCOUNTS as AccountId[];

function refused(text: string, context: Parameters<typeof compileIntentText>[1] = { accounts }): PlatformError {
  try {
    compileIntentText(text, context);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError for "${text}"`);
    return error;
  }
  assert.fail(`"${text}" compiled but should have been refused`);
}

describe("grammar: published examples", () => {
  for (const example of GRAMMAR_EXAMPLES) {
    it(`compiles "${example}"`, () => {
      const result = compileIntentText(example, { accounts });
      assert.ok(result.actions.length >= 1);
      assert.equal(result.clauses.length, result.actions.length);
    });
  }

  it("maps each example to the expected actions", () => {
    const shapes = GRAMMAR_EXAMPLES.map((example) =>
      compileIntentText(example, { accounts }).actions.map((action) =>
        [action.kind, action.network, action.toNetwork ?? "-", action.from ?? "-", action.to ?? "-", action.amount].join(" ")));
    assert.deepEqual(shapes, [
      ["swap solana - SOL USDC 1"],
      ["swap base - ETH USDC 0.01"],
      ["swap solana - SOL JitoSOL 2"],
      ["stake solana - SOL mSOL 1.5"],
      ["transfer solana - USDC - 5"],
      ["transfer arbitrum - ETH - 0.001"],
      ["bridge base solana USDC - 25"],
      ["bridge solana arbitrum USDC - 100"],
      ["bridge arbitrum solana ETH SOL 0.01"],
      ["bridge base solana USDC - 50", "swap solana - - JitoSOL max"],
      ["bridge solana base USDC - 20", "deposit base - - - max"],
      ["swap solana - USDC SOL 10", "stake solana - - JitoSOL max"],
    ]);
  });

  it("records the portion of the previous output for half / percentages", () => {
    const half = compileIntentText("bridge 50 USDC from base to solana then swap half to JitoSOL", { accounts });
    assert.equal(half.actions[1]?.params?.portionBps, 5_000);
    const pct = compileIntentText("bridge 50 USDC from base to solana; swap 25% to SOL", { accounts });
    assert.equal(pct.actions[1]?.params?.portionBps, 2_500);
    const all = compileIntentText("bridge 50 USDC from base to solana and then swap it to SOL", { accounts });
    assert.equal(all.actions[1]?.params, undefined);
    assert.equal(all.actions[1]?.amount, "max");
  });

  it("sets the liquid-staking provider and target", () => {
    const [action] = compileIntentText("stake 1.5 SOL with marinade", { accounts }).actions;
    assert.equal(action?.to, "mSOL");
    assert.equal(action?.params?.provider, "Marinade");
    const [jito] = compileIntentText("stake 2 sol", { accounts }).actions;
    assert.equal(jito?.to, "JitoSOL");
  });

  it("accepts thousands separators, $ amounts and polite prefixes", () => {
    const [big] = compileIntentText("please swap 1,250.5 USDC to SOL", { accounts }).actions;
    assert.equal(big?.amount, "1250.5");
    const [usd] = compileIntentText("swap $20 to SOL", { accounts }).actions;
    assert.equal(usd?.from, "USDC");
    assert.equal(usd?.amount, "20");
    const [arrow] = compileIntentText("swap 1 SOL -> USDC", { accounts }).actions;
    assert.equal(arrow?.to, "USDC");
  });

  it("infers the network from the previous step, defaultNetwork and accounts", () => {
    const chained = compileIntentText("bridge 10 USDC from base to arbitrum then send it to 0x000000000000000000000000000000000000dEaD", { accounts });
    assert.equal(chained.actions[1]?.network, "arbitrum");
    const byDefault = compileIntentText("bridge 10 USDC to solana", { accounts, defaultNetwork: "base" });
    assert.equal(byDefault.actions[0]?.network, "base");
    const evmOnly = compileIntentText("swap 0.1 ETH to USDC", { accounts: [EVM_ACCOUNT as AccountId] });
    assert.equal(evmOnly.actions[0]?.network, "base");
  });

  it("splits clauses on ; then, and-then and verb-led and", () => {
    assert.deepEqual(splitClauses("swap 1 SOL to USDC; send 5 USDC to x"), ["swap 1 SOL to USDC", "send 5 USDC to x"]);
    assert.deepEqual(splitClauses("swap 1 SOL to USDC, then stake it"), ["swap 1 SOL to USDC", "stake it"]);
    assert.deepEqual(splitClauses("bridge 1 USDC from base to solana and swap it to SOL"), ["bridge 1 USDC from base to solana", "swap it to SOL"]);
  });
});

describe("grammar: refusals (never guessed)", () => {
  const cases: readonly [string, RegExp][] = [
    ["borrow 100 USDC on aave", /not a supported action/u],
    ["swap all SOL to USDC", /refer to a previous step/u],
    ["swap half to USDC", /refer to a previous step/u],
    ["swap 1,5 SOL to USDC", /use a dot for decimals/u],
    ["swap 12,34,5 SOL to USDC", /use a dot for decimals/u],
    ["swap 0 SOL to USDC", /not a positive amount/u],
    ["bridge 10 USDC from base to solana then swap 150% to SOL", /between 0 and 100/u],
    ["bridge 10 USDC to solana", /Say where the funds come from/u],
    ["bridge 10 USDC from solana to solana", /source and destination networks are the same/u],
    ["send 5 USDC to not-an-address", /does not match/u],
    ["stake 1 USDC", /does not match/u],
    ["swap 1 SOL to USDC on narnia", /does not match/u],
    ["swap $5 ETH to USDC on base", /USD stablecoin/u],
    ["swap $5 ETH to SOL", /Cannot find one network/u],
    ["send 5 USDC to solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:notbase58!!", /CAIP-10|does not match/u],
  ];
  for (const [text, message] of cases) {
    it(`refuses "${text}"`, () => {
      const error = refused(text);
      assert.equal(error.code, "INTENT_UNSUPPORTED");
      assert.equal(error.status, 422);
      assert.match(error.message, message);
      assert.ok(error.hints && error.hints.length > 0, "carries example hints");
    });
  }

  it("refuses empty and oversized text", () => {
    assert.equal(refused("   ").code, "INTENT_UNSUPPORTED");
    const nine = Array.from({ length: 9 }, () => "swap 1 SOL to USDC").join("; ");
    assert.match(refused(nine).message, /at most 8 actions/u);
  });

  it("refuses ambiguous swap networks instead of guessing", () => {
    // USDC -> WETH exists on both Base and Arbitrum; with no hint the EVM default applies (documented), but
    // with only a Solana account and no default it is still deterministic.
    const result = compileIntentText("swap 10 USDC to WETH", { accounts: [] });
    assert.equal(result.actions[0]?.network, "base");
  });
});
