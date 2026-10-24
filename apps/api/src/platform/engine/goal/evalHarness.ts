/**
 * The intent eval (intent engine v2 §6; design E): corpora of prompts
 * (`__tests__/fixtures/intent-eval.json`, `intent-hard.json`,
 * `intent-redteam.json`; `kletia.intent-eval/v1`), each run through the
 * engine with fixture wallets and fixed prices, classified against its accept
 * list and scored per family against the acceptance gates.
 *
 * Accept grammar (frozen, §7.5, plus `C:`), the first entry that matches wins:
 * - `P:<regex>`: ready, and the regex matches the plan shape (corpusHarness.shape);
 * - `C:<regex>`: the plan is right only after a one-click confirm (a corrected,
 *   derived or model reading, a moves confirm, a question-form command): ready
 *   with this shape after a confirm the harness answered is correct; ready
 *   without one is `plans_unconfirmed`;
 * - `A:<regex>`: needs input, and the regex matches "field:REASON" of the first question;
 * - `R` or `R:<CODE>`: refused (with that error code);
 * - `H:<regex>`: handed to its surface (round 9: perps, native orders, automations), and the regex matches the
 *   hand-off's shape (handoff/shape.ts). A hand-off no `H:` entry accepts is a wrong plan.
 * A confirm the harness answered before a plan the corpus accepts only with
 * `P:` is a needless ask (unless an `A:` entry accepts that confirm), and a
 * plan that differs from the sentence its confirm promised is a wrong plan
 * (I14).
 *
 * Modes (design E.2):
 * - `decide` (default): `decideTurn`, the function `POST
 *   /v1/intents?clarify=true` calls, with optional multi-turn scripts
 *   (`then`) and the one-click confirm answered once (`autoConfirm`);
 * - `plan`: a ready turn is also planned as a dry run against offline venues
 *   (evalPlan.ts); a refusal is `plans_unplannable` and a plan whose end
 *   state differs from the decision is `plans_wrongly`;
 * - `strict`: the text through the strict path (grammar, then the planner),
 *   where every question is a refusal.
 *
 * Offline and deterministic by default (stub holdings readers, a fixed price
 * reader). `runIntentEvalLive` sends the wallet-independent prompts to a
 * running API with `?clarify=true&dryRun=true` (read-only; nothing is
 * stored, signed or sent).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { findAssetBySymbol, type IntentActionSpec, type IntentHandoff, type IntentGraph, type IntentRequest, type NetworkKey } from "@kletia/core";
import { isPlatformError, type PlatformError } from "../../errors.js";
import { compileIntentText } from "../grammar.js";
import { handoffShape } from "../handoff/shape.js";
import { handoffRefusal } from "../service.js";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader, fixedPriceReader, type PriceReader } from "../prices.js";
import { REGISTRY_STAKE_PROVIDERS, STAKE_PROVIDERS } from "../clarify/catalog.js";
import type { TurnDecision } from "../clarify/index.js";
import type { ReadingHook, ResolvedAction, TurnContext, TurnInput } from "../clarify/types.js";
import { contextFor, CORPUS_PRICE_AT, CORPUS_PRICES, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type Corpus, type CorpusCase } from "../clarify/corpusHarness.js";
import { asNetwork, compareEndStates, endStateOfActions, endStateOfGraph, planActions, planRequest, withPlanWorld, type EndState } from "./evalPlan.js";
import { oracleFlags } from "./evalOracle.js";
import { resetVenueStats } from "../routing/venueStats.js";

export const INTENT_EVAL_SPEC = "kletia.intent-eval/v1";

/**
 * The gates are enforced since package P5 (goal steps on by default): the
 * test and the CLI fail when one does not hold, besides a broken corpus, a
 * crash or non-determinism.
 */
export const INTENT_EVAL_ENFORCE = true;

/** The fixed prices of the offline eval (§6): USD per whole token. */
export const EVAL_PRICES: Readonly<Record<string, number>> = CORPUS_PRICES;
/** The reading time of the fixed prices (Unix ms), so runs are byte-identical. */
export const EVAL_PRICE_AT = CORPUS_PRICE_AT;

export function evalPriceReader(): PriceReader {
  return fixedPriceReader(EVAL_PRICES, EVAL_PRICE_AT);
}

export const EVAL_MODES = Object.freeze(["decide", "plan", "strict"] as const);
export type EvalMode = (typeof EVAL_MODES)[number];

export const EVAL_CORRECT_CLASSES = Object.freeze(["plan_ok", "ask_ok", "refuse_ok"] as const);
export const EVAL_FAILURE_CLASSES = Object.freeze([
  "asks_needlessly", "asks_wrong_question", "refuses_wrongly", "plans_unconfirmed", "plans_unplannable", "plans_wrongly", "crashed",
] as const);
export const EVAL_CLASSES = Object.freeze([...EVAL_CORRECT_CLASSES, ...EVAL_FAILURE_CLASSES] as const);
export type EvalClass = (typeof EVAL_CLASSES)[number];

