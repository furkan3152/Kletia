/**
 * One clarify turn of a hand-off thread: a new sentence the
 * hand-off reader reads, an answer to an open hand-off question, a commit
 * (`none`) that returns the hand-off again, or "cancel". The thread keeps the
 * hand-off's state (`thread.handoff`) and no steps; every turn decides it
 * again from the current facts and the caller's rule book.
 */
import {
  CLARIFY_POLICY_VERSION,
  CONTROL_CANCEL_PATTERN,
  effectivePerps,
  effectivePredictions,
  THREAD_LIMITS,
  THREAD_SPEC,
  type ClarifyThread,
  type IntentRequest,
  type NetworkKey,
  type ThreadHandoff,
} from "@kletia/core";
import { isPlatformError, PlatformError } from "../../errors.js";
import { compileIntentText } from "../grammar.js";
import { factsNow, type TurnFacts } from "../clarify/facts.js";
import type { Question, TurnContext, TurnInput, TurnKindName } from "../clarify/types.js";
import { answerHandoff, decideHandoff, type HandoffOutcome, type InnerReading } from "./decide.js";
import { readHandoff } from "./read.js";
import type { TurnDecision } from "../clarify/index.js";
import { findPredictionMarkets } from "../../predictions/service.js";

/** The decision layer the hand-off uses for a run's sentence (passed in: clarify/index.ts owns decideTurn). */
export interface HandoffDeps {
  readonly decideTurn: (thread: ClarifyThread | null, input: TurnInput, ctx: TurnContext, constraints?: IntentRequest["constraints"]) => Promise<TurnDecision>;
  readonly inexactReading: (decision: never) => string | null;
  readonly stateFromThread: (thread: ClarifyThread) => TurnDecision["state"];
}

const DEFAULT_PERPS = effectivePerps([]);
const DEFAULT_PREDICTIONS = effectivePredictions([]);

function wrapRun(text: string, error: unknown): never {
  if (isPlatformError(error) && error.code !== "THREAD_CLOSED") {
    throw new PlatformError(error.code, `Each run would plan "${text.slice(0, 80)}": ${error.message}`, error.status, error.issues, error.hints, error.details);
  }
  throw error;
}

/** The intent reader's reading of a run's sentence, with the answers given so far replayed. */
async function innerReading(text: string, answers: NonNullable<ThreadHandoff["inner"]>["answers"], ctx: TurnContext, deps: HandoffDeps): Promise<InnerReading> {
  const inner: TurnContext = { ...ctx, noHandoff: true };
  let decision: TurnDecision;
  try {
    decision = await deps.decideTurn(null, { text }, inner);
    for (const answer of answers) {
      if (decision.status !== "needs_input") break;
      decision = await deps.decideTurn(decision.thread, { answer }, inner);
    }
  } catch (error) {
    wrapRun(text, error);
  }
  if (decision.status === "needs_input") return { status: "needs_input", questions: decision.questions, assumptions: decision.assumptions };
  if (decision.status !== "ready" || !decision.actions || decision.actions.length === 0 || !decision.sentence) {
    throw new PlatformError("INTENT_UNSUPPORTED", `Each run would plan "${text.slice(0, 80)}", which Kletia cannot write as one sentence.`, 422);
  }
  const actions = decision.actions;
  const relative = decision.state.steps.some((step) => step.amount !== undefined && ["balance", "position", "usd"].includes(step.amount.v.t));
  const only = actions.length === 1 ? actions[0] : undefined;
  const swap = only && only.kind === "swap" && only.to && only.amount !== "max" ? { sell: only.from, buy: only.to, amount: only.amount } : null;
  const receives = only && only.kind === "swap" ? only.to : undefined;
  return { status: "ready", sentence: decision.sentence, network: actions[0]?.network as NetworkKey, relative, assumptions: decision.assumptions, swap, ...(receives ? { receives } : {}) };
}

/** Null when a run reads `text` again without questions (the grammar, or an exact reading), else why not. */
async function runReadable(text: string, ctx: TurnContext, deps: HandoffDeps): Promise<string | null> {
  try {
    compileIntentText(text, { accounts: ctx.accounts as never, contracts: ctx.contracts });
    return null;
  } catch (error) {
    // The grammar's own refusal: the exact reading below may still read it (as every run does).
    if (!isPlatformError(error) || error.code !== "INTENT_UNSUPPORTED") return isPlatformError(error) ? error.message : "it cannot be read";
  }
  const decision = await deps.decideTurn(null, { text }, { ...ctx, noHandoff: true, confirmAuthority: "api" });
  if (decision.status !== "ready") return "it would need an answer at every run";
  return deps.inexactReading(decision as never);
}

function questionOpen(thread: ClarifyThread, questions: readonly Question[], id: string): boolean {
  return thread.status === "needs_input" && questions.some((entry) => entry.id === id);
}

