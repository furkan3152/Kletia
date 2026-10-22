/**
 * Clarify answers for sentences the live audit flagged: a vague action asks
 * what it acts on instead of refusing; nonsense is refused cleanly with
 * example sentences; borrow and repay say "not available yet" in every path;
 * a token listed only on the other lane is "not available" there (never read
 * as a near symbol); a small native stake states the minimum and offers the
 * liquid route; an amount question offers the balance the turn's snapshot
 * already read.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { NetworkKey } from "@kletia/core";
import { belowNativeMinimum } from "../adapters/solanaNativeStake.js";
import { contextFor, installWallet, loadCorpus, runTurn, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { TurnFacts } from "../clarify/facts.js";
import { decideTurn } from "../clarify/index.js";
import { planIntent } from "../planner.js";
import type { Snapshot } from "../solver/snapshot.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const ctx = contextFor(corpus, { id: "t", category: "test", title: "t", wallet: "full", turns: [] } as unknown as CorpusCase);

after(() => uninstallWallet());

async function turn(text: string) {
  installWallet(corpus, "full");
  return runTurn(null, { text }, ctx);
}

async function refusalOf(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isPlatformError(error), String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

describe("vague sentences ask, nonsense is refused cleanly", () => {
  for (const [text, reason, prompt] of [
    ["swap some tokens", "INPUT_ASSET_MISSING", "What should Kletia swap?"],
    ["swap", "INPUT_ASSET_MISSING", "What should Kletia swap?"],
    ["sell some crypto", "INPUT_ASSET_MISSING", "What should Kletia sell?"],
    ["buy something", "OUTPUT_ASSET_MISSING", "What should Kletia buy?"],
    ["get me some tokens", "OUTPUT_ASSET_MISSING", "What should Kletia buy?"],
    ["stake something", "INPUT_ASSET_MISSING", "What should Kletia stake?"],
    ["bridge some tokens", "DESTINATION_MISSING", undefined],
  ] as const) {
    it(`"${text}" asks ${reason}`, async () => {
      const run = await turn(text);
      assert.ok(run.decision, `${run.error?.code}: ${run.error?.message}`);
      assert.equal(run.decision.status, "needs_input");
      const question = run.decision.questions[0];
      assert.equal(question?.reason, reason);
      if (prompt) assert.equal(question?.prompt, prompt);
      assert.ok((question?.options.length ?? 0) > 0, "the question offers choices");
    });
  }

  it("refuses nonsense and questions with INTENT_UNSUPPORTED and example sentences", async () => {
    for (const text of ["asdfgh", "what is the weather in istanbul", "buy me a lambo", "buy a bored ape"]) {
      const run = await turn(text);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED", text);
      assert.doesNotMatch(run.error?.message ?? "", /does not match a supported/u, text);
    }
    installWallet(corpus, "full");
    const error = await refusalOf(decideTurn(null, { text: "asdfgh" }, ctx));
    assert.ok((error.hints?.length ?? 0) >= 3, "example sentences are attached");
    assert.match(error.message, /It can swap, buy, bridge, send, stake, deposit and withdraw tokens\./u);
  });
});

describe("read-only rate questions", () => {
  it("point to the keyless venues read instead of failing as an action", async () => {
    for (const [text, query] of [
      ["compare yield", {}],
      ["show live Aave rates", { protocol: "aave-v3" }],
      ["what are the usdc rates on base?", { network: "base" }],
    ] as const) {
      installWallet(corpus, "full");
      const error = await refusalOf(decideTurn(null, { text }, ctx));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
      assert.deepEqual(error.details, { readOnly: "venues", path: "/v1/venues", query }, text);
      assert.match(error.message, /Live lending rates need no wallet: GET \/v1\/venues/u, text);
    }
    // The strict grammar (no clarify) says the same.
    const strict = await refusalOf(planIntent({ text: "show live Aave rates", accounts: ["eip155:8453:0x2222222222222222222222222222222222222222"] }));
    assert.deepEqual(strict.details, { readOnly: "venues", path: "/v1/venues", query: { protocol: "aave-v3" } });
  });

  it("leaves other questions as plain refusals", async () => {
    installWallet(corpus, "full");
    const error = await refusalOf(decideTurn(null, { text: "what's the price of ETH" }, ctx));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.equal(error.details, undefined);
  });
});

describe("borrow and repay", () => {
  it("say 'not available yet' in the clarify path", async () => {
    for (const [text, expected] of [["borrow 100 USDC on base", /^Borrowing is not available yet/u], ["repay my loan", /^Repaying a loan is not available yet/u]] as const) {
      const run = await turn(text);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED", text);
      assert.match(run.error?.message ?? "", expected, text);
    }
  });

  it("say 'not available yet' for structured actions too", async () => {
    for (const [kind, expected] of [["borrow", /^Borrowing is not available yet/u], ["repay", /^Repaying a loan is not available yet/u]] as const) {
      const error = await refusalOf(planIntent({ actions: [{ kind, network: "base", amount: "100", from: "USDC" }], accounts: ["eip155:8453:0x2222222222222222222222222222222222222222"] }));
      assert.equal(error.code, "INTENT_UNSUPPORTED");
      assert.match(error.message, expected);
    }
  });
});

describe("tokens of the other lane", () => {
  it("says USDT is not available on Arbitrum Sepolia instead of reading it as USDC", async () => {
    const run = await turn("swap 5 USDC to USDT on arbitrum sepolia");
    assert.equal(run.error?.code, "TOKEN_UNKNOWN", run.error?.message);
    assert.match(run.error?.message ?? "", /^USDT is not available on Arbitrum Sepolia \(a testnet\)\. USDT is listed on mainnet networks only/u);
    assert.notEqual(run.error?.code, "SWAP_SAME_ASSET");
  });

  it("asks which token to spend when the spent token is not on the testnet", async () => {
    const run = await turn("send 5 USDT on arbitrum sepolia to 0x1111111111111111111111111111111111111111");
    const question = run.decision?.questions[0];
    assert.equal(question?.reason, "ASSET_NOT_ON_NETWORK", run.error?.message);
    assert.match(question?.prompt ?? "", /^USDT is not available on Arbitrum Sepolia/u);
    assert.deepEqual(question?.options.map((option) => option.id), ["USDC"]);
  });
});

describe("native staking minimum", () => {
  it("offers the liquid route below Solana's minimum", () => {
    const error = belowNativeMinimum("solana", 100_000_000n, 1_000_000_000n);
    assert.equal(error.code, "AMOUNT_TOO_SMALL");
    assert.match(error.message, /at least 1 SOL on Solana, so 0\.1 SOL is too little\. Liquid staking has no such minimum/u);
    assert.deepEqual(error.hints, ["stake 0.1 SOL with jito", "stake 0.1 SOL with marinade", "stake 0.1 SOL with jupiter"]);
  });

  it("states the devnet minimum plainly (no liquid staking there)", () => {
    const error = belowNativeMinimum("solana-devnet", 1_000_000n, 10_000_000n);
    assert.match(error.message, /at least 0\.01 SOL on Solana Devnet, so 0\.001 SOL is too little\. Liquid staking is not available on devnet/u);
    assert.deepEqual(error.hints, ["stake 0.01 SOL on solana devnet"]);
  });
});

describe("amount questions use the balance already read", () => {
  it("answers a balance from the turn's snapshot without another read", () => {
    const facts = new TurnFacts(["eip155:42161:0x2222222222222222222222222222222222222222"]);
    const snapshot = {
      accounts: [],
      observedAt: new Date(0).toISOString(),
      holdings: [
        { network: "arbitrum" as NetworkKey, asset: null, symbol: "USDC", decimals: 6, status: "known", units: "158162265", formatted: "158.162265", usd: 158.16, source: "sweep" },
        { network: "base" as NetworkKey, asset: null, symbol: "USDC", decimals: 6, status: "unknown", usd: null, source: "sweep" },
      ],
      positions: [],
      positionNetworks: [],
      prices: new Map(),
      apy: new Map(),
      sweep: { status: "complete", networks: ["arbitrum"], failures: [], peakConcurrency: 1, ms: 1 },
    } as unknown as Snapshot;
    facts.useSnapshot(snapshot);
    assert.equal(facts.balance("arbitrum", "usdc"), "158.162265");
    assert.equal(facts.misses, 0);
    assert.equal(facts.balance("base", "USDC"), undefined, "unknown stays unknown, never zero");
    assert.equal(facts.misses, 1);
  });
});
