/**
 * Protocol spine in the planner, with stub venues (the real adapters
 * have their own suites): named Solana DEX venues (explicitOnly, routed
 * through Jupiter), a named destination swap stays its own step, the
 * same-network swap auction and its on-chain floor tie-break, EVM staking on
 * Ethereum, dynamic refusal texts, bare "spark", transfer-only assets and
 * EIP-55 recipient checksums.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateIntentGraph, type AccountId, type ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { compileIntentText } from "../grammar.js";
import { planIntent } from "../planner.js";
import { ACCOUNTS, EVM_ADDRESS, resetEngine, STUB_ADAPTERS, stubJupiter } from "./helpers.js";
import { LENDING_STUBS, resetSwapStubs, stubLending, stubSameNetwork, swapCalls, swapScripts } from "./venueStubs.js";

const ETH_ACCOUNTS = [`eip155:1:${EVM_ADDRESS}`, ...ACCOUNTS];

/** A named Solana DEX venue: served only when named (explicitOnly), routed through Jupiter (registry routedVia). */
function directDex(id: "raydium" | "orca" | "meteora"): ProtocolAdapter {
  return {
    ...stubJupiter,
    id,
    protocols: [id],
    label: id,
    explicitOnly: true,
    supports: (route) => route.kind === "swap" && stubJupiter.supports(route),
    plan: async (action) => {
      dexCalls.push(id);
      return { ...await stubJupiter.plan(action), protocol: id };
    },
  };
}

const dexCalls: ProtocolId[] = [];
const uniswap = stubSameNetwork("uniswap-v3", { networks: ["base", "arbitrum", "ethereum", "optimism", "polygon"] });
const aerodrome = stubSameNetwork("aerodrome", { networks: ["base"] });
const lido = stubSameNetwork("lido", { kind: "stake", networks: ["ethereum"], outputs: ["wstETH"] });

function useAdapters(extra: readonly ProtocolAdapter[] = []): void {
  configureAdapters([...STUB_ADAPTERS, directDex("raydium"), directDex("orca"), directDex("meteora"), ...extra]);
}

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

beforeEach(() => {
  resetEngine();
  resetSwapStubs();
  dexCalls.length = 0;
  useAdapters();
});
afterEach(() => resetEngine());

describe("named venues in the grammar bind to the route", () => {
  const phrases: readonly [string, ProtocolId, string][] = [
    ["swap 1 SOL to USDC via raydium", "raydium", "solana"],
    ["swap 1 SOL to USDC on solana using orca", "orca", "solana"],
    ["swap 1 SOL to USDC through raydium on solana", "raydium", "solana"],
    ["buy SOL with 10 USDC with orca on solana", "orca", "solana"],
    ["swap 1 SOL to USDC via meteora", "meteora", "solana"],
    ["deposit 10 USDC into spark", "spark-savings", "base"],
    ["withdraw all WETH from spark lend on ethereum", "sparklend", "ethereum"],
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
});

describe("named Solana DEX venues (explicitOnly, routedVia jupiter)", () => {
  it("plans a named DEX and never calls one for a plain swap", async () => {
    const named = await planIntent({ text: "swap 1 SOL to USDC via orca", accounts: ACCOUNTS });
    assert.equal(named.steps[0]?.protocol, "orca");
    dexCalls.length = 0;
    const plain = await planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
    assert.equal(plain.steps[0]?.protocol, "jupiter");
    assert.deepEqual(dexCalls, [], "explicitOnly venues are not quoted unless named or preferred");
  });

  it("refuses an unnamed swap when Jupiter is avoided, and names the dependency for a named DEX", async () => {
    const unnamed = await planError({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, constraints: { avoidProtocols: ["jupiter"] } });
    assert.equal(unnamed.code, "INTENT_UNSUPPORTED");
    assert.deepEqual(dexCalls, []);
    for (const venue of ["raydium", "orca", "meteora"] as const) {
      const named = await planError({ text: `swap 1 SOL to USDC via ${venue}`, accounts: ACCOUNTS, constraints: { avoidProtocols: ["jupiter"] } });
      assert.equal(named.code, "INTENT_UNSUPPORTED");
      assert.match(named.message, /swaps run through the Jupiter program, which constraints\.avoidProtocols excludes/u, venue);
    }
    const structured = await planError({
      actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1", protocol: "raydium" }],
      accounts: ACCOUNTS,
      constraints: { avoidProtocols: ["jupiter"] },
    });
    assert.match(structured.message, /^Raydium swaps run through the Jupiter program/u);
  });

  it("never substitutes Jupiter when the named DEX itself is avoided", async () => {
    const error = await planError({ text: "swap 1 SOL to USDC via orca", accounts: ACCOUNTS, constraints: { avoidProtocols: ["orca"] } });
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /Orca is named here but constraints\.avoidProtocols excludes it/u);
  });
});

