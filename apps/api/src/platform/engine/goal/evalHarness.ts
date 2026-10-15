/**
 * The intent eval: a corpus of prompts
 * (`__tests__/fixtures/intent-eval.json`, `kletia.intent-eval/v1`), each run
 * through `decideTurn` (the function `POST /v1/intents?clarify=true` calls)
 * with the clarify corpus' fixture wallets, classified against its accept
 * list and scored per family against the acceptance gates.
 *
 * Accept grammar, the first entry that matches wins:
 * - `P:<regex>`: ready, and the regex matches the plan shape (corpusHarness.shape);
 * - `A:<regex>`: needs input, and the regex matches "field:REASON" of the first question;
 * - `R` or `R:<CODE>`: refused (with that error code).
 *
 * Offline and deterministic by default (stub holdings readers, a fixed price
 * reader). `runIntentEvalLive` sends the wallet-independent prompts to a
 * running API with `?clarify=true&dryRun=true` (read-only; nothing is
 * stored, signed or sent).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { IntentActionSpec, NetworkKey } from "@kletia/core";
import { compileIntentText } from "../grammar.js";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader, fixedPriceReader, type PriceReader } from "../prices.js";
import { STAKE_PROVIDERS } from "../clarify/catalog.js";
import { contextFor, CORPUS_PRICE_AT, CORPUS_PRICES, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type Corpus, type CorpusCase } from "../clarify/corpusHarness.js";

export const INTENT_EVAL_SPEC = "kletia.intent-eval/v1";

/**
 * The gates are enforced (goal steps are on by default): the test and the
 * CLI fail when one does not hold, besides a broken corpus, a crash or
 * non-determinism.
 */
export const INTENT_EVAL_ENFORCE = true;

/** The fixed prices of the offline eval: USD per whole token. */
export const EVAL_PRICES: Readonly<Record<string, number>> = CORPUS_PRICES;
/** The reading time of the fixed prices (Unix ms), so runs are byte-identical. */
export const EVAL_PRICE_AT = CORPUS_PRICE_AT;

export function evalPriceReader(): PriceReader {
  return fixedPriceReader(EVAL_PRICES, EVAL_PRICE_AT);
}

export const EVAL_CORRECT_CLASSES = Object.freeze(["plan_ok", "ask_ok", "refuse_ok"] as const);
export const EVAL_FAILURE_CLASSES = Object.freeze(["asks_needlessly", "asks_wrong_question", "refuses_wrongly", "plans_wrongly", "crashed"] as const);
export const EVAL_CLASSES = Object.freeze([...EVAL_CORRECT_CLASSES, ...EVAL_FAILURE_CLASSES] as const);
export type EvalClass = (typeof EVAL_CLASSES)[number];

/** The acceptance gates; gate 5 (the clarify corpus) is clarifyCorpus.test.ts. */
export const INTENT_EVAL_GATES = Object.freeze({
  minCorrectBps: 9_300,
  /** Families that must be 100% correct. */
  perfectFamilies: Object.freeze(["explicit", "refuse"]),
  maxPlansWrongly: 0,
  /** Of the prompts outside the `refuse` family. */
  maxRefusesWronglyBps: 200,
  /** asks_needlessly + asks_wrong_question, of all prompts. */
  maxNeedlessAsksBps: 400,
  maxCrashed: 0,
});

export interface IntentEvalPrompt {
  readonly id: string;
  readonly family: string;
  readonly say: string;
  /** A clarify-corpus fixture wallet; "full" when absent. */
  readonly wallet?: string;
  readonly request?: { readonly defaultNetwork?: NetworkKey; readonly sourceNetwork?: NetworkKey | "auto" };
  readonly accept: readonly string[];
  readonly tags: readonly string[];
  /** Why an expectation was changed (corpus hygiene). */
  readonly why?: string;
}

