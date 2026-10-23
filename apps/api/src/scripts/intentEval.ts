/**
 * npm run eval:intents -w apps/api [-- options]
 *
 * Runs the intent eval corpora and prints the family scoreboard, the gates
 * and the ratchets.
 *
 *   (no options)          the repo corpus offline in decide mode: decideTurn with the fixture wallets and fixed prices
 *   --corpus <name|file>  repo (default), hard, redteam, all (the three), or a corpus file
 *   --mode <mode>         decide (default), plan (ready turns also planned as dry runs; F-2 class), strict
 *                         (the strict path; asks are refusals), or all
 *   --no-confirm          leave one-click confirms open (by default the harness confirms once)
 *   --ledger              check the ledger ratchet (__tests__/fixtures/intent-hard-ledger.json); always on for
 *                         hard and redteam, whose gate it is
 *   --record-ledger       re-record the ledger entries of the runs (new failures get a placeholder root to review)
 *   --record-outcomes     record each prompt's outcome class in __tests__/fixtures/intent-outcomes.json
 *   --transitions         fail on a move to a less safe outcome with no reviewed why (intent-transitions.json)
 *   --metamorphic         also run the metamorphic suite (decide mode) and check it against the ledger's allowances
 *   --holdout <file>      score a holdout corpus kept outside the tree against the hard corpus
 *   --fails               also print every failing prompt
 *   --json <file>         write the per-prompt results as JSON (the last run)
 *   --api <origin>        run the wallet-independent prompts against a live API
 *                         (POST /v1/intents?clarify=true&dryRun=true: read-only, nothing stored or signed)
 *   --key <key>           API key for --api (or KLETIA_EVAL_API_KEY); public tier without one
 *   --delay <ms>          pause between live requests (default 400; the public tier allows 30 a minute)
 *   --family <a,b>        only these families
 *   --enforce             exit 1 when a gate fails (always on once INTENT_EVAL_ENFORCE is)
 *   --llm <mode>          also run the model-assisted reading layer (scripts/readingEval.ts): replay (recordings),
 *                         adversarial or fuzz (hostile providers, every family agreeing), or live; the harness
 *                         confirms model readings as the person would, so a wrong reading counts as a wrong plan
 *
 * Exit 1 on a crash, a broken corpus, a failed gate, a broken ratchet or an
 * unreviewed transition.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVAL_MODES,
  INTENT_EVAL_ENFORCE,
  evalGates,
  formatScoreboard,
  loadEvalFixtures,
  loadIntentEval,
  modeRunOptions,
  runIntentEval,
  runIntentEvalLive,
  scoreIntentEval,
  type EvalMode,
  type EvalResult,
  type IntentEvalCorpus,
  type Scoreboard,
} from "../platform/engine/goal/evalHarness.js";
import { evalReader, READING_EVAL_MODES, type EvalReader, type ReadingEvalMode } from "./readingEval.js";
import { checkMetamorphic, formatMetamorphic, runMetamorphic } from "../platform/engine/goal/evalMetamorphic.js";
import {
  EVAL_CORPUS_FILES,
  checkLedger,
  corpusNameOf,
  formatLedgerReport,
  ledgerOk,
  loadLedger,
  loadOutcomes,
  loadTransitions,
  rerecordLedger,
  transitionReport,
  writeLedger,
  writeOutcomes,
  type LedgerFile,
} from "../platform/engine/goal/evalTransitions.js";

const FIXTURES = new URL("../platform/engine/__tests__/fixtures/", import.meta.url);
const fixturePath = (name: string) => fileURLToPath(new URL(name, FIXTURES));
const LEDGER_PATH = fixturePath("intent-hard-ledger.json");
const OUTCOMES_PATH = fixturePath("intent-outcomes.json");
const TRANSITIONS_PATH = fixturePath("intent-transitions.json");
/** The repository root (corpus files name their fixtures relative to it). */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** Corpora whose gate is the ledger ratchet, not the repo corpus' family gates. */
const LEDGER_GATED = new Set(["hard", "redteam"]);
/** The holdout may trail the hard corpus' deterministic score by this many points. */
const HOLDOUT_MARGIN_POINTS = 6;

