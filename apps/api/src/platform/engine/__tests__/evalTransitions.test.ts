/**
 * The eval ratchets (goal/evalTransitions.ts): outcome classes and the
 * less-safe rule, the transition report, and the ledger (unledgered, worse,
 * cleared and stale entries; oracle allowances). The committed files are well
 * formed: every ledger entry names a root class and a clearing package, every
 * allowance a reviewed reason, and the recorded outcomes cover every prompt of
 * every committed corpus in every mode.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EVAL_MODES, loadIntentEval, scoreIntentEval, type EvalResult, type IntentEvalCorpus, type IntentEvalPrompt } from "../goal/evalHarness.js";
import {
  EVAL_CORPUS_FILES,
  checkLedger,
  corpusNameOf,
  lessSafe,
  ledgerOk,
  loadLedger,
  loadOutcomes,
  loadTransitions,
  outcomeOf,
  rerecordLedger,
  transitionReport,
  writeOutcomes,
  type LedgerFile,
  type OutcomesFile,
  type TransitionsFile,
} from "../goal/evalTransitions.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const base = { say: "x", questions: [] as string[], plan: null, assumptions: [] as string[] };
const refused = (id: string): EvalResult => ({ id, ...base, status: "refused", error: "INTENT_UNSUPPORTED" });
const asked = (id: string, question = "actions[0].amount:AMOUNT_MISSING"): EvalResult => ({ id, ...base, status: "needs_input", questions: [question] });
const ready = (id: string, plan = "swap@solana 1 SOL->USDC", extra: Partial<EvalResult> = {}): EvalResult => ({ id, ...base, status: "ready", plan, ...extra });
const prompt = (id: string, accept: string[]): IntentEvalPrompt => ({ id, family: "explicit", say: "x", accept, tags: [] });
const corpusOf = (prompts: IntentEvalPrompt[]): IntentEvalCorpus => ({ spec: "kletia.intent-eval/v1", fixtures: "x#fixtures", prompts });
const emptyLedger: LedgerFile = { spec: "kletia.intent-ledger/v1", entries: [], oracleAllow: [], metamorphic: [] };

describe("outcomes and transitions", () => {
  it("classes outcomes: refused < asked < confirm < ready, a confirm answered or open is a confirm", () => {
    assert.equal(outcomeOf(refused("a")), "refused");
    assert.equal(outcomeOf(asked("a")), "asked");
    assert.equal(outcomeOf(asked("a", "actions[0].kind:INTERPRETATION_CONFIRM")), "confirm");
    assert.equal(outcomeOf({ ...asked("a", "x:Y"), kinds: ["confirm"] }), "confirm");
    assert.equal(outcomeOf(ready("a", undefined, { confirmed: true })), "confirm");
    assert.equal(outcomeOf(ready("a")), "ready");
    assert.equal(outcomeOf({ ...refused("a"), status: "crashed" }), "refused");
  });

  it("less safe means to ready from anything else, or to confirm from refused or asked", () => {
    assert.ok(lessSafe("refused", "ready") && lessSafe("asked", "ready") && lessSafe("confirm", "ready"));
    assert.ok(lessSafe("refused", "confirm") && lessSafe("asked", "confirm"));
    assert.ok(!lessSafe("refused", "asked") && !lessSafe("ready", "refused") && !lessSafe("confirm", "asked") && !lessSafe("ready", "ready"));
  });

  it("reports unreviewed, reviewed, safer and replanned moves", () => {
    const outcomes: OutcomesFile = {
      spec: "kletia.intent-outcomes/v1",
      corpora: { repo: { decide: { A: { o: "refused", d: "X" }, B: { o: "asked", d: "q" }, C: { o: "ready", d: "old plan" }, D: { o: "ready", d: "p" } } } },
    };
    const transitions: TransitionsFile = {
      spec: "kletia.intent-transitions/v1",
      transitions: [{ corpus: "repo", mode: "decide", id: "B", from: "asked", to: "confirm", why: "Reviewed: the new confirm rule asks once." }],
    };
    const report = transitionReport("repo", "decide", [ready("A"), asked("B", "actions[0].kind:INTERPRETATION_CONFIRM"), ready("C", "new plan"), refused("D"), ready("E")], outcomes, transitions);
    assert.deepEqual(report.unreviewed, [{ id: "A", from: "refused", to: "ready", detail: "swap@solana 1 SOL->USDC" }]);
    assert.deepEqual(report.reviewed, [{ id: "B", from: "asked", to: "confirm" }]);
    assert.deepEqual(report.replanned, [{ id: "C", before: "old plan", after: "new plan" }]);
    assert.deepEqual(report.safer, [{ id: "D", from: "ready", to: "refused" }]);
    assert.deepEqual(report.unrecorded, ["E"]);
  });

  it("refuses a transition without a reviewed why", () => {
    const dir = mkdtempSync(join(tmpdir(), "kletia-transitions-"));
    try {
      const file = join(dir, "t.json");
      writeFileSync(file, JSON.stringify({ spec: "kletia.intent-transitions/v1", transitions: [{ corpus: "repo", mode: "decide", id: "A", from: "asked", to: "ready", why: "ok" }] }));
      assert.throws(() => loadTransitions(file), /reviewed why/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records outcomes per corpus and mode, keeping the others", () => {
    const dir = mkdtempSync(join(tmpdir(), "kletia-outcomes-"));
    try {
      const file = join(dir, "o.json");
      writeOutcomes(file, "repo", "decide", [ready("A"), asked("B")]);
      writeOutcomes(file, "hard", "plan", [refused("C")]);
      const loaded = loadOutcomes(file);
      assert.deepEqual(loaded.corpora.repo?.decide, { A: { o: "ready", d: "swap@solana 1 SOL->USDC" }, B: { o: "asked", d: "actions[0].amount:AMOUNT_MISSING" } });
      assert.deepEqual(loaded.corpora.hard?.plan, { C: { o: "refused", d: "INTENT_UNSUPPORTED" } });
      assert.deepEqual(Object.keys(loaded.corpora), ["hard", "repo"]);
      const before = readFileSync(file, "utf8");
      writeOutcomes(file, "repo", "decide", [ready("A"), asked("B")]);
      assert.equal(readFileSync(file, "utf8"), before, "re-recording the same run is byte-identical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ledger ratchet", () => {
  const corpus = corpusOf([prompt("A", ["P:^ok$"]), prompt("B", ["P:^ok$"]), prompt("C", ["R"]), prompt("D", ["P:^ok$"])]);
  const entry = (id: string, klass: "plans_wrongly" | "asks_needlessly" | "refuses_wrongly") => ({ corpus: "repo", mode: "decide" as const, id, klass, root: "WP1", clears: "P4" });

  it("fails on an unledgered failure, a worse failure, a cleared entry, a stale entry and an unallowed flag", () => {
    const board = scoreIntentEval(corpus, [ready("A", "bad"), ready("B", "bad"), refused("C"), ready("D", "ok", { oracles: ["I9 funding: spends 5 USDC on optimism, holds 0"] })]);
    const ledger: LedgerFile = { ...emptyLedger, entries: [entry("B", "asks_needlessly"), entry("C", "refuses_wrongly"), entry("Z", "plans_wrongly")] };
    const report = checkLedger("repo", "decide", board, ledger);
    assert.deepEqual(report.unledgered.map((row) => row.id), ["A"]);
    assert.deepEqual(report.worse, [{ id: "B", klass: "plans_wrongly", recorded: "asks_needlessly" }]);
    assert.deepEqual(report.cleared.map((row) => row.id), ["C"]);
    assert.deepEqual(report.stale.map((row) => row.id), ["Z"]);
    assert.deepEqual(report.flags, [{ id: "D", flag: "I9 funding: spends 5 USDC on optimism, holds 0" }]);
    assert.ok(!ledgerOk(report));
  });

  it("holds when every failure is ledgered at its class or better and every flag is allowed", () => {
    const board = scoreIntentEval(corpus, [ready("A", "bad"), asked("B"), refused("C"), ready("D", "ok", { oracles: ["I9 funding: x"] })]);
    const ledger: LedgerFile = {
      ...emptyLedger,
      entries: [entry("A", "plans_wrongly"), entry("B", "refuses_wrongly")],
      oracleAllow: [{ corpus: "repo", mode: "decide", id: "D", flag: "I9 funding", why: "Transfers have no balance check yet." }],
    };
    const report = checkLedger("repo", "decide", board, ledger);
    assert.ok(ledgerOk(report), JSON.stringify(report));
    assert.equal(report.ledgered, 2);
    // Another mode or corpus is a separate ledger.
    assert.equal(checkLedger("repo", "plan", board, ledger).unledgered.length, 2);
  });

  it("re-records a corpus and mode, keeping roots and every other entry", () => {
    const board = scoreIntentEval(corpus, [ready("A", "bad"), ready("B", "ok"), asked("C"), ready("D", "bad")]);
    const ledger: LedgerFile = { ...emptyLedger, entries: [entry("A", "asks_needlessly"), entry("B", "plans_wrongly"), { ...entry("A", "plans_wrongly"), corpus: "hard" }] };
    const next = rerecordLedger(ledger, "repo", "decide", board, () => ({ root: "new", clears: "P2" }));
    assert.deepEqual(next.entries, [
      { ...entry("A", "plans_wrongly"), corpus: "hard" },
      { corpus: "repo", mode: "decide", id: "A", klass: "plans_wrongly", root: "WP1", clears: "P4" },
      { corpus: "repo", mode: "decide", id: "C", klass: "asks_wrong_question", root: "new", clears: "P2" },
      { corpus: "repo", mode: "decide", id: "D", klass: "plans_wrongly", root: "new", clears: "P2" },
    ]);
  });

  it("refuses a malformed ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "kletia-ledger-"));
    try {
      const file = join(dir, "l.json");
      const write = (ledger: unknown) => writeFileSync(file, JSON.stringify(ledger));
      write({ ...emptyLedger, entries: [entry("A", "plans_wrongly"), entry("A", "plans_wrongly")] });
      assert.throws(() => loadLedger(file), /ledgered twice/u);
      write({ ...emptyLedger, entries: [{ ...entry("A", "plans_wrongly"), klass: "plan_ok" }] });
      assert.throws(() => loadLedger(file), /correct class/u);
      write({ ...emptyLedger, entries: [{ ...entry("A", "plans_wrongly"), clears: "" }] });
      assert.throws(() => loadLedger(file), /package/u);
      write({ ...emptyLedger, oracleAllow: [{ corpus: "repo", mode: "decide", id: "A", flag: "I9", why: "short" }] });
      assert.throws(() => loadLedger(file), /reviewed why/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("committed ratchet files", () => {
  it("name the committed corpora", () => {
    assert.equal(corpusNameOf(fixture("intent-eval.json")), "repo");
    assert.equal(corpusNameOf("/x/intent-hard.json"), "hard");
    assert.equal(corpusNameOf("C:\\x\\intent-redteam.json"), "redteam");
    assert.equal(corpusNameOf("/tmp/holdout.json"), "holdout");
  });

  it("the ledger, outcomes and transitions load and cover every committed corpus in every mode", () => {
    const ledger = loadLedger(fixture("intent-hard-ledger.json"));
    for (const allow of ledger.metamorphic) assert.match(allow.id, /^(?:repo|hard|redteam):[A-Z]+\d+~[a-z-]+~\d+$/u);
    for (const allow of ledger.oracleAllow) assert.ok(allow.clears, `${allow.id}: clears`);
    loadTransitions(fixture("intent-transitions.json"));
    const outcomes = loadOutcomes(fixture("intent-outcomes.json"));
    for (const [name, file] of Object.entries(EVAL_CORPUS_FILES)) {
      const ids = loadIntentEval(fixture(file)).prompts.map((entry) => entry.id).sort();
      for (const mode of EVAL_MODES) assert.deepEqual(Object.keys(outcomes.corpora[name]?.[mode] ?? {}).sort(), ids, `${name}/${mode}`);
    }
  });
});
