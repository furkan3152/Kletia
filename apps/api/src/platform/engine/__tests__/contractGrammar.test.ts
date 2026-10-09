/**
 * Grammar: per-key contract aliases (`deposit 100 USDC into acme vault`),
 * amount words, network disambiguation, fall-through to the built-in
 * sentences, and the drift guard between the grammar's venue words and the
 * reserved alias list of @kletia/core.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESERVED_CONTRACT_PHRASES, reservedContractPhrase } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { ContractPhrase } from "../contracts/directory.js";
import { compileIntentText, GRAMMAR_EXAMPLES, GRAMMAR_VENUE_WORDS, isGrammarVenueWord, type GrammarContext } from "../grammar.js";

const ACCOUNTS: GrammarContext["accounts"] = ["eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"];

const PHRASES: readonly ContractPhrase[] = [
  { contract: "ct_000000000000000000000001", entry: "deposit", network: "base", vm: "evm", verbs: ["deposit", "supply"], aliases: ["acme vault", "acme"], spends: true },
  { contract: "ct_000000000000000000000002", entry: "deposit", network: "arbitrum", vm: "evm", verbs: ["deposit"], aliases: ["acme vault", "acme"], spends: true },
  { contract: "ct_000000000000000000000003", entry: "claim", network: "base", vm: "evm", verbs: ["claim", "harvest"], aliases: ["acme rewards"], spends: false },
  { contract: "ct_000000000000000000000004", entry: "stake", network: "solana", vm: "svm", verbs: ["stake"], aliases: ["acme stake"], spends: true },
];

function compile(text: string, context: GrammarContext = {}) {
  return compileIntentText(text, { accounts: ACCOUNTS, contracts: PHRASES, ...context });
}

function clauseError(pattern: RegExp) {
  return (error: unknown) => error instanceof PlatformError && error.code === "INTENT_UNSUPPORTED" && pattern.test(error.message);
}

describe("grammar: contract aliases", () => {
  it("turns an alias clause into a call step on the alias's network", () => {
    assert.deepEqual(compile("deposit 100 USDC into acme vault on base").actions, [
      { kind: "call", network: "base", contract: "ct_000000000000000000000001", entry: "deposit", from: "USDC", amount: "100" },
    ]);
    assert.deepEqual(compile("supply 5 into the acme pool on base").actions[0], { kind: "call", network: "base", contract: "ct_000000000000000000000001", entry: "deposit", amount: "5" });
    assert.deepEqual(compile("stake 2 SOL with acme stake").actions[0], { kind: "action", network: "solana", contract: "ct_000000000000000000000004", entry: "stake", from: "SOL", amount: "2" });
    assert.deepEqual(compile("deposit $50 into acme on base").actions[0]?.from, "USDC");
  });

  it("chains amount words to the previous step and picks the registration on its destination", () => {
    const result = compile("bridge 100 USDC from base to arbitrum then deposit it into acme vault");
    assert.deepEqual(result.actions[1], { kind: "call", network: "arbitrum", contract: "ct_000000000000000000000002", entry: "deposit", amount: "max" });
    assert.deepEqual(compile("bridge 100 USDC from base to arbitrum and deposit half into acme").actions[1]?.params, { portionBps: 5_000 });
    assert.deepEqual(compile("bridge 100 USDC from base to arbitrum, deposit 25% into acme").actions[1]?.params, { portionBps: 2_500 });
  });

  it("asks for a network when an alias is registered on several and nothing settles it", () => {
    assert.throws(() => compile("deposit 100 USDC into acme vault"), clauseError(/several registered actions \(Base, Arbitrum One\)/u));
    assert.throws(() => compile("deposit 100 USDC into acme on optimism"), clauseError(/registered on Base, Arbitrum One, not OP Mainnet/u));
  });

  it("handles non-spending entries without an amount and refuses one", () => {
    assert.deepEqual(compile("claim rewards from acme rewards").actions[0], { kind: "call", network: "base", contract: "ct_000000000000000000000003", entry: "claim" });
    assert.deepEqual(compile("swap 1 SOL to USDC then harvest my rewards from acme rewards").actions[1]?.entry, "claim");
    assert.throws(() => compile("claim 5 USDC from acme rewards"), clauseError(/spends nothing/u));
    assert.throws(() => compile("deposit into acme vault on base"), clauseError(/how much/u));
    assert.throws(() => compile("deposit all into acme on base"), clauseError(/previous step/u));
  });

  it("refuses a verb the alias does not take", () => {
    assert.throws(() => compile("stake 5 USDC into acme vault on base"), clauseError(/accepts "deposit", "supply"/u));
  });

  it("falls through to the built-in sentences when no alias matches", () => {
    assert.equal(compile("deposit 100 USDC into aave on base").actions[0]?.kind, "deposit");
    assert.equal(compile("stake 1.5 SOL with marinade").actions[0]?.kind, "stake");
    assert.throws(() => compile("deposit 100 USDC into bogus vault on base"), (error: unknown) => error instanceof PlatformError && error.code === "INTENT_UNSUPPORTED");
  });

  it("leaves every built-in example unchanged", () => {
    for (const example of GRAMMAR_EXAMPLES) {
      assert.deepEqual(compile(example), compileIntentText(example, { accounts: ACCOUNTS }), example);
    }
  });

  it("splits clauses on the key's own verbs", () => {
    const result = compile("bridge 100 USDC from base to arbitrum and deposit it into acme vault, claim rewards from acme rewards on base");
    assert.deepEqual(result.actions.map((action) => action.kind), ["bridge", "call", "call"]);
  });
});

describe("grammar: reserved-word drift guard", () => {
  it("keeps every grammar venue word reserved for aliases (and matched by the grammar)", () => {
    for (const word of GRAMMAR_VENUE_WORDS) {
      assert.ok(RESERVED_CONTRACT_PHRASES.includes(word), `${word} must be in RESERVED_CONTRACT_PHRASES`);
      assert.notEqual(reservedContractPhrase(word), null, word);
      assert.ok(isGrammarVenueWord(word), `${word} must still be a grammar venue word`);
    }
  });
});
