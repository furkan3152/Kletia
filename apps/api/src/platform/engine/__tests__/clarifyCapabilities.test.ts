/**
 * Clarify takes its capabilities from the engine (grammar, registry,
 * YIELD_VENUES, the staking tables): every kind and network it can offer
 * must plan. Each sentence below goes through the whole turn
 * (clarifyTurn: facts, policy, canonical sentence, createIntentDetailed)
 * against stub adapters, one per protocol, on a wallet funded everywhere.
 * Also: departure pass-through and the structured fallback.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  applySlippage,
  ASSETS,
  CHAINS,
  YIELD_VENUES,
  type IntentActionKind,
  type IntentTurnResponse,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { configureAdapters } from "../adapters/registry.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "../adapters/types.js";
import { assetAmount } from "../assets.js";
import { BRIDGE_NETWORKS, OFFERED_KINDS, protocolWord, STAKE_PROVIDERS, SWAP_NETWORKS, TESTNET_BRIDGE_NETWORKS, VAULT_PROTOCOLS } from "../clarify/catalog.js";
import { installWallet, type Corpus } from "../clarify/corpusHarness.js";
import { clarifyTurn } from "../clarify/index.js";
import { LENDING_VENUES } from "../grammar.js";
import { configureHoldingsReaders } from "../holdings.js";
import { EVM_ACCOUNT, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, resetEngine, SOL_ACCOUNT } from "./helpers.js";

function planned(action: AdapterAction, protocol: ProtocolId): PlannedStep {
  const cross = action.network !== action.destinationNetwork;
  const out = action.amount === "0" ? "1000000" : action.amount;
  return {
    protocol,
    title: `stub ${protocol} ${action.kind}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount === "0" ? out : action.amount),
    expectedOutput: assetAmount(action.output, out),
    minimumOutput: assetAmount(action.output, applySlippage(out, action.slippageBps)),
    feesUsd: 0.1,
    estimatedSeconds: cross ? 30 : 10,
    settlement: cross ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: 20 } : { kind: "same-network" },
    warnings: [],
    transactionCount: 1,
    slippageBps: action.slippageBps,
  };
}

/** A stub that plans every route of `kinds` under its protocol id (never prepared in this test). */
function stubFor(id: ProtocolId, kinds: readonly IntentActionKind[], extra: Partial<ProtocolAdapter> = {}): ProtocolAdapter {
  return {
    id,
    protocols: [id],
    label: `Stub ${id}`,
    supports: (route) => kinds.includes(route.kind),
    plan: async (action) => planned(action, id),
    prepare: async () => {
      throw new Error("not prepared in capability tests");
    },
    verify: async () => {
      throw new Error("not verified in capability tests");
    },
    ...extra,
  };
}

const LENDING = [...new Set(YIELD_VENUES.filter((venue) => venue.actions.length > 0).map((venue) => venue.protocol))];
const ADAPTERS: ProtocolAdapter[] = [
  stubFor("jupiter", ["swap", "stake"], { supports: (route) => route.network === "solana" && (route.kind === "swap" || route.kind === "stake") }),
  stubFor("spl-token", ["transfer"], { protocols: ["spl-token", "system-transfer"], supports: (route) => route.kind === "transfer" && CHAINS[route.network].vm === "svm" }),
  stubFor("erc20-transfer", ["transfer"], { protocols: ["erc20-transfer", "system-transfer"], supports: (route) => route.kind === "transfer" && CHAINS[route.network].vm === "evm" }),
  stubFor("relay", ["swap", "bridge"], { supports: (route) => route.kind === "bridge" || (route.kind === "swap" && route.network !== "solana") }),
  ...LENDING.map((id) => stubFor(id, ["deposit", "withdraw"])),
  ...["lido", "rocket-pool", "etherfi"].map((id) => stubFor(id as ProtocolId, ["stake"], { supports: (route) => route.kind === "stake" && route.network === "ethereum" })),
  stubFor("solana-stake", ["stake"], { supports: (route) => route.kind === "stake" && (route.network === "solana" || route.network === "solana-devnet") }),
];

