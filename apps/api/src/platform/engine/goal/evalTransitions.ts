/**
 * The eval's ratchets (design E.2, E.3): main auto-deploys, so a merge may
 * neither add a failure nor make a prompt less safe without a reviewed
 * reason.
 *
 * - Ledger (`__tests__/fixtures/intent-hard-ledger.json`): every prompt that
 *   fails today, per corpus and mode, with its class, its root class
 *   (WP/AQ/RF of U2, a red-team attack id, or the design rule its
 *   expectation follows) and the package whose merge clears it. A run fails
 *   when a prompt fails that is not ledgered, fails with a more severe class
 *   than recorded, or passes while still ledgered (the entry is removed in the
 *   same change, so the ledger only shrinks). Oracle flags on prompts that are
 *   not failing must be allowlisted with a reason, and so must metamorphic
 *   violations; stale allowances fail too.
 * - Outcomes (`intent-outcomes.json`) and transitions
 *   (`intent-transitions.json`): each prompt's outcome class (refused < asked
 *   < confirm < ready) is recorded per corpus and mode; a run that moves a
 *   prompt to a less safe class (refused, asked or confirm to ready; refused
 *   or asked to confirm) fails unless a transition entry holds a reviewed
 *   reason for exactly that prompt and change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  EVAL_CORRECT_CLASSES,
  loadEvalFixtures,
  loadIntentEval,
  modeRunOptions,
  moreSevere,
  runIntentEval,
  scoreIntentEval,
  type EvalClass,
  type EvalMode,
  type EvalResult,
  type Scoreboard,
} from "./evalHarness.js";

// ------------------------------------------------------------- corpora

/** The ledger and outcome names of the committed corpora, by file name. */
export const EVAL_CORPUS_FILES: Readonly<Record<string, string>> = Object.freeze({
  repo: "intent-eval.json",
  hard: "intent-hard.json",
  redteam: "intent-redteam.json",
});

/** The corpus name the ledger and the outcomes use for a corpus file ("repo", "hard", "redteam", else the file name). */
export function corpusNameOf(path: string): string {
  const file = path.split(/[\\/]/u).pop() ?? path;
  const known = Object.entries(EVAL_CORPUS_FILES).find(([, name]) => name === file);
  return known ? known[0] : file.replace(/\.json$/u, "");
}

// ------------------------------------------------------------- outcomes

export const OUTCOME_CLASSES = Object.freeze(["refused", "asked", "confirm", "ready"] as const);
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** The outcome class of one result: a one-click confirm (answered or open) is "confirm". */
export function outcomeOf(result: EvalResult): OutcomeClass {
  if (result.confirmed) return "confirm";
  switch (result.status) {
    // A hand-off prefills a surface the person signs on (round 9): as consequential as a plan.
    case "ready":
    case "handoff":
      return "ready";
    case "needs_input": {
      const first = result.questions[0] ?? "";
      return result.kinds?.[0] === "confirm" || /:INTERPRETATION_CONFIRM$/u.test(first) ? "confirm" : "asked";
    }
    default:
      return "refused";
  }
}

/** One line of detail kept with an outcome: the plan, the first question or the error code. */
export function outcomeDetail(result: EvalResult): string {
  return result.plan ?? result.questions[0] ?? result.error ?? result.status;
}

const rank = (outcome: OutcomeClass) => OUTCOME_CLASSES.indexOf(outcome);

/** True when moving from `from` to `to` is less safe (design E.2: to ready from anything else, or to confirm from refused or asked). */
export function lessSafe(from: OutcomeClass, to: OutcomeClass): boolean {
  return (to === "ready" || to === "confirm") && rank(to) > rank(from);
}

export interface RecordedOutcome {
  readonly o: OutcomeClass;
  readonly d: string;
}

export interface OutcomesFile {
  readonly spec: "kletia.intent-outcomes/v1";
  /** corpus -> mode -> prompt id -> outcome. */
  readonly corpora: Readonly<Record<string, Readonly<Partial<Record<EvalMode, Readonly<Record<string, RecordedOutcome>>>>>>>;
}

export interface TransitionEntry {
  readonly corpus: string;
  readonly mode: EvalMode;
  readonly id: string;
  readonly from: OutcomeClass;
  readonly to: OutcomeClass;
  /** The reviewed reason (at least 20 characters). */
  readonly why: string;
}

export interface TransitionsFile {
  readonly spec: "kletia.intent-transitions/v1";
  readonly transitions: readonly TransitionEntry[];
}

export function loadOutcomes(path: string): OutcomesFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as OutcomesFile;
  if (file.spec !== "kletia.intent-outcomes/v1" || typeof file.corpora !== "object") throw new Error(`${path}: not an outcomes file`);
  return file;
}