function handoffThread(previous: ClarifyThread | null, id: string, state: ThreadHandoff, outcome: HandoffOutcome, label: string, ctx: TurnContext): ClarifyThread {
  const turns = [...(previous?.turns ?? []), { role: "kletia" as const, kind: "handoff", label: label.slice(0, 160) }].slice(-THREAD_LIMITS.storedTurns);
  const thread: ClarifyThread = {
    spec: THREAD_SPEC,
    id,
    rev: (previous?.rev ?? 0) + 1,
    status: outcome.status === "handoff" ? "ready" : "needs_input",
    policy: CLARIFY_POLICY_VERSION,
    steps: [],
    open: outcome.status === "needs_input" ? outcome.questions.map((entry) => entry.field) : [],
    corrections: [],
    turns,
    undo: [],
    handoff: state,
    ...(previous?.textOrigin ?? ctx.textOrigin ? { textOrigin: previous?.textOrigin ?? ctx.textOrigin } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(thread), "utf8") > THREAD_LIMITS.maxBytes) {
    throw new PlatformError("THREAD_INVALID", "This task no longer fits in a thread. Start a new one with a shorter sentence.", 400, [{ path: "thread", message: "Too large." }]);
  }
  return thread;
}

/**
 * The hand-off side of a clarify turn, or null when the turn is not one (the
 * intent reader takes it). `fresh` is set when a hand-off thread gets a
 * sentence that is no hand-off: the caller reads it as a new thread.
 */
export async function handoffTurn(
  thread: ClarifyThread | null,
  input: TurnInput,
  ctx: TurnContext,
  facts: TurnFacts,
  id: string,
  deps: HandoffDeps,
): Promise<TurnDecision | { readonly fresh: true } | null> {
  if (ctx.noHandoff) return null;
  const env = {
    accounts: ctx.accounts,
    facts,
    now: factsNow(),
    perps: ctx.perps ?? DEFAULT_PERPS,
    predictions: ctx.predictions ?? DEFAULT_PREDICTIONS,
    findMarkets: (query: string) => findPredictionMarkets(query),
    inner: (text: string, answers: NonNullable<ThreadHandoff["inner"]>["answers"]) => innerReading(text, answers, ctx, deps),
    runReadable: (text: string) => runReadable(text, ctx, deps),
  };
  const kept = thread?.handoff;
  let state: ThreadHandoff | null = null;
  let turn: TurnKindName;
  let label: string;
  if ("text" in input) {
    const said = input.text.trim();
    if (kept && CONTROL_CANCEL_PATTERN.test(said)) {
      const cancelled: ClarifyThread = { ...(thread as ClarifyThread), rev: (thread as ClarifyThread).rev + 1, status: "cancelled", open: [] };
      return { status: "cancelled", turn: "control", thread: cancelled, questions: [], assumptions: [], optionSentences: new Map(), state: deps.stateFromThread(cancelled) };
    }
    state = readHandoff(said);
    turn = thread ? "replace" : "message";
    label = "Read a new request";
    if (!state && kept && thread?.status === "needs_input") {
      // A typed answer to the open question ("5x", "100", "long").
      const asked = await decideHandoff(kept, env);
      const open = asked.status === "needs_input" ? asked.questions[0] : undefined;
      if (open) {
        try {
          state = answerHandoff(kept, { question: open.id, text: said });
          turn = "answer";
          label = "Took your answer";
        } catch {
          state = null;
        }
      }
    }
    if (!state) return kept ? { fresh: true } : null;
  } else if (kept && "answer" in input) {
    const asked = await decideHandoff(kept, env);
    if (!questionOpen(thread as ClarifyThread, asked.status === "needs_input" ? asked.questions : [], input.answer.question)) {
      throw new PlatformError("QUESTION_NOT_OPEN", "That question is not open on this thread.", 409, [{ path: "answer.question", message: "Not open." }]);
    }
    state = answerHandoff(kept, input.answer);
    turn = "answer";
    label = "Took your answer";
  } else if (kept && "none" in input) {
    state = kept;
    turn = "none";
    label = "Checked again";
  } else if (kept && "assumption" in input) {
    throw new PlatformError("ANSWER_INVALID", "Change this on the surface it opens; a hand-off chip has no other options here.", 422, [{ path: "assumption", message: "No alternatives." }]);
  } else {
    return null;
  }
  const outcome = await decideHandoff(state, env);
  const next = handoffThread(turn === "message" ? null : thread, thread?.id ?? id, outcome.state, outcome, label, ctx);
  return {
    status: outcome.status,
    turn,
    thread: next,
    questions: outcome.status === "needs_input" ? outcome.questions : [],
    assumptions: outcome.assumptions,
    ...(outcome.status === "handoff" ? { handoff: outcome.handoff } : {}),
    optionSentences: new Map(),
    state: deps.stateFromThread(next),
  };
}