/**
 * Failure classes from most to least severe (design E.3): the ledger ratchet
 * fails when a prompt fails with a more severe class than recorded.
 * `plans_unconfirmed` (the right plan, but without the confirm the design
 * requires) sits below an unplannable plan and above every ask or refusal.
 */
export const EVAL_SEVERITY: readonly EvalClass[] = Object.freeze([
  "plans_wrongly", "crashed", "plans_unplannable", "plans_unconfirmed", "asks_wrong_question", "refuses_wrongly", "asks_needlessly",
] as const);

/** True when `a` is a more severe failure than `b` (a correct class is the least severe). */
export function moreSevere(a: EvalClass, b: EvalClass): boolean {
  const rank = (klass: EvalClass) => {
    const index = EVAL_SEVERITY.indexOf(klass);
    return index === -1 ? EVAL_SEVERITY.length : index;
  };
  return rank(a) < rank(b);
}

/** The acceptance gates (§6); gate 5 (the round-6 clarify corpus) is clarifyCorpus.test.ts. */
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
  /** Ready without the confirm the design requires (design A.3). */
  maxPlansUnconfirmed: 0,
  /** Plan mode: ready in clarify, refused by the planner (F-2). */
  maxPlansUnplannable: 0,
});

/** One later turn of a multi-turn script: an answer, the one-click confirm, or more text. */
export type EvalFollowUp =
  | { readonly answer: { readonly question: string; readonly option?: string; readonly text?: string } }
  | { readonly confirm: true }
  | { readonly say: string };

export interface IntentEvalPrompt {
  readonly id: string;
  readonly family: string;
  readonly say: string;
  /** A clarify-corpus fixture wallet; "full" when absent. */
  readonly wallet?: string;
  readonly request?: { readonly defaultNetwork?: NetworkKey; readonly sourceNetwork?: NetworkKey | "auto" };
  readonly accept: readonly string[];
  readonly tags: readonly string[];
  /** Why an expectation was changed (corpus hygiene, §6). */
  readonly why?: string;
  /** Sub-family label (hard corpus). */
  readonly sub?: string;
  /** The human-readable expectation the accept list was compiled from (hard corpus). */
  readonly expect?: unknown;
  readonly note?: string;
  /** Later turns, classified at the end (design E.2). */
  readonly then?: readonly EvalFollowUp[];
  /** Red-team attack ids this prompt exercises (redteam.md). */
  readonly attacks?: readonly string[];
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
  readonly status: "ready" | "needs_input" | "cancelled" | "refused" | "crashed" | "skipped" | "handoff";
  readonly error?: string;
  readonly message?: string;
  /** "field:REASON" of each question, in order. */
  readonly questions: readonly string[];
  /** The plan shape (ready turns), or the hand-off's shape (hand-off turns). */
  readonly plan: string | null;
  /** "field:source" of each assumption. */
  readonly assumptions: readonly string[];
  /** Question kinds of the last turn ("choice", "amount", "address", "confirm"). */
  readonly kinds?: readonly string[];
  /** The plan came after a one-click confirm (scripted or answered by the harness). */
  readonly confirmed?: true;
  /** "field:REASON" of the confirm the harness answered on its own (autoConfirm), not by a script. */
  readonly autoConfirmed?: string;
  /** The confirmed option's sentence differs from the plan that followed (I14): a wrong plan. */
  readonly confirmMismatch?: string;
  /** Turns run (more than one: a script or a confirm). */
  readonly turns?: number;
  /** Plan mode: the planner's answer for a ready turn. */
  readonly planned?: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };
  /** Plan mode: differences between the decided and the planned end state (empty: the same). */
  readonly endStateDiff?: readonly string[];
  /** Plan mode: the planned end state. */
  readonly endState?: EndState;
  /** Invariant and conservation flags on a ready result (evalOracle.ts). */
  readonly oracles?: readonly string[];
}

export interface ParsedAccept {
  readonly kind: "P" | "C" | "A" | "R" | "H";
  /** P, C and A: the regex; R: null. */
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
  if (kind !== "P" && kind !== "A" && kind !== "C" && kind !== "H") throw new Error(`accept "${accept}": must start with P:, C:, A:, H: or R`);
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
    case "H":
      return result.status === "handoff" && result.plan !== null && (parsed.pattern as RegExp).test(result.plan);
    case "P":
    case "C":
      return result.status === "ready" && result.plan !== null && result.plan !== "" && (parsed.pattern as RegExp).test(result.plan);
    case "A":
      return result.status === "needs_input" && result.questions.length > 0 && (parsed.pattern as RegExp).test(result.questions[0] as string);
    case "R":
      return result.status === "refused" && (parsed.code === null || result.error === parsed.code);
  }
}

