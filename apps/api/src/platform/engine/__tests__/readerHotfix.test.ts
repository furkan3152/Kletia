/**
 * Reader fixes: the live wrong readings the red-team probe found in the
 * deterministic reader, each with paraphrases.
 *
 * - "half a sol" is 0.5 SOL (token units), never half the balance; a
 *   fraction with no exact decimal ("a third of a sol") is not read.
 * - A message with a question mark is never ready (read-only answer,
 *   refusal, or a confirm of the solved plan), in the clarify
 *   reader and in the strict grammar.
 * - "over" is no filler: "swap over 100 USDC" is not read as "swap 100 USDC";
 *   "over to" / "over from" stay connector spellings.
 * - No keyword correction into an English word: "on case" is not "on base".
 * - "buy 100 USDC of ETH" takes the worth reading (spend 100 USDC on ETH)
 *   inside the D12 confirm, never the reversed reading.
 * - "it" after a payment to someone else is refused; an unworded next step
 *   is not chained to that payment.
 * - "move 10 USDC to op" (a neutral verb, a word that names a token and a
 *   network, no source network) is refused with both phrasings.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSETS } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { ENGLISH_WORDS, isEnglishWord, REVIEWED_KEYWORDS } from "../clarify/englishWords.js";
import { candidates, keywordCandidates } from "../clarify/fuzzy.js";
import type { TurnDecision } from "../clarify/index.js";
import { KEYWORD_VOCABULARY, parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { knownSymbol } from "../clarify/catalog.js";
import { ASSET_NETWORK_WORDS, compileIntentText, resolveNetworkName } from "../grammar.js";
import { lex, normalizeClause, readGoals, type Token } from "../goal/index.js";
import { CONNECTOR_VARIANTS, FILLER_WORDS } from "../goal/lexicon.js";
import { hasQuestionMark } from "../readOnly.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

/* ------------------------------------------------------------ helpers */

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);

after(() => uninstallWallet());

/** One turn with a corpus wallet ("full": SOL and USDC on Solana, ETH and USDC on Base and Arbitrum). */
async function say(text: string, thread: TurnDecision["thread"] | null = null, wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, { text }, contextOf(wallet));
}

/** The refusal a call throws. */
function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return error;
    throw error;
  }
  assert.fail("expected a refusal");
}

const amountOf = (tokens: readonly Token[]) => tokens.find((token): token is Extract<Token, { t: "AMOUNT" }> => token.t === "AMOUNT");
const lexed = (text: string) => lex(normalizeClause(text));

/* ------------------------------------------------- token-unit fractions */