export interface IntentEvalCorpus {
  readonly spec: typeof INTENT_EVAL_SPEC;
  /** "<repo path to clarify-corpus.json>#fixtures". */
  readonly fixtures: string;
  readonly prompts: readonly IntentEvalPrompt[];
}

export interface EvalResult {
  readonly id: string;
  readonly say: string;
  readonly status: "ready" | "needs_input" | "cancelled" | "refused" | "crashed" | "skipped";
  readonly error?: string;
  readonly message?: string;
  /** "field:REASON" of each question, in order. */
  readonly questions: readonly string[];
  /** The plan shape (ready turns). */
  readonly plan: string | null;
  /** "field:source" of each assumption. */
  readonly assumptions: readonly string[];
}

export interface ParsedAccept {
  readonly kind: "P" | "A" | "R";
  /** P and A: the regex; R: null. */
  readonly pattern: RegExp | null;
  /** R:<CODE>. */
  readonly code: string | null;
}

/** Parses one accept entry; throws on a malformed one (a corpus defect). */
export function parseAccept(accept: string): ParsedAccept {
  const colon = accept.indexOf(":");
  const kind = colon === -1 ? accept : accept.slice(0, colon);
  const rest = colon === -1 ? "" : accept.slice(colon + 1);
  if (kind === "R") {
    if (rest && !/^[A-Z][A-Z0-9_]{1,63}$/u.test(rest)) throw new Error(`accept "${accept}": R takes an error code`);
    return { kind, pattern: null, code: rest || null };
  }
  if (kind !== "P" && kind !== "A") throw new Error(`accept "${accept}": must start with P:, A: or R`);
  if (!rest) throw new Error(`accept "${accept}": empty pattern`);
  return { kind, pattern: new RegExp(rest, "u"), code: null };
}

const acceptCache = new Map<string, ParsedAccept>();
function parsedAccept(accept: string): ParsedAccept {
  let parsed = acceptCache.get(accept);
  if (!parsed) {
    parsed = parseAccept(accept);
    acceptCache.set(accept, parsed);
  }
  return parsed;
}

export function matchesAccept(accept: string, result: EvalResult): boolean {
  const parsed = parsedAccept(accept);
  switch (parsed.kind) {
    case "P":
      return result.status === "ready" && result.plan !== null && result.plan !== "" && (parsed.pattern as RegExp).test(result.plan);
    case "A":
      return result.status === "needs_input" && result.questions.length > 0 && (parsed.pattern as RegExp).test(result.questions[0] as string);
    case "R":
      return result.status === "refused" && (parsed.code === null || result.error === parsed.code);
  }
}

/** The class of one result (including `crashed`). */
export function classifyResult(prompt: IntentEvalPrompt, result: EvalResult): EvalClass {
  if (result.status === "crashed") return "crashed";
  for (const accept of prompt.accept) {
    if (matchesAccept(accept, result)) return parsedAccept(accept).kind === "P" ? "plan_ok" : parsedAccept(accept).kind === "A" ? "ask_ok" : "refuse_ok";
  }
  const wantsPlan = prompt.accept.some((accept) => accept.startsWith("P:"));
  if (result.status === "ready") return "plans_wrongly";
  if (result.status === "needs_input") return wantsPlan ? "asks_needlessly" : "asks_wrong_question";
  return "refuses_wrongly";
}

/** Loads and checks a corpus: spec, unique ids, a family, a sentence and parseable accepts on every prompt. */
export function loadIntentEval(path: string): IntentEvalCorpus {
  const corpus = JSON.parse(readFileSync(path, "utf8")) as IntentEvalCorpus;
  if (corpus.spec !== INTENT_EVAL_SPEC) throw new Error(`${path}: spec must be ${INTENT_EVAL_SPEC}`);
  if (!Array.isArray(corpus.prompts) || corpus.prompts.length === 0) throw new Error(`${path}: no prompts`);
  const ids = new Set<string>();
  for (const prompt of corpus.prompts) {
    if (typeof prompt.id !== "string" || ids.has(prompt.id)) throw new Error(`${path}: duplicate or missing id ${String(prompt.id)}`);
    ids.add(prompt.id);
    if (typeof prompt.family !== "string" || !prompt.family) throw new Error(`${prompt.id}: family`);
    if (typeof prompt.say !== "string" || !prompt.say.trim()) throw new Error(`${prompt.id}: say`);
    if (!Array.isArray(prompt.accept) || prompt.accept.length === 0) throw new Error(`${prompt.id}: accept`);
    prompt.accept.forEach(parseAccept);
  }
  return corpus;
}