/** A wallet that holds plenty of every listed asset on every network. */
const RICH: Corpus = {
  spec: "kletia.clarify-corpus/v1",
  fixtures: {
    wallets: {
      rich: {
        accounts: [EVM_ACCOUNT, SOL_ACCOUNT],
        balances: Object.fromEntries((Object.keys(CHAINS) as NetworkKey[]).map((network) => [
          network,
          Object.fromEntries([CHAINS[network].nativeAsset.symbol, ...ASSETS.filter((asset) => asset.network === network).map((asset) => asset.symbol)].map((symbol) => [symbol, "100000"])),
        ])),
        positions: null,
      },
    },
    names: {},
    contracts: [],
  },
  cases: [],
};

const ACCOUNTS = [EVM_ACCOUNT, SOL_ACCOUNT] as const;

/** Testnet capital: the same addresses on Arbitrum Sepolia and Solana Devnet (accounts re-home within their lane). */
const TESTNET_ACCOUNTS = [`eip155:421614:${EVM_ACCOUNT.split(":")[2]}`, `solana:${CHAINS["solana-devnet"].reference}:${SOL_ACCOUNT.split(":")[2]}`] as const;

async function plan(text: string, extra: Record<string, unknown> = {}, accounts: readonly string[] = ACCOUNTS): Promise<IntentTurnResponse> {
  installWallet(RICH, "rich");
  return clarifyTurn({ text, accounts: [...accounts], ...extra } as never, { dryRun: true, thread: null });
}

async function assertPlans(text: string, accounts: readonly string[] = ACCOUNTS): Promise<IntentTurnResponse> {
  const response = await plan(text, {}, accounts);
  assert.equal(response.status, "planned", `${text}: ${response.status === "needs_input" ? JSON.stringify(response.questions.map((q) => q.reason)) : ""}`);
  return response;
}

before(() => {
  resetEngine();
  configureAdapters(ADAPTERS);
});

after(() => {
  configureAdapters(null);
  configureHoldingsReaders(null);
});

