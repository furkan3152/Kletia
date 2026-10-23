/**
 * Amounts in the reader (intent design P4-M2, A.2 amounts, A.3, red-team
 * A4, A5, A13, A15; U2 WP7, AQ5, RF6, RF7):
 *
 * - "1.000" keeps its typed form (always asked); European "1.000.000" and
 *   "1.000,50" read with a "Read as" chip; "0.500" stays a decimal.
 * - "d,ddd" keeps `raw`; paid to someone else it is read back in words.
 * - "and a half" adds 0.5 only before the token (after a bare number) or
 *   before the end, a connector or the same token; never before "of", "my"
 *   or another token.
 * - Fractions "a/b" only with 1 <= a < b <= 10: a portion after "of my",
 *   token units before a symbol; weight lists summing to 100 are rebalance
 *   weights (rebalance verbs only); every other slash form is refused.
 * - Portion evidence: "half sol" is asked, "half my sol" is a portion.
 * - Spaced thousands ("1 000"), "usd 50", arithmetic ("10 + 5", source C).
 * - Vague amounts ("like 1 or 2", "a few") are asked.
 * - Commentary ("worth $150", "(half my stack)") keeps the stated amount and
 *   records a marker; confirmed until the decision layer cross-checks it.
 * - Two amounts by word order alone, or on both sides of a conversion, are
 *   never planned on one of them.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { add, multiply } from "../clarify/decimal.js";
import type { TurnDecision } from "../clarify/index.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import {
  amountInWords,
  commentaryAgrees,
  commentaryOf,
  fractionBps,
  fractionDecimal,
  groupedThousands,
  lex,
  normalizeClause,
  readGoals,
  readNumber,
  type Token,
} from "../goal/index.js";
import { isPlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);
after(() => uninstallWallet());

async function say(text: string, thread: TurnDecision["thread"] | null = null, wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, { text }, contextOf(wallet));
}

const parse = (text: string) => parseSentence(text, []);
const first = (text: string) => parse(text).steps[0] as WorkStep;
const tokens = (text: string): Token[] => lex(normalizeClause(text));
const amountToken = (text: string) => tokens(text).find((token) => token.t === "AMOUNT") as Extract<Token, { t: "AMOUNT" }> | undefined;

function refused(text: string): void {
  assert.throws(() => parse(text), (error: unknown) => isPlatformError(error), text);
}

/* ------------------------------------------------------------ helpers */