/**
 * The clarify corpus that holds the fixture wallets: the file named by
 * `fixtures`, looked up next to the eval corpus first, then from `root`.
 */
export function loadEvalFixtures(evalPath: string, corpus: IntentEvalCorpus, root = process.cwd()): Corpus {
  const file = corpus.fixtures.split("#")[0] as string;
  const candidates = [resolve(dirname(evalPath), basename(file)), resolve(root, file)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`fixtures not found: ${candidates.join(", ")}`);
  return loadCorpus(found);
}

function caseOf(prompt: IntentEvalPrompt): CorpusCase {
  return { id: prompt.id, category: prompt.family, title: "", wallet: prompt.wallet ?? "full", turns: [], ...(prompt.request ? { request: prompt.request } : {}) };
}

/** A price reader the caller asked for instead of the corpus prices installWallet sets. */
let pricesOverride: PriceReader | null = null;

/** Runs one prompt offline (the caller installs the price reader). */
export async function runPrompt(fixtures: Corpus, prompt: IntentEvalPrompt): Promise<EvalResult> {
  const entry = caseOf(prompt);
  try {
    installWallet(fixtures, entry.wallet);
    if (pricesOverride) configurePriceReader(pricesOverride);
    const run = await runTurn(null, { text: prompt.say }, contextFor(fixtures, entry));
    if (run.error) return { id: prompt.id, say: prompt.say, status: "refused", error: run.error.code, message: run.error.message.slice(0, 200), questions: [], plan: null, assumptions: [] };
    const decision = run.decision;
    if (!decision) throw new Error("no decision");
    return {
      id: prompt.id,
      say: prompt.say,
      status: decision.status,
      questions: decision.questions.map((question) => `${question.field}:${question.reason}`),
      plan: decision.actions ? shape(decision.actions) : null,
      assumptions: decision.assumptions.map((assumption) => `${assumption.field}:${assumption.source}`),
    };
  } catch (error) {
    return { id: prompt.id, say: prompt.say, status: "crashed", error: "CRASH", message: String((error as Error)?.message ?? error).slice(0, 200), questions: [], plan: null, assumptions: [] };
  }
}

export interface RunOptions {
  /** Defaults to the fixed eval prices; null keeps whatever reader is installed. */
  readonly prices?: PriceReader | null;
  readonly filter?: (prompt: IntentEvalPrompt) => boolean;
}

/** Runs every prompt offline, in corpus order; restores the holdings and price readers afterwards. */
export async function runIntentEval(corpus: IntentEvalCorpus, fixtures: Corpus, options: RunOptions = {}): Promise<EvalResult[]> {
  const prices = options.prices === undefined ? evalPriceReader() : options.prices;
  if (prices) configurePriceReader(prices);
  pricesOverride = options.prices === undefined ? null : options.prices;
  const out: EvalResult[] = [];
  try {
    for (const prompt of corpus.prompts) {
      if (options.filter && !options.filter(prompt)) continue;
      out.push(await runPrompt(fixtures, prompt));
    }
  } finally {
    pricesOverride = null;
    uninstallWallet();
    configureHoldingsReaders(null);
    if (prices) configurePriceReader(null);
  }
  return out;
}

// ------------------------------------------------------------- live mode