describe("clarify capabilities: every offered kind and network plans", () => {
  it("offers the six step kinds of the grammar", () => {
    assert.deepEqual([...OFFERED_KINDS], ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"]);
  });

  it("swaps on every swap network of each lane", async () => {
    for (const network of SWAP_NETWORKS) {
      const testnet = CHAINS[network].environment === "testnet";
      const native = CHAINS[network].nativeAsset.symbol;
      await assertPlans(`swap 10 USDC to ${native} on ${network}`, testnet ? TESTNET_ACCOUNTS : ACCOUNTS);
    }
    assert.ok(SWAP_NETWORKS.includes("arbitrum-sepolia"), "testnet swaps (Uniswap V3 on Arbitrum Sepolia)");
  });

  it("bridges USDC between every pair of bridge networks of the same lane, CCTP testnets included", async () => {
    assert.ok(BRIDGE_NETWORKS.length >= 6, BRIDGE_NETWORKS.join(","));
    for (const from of BRIDGE_NETWORKS) {
      for (const to of BRIDGE_NETWORKS) if (from !== to) await assertPlans(`bridge 10 USDC from ${from} to ${to}`);
    }
    assert.deepEqual([...TESTNET_BRIDGE_NETWORKS], ["arc", "arbitrum-sepolia", "solana-devnet"]);
    for (const from of TESTNET_BRIDGE_NETWORKS) {
      for (const to of TESTNET_BRIDGE_NETWORKS) if (from !== to) await assertPlans(`bridge 10 USDC from ${from} to ${to}`, TESTNET_ACCOUNTS);
    }
  });

  it("stakes testnet SOL natively on Solana Devnet by default, and reads 'natively' without 'with'", async () => {
    for (const text of ["stake 2 SOL", "stake 2 SOL natively"]) {
      const response = await assertPlans(text, TESTNET_ACCOUNTS);
      if (response.status !== "planned") continue;
      assert.deepEqual(response.intent.steps.map((step) => [step.kind, step.network]), [["stake", "solana-devnet"]], text);
    }
    const mainnet = await assertPlans("stake 2 SOL natively");
    if (mainnet.status === "planned") assert.deepEqual(mainnet.intent.steps.map((step) => step.network), ["solana"]);
  });

  it("sends the native asset on every network", async () => {
    for (const network of Object.keys(CHAINS) as NetworkKey[]) {
      const recipient = CHAINS[network].vm === "evm" ? OTHER_EVM_ADDRESS : OTHER_SOL_ADDRESS;
      await assertPlans(`send 1 ${CHAINS[network].nativeAsset.symbol} to ${recipient} on ${network}`);
    }
  });

  it("stakes with every provider", async () => {
    for (const provider of STAKE_PROVIDERS) await assertPlans(`stake 1 ${provider.input} with ${provider.word}`);
  });

  it("deposits into and withdraws from every executable venue", async () => {
    // Round 9 venues (Sky, Ethena, Save) wait for their grammar words (reader hook, wired by the integrator).
    for (const venue of YIELD_VENUES.filter((entry) => !READER_PENDING.includes(entry.protocol) && LENDING_VENUES.some((word) => word.protocol === entry.protocol))) {
      const vault = VAULT_PROTOCOLS.includes(venue.protocol) ? ` ${venue.slug}` : "";
      for (const kind of venue.actions) {
        const text = kind === "deposit"
          ? `deposit 10 ${venue.asset} into ${protocolWord(venue.protocol)}${vault} on ${venue.network}`
          : `withdraw 10 ${venue.asset} from ${protocolWord(venue.protocol)}${vault} on ${venue.network}`;
        await assertPlans(text);
      }
    }
  });
});

/** Lending protocols whose venue words the sentence reader does not know yet (round 9 reader hooks). */
const READER_PENDING: readonly string[] = ["sky", "ethena"];

describe("clarify planning", () => {
  it("plans the canonical sentence as grammar text with the thread and assumptions in the interpretation", async () => {
    const response = await plan("swap 10 USDC to ETH");
    assert.equal(response.status, "planned");
    if (response.status !== "planned") return;
    assert.equal(response.intent.interpretation.source, "grammar");
    assert.equal(response.intent.request.text, response.sentence);
    assert.equal(response.intent.interpretation.thread?.id, response.thread.id);
    assert.ok((response.intent.interpretation.assumptions ?? []).some((entry) => entry.field === "actions[0].network"));
    assert.ok(response.intent.request.clientReference?.startsWith(`thread:${response.thread.id}:r1`));
  });

  it("applies the departure itself: interpretation.departure is passed and sourceNetwork is never forwarded", async () => {
    const response = await plan("deposit 10 USDC into kamino", { sourceNetwork: "base" });
    assert.equal(response.status, "planned");
    if (response.status !== "planned") return;
    assert.equal(response.intent.request.sourceNetwork, undefined);
    assert.equal(response.intent.interpretation.departure?.network, "base");
    assert.equal(response.intent.interpretation.departure?.bridged, true);
    assert.match(response.sentence, /^bridge 10 USDC from base to solana, then deposit it into kamino on solana$/u);
    assert.deepEqual(response.intent.steps.map((step) => step.kind), ["bridge", "deposit"]);
  });

  it("plans a payment to a recipient elsewhere as structured actions with the closest sentence as the text", async () => {
    // A payment that crosses networks asks who bears the bridge fees first (DELIVERY_AMOUNT).
    const asked = await plan(`send 5 USDC to ${OTHER_SOL_ADDRESS}`, { sourceNetwork: "base" });
    assert.equal(asked.status, "needs_input");
    if (asked.status !== "needs_input") return;
    const delivery = asked.questions[0];
    assert.equal(delivery?.reason, "DELIVERY_AMOUNT");
    const response = await plan("", { text: undefined, answer: { question: delivery?.id, option: "send" }, thread: asked.thread, sourceNetwork: "base" });
    assert.equal(response.status, "planned");
    if (response.status !== "planned") return;
    assert.equal(response.intent.interpretation.source, "structured");
    assert.equal(response.intent.request.sourceNetwork, undefined);
    assert.ok(response.intent.request.text?.includes(OTHER_SOL_ADDRESS));
    assert.equal(response.intent.steps.length, 1);
    assert.equal(response.intent.steps[0]?.kind, "bridge");
  });

  it("returns needs_input with option sentences a stateless agent can send as text", async () => {
    const response = await plan("swap SOL to USDC");
    assert.equal(response.status, "needs_input");
    if (response.status !== "needs_input") return;
    const all = response.questions[0]?.options.find((option) => option.id === "all");
    assert.ok(all?.sentence, "the All option carries its sentence");
    const followed = await plan(all.sentence as string);
    assert.equal(followed.status, "planned");
  });
});