interface Args {
  fails: boolean;
  enforce: boolean;
  llm?: ReadingEvalMode;
  confirm: boolean;
  ledger: boolean;
  recordLedger: boolean;
  recordOutcomes: boolean;
  transitions: boolean;
  metamorphic: boolean;
  modes: EvalMode[];
  corpora: string[];
  json?: string;
  holdout?: string;
  families?: string[];
  api?: string;
  key?: string;
  delay: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    fails: false, enforce: false, confirm: true, ledger: false, recordLedger: false, recordOutcomes: false,
    transitions: false, metamorphic: false, modes: ["decide"], corpora: ["repo"], delay: 400,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--fails": args.fails = true; break;
      case "--enforce": args.enforce = true; break;
      case "--llm": {
        const mode = value() as ReadingEvalMode;
        if (!READING_EVAL_MODES.includes(mode)) throw new Error(`--llm must be one of ${READING_EVAL_MODES.join(", ")}`);
        args.llm = mode;
        break;
      }
      case "--no-confirm": args.confirm = false; break;
      case "--ledger": args.ledger = true; break;
      case "--record-ledger": args.recordLedger = true; args.ledger = true; break;
      case "--record-outcomes": args.recordOutcomes = true; break;
      case "--transitions": args.transitions = true; break;
      case "--metamorphic": args.metamorphic = true; break;
      case "--json": args.json = value(); break;
      case "--holdout": args.holdout = value(); break;
      case "--corpus": {
        const name = value();
        args.corpora = name === "all" ? Object.keys(EVAL_CORPUS_FILES) : [name];
        break;
      }
      case "--mode": {
        const mode = value();
        if (mode === "all") args.modes = [...EVAL_MODES];
        else if ((EVAL_MODES as readonly string[]).includes(mode)) args.modes = [mode as EvalMode];
        else throw new Error(`--mode is ${EVAL_MODES.join(", ")} or all`);
        break;
      }
      case "--api": args.api = value(); break;
      case "--family": args.families = value().split(",").map((name) => name.trim()).filter(Boolean); break;
      case "--key": args.key = value(); break;
      case "--delay": {
        const ms = Number(value());
        if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) throw new Error("--delay is 0 to 60000 ms");
        args.delay = ms;
        break;
      }
      default: throw new Error(`unknown option ${String(flag)}`);
    }
  }
  if (args.api && !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/u.test(args.api)) throw new Error("--api is an http(s) origin");
  if (args.api && (args.modes.length !== 1 || args.modes[0] !== "decide")) throw new Error("--api runs decide mode only");
  return args;
}

function corpusPath(name: string): string {
  const file = EVAL_CORPUS_FILES[name];
  return file ? fixturePath(file) : name;
}

interface Loaded {
  readonly name: string;
  readonly corpus: IntentEvalCorpus;
  readonly fixtures: ReturnType<typeof loadEvalFixtures>;
}

function load(path: string, families: readonly string[] | undefined): Loaded {
  const loaded = loadIntentEval(path);
  const corpus = families ? { ...loaded, prompts: loaded.prompts.filter((prompt) => families.includes(prompt.family)) } : loaded;
  if (corpus.prompts.length === 0) throw new Error(`${path}: no prompt matches --family`);
  return { name: corpusNameOf(path), corpus, fixtures: loadEvalFixtures(path, loaded, REPO_ROOT) };
}

/** The model-assisted reading hook of `--llm` (one per process run, so its metrics add up). */
let llmReader: EvalReader | null = null;

async function runOffline(loaded: Loaded, mode: EvalMode, confirm: boolean): Promise<{ results: EvalResult[]; board: Scoreboard; ms: number }> {
  const started = Date.now();
  const reader = mode !== "strict" && llmReader ? { reader: llmReader.hook } : {};
  const results = await runIntentEval(loaded.corpus, loaded.fixtures, { ...modeRunOptions(mode, { confirm }), ...reader });
  return { results, board: scoreIntentEval(loaded.corpus, results, { strict: mode === "strict" }), ms: Date.now() - started };
}