describe("token-unit fractions", () => {
  for (const [text, value, symbol] of [
    ["swap half a sol to usdc", "0.5", "sol"],
    ["swap half an eth to usdc on base", "0.5", "eth"],
    ["swap a quarter of a sol to usdc", "0.25", "sol"],
    ["sell quarter of an eth for usdc on base", "0.25", "eth"],
    ["swap half of a sol to usdc", "0.5", "sol"],
    ["swap three quarters of a sol to usdc", "0.75", "sol"],
    ["stake a tenth of a sol with jito", "0.1", "sol"],
  ] as const) {
    it(`"${text}" reads ${value} ${symbol.toUpperCase()}, not a share of the balance`, () => {
      const tokens = lexed(text);
      const amount = amountOf(tokens);
      assert.deepEqual(amount?.sel, { t: "exact", value });
      assert.equal(amount?.rewritten, true);
      assert.equal(amount?.readAs, `${value} ${symbol.toUpperCase()}`);
      const next = tokens[tokens.indexOf(amount as Token) + 1];
      assert.equal(next?.t === "ASSET" ? next.symbol.toLowerCase() : next?.t, symbol);
    });
  }

  it("keeps portions where the words say one: my, of my, the, of it", () => {
    for (const text of ["swap half my sol to usdc", "swap half of my sol to usdc", "swap half the sol to usdc", "swap a quarter of my eth to usdc"]) {
      assert.equal(amountOf(lexed(text))?.sel.t, "portion", text);
    }
  });

  it("does not read a fraction with no exact decimal, or a fraction of a dollar or a class", () => {
    for (const text of ["swap a third of a sol to usdc", "swap two thirds of an eth to usdc", "send half a dollar to vitalik.eth on base", "swap half a stablecoin to sol"]) {
      const tokens = lexed(text);
      assert.ok(tokens.some((token) => token.t === "NOISE"), text);
      assert.equal(readGoals(text)[0], null, text);
    }
  });

  it("the Goal carries the exact amount and the material rewrite", () => {
    const [read] = readGoals("swap half a sol to usdc");
    assert.deepEqual(read?.goal.spend.amount, { t: "exact", value: "0.5" });
    assert.deepEqual(read?.notes.rewritten, { from: "half a sol", to: "0.5 SOL" });
    const [long] = readGoals("swap a quarter of an eth to usdc on base");
    assert.ok((long?.notes.rewritten?.from.length ?? 99) <= 16, "the chip quotes at most 16 characters");
  });

  it("\"swap half a sol to usdc\" plans 0.5 SOL with a material chip (live wrong plan: 1.25 SOL)", async () => {
    const run = await say("swap half a sol to usdc");
    assert.ok(run.decision, run.error?.message);
    assert.equal(run.decision.status, "ready");
    assert.equal(shape(run.decision.actions ?? []), "swap@solana 0.5 SOL->USDC");
    const chip = run.decision.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(chip?.label, "\"half a sol\" read as 0.5 SOL");
    assert.equal(chip?.material, true);
  });

  it("\"stake half a sol\" stakes 0.5 SOL; \"swap a third of a sol to usdc\" is refused", async () => {
    const stake = await say("stake half a sol");
    assert.ok(stake.decision, stake.error?.message);
    assert.match(shape(stake.decision.actions ?? []), /^stake@solana 0\.5 SOL->/u);
    const third = await say("swap a third of a sol to usdc");
    assert.equal(third.decision, undefined);
    assert.equal(third.error?.code, "INTENT_UNSUPPORTED");
  });
});

/* -------------------------------------------------------- question mark */

describe("a question mark is never ready", () => {
  it("detects question marks in any script", () => {
    for (const text of ["swap 1 sol?", "swap 1 sol？", "¿swap 1 sol", "swap 1 sol ﹖"]) assert.equal(hasQuestionMark(text), true, text);
    assert.equal(hasQuestionMark("swap 1 sol to usdc."), false);
  });

  // A command with a trailing question mark is read, but only as a confirm of the solved plan (questionForm).
  for (const text of [
    "swap 0.01 eth to usdc on base?",
    "can you swap 1 sol to usdc?",
    "bridge 20 usdc from base to arbitrum？",
    "send 5 usdc to vitalik.eth on base??",
  ]) {
    it(`"${text}" is never ready: a confirm of the solved plan`, async () => {
      const run = await say(text);
      assert.ok(run.decision, run.error?.message);
      assert.equal(run.decision.status, "needs_input");
      assert.ok(run.decision.questions.some((question) => question.reason === "INTERPRETATION_CONFIRM"), JSON.stringify(run.decision.questions.map((q) => q.reason)));
    });
  }

  it('"swap 1 sol to usdc? thanks" is refused: text after the mark is not an instruction', async () => {
    const run = await say("swap 1 sol to usdc? thanks");
    assert.equal(run.decision, undefined);
    assert.equal(run.error?.code, "INTENT_UNSUPPORTED");
    assert.match(run.error?.message ?? "", /question/u);
  });

  it("a rate question with a question mark keeps its read-only answer", () => {
    const error = refusal(() => parseSentence("what's the best yield for usdc on base?", []));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.equal((error.details as { readOnly?: string } | undefined)?.readOnly, "venues");
  });

  it("the strict grammar refuses the same text it plans without the mark", () => {
    const error = refusal(() => compileIntentText("swap 0.01 ETH to USDC on base?"));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /question/u);
    assert.equal(compileIntentText("swap 0.01 ETH to USDC on base").actions[0]?.amount, "0.01");
  });
});

/* ------------------------------------------------------------- "over" */

