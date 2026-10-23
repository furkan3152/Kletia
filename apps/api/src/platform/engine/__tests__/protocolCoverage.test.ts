/**
 * Coverage gate: every cell of the coverage table plans with the venue the
 * table names, or is refused with a sentence that works (never a bare
 * INTENT_UNSUPPORTED). Offline: one stub adapter per protocol of the
 * capability index, serving exactly the (network, kind, asset) rows the index
 * states, so this gate fails when the grammar, the planner or the registry
 * drift apart. `npm run verify:coverage` runs the same table against a live
 * API (dry runs only).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  applySlippage,
  capabilityIndex,
  CHAINS,
  getProtocol,
  sameCapitalLane,
  type IntentGraph,
  type ProtocolId,
} from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import { configureAdapters } from "../adapters/registry.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "../adapters/types.js";
import { wrapDirection } from "../adapters/wrap.js";
import { assetAmount } from "../assets.js";
import { l2StakeOptions, lendingProtocols, rankedVenueOptions, REGISTRY_STAKE_PROVIDERS, STAKE_PROVIDERS } from "../clarify/catalog.js";
import { installWallet, type Corpus } from "../clarify/corpusHarness.js";
import { decideTurn } from "../clarify/index.js";
import { configureHoldingsReaders } from "../holdings.js";
import { compileIntentText } from "../grammar.js";
import { createIntent } from "../service.js";
import { COVERAGE_CELLS, quotedSentences, type CoverageCell } from "../../../scripts/coverageMatrix.js";
import { ACCOUNTS, EVM_ACCOUNT, resetEngine, SOL_ACCOUNT, stubEvmTransfer, stubSolanaTransfer } from "./helpers.js";

/** Liquid staking tokens a Solana stake pool mints (the stub of each pool serves only its own token). */
const POOL_TOKENS: Readonly<Partial<Record<ProtocolId, string>>> = { jito: "JitoSOL", marinade: "mSOL", sanctum: "JupSOL" };
/** Basis points a stub adds to its output: a direct stake pool mints a little more than the Jupiter route. */
const BONUS_BPS: Readonly<Partial<Record<ProtocolId, bigint>>> = { jito: 100n, marinade: 100n, sanctum: 100n };