describe("amount helpers", () => {
  it("reads dot and European number forms (WP7)", () => {
    assert.deepEqual(readNumber("1.000"), { value: "1.000", raw: "1.000" });
    assert.deepEqual(readNumber("12.500"), { value: "12.500", raw: "12.500" });
    assert.deepEqual(readNumber("0.500"), { value: "0.500" });
    assert.deepEqual(readNumber("1.000.000"), { value: "1000000", raw: "1.000.000", rewritten: true });
    assert.deepEqual(readNumber("1.000,50"), { value: "1000.50", raw: "1.000,50", rewritten: true });
    assert.deepEqual(readNumber("2,500"), { value: "2500", raw: "2,500" });
    for (const bad of ["1.00.000", "01.000.000", "1.000.00", "1.000,505"]) assert.equal(readNumber(bad), null, bad);
  });

  it("computes fractions only for 1 <= a < b <= 10 (A15)", () => {
    assert.equal(fractionDecimal(1, 2), "0.5");
    assert.equal(fractionDecimal(3, 4), "0.75");
    assert.equal(fractionDecimal(3, 8), "0.375");
    assert.equal(fractionDecimal(1, 10), "0.1");
    for (const [a, b] of [[1, 3], [2, 3], [3, 2], [1, 1], [0, 2], [1, 11], [50, 50]] as const) assert.equal(fractionDecimal(a, b), null, `${a}/${b}`);
    assert.equal(fractionBps(1, 4), 2500);
    assert.equal(fractionBps(1, 3), 3333);
    assert.equal(fractionBps(2, 3), 6667);
    assert.equal(fractionBps(3, 2), null);
    assert.equal(fractionBps(60, 40), null);
  });

  it("spells amounts in words for the payment read-back (A5)", () => {
    assert.equal(amountInWords("2500"), "two thousand five hundred");
    assert.equal(amountInWords("1000"), "one thousand");
    assert.equal(amountInWords("12345"), "twelve thousand three hundred forty-five");
    assert.equal(amountInWords("1000000"), "one million");
    assert.equal(amountInWords("0.5"), "zero point five");
    assert.equal(amountInWords("1250.75"), "one thousand two hundred fifty point seven five");
    assert.equal(amountInWords("1e3"), null);
    assert.ok(groupedThousands("2,500"));
    assert.ok(groupedThousands("1,000.50"));
    assert.ok(!groupedThousands("2500"));
    assert.ok(!groupedThousands("2,5"));
  });

  it("adds and multiplies exactly, never rounding", () => {
    assert.equal(add("10", "5"), "15");
    assert.equal(add("0.1", "0.2"), "0.3");
    assert.equal(multiply("2", "50"), "100");
    assert.equal(multiply("1.5", "3"), "4.5");
    assert.equal(multiply("0.000000001", "0.0000000001"), null);
  });

  it("reads commentary markers back and checks them against prices and holdings", () => {
    assert.deepEqual(commentaryOf({ rule: "commentary:usd", from: "worth $150" }), { kind: "usd", usd: "150" });
    assert.deepEqual(commentaryOf({ rule: "commentary:usd", from: "150 dollars" }), { kind: "usd", usd: "150" });
    assert.deepEqual(commentaryOf({ rule: "commentary:portion", from: "half my stack" }), { kind: "portion", bps: 5000 });
    assert.deepEqual(commentaryOf({ rule: "commentary:portion", from: "25% of my bag" }), { kind: "portion", bps: 2500 });
    assert.equal(commentaryOf({ rule: "unit:thousand", from: "1.5 k" }), null);
    assert.ok(commentaryAgrees({ kind: "usd", usd: "150" }, { amount: "1", price: 151 }));
    assert.ok(!commentaryAgrees({ kind: "usd", usd: "500" }, { amount: "1", price: 151 }));
    assert.ok(!commentaryAgrees({ kind: "usd", usd: "150" }, { amount: "1", price: null }), "no price: never agrees (asked)");
    assert.ok(commentaryAgrees({ kind: "portion", bps: 5000 }, { amount: "150", balance: "300" }));
    assert.ok(!commentaryAgrees({ kind: "portion", bps: 5000 }, { amount: "150", balance: "2.49" }));
    assert.ok(!commentaryAgrees({ kind: "portion", bps: 5000 }, { amount: "150" }), "no balance: never agrees (asked)");
  });
});

/* -------------------------------------------------------------- lexer */