/** True when an `A:` accept of the prompt matches this "field:REASON" question. */
function acceptsQuestion(prompt: IntentEvalPrompt, question: string): boolean {
  return prompt.accept.some((accept) => {
    const parsed = parsedAccept(accept);
    return parsed.kind === "A" && (parsed.pattern as RegExp).test(question);
  });
}

/** True when the prompt accepts any question (strict mode reads a refusal as that question, design C.5). */
function acceptsAsk(prompt: IntentEvalPrompt): boolean {
  return prompt.accept.some((accept) => accept.startsWith("A:") || accept.startsWith("C:"));
}

/**
 * The class of one result (port of round7 eval/score.py, plus `crashed`, the
 * confirm-only plans of `C:`, and plan mode's planner checks). In strict
 * mode (`strict`), a refusal of a prompt that accepts a question is correct:
 * the strict path refuses whatever needs a question (`CLARIFY_REQUIRED`).
 */
export function classifyResult(prompt: IntentEvalPrompt, result: EvalResult, options: { readonly strict?: boolean } = {}): EvalClass {
  if (result.status === "crashed") return "crashed";
  let klass: EvalClass | null = null;
  for (const accept of prompt.accept) {
    if (!matchesAccept(accept, result)) continue;
    const kind = parsedAccept(accept).kind;
    klass = kind === "P" || kind === "H" ? "plan_ok" : kind === "C" ? (result.confirmed ? "plan_ok" : "plans_unconfirmed") : kind === "A" ? "ask_ok" : "refuse_ok";
    // A confirm the harness answered for a plan the corpus wants without one is a needless ask,
    // unless the corpus accepts that confirm question itself.
    if ((kind === "P" || kind === "H") && result.autoConfirmed && !acceptsQuestion(prompt, result.autoConfirmed)) klass = "asks_needlessly";
    break;
  }
  if (klass === null) {
    const wantsPlan = prompt.accept.some((accept) => accept.startsWith("P:") || accept.startsWith("C:") || accept.startsWith("H:"));
    if (result.status === "ready" || result.status === "handoff") return "plans_wrongly";
    if (result.status === "needs_input") return wantsPlan ? "asks_needlessly" : "asks_wrong_question";
    if (options.strict && result.status === "refused" && acceptsAsk(prompt)) return "refuse_ok";
    return "refuses_wrongly";
  }
  // Plan mode: a plan the planner changes is wrong; one it refuses is unplannable (F-2).
  if (klass === "plan_ok" || klass === "plans_unconfirmed" || klass === "asks_needlessly") {
    if (result.confirmMismatch) return "plans_wrongly";
    if (result.endStateDiff && result.endStateDiff.length > 0) return "plans_wrongly";
    if (result.planned && !result.planned.ok) {
      // The person ends with the planner's refusal: correct when the corpus accepts that refusal.
      const code = result.planned.code;
      const refusalAccepted = prompt.accept.some((accept) => {
        const parsed = parsedAccept(accept);
        return parsed.kind === "R" && (parsed.code === null || parsed.code === code);
      });
      return refusalAccepted ? "refuse_ok" : "plans_unplannable";
    }
  }
  return klass;
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
    if (prompt.then !== undefined) {
      if (!Array.isArray(prompt.then) || prompt.then.length === 0 || prompt.then.length > 6) throw new Error(`${prompt.id}: then`);
      for (const step of prompt.then) {
        const keys = Object.keys(step);
        if (keys.length !== 1 || !["answer", "confirm", "say"].includes(keys[0] as string)) throw new Error(`${prompt.id}: then step ${JSON.stringify(step)}`);
      }
    }
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

export interface PromptOptions {
  readonly mode?: EvalMode;
  /**
   * Answer a one-click confirm (a question of kind "confirm") once and
   * classify what follows (design E.2: a wrong reading the person would have
   * had to catch still counts as a wrong plan).
   */
  readonly autoConfirm?: boolean;
  /** The model-assisted reading hook (seam S5), passed to every turn as `TurnContext.reader`. */
  readonly reader?: ReadingHook;
  /** Who answers the turns (seam S5); the harness confirms as the desk by default. */
  readonly confirmAuthority?: "desk";
  /** Run the invariant and conservation oracles on ready results. */
  readonly oracles?: boolean;
}

function errorResult(prompt: IntentEvalPrompt, status: "refused" | "crashed", code: string, message: string, turns?: number): EvalResult {
  return { id: prompt.id, say: prompt.say, status, error: code, message: message.slice(0, 200), questions: [], plan: null, assumptions: [], ...(turns && turns > 1 ? { turns } : {}) };
}

function decisionResult(prompt: IntentEvalPrompt, decision: TurnDecision, extra: Partial<EvalResult>): EvalResult {
  return {
    id: prompt.id,
    say: prompt.say,
    status: decision.status,
    questions: decision.questions.map((question) => `${question.field}:${question.reason}`),
    plan: decision.handoff ? handoffShape(decision.handoff) : decision.actions ? shape(decision.actions) : null,
    assumptions: decision.assumptions.map((assumption) => `${assumption.field}:${assumption.source}`),
    ...(decision.questions.length > 0 ? { kinds: decision.questions.map((question) => question.kind) } : {}),
    ...extra,
  };
}

/** The option of a confirm question that says yes ("confirm", "yes", or a label starting with "Yes"). */
function confirmOption(decision: TurnDecision): { question: string; option: string } | null {
  const question = decision.questions[0];
  if (!question || question.kind !== "confirm") return null;
  const option = question.options.find((entry) => entry.id === "confirm" || entry.id === "yes") ?? question.options.find((entry) => /^yes\b/iu.test(entry.label));
  return option ? { question: question.id, option: option.id } : null;
}

function followUpInput(step: EvalFollowUp, decision: TurnDecision): TurnInput | null {
  if ("say" in step) return { text: step.say };
  if ("answer" in step) return { answer: step.answer };
  const yes = confirmOption(decision);
  return yes ? { answer: yes } : null;
}

/** The sentence a confirm option promised (the "Yes" leads to this plan), if the turn rendered one. */
function promisedSentence(decision: TurnDecision, yes: { question: string; option: string }): string | null {
  return decision.optionSentences.get(`${yes.question}|${yes.option}`) ?? null;
}

interface DecideOutcome {
  readonly result: EvalResult;
  readonly ctx: TurnContext;
  readonly decision?: TurnDecision;
}

async function decidePrompt(fixtures: Corpus, prompt: IntentEvalPrompt, options: PromptOptions): Promise<DecideOutcome> {
  const entry = caseOf(prompt);
  installWallet(fixtures, entry.wallet);
  if (pricesOverride) configurePriceReader(pricesOverride);
  const ctx: TurnContext = {
    ...contextFor(fixtures, entry),
    ...(options.reader ? { reader: options.reader } : {}),
    ...(options.reader || options.confirmAuthority ? { confirmAuthority: options.confirmAuthority ?? "desk" } : {}),
  };
  let run = await runTurn(null, { text: prompt.say }, ctx);
  let turns = 1;
  let confirmed = false;
  let autoConfirmed: string | null = null;
  // The sentence the last answered confirm promised; checked against the plan that follows it (I14).
  let promised: string | null = null;
  const script = [...(prompt.then ?? [])];
  for (;;) {
    if (run.error) return { result: errorResult(prompt, "refused", run.error.code, run.error.message, turns), ctx };
    const decision = run.decision;
    if (!decision) throw new Error("no decision");
    let next: TurnInput | null = null;
    const scripted = script.shift();
    if (scripted) {
      next = followUpInput(scripted, decision);
      if (next === null) throw new Error(`${prompt.id}: the script confirms, but no confirm question is open`);
      if ("confirm" in scripted) confirmed = true;
      const yes = "confirm" in scripted ? confirmOption(decision) : null;
      promised = yes ? promisedSentence(decision, yes) : null;
    } else if (options.autoConfirm && !confirmed && decision.status === "needs_input") {
      const yes = confirmOption(decision);
      if (yes) {
        next = { answer: yes };
        confirmed = true;
        const question = decision.questions[0];
        autoConfirmed = question ? `${question.field}:${question.reason}` : "confirm";
        promised = promisedSentence(decision, yes);
      }
    }
    if (next === null) {
      const mismatch = decision.status === "ready" && promised !== null && decision.sentence && decision.sentence !== promised
        ? `confirmed "${promised.slice(0, 160)}", planned "${decision.sentence.slice(0, 160)}"`
        : null;
      return {
        result: decisionResult(prompt, decision, {
          ...(confirmed ? { confirmed: true as const } : {}),
          ...(autoConfirmed ? { autoConfirmed } : {}),
          ...(mismatch ? { confirmMismatch: mismatch } : {}),
          ...(turns > 1 ? { turns } : {}),
        }),
        ctx,
        decision,
      };
    }
    run = await runTurn(decision.thread, next, ctx);
    turns += 1;
  }
}

/** Plan mode: plans a ready decision as a dry run against the offline venues. */
async function planDecided(fixtures: Corpus, prompt: IntentEvalPrompt, outcome: DecideOutcome): Promise<EvalResult> {
  const decision = outcome.decision;
  if (!decision || decision.status !== "ready" || !decision.actions) return outcome.result;
  const actions = decision.actions;
  const planned = await withPlanWorld(fixtures, prompt.wallet ?? "full", () => planActions(actions, decision.sentence ?? null, outcome.ctx));
  if (!planned.ok) return { ...outcome.result, planned: { ok: false, code: planned.code, message: planned.message } };
  const endState = endStateOfGraph(planned.graph, outcome.ctx.accounts);
  return { ...outcome.result, planned: { ok: true }, endState, endStateDiff: compareEndStates(endStateOfActions(actions), endState) };
}

/** ResolvedAction-like steps from compiled specs (strict mode's shape and end state). */
function actionsOfSpecs(specs: readonly IntentActionSpec[]): ResolvedAction[] {
  let output = "";
  return specs.map((spec) => {
    const portion = typeof spec.params?.portionBps === "number" ? spec.params.portionBps : undefined;
    const from = spec.from ? canonicalSymbol(spec.network, spec.from) : output;
    const to = spec.to ? canonicalSymbol(spec.toNetwork ?? spec.network, spec.to) : undefined;
    output = to ?? from;
    return {
      kind: spec.kind as ResolvedAction["kind"],
      network: spec.network,
      ...(spec.toNetwork ? { toNetwork: spec.toNetwork } : {}),
      from,
      ...(to ? { to } : {}),
      amount: spec.amount ?? "max",
      ...(portion !== undefined ? { portionBps: portion } : {}),
      ...(spec.recipient ? { recipient: spec.recipient } : {}),
      ...(spec.protocol ? { protocol: spec.protocol } : {}),
    };
  });
}

/** Strict mode: a hand-off the strict path refuses with INTENT_HANDOFF and its typed hand-off (round 9), or null. */
async function strictHandoffResult(prompt: IntentEvalPrompt, ctx: TurnContext, error: PlatformError): Promise<EvalResult | null> {
  try {
    // compileIntentText's own refusal (the planner marks it as the grammar's only when it calls the grammar itself).
    if (error.code === "INTENT_UNSUPPORTED") await handoffRefusal({ text: prompt.say, accounts: ctx.accounts, ...(ctx.defaultNetwork ? { defaultNetwork: ctx.defaultNetwork } : {}) });
    return null;
  } catch (handoffError) {
    if (!isPlatformError(handoffError)) throw handoffError;
    const handoff = (handoffError.details as { handoff?: IntentHandoff } | undefined)?.handoff;
    if (!handoff) return errorResult(prompt, "refused", handoffError.code, handoffError.message);
    return { id: prompt.id, say: prompt.say, status: "handoff", questions: [], plan: handoffShape(handoff), assumptions: [] };
  }
}

/** Strict mode: the text through the strict grammar and the planner (no questions: anything else is a refusal). */
async function strictPrompt(fixtures: Corpus, prompt: IntentEvalPrompt): Promise<EvalResult> {
  const entry = caseOf(prompt);
  installWallet(fixtures, entry.wallet);
  if (pricesOverride) configurePriceReader(pricesOverride);
  const ctx = contextFor(fixtures, entry);
  let specs: IntentActionSpec[];
  try {
    specs = compileIntentText(prompt.say, { accounts: ctx.accounts as never, ...(ctx.defaultNetwork ? { defaultNetwork: ctx.defaultNetwork } : {}), contracts: ctx.contracts }).actions;
  } catch (error) {
    if (!isPlatformError(error)) throw error;
    const handed = await strictHandoffResult(prompt, ctx, error);
    return handed ?? errorResult(prompt, "refused", error.code, error.message);
  }
  const request = {
    text: prompt.say,
    accounts: ctx.accounts,
    ...(ctx.defaultNetwork ? { defaultNetwork: ctx.defaultNetwork } : {}),
    ...(ctx.sourceNetwork ? { sourceNetwork: ctx.sourceNetwork } : {}),
  } as IntentRequest;
  const planned = await withPlanWorld(fixtures, entry.wallet, () => planRequest(request));
  if (!planned.ok) return { ...errorResult(prompt, "refused", planned.code, planned.message), planned: { ok: false, code: planned.code, message: planned.message } };
  const actions = actionsOfSpecs(specs);
  const endState = endStateOfGraph(planned.graph, ctx.accounts);
  // A departure (sourceNetwork) adds legs the sentence does not have: only the sentence's own end state is compared.
  const diff = ctx.sourceNetwork ? [] : compareEndStates(endStateOfActions(actions), endState);
  return { id: prompt.id, say: prompt.say, status: "ready", questions: [], plan: strictShape(specs, planned.graph), assumptions: [], planned: { ok: true }, endState, endStateDiff: diff };
}

/**
 * Strict mode's plan shape: the compiled specs, plus every crossing leg the
 * planner's strict-path safety net inserted between dependent steps on
 * different networks (design C.5), so a plan that crosses is shown crossing.
 * Graph steps are matched to the specs in order by kind and network; the
 * unmatched ones are the inserted legs. Falls back to the specs' shape when
 * the graph cannot be matched that way.
 */
function strictShape(specs: readonly IntentActionSpec[], graph: IntentGraph): string {
  const base = specShape(specs);
  if (graph.steps.length <= specs.length) return base;
  const parts = base.split(" | ");
  if (parts.length !== specs.length) return base;
  const out: string[] = [];
  let next = 0;
  for (const step of graph.steps) {
    const spec = specs[next];
    if (spec && spec.kind === step.kind && spec.network === step.network) {
      out.push(parts[next] as string);
      next += 1;
      continue;
    }
    // An inserted crossing: it carries the previous output to the network of the step it feeds.
    const destination = spec?.network;
    if (!destination || destination === step.network || !step.input) return base;
    const from = canonicalSymbol(step.network, step.input.symbol);
    const toSymbol = step.expectedOutput ? canonicalSymbol(destination, step.expectedOutput.symbol) : from;
    const to = toSymbol.toUpperCase() !== from.toUpperCase() ? `->${toSymbol}` : "";
    out.push(`${step.kind}@${step.network}->${destination} max ${from}${to}`);
  }
  return next === specs.length ? out.join(" | ") : base;
}

/** Runs one prompt offline in the given mode (the caller installs the price reader). */
export async function runPrompt(fixtures: Corpus, prompt: IntentEvalPrompt, options: PromptOptions = {}): Promise<EvalResult> {
  // Every prompt starts from the same venue statistics: a breaker opened or a fill rate learnt
  // by an earlier prompt's dry runs must not change this prompt's routes (determinism, E.2).
  resetVenueStats();
  try {
    if (options.mode === "strict") return await strictPrompt(fixtures, prompt);
    const outcome = await decidePrompt(fixtures, prompt, options);
    let result = options.mode === "plan" ? await planDecided(fixtures, prompt, outcome) : outcome.result;
    if (options.oracles && result.status === "ready" && outcome.decision?.actions) {
      const wallet = fixtures.fixtures.wallets[prompt.wallet ?? "full"];
      const flags = oracleFlags({ text: prompt.say, actions: outcome.decision.actions, balances: wallet?.balances ?? null, confirmed: result.confirmed === true });
      if (flags.length > 0) result = { ...result, oracles: flags };
    }
    return result;
  } catch (error) {
    return errorResult(prompt, "crashed", "CRASH", String((error as Error)?.message ?? error));
  }
}

export interface RunOptions extends PromptOptions {
  /** Defaults to the fixed eval prices; null keeps whatever reader is installed. */
  readonly prices?: PriceReader | null;
  readonly filter?: (prompt: IntentEvalPrompt) => boolean;
}

/**
 * The run options of a mode as the gates use them (design E.2): decide and
 * plan answer a one-click confirm once and run the oracles; strict has no
 * questions to answer. `confirm: false` leaves confirms open.
 */
export function modeRunOptions(mode: EvalMode, options: { readonly confirm?: boolean } = {}): RunOptions {
  return { mode, autoConfirm: (options.confirm ?? true) && mode !== "strict", oracles: mode !== "strict" };
}

/**
 * The offline eval never reaches the network (determinism, E.2): a token
 * search for a symbol Kletia does not list answers "no such token" (the
 * fixture world knows no unlisted tokens), and any other request fails as a
 * network error. Returns the function that restores the real fetch.
 */
export function installOfflineFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/tokens\/v\d+\/search\?/u.test(url)) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    // Round 10: prediction hand-offs search Polymarket; the eval answers from recorded searches (unknown words: none).
    if (/\/public-search\?/u.test(url)) {
      const query = (new URL(url).searchParams.get("q") ?? "").toLowerCase();
      return new Response(JSON.stringify(predictionSearches()[query] ?? { events: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new TypeError(`offline eval: no network (${url.slice(0, 80)})`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const PREDICTION_SEARCHES = new URL("../__tests__/fixtures/predictions/eval-search.json", import.meta.url);
let predictionSearchCache: Record<string, unknown> | null = null;

/** Recorded Polymarket searches of the eval's prediction prompts (Gamma /public-search, trimmed), keyed by lower-case words. */
function predictionSearches(): Record<string, unknown> {
  predictionSearchCache ??= existsSync(PREDICTION_SEARCHES) ? (JSON.parse(readFileSync(PREDICTION_SEARCHES, "utf8")) as Record<string, unknown>) : {};
  return predictionSearchCache;
}

/** Runs every prompt offline, in corpus order; restores the holdings and price readers afterwards. */
export async function runIntentEval(corpus: IntentEvalCorpus, fixtures: Corpus, options: RunOptions = {}): Promise<EvalResult[]> {
  const prices = options.prices === undefined ? evalPriceReader() : options.prices;
  if (prices) configurePriceReader(prices);
  pricesOverride = options.prices === undefined ? null : options.prices;
  const out: EvalResult[] = [];
  const restoreFetch = installOfflineFetch();
  try {
    for (const prompt of corpus.prompts) {
      if (options.filter && !options.filter(prompt)) continue;
      out.push(await runPrompt(fixtures, prompt, options));
    }
  } finally {
    restoreFetch();
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

/** A symbol's listed spelling on a network ("usdc" -> "USDC", "wsteth" -> "wstETH"), else as typed. */
function canonicalSymbol(network: string | undefined, symbol: string): string {
  const key = asNetwork(network);
  return (key && findAssetBySymbol(key, symbol)?.symbol) || symbol;
}

/**
 * A grammar provider label ("Jito", "ether.fi", "Sanctum" for hSOL) as clarify's provider id ("jito", "etherfi",
 * "sanctum-hsol"); a swap's Jupiter venue filter ("avoid:raydium") as it is.
 */
function providerIdOf(label: string, symbol: string | undefined): string {
  if (/^(?:dexes|avoid):/u.test(label)) return label;
  const named = [...STAKE_PROVIDERS, ...REGISTRY_STAKE_PROVIDERS].filter((entry) => entry.grammarProvider.toLowerCase() === label.toLowerCase());
  return (named.find((entry) => symbol !== undefined && entry.symbol.toUpperCase() === symbol.toUpperCase()) ?? named[0])?.id
    ?? label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

/**
 * The plan shape of compiled specs, in corpusHarness.shape's format (the live
 * API returns a sentence and the strict path specs, not resolved actions):
 * symbols in their listed spelling, a dependent step spending the previous
 * step's output, provider ids as clarify names them. Best effort.
 */
export function specShape(specs: readonly IntentActionSpec[]): string {
  let output = "";
  return specs
    .map((spec) => {
      const portion = typeof spec.params?.portionBps === "number" ? spec.params.portionBps : undefined;
      const amount = spec.amount === "max" || spec.amount === undefined ? (portion && portion !== 10_000 ? `max(${portion})` : "max") : spec.amount;
      // A dependent step spends the previous step's output (clarify resolves `from` the same way).
      const from = spec.from ? canonicalSymbol(spec.network, spec.from) : output;
      const toSymbol = spec.to ? canonicalSymbol(spec.toNetwork ?? spec.network, spec.to) : undefined;
      output = toSymbol ?? from;
      const to = toSymbol && toSymbol.toUpperCase() !== from.toUpperCase() ? `->${toSymbol}` : "";
      const recipient = spec.recipient ? ` to ${spec.recipient}` : "";
      const venue = typeof spec.params?.venue === "string" ? `:${spec.params.venue}` : "";
      const protocol = spec.protocol && spec.kind !== "stake" ? ` [${spec.protocol}${venue}]` : "";
      const label = spec.params?.provider;
      const provider = typeof label === "string" ? ` {${providerIdOf(label, toSymbol)}}` : "";
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
  readonly questions?: readonly { readonly field: string; readonly reason: string; readonly kind?: string }[];
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
        const questions = json.questions ?? [];
        out.push({
          ...base,
          status: "needs_input",
          questions: questions.map((q) => `${q.field}:${q.reason}`),
          plan: null,
          assumptions,
          ...(questions.some((q) => q.kind) ? { kinds: questions.map((q) => q.kind ?? "") } : {}),
        });
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
  /** Ready results that raised an invariant or conservation flag (oracles on). */
  readonly flagged: number;
}

function emptyCounts(): Record<EvalClass, number> {
  return Object.fromEntries(EVAL_CLASSES.map((klass) => [klass, 0])) as Record<EvalClass, number>;
}

const correctOf = (counts: ClassCounts) => EVAL_CORRECT_CLASSES.reduce((sum, klass) => sum + counts[klass], 0);
const totalOf = (counts: ClassCounts) => EVAL_CLASSES.reduce((sum, klass) => sum + counts[klass], 0);

export function scoreIntentEval(corpus: IntentEvalCorpus, results: readonly EvalResult[], options: { readonly strict?: boolean } = {}): Scoreboard {
  const prompts = new Map(corpus.prompts.map((prompt) => [prompt.id, prompt]));
  const byClass = emptyCounts();
  const byFamily: Record<string, Record<EvalClass, number>> = {};
  const rows: Scoreboard["rows"][number][] = [];
  let skipped = 0;
  let flagged = 0;
  for (const result of results) {
    const prompt = prompts.get(result.id);
    if (!prompt) throw new Error(`result for unknown prompt ${result.id}`);
    if (result.status === "skipped") {
      skipped += 1;
      continue;
    }
    const klass = classifyResult(prompt, result, options);
    byClass[klass] += 1;
    (byFamily[prompt.family] ??= emptyCounts())[klass] += 1;
    if (result.oracles && result.oracles.length > 0) flagged += 1;
    rows.push({ klass, prompt, result });
  }
  return { prompts: rows.length, correct: correctOf(byClass), skipped, byClass, byFamily, rows, flagged };
}

export interface GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string;
}

const pct = (part: number, whole: number) => (whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1));

/** Gates 1-4 and 6 of §6 (gate 5 is the clarify corpus test), plus no crashes, no unconfirmed plans and, in plan mode, no unplannable plans. */
export function evalGates(board: Scoreboard, options: { readonly mode?: EvalMode; readonly ledgered?: ReadonlySet<string> } = {}): GateResult[] {
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
  out.push({ gate: "plans_unconfirmed", ok: board.byClass.plans_unconfirmed <= gates.maxPlansUnconfirmed, detail: `${board.byClass.plans_unconfirmed} (needs ${gates.maxPlansUnconfirmed})` });
  if (options.mode === "plan") {
    // Unplannable prompts the ledger records (E.3) are reported, not failed, until their package clears them.
    const unplannable = board.rows.filter((row) => row.klass === "plans_unplannable");
    const open = unplannable.filter((row) => !options.ledgered?.has(row.prompt.id)).length;
    const ledgered = unplannable.length - open;
    out.push({ gate: "plans_unplannable", ok: open <= gates.maxPlansUnplannable, detail: `${open}${ledgered ? ` (+${ledgered} ledgered)` : ""} (needs ${gates.maxPlansUnplannable})` });
  }
  return out;
}

/** The scoreboard as text (the format of round7 eval/score.py), with the gates and, optionally, the fail list. */
export function formatScoreboard(
  board: Scoreboard,
  options: { readonly failList?: boolean; readonly mode?: EvalMode; readonly gates?: boolean; readonly ledgered?: ReadonlySet<string> } = {},
): string {
  const lines: string[] = [];
  lines.push(`prompts ${board.prompts}  correct ${board.correct} (${pct(board.correct, board.prompts)}%)  plans_wrongly=${board.byClass.plans_wrongly}${board.skipped ? `  skipped ${board.skipped}` : ""}${board.flagged ? `  oracle-flagged ${board.flagged}` : ""}`);
  lines.push(`  ${EVAL_CLASSES.map((klass) => `${klass} ${board.byClass[klass]}`).join("  ")}`);
  lines.push("family        n  correct  needless wrongQ refusedW unconf unplan plansW crashed");
  for (const [family, counts] of Object.entries(board.byFamily)) {
    const cells = [totalOf(counts), correctOf(counts)].map((value, index) => String(value).padStart(index === 0 ? 4 : 6));
    const fails = [counts.asks_needlessly, counts.asks_wrong_question, counts.refuses_wrongly, counts.plans_unconfirmed, counts.plans_unplannable, counts.plans_wrongly, counts.crashed]
      .map((value, index) => String(value).padStart([8, 6, 8, 6, 6, 6, 7][index] as number));
    lines.push(`  ${family.padEnd(10)} ${cells.join(" ")} ${fails.join(" ")}`);
  }
  if (options.gates !== false) {
    lines.push(`gates (${INTENT_EVAL_ENFORCE ? "enforced" : "report mode"}):`);
    for (const gate of evalGates(board, options)) lines.push(`  ${gate.ok ? "pass" : "FAIL"}  ${gate.gate.padEnd(17)} ${gate.detail}`);
  }
  if (options.failList) {
    for (const row of board.rows) {
      const flags = row.result.oracles && row.result.oracles.length > 0 ? `  {${row.result.oracles.join("; ")}}` : "";
      if ((EVAL_CORRECT_CLASSES as readonly string[]).includes(row.klass) && !flags) continue;
      const planned = row.result.planned && !row.result.planned.ok ? ` (planner: ${row.result.planned.code})` : row.result.endStateDiff?.length ? ` (end state: ${row.result.endStateDiff.join("; ")})` : "";
      const got = row.result.plan ?? (row.result.questions[0] ? `[${row.result.questions[0]}]` : `${row.result.error ?? ""}: ${row.result.message ?? ""}`);
      lines.push(`${row.klass.padEnd(20)} ${row.prompt.id} ${JSON.stringify(row.prompt.say)} -> ${got}${planned}${flags}`);
    }
  }
  return lines.join("\n");
}
