/**
 * Closed-class words in the reader (intent design P4-M1, A.2, I12): every
 * never-drop word, unit word and approximation is consumed by a named rule
 * or the clause is refused with its family's message; never dropped,
 * corrected or read away.
 *
 * - Refusals by family: negation, cancellation, question, condition and
 *   time, disjunction, limit (also "each" until RECIPIENT_EACH reads it),
 *   unit; `details.closedClass` names the family, and labels never hide one
 *   ("dont groceries: pay ...", red-team RT124/RT125).
 * - Rules this reader applies: step order ("after that"), "over to/from",
 *   "everything except N", approximations and "1 or 2" (the amount is asked,
 *   never read as the number), units and multipliers (a "Read as" item and
 *   the unit on the amount).
 * - Openers: "should i ..." is refused as a question; "can you ..." is
 *   planned only as a confirm of the solved plan.
 * - The closed-class record travels on the step with the hits a slot rule
 *   consumed, and its look-alike symbols.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSED_CLASS_REFUSALS } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { CLOSED_CLASS_COPY } from "../clarify/copy.js";
import type { TurnDecision } from "../clarify/index.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { clauseRecord, openerOf, READER_RULES } from "../goal/closedClass.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);
after(() => uninstallWallet());

async function say(text: string, thread: TurnDecision["thread"] | null = null, wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, { text }, contextOf(wallet));
}

function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return error;
    throw error;
  }
  assert.fail("expected a refusal");
}

const first = (text: string) => parseSentence(text, []).steps[0] as WorkStep;

/* ---------------------------------------------------------- families */

