/**
 * The intent eval (intent engine v2 §6; fixtures/intent-eval.json): every
 * prompt runs through decideTurn with the clarify corpus' fixture wallets and
 * the fixed eval prices, twice (determinism), and the family scoreboard is
 * printed. Report mode (INTENT_EVAL_ENFORCE = false) until package P5: the
 * gates are printed, not enforced. Always enforced: the corpus is well
 * formed, nothing crashes and two runs agree.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader, nativeUsdQuote, solanaMintUsdQuote } from "../prices.js";
import { quoteAsset } from "../preview/pricer.js";
import { WRAPPED_SOL_MINT } from "@kletia/core";
import {
  EVAL_PRICE_AT,
  INTENT_EVAL_ENFORCE,
  classifyResult,
  evalGates,
  evalPriceReader,
  formatScoreboard,
  loadEvalFixtures,
  loadIntentEval,
  parseAccept,
  runIntentEval,
  runIntentEvalLive,
  scoreIntentEval,
  specShape,
  type EvalResult,
  type IntentEvalPrompt,
} from "../goal/evalHarness.js";

const evalPath = fileURLToPath(new URL("./fixtures/intent-eval.json", import.meta.url));
const corpus = loadIntentEval(evalPath);
const fixtures = loadEvalFixtures(evalPath, corpus);

after(() => {
  configureHoldingsReaders(null);
  configurePriceReader(null);
});

const prompt = (accept: string[], family = "explicit"): IntentEvalPrompt => ({ id: "T1", family, say: "x", accept, tags: [] });
const result = (overrides: Partial<EvalResult>): EvalResult => ({ id: "T1", say: "x", status: "refused", questions: [], plan: null, assumptions: [], ...overrides });

describe("intent eval harness", () => {
  it("parses the accept grammar and refuses malformed entries", () => {
    assert.deepEqual(parseAccept("R"), { kind: "R", pattern: null, code: null });
    assert.equal(parseAccept("R:INTENT_UNSUPPORTED").code, "INTENT_UNSUPPORTED");
    assert.equal(parseAccept("P:^swap@solana").kind, "P");
    for (const bad of ["X:foo", "P:", "A", "R:not a code", "P:("]) assert.throws(() => parseAccept(bad), bad);
  });

  it("classifies like score.py, and a crash is never correct", () => {
    const plan = prompt(["P:^swap@solana 1 SOL->USDC$"]);
    assert.equal(classifyResult(plan, result({ status: "ready", plan: "swap@solana 1 SOL->USDC" })), "plan_ok");
    assert.equal(classifyResult(plan, result({ status: "ready", plan: "swap@base 1 SOL->USDC" })), "plans_wrongly");
    assert.equal(classifyResult(plan, result({ status: "needs_input", questions: ["actions[0].amount:AMOUNT_MISSING"] })), "asks_needlessly");
    assert.equal(classifyResult(plan, result({ status: "refused", error: "INTENT_UNSUPPORTED" })), "refuses_wrongly");
    const ask = prompt(["A:amount:AMOUNT_MISSING"]);
    assert.equal(classifyResult(ask, result({ status: "needs_input", questions: ["actions[0].amount:AMOUNT_MISSING", "x:Y"] })), "ask_ok");
    assert.equal(classifyResult(ask, result({ status: "needs_input", questions: ["x:Y", "actions[0].amount:AMOUNT_MISSING"] })), "asks_wrong_question");
    const refuse = prompt(["R:INTENT_UNSUPPORTED"], "refuse");
    assert.equal(classifyResult(refuse, result({ error: "INTENT_UNSUPPORTED" })), "refuse_ok");
    assert.equal(classifyResult(refuse, result({ error: "OTHER" })), "refuses_wrongly");
    assert.equal(classifyResult(prompt(["R"]), result({ status: "crashed", error: "CRASH" })), "crashed");
  });

  it("scores gates: a perfect board passes, a wrong plan fails", () => {
    const tiny = { ...corpus, prompts: [prompt(["P:^ok$"]), { ...prompt(["R"], "refuse"), id: "T2" }] };
    const good = scoreIntentEval(tiny, [result({ status: "ready", plan: "ok" }), result({ id: "T2" })]);
    assert.ok(evalGates(good).every((gate) => gate.ok), formatScoreboard(good));
    const bad = scoreIntentEval(tiny, [result({ status: "ready", plan: "nope" }), result({ id: "T2" })]);
    assert.deepEqual(evalGates(bad).filter((gate) => !gate.ok).map((gate) => gate.gate), ["correct", "explicit 100%", "plans_wrongly"]);
  });

  it("the fixed price reader feeds prices.ts and the preview pricer", async () => {
    configurePriceReader(evalPriceReader());
    try {
      assert.deepEqual(await nativeUsdQuote("solana"), { usd: 151.02, source: "jupiter", at: EVAL_PRICE_AT });
      assert.equal((await nativeUsdQuote("base"))?.usd, 3412.5);
      assert.equal((await nativeUsdQuote("polygon"))?.usd, 0.51);
      assert.equal((await solanaMintUsdQuote(WRAPPED_SOL_MINT))?.usd, 151.02);
      assert.equal((await quoteAsset("eip155:8453/slip44:60" as never))?.usd, 3412.5);
      // Par and testnet rules still come first; unknown symbols stay unpriced.
      assert.equal((await nativeUsdQuote("arc"))?.source, "usd-par");
      assert.equal(await solanaMintUsdQuote("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"), null);
    } finally {
      configurePriceReader(null);
    }
  });

  it("live mode skips wallet-dependent prompts and maps responses (stub fetch)", async () => {
    const sample = { ...corpus, prompts: [
      { id: "L1", family: "explicit", say: "swap 1 SOL to USDC", accept: ["P:^swap@solana 1 SOL->USDC$"], tags: [] },
      { id: "L2", family: "gap", say: "swap SOL to USDC", accept: ["A:amount:AMOUNT_MISSING"], tags: [] },
      { id: "L3", family: "refuse", say: "rug it", accept: ["R:INTENT_UNSUPPORTED"], tags: [] },
      { id: "L4", family: "wallet", say: "swap 3 SOL", accept: ["A:x"], tags: [] },
    ] };
    const bodies: Record<string, unknown> = {
      "swap 1 SOL to USDC": { status: "planned", sentence: "swap 1 SOL to USDC on solana", assumptions: [] },
      "swap SOL to USDC": { status: "needs_input", questions: [{ field: "actions[0].amount", reason: "AMOUNT_MISSING" }], assumptions: [] },
      "rug it": { error: { code: "INTENT_UNSUPPORTED", message: "no" } },
    };
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      const text = (JSON.parse(String(init.body)) as { text: string }).text;
      const body = bodies[text];
      return new Response(JSON.stringify(body), { status: (body as { error?: unknown }).error ? 422 : 200 });
    }) as unknown as typeof fetch;
    const results = await runIntentEvalLive(sample, fixtures, { api: "http://127.0.0.1:3820/", fetchImpl });
    assert.deepEqual(seen, Array(3).fill("http://127.0.0.1:3820/v1/intents?clarify=true&dryRun=true"));
    const board = scoreIntentEval(sample, results);
    assert.equal(board.skipped, 1);
    assert.deepEqual(board.rows.map((row) => row.klass), ["plan_ok", "ask_ok", "refuse_ok"], formatScoreboard(board, { failList: true }));
    // A 429 is retried after Retry-After, and a lasting one is a crash, never a refusal.
    let calls = 0;
    const waits: number[] = [];
    const limited = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "2" } })
        : new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429 });
    }) as unknown as typeof fetch;
    const one = { ...sample, prompts: [sample.prompts[2] as IntentEvalPrompt] };
    const [limitedResult] = await runIntentEvalLive(one, fixtures, { api: "http://127.0.0.1:3820", fetchImpl: limited, rateLimitRetries: 1, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(waits, [2000]);
    assert.equal(limitedResult?.status, "crashed");
    assert.equal(specShape([{ kind: "swap", network: "base", amount: "max", from: "USDC", to: "ETH", params: { portionBps: 5000 } }]), "swap@base max(5000) USDC->ETH");
    assert.equal(specShape([{ kind: "stake", network: "ethereum", amount: "1", from: "ETH", to: "weETH", params: { provider: "ether.fi" } }]), "stake@ethereum 1 ETH->weETH {etherfi}");
    assert.equal(
      specShape([{ kind: "swap", network: "solana", amount: "1", from: "SOL", to: "USDC" }, { kind: "bridge", network: "solana", toNetwork: "base", amount: "max" }]),
      "swap@solana 1 SOL->USDC | bridge@solana->base max USDC",
    );
  });
});

describe("intent eval corpus (gates enforced)", () => {
  it("runs every prompt twice with the same results, never crashes, and prints the scoreboard", async () => {
    const first = await runIntentEval(corpus, fixtures);
    const second = await runIntentEval(corpus, fixtures);
    assert.equal(first.length, corpus.prompts.length);
    assert.deepEqual(second, first, "two runs agree");
    const board = scoreIntentEval(corpus, first);
    console.log(formatScoreboard(board, { failList: process.env.KLETIA_INTENT_EVAL_FAILS === "1" }));
    assert.equal(board.byClass.crashed, 0, formatScoreboard(board, { failList: true }));
    if (INTENT_EVAL_ENFORCE) {
      const failed = evalGates(board).filter((gate) => !gate.ok);
      assert.deepEqual(failed, [], formatScoreboard(board, { failList: true }));
    }
  });
});