describe("\"over\" is not a filler", () => {
  it("is out of FILLER_WORDS and lexes as NOISE before an amount", () => {
    assert.equal(FILLER_WORDS.has("over"), false);
    assert.ok(lexed("swap over 100 usdc to eth on base").some((token) => token.t === "NOISE" && token.raw === "over"));
  });

  for (const text of ["swap over 100 usdc to eth on base", "send over 50 usdc to vitalik.eth on base", "bridge over 10 usdc from base to arbitrum"]) {
    it(`"${text}" is refused (live: read as exactly the amount)`, async () => {
      const run = await say(text);
      assert.equal(run.decision, undefined, `not a decision: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED");
    });
  }

  it("\"over to\" and \"over from\" are connector spellings", async () => {
    assert.deepEqual(CONNECTOR_VARIANTS, { "over to": "to", "over from": "from" });
    const to = await say("hey move 25 USDC from base over to solana");
    assert.equal(shape(to.decision?.actions ?? []), "bridge@base->solana 25 USDC");
    // Asked politely ("could you ..."), the same sentence is planned only after a one-click confirm.
    const polite = await say("hey could you move 25 USDC from base over to solana");
    assert.equal(polite.decision?.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    const from = await say("port 10 USDC over from arbitrum to base");
    assert.equal(shape(from.decision?.actions ?? []), "bridge@arbitrum->base 10 USDC");
  });
});

/* ------------------------------------------------------- English words */

describe("no keyword correction into an English word", () => {
  it("lists the probe's words and none of the keywords", () => {
    for (const word of ["case", "vase", "bass", "delay", "ora", "bride", "form"]) {
      assert.equal(isEnglishWord(word), true, word);
    }
    for (const keyword of REVIEWED_KEYWORDS) assert.equal(ENGLISH_WORDS.has(keyword), false, keyword);
    for (const word of ENGLISH_WORDS) assert.match(word, /^[a-z]{3,}$/u, word);
  });

  it("was reviewed against today's keyword vocabulary (drift: review englishWords.ts when a keyword is added)", () => {
    assert.deepEqual([...new Set(KEYWORD_VOCABULARY)].sort(), [...new Set(REVIEWED_KEYWORDS)].sort());
  });

  it("keywordCandidates leaves English words alone and still fixes slips that are not words", () => {
    const networks = ["base", "arbitrum", "solana"];
    assert.deepEqual(candidates("case", networks), ["base"]);
    assert.deepEqual(keywordCandidates("case", networks), []);
    assert.deepEqual(keywordCandidates("Vase", networks), []);
    assert.deepEqual(keywordCandidates("bsae", networks), ["base"]);
    assert.deepEqual(keywordCandidates("delay", ["relay", "across"]), []);
    assert.deepEqual(keywordCandidates("ora", ["orca"]), []);
  });

  for (const text of ["deposit 100 usdc into aave on case", "bridge 10 usdc from base to arbitrum via delay", "swap 1 sol to usdc via ora", "deposit 100 usdc into aave on vase"]) {
    it(`"${text}" is refused, not corrected`, async () => {
      const run = await say(text);
      assert.equal(run.decision, undefined, `not a decision: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED");
    });
  }

  it("a slip that is not a word is still corrected (\"bsae\"), and the correction is confirmed (source C)", async () => {
    const run = await say("deposit 100 usdc into aave on bsae");
    assert.ok(run.decision, run.error?.message);
    const confirm = run.decision.questions[0];
    assert.equal(confirm?.reason, "INTERPRETATION_CONFIRM");
    installWallet(corpus, "full");
    const yes = await runTurn(run.decision.thread, { answer: { question: confirm.id, option: "confirm" } }, contextOf("full"));
    assert.ok(yes.decision, yes.error?.message);
    assert.match(shape(yes.decision.actions ?? []), /^deposit@base 100 USDC/u);
  });

  it("an English word is never corrected into a verb; two close verbs are still asked", async () => {
    for (const text of ["sway 1 sol to usdc", "bend 5 usdc to vitalik.eth on base", "trace 1 sol to usdc"]) {
      const run = await say(text);
      assert.equal(run.decision, undefined, `${text}: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED", text);
    }
    const both = await say("bend 5 USDC on base");
    assert.ok(both.decision, both.error?.message);
    assert.equal(both.decision.questions[0]?.reason, "VERB_AMBIGUOUS");
  });

  it("\"form\" stays a reviewed spelling of the connector \"from\" (no value changes)", async () => {
    const run = await say("bridge 25 USDC form base to solana");
    assert.equal(shape(run.decision?.actions ?? []), "bridge@base->solana 25 USDC");
    assert.equal(run.decision?.assumptions.some((entry) => entry.source === "correction"), false);
  });
});

/* ------------------------------------------------- "<amount> <stable> of" */

describe("\"buy 100 USDC of ETH\" is the worth reading, confirmed", () => {
  for (const [text, spend, amount, want] of [
    ["buy 100 usdc of eth on base", "usdc", "100", "eth"],
    ["buy 100 usdc worth of eth on base", "usdc", "100", "eth"],
    ["get 50 usdt of sol", "usdt", "50", "sol"],
    ["purchase 20 dai of eth on base", "dai", "20", "eth"],
    ["get me 25 usdc of jitosol", "usdc", "25", "jitosol"],
  ] as const) {
    it(`"${text}" spends ${amount} ${spend.toUpperCase()} on ${want.toUpperCase()}`, () => {
      const [read] = readGoals(text);
      assert.ok(read, text);
      assert.equal(read.goal.kind, "convert");
      assert.deepEqual(read.goal.spend.asset, { symbol: spend });
      assert.deepEqual(read.goal.spend.amount, { t: "exact", value: amount });
      assert.deepEqual(read.goal.want.asset, { symbol: want });
      assert.equal(read.goal.want.amount, undefined);
      assert.equal(read.notes.orderOnly, true, "confirmed before planning");
      assert.equal(read.notes.worthIdiom, true);
    });
  }

  it("asks INTERPRETATION_CONFIRM with the worth reading, and plans it once confirmed", async () => {
    const first = await say("buy 100 usdc of eth on base");
    assert.ok(first.decision, first.error?.message);
    assert.equal(first.decision.status, "needs_input");
    const q = first.decision.questions[0];
    assert.equal(q?.reason, "INTERPRETATION_CONFIRM");
    assert.match(q?.prompt ?? "", /^Swap 100 USDC to ETH on Base/u);
    installWallet(corpus, "full");
    const confirmed = await runTurn(first.decision.thread, { answer: { question: q?.id as string, option: "confirm" } }, contextOf("full"));
    assert.ok(confirmed.decision, confirmed.error?.message);
    assert.equal(confirmed.decision.status, "ready");
    assert.equal(shape(confirmed.decision.actions ?? []), "swap@base 100 USDC->ETH");
  });

  it("leaves other buy shapes as they were", () => {
    const [withFunds] = readGoals("buy eth with 100 usdc on base");
    assert.deepEqual(withFunds?.goal.spend.asset, { symbol: "usdc" });
    assert.equal(withFunds?.notes.worthIdiom, undefined);
    const [dollars] = readGoals("buy $100 of eth on base");
    assert.equal(dollars?.notes.worthIdiom, undefined);
    assert.deepEqual(dollars?.goal.want.asset, { symbol: "eth" });
  });
});

/* ---------------------------------------- "it" after a payment to others */

describe("\"it\" after a payment to someone else", () => {
  for (const text of [
    "send 10 usdc to vitalik.eth on base and swap it to eth",
    "send 10 usdc to vitalik.eth on base, then swap half of it to eth",
    "pay vitalik.eth 5 usdc on base then swap that to eth",
    "transfer 5 usdc to vitalik.eth on base and then bridge it to arbitrum",
    "send 10 usdc to my friend on base then swap it to eth",
  ]) {
    it(`"${text}" is refused (live: ready, then unplannable)`, async () => {
      const run = await say(text);
      assert.equal(run.decision, undefined, `not a decision: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED");
      assert.match(run.error?.message ?? "", /pays someone else/u);
    });
  }

  it("a next step with no amount and no token is not chained to the payment: it asks", async () => {
    const run = await say("send 10 usdc to vitalik.eth on base then swap to eth");
    assert.ok(run.decision, run.error?.message);
    assert.equal(run.decision.status, "needs_input");
    assert.ok(run.decision.questions.some((q) => q.field.startsWith("actions[1].")));
    const parsed = parseSentence("send 10 usdc to vitalik.eth on base then stake", []);
    assert.equal(parsed.steps[1]?.amount, undefined, "stake is not chained to the payment");
  });

  it("the thread's last step counts when the caller passes it", () => {
    const paid: WorkStep = { kind: { v: "transfer", by: "user" }, recipient: { v: "vitalik.eth", by: "user" }, amount: { v: { t: "exact", value: "10" }, by: "user" }, from: { v: "USDC", by: "user" } };
    const error = refusal(() => parseSentence("swap it to eth", [], true, 1, paid));
    assert.match(error.message, /pays someone else/u);
    const own: WorkStep = { kind: { v: "swap", by: "user" }, amount: { v: { t: "exact", value: "1" }, by: "user" }, from: { v: "SOL", by: "user" }, to: { v: "USDC", by: "user" } };
    assert.deepEqual(parseSentence("swap it to eth", [], true, 1, own).steps[0]?.amount?.v, { t: "previous", bps: 10_000 });
  });

  it("\"it\" after the person's own step still binds to its output", () => {
    const parsed = parseSentence("swap 1 sol to usdc then send it to vitalik.eth", []);
    assert.deepEqual(parsed.steps[1]?.amount?.v, { t: "previous", bps: 10_000 });
  });
});

/* ------------------------------------- neutral verbs and token/network words */

describe("\"move 10 usdc to op\" is refused with both phrasings (F-1)", () => {
  it("names only words that are both a listed token and a network", () => {
    for (const [word, entry] of Object.entries(ASSET_NETWORK_WORDS)) {
      assert.equal(knownSymbol(word), true, word);
      assert.equal(resolveNetworkName(word), entry.network, word);
    }
    assert.ok(ASSETS.some((asset) => asset.symbol === "OP"));
  });

  for (const [text, bridge, swap] of [
    ["move 10 usdc to op", "bridge 10 USDC to optimism", "swap 10 USDC to OP"],
    ["send 10 usdc to sol", "bridge 10 USDC to solana", "swap 10 USDC to SOL"],
    ["transfer 5 usdc to arb", "bridge 5 USDC to arbitrum", "swap 5 USDC to ARB"],
    ["move my usdc into op", "bridge 10 USDC to optimism", "swap 10 USDC to OP"],
  ] as const) {
    it(`"${text}" is refused with "${bridge}" and "${swap}"`, async () => {
      const run = await say(text);
      assert.equal(run.decision, undefined, `not a decision: ${run.decision ? shape(run.decision.actions ?? []) : ""}`);
      assert.equal(run.error?.code, "INTENT_UNSUPPORTED");
      assert.ok(run.error?.message.includes(bridge), run.error?.message);
      assert.ok(run.error?.message.includes(swap), run.error?.message);
    });
  }

  it("keeps the network reading after \"from <network>\", with \"as <token>\", for a bridge verb and a full network name", async () => {
    assert.equal(shape((await say("move 10 usdc from base to op")).decision?.actions ?? []), "bridge@base->optimism 10 USDC");
    assert.equal(shape((await say("move 10 usdc to op from base")).decision?.actions ?? []), "bridge@base->optimism 10 USDC");
    for (const text of ["bridge 10 usdc to op", "move 10 usdc to optimism", "move 0.01 eth from arbitrum to solana as sol"]) {
      const run = await say(text);
      assert.doesNotMatch(run.error?.message ?? "", /can mean/u, text);
    }
  });

  it("the strict grammar refuses it with both phrasings as hints, even with a default network", () => {
    const error = refusal(() => compileIntentText("move 10 USDC to op", { defaultNetwork: "base" }));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.deepEqual(error.hints?.slice(0, 2), ["bridge 10 USDC to optimism", "swap 10 USDC to OP"]);
    assert.equal(compileIntentText("move 10 USDC from base to op").actions[0]?.toNetwork, "optimism");
    assert.equal(compileIntentText("move 0.01 ETH from arbitrum to solana as SOL").actions[0]?.to, "SOL");
  });
});