describe("the lexer's amount forms", () => {
  it("reads spaced thousands as one number with a Read-as item", () => {
    for (const [text, value] of [["swap 1 000 usdc to sol", "1000"], ["send 12 500 usdc to alice.eth", "12500"], ["bridge 1 000 000 usdc to base", "1000000"], ["swap 2 500.50 usdc to eth", "2500.50"]] as const) {
      const amount = amountToken(text);
      assert.equal(amount?.sel.t === "exact" ? amount.sel.value : null, value, text);
      assert.equal(amount?.rule, "number:spaced", text);
    }
    // A number of more than three digits is never the head of a group; "1 sol 000" is not a number.
    assert.equal(amountToken("swap 1000 000 usdc to sol")?.rule, undefined);
  });

  it("reads token-unit fractions before a symbol and portions after \"of my\"", () => {
    for (const [text, value] of [["swap 1/2 sol to usdc", "0.5"], ["send 1/4 eth to alice.eth", "0.25"], ["swap 3/4 of a sol to usdc", "0.75"], ["bridge 1/10 eth to base", "0.1"]] as const) {
      const amount = amountToken(text);
      assert.deepEqual(amount?.sel, { t: "exact", value }, text);
      assert.equal(amount?.rule, "fraction:units", text);
    }
    for (const [text, bps] of [["stake 1/4 of my sol with jito", 2500], ["swap 3/4 of my base eth to usdc", 7500], ["swap 1/3 my sol to usdc", 3333], ["swap 1/2 of it to eth", 5000]] as const) {
      assert.deepEqual(amountToken(text)?.sel, { t: "portion", bps }, text);
    }
  });

  it("refuses every other slash form, and keeps weight lists for rebalancing", () => {
    for (const text of ["swap 3/2 sol to usdc", "swap 1/3 sol to usdc", "swap 1/11 sol to usdc", "swap 1/2 to usdc", "swap 2/4/6 sol to usdc", "swap 0/2 sol to usdc"]) {
      assert.ok(tokens(text).some((token) => token.t === "NOISE"), text);
    }
    for (const [text, weights] of [["rebalance to 50/50 eth usdc", [50, 50]], ["rebalance to 60/40 eth usdc", [60, 40]], ["rebalance to 40/30/30 eth usdc sol", [40, 30, 30]]] as const) {
      const list = tokens(text).find((token) => token.t === "WEIGHTS");
      assert.deepEqual(list?.t === "WEIGHTS" ? list.weights : null, weights, text);
    }
  });

  it("reads \"and a half\" only under its condition (AQ5, A13)", () => {
    for (const text of ["swap 1 sol and a half to usdc", "swap one and a half sol to usdc", "swap 1 and a half sol to usdc", "stake 2 sol and a half with jito", "swap 1 sol and a half sol to usdc", "swap 3 sol and a half"]) {
      const amount = parse(text).steps[0]?.amount?.v;
      assert.equal(amount?.t === "exact" ? amount.value : null, text.includes("2 sol") ? "2.5" : text.includes("3 sol") ? "3.5" : "1.5", text);
    }
    for (const text of ["send 1 sol and a half of my usdc to carol.sns", "send 1 sol and a half my usdc to carol.sns", "swap 1 sol and a half eth to usdc", "swap 1.5 sol and a half to usdc", "swap 1 and a half of my sol to usdc"]) refused(text);
  });

  it("reads \"usd 50\" as fifty dollars", () => {
    assert.deepEqual(amountToken("swap usd 50 of sol to usdc")?.sel, { t: "usd", value: "50" });
    assert.deepEqual(amountToken("bridge usd 25 to base")?.sel, { t: "usd", value: "25" });
    assert.equal(amountToken("swap usd 1.000 of sol to usdc")?.sel.t !== "usd", true, "a dot-thousands figure is not read as dollars here");
  });

  it("turns portions without evidence into an amount that is asked (WP6, A4)", () => {
    for (const text of ["swap half sol to usdc", "swap a quarter eth to usdc on base", "stake half sol with jito", "swap three quarters usdc to sol"]) {
      assert.ok(tokens(text).some((token) => token.t === "VAGUE"), text);
    }
    for (const text of ["swap half my sol to usdc", "swap half of my sol to usdc", "swap half the sol to usdc", "swap half of it to usdc", "swap half a sol to usdc"]) {
      assert.ok(!tokens(text).some((token) => token.t === "VAGUE"), text);
    }
  });

  it("reads arithmetic as one derived amount, and refuses mixed tokens", () => {
    for (const [text, value, rule] of [["send 10 usdc + 5 usdc to alice.eth", "15", "arithmetic:add"], ["send 10 + 5 usdc to alice.eth", "15", "arithmetic:add"], ["swap 2 x 50 usdc to eth", "100", "arithmetic:multiply"], ["swap 1 plus 0.5 sol to usdc", "1.5", "arithmetic:add"]] as const) {
      const amount = amountToken(text);
      assert.deepEqual(amount?.sel, { t: "exact", value }, text);
      assert.equal(amount?.rule, rule, text);
      assert.equal(amount?.derived, "arithmetic", text);
    }
    for (const text of ["send 10 usdc + 5 sol to alice.eth", "swap 2 usdc x 50 to eth", "swap + 5 usdc to eth"]) assert.ok(tokens(text).some((token) => token.t === "NOISE"), text);
  });

  it("records commentary on the stated amount, and refuses one no rule reads", () => {
    const worth = amountToken("stake 1 SOL worth $150 with jito");
    assert.deepEqual(worth?.sel, { t: "exact", value: "1" });
    assert.deepEqual(worth?.commentary, { kind: "usd", usd: "150", raw: "worth $150" });
    assert.deepEqual(amountToken("stake 150 sol (half my stack) with jito")?.commentary, { kind: "portion", bps: 5000, raw: "half my stack" });
    assert.deepEqual(amountToken("swap 2 eth (about 25% of my eth) to usdc")?.commentary, undefined);
    assert.deepEqual(amountToken("swap 2 eth ($7000) to usdc on base")?.commentary, { kind: "usd", usd: "7000", raw: "$7000" });
    assert.deepEqual(amountToken("swap 2 eth (worth 7000 dollars) to usdc on base")?.commentary, { kind: "usd", usd: "7000", raw: "worth 7000 dollars" });
    for (const text of ["stake 150 sol (for my rent) with jito", "stake 150 sol (half your stack) with jito", "stake (half my stack) with jito"]) assert.ok(tokens(text).some((token) => token.t === "NOISE"), text);
    // "100 usdc worth of sol" is the worth phrase, not a remark.
    assert.equal(amountToken("swap 100 usdc worth of sol")?.commentary, undefined);
  });

  it("reads \"like 1 or 2\" as a vague amount consuming both closed-class words (RF7)", () => {
    const vague = tokens("swap like 1 or 2 sol to usdc").find((token) => token.t === "VAGUE");
    assert.equal(vague?.t === "VAGUE" ? vague.raw : null, "like 1 or 2");
    assert.deepEqual(vague?.t === "VAGUE" ? [vague.rule, ...(vague.rules ?? [])] : null, ["amountVague:approx", "amountVague:or"]);
  });
});

