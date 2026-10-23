/**
 * Hand-offs: perps trades, native orders and automations read from
 * plain text into the typed input of their surface. Every missing leverage,
 * side, amount, price, period or network is asked (never guessed), every
 * default is a chip, a disabled venue or a leverage above the rule book's cap
 * is refused, and nothing is planned or executed: the decision carries no
 * actions and the thread no steps.
 *
 * End to end through decideTurn with the corpus wallet "full" (offline:
 * fixture holdings and fixed prices, clock 2026-10-01 12:04:30 UTC).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { effectivePerps, parseAccountId, type IntentHandoff } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, uninstallWallet, type TurnRun } from "../clarify/corpusHarness.js";
import type { TurnContext } from "../clarify/types.js";
import { handoffShape } from "../handoff/shape.js";
import { readHandoff } from "../handoff/read.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const CTX: TurnContext = contextFor(corpus, { id: "handoff", category: "", title: "", wallet: "full", turns: [] });

before(() => installWallet(corpus, "full"));
after(() => uninstallWallet());

async function say(text: string, ctx: TurnContext = CTX): Promise<TurnRun> {
  return runTurn(null, { text }, ctx);
}

function handed(run: TurnRun): IntentHandoff {
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.decision?.status, "handoff", JSON.stringify(run.decision?.questions.map((q) => `${q.field}:${q.reason}`)));
  // Never an intent: no actions, no steps, the hand-off kept on the thread.
  assert.equal(run.decision?.actions, undefined);
  assert.deepEqual(run.decision?.thread.steps, []);
  assert.equal(run.decision?.thread.status, "ready");
  return run.decision?.handoff as IntentHandoff;
}

function asked(run: TurnRun): string {
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.decision?.status, "needs_input");
  const question = run.decision?.questions[0];
  return `${question?.field}:${question?.reason}`;
}

function chips(run: TurnRun): string[] {
  return (run.decision?.assumptions ?? []).map((entry) => entry.label);
}

describe("perps hand-offs", () => {
  it("reads the documented sentences into planPerpsIntent's input", async () => {
    assert.equal(handoffShape(handed(await say("long ETH 5x with 100 USDC"))), "perps:open long ETH 100 USDC 5x");
    const short = await say("short BTC $500 with 50 USDC on Hyperliquid");
    assert.equal(handoffShape(handed(short)), "perps:open short BTC $500 50 USDC 10x @hyperliquid");
    assert.ok(chips(short).includes("Leverage 10x"), "a derived leverage is a chip");
    assert.equal(handoffShape(handed(await say("close my ETH long"))), "perps:close long ETH");
    assert.equal(handoffShape(handed(await say("reduce my SOL short by $100"))), "perps:decrease short SOL $100");
    assert.equal(handoffShape(handed(await say("go long 3x BTC with $200"))), "perps:open long BTC 200 USDC 3x");
  });

  it("refuses Drift, naming why it is disabled", async () => {
    const run = await say("short SOL $200 at 3x on Drift");
    assert.equal(run.error?.code, "PERPS_VENUE_DISABLED");
    assert.match(run.error?.message ?? "", /April 1, 2026/u);
  });

  it("asks the collateral, then the leverage, and takes typed answers", async () => {
    const first = await say("long ETH");
    assert.equal(asked(first), "handoff.collateral:AMOUNT_MISSING");
    const second = await runTurn(first.decision!.thread, { text: "100" }, CTX);
    assert.equal(asked(second), "handoff.leverage:LEVERAGE_MISSING");
    assert.ok(second.decision!.questions[0]!.options.every((option) => option.recommended === undefined), "never a suggested leverage");
    const third = await runTurn(second.decision!.thread, { answer: { question: "q.handoff.leverage", option: "5" } }, CTX);
    assert.equal(handoffShape(handed(third)), "perps:open long ETH 100 USDC 5x");
    const side = await say("close my SOL perp");
    assert.equal(asked(side), "handoff.side:SIDE_MISSING");
  });

  it("refuses leverage above the rule book's cap and perps a rule book turns off", async () => {
    assert.equal((await say("short ETH 50x with 100 USDC")).error?.code, "PERPS_LEVERAGE_TOO_HIGH");
    const capped: TurnContext = { ...CTX, perps: { ...effectivePerps([]), maxLeverage: 3 } };
    const run = await say("long ETH 5x with 100 USDC", capped);
    assert.equal(run.error?.code, "PERPS_LEVERAGE_TOO_HIGH");
    assert.match(run.error?.message ?? "", /3x cap/u);
    const off: TurnContext = { ...CTX, perps: { enabled: false, maxLeverage: 20, venues: [], reason: "Agent keys trade perps only when their rule book sets perps.enabled." } };
    assert.equal((await say("long ETH 5x with 100 USDC", off)).error?.code, "PERPS_POLICY_DENIED");
    assert.equal((await say("long ETH 5x with 100 ETH")).error?.code, "PERPS_MARKET_UNSUPPORTED");
  });

  it("leaves look-alikes to the intent reader", () => {
    for (const text of ["long term hold my SOL", "swap 1 SOL to USDC", "short of USDC, send 5 to vitalik.eth"]) assert.equal(readHandoff(text), null, text);
  });
});

describe("native order hand-offs", () => {
  it("reads limit and DCA orders into planNativeOrder's input", async () => {
    const limit = await say("sell 1 WETH at 4000 on base");
    assert.equal(handoffShape(handed(limit)), "order:limit sell 1 WETH for USDC at 4000 on base [cow-protocol]");
    assert.ok(chips(limit).includes("Priced in USDC"));
    assert.equal(handoffShape(handed(await say("buy SOL with 500 USDC over 10 days"))), "order:dca sell 500 USDC for SOL every day x10 on solana [jupiter-recurring]");
    assert.equal(handoffShape(handed(await say("limit buy 1000 JUP at 0.8"))), "order:limit buy 1000 JUP with USDC at 0.8 on solana [jupiter-trigger]");
    assert.equal(handoffShape(handed(await say("sell 100 USDC for SOL every day for 5 days"))), "order:dca sell 500 USDC for SOL every day x5 on solana [jupiter-recurring]");
    const handoff = handed(await say("buy SOL with 500 USDC over 10 days"));
    assert.equal(handoff.execution, "native");
  });

  it("asks the network when the pair is on several, and cancels by order id", async () => {
    const run = await say("if ETH rises above 4000 sell 1 ETH");
    assert.equal(asked(run), "handoff.network:NETWORK_AMBIGUOUS");
    const answered = await runTurn(run.decision!.thread, { answer: { question: "q.handoff.network", option: "base" } }, CTX);
    assert.match(handoffShape(handed(answered)), /^order:limit sell 1 \w*ETH for USDC at 4000 on base \[cow-protocol\]$/u);
    const id = "jupiter-trigger:solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    assert.equal(handoffShape(handed(await say(`cancel order ${id}`))), `order:cancel ${id}`);
    assert.equal((await say("cancel my order")).error?.code, "INTENT_UNSUPPORTED");
  });
});

describe("automation hand-offs", () => {
  it("reads schedules, conditions, sweeps and the best yield into a validated draft", async () => {
    const weekly = await say("buy $50 of ETH every Monday");
    assert.equal(handoffShape(handed(weekly)), "automation:every 1 week mon max - => swap 50 USDC to ETH on base");
    assert.ok(chips(weekly).includes("Each run waits for your signature"));
    const stop = await say("if SOL drops below 120 sell half");
    assert.equal(handoffShape(handed(stop)), "automation:price SOL@solana below 120 => sell half of my SOL for USDC on solana");
    assert.ok(chips(stop).includes("No native stop order"));
    assert.ok(!chips(stop).some((label) => /1\.25/u.test(label)), "today's balance is no chip of a share taken at each run");
    assert.equal(handoffShape(handed(await say("every month send 100 USDC to vitalik.eth on base"))), "automation:every 1 month fri max - => send 100 USDC to vitalik.eth on base");
  });

  it("asks the first deposit of the best-yield rule and the network of a payment", async () => {
    const best = await say("keep my USDC in the best yield");
    assert.equal(asked(best), "handoff.amount:AMOUNT_MISSING");
    const answered = await runTurn(best.decision!.thread, { text: "100" }, CTX);
    const handoff = handed(answered);
    assert.match(handoffShape(handoff), /^automation:apy USDC [a-z,]+ => rebalance 100$/u);
    const monthly = await say("every month send 100 USDC to vitalik.eth");
    assert.equal(asked(monthly), "handoff.action:TRANSFER_NETWORK");
  });

  it("confirms that a sweep spends the whole balance, then watches that account", async () => {
    const run = await say("when USDC arrives, deposit it into aave");
    assert.equal(asked(run), "handoff.confirm:INTERPRETATION_CONFIRM");
    const confirmed = await runTurn(run.decision!.thread, { answer: { question: "q.handoff.confirm", option: "confirm" } }, CTX);
    const handoff = handed(confirmed);
    assert.equal(handoffShape(handoff), "automation:incoming USDC@base => deposit all my USDC into aave on base");
    if (handoff.surface !== "automations" || handoff.input.draft.trigger.kind !== "event") throw new Error("not an event trigger");
    assert.equal(parseAccountId(handoff.input.draft.trigger.account)?.chain.key, "base");
  });
});

describe("hand-off threads", () => {
  it("returns the hand-off again on a commit turn and cancels on request", async () => {
    const run = await say("long ETH 5x with 100 USDC");
    const again = await runTurn(run.decision!.thread, { none: true }, CTX);
    assert.equal(handoffShape(handed(again)), "perps:open long ETH 100 USDC 5x");
    const cancelled = await runTurn(run.decision!.thread, { text: "cancel" }, CTX);
    assert.equal(cancelled.decision?.status, "cancelled");
  });

  it("reads a new ordinary sentence on a hand-off thread as a new task", async () => {
    const run = await say("long ETH");
    const next = await runTurn(run.decision!.thread, { text: "swap 1 SOL to USDC" }, CTX);
    assert.equal(next.decision?.status, "ready");
    assert.equal(next.decision?.thread.handoff, undefined);
  });
});
