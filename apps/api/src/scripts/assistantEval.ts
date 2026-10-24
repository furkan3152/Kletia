/**
 * npm run eval:assistant -w @kletia/api [-- --fails] [-- --json <file>]
 *
 * Runs the assistant corpus (platform/assistant/__tests__/fixtures/assistant-corpus.json)
 * offline on the deterministic path and enforces its gates: at least 60
 * questions, at least 90% correct, no answer with a number, asset, network,
 * month or address that is not in its facts, no answer that mentions another
 * fixture wallet. It then plans every action sentence the corpus produced for
 * the intent corpus' "full" wallet (the same holdings as the fixture wallet
 * alice): each must read as a plan or a question, never be refused.
 *
 * Exit 1 when a gate fails.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assistantGates, loadAssistantCorpus, runAssistantEval } from "../platform/assistant/evalHarness.js";
import { loadEvalFixtures, loadIntentEval, modeRunOptions, runIntentEval } from "../platform/engine/goal/evalHarness.js";

const CORPUS = fileURLToPath(new URL("../platform/assistant/__tests__/fixtures/assistant-corpus.json", import.meta.url));
const INTENT_CORPUS = fileURLToPath(new URL("../platform/engine/__tests__/fixtures/intent-eval.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const args = process.argv.slice(2);
const corpus = loadAssistantCorpus(CORPUS);
const rows = await runAssistantEval(corpus);

const families = new Map<string, { total: number; correct: number }>();
for (const row of rows) {
  const entry = families.get(row.question.family) ?? { total: 0, correct: 0 };
  entry.total += 1;
  if (row.correct) entry.correct += 1;
  families.set(row.question.family, entry);
}
console.log("family         correct");
for (const [family, entry] of families) console.log(`${family.padEnd(14)} ${entry.correct}/${entry.total}`);

const failing = rows.filter((row) => !row.correct || row.ungrounded.length > 0 || row.leaks.length > 0);
if (args.includes("--fails")) {
  for (const row of failing) {
    console.log(`\n${row.question.id} [${row.question.wallet}] ${row.question.ask}\n  -> ${row.answer.status}: ${row.answer.text}`);
    for (const miss of [...row.misses, ...row.ungrounded.map((entry) => `ungrounded ${entry}`), ...row.leaks.map((entry) => `leak ${entry}`)]) console.log(`  ! ${miss}`);
  }
}

// Every action sentence must be something the sentence reader plans or asks about, for the same holdings.
const actionRows = rows.filter((row) => row.question.wallet === "alice" && (row.answer.action?.sentences.length ?? 0) > 0);
const sentences = [...new Set(actionRows.flatMap((row) => row.answer.action?.sentences ?? []))];
const intentCorpus = loadIntentEval(INTENT_CORPUS);
const fixtures = loadEvalFixtures(INTENT_CORPUS, intentCorpus, REPO_ROOT);
const planned = await runIntentEval(
  { ...intentCorpus, prompts: sentences.map((say, index) => ({ id: `AS${index}`, family: "assistant", say, wallet: "full", accept: ["P:."], tags: [] })) },
  fixtures,
  modeRunOptions("decide"),
);
const refused = planned.filter((result) => result.status !== "ready" && result.status !== "needs_input");
for (const result of refused) console.log(`  ! action sentence not planned: "${result.say}" -> ${result.status} ${result.error ?? ""}`);

const gates = [...assistantGates(rows), { gate: "action sentences planned", ok: refused.length === 0, detail: `${sentences.length - refused.length}/${sentences.length}` }];
console.log("\ngates");
for (const gate of gates) console.log(`  ${gate.ok ? "PASS" : "FAIL"}  ${gate.gate}: ${gate.detail}`);

const jsonAt = args.indexOf("--json");
if (jsonAt >= 0 && args[jsonAt + 1]) {
  writeFileSync(args[jsonAt + 1] as string, JSON.stringify(rows.map((row) => ({ id: row.question.id, ask: row.question.ask, correct: row.correct, misses: row.misses, ungrounded: row.ungrounded, leaks: row.leaks, answer: row.answer })), null, 1));
}
if (gates.some((gate) => !gate.ok)) process.exit(1);