function planned(action: AdapterAction, protocol: ProtocolId): PlannedStep {
  const cross = action.network !== action.destinationNetwork;
  const base = action.amount === "0" ? 1_000_000n : BigInt(action.amount);
  const out = ((base * (10_000n + (BONUS_BPS[protocol] ?? 0n))) / 10_000n).toString();
  return {
    protocol,
    title: `stub ${protocol} ${action.kind}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount === "0" ? base.toString() : action.amount),
    expectedOutput: assetAmount(action.output, out),
    minimumOutput: assetAmount(action.output, applySlippage(out, action.slippageBps)),
    feesUsd: 0.1,
    estimatedSeconds: cross ? 30 : 10,
    settlement: cross ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: 20 } : { kind: "same-network" },
    warnings: [],
    transactionCount: 1,
    slippageBps: action.slippageBps,
    floor: "onchain",
  };
}

/** A stub that serves exactly the capability rows of `protocol` (transfers are served by the transfer stubs). */
function stubFromIndex(protocol: ProtocolId): ProtocolAdapter {
  const rows = capabilityIndex().filter((row) => row.protocol === protocol && row.kind !== "transfer");
  const explicitOnly = rows.some((row) => row.explicitOnly) || protocol === "solana-stake";
  return {
    id: protocol,
    protocols: [protocol],
    label: `Stub ${protocol}`,
    ...(explicitOnly ? { explicitOnly: true } : {}),
    supports(route) {
      const mine = rows.filter((row) => row.network === route.network && row.kind === route.kind);
      if (mine.length === 0) return false;
      if (route.kind === "bridge") {
        if (route.network === route.destinationNetwork || !sameCapitalLane(route.network, route.destinationNetwork)) return false;
        if (!(getProtocol(protocol)?.networks ?? []).includes(route.destinationNetwork)) return false;
      } else if (route.network !== route.destinationNetwork) {
        return false;
      }
      if (route.kind === "stake") {
        if ((protocol === "solana-stake") !== route.output.isNative) return false;
        const token = POOL_TOKENS[protocol];
        if (token && route.output.symbol !== token) return false;
      }
      // The wrap venue's index row takes "any asset its adapter accepts": only the gas asset and its wrapped token.
      if (protocol === "wrap") return wrapDirection(route) !== null;
      const symbols = route.kind === "swap" ? [route.input.symbol, route.output.symbol] : [route.input.symbol];
      return symbols.every((symbol) => mine.some((row) => row.asset === null || row.asset.toUpperCase() === symbol.toUpperCase()));
    },
    plan: async (action) => planned(action, protocol),
    prepare: async () => {
      throw new Error("not prepared in the coverage gate");
    },
    verify: async () => {
      throw new Error("not verified in the coverage gate");
    },
  };
}

const INDEXED: readonly ProtocolId[] = [...new Set(capabilityIndex().filter((row) => row.kind !== "transfer").map((row) => row.protocol))];
const ADAPTERS: ProtocolAdapter[] = [...INDEXED.map(stubFromIndex), stubEvmTransfer, stubSolanaTransfer];

async function outcome(cell: CoverageCell): Promise<{ graph?: IntentGraph; error?: { code: string; message: string } }> {
  try {
    return { graph: await createIntent({ text: cell.text, accounts: ACCOUNTS }) };
  } catch (error) {
    if (isPlatformError(error)) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

before(() => {
  resetEngine();
  configureAdapters(ADAPTERS);
});

after(() => {
  configureAdapters(null);
  configureHoldingsReaders(null);
});

describe("coverage gate", () => {
  it("covers every network of the registry", () => {
    const networks = new Set(COVERAGE_CELLS.map((cell) => cell.network));
    for (const network of Object.keys(CHAINS)) assert.ok(networks.has(network as never), network);
  });

  for (const cell of COVERAGE_CELLS) {
    it(`${cell.network} ${cell.kind}: "${cell.text}"`, async () => {
      const result = await outcome(cell);
      if (cell.expect === "plans") {
        assert.ok(result.graph, `${cell.text}: ${result.error?.code} ${result.error?.message}`);
        const protocols = result.graph.steps.map((step) => step.protocol);
        cell.protocols?.forEach((allowed, index) => {
          assert.ok(allowed.includes(protocols[index] as ProtocolId), `${cell.text}: step ${index + 1} ran ${protocols[index]}, expected one of ${allowed.join(", ")}`);
        });
        if (cell.output) assert.equal(result.graph.steps.at(-1)?.minimumOutput?.symbol, cell.output, `${cell.text}: output`);
        if (cell.warning) assert.ok(result.graph.warnings.some((warning) => cell.warning?.test(warning)), `${cell.text}: ${result.graph.warnings.join(" | ")}`);
        return;
      }
      // A guided refusal: never bare; every sentence it offers plans.
      assert.equal(result.error?.code, "INTENT_UNSUPPORTED", `${cell.text}: ${result.error?.message ?? "planned"}`);
      assert.match(result.error?.message ?? "", cell.message as RegExp);
      const offered = quotedSentences(result.error?.message ?? "", cell.text);
      assert.ok(offered.length > 0, `${cell.text}: the refusal offers no sentence`);
      for (const sentence of offered) {
        const follow = await outcome({ ...cell, text: sentence, expect: "plans" });
        assert.ok(follow.graph, `"${sentence}" (offered by "${cell.text}"): ${follow.error?.code} ${follow.error?.message}`);
      }
    });
  }
});

describe("venue choices and staking providers from the registry", () => {
  it("VENUE_MISSING options come from the capability index (registry order kept)", () => {
    assert.deepEqual(lendingProtocols().slice(0, 4), ["aave-v3", "compound-v3", "moonwell", "morpho"]);
    for (const protocol of lendingProtocols()) assert.ok(capabilityIndex(undefined, "deposit").some((row) => row.protocol === protocol), protocol);
  });

  it("ranks venue-less deposit options by tier, at most four", () => {
    const base = rankedVenueOptions("base", "deposit", "USDC").map((venue) => venue.protocol);
    assert.equal(base.length, 4);
    assert.deepEqual(base.slice(0, 3), ["aave-v3", "compound-v3", "spark-savings"]);
    assert.deepEqual(rankedVenueOptions("polygon", "deposit", "ETH").map((venue) => venue.protocol), ["aave-v3", "fluid"]);
    assert.deepEqual(rankedVenueOptions("arbitrum-sepolia", "deposit", "USDC").map((venue) => venue.protocol), ["aave-v3"]);
    assert.deepEqual(rankedVenueOptions("arc", "deposit", "USDC"), []);
  });

  it("every staking word the grammar reads has a provider (never the default by accident)", () => {
    const ids = [...STAKE_PROVIDERS, ...REGISTRY_STAKE_PROVIDERS].map((provider) => provider.id);
    for (const id of ["stader", "mantle-lsp", "frax-ether", "solana-stake"]) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("offers buy-the-LST and bridge-and-stake for ETH staking off Ethereum", () => {
    assert.deepEqual(l2StakeOptions("base").map((option) => option.id), ["buy:wstETH", "buy:cbETH", "bridge-stake"]);
    assert.deepEqual(l2StakeOptions("arbitrum").map((option) => option.id), ["buy:wstETH", "bridge-stake"]);
    // Polygon's ether is WETH: no native ETH to bridge and stake, the LST is bought with WETH.
    assert.deepEqual(l2StakeOptions("polygon").map((option) => [option.id, option.actions[0]?.from]), [["buy:wstETH", "WETH"]]);
    assert.deepEqual(l2StakeOptions("ethereum"), []);
    assert.deepEqual(l2StakeOptions("arbitrum-sepolia"), []);
    for (const option of l2StakeOptions("base")) assert.ok(!/stake/iu.test(option.label) || option.id === "bridge-stake", option.label);
  });
});

describe("clarify turns for the new cells", () => {
  const RICH: Corpus = {
    spec: "kletia.clarify-corpus/v1",
    fixtures: {
      wallets: {
        rich: {
          accounts: [EVM_ACCOUNT, SOL_ACCOUNT],
          balances: Object.fromEntries(Object.keys(CHAINS).map((network) => [network, { [CHAINS[network as keyof typeof CHAINS].nativeAsset.symbol]: "1000", USDC: "100000", USDT: "100000", USDT0: "100000", WETH: "10" }])),
          positions: null,
        },
      },
      names: {},
      contracts: [],
    },
    cases: [],
  };

  const turn = async (text: string) => {
    installWallet(RICH, "rich");
    return decideTurn(null, { text }, { accounts: [EVM_ACCOUNT, SOL_ACCOUNT], contracts: [] });
  };

  it("a venue-less deposit asks VENUE_MISSING with the index venues", async () => {
    const decision = await turn("deposit 100 USDC on polygon");
    assert.equal(decision.status, "needs_input");
    assert.equal(decision.questions[0]?.reason, "VENUE_MISSING");
    assert.deepEqual(decision.questions[0]?.options.map((option) => option.id), ["aave-v3", "compound-v3", "morpho", "fluid"].filter((id) => capabilityIndex("polygon", "deposit", "USDC").some((row) => row.protocol === id && row.asset === "USDC")));
  });

  for (const [text, provider, to] of [
    ["stake 1 ETH with stader", "stader", "ETHx"],
    ["stake 1 ETH with mantle", "mantle-lsp", "mETH"],
    ["stake 1 ETH with frax", "frax-ether", "sfrxETH"],
    ["stake 2 SOL with native stake", "solana-stake", "SOL"],
  ] as const) {
    it(`"${text}" keeps the named provider (${provider})`, async () => {
      const decision = await turn(text);
      assert.equal(decision.status, "ready", JSON.stringify(decision.questions));
      assert.equal(decision.actions?.[0]?.provider, provider);
      assert.equal(decision.actions?.[0]?.to ?? decision.actions?.[0]?.from, to);
    });
  }
});

describe("grammar hooks", () => {
  const SOL_DEVNET = `solana:${CHAINS["solana-devnet"].reference}:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`;
  const refusal = (text: string) => {
    try {
      compileIntentText(text, { accounts: ACCOUNTS as never });
    } catch (error) {
      return error as Error & { code?: string };
    }
    throw new Error(`"${text}" compiled`);
  };

  it("borrow and repay say what Kletia can do instead", () => {
    assert.match(refusal("borrow 100 USDC on base").message, /^Borrowing is not available yet .*deposit as collateral/u);
    assert.match(refusal("repay 100 USDC on base").message, /^Repaying a loan is not available yet/u);
  });

  it("a venue-less deposit names the venues of the index and a sentence that works", () => {
    const message = refusal("deposit 100 USDT on arbitrum").message;
    assert.match(message, /names no venue\. USDT deposits on Arbitrum One run on Aave V3, Compound V3; say which one, e\.g\. "deposit 100 USDT into aave on arbitrum"\./u);
    assert.match(refusal("deposit 1 ETH on polygon").message, /run on Aave V3, Fluid Lending/u);
    assert.match(refusal("deposit 1 USDC on arc").message, /no lending venue takes USDC on Arc Testnet/u);
  });

  it("native staking: words, a named validator, Solana Devnet by lane, never on EVM", () => {
    const vote = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";
    const [named] = compileIntentText(`stake 2 SOL with validator ${vote}`, { accounts: ACCOUNTS as never }).actions;
    assert.deepEqual([named?.protocol, named?.to, named?.params?.provider], ["solana-stake", "SOL", vote]);
    const [devnet] = compileIntentText("stake 1 SOL", { accounts: [SOL_DEVNET] as never }).actions;
    assert.deepEqual([devnet?.network, devnet?.protocol], ["solana-devnet", "solana-stake"]);
    const [mainnet] = compileIntentText("stake 1 SOL", { accounts: ACCOUNTS as never }).actions;
    assert.deepEqual([mainnet?.network, mainnet?.protocol, mainnet?.to], ["solana", undefined, "JitoSOL"]);
    assert.match(refusal("stake 1 SOL natively on base").message, /Native staking stakes SOL on Solana or Solana Devnet/u);
  });

  it("ETH on Polygon PoS is WETH with a note; never on a network whose gas is ether", () => {
    const polygon = compileIntentText("swap 0.1 ETH to USDC on polygon", { accounts: ACCOUNTS as never });
    assert.equal(polygon.actions[0]?.from, "WETH");
    assert.match(polygon.warnings[0] ?? "", /"ETH" was read as WETH/u);
    const base = compileIntentText("swap 0.1 ETH to USDC on base", { accounts: ACCOUNTS as never });
    assert.equal(base.actions[0]?.from, "ETH");
    assert.deepEqual(base.warnings, []);
  });
});