/** Prompts whose outcome does not hinge on the fixture wallet's balances (the live API reads real ones). */
export function walletIndependent(prompt: IntentEvalPrompt): boolean {
  return (prompt.wallet ?? "full") === "full" && prompt.family !== "wallet";
}

/** The plan shape of compiled specs (the live API returns a sentence, not resolved actions); best effort. */
export function specShape(specs: readonly IntentActionSpec[]): string {
  return specs
    .map((spec, index) => {
      const portion = typeof spec.params?.portionBps === "number" ? spec.params.portionBps : undefined;
      const amount = spec.amount === "max" || spec.amount === undefined ? (portion && portion !== 10_000 ? `max(${portion})` : "max") : spec.amount;
      // A dependent step spends the previous step's output (clarify resolves `from` the same way).
      const previous = index > 0 ? specs[index - 1] : undefined;
      const from = spec.from ?? previous?.to ?? previous?.from ?? "";
      const to = spec.to && spec.to.toUpperCase() !== from.toUpperCase() ? `->${spec.to}` : "";
      const recipient = spec.recipient ? ` to ${spec.recipient}` : "";
      const venue = typeof spec.params?.venue === "string" ? `:${spec.params.venue}` : "";
      const protocol = spec.protocol && spec.kind !== "stake" ? ` [${spec.protocol}${venue}]` : "";
      // The grammar's provider label ("Jito", "ether.fi") as clarify's provider id ("jito", "etherfi").
      const label = spec.params?.provider;
      const providerId = typeof label === "string"
        ? STAKE_PROVIDERS.find((entry) => entry.grammarProvider.toLowerCase() === label.toLowerCase())?.id ?? label
        : undefined;
      const provider = providerId ? ` {${providerId}}` : "";
      const contract = spec.contract ? ` <${spec.contract}#${spec.entry ?? ""}>` : "";
      return `${spec.kind}@${spec.network}${spec.toNetwork ? `->${spec.toNetwork}` : ""} ${amount} ${from}${to}${recipient}${protocol}${provider}${contract}`;
    })
    .join(" | ");
}