/* ------------------------------------------------------------ slots */

describe("what the reader hands the decision layer", () => {
  it("keeps raw on dot-thousands and grouped amounts (A5)", () => {
    for (const text of ["bridge 1.000 usdc from base to arbitrum", "swap 1.000 usdc to sol", "send 2.500 usdc to vitalik.eth on base"]) {
      const amount = first(text).amount?.v;
      assert.ok(amount?.t === "exact" && /^\d\.\d{3}$/u.test(amount.raw ?? amount.value), text);
    }
    const grouped = first("swap 2,500 usdc to eth on base").amount?.v;
    assert.deepEqual(grouped, { t: "exact", value: "2500", raw: "2,500" });
  });

  it("reads a grouped amount paid to someone else back in words, never for one's own swap", () => {
    for (const [text, to] of [
      ["send 2,500 usdc to vitalik.eth on base", "2,500 USDC (two thousand five hundred)"],
      ["pay alice.eth 1,000 usdc on base", "1,000 USDC (one thousand)"],
      ["send 12,345 usdc to bob.base.eth on base", "12,345 USDC (twelve thousand three hundred forty-five)"],
    ] as const) {
      assert.deepEqual(first(text).readAs, [{ slot: "amount", rule: "format:grouped", to }], text);
    }
    assert.equal(first("swap 2,500 usdc to eth on base").readAs, undefined);
    assert.equal(first("bridge 1,000 usdc from base to arbitrum").readAs, undefined);
  });

  it("reads European thousands with a Read-as item", () => {
    const step = first("bridge 1.000.000 usdc from base to arbitrum");
    assert.deepEqual(step.amount?.v, { t: "exact", value: "1000000", raw: "1.000.000", rewritten: true });
    assert.equal(step.readAs?.[0]?.rule, "format:european");
  });

  it("asks the amount of a portion without evidence, on the strict and the Goal path alike", () => {
    for (const text of ["swap half sol to usdc", "stake half sol", "withdraw half usdc from aave on base", "bridge half usdc from base to arbitrum", "swap a quarter sol to usdc"]) {
      assert.equal(first(text).amount, undefined, text);
    }
    assert.deepEqual(first("swap half my sol to usdc").amount?.v, { t: "balance", bps: 5000 });
    assert.deepEqual(first("swap half of my sol to usdc").amount?.v, { t: "balance", bps: 5000 });
  });

  it("reads portions of a holding on a named network and of a position (RF6)", () => {
    for (const [text, bps] of [
      ["deposit half of my arbitrum usdc into aave", 5000],
      ["swap three quarters of my arbitrum eth to usdc", 7500],
      ["swap 25% of my base usdc to eth", 2500],
      ["swap 3/4 of my base eth to usdc", 7500],
    ] as const) {
      const step = first(text);
      assert.deepEqual(step.amount?.v, { t: "balance", bps }, text);
      assert.ok(step.network?.v === "arbitrum" || step.network?.v === "base" || step.fundFrom !== undefined, text);
    }
  });

  it("marks arithmetic as source C with a Read-as item", () => {
    const step = first("send 10 usdc + 5 usdc to alice.eth on base");
    assert.deepEqual(step.amount?.v, { t: "exact", value: "15", raw: "10 + 5", rewritten: true });
    assert.equal(step.source, "C");
    assert.deepEqual(step.readAs, [{ slot: "amount", rule: "arithmetic:add", from: "10 + 5", to: "15 USDC" }]);
  });

  it("keeps the stated amount and marks commentary for the cross-check (source C until it is checked)", () => {
    const worth = first("stake 1 SOL worth $150 with jito");
    assert.deepEqual(worth.amount?.v, { t: "exact", value: "1" });
    assert.equal(worth.source, "C");
    assert.deepEqual(worth.readAs, [{ slot: "amount", rule: "commentary:usd", from: "worth $150", to: "1 SOL" }]);
    const stack = first("stake 150 sol (half my stack) with jito");
    assert.deepEqual(stack.amount?.v, { t: "exact", value: "150" });
    assert.deepEqual(stack.readAs, [{ slot: "amount", rule: "commentary:portion", from: "half my stack", to: "150 SOL" }]);
  });

  it("refuses a second amount by word order and an amount on both sides of a conversion", () => {
    for (const text of ["swap 1 sol 2 usdc", "swap 1 sol for 2 usdc", "swap 100 usdc to 0.03 eth on base", "get me 1 eth with 100 usdc on base"]) refused(text);
  });

  it("reads weight lists into rebalance targets, and nowhere else", () => {
    const [asset] = readGoals("rebalance to 50/50 eth usdc on arbitrum");
    assert.deepEqual(asset?.goal.targets, { axis: "asset", scope: { network: "arbitrum", custody: { kind: "wallet" } }, weights: [{ key: "eth", bps: 5000 }, { key: "usdc", bps: 5000 }] });
    const [network] = readGoals("rebalance my usdc 60/40 between base and arbitrum");
    assert.deepEqual(network?.goal.targets, { axis: "network", weights: [{ key: "base", bps: 6000 }, { key: "arbitrum", bps: 4000 }] });
    assert.deepEqual(network?.goal.spend.asset, { symbol: "usdc" });
    for (const text of ["swap 60/40 sol usdc", "rebalance to 50/50 eth", "rebalance to 50/50 eth eth", "rebalance to 50/50 eth usdc on arbitrum tonight", "send 50/50 usdc to alice.eth"]) {
      assert.equal(readGoals(text)[0] ?? null, null, text);
    }
  });
});

