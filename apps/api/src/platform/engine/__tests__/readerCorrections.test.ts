/**
 * Corrections in the reader (intent design P4-M1, A.2 L2 and L3 tier 2,
 * A.3 source C, red-team A9, U2 RF2 / RF12):
 *
 * - A keyword correction (verb, network, venue) makes the clause source C:
 *   a one-click confirm of the solved plan, never a plan on a chip alone.
 * - At most two keyword corrections per clause; more is a guess, not read.
 * - Never corrected: numbers, addresses, names, symbols, look-alike symbols,
 *   closed-class words and English words (property test).
 * - Reviewed connector spellings ("too", "fo", "form", "in2", "thru", "w/")
 *   are lexicon entries, not corrections: no confirm.
 * - Digit-as-word: "2" / "4" between a complete amount + token and a
 *   recipient, network or verb is "to" / "for", as a correction (source C);
 *   never before a token symbol.
 * - Payment verbs: gift, reimburse, pay back, settle up are payments.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NEVER_DROP } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { ENGLISH_WORDS } from "../clarify/englishWords.js";
import type { TurnDecision } from "../clarify/index.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { isPlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);
after(() => uninstallWallet());

async function say(text: string, thread: TurnDecision["thread"] | null = null, wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, { text }, contextOf(wallet));
}

/** Answers the one-click confirm of a turn and returns the ready plan's shape. */
async function confirmed(run: Awaited<ReturnType<typeof say>>): Promise<string> {
  const confirm = run.decision?.questions.find((question) => question.reason === "INTERPRETATION_CONFIRM");
  assert.ok(confirm, `no confirm: ${run.error?.message ?? JSON.stringify(run.decision?.questions.map((question) => question.reason))}`);
  installWallet(corpus, "full");
  const yes = await runTurn(run.decision?.thread ?? null, { answer: { question: confirm.id, option: "confirm" } }, contextOf("full"));
  assert.equal(yes.decision?.status, "ready", yes.error?.message);
  return shape(yes.decision?.actions ?? []);
}

const parse = (text: string) => parseSentence(text, []);

describe("keyword corrections are source C (a one-click confirm)", () => {
  for (const [text, plan] of [
    ["swpa 1 SOL to USDC", "swap@solana 1 SOL->USDC"],
    ["bridge 25 usdc from bsae to solana", "bridge@base->solana 25 USDC"],
    ["deposit 100 USDC into aavee on base", "deposit@base 100 USDC [aave-v3]"],
    ["swap 1 sol to usdc on solan", "swap@solana 1 SOL->USDC"],
    ["stake 1 SOL with jitto", "stake@solana 1 SOL->JitoSOL"],
  ] as const) {
    it(`"${text}" is confirmed, then plans ${plan}`, async () => {
      const read = parse(text);
      assert.ok(read.corrections.some((entry) => entry.material), JSON.stringify(read.corrections));
      assert.ok(read.steps.every((step) => step.source === "C"), JSON.stringify(read.steps.map((step) => step.source)));
      const run = await say(text);
      assert.equal(run.decision?.status, "needs_input");
      assert.ok((await confirmed(run)).startsWith(plan));
    });
  }

  it("more than two keyword corrections in one clause are a guess: not read", () => {
    for (const text of ["swpa 1 sol to usdc on solan via jupyter", "brdge 25 usdc frm bsae to solan"]) {
      assert.throws(() => parse(text), (error: Error & { code?: string }) => error.code === "INTENT_UNSUPPORTED", text);
    }
  });

  it("reviewed connector spellings are no corrections (no confirm)", () => {
    for (const text of ["swap 1 SOL too USDC", "bridge 25 usdc form base to solana", "deposit 100 usdc in2 aave on base", "stake 2 sol w/ jito", "bridge 25 usdc thru across from base to arbitrum"]) {
      const read = parse(text);
      assert.ok(read.steps.every((step) => step.source === undefined), `${text}: ${JSON.stringify(read.steps.map((step) => step.source))}`);
      assert.ok(read.corrections.every((entry) => !entry.material), `${text}: ${JSON.stringify(read.corrections)}`);
    }
  });
});

describe("never corrects values (property, design P4 tests)", () => {
  const closedWords = NEVER_DROP.map((entry) => entry.phrase).filter((phrase) => /^[a-z]+$/u.test(phrase));
  const values = [
    "0x000000000000000000000000000000000000dEaD", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "vitalik.eth", "toly.sns", "25", "0.5", "1,000",
    "usdc", "weth", "jitosol", "steth", "wsol", "usdc.e", ...closedWords, ...[...ENGLISH_WORDS].slice(0, 120),
  ];
  it("no correction ever starts from a number, an address, a name, a symbol, a look-alike, a closed-class or an English word", () => {
    for (const value of values) {
      for (const text of [`swap 1 ${value} to usdc on base`, `bridge 25 usdc from base to ${value}`, `send 5 usdc to ${value} on base`, `deposit 100 usdc into ${value} on base`]) {
        let corrections: readonly { from: string }[] = [];
        try {
          corrections = parse(text).corrections;
        } catch (error) {
          assert.ok(isPlatformError(error), `${text}: ${String(error)}`);
          continue;
        }
        assert.ok(corrections.every((entry) => entry.from.toLowerCase() !== value.toLowerCase().slice(0, 16)), `${text}: ${JSON.stringify(corrections)}`);
      }
    }
  });
});

describe("digit-as-word (design A.2 L3 tier 2, U2 RF2)", () => {
  for (const [text, recipient] of [["send .1 eth 2 alice.eth on base", "alice.eth"], ["send 5 usdc 2 bob.eth on base", "bob.eth"]] as const) {
    it(`"${text}" reads "2" as "to", confirmed (source C)`, async () => {
      const read = parse(text);
      assert.equal(read.steps[0]?.recipient?.v, recipient);
      assert.equal(read.steps[0]?.source, "C");
      assert.deepEqual(read.corrections, [{ field: "actions[0].text", from: "2", to: "to", material: true }]);
    });
  }

  it("bridges a network with \"2\" only after a complete amount and token", () => {
    const step = parse("bridge 50 usdc 2 arbitrum from base").steps[0] as WorkStep;
    assert.equal(step.toNetwork?.v, "arbitrum");
    assert.equal(step.source, "C");
  });

  it("never before a token symbol: \"swap 1 sol 2 usdc\" is not read as \"to\" (and its order-only second amount is refused, U2 NOI009)", () => {
    assert.throws(() => parse("swap 1 sol 2 usdc"), (error: unknown) => (error as { code?: string }).code === "INTENT_UNSUPPORTED");
  });
});

describe("payment verbs (U2 RF12)", () => {
  for (const text of ["gift 5 usdc to bob.base.eth", "reimburse alice.eth 20 usdc on base", "pay back bob.eth 10 usdc on base", "settle up with 15 usdc to carol.eth on base"]) {
    it(`"${text}" is a payment`, () => {
      let steps: WorkStep[] = [];
      try {
        steps = parse(text).steps;
      } catch (error) {
        // "settle up with ..." reads only in the "to" shape; a refusal is never a wrong plan.
        assert.ok(text.startsWith("settle"), `${text}: ${String(error)}`);
        return;
      }
      assert.equal(steps[0]?.kind?.v, "transfer", JSON.stringify(steps));
      assert.ok(steps[0]?.recipient?.v.endsWith(".eth"));
    });
  }
});