export interface LiveOptions {
  /** API origin, e.g. http://127.0.0.1:3820 (the /v1 path is added). */
  readonly api: string;
  /** Bearer key; the public tier when absent. */
  readonly key?: string;
  /** Pause between requests, ms (public-tier rate limits). */
  readonly delayMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Retries of a 429 (after its Retry-After, at most 65 s); still limited afterwards, the prompt counts as crashed. */
  readonly rateLimitRetries?: number;
  /** Test seam for the Retry-After wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface LiveBody {
  readonly status?: string;
  readonly sentence?: string;
  readonly questions?: readonly { readonly field: string; readonly reason: string }[];
  readonly assumptions?: readonly { readonly field: string; readonly source: string }[];
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Runs the wallet-independent prompts against a live API with
 * `?clarify=true&dryRun=true` (dry run: no intent is stored; nothing is
 * signed or sent). The accounts are the fixture wallet's addresses; the API
 * reads their real balances, so balance-dependent outcomes may differ.
 */
export async function runIntentEvalLive(corpus: IntentEvalCorpus, fixtures: Corpus, options: LiveOptions): Promise<EvalResult[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const url = `${options.api.replace(/\/+$/u, "")}/v1/intents?clarify=true&dryRun=true`;
  const out: EvalResult[] = [];
  for (const prompt of corpus.prompts) {
    if (!walletIndependent(prompt)) {
      out.push({ id: prompt.id, say: prompt.say, status: "skipped", questions: [], plan: null, assumptions: [] });
      continue;
    }
    const wallet = fixtures.fixtures.wallets[prompt.wallet ?? "full"];
    const body = { text: prompt.say, accounts: wallet?.accounts ?? [], ...(prompt.request ?? {}) };
    const base = { id: prompt.id, say: prompt.say };
    try {
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        if (response.status !== 429 || attempt >= retries) break;
        await response.body?.cancel().catch(() => undefined);
        const wait = Number(response.headers.get("retry-after"));
        await sleep(Math.min(65, Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000);
      }
      // A rate limit is the harness's problem, not the engine's answer: never scored as a refusal.
      if (response.status === 429) throw new Error("RATE_LIMITED after retries (use --key or a longer --delay)");
      const json = (await response.json().catch(() => ({}))) as LiveBody;
      const assumptions = (json.assumptions ?? []).map((assumption) => `${assumption.field}:${assumption.source}`);
      if (json.error || !response.ok) {
        out.push({ ...base, status: "refused", error: json.error?.code ?? `HTTP_${response.status}`, message: (json.error?.message ?? "").slice(0, 200), questions: [], plan: null, assumptions: [] });
      } else if (json.status === "planned") {
        let plan: string;
        try {
          plan = specShape(compileIntentText(json.sentence ?? "", { accounts: (wallet?.accounts ?? []) as never }).actions);
        } catch {
          plan = `sentence:${json.sentence ?? ""}`;
        }
        out.push({ ...base, status: "ready", questions: [], plan, assumptions });
      } else if (json.status === "needs_input") {
        out.push({ ...base, status: "needs_input", questions: (json.questions ?? []).map((q) => `${q.field}:${q.reason}`), plan: null, assumptions });
      } else {
        out.push({ ...base, status: "cancelled", questions: [], plan: null, assumptions });
      }
    } catch (error) {
      out.push({ ...base, status: "crashed", error: "CRASH", message: String((error as Error)?.message ?? error).slice(0, 200), questions: [], plan: null, assumptions: [] });
    }
    if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
  }
  return out;
}

// ------------------------------------------------------------- scoring

export type ClassCounts = Readonly<Record<EvalClass, number>>;

export interface Scoreboard {
  readonly prompts: number;
  readonly correct: number;
  readonly skipped: number;
  readonly byClass: ClassCounts;
  readonly byFamily: Readonly<Record<string, ClassCounts>>;
  readonly rows: readonly { readonly klass: EvalClass; readonly prompt: IntentEvalPrompt; readonly result: EvalResult }[];
}

function emptyCounts(): Record<EvalClass, number> {
  return Object.fromEntries(EVAL_CLASSES.map((klass) => [klass, 0])) as Record<EvalClass, number>;
}

const correctOf = (counts: ClassCounts) => EVAL_CORRECT_CLASSES.reduce((sum, klass) => sum + counts[klass], 0);
const totalOf = (counts: ClassCounts) => EVAL_CLASSES.reduce((sum, klass) => sum + counts[klass], 0);

export function scoreIntentEval(corpus: IntentEvalCorpus, results: readonly EvalResult[]): Scoreboard {
  const prompts = new Map(corpus.prompts.map((prompt) => [prompt.id, prompt]));
  const byClass = emptyCounts();
  const byFamily: Record<string, Record<EvalClass, number>> = {};
  const rows: Scoreboard["rows"][number][] = [];
  let skipped = 0;
  for (const result of results) {
    const prompt = prompts.get(result.id);
    if (!prompt) throw new Error(`result for unknown prompt ${result.id}`);
    if (result.status === "skipped") {
      skipped += 1;
      continue;
    }
    const klass = classifyResult(prompt, result);
    byClass[klass] += 1;
    (byFamily[prompt.family] ??= emptyCounts())[klass] += 1;
    rows.push({ klass, prompt, result });
  }
  return { prompts: rows.length, correct: correctOf(byClass), skipped, byClass, byFamily, rows };
}

export interface GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string;
}

const pct = (part: number, whole: number) => (whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1));