/* ----------------------------------------------------------- decisions */

describe("outcomes", () => {
  it("\"swap half sol to usdc\" asks the amount, with half the balance as an option (RT042)", async () => {
    const run = await say("swap half sol to usdc");
    assert.equal(run.decision?.status, "needs_input", run.error?.message);
    const question = run.decision?.questions[0];
    assert.equal(question?.field, "actions[0].amount");
    assert.ok(question?.options.some((option) => option.id === "half"));
  });

  it("\"one and a half sol\" and \"1 sol and a half\" plan 1.5 SOL with a Read-as chip (AQ5)", async () => {
    for (const text of ["swap one and a half sol to usdc", "swap 1 sol and a half to usdc"]) {
      const run = await say(text);
      assert.equal(run.decision?.status, "ready", run.error?.message);
      assert.equal(shape(run.decision?.actions ?? []), "swap@solana 1.5 SOL->USDC");
      assert.ok(run.decision?.assumptions.some((entry) => /^Read as 1\.5 SOL/u.test(entry.label)), text);
    }
  });

  it("\"1.000\" always asks AMOUNT_FORMAT_AMBIGUOUS (WP7)", async () => {
    const run = await say("bridge 1.000 usdc from base to arbitrum");
    assert.equal(run.decision?.questions[0]?.reason, "AMOUNT_FORMAT_AMBIGUOUS", run.error?.message);
  });

  it("arithmetic and commentary are one-click confirms, never plain plans", async () => {
    for (const text of ["swap 1 + 0.5 sol to usdc", "stake 1 SOL worth $150 with jito"]) {
      const run = await say(text);
      assert.equal(run.decision?.status, "needs_input", run.error?.message);
      assert.ok(run.decision?.questions.some((question) => question.reason === "INTERPRETATION_CONFIRM"), text);
    }
  });

  it("\"swap like 1 or 2 sol to usdc\" asks the amount (RF7)", async () => {
    const run = await say("swap like 1 or 2 sol to usdc");
    assert.equal(run.decision?.questions[0]?.field, "actions[0].amount", run.error?.message);
  });

  it("\"1/2 sol\" plans 0.5 SOL with a Read-as chip; \"3/2 sol\" is refused", async () => {
    const run = await say("swap 1/2 sol to usdc");
    assert.equal(shape(run.decision?.actions ?? []), "swap@solana 0.5 SOL->USDC", run.error?.message);
    assert.ok(run.decision?.assumptions.some((entry) => entry.label === "Read as 0.5 SOL (1/2 sol)"));
    const refusedRun = await say("swap 3/2 sol to usdc");
    assert.equal(refusedRun.error?.code, "INTENT_UNSUPPORTED");
  });
});
