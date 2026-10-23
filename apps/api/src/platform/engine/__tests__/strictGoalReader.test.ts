/**
 * Strict Goal-reader fallback (intent design C.5, behind
 * KLETIA_STRICT_GOAL_READER, default off): strict text the grammar cannot
 * read is offered to the deterministic Goal reader and decision layer with no
 * questions and no model; only an exact reading (source E) is planned, through
 * Kletia's canonical sentence. A question, a correction or a derived value is
 * CLARIFY_REQUIRED (422) with the questions in `details`.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { PlatformError } from "../../errors.js";
import { installWallet, loadCorpus, uninstallWallet } from "../clarify/corpusHarness.js";
import { createIntentDetailed, strictGoalReaderEnabled } from "../service.js";
import { resetEngine } from "./helpers.js";

const corpus = loadCorpus(new URL("./fixtures/clarify-corpus.json", import.meta.url).pathname);
const accounts = corpus.fixtures.wallets.full?.accounts ?? [];
let flag: string | undefined;

async function refusal(text: string): Promise<PlatformError> {
  try {
    await createIntentDetailed({ text, accounts }, { dryRun: true });
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail(`${text} planned`);
}

describe("strict Goal-reader fallback (C.5)", () => {
  before(() => {
    flag = process.env.KLETIA_STRICT_GOAL_READER;
    resetEngine();
    installWallet(corpus, "full");
  });
  after(() => {
    uninstallWallet();
    if (flag === undefined) delete process.env.KLETIA_STRICT_GOAL_READER;
    else process.env.KLETIA_STRICT_GOAL_READER = flag;
  });
  afterEach(() => {
    delete process.env.KLETIA_STRICT_GOAL_READER;
  });

  it("is off by default: the grammar's refusal stands", async () => {
    assert.equal(strictGoalReaderEnabled({}), false);
    assert.equal(strictGoalReaderEnabled({ KLETIA_STRICT_GOAL_READER: "on" }), true);
    assert.equal((await refusal("turn 1 sol into usdc")).code, "INTENT_UNSUPPORTED");
  });

  it("plans an exact reading through Kletia's canonical sentence (reviewed fillers allowed)", async () => {
    process.env.KLETIA_STRICT_GOAL_READER = "on";
    for (const text of ["turn 1 sol into usdc", "swap 1 sol to usdc right now"]) {
      const created = await createIntentDetailed({ text, accounts }, { dryRun: true });
      assert.equal(created.intent.request.text, "swap 1 SOL to USDC on solana", text);
      assert.deepEqual(created.intent.steps.map((step) => `${step.kind}@${step.network}`), ["swap@solana"], text);
      assert.equal(created.intent.steps[0]?.input?.amount, "1000000000", "exactly the stated amount");
    }
  });

  it("never plans a corrected or derived reading, or one that needs an answer", async () => {
    process.env.KLETIA_STRICT_GOAL_READER = "on";
    const derived = await refusal("swap half a sol to usdc");
    assert.equal(derived.code, "CLARIFY_REQUIRED");
    assert.equal(derived.status, 422);
    assert.match(derived.message, /half a sol/u);
    assert.ok(derived.hints?.some((hint) => /\?clarify=true/u.test(hint)));
    const vague = await refusal("turn some sol into usdc");
    assert.equal(vague.code, "CLARIFY_REQUIRED");
    const questions = (vague.details as { questions?: { reason: string }[] } | undefined)?.questions ?? [];
    assert.deepEqual(questions.map((question) => question.reason), ["AMOUNT_MISSING"], "the questions ride in details");
  });

  it("leaves texts the grammar reads, structured actions and planner refusals to the strict path", async () => {
    process.env.KLETIA_STRICT_GOAL_READER = "on";
    const created = await createIntentDetailed({ text: "swap 1 SOL to USDC on solana", accounts }, { dryRun: true });
    assert.equal(created.intent.request.text, "swap 1 SOL to USDC on solana");
    const structured = await createIntentDetailed({ actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }], accounts }, { dryRun: true });
    assert.equal(structured.intent.steps.length, 1);
  });
});