describe("a never-drop word no rule consumes refuses with its family's message", () => {
  const cases: readonly (readonly [string, (typeof CLOSED_CLASS_REFUSALS)[number]])[] = [
    ["dont swap 1 eth to usdc on base", "negation"],
    ["swap 1 eth to usdc, but not on base", "negation"],
    ["never bridge 10 usdc to arbitrum", "negation"],
    ["cancel that, bridge 10 usdc from base to arbitrum", "cancellation"],
    ["scratch that swap 1 sol to usdc", "cancellation"],
    ["swap 1 eth to usdc on base tomorrow", "condition"],
    ["if eth drops swap 100 usdc to eth on base", "condition"],
    ["send 5 usdc to bob tomorrow", "condition"],
    ["stake 1 sol with jito weekly", "condition"],
    ["bridge 100 usdc to arbitrum or optimism", "disjunction"],
    ["deposit 100 usdc into aave or compound on base", "disjunction"],
    ["swap up to 100 usdc to eth on base", "limit"],
    ["transfer over 25 usdc from base to solana", "limit"],
    ["swap at most 2 sol to usdc", "limit"],
    ["swap 1 sol to usdc, maybe", "question"],
    ["swap 1 sol to usdc i guess", "question"],
  ];
  for (const [text, family] of cases) {
    it(`"${text}" -> ${family}`, () => {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
      assert.deepEqual(error.details, { closedClass: family }, `${text}: ${error.message}`);
      assert.equal(error.message, CLOSED_CLASS_COPY[family]);
    });
  }

  it("a label never hides a closed-class word (red-team RT124, RT125)", async () => {
    for (const [text, family] of [
      ["dont groceries: pay 20 usdc to vitalik.eth on base", "negation"],
      ["maybe rent: send 50 usdc to 0x1111111111111111111111111111111111111111 on base", "question"],
      ["later: swap 1 sol to usdc", "condition"],
    ] as const) {
      const run = await say(text);
      assert.equal(run.decision, undefined, `${text}: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED", text);
      assert.equal(run.error?.message, CLOSED_CLASS_COPY[family], text);
    }
    // A plain label is still a note.
    const note = await say("rent: send 50 usdc to 0x1111111111111111111111111111111111111111 on base");
    assert.equal(note.decision?.status, "ready", note.error?.message);
  });

  it("the refusal never echoes the person's words", () => {
    const error = refusal(() => parseSentence("dont send my secret 50 usdc to bob.eth", []));
    assert.doesNotMatch(error.message, /secret|bob\.eth/u);
  });
});

/* -------------------------------------------------------- consumed */

describe("rules this reader applies consume the word", () => {
  it("step order: \"after that\" (order:then)", () => {
    const read = parseSentence("bridge 10 usdc from base to arbitrum and after that swap it to eth", []);
    assert.deepEqual(read.steps.map((step) => step.kind?.v), ["bridge", "swap"]);
    const split = parseSentence("bridge 10 usdc from base to arbitrum then after that swap it to eth", []);
    assert.deepEqual(split.steps.map((step) => step.kind?.v), ["bridge", "swap"]);
    // "after" with no "that" is time, not order.
    assert.equal(refusal(() => parseSentence("swap 1 sol to usdc after the merge", [])).message, CLOSED_CLASS_COPY.condition);
  });

  it("\"over to\", \"over from\" and \"over <bridge>\" are connector spellings (connector:over)", () => {
    assert.equal(first("move 25 usdc from base over to solana").toNetwork?.v, "solana");
    assert.equal(first("port 10 usdc over from arbitrum to base").network?.v, "arbitrum");
    assert.equal(first("bridge 10 usdc from base to arbitrum over relay").protocol?.v, "relay");
  });

  it("\"everything except 0.5\" is all but 0.5 (allBut:except)", () => {
    const step = first("swap everything except 0.5 sol to usdc");
    assert.deepEqual(step.goal?.spend.amount, { t: "allBut", keep: "0.5" });
  });

  for (const text of ["stake around 3 sol with jito", "swap ~3 sol to usdc", "swap 3ish sol to usdc", "swap 3 sol or so to usdc", "swap about 2 eth to usdc on base", "swap like 1 sol to usdc", "bridge 1 or 2 sol to base", "swap a couple sol to usdc", "bridge a bunch of usdc to arbitrum", "send a little sol to carol.sns"]) {
    it(`"${text}": the amount is asked, never read as the stated number`, async () => {
      const step = first(text);
      assert.equal(step.amount, undefined, JSON.stringify(step.amount));
      // Never planned with a guessed amount: the turn asks (the amount, or first another missing part).
      const run = await say(text);
      assert.equal(run.decision?.status, "needs_input", run.error?.message);
    });
  }

  it("an approximate amount after a step is never chained to its output", () => {
    const read = parseSentence("bridge 100 usdc from base to arbitrum then swap around 50 usdc to eth", []);
    assert.equal(read.steps[1]?.amount, undefined);
    // With no token to read it from, the step is refused rather than chained to all of the previous output.
    assert.equal(refusal(() => parseSentence("bridge 100 usdc from base to arbitrum then deposit around 50 into aave", [])).message, CLOSED_CLASS_COPY.limit);
  });

  it("\"almost all\" and \"nearly everything\" are refused, not read as all", () => {
    for (const text of ["swap almost all my sol to usdc", "bridge nearly everything to base"]) {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
    }
  });
});

/* ------------------------------------------------------------ units */

describe("units and multipliers (design A.2 L0, red-team A3)", () => {
  for (const [text, value, unit, readAs] of [
    ["swap 1.5 k usdc to eth on base", "1500", "thousand", "1500 USDC"],
    ["swap 1.5k usdc to eth on base", "1500", "thousand", "1500 USDC"],
    ["send 2 grand of usdc to bob.eth on base", "2000", "thousand", "2000 USDC"],
    ["bridge 1.5 million usdc from base to arbitrum", "1500000", "million", "1500000 USDC"],
    ["bridge 2mm usdc from base to arbitrum", "2000000", "million", "2000000 USDC"],
    ["swap 1 bn bonk to sol", "1000000000", "billion", "1000000000 BONK"],
    ["send 50 cents of usdc to vitalik.eth on base", "0.5", "cents", "0.5 USDC"],
    ["send 1000 sats to vitalik.eth on base", "0.00001", "sats", "0.00001 BTC"],
    ["send 20 gwei to vitalik.eth on base", "0.00000002", "gwei", "0.00000002 ETH"],
    ["swap 5000 lamports to usdc", "0.000005", "lamports", "0.000005 SOL"],
  ] as const) {
    it(`"${text}" reads ${value} (${unit}) with a "Read as" item`, () => {
      const step = first(text);
      assert.deepEqual(step.amount?.v, { t: "exact", value, raw: step.amount?.v.t === "exact" ? step.amount.v.raw : "", rewritten: true, unit });
      assert.equal(step.amount?.prov?.rule, `unit:${unit}`);
      assert.deepEqual(step.readAs?.map((item) => [item.rule, item.to]), [[`unit:${unit}`, readAs]]);
      assert.ok(step.closedClass?.hits.some((hit) => hit.category === "unit"), "the unit stays in the record");
    });
  }

  it("\"$1.5k\" and \"2 million dollars\" are dollar amounts", () => {
    assert.deepEqual(first("swap $1.5k of sol to usdc").amount?.v, { t: "usd", value: "1500" });
    assert.equal(first("send 2 million dollars of usdc to bob.eth on base").amount?.v.t, "exact");
  });

  it("\"50 bps of my usdc\" is a 0.5 % share of the holding", () => {
    const step = first("swap 50 bps of my usdc to eth on base");
    assert.deepEqual(step.amount?.v, { t: "balance", bps: 50 });
    assert.equal(step.amount?.prov?.rule, "unit:bps");
  });

  it("a unit no rule applies to is refused with the unit message, never read without it", () => {
    for (const text of ["swap 2 m sol to usdc", "swap 2m eth to usdc on base", "send 50 cents of eth to bob.eth", "swap 1000 sats of eth to usdc", "swap 50 bps usdc to eth", "swap 20 gwei of sol to usdc"]) {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
      if (error.details) assert.deepEqual(error.details, { closedClass: "unit" }, text);
    }
  });

  it("a unit amount paid to someone else is confirmed before planning; one on the person's own account is a chip", async () => {
    const paid = await say("send 0.01 k usdc to vitalik.eth on base");
    const confirm = paid.decision?.questions.find((question) => question.reason === "INTERPRETATION_CONFIRM");
    assert.ok(confirm, `${paid.error?.message ?? JSON.stringify(paid.decision?.questions.map((question) => question.reason))}`);
    const own = await say("swap 0.01 k usdc to sol");
    const chip = own.decision?.assumptions.find((entry) => entry.label.startsWith("Read as"));
    assert.equal(chip?.label, "Read as 10 USDC (0.01 k)", JSON.stringify(own.decision?.assumptions.map((entry) => entry.label)) + (own.error?.message ?? ""));
    assert.equal(chip?.material, true);
  });
});

/* ----------------------------------------------------------- openers */

describe("question and polite openers (design A.2 questions vs commands)", () => {
  it("reads the opener before normalisation strips it", () => {
    assert.deepEqual(openerOf("can you swap 1 sol to usdc"), { kind: "polite", phrase: "can you" });
    assert.deepEqual(openerOf("hey could you please bridge 10 usdc to base"), { kind: "polite", phrase: "could you please" });
    assert.deepEqual(openerOf("should i swap 1 eth to usdc"), { kind: "question", phrase: "should" });
    assert.deepEqual(openerOf("what if i swap 1 eth"), { kind: "question", phrase: "what" });
    assert.equal(openerOf("swap 1 sol to usdc"), null);
    assert.equal(openerOf("whatever.eth gets 5 usdc"), null);
  });

  for (const text of ["should i swap 1 eth to usdc on base", "is it worth staking 2 sol with jito", "what if i bridge 10 usdc to arbitrum", "would it be better to swap 1 sol to usdc"]) {
    it(`"${text}" is refused as a question, never planned`, () => {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED");
      assert.equal(error.message, CLOSED_CLASS_COPY.question);
    });
  }

  it("a polite command is planned only after a one-click confirm of the solved plan", async () => {
    for (const text of ["can you swap 1 sol to usdc", "could you please bridge 25 usdc from base to solana", "hey can u stake 1 sol with jito"]) {
      const steps = parseSentence(text, []).steps;
      assert.ok(steps.every((step) => step.questionForm === true), text);
      const run = await say(text);
      assert.equal(run.decision?.status, "needs_input", text);
      const confirm = run.decision?.questions[0];
      assert.equal(confirm?.reason, "INTERPRETATION_CONFIRM", text);
      installWallet(corpus, "full");
      const yes = await runTurn(run.decision?.thread ?? null, { answer: { question: confirm?.id as string, option: "confirm" } }, contextOf("full"));
      assert.equal(yes.decision?.status, "ready", `${text}: ${yes.error?.message}`);
    }
  });
});

/* ------------------------------------------------------------ record */

describe("the closed-class record (design A.2 L0, seam S1)", () => {
  it("records never-drop, unit and network words with spans, and look-alike symbols", () => {
    const record = clauseRecord("swap 1.5 k wsol to usdc tomorrow on solana testnet");
    assert.deepEqual(record.hits.map((hit) => [hit.phrase, hit.category]), [["k", "unit"], ["tomorrow", "condition"], ["solana testnet", "network"]]);
    const tomorrow = record.hits.find((hit) => hit.phrase === "tomorrow");
    assert.equal("swap 1.5 k wsol to usdc tomorrow on solana testnet".slice(tomorrow?.start, tomorrow?.end), "tomorrow");
    assert.deepEqual(record.lookalikes.map((entry) => [entry.typed, entry.family]), [["wsol", "sol"]]);
  });

  it("does not read a word inside a name as a closed-class or network word", () => {
    assert.deepEqual(clauseRecord("send 5 usdc to ink.eth on base").hits, []);
    assert.deepEqual(clauseRecord("send 5 usdc to never-mind.eth on base").hits.map((hit) => hit.phrase), []);
    assert.deepEqual(clauseRecord("id like 5 usdc on base").hits, []);
  });

  it("travels on the step with the hits a slot rule consumed", () => {
    const step = first("swap 2 million usdc to eth on base");
    assert.deepEqual(step.closedClass?.hits.map((hit) => hit.phrase), ["million"]);
    assert.deepEqual(first("swap 1 wsol to usdc").closedClass?.lookalikes.map((entry) => entry.typed), ["wsol"]);
    // A clean clause carries no record (nothing for later layers to check).
    assert.equal(first("swap 1 sol to usdc").closedClass, undefined);
  });

  it("names only rules the shared word lists define", async () => {
    const { CLOSED_CLASS_RULES } = await import("@kletia/core");
    for (const rule of READER_RULES) assert.ok(Object.hasOwn(CLOSED_CLASS_RULES, rule), rule);
  });
});
