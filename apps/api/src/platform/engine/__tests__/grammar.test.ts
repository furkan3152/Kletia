import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { RESERVED_CONTRACT_PHRASES } from "@kletia/core";
import {
  BRIDGE_VENUES,
  compileIntentText,
  GRAMMAR_EXAMPLES,
  GRAMMAR_VENUE_WORDS,
  LENDING_VENUES,
  LENDING_WORDS,
  MissingSourceError,
  normalizeText,
  SENTENCE_FRAGMENTS,
  splitClauses,
  SWAP_NETWORKS,
  SWAP_VENUES,
  VERBS,
} from "../grammar.js";
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

  it("maps each example to the expected actions and venues", () => {
    const shapes = GRAMMAR_EXAMPLES.map((example) =>
      compileIntentText(example, { accounts }).actions.map((action) =>
        [action.kind, action.network, action.toNetwork ?? "-", action.from ?? "-", action.to ?? "-", action.amount, action.protocol ?? "-"].join(" ")));
    assert.deepEqual(shapes, [
      ["swap solana - SOL USDC 1 -"],
      ["swap base - ETH USDC 0.01 -"],
      ["swap solana - SOL JitoSOL 2 -"],
      ["stake solana - SOL mSOL 1.5 -"],
      ["transfer solana - USDC - 5 -"],
      ["transfer arbitrum - ETH - 0.001 -"],
      ["bridge base solana USDC - 25 -"],
      ["bridge solana arbitrum USDC - 100 -"],
      ["bridge arbitrum solana ETH SOL 0.01 -"],
      ["bridge base solana USDC - 50 -", "swap solana - - JitoSOL max -"],
      ["bridge solana base USDC - 20 -", "deposit base - - - max aave-v3"],
      ["swap solana - USDC SOL 10 -", "stake solana - - JitoSOL max -"],
      ["deposit base - USDC - 100 morpho"],
      ["withdraw base - USDC - 50 aave-v3"],
      ["withdraw arbitrum - USDC - max compound-v3"],
      ["deposit solana - USDC - 10 jupiter-lend"],
      ["bridge base solana USDC - 25 lifi"],
      ["bridge ethereum base USDC - 100 -"],
      ["transfer optimism - USDC - 5 -"],
      ["swap solana - SOL USDC 1 raydium"],
      ["swap solana - USDC SOL 10 orca"],
      ["swap solana - SOL USDC 1 meteora"],
      ["swap ethereum - USDC ETH 100 -"],
      ["stake ethereum - ETH wstETH 1 lido"],
      ["deposit ethereum - USDC - 100 sparklend"],
      ["deposit base - USDC - 100 spark-savings"],
      ["deposit ethereum - USDC - 100 yearn-v3"],
      ["bridge base arbitrum USDC - 100 across"],
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
    ["deposit 100 USDC into aave spark-usdc on base", /Only Morpho, Spark Savings and Yearn vaults are named/u],
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

describe("grammar: round-6 venues, staking and swap networks (protocols P0)", () => {
  const shape = (text: string, context: Parameters<typeof compileIntentText>[1] = { accounts }) =>
    compileIntentText(text, context).actions.map((action) =>
      [action.kind, action.network, action.from ?? "-", action.to ?? "-", action.amount, action.protocol ?? "-", String(action.params?.venue ?? "-")].join(" "));

  const phrases: readonly [string, string][] = [
    ["swap 100 USDC to POL", "swap polygon USDC POL 100 - -"],
    ["swap 100 USDC to ETH on optimism via velodrome", "swap optimism USDC ETH 100 velodrome -"],
    ["swap 0.05 ETH to USDC on base via aerodrome", "swap base ETH USDC 0.05 aerodrome -"],
    ["swap 100 USDC to ETH via uniswap on arbitrum", "swap arbitrum USDC ETH 100 uniswap-v3 -"],
    ["swap 1 SOL to USDC via meteora", "swap solana SOL USDC 1 meteora -"],
    ["swap 1 SOL to USDC through raydium on solana", "swap solana SOL USDC 1 raydium -"],
    ["buy SOL with 10 USDC with orca on solana", "swap solana USDC SOL 10 orca -"],
    ["stake 1 ETH with lido", "stake ethereum ETH wstETH 1 lido -"],
    ["stake 0.5 ETH with rocket pool", "stake ethereum ETH rETH 0.5 rocket-pool -"],
    ["stake 0.5 eth with ether.fi", "stake ethereum ETH weETH 0.5 etherfi -"],
    ["stake 1 ETH", "stake ethereum ETH wstETH 1 lido -"],
    ["stake 2 SOL with jito", "stake solana SOL JitoSOL 2 - -"],
    ["deposit 100 USDC into spark savings on base", "deposit base USDC - 100 spark-savings -"],
    ["deposit 100 USDC into sparklend on ethereum", "deposit ethereum USDC - 100 sparklend -"],
    ["withdraw all WETH from spark lend on ethereum", "withdraw ethereum WETH - max sparklend -"],
    ["deposit 1 WETH into spark speth on ethereum", "deposit ethereum WETH - 1 spark-savings speth"],
    ["deposit 100 USDC into fluid on polygon", "deposit polygon USDC - 100 fluid -"],
    ["withdraw all USDC from yearn usdc-1 on ethereum", "withdraw ethereum USDC - max yearn-v3 usdc-1"],
    ["deposit 10 USDC into yearn v3 usdc-1 on ethereum", "deposit ethereum USDC - 10 yearn-v3 usdc-1"],
    ["bridge 100 USDC from base to arbitrum via across", "bridge base USDC - 100 across -"],
    ["bridge 100 USDC from base to solana via cctp", "bridge base USDC - 100 cctp-v2 -"],
  ];
  for (const [text, expected] of phrases) {
    it(`compiles "${text}"`, () => {
      assert.deepEqual(shape(text), [expected]);
    });
  }

  it("keeps the EVM fallback on Base when only EVM networks list both tokens and nothing hints", () => {
    assert.deepEqual(shape("swap 10 USDC to WETH", { accounts: [] }), ["swap base USDC WETH 10 - -"]);
    assert.deepEqual(shape("swap 10 USDC to WETH", { accounts: ["eip155:10:0x4f183e308f24c81c05303821AD025812fBFd807D" as AccountId] }), ["swap optimism USDC WETH 10 - -"]);
    assert.deepEqual([...SWAP_NETWORKS], ["solana", "base", "arbitrum", "ethereum", "optimism", "polygon"]);
  });

  it("refuses stake words of the other VM and a named venue that lists neither token", () => {
    assert.match(refused("stake 1 SOL with lido").message, /stakes ETH on Ethereum, not SOL/u);
    assert.match(refused("stake 1 ETH with jito").message, /stakes SOL on Solana, not ETH/u);
    assert.match(refused("swap 1 SOL to USDC via uniswap").message, /Uniswap V3 swaps run on Base/u);
  });

  it("reads bare \"spark\" as Spark Savings and names SparkLend in a warning", () => {
    const result = compileIntentText("deposit 100 USDC into spark on ethereum", { accounts });
    assert.equal(result.actions[0]?.protocol, "spark-savings");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /Spark Savings.*sparklend.*SparkLend/u);
    assert.deepEqual(compileIntentText("deposit 100 USDC into sparklend on ethereum", { accounts }).warnings, []);
    assert.deepEqual(compileIntentText("deposit 100 USDC into spark savings on ethereum", { accounts }).warnings, []);
  });

  it("keeps every grammar venue word reserved for contract aliases (drift)", () => {
    const reserved = new Set(RESERVED_CONTRACT_PHRASES);
    for (const word of GRAMMAR_VENUE_WORDS) assert.ok(reserved.has(word), `${word} must be in RESERVED_CONTRACT_PHRASES`);
  });
});

describe("grammar: strict-mode fixes (clarify C0)", () => {
  it("drops trailing politeness", () => {
    assert.deepEqual(compileIntentText("swap 1 SOL to USDC please", { accounts }).actions, compileIntentText("swap 1 SOL to USDC", { accounts }).actions);
    assert.equal(normalizeText("Swap 1 SOL to USDC, thanks!"), "Swap 1 SOL to USDC");
    assert.equal(normalizeText("please bridge 5 USDC from base to solana thank you."), "bridge 5 USDC from base to solana");
  });

  it("never hints \"from base to base\" for a bridge without a source", () => {
    const toBase = refused("move 10 USDC to base");
    assert.doesNotMatch(toBase.message, /from base to base/u);
    assert.match(toBase.message, /Say where the funds come from, e\.g\. "from solana to base"/u);
    const evmOnly = refused("move 10 USDC to base", { accounts: [EVM_ACCOUNT as AccountId] });
    assert.doesNotMatch(evmOnly.message, /from base to base/u);
  });

  it("raises MissingSourceError with today's code, message, hints and issues", () => {
    const error = refused("bridge 10 USDC to solana");
    assert.ok(error instanceof MissingSourceError);
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.equal(error.status, 422);
    assert.equal(error.message, 'Say where the funds come from, e.g. "from base to solana". (in "bridge 10 USDC to solana")');
    assert.deepEqual(error.issues, [{ path: "text", message: 'Say where the funds come from, e.g. "from base to solana".' }]);
    assert.deepEqual(error.hints, GRAMMAR_EXAMPLES.slice(0, 20));
    assert.deepEqual(error.missing, { asset: "USDC", amount: "10", toNetwork: "solana" });
    assert.equal(error.toJSON().code, "INTENT_UNSUPPORTED");
  });

  it("reports per action whether the clause named its network", () => {
    assert.deepEqual(compileIntentText("bridge 25 USDC from base to solana then swap it to SOL", { accounts }).explicitNetwork, [true, false]);
    assert.deepEqual(compileIntentText("swap 10 USDC to SOL", { accounts }).explicitNetwork, [false]);
    assert.deepEqual(compileIntentText("deposit 100 USDC into aave on base", { accounts }).explicitNetwork, [true]);
    assert.deepEqual(compileIntentText("send 1 USDC to eip155:10:0x000000000000000000000000000000000000dEaD", { accounts }).explicitNetwork, [true]);
    assert.deepEqual(compileIntentText("bridge 10 USDC to solana", { accounts, defaultNetwork: "base" }).explicitNetwork, [false]);
  });
});

describe("grammar: exports for the clarify layer (clarify C2)", () => {
  it("exports verbs, venue words, fragments and normalisation", () => {
    assert.ok(VERBS.includes("swap") && VERBS.includes("redeem"));
    assert.ok(LENDING_VENUES.some((venue) => venue.protocol === "sparklend"));
    assert.ok(BRIDGE_VENUES.some((venue) => venue.protocol === "across"));
    assert.ok(SWAP_VENUES.some((venue) => venue.protocol === "orca"));
    assert.equal(SENTENCE_FRAGMENTS.LENDING_WORDS, LENDING_WORDS);
    for (const fragment of Object.values(SENTENCE_FRAGMENTS)) assert.doesNotThrow(() => new RegExp(fragment, "iu"));
    assert.equal(typeof normalizeText, "function");
  });
});
