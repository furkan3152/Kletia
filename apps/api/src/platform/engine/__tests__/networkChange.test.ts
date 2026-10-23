/**
 * The network-change rule (intent design C.1, C.4; package P2-M1): when a
 * step runs on a network other than where its money is, the decision layer
 * knows where the bridge goes. A dependent step on another network gets a
 * crossing leg (a material chip); a destination the person said that the
 * next step contradicts, or a bridge back to where the funds started, is
 * asked; funds from a network nobody named are asked (FUNDS_ELSEWHERE); a
 * fixed departure is overridden only by a spend-side network; a step signed
 * where the person holds no gas asks how it pays its fee. Offline: the
 * clarify corpus' fixture wallets.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClarifyThread } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision, TurnInput } from "../clarify/index.js";
import { crossingSymbols } from "../clarify/policy.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
after(() => uninstallWallet());

interface Turn {
  readonly decision?: TurnDecision;
  readonly error?: { readonly code: string; readonly message: string };
}

async function thread(wallet: string, request: CorpusCase["request"] | undefined, ...inputs: (string | TurnInput)[]): Promise<Turn[]> {
  const entry = { id: "t", category: "test", title: "t", wallet, ...(request ? { request } : {}), turns: [] } as CorpusCase;
  const ctx = contextFor(corpus, entry);
  const out: Turn[] = [];
  let current: ClarifyThread | null = null;
  for (const input of inputs) {
    installWallet(corpus, wallet);
    const result = await runTurn(current, typeof input === "string" ? { text: input } : input, ctx);
    out.push(result);
    if (result.decision) current = result.decision.thread;
  }
  return out;
}

const answer = (question: string, option: string): TurnInput => ({ answer: { question, option } });
const planOf = (turn: Turn | undefined) => (turn?.decision?.actions ? shape(turn.decision.actions) : `${turn?.decision?.status ?? turn?.error?.code}`);
const asked = (turn: Turn | undefined) => turn?.decision?.questions.map((q) => `${q.field}:${q.reason}`) ?? [];
const optionsOf = (turn: Turn | undefined) => turn?.decision?.questions[0]?.options.map((option) => option.id) ?? [];

describe("C.1 rule 2: a dependent step on another network gets a crossing leg", () => {
  it("'swap 1 sol to usdc and deposit it into aave on base' bridges the swap's output to Base, shown as a material chip", async () => {
    const [turn] = await thread("full", undefined, "swap 1 sol to usdc and deposit it into aave on base");
    assert.equal(planOf(turn), "swap@solana 1 SOL->USDC | bridge@solana->base max USDC | deposit@base max USDC [aave-v3]");
    const chip = turn?.decision?.assumptions.find((entry) => entry.field === "actions[1].network");
    assert.ok(chip?.material, "the inserted bridge is a material chip");
    assert.equal(chip?.source, "context");
  });

  it("crossing carriers: USDC and ETH cross within their lane; what no bridge carries is null", () => {
    assert.deepEqual(crossingSymbols("USDC", "solana", "base"), { from: "USDC", to: "USDC" });
    assert.deepEqual(crossingSymbols("ETH", "base", "arbitrum"), { from: "ETH", to: "ETH" });
    assert.equal(crossingSymbols("SOL", "solana", "base"), null);
    assert.equal(crossingSymbols("USDC", "base", "arbitrum-sepolia"), null, "mainnet and testnet never mix");
  });
});

describe("C.1 rule 6: contradictions and round trips are asked, never an inserted leg", () => {
  const sentence = "bridge 100 usdc from base to arbitrum then deposit it into aave on base";

  it("a step network that contradicts the said bridge destination lists both readings", async () => {
    const [turn] = await thread("full", undefined, sentence);
    assert.deepEqual(asked(turn), ["actions[1].network:NETWORK_CONTRADICTION"]);
    assert.deepEqual(optionsOf(turn), ["arbitrum", "skip", "cancel"]);
    assert.ok(turn?.decision?.questions[0]?.options.every((option) => !option.recommended), "a purpose question suggests nothing");
  });

  it("'where the bridge lands' deposits on Arbitrum; 'skip the bridge' deposits on Base with the bridge's amount", async () => {
    const [, landing] = await thread("full", undefined, sentence, answer("q.actions.1.network", "arbitrum"));
    assert.equal(planOf(landing), "bridge@base->arbitrum 100 USDC | deposit@arbitrum max USDC [aave-v3]");
    const [, skipped] = await thread("full", undefined, sentence, answer("q.actions.1.network", "skip"));
    assert.equal(planOf(skipped), "deposit@base 100 USDC [aave-v3]");
  });

  it("a said bridge back to where the funds started is asked once; the answer plans both bridges", async () => {
    const [ask, planned] = await thread("full", undefined, "bridge 10 usdc from base to arbitrum then bridge it to base", answer("q.actions.1.toNetwork", "base"));
    assert.deepEqual(asked(ask), ["actions[1].toNetwork:NETWORK_CONTRADICTION"]);
    assert.deepEqual(optionsOf(ask), ["base", "cancel"]);
    assert.equal(planOf(planned), "bridge@base->arbitrum 10 USDC | bridge@arbitrum->base max USDC");
    const [onward] = await thread("full", undefined, "bridge 10 usdc from base to arbitrum then bridge it to solana");
    assert.equal(planOf(onward), "bridge@base->arbitrum 10 USDC | bridge@arbitrum->solana max USDC", "a crossing onward is not a round trip");
  });
});

describe("C.1 rule 3: funds from a network nobody named are asked (FUNDS_ELSEWHERE)", () => {
  it("'I need 20 USDC on arbitrum' asks where the USDC comes from; each option pins the holding it names", async () => {
    const [ask, planned] = await thread("low_evm", undefined, "I need 20 USDC on arbitrum", answer("q.actions.0.network", "solana:USDC"));
    assert.deepEqual(asked(ask), ["actions[0].network:FUNDS_ELSEWHERE"]);
    const options = ask?.decision?.questions[0]?.options ?? [];
    assert.equal(options[0]?.id, "solana:USDC", "the same asset first (exposure-neutral)");
    assert.ok(options.every((option) => !option.recommended && /^Use \S+ on /u.test(option.label)));
    assert.equal(planOf(planned), "bridge@solana->arbitrum 20 USDC");
  });

  it("a short balance where the person named the network offers funds elsewhere, never moves them on a chip", async () => {
    const [ask] = await thread("full", undefined, "I need 50 USDC on arbitrum");
    assert.deepEqual(asked(ask), ["actions[0].network:FUNDS_ELSEWHERE"]);
    assert.equal(ask?.decision?.actions, undefined);
  });
});

describe("C.4: the departure and the said network (C8, D2 on the departure)", () => {
  it("a venue network is where the step runs; the money comes from the fixed departure (a material chip)", async () => {
    const [turn] = await thread("wide", { sourceNetwork: "solana" }, "deposit 50 USDC into aave on arbitrum");
    assert.equal(planOf(turn), "bridge@solana->arbitrum 50 USDC | deposit@arbitrum max USDC [aave-v3]");
    assert.ok(turn?.decision?.assumptions.find((entry) => entry.field === "actions[0].network")?.material);
  });

  it("a departure that holds too little is asked; 'use funds on Base' bridges from Base to where the step runs", async () => {
    const [ask, planned] = await thread("full", { sourceNetwork: "solana" }, "deposit 50 USDC into aave on arbitrum", answer("q.actions.0.amount", "base"));
    assert.deepEqual(asked(ask), ["actions[0].amount:AMOUNT_EXCEEDS_BALANCE"]);
    assert.deepEqual(optionsOf(ask), ["all", "base", "keep"]);
    assert.equal(planOf(planned), "bridge@base->arbitrum 50 USDC | deposit@arbitrum max USDC [aave-v3]");
  });

  it("funds on the network where the step runs are spent there (no bridge to itself, no departure leg)", async () => {
    const [, planned] = await thread("full", { sourceNetwork: "solana" }, "deposit 50 USDC into aave", answer("q.actions.0.amount", "base"));
    assert.equal(planOf(planned), "deposit@base 50 USDC [aave-v3]");
  });
});

describe("C.1 rule 8: gas where a later step is signed", () => {
  const sentence = "bridge 20 USDC from base to optimism then swap it to ETH";

  it("no ETH on OP Mainnet for step 2: asked, with a top-up on the arriving bridge", async () => {
    const [ask] = await thread("full", undefined, sentence);
    assert.deepEqual(asked(ask), ["actions[1].network:GAS_ON_ARRIVAL"]);
    assert.deepEqual(optionsOf(ask), ["topup", "anyway", "cancel"]);
    assert.match(ask?.decision?.questions[0]?.prompt ?? "", /^You hold no ETH on OP Mainnet to sign step 2\./u);
  });

  it("the network the plan starts on is not asked (the person signs there first); a fixed departure's bridge is an arrival", async () => {
    const [ask, start] = await thread("full", undefined, "swap 10 USDC to ETH on optimism", answer("q.actions.0.amount", "keep"));
    assert.deepEqual(asked(ask), ["actions[0].amount:AMOUNT_EXCEEDS_BALANCE"]);
    assert.equal(planOf(start), "swap@optimism 10 USDC->ETH");
    const [departed, topped] = await thread("full", { sourceNetwork: "solana" }, "deposit 5 USDC into aave on optimism", answer("q.actions.0.network", "topup"));
    assert.deepEqual(asked(departed), ["actions[0].network:GAS_ON_ARRIVAL"]);
    assert.match(departed?.decision?.questions[0]?.options[0]?.detail ?? "", /with the bridge from Solana$/u);
    assert.equal(planOf(topped), "bridge@solana->optimism 5 USDC | deposit@optimism max USDC [aave-v3]");
    assert.deepEqual(topped?.decision?.gasOnArrival, { optimism: "0.50" });
  });

  it("'add ETH with the bridge' becomes the plan request's gasOnArrival and a material chip; 'plan anyway' adds none", async () => {
    const [, topup] = await thread("full", undefined, sentence, answer("q.actions.1.network", "topup"));
    assert.equal(planOf(topup), "bridge@base->optimism 20 USDC | swap@optimism max USDC->ETH");
    assert.deepEqual(topup?.decision?.gasOnArrival, { optimism: "0.50" });
    assert.ok(topup?.decision?.assumptions.find((entry) => entry.field === "actions[0].gasOnArrival")?.material);
    const [, anyway] = await thread("full", undefined, sentence, answer("q.actions.1.network", "anyway"));
    assert.equal(planOf(anyway), "bridge@base->optimism 20 USDC | swap@optimism max USDC->ETH");
    assert.equal(anyway?.decision?.gasOnArrival, undefined);
  });
});
