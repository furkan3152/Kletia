/**
 * Reader noise: what the reader may drop and how it shows it.
 *
 * - Screen: NFKC, invisible and direction characters, arrows ("➡️"), fancy
 *   quotes, "…", emoji (removed and listed as "Ignored: emoji"), repeated
 *   punctuation; a word with letters outside the Latin script is refused.
 * - Reviewed fillers ("lol", "rn", "gm", "thx in advance", "and thats it")
 *   are dropped and listed in the non-material "Ignored" chip; politeness is
 *   dropped silently. A filler next to an amount or right after a
 *   network word is kept, so the clause is not read.
 * - Stretched spellings ("pleaseeee") read as the filler they stretch.
 * - Cashtags: "$SOL" is SOL, "$50" stays fifty dollars.
 * - Lexicon spellings ("w/", "w <venue>", "in2", "thru", "frm", "4rm").
 * - Property: inserting reviewed fillers or emoji never changes the slots;
 *   inserting any other word makes the clause unreadable or is consumed by
 *   a named rule.
 *
 * Paraphrases are written for this test (never copied from the holdout).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision } from "../clarify/index.js";
import { parseSentence, readCashtags } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { dropFillers, unstretch } from "../goal/closedClass.js";
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

/** The slots that carry meaning, for comparing two readings. */
function slots(steps: readonly WorkStep[]): unknown[] {
  return steps.map((step) => ({
    kind: step.kind?.v,
    amount: step.amount?.v.t === "exact" ? step.amount.v.value : step.amount?.v,
    from: step.from?.v.toUpperCase(),
    to: step.to?.v.toUpperCase(),
    network: step.network?.v,
    toNetwork: step.toNetwork?.v,
    recipient: step.recipient?.v,
    protocol: step.protocol?.v,
    provider: step.provider?.v,
    goal: step.goal?.kind,
  }));
}

/* ----------------------------------------------------------- screen */

describe("screen", () => {
  it("reads arrows with an emoji variation selector as \"to\"", () => {
    const steps = parseSentence("50 usdc base➡️solana", []).steps;
    assert.deepEqual(slots(steps), slots(parseSentence("50 usdc base to solana", []).steps));
  });

  it("removes emoji and lists them as ignored, never as meaning", async () => {
    for (const text of ["stake 2 sol w/ marinade 🔥🔥", "swap 1 sol to usdc 💸", "🚀 swap 1 sol to usdc"]) {
      const step = parseSentence(text, []).steps[0] as WorkStep;
      assert.ok(step.ignored?.includes("emoji"), text);
    }
    const run = await say("swap 1 sol to usdc 💸💸");
    assert.equal(run.decision?.status, "ready", run.error?.message);
    assert.equal(shape(run.decision?.actions ?? []), "swap@solana 1 SOL->USDC");
    const chip = run.decision?.assumptions.find((entry) => entry.label.startsWith("Ignored"));
    assert.equal(chip?.label, "Ignored: emoji");
    assert.equal(chip?.material, false);
  });

  it("reads \"…\", fancy quotes, dashes and invisible characters as plain text", () => {
    const plain = slots(parseSentence("bridge 20 usdc from base to arbitrum then swap to eth", []).steps);
    assert.deepEqual(slots(parseSentence("bridge 20 usdc from base to arbitrum… then swap to eth", []).steps), plain);
    assert.deepEqual(slots(parseSentence("bridge 20​ usdc from base to arbitrum then swap to eth", []).steps), plain);
    assert.deepEqual(slots(parseSentence("bridge 20 usdc from ‮base to arbitrum then swap to eth", []).steps), plain);
    assert.deepEqual(slots(parseSentence("swap 1 sol to usdc", []).steps), slots(parseSentence("“swap” 1 sol to usdc", []).steps));
  });

  it("refuses a word with letters outside the Latin script (homoglyph tickers)", () => {
    for (const text of ["swap 1 sol to USDС", "send 5 usdс to vitalik.eth on base", "swap 1 ЕТН to usdc on base", "swap 1 sοl to usdc"]) {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
      assert.match(error.message, /Latin letters/u, text);
    }
  });
});

/* ---------------------------------------------------------- fillers */