/** Gates 1-4 and 6 (gate 5 is the clarify corpus test), plus no crashes. */
export function evalGates(board: Scoreboard): GateResult[] {
  const gates = INTENT_EVAL_GATES;
  const n = board.prompts;
  const out: GateResult[] = [];
  out.push({ gate: "correct", ok: n > 0 && board.correct * 10_000 >= gates.minCorrectBps * n, detail: `${board.correct}/${n} = ${pct(board.correct, n)}% (needs ≥ ${gates.minCorrectBps / 100}%)` });
  for (const family of gates.perfectFamilies) {
    const counts = board.byFamily[family];
    const total = counts ? totalOf(counts) : 0;
    const good = counts ? correctOf(counts) : 0;
    out.push({ gate: `${family} 100%`, ok: total > 0 && good === total, detail: `${good}/${total}` });
  }
  out.push({ gate: "plans_wrongly", ok: board.byClass.plans_wrongly <= gates.maxPlansWrongly, detail: `${board.byClass.plans_wrongly} (needs ${gates.maxPlansWrongly})` });
  const refuseFamily = board.byFamily.refuse;
  const outside = n - (refuseFamily ? totalOf(refuseFamily) : 0);
  const wrongRefusals = board.byClass.refuses_wrongly - (refuseFamily?.refuses_wrongly ?? 0);
  out.push({ gate: "refuses_wrongly", ok: wrongRefusals * 10_000 <= gates.maxRefusesWronglyBps * outside, detail: `${wrongRefusals}/${outside} = ${pct(wrongRefusals, outside)}% outside refuse (needs ≤ ${gates.maxRefusesWronglyBps / 100}%)` });
  const needless = board.byClass.asks_needlessly + board.byClass.asks_wrong_question;
  out.push({ gate: "needless asks", ok: needless * 10_000 <= gates.maxNeedlessAsksBps * n, detail: `${needless}/${n} = ${pct(needless, n)}% (needs ≤ ${gates.maxNeedlessAsksBps / 100}%)` });
  out.push({ gate: "crashed", ok: board.byClass.crashed <= gates.maxCrashed, detail: `${board.byClass.crashed}` });
  return out;
}

/** The scoreboard as text, with the gates and, optionally, the fail list. */
export function formatScoreboard(board: Scoreboard, options: { readonly failList?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`prompts ${board.prompts}  correct ${board.correct} (${pct(board.correct, board.prompts)}%)  plans_wrongly=${board.byClass.plans_wrongly}${board.skipped ? `  skipped ${board.skipped}` : ""}`);
  lines.push(`  ${EVAL_CLASSES.map((klass) => `${klass} ${board.byClass[klass]}`).join("  ")}`);
  lines.push("family        n  correct  needless wrongQ refusedW plansW crashed");
  for (const [family, counts] of Object.entries(board.byFamily)) {
    const cells = [totalOf(counts), correctOf(counts)].map((value, index) => String(value).padStart(index === 0 ? 4 : 6));
    const fails = [counts.asks_needlessly, counts.asks_wrong_question, counts.refuses_wrongly, counts.plans_wrongly, counts.crashed]
      .map((value, index) => String(value).padStart([8, 6, 8, 6, 7][index] as number));
    lines.push(`  ${family.padEnd(10)} ${cells.join(" ")} ${fails.join(" ")}`);
  }
  lines.push(`gates (${INTENT_EVAL_ENFORCE ? "enforced" : "report mode"}):`);
  for (const gate of evalGates(board)) lines.push(`  ${gate.ok ? "pass" : "FAIL"}  ${gate.gate.padEnd(16)} ${gate.detail}`);
  if (options.failList) {
    for (const row of board.rows) {
      if ((EVAL_CORRECT_CLASSES as readonly string[]).includes(row.klass)) continue;
      const got = row.result.plan ?? (row.result.questions[0] ? `[${row.result.questions[0]}]` : `${row.result.error ?? ""}: ${row.result.message ?? ""}`);
      lines.push(`${row.klass.padEnd(20)} ${row.prompt.id} ${JSON.stringify(row.prompt.say)} -> ${got}`);
    }
  }
  return lines.join("\n");
}