export function loadTransitions(path: string): TransitionsFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as TransitionsFile;
  if (file.spec !== "kletia.intent-transitions/v1" || !Array.isArray(file.transitions)) throw new Error(`${path}: not a transitions file`);
  for (const entry of file.transitions) {
    if (!(OUTCOME_CLASSES as readonly string[]).includes(entry.from) || !(OUTCOME_CLASSES as readonly string[]).includes(entry.to)) throw new Error(`${path}: ${entry.id} has an unknown class`);
    if (typeof entry.why !== "string" || entry.why.trim().length < 20) throw new Error(`${path}: ${entry.corpus}/${entry.id} needs a reviewed why`);
  }
  return file;
}

/** The outcomes of one run, keyed by prompt id, in corpus order. */
export function recordOutcomes(results: readonly EvalResult[]): Record<string, RecordedOutcome> {
  return Object.fromEntries(results.filter((result) => result.status !== "skipped").map((result) => [result.id, { o: outcomeOf(result), d: outcomeDetail(result).slice(0, 200) }]));
}

/** Writes one corpus and mode into the outcomes file (the lead re-records at merge), keeping every other corpus and mode. */
export function writeOutcomes(path: string, corpus: string, mode: EvalMode, results: readonly EvalResult[]): void {
  let file: OutcomesFile = { spec: "kletia.intent-outcomes/v1", corpora: {} };
  try {
    file = loadOutcomes(path);
  } catch {
    // A missing or unreadable file starts empty.
  }
  const corpora = { ...file.corpora, [corpus]: { ...(file.corpora[corpus] ?? {}), [mode]: recordOutcomes(results) } };
  const sorted = Object.fromEntries(Object.entries(corpora).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ spec: "kletia.intent-outcomes/v1", corpora: sorted }, null, 1)}\n`);
}

export interface TransitionReport {
  /** Less safe moves with no reviewed reason: these fail the run. */
  readonly unreviewed: readonly { readonly id: string; readonly from: OutcomeClass; readonly to: OutcomeClass; readonly detail: string }[];
  /** Less safe moves a transition entry covers. */
  readonly reviewed: readonly { readonly id: string; readonly from: OutcomeClass; readonly to: OutcomeClass }[];
  /** Safer moves (reported, never failing). */
  readonly safer: readonly { readonly id: string; readonly from: OutcomeClass; readonly to: OutcomeClass }[];
  /** Ready before and after, with another plan (reported). */
  readonly replanned: readonly { readonly id: string; readonly before: string; readonly after: string }[];
  /** Prompts with no recorded outcome. */
  readonly unrecorded: readonly string[];
}

/** Compares a run with the recorded outcomes of its corpus and mode. */
export function transitionReport(
  corpus: string,
  mode: EvalMode,
  results: readonly EvalResult[],
  outcomes: OutcomesFile,
  transitions: TransitionsFile,
): TransitionReport {
  const recorded = outcomes.corpora[corpus]?.[mode] ?? {};
  const unreviewed: TransitionReport["unreviewed"][number][] = [];
  const reviewed: TransitionReport["reviewed"][number][] = [];
  const safer: TransitionReport["safer"][number][] = [];
  const replanned: TransitionReport["replanned"][number][] = [];
  const unrecorded: string[] = [];
  for (const result of results) {
    if (result.status === "skipped") continue;
    const before = recorded[result.id];
    if (!before) {
      unrecorded.push(result.id);
      continue;
    }
    const to = outcomeOf(result);
    const from = before.o;
    if (from === to) {
      if (to === "ready" && before.d !== outcomeDetail(result)) replanned.push({ id: result.id, before: before.d, after: outcomeDetail(result) });
      continue;
    }
    if (!lessSafe(from, to)) {
      safer.push({ id: result.id, from, to });
      continue;
    }
    const covered = transitions.transitions.some((entry) => entry.corpus === corpus && entry.mode === mode && entry.id === result.id && entry.from === from && entry.to === to);
    if (covered) reviewed.push({ id: result.id, from, to });
    else unreviewed.push({ id: result.id, from, to, detail: outcomeDetail(result) });
  }
  return { unreviewed, reviewed, safer, replanned, unrecorded };
}

// ------------------------------------------------------------- ledger

export interface LedgerEntry {
  readonly corpus: string;
  readonly mode: EvalMode;
  readonly id: string;
  readonly klass: EvalClass;
  /** Root class: U2's WP/AQ/RF class, a red-team attack id, or the design rule the expectation follows. */
  readonly root: string;
  /** The package (and milestone) whose merge clears it. */
  readonly clears: string;
  readonly note?: string;
}

export interface OracleAllowance {
  readonly corpus: string;
  readonly mode: EvalMode;
  readonly id: string;
  /** The flag's leading words ("I9 funding", "N number: 2"). */
  readonly flag: string;
  readonly why: string;
  readonly clears?: string;
}

export interface MetamorphicAllowance {
  /** "<corpus>:<prompt id>~<relation>~<n>". */
  readonly id: string;
  readonly why: string;
  readonly clears: string;
}

export interface LedgerFile {
  readonly spec: "kletia.intent-ledger/v1";
  readonly entries: readonly LedgerEntry[];
  readonly oracleAllow: readonly OracleAllowance[];
  readonly metamorphic: readonly MetamorphicAllowance[];
}

export function loadLedger(path: string): LedgerFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
  if (file.spec !== "kletia.intent-ledger/v1" || !Array.isArray(file.entries)) throw new Error(`${path}: not a ledger`);
  const keys = new Set<string>();
  for (const entry of file.entries) {
    const key = `${entry.corpus}|${entry.mode}|${entry.id}`;
    if (keys.has(key)) throw new Error(`${path}: ${key} is ledgered twice`);
    keys.add(key);
    if ((EVAL_CORRECT_CLASSES as readonly string[]).includes(entry.klass)) throw new Error(`${path}: ${key} ledgers a correct class`);
    if (!entry.root || !entry.clears) throw new Error(`${path}: ${key} needs a root class and the package that clears it`);
  }
  for (const allow of file.oracleAllow ?? []) {
    if (!allow.why || allow.why.trim().length < 20) throw new Error(`${path}: oracle allowance ${allow.corpus}/${allow.id} needs a reviewed why`);
  }
  for (const allow of file.metamorphic ?? []) {
    if (!allow.why || !allow.clears) throw new Error(`${path}: metamorphic allowance ${allow.id} needs a why and the package that clears it`);
  }
  return { ...file, oracleAllow: file.oracleAllow ?? [], metamorphic: file.metamorphic ?? [] };
}

export interface LedgerReport {
  /** Failures with no ledger entry. */
  readonly unledgered: readonly { readonly id: string; readonly klass: EvalClass; readonly detail: string }[];
  /** Failures worse than their ledger entry. */
  readonly worse: readonly { readonly id: string; readonly klass: EvalClass; readonly recorded: EvalClass }[];
  /** Ledger entries whose prompt now passes (remove them). */
  readonly cleared: readonly LedgerEntry[];
  /** Ledger entries for prompts the corpus no longer has. */
  readonly stale: readonly LedgerEntry[];
  /** Oracle flags on passing prompts with no allowance. */
  readonly flags: readonly { readonly id: string; readonly flag: string }[];
  /** Allowances no flag uses any more. */
  readonly staleAllowances: readonly OracleAllowance[];
  /** Failures the ledger covers (counts by class). */
  readonly ledgered: number;
}

export function ledgerOk(report: LedgerReport): boolean {
  return report.unledgered.length === 0 && report.worse.length === 0 && report.cleared.length === 0 && report.stale.length === 0 &&
    report.flags.length === 0 && report.staleAllowances.length === 0;
}

/** Checks one scored run against the ledger (corpus and mode as the ledger names them). */
export function checkLedger(corpus: string, mode: EvalMode, board: Scoreboard, ledger: LedgerFile): LedgerReport {
  const entries = ledger.entries.filter((entry) => entry.corpus === corpus && entry.mode === mode);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const unledgered: LedgerReport["unledgered"][number][] = [];
  const worse: LedgerReport["worse"][number][] = [];
  const cleared: LedgerEntry[] = [];
  const flags: LedgerReport["flags"][number][] = [];
  let ledgered = 0;
  const allowances = ledger.oracleAllow.filter((allow) => allow.corpus === corpus && allow.mode === mode);
  const usedAllowances = new Set<OracleAllowance>();
  for (const row of board.rows) {
    seen.add(row.prompt.id);
    const entry = byId.get(row.prompt.id);
    const failing = !(EVAL_CORRECT_CLASSES as readonly string[]).includes(row.klass);
    if (failing) {
      if (!entry) unledgered.push({ id: row.prompt.id, klass: row.klass, detail: row.result.plan ?? row.result.questions[0] ?? row.result.error ?? "" });
      else if (moreSevere(row.klass, entry.klass)) worse.push({ id: row.prompt.id, klass: row.klass, recorded: entry.klass });
      else ledgered += 1;
      continue;
    }
    if (entry) cleared.push(entry);
    for (const flag of row.result.oracles ?? []) {
      const allowance = allowances.find((allow) => allow.id === row.prompt.id && flag.startsWith(allow.flag));
      if (allowance) usedAllowances.add(allowance);
      else flags.push({ id: row.prompt.id, flag });
    }
  }
  const stale = entries.filter((entry) => !seen.has(entry.id));
  const staleAllowances = allowances.filter((allow) => !usedAllowances.has(allow));
  return { unledgered, worse, cleared, stale, flags, staleAllowances, ledgered };
}

export function formatLedgerReport(corpus: string, mode: EvalMode, report: LedgerReport): string {
  const lines = [`ledger ${corpus}/${mode}: ${report.ledgered} ledgered failures${ledgerOk(report) ? ", ratchet holds" : ""}`];
  for (const row of report.unledgered) lines.push(`  NEW     ${row.klass.padEnd(20)} ${row.id} -> ${row.detail}`);
  for (const row of report.worse) lines.push(`  WORSE   ${row.id}: ${row.recorded} -> ${row.klass}`);
  for (const entry of report.cleared) lines.push(`  CLEARED ${entry.id} (${entry.root}, ${entry.clears}): remove its ledger entry`);
  for (const entry of report.stale) lines.push(`  STALE   ${entry.id}: not in the corpus`);
  for (const row of report.flags) lines.push(`  FLAG    ${row.id}: ${row.flag}`);
  for (const allow of report.staleAllowances) lines.push(`  UNUSED  allowance ${allow.id}: ${allow.flag}`);
  return lines.join("\n");
}

/**
 * The ledger with one corpus and mode re-recorded from a run: failing prompts
 * keep their root, package and note when already ledgered, new ones get the
 * given defaults; passing prompts drop out. Oracle allowances are kept.
 */
export function rerecordLedger(
  ledger: LedgerFile,
  corpus: string,
  mode: EvalMode,
  board: Scoreboard,
  defaults: (id: string, klass: EvalClass) => { root: string; clears: string; note?: string },
): LedgerFile {
  const previous = new Map(ledger.entries.filter((entry) => entry.corpus === corpus && entry.mode === mode).map((entry) => [entry.id, entry]));
  const kept = ledger.entries.filter((entry) => !(entry.corpus === corpus && entry.mode === mode));
  const fresh: LedgerEntry[] = [];
  for (const row of board.rows) {
    if ((EVAL_CORRECT_CLASSES as readonly string[]).includes(row.klass)) continue;
    const old = previous.get(row.prompt.id);
    const base = old ?? { ...defaults(row.prompt.id, row.klass) };
    fresh.push({ corpus, mode, id: row.prompt.id, klass: row.klass, root: base.root, clears: base.clears, ...(base.note ? { note: base.note } : {}) });
  }
  return { ...ledger, entries: [...kept, ...fresh] };
}

/** Writes the ledger in its canonical order (corpus, mode, prompt id), so a re-record only shows real changes. */
export function writeLedger(path: string, ledger: LedgerFile): void {
  const modeRank = (mode: EvalMode) => ["decide", "plan", "strict"].indexOf(mode);
  const entries = [...ledger.entries].sort((a, b) => a.corpus.localeCompare(b.corpus) || modeRank(a.mode) - modeRank(b.mode) || a.id.localeCompare(b.id));
  const oracleAllow = [...ledger.oracleAllow].sort((a, b) => a.corpus.localeCompare(b.corpus) || modeRank(a.mode) - modeRank(b.mode) || a.id.localeCompare(b.id) || a.flag.localeCompare(b.flag));
  const metamorphic = [...ledger.metamorphic].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(path, `${JSON.stringify({ spec: ledger.spec, entries, oracleAllow, metamorphic }, null, 1)}\n`);
}

// ------------------------------------------------------------- one gated run

export interface RatchetRun {
  readonly corpus: string;
  readonly mode: EvalMode;
  readonly results: readonly EvalResult[];
  readonly board: Scoreboard;
  readonly ledger: LedgerReport;
  /** Null when no outcomes were given. */
  readonly transitions: TransitionReport | null;
}

/**
 * Runs one committed corpus in one mode with the gate's options
 * (`modeRunOptions`) and checks it against the ledger and, when given, the
 * recorded outcomes and reviewed transitions.
 */
export async function runRatchet(
  path: string,
  mode: EvalMode,
  files: { readonly ledger: LedgerFile; readonly outcomes?: OutcomesFile; readonly transitions?: TransitionsFile },
  options: { readonly root?: string; readonly confirm?: boolean } = {},
): Promise<RatchetRun> {
  const corpus = loadIntentEval(path);
  const fixtures = loadEvalFixtures(path, corpus, options.root);
  const results = await runIntentEval(corpus, fixtures, modeRunOptions(mode, options));
  const board = scoreIntentEval(corpus, results, { strict: mode === "strict" });
  const name = corpusNameOf(path);
  const transitions = files.outcomes
    ? transitionReport(name, mode, results, files.outcomes, files.transitions ?? { spec: "kletia.intent-transitions/v1", transitions: [] })
    : null;
  return { corpus: name, mode, results, board, ledger: checkLedger(name, mode, board, files.ledger), transitions };
}