describe("reviewed fillers", () => {
  for (const [text, ignored] of [
    ["swap 1 sol for usdc lol", ["lol"]],
    ["swap 1 sol to usdc rn", ["rn"]],
    ["gm! swap 0.5 sol to usdc", ["gm"]],
    ["ok so swap 1 sol to usdc and thats it", ["ok so", "and thats it"]],
    ["basically swap 1 sol to usdc", ["basically"]],
    ["swap my idle usdc to sol on solana", ["idle"]],
  ] as const) {
    it(`"${text}" drops ${ignored.join(", ")} and lists it`, () => {
      const steps = parseSentence(text, []).steps;
      assert.deepEqual([...(steps[0]?.ignored ?? [])].sort(), [...ignored].sort());
    });
  }

  it("drops politeness silently (it never carries meaning)", () => {
    for (const text of ["swap 1 sol to usdc, thx in advance!!", "swap 1 sol to usdc please", "swap 1 sol to usdc thanks a lot", "swap 1 sol to usdc pls"]) {
      const step = parseSentence(text, []).steps[0] as WorkStep;
      assert.equal(step.ignored, undefined, text);
      assert.deepEqual(slots([step]), slots(parseSentence("swap 1 sol to usdc", []).steps), text);
    }
  });

  it("keeps a filler next to an amount: the clause is not read as the bare number", () => {
    for (const text of ["swap some 50 usdc to eth on base", "swap just 2 sol to usdc", "swap 1 sol lol 2 usdc"]) {
      assert.throws(() => parseSentence(text, []), (error: Error & { code?: string }) => error.code === "INTENT_UNSUPPORTED", text);
    }
  });

  it("keeps a filler right after a network word (only clause-final politeness may follow one)", () => {
    for (const [text, word] of [["bridge 10 usdc from base to arbitrum lol", "lol"], ["swap 1 eth to usdc on base rn", "rn"], ["bridge 5 usdc to polygon basically", "basically"]] as const) {
      // Kept means read or refused, never dropped: refused, or still in the reading (an unknown token asked as a typo).
      try {
        const steps = parseSentence(text, []).steps;
        assert.equal(steps[0]?.ignored, undefined, text);
        assert.ok(steps.some((step) => step.assetTypo?.raw === word || step.to?.v === word || step.from?.v === word), `${text}: ${JSON.stringify(slots(steps))}`);
      } catch (error) {
        assert.ok(isPlatformError(error) && error.code === "INTENT_UNSUPPORTED", text);
      }
    }
    assert.equal(parseSentence("bridge 10 usdc from base to arbitrum please", []).steps.length, 1);
    assert.equal(parseSentence("bridge 10 usdc from base to arbitrum thx", []).steps.length, 1);
  });

  it("keeps \"u\" in \"can u\" and \"like\" in \"i'd like\"", () => {
    assert.equal(dropFillers("can u swap 1 sol to usdc").text, "can u swap 1 sol to usdc");
    assert.deepEqual(dropFillers("id like 5 usdc on base").ignored, []);
    assert.equal(dropFillers("swap like all my sol to usdc").text, "swap all my sol to usdc");
  });

  it("reads stretched spellings only into a filler or greeting", () => {
    assert.equal(unstretch("pleaseeee"), "please");
    assert.equal(unstretch("sooo"), "so");
    assert.equal(unstretch("lolll"), "lol");
    assert.equal(unstretch("thxxx"), "thx");
    assert.equal(unstretch("swaaap"), "swaaap");
    assert.equal(unstretch("usdccc"), "usdccc");
    assert.deepEqual(slots(parseSentence("swap 1 sol to usdc pleaseeee", []).steps), slots(parseSentence("swap 1 sol to usdc", []).steps));
  });
});

/* -------------------------------------------------- spellings, tags */

describe("lexicon spellings and cashtags", () => {
  it("reads \"w/\", \"w <venue>\", \"in2\", \"thru\", \"frm\" and \"4rm\" as their connectors (no correction)", () => {
    for (const [text, plain] of [
      ["stake 2 sol w/ marinade", "stake 2 sol with marinade"],
      ["stake 2 sol w/marinade", "stake 2 sol with marinade"],
      ["stake 0.5 eth w rocketpool", "stake 0.5 eth with rocketpool"],
      ["i wanna stake 2 sol w jito pls", "stake 2 sol with jito"],
      ["deposit 100 usdc in2 aave on base", "deposit 100 usdc into aave on base"],
      ["bridge 25 usdc frm base to arbitrum", "bridge 25 usdc from base to arbitrum"],
      ["bridge 25 usdc 4rm base to arbitrum", "bridge 25 usdc from base to arbitrum"],
      ["swap 100 usdc for weth on base w/ uniswap", "swap 100 usdc for weth on base with uniswap"],
    ] as const) {
      const read = parseSentence(text, []);
      assert.deepEqual(slots(read.steps), slots(parseSentence(plain, []).steps), text);
      assert.deepEqual(read.corrections, [], text);
      assert.equal(read.steps[0]?.source, undefined, text);
    }
  });

  it("reads \"$SOL\" as SOL and keeps \"$50\" as fifty dollars", async () => {
    assert.equal(readCashtags("swap 1 $SOL to $USDC"), "swap 1 SOL to USDC");
    assert.equal(readCashtags("buy $50 of $sol"), "buy $50 of sol");
    assert.equal(readCashtags("swap 1 $NOTATOKEN to usdc"), "swap 1 $NOTATOKEN to usdc");
    const run = await say("swap 1 $SOL to $USDC");
    assert.equal(run.decision?.status, "ready", run.error?.message);
    assert.equal(shape(run.decision?.actions ?? []), "swap@solana 1 SOL->USDC");
  });
});