describe("a named destination swap stays its own step", () => {
  it("keeps bridge + 'via orca' as Relay then Orca", async () => {
    const graph = await planIntent({ text: "bridge 25 USDC from base to solana then swap it to SOL via orca", accounts: ACCOUNTS });
    assert.deepEqual(graph.steps.map((step) => [step.kind, step.protocol, step.status]), [["bridge", "relay", "ready"], ["swap", "orca", "pending"]]);
    assert.deepEqual(graph.steps[1]?.dependsOn, ["s1"]);
    assert.deepEqual(validateIntentGraph(graph), []);
  });

  it("keeps a structured bridge + {swap, protocol: jupiter} as two steps", async () => {
    const graph = await planIntent({
      actions: [
        { kind: "bridge", network: "base", from: "USDC", to: "USDC", amount: "25", toNetwork: "solana" },
        { kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max", protocol: "jupiter" },
      ],
      accounts: ACCOUNTS,
    });
    assert.deepEqual(graph.steps.map((step) => step.protocol), ["relay", "jupiter"]);
    assert.equal(graph.interpretation.optimizations, undefined);
  });

  it("respects a preferred local DEX when considering the bridge + swap merge", async () => {
    const graph = await planIntent({ text: "bridge 25 USDC from base to solana then swap it to SOL", accounts: ACCOUNTS, constraints: { preferProtocols: ["raydium"] } });
    assert.equal(graph.steps.length, 2);
    assert.equal(graph.steps[1]?.protocol, "raydium");
  });

  it("still merges an unnamed swap into one cross-network swap", async () => {
    const graph = await planIntent({ text: "bridge 25 USDC from base to solana then swap it to SOL", accounts: ACCOUNTS });
    assert.equal(graph.steps.length, 1);
    assert.equal(graph.steps[0]?.minimumOutput?.symbol, "SOL");
  });

  it("preserves a complex route's named venues, partial amounts and dependency order", async () => {
    const valid = await planIntent({
      text: "bridge 50 USDC from base to solana then swap half to SOL via raydium then swap half to USDC using orca then bridge it to base then deposit it into aave",
      accounts: ACCOUNTS,
    });
    assert.deepEqual(valid.steps.map((step) => step.protocol), ["relay", "raydium", "orca", "relay", "aave-v3"]);
    assert.deepEqual(valid.steps.map((step) => step.dependsOn), [[], ["s1"], ["s2"], ["s3"], ["s4"]]);
    assert.deepEqual(validateIntentGraph(valid), []);
  });
});

describe("same-network swap auction", () => {
  beforeEach(() => useAdapters([uniswap, aerodrome]));

  it("ranks several same-network venues by guaranteed output and keeps the loser as quote evidence", async () => {
    swapScripts["uniswap-v3"] = { minimumBps: 9_950, floor: "onchain" };
    swapScripts.aerodrome = { minimumBps: 9_900, floor: "onchain" };
    const graph = await planIntent({ text: "swap 100 USDC to ETH on base", accounts: ACCOUNTS });
    const [step] = graph.steps;
    assert.ok(step);
    assert.ok(["uniswap-v3", "aerodrome", "relay"].includes(step.protocol));
    // Relay's stub quotes the full price minus slippage (9,950 bps): uniswap ties it on output, wins on time.
    assert.notEqual(step.protocol, "aerodrome");
    assert.ok(step.evidence.some((entry) => /Also quoted: Aerodrome/u.test(entry.detail ?? "")), "the losing quote is recorded");
    assert.ok(swapCalls.length >= 2, "every candidate quoted");
  });

  it("breaks an exact tie with the on-chain floor before the preference order", async () => {
    // Only the two DEX stubs, identical quotes, the claimed one listed first.
    configureAdapters([...STUB_ADAPTERS.filter((adapter) => adapter.id !== "relay"), stubSameNetwork("aerodrome", { networks: ["base"] }), stubSameNetwork("uniswap-v3", { networks: ["base"] })]);
    swapScripts.aerodrome = { minimumBps: 9_900, floor: "claimed", seconds: 15 };
    swapScripts["uniswap-v3"] = { minimumBps: 9_900, floor: "onchain", seconds: 15 };
    const graph = await planIntent({ text: "swap 100 USDC to ETH on base", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "uniswap-v3");
    swapScripts.aerodrome = { minimumBps: 9_901, floor: "claimed", seconds: 15 };
    const better = await planIntent({ text: "swap 100 USDC to ETH on base", accounts: ACCOUNTS });
    assert.equal(better.steps[0]?.protocol, "aerodrome", "a larger guaranteed output still wins");
  });

  it("falls back to the venue that quotes when another fails", async () => {
    swapScripts["uniswap-v3"] = { minimumBps: 9_990, fail: "VENUE_ILLIQUID" };
    const graph = await planIntent({ text: "swap 100 USDC to ETH on base", accounts: ACCOUNTS });
    assert.notEqual(graph.steps[0]?.protocol, "uniswap-v3");
    assert.ok(graph.steps[0]?.evidence.some((entry) => /Uniswap V3 could not quote \(VENUE_ILLIQUID\)/u.test(entry.detail ?? "")));
  });

  it("lists the live swap networks from the adapters when a swap has no venue", async () => {
    resetEngine();
    const error = await planError({ text: "swap 100 USDC to ETH on ethereum", accounts: ETH_ACCOUNTS });
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /^Swaps run on Base or Arbitrum One \(Relay\) and Solana \(Jupiter\); USDC → ETH on Ethereum is not available for the requested protocol and constraints\.$/u);
    useAdapters([uniswap]);
    const live = await planIntent({ text: "swap 100 USDC to ETH on ethereum", accounts: ETH_ACCOUNTS });
    assert.equal(live.steps[0]?.protocol, "uniswap-v3");
  });
});

describe("EVM liquid staking", () => {
  it("routes stake on Ethereum to the Lido venue with wstETH as the output", async () => {
    useAdapters([lido]);
    const graph = await planIntent({ text: "stake 1 ETH with lido", accounts: ETH_ACCOUNTS });
    assert.deepEqual(graph.steps.map((step) => `${step.kind}/${step.protocol}@${step.network}`), ["stake/lido@ethereum"]);
    assert.equal(graph.steps[0]?.minimumOutput?.symbol, "wstETH");
    const structured = await planIntent({ actions: [{ kind: "stake", network: "ethereum", from: "ETH", to: "wstETH", amount: "1" }], accounts: ETH_ACCOUNTS });
    assert.equal(structured.steps[0]?.protocol, "lido", "the protocol follows from the token");
  });

  it("refuses staking where no venue runs, naming the live networks", async () => {
    const base = await planError({ actions: [{ kind: "stake", network: "base", from: "ETH", amount: "1" }], accounts: ACCOUNTS });
    assert.match(base.message, /^Liquid staking runs on Solana mainnet \(SOL → JitoSOL, mSOL or JupSOL\), not Base\.$/u);
    useAdapters([lido]);
    const withLido = await planError({ actions: [{ kind: "stake", network: "base", from: "ETH", amount: "1" }], accounts: ACCOUNTS });
    assert.match(withLido.message, /and Ethereum \(ETH → wstETH\), not Base\./u);
    const unlisted = await planError({ text: "stake 1 ETH with rocket pool", accounts: ETH_ACCOUNTS });
    assert.match(unlisted.message, /does not execute Rocket Pool routes/u);
  });

  it("refuses mismatched staking protocols and tokens", async () => {
    const solanaLido = await planError({ actions: [{ kind: "stake", network: "solana", from: "SOL", amount: "1", protocol: "lido" }], accounts: ACCOUNTS });
    assert.match(solanaLido.message, /Lido stakes ETH on Ethereum/u);
    const mismatch = await planError({ actions: [{ kind: "stake", network: "ethereum", from: "ETH", to: "rETH", amount: "1", protocol: "lido" }], accounts: ETH_ACCOUNTS });
    assert.match(mismatch.message, /Lido mints wstETH, not rETH/u);
  });
});

describe("lending additions and bare spark", () => {
  beforeEach(() => {
    configureAdapters([...STUB_ADAPTERS, ...LENDING_STUBS, stubLending("spark-savings"), stubLending("sparklend")]);
  });

  it("plans bare spark as Spark Savings with a warning that names SparkLend", async () => {
    const graph = await planIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ETH_ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "spark-savings");
    assert.equal(graph.steps[0]?.venue, "ethereum:spark-savings:usdc", "sUSDC is Ethereum's default USDC savings venue");
    assert.ok(graph.warnings.some((warning) => /Spark Savings/u.test(warning) && /SparkLend/u.test(warning)));
    const sparklend = await planIntent({ text: "deposit 100 USDC into sparklend on ethereum", accounts: ETH_ACCOUNTS });
    assert.equal(sparklend.steps[0]?.protocol, "sparklend");
    assert.ok(!sparklend.warnings.some((warning) => /Spark Savings/u.test(warning)));
  });

  it("keeps the unnamed deposit defaults (new protocols are appended)", async () => {
    const graph = await planIntent({ text: "deposit 100 USDC into aave on base", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "aave-v3");
    const unnamed = await planIntent({ actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "10" }], accounts: ACCOUNTS });
    assert.equal(unnamed.steps[0]?.protocol, "aave-v3");
  });
});