/** New ledger entries get a placeholder the reviewer replaces: the attack id or the corpus rule tag when the prompt has one. */
function ledgerDefaults(loaded: Loaded) {
  const prompts = new Map(loaded.corpus.prompts.map((prompt) => [prompt.id, prompt]));
  return (id: string) => {
    const prompt = prompts.get(id);
    const rule = prompt?.attacks?.[0] ?? prompt?.tags.find((tag) => tag !== "reclassified" && tag !== "redteam");
    return { root: rule ?? "unreviewed", clears: "unassigned (review)" };
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.llm) llmReader = evalReader(args.llm);
  let failed = false;
  if (args.api) {
    const loaded = load(corpusPath(args.corpora[0] as string), args.families);
    const key = args.key ?? process.env.KLETIA_EVAL_API_KEY;
    const started = Date.now();
    const results = await runIntentEvalLive(loaded.corpus, loaded.fixtures, { api: args.api, ...(key ? { key } : {}), delayMs: args.delay });
    const board = scoreIntentEval(loaded.corpus, results);
    console.log(`live ${args.api} · ${results.length} results in ${Date.now() - started} ms`);
    console.log(formatScoreboard(board, { failList: args.fails }));
    if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 1)}\n`);
    if (board.byClass.crashed > 0) return 1;
    return (args.enforce || INTENT_EVAL_ENFORCE) && evalGates(board).some((gate) => !gate.ok) ? 1 : 0;
  }

  let ledger: LedgerFile | null = args.ledger || args.corpora.some((name) => LEDGER_GATED.has(name)) ? loadLedger(LEDGER_PATH) : null;
  const transitions = args.transitions ? loadTransitions(TRANSITIONS_PATH) : null;
  const outcomes = args.transitions ? loadOutcomes(OUTCOMES_PATH) : null;
  let lastResults: EvalResult[] = [];
  const decideScores = new Map<string, Scoreboard>();

  for (const name of args.corpora) {
    const loaded = load(corpusPath(name), args.families);
    for (const mode of args.modes) {
      const { results, board, ms } = await runOffline(loaded, mode, args.confirm);
      lastResults = results;
      if (mode === "decide") decideScores.set(loaded.name, board);
      const ledgered = new Set((ledger?.entries ?? []).filter((entry) => entry.corpus === loaded.name && entry.mode === mode).map((entry) => entry.id));
      const gated = !LEDGER_GATED.has(loaded.name) && mode !== "strict";
      console.log(`\n== ${loaded.name} · ${mode}${args.confirm && mode !== "strict" ? " · confirms once" : ""} · ${results.length} results in ${ms} ms`);
      console.log(formatScoreboard(board, { failList: args.fails, mode, gates: gated, ledgered }));
      if (board.byClass.crashed > 0) failed = true;
      if (gated && (args.enforce || INTENT_EVAL_ENFORCE) && evalGates(board, { mode, ledgered }).some((gate) => !gate.ok)) failed = true;
      if (ledger && (args.ledger || LEDGER_GATED.has(loaded.name))) {
        if (args.recordLedger) {
          ledger = rerecordLedger(ledger, loaded.name, mode, board, ledgerDefaults(loaded));
          writeLedger(LEDGER_PATH, ledger);
          console.log(`ledger ${loaded.name}/${mode}: re-recorded`);
        } else {
          const report = checkLedger(loaded.name, mode, board, ledger);
          console.log(formatLedgerReport(loaded.name, mode, report));
          if (!ledgerOk(report)) failed = true;
        }
      }
      if (args.recordOutcomes) {
        writeOutcomes(OUTCOMES_PATH, loaded.name, mode, results);
        console.log(`outcomes ${loaded.name}/${mode}: recorded`);
      }
      if (transitions && outcomes) {
        const report = transitionReport(loaded.name, mode, results, outcomes, transitions);
        console.log(`transitions ${loaded.name}/${mode}: ${report.unreviewed.length} unreviewed, ${report.reviewed.length} reviewed, ${report.safer.length} safer, ${report.replanned.length} replanned, ${report.unrecorded.length} unrecorded`);
        for (const move of report.unreviewed) console.log(`  UNREVIEWED ${move.id}: ${move.from} -> ${move.to} (${move.detail})`);
        for (const move of report.replanned) console.log(`  replanned  ${move.id}: ${move.before} -> ${move.after}`);
        if (report.unreviewed.length > 0) failed = true;
      }
      if (args.metamorphic && mode === "decide") {
        const run = await runMetamorphic(loaded.corpus, loaded.fixtures, results, { autoConfirm: false });
        console.log(formatMetamorphic(loaded.name, run));
        if (ledger) {
          const check = checkMetamorphic(loaded.name, run, ledger.metamorphic);
          console.log(`metamorphic ${loaded.name}: ${check.allowed} allowed, ${check.open.length} open, ${check.stale.length} stale allowances`);
          for (const allow of check.stale) console.log(`  UNUSED allowance ${allow.id}`);
          if (check.open.length > 0 || check.stale.length > 0) failed = true;
        } else if (run.findings.some((finding) => finding.kind === "violation")) {
          failed = true;
        }
      }
    }
  }

  if (args.holdout) {
    const holdout = load(args.holdout, args.families);
    const { results, board, ms } = await runOffline(holdout, "decide", args.confirm);
    lastResults = results;
    const hard = decideScores.get("hard") ?? (await runOffline(load(corpusPath("hard"), undefined), "decide", args.confirm)).board;
    const pct = (part: number, whole: number) => (whole === 0 ? 0 : (100 * part) / whole);
    const floor = pct(hard.correct, hard.prompts) - HOLDOUT_MARGIN_POINTS;
    const score = pct(board.correct, board.prompts);
    console.log(`\n== holdout ${holdout.name} · decide · ${results.length} results in ${ms} ms`);
    console.log(formatScoreboard(board, { failList: args.fails, gates: false }));
    console.log(`holdout gates: plans_wrongly ${board.byClass.plans_wrongly} (needs 0); correct ${score.toFixed(1)}% (needs >= hard ${pct(hard.correct, hard.prompts).toFixed(1)}% - ${HOLDOUT_MARGIN_POINTS} = ${floor.toFixed(1)}%)`);
    if (board.byClass.plans_wrongly > 0 || board.byClass.crashed > 0 || score < floor) failed = true;
  }

  if (args.json) writeFileSync(args.json, `${JSON.stringify(lastResults, null, 1)}\n`);
  if (llmReader) {
    const m = llmReader.layer.metrics;
    const rejected = Object.entries(m.rejected).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} ${count}`).join(", ");
    console.log(`model reading (${args.llm}): calls ${m.calls}, failures ${m.failures}, proposals ${m.proposals}, missing recordings ${llmReader.missing()}; rejected: ${rejected || "none"}`);
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
