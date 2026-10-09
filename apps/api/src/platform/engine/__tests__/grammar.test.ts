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
      ["deposit base - USDC - 100"],
      ["withdraw base - USDC - 50"],
      ["withdraw arbitrum - USDC - max"],
      ["deposit solana - USDC - 10"],
      ["bridge base solana USDC - 25"],
      ["bridge ethereum base USDC - 100"],
      ["transfer optimism - USDC - 5"],
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

describe("grammar: lending venues, bridge venues, new networks and names", () => {
  const solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as AccountId;
  const shape = (text: string, context: Parameters<typeof compileIntentText>[1] = { accounts }) =>
    compileIntentText(text, context).actions.map((action) =>
      [action.kind, action.network, action.toNetwork ?? "-", action.from ?? "-", action.amount, action.protocol ?? "-", action.recipient ?? "-", String(action.params?.venue ?? "-")].join(" "));

  const phrases: readonly [string, string][] = [
    ["withdraw 50 USDC from aave on base", "withdraw base - USDC 50 aave-v3 - -"],
    ["withdraw all USDC from compound on arbitrum", "withdraw arbitrum - USDC max compound-v3 - -"],
    ["deposit 100 USDC into morpho on base", "deposit base - USDC 100 morpho - -"],
    ["supply 1 ETH to compound on arbitrum", "deposit arbitrum - ETH 1 compound-v3 - -"],
    ["lend 50 USDC on moonwell", "deposit base - USDC 50 moonwell - -"],
    ["deposit 10 USDC into jupiter lend", "deposit solana - USDC 10 jupiter-lend - -"],
    ["deposit 5 USDC into kamino", "deposit solana - USDC 5 kamino - -"],
    ["deposit 100 USDC into morpho spark-usdc on base", "deposit base - USDC 100 morpho - spark-usdc"],
    ["deposit 100 USDC into the morpho vault on base", "deposit base - USDC 100 morpho - -"],
    ["withdraw everything of my USDC from compound v3 on base", "withdraw base - USDC max compound-v3 - -"],
    ["bridge 25 USDC from base to solana via lifi", "bridge base solana USDC 25 lifi - -"],
    ["bridge 25 USDC from base to solana via debridge dln", "bridge base solana USDC 25 debridge-dln - -"],
    ["move 0.01 ETH from arbitrum to solana as SOL using relay", "bridge arbitrum solana ETH 0.01 relay - -"],
    ["bridge 100 USDC from ethereum to base", "bridge ethereum base USDC 100 - - -"],
    ["bridge 10 USDC from op mainnet to polygon pos", "bridge optimism polygon USDC 10 - - -"],
    ["send 5 USDC to vitalik.eth on optimism", "transfer optimism - USDC 5 - vitalik.eth -"],
    ["send 5 USDC to jesse.base.eth", "transfer base - USDC 5 - jesse.base.eth -"],
    ["send 1 USDC to bonfida.sns", "transfer solana - USDC 1 - bonfida.sns -"],
  ];
  for (const [text, expected] of phrases) {
    it(`compiles "${text}"`, () => {
      assert.deepEqual(shape(text), [expected]);
    });
  }

  it("lets a full withdrawal fund the next step", () => {
    assert.deepEqual(shape("withdraw all USDC from aave on base then bridge it to solana"), [
      "withdraw base - USDC max aave-v3 - -",
      "bridge base solana - max - - -",
    ]);
  });

  it("infers lending and name networks from the venue, the name and the caller's accounts", () => {
    const ethereum = "eip155:1:0x4f183e308f24c81c05303821AD025812fBFd807D" as AccountId;
    assert.deepEqual(shape("deposit 100 USDC into aave", { accounts: [ethereum] }), ["deposit ethereum - USDC 100 aave-v3 - -"]);
    assert.deepEqual(shape("send 5 USDC to vitalik.eth", { accounts: [ethereum] }), ["transfer ethereum - USDC 5 - vitalik.eth -"]);
    assert.deepEqual(shape("lend 50 USDC on moonwell", { accounts: [solana] }), ["deposit base - USDC 50 moonwell - -"]);
    assert.deepEqual(shape("bridge 20 USDC from base to solana and deposit it into kamino"), [
      "bridge base solana USDC 20 - - -",
      "deposit solana - - max kamino - -",
    ]);
  });

  const refusals: readonly [string, RegExp][] = [
    ["withdraw half USDC from aave on base", /exact amount or "all"/u],
    ["withdraw it from aave on base", /exact amount or "all"/u],
    ["withdraw all from aave on base", /which asset to withdraw/u],
    ["deposit 100 USDC on base", /does not match/u],
    ["deposit 100 USDC into aave spark-usdc on base", /Only Morpho vaults are named/u],
    ["deposit 100 USDC into venus on base", /does not match/u],
    ["bridge 25 USDC from base to solana via wormhole", /does not match/u],
    ["withdraw $5 ETH from aave on base", /USD stablecoin/u],
  ];
  for (const [text, message] of refusals) {
    it(`refuses "${text}"`, () => {
      const error = refused(text);
      assert.equal(error.code, "INTENT_UNSUPPORTED");
      assert.equal(error.status, 422);
      assert.match(error.message, message);
      assert.ok(error.hints?.includes("withdraw 50 USDC from aave on base"), "hints include the lending examples");
    });
  }
});