/* --------------------------------------------------------- property */

/** A small deterministic generator (no Math.random: the same run every time). */
function* sequence(seed: number): Generator<number> {
  let state = seed >>> 0;
  for (;;) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    yield state;
  }
}

const CLEAN = [
  "swap 1 sol to usdc",
  "bridge 25 usdc from base to arbitrum",
  "send 5 usdc to vitalik.eth on base",
  "stake 2 sol with jito",
  "deposit 100 usdc into aave on base",
  "swap 0.5 eth to usdc on arbitrum",
];
const START_FILLERS = ["lol", "gm", "basically", "ok so", "kindly", "so basically"];
const END_FILLERS = ["lol", "rn", "and thats it", "thx in advance", "for me", "real quick"];
const EMOJI = ["🔥", "💸💸", "🚀", "✅"];
/** Words no rule reads: inserting one anywhere must leave the clause unread (or be consumed by a rule). */
const STRANGERS = ["dont", "tomorrow", "maybe", "or", "never", "if", "banana", "quickly2", "unless", "except", "under"];

describe("no silent drop (property)", () => {
  it("reviewed fillers and emoji never change the slots, and every dropped filler is listed", () => {
    const next = sequence(20261023);
    for (let round = 0; round < 120; round += 1) {
      const clean = CLEAN[(next.next().value as number) % CLEAN.length] as string;
      const start = START_FILLERS[(next.next().value as number) % START_FILLERS.length] as string;
      const end = END_FILLERS[(next.next().value as number) % END_FILLERS.length] as string;
      const emoji = EMOJI[(next.next().value as number) % EMOJI.length] as string;
      const shapeOf = (next.next().value as number) % 3;
      // "for me" / "real quick" after a network word are kept by design: only clean clauses that end in a token get them.
      const endsInNetwork = /\b(?:base|arbitrum|solana)$/u.test(clean);
      const noisy = shapeOf === 0 ? `${start} ${clean}` : shapeOf === 1 && !endsInNetwork ? `${clean} ${end}` : `${clean} ${emoji}`;
      const read = parseSentence(noisy, []);
      assert.deepEqual(slots(read.steps), slots(parseSentence(clean, []).steps), noisy);
      const ignored = read.steps[0]?.ignored ?? [];
      if (shapeOf === 0) assert.ok(ignored.includes(start), `${noisy}: ${ignored.join(", ")}`);
      if (shapeOf === 2 || (shapeOf === 1 && endsInNetwork)) assert.ok(ignored.includes("emoji"), noisy);
    }
  });

  it("any other inserted word leaves the clause unread (refused), never dropped", () => {
    const next = sequence(7);
    for (let round = 0; round < 120; round += 1) {
      const clean = CLEAN[(next.next().value as number) % CLEAN.length] as string;
      const stranger = STRANGERS[(next.next().value as number) % STRANGERS.length] as string;
      const words = clean.split(" ");
      const at = (next.next().value as number) % (words.length + 1);
      const noisy = [...words.slice(0, at), stranger, ...words.slice(at)].join(" ");
      let read: ReturnType<typeof parseSentence> | null = null;
      try {
        read = parseSentence(noisy, []);
      } catch (error) {
        assert.ok(isPlatformError(error), noisy);
        continue;
      }
      // A reading survives only when a named rule consumed the word: it shows in the step's closed-class record.
      const consumed = read.steps.some((step) => (step.closedClass?.hits ?? []).some((hit) => noisy.toLowerCase().includes(hit.phrase)));
      assert.ok(consumed, `"${noisy}" was read with "${stranger}" dropped: ${JSON.stringify(slots(read.steps))}`);
    }
  });
});
