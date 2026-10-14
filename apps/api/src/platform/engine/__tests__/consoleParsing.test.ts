/**
 * The console's deterministic parsers (Base, Arc, Arbitrum): a prompt that
 * names a balance or position together with a money-moving verb is an
 * action, never a portfolio read; plain reads stay portfolio reads; and the
 * Arc liquidity widget's LP exit prompt parses to remove_liquidity.
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/consoleParsing.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeterministicArbitrumIntent, parseDeterministicArcIntent, parseDeterministicBaseIntent } from "../../../shared/ai/parser.js";

const PARSERS = {
  base: parseDeterministicBaseIntent,
  arc: parseDeterministicArcIntent,
  arbitrum: parseDeterministicArbitrumIntent,
} as const;

const ACTIONS = [
  "withdraw my whole aave position on base",
  "withdraw all my positions from aave on arbitrum",
  "send my USDC balance to 0x000000000000000000000000000000000000dEaD",
  "Withdraw all my positions from Kletia Lending on Arc Testnet",
  "Repay my lending position balance on Arc Testnet",
  "Stake my USDC balance in Kletia Staking on Arc Testnet",
  "close my aave position",
  "swap my whole ETH balance to USDC",
  "bridge my USDC balance to arbitrum",
  "move my holdings to base",
  // Turkish verbs that start with a non-ASCII letter ("withdraw the whole balance", "pay from the balance").
  "tüm bakiye çek",
  "bakiye öde 0x000000000000000000000000000000000000dEaD",
];

const READS = [
  "show my portfolio",
  "show my Base portfolio",
  "show my Arc balances",
  "what are my positions",
  "show my staking positions",
  "list my holdings",
  "portföy",
];

describe("console parsers: portfolio reads versus actions on a balance or position", () => {
  for (const [network, parse] of Object.entries(PARSERS)) {
    for (const prompt of ACTIONS) {
      it(`${network} never reads "${prompt}" as a portfolio`, () => {
        assert.notEqual(parse(prompt)?.action, "portfolio");
      });
    }
  }

  for (const prompt of READS) {
    it(`"${prompt}" stays a portfolio read on Arc and Arbitrum`, () => {
      assert.equal(parseDeterministicArcIntent(prompt)?.action, "portfolio");
      assert.equal(parseDeterministicArbitrumIntent(prompt)?.action, "portfolio");
    });
  }

  it("keeps Base portfolio reads (and leaves Arc wording to the Arc parser)", () => {
    assert.equal(parseDeterministicBaseIntent("show my Base portfolio")?.action, "portfolio");
    assert.equal(parseDeterministicBaseIntent("show my balances")?.action, "portfolio");
    assert.equal(parseDeterministicBaseIntent("show my Arc Testnet balances"), null);
  });
});

describe("Arc LP exit (liquidity widget)", () => {
  it("parses the widget's prompt to remove_liquidity with the exact amount", () => {
    for (const [prompt, amount] of [
      ["Remove 1 LP tokens from Kletia Swap on Arc Testnet; simulate it before wallet approval", "1"],
      ["Remove 1 LP tokens from Kletia Swap on Arc Testnet", "1"],
      ["Remove 2.5 LP tokens from Kletia Swap on Arc Testnet; simulate it before wallet approval.", "2.5"],
      ["remove 0.000001 LP token from kletia swap on arc testnet", "0.000001"],
    ] as const) {
      const intent = parseDeterministicArcIntent(prompt);
      assert.equal(intent?.action, "remove_liquidity", prompt);
      assert.equal(intent?.amount, amount, prompt);
      assert.equal(intent?.isComplete, true, prompt);
    }
  });

  it("does not guess other pools, networks or amounts", () => {
    for (const prompt of [
      "Remove 1 LP tokens from Kletia Swap on Base",
      "Remove all LP tokens from Kletia Swap on Arc Testnet",
      "Remove -1 LP tokens from Kletia Swap on Arc Testnet",
      "Remove 1 LP tokens from Uniswap on Arc Testnet",
      "Remove 1 LP tokens from Kletia Swap on Arc Testnet and send them to 0x000000000000000000000000000000000000dEaD",
    ]) {
      assert.notEqual(parseDeterministicArcIntent(prompt)?.action, "remove_liquidity", prompt);
    }
  });
});