describe("strict-mode safety (USDbC)", () => {
  it("refuses a transfer-only asset in a swap, a deposit or a bridge, naming USDC", async () => {
    for (const text of ["swap 10 USDbC to USDC on base", "deposit 10 USDbC into aave on base", "bridge 10 USDbC from base to arbitrum as USDC"]) {
      const error = await planError({ text, accounts: ACCOUNTS });
      assert.equal(error.code, "ROUTE_UNSUPPORTED", text);
      assert.equal(error.status, 422);
      assert.match(error.message, /USDbC can only be sent.*Use USDC instead\./u, text);
    }
    const sent = await planIntent({ text: "send 10 USDbC to 0x000000000000000000000000000000000000dEaD on base", accounts: ACCOUNTS });
    assert.equal(sent.steps[0]?.kind, "transfer");
  });

  it("refuses a recipient whose mixed-case address fails EIP-55 (RECIPIENT_CHECKSUM_INVALID)", async () => {
    // 0x4f18…807D with one letter's case flipped.
    const broken = "0x4F183e308f24c81c05303821AD025812fBFd807D";
    const error = await planError({ text: `send 1 USDC to ${broken} on arbitrum`, accounts: ACCOUNTS });
    assert.equal(error.code, "RECIPIENT_CHECKSUM_INVALID");
    assert.equal(error.status, 422);
    const lower = await planIntent({ text: "send 1 USDC to 0x000000000000000000000000000000000000dead on arbitrum", accounts: ACCOUNTS });
    assert.equal(lower.steps[0]?.kind, "transfer", "an all-lower-case address carries no checksum and is accepted");
  });
});
