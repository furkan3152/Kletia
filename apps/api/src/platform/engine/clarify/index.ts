/**
 * The clarify engine (clarify design §4, §5): one turn on a task's thread.
 *
 *   request -> secret screen -> validate -> thread (client-held or loaded)
 *     -> reducer + policy over this turn's wallet facts (holdings.readFacts)
 *     -> needs_input: at most two questions, chips, a draft
 *     -> ready: departure.ts's rules on the resolved actions, the canonical
 *        sentence, then createIntentDetailed (dry run or stored) with
 *        interpretation { assumptions, thread, departure }.
 *
 * `sourceNetwork` is applied here and never forwarded: the canonical sentence
 * names every network, so the planner would otherwise read it as "the
 * sentence wins". A refusal at any point throws and leaves the thread as it
 * was. Nothing read (balances, names) is stored in the thread.
 */
import { randomBytes } from "node:crypto";
import {
  CLARIFY_POLICY_VERSION,
  PURPOSE_REASONS,
  THREAD_LIMITS,
  THREAD_SPEC,
  UNSUGGESTED_REASONS,
  validateIntentTurnRequest,
  validateThread,
  CLARIFY_LIMITS,
  isKnownSymbol,
  isNetworkKey,
  LOOKALIKE_FAMILIES,
  normalizeMessage,
  type Goal,
  type ClarifyAssumption,
  type ClarifyDraft,
  type ClarifyDraftStep,
  type ClarifyOption,
  type ClarifyQuestion,
  type ClarifyThread,
  type IntentDeparture,
  type IntentHandoff,
  type IntentRequest,
  type IntentTurnRequest,
  type IntentTurnResponse,
  type NetworkKey,
  type ThreadStep,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { contractDirectory, contractsEnabled, type ContractPhrase } from "../contracts/directory.js";
import { resolveDeparture, type DepartureBalanceReader } from "../departure.js";
import { assertNoSecret } from "../secretScreen.js";
import { createIntentDetailed, inexactReading } from "../service.js";
import { handoffTurn } from "../handoff/turn.js";
import { networkName } from "./catalog.js";
import { assumption, clip } from "./copy.js";
import { TurnFacts } from "./facts.js";
import { goalStepFrom, isGoalStep, isPlaceholder, placeholderOf, storedGoal } from "./goals.js";
import { closestSentence, fromActionSpecs, render, toActionSpecs } from "./render.js";
import { reduceTurn, type ReduceOutcome } from "./turn.js";
import type { Assumption, EditOp, Option, Question, ResolvedAction, TurnContext, TurnInput, TurnKindName, UnreadClause, WorkState, WorkStep } from "./types.js";
import { invariantRefusal, lookalikeRefusal, readyViolations, unlistedLookalikes } from "../solver/invariants.js";

export type { ResolvedAction, TurnContext, TurnInput } from "./types.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** "th_" + 24 base32 characters (120 random bits). */
export function newThreadId(): string {
  const bytes = randomBytes(24);
  let id = "th_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}

/* -------------------------------------------------- thread <-> state */

const SLOT_KEYS = ["kind", "amount", "from", "to", "network", "toNetwork", "recipient", "protocol", "vault", "provider", "contract", "fundFrom"] as const;

function stepToThread(input: WorkStep): ThreadStep {
  // A goal step is stored as a placeholder (no kind) plus its Goal in thread.goals.
  const step = isGoalStep(input) ? placeholderOf(input) : input;
  const out: Record<string, unknown> = {};
  for (const key of SLOT_KEYS) {
    const slot = step[key];
    if (slot) {
      // The grounding ledger (A.4) travels with the slot: offsets, rule and question ids only, never words.
      out[key] = { v: slot.v, by: slot.by, ...(slot.why && slot.by === "assumed" ? { why: slot.why } : {}), ...(slot.prov ? { prov: slot.prov } : {}) };
    }
  }
  if (step.kindCandidates && step.kindCandidates.length > 0) out.kindCandidates = [...step.kindCandidates];
  if (step.usdFrom) out.usdFrom = true;
  if (step.usdTo) out.usdTo = true;
  // How the step was read (A.3): a confirm-class reading keeps asking until the person confirms the solved plan.
  if (step.keep && step.keep.length > 0) out.keep = step.keep.slice(0, 4);
  if (step.modelRead) out.modelRead = true;
  if (step.readAs && step.readAs.length > 0) out.readAs = step.readAs.slice(0, 4);
  if (step.questionForm) out.questionForm = true;
  if (step.source) out.source = step.source;
  return out as ThreadStep;
}

function stepFromThread(step: ThreadStep, keepAssumed: boolean): WorkStep {
  const out = JSON.parse(JSON.stringify(step)) as WorkStep;
  if (!keepAssumed) {
    for (const key of SLOT_KEYS) if (out[key]?.by === "assumed") delete out[key];
  }
  return out;
}

const EDIT_OPS = new Set(["amount", "network", "recipient", "asset", "provider", "bridgeVenue", "lending", "dex"]);

/** A client-held pendingEdit must be one of the engine's edit shapes (core leaves its shape to the engine). */
function validPendingEdit(value: unknown): value is EditOp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  if (typeof edit.op !== "string" || !EDIT_OPS.has(edit.op)) return false;
  const text = (key: string, max = 128) => typeof edit[key] === "string" && (edit[key] as string).length > 0 && (edit[key] as string).length <= max;
  switch (edit.op) {
    case "amount":
      return validateThread({ ...EMPTY_PROBE, steps: [{ amount: { v: edit.amount, by: "user" } }] }).ok && (edit.unit === undefined || text("unit", 16));
    case "network":
      return ["from", "to", "on", "use"].includes(edit.dir as string) && isNetworkKey(edit.network);
    case "recipient":
      return text("recipient");
    case "asset":
      return text("symbol", 16);
    default:
      return text(edit.op === "provider" ? "provider" : "protocol", 64);
  }
}

const EMPTY_PROBE = { spec: THREAD_SPEC, id: "th_aaaaaaaaaaaaaaaaaaaaaaaa", rev: 0, status: "ready", policy: CLARIFY_POLICY_VERSION, open: [], corrections: [], turns: [], undo: [] };

/** The working state of a thread; a thread of an older policy keeps its slots and re-decides assumed ones (§4.13). */
export function stateFromThread(thread: ClarifyThread): WorkState {
  const current = thread.policy === CLARIFY_POLICY_VERSION;
  if (thread.pendingEdit !== undefined && !validPendingEdit(thread.pendingEdit)) {
    throw new PlatformError("THREAD_INVALID", "The thread is not valid. Send it exactly as the last response returned it, or start a new one.", 400, [{ path: "thread.pendingEdit", message: "Not an edit Kletia wrote." }]);
  }
  if (thread.status === "needs_input" && thread.open.includes("edit") && thread.pendingEdit === undefined) {
    throw new PlatformError("THREAD_INVALID", "The thread is not valid. Send it exactly as the last response returned it, or start a new one.", 400, [{ path: "thread.open", message: "An edit question without its edit." }]);
  }
  // Goal steps: each placeholder step (no kind) takes the next stored Goal.
  const goals = thread.goals ?? [];
  const placeholders = thread.steps.filter((step) => isPlaceholder(step)).length;
  if (placeholders !== goals.length) {
    throw new PlatformError("THREAD_INVALID", "The thread is not valid. Send it exactly as the last response returned it, or start a new one.", 400, [{ path: "thread.goals", message: "One goal per goal step." }]);
  }
  let next = 0;
  const steps = thread.steps.map((step) => {
    const work = stepFromThread(step, current);
    if (!isPlaceholder(step)) return work;
    const goal = goals[next] as NonNullable<ClarifyThread["goals"]>[number];
    next += 1;
    return goalStepFrom(work, goal);
  });
  return {
    id: thread.id,
    rev: thread.rev,
    status: thread.status,
    steps,
    open: [...thread.open],
    ...(thread.pendingEdit !== undefined && current ? { pendingEdit: thread.pendingEdit as WorkState["pendingEdit"] } : {}),
    corrections: thread.corrections.map((entry) => ({ ...entry })),
    turns: thread.turns.map((entry) => ({ ...entry })),
    undo: thread.undo.filter((snapshot) => !snapshot.some((step) => isPlaceholder(step))).map((snapshot) => snapshot.map((step) => stepFromThread(step, current))),
    // A digest of another policy version never settles anything (its plan may read differently now).
    ...(thread.confirmDigest !== undefined && current ? { confirmDigest: thread.confirmDigest } : {}),
    ...(thread.textOrigin !== undefined ? { textOrigin: thread.textOrigin } : {}),
  };
}

function serialisedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The thread blob of a state, within THREAD_LIMITS (older undo snapshots, then older turns, go first). */
export function threadFromState(state: WorkState): ClarifyThread {
  const goals = state.steps.filter(isGoalStep).map((step) => storedGoal(step));
  let thread: ClarifyThread = {
    spec: THREAD_SPEC,
    id: state.id,
    rev: state.rev,
    status: state.status,
    policy: CLARIFY_POLICY_VERSION,
    steps: state.steps.map(stepToThread),
    open: state.status === "needs_input" ? [...state.open] : [],
    ...(state.pendingEdit ? { pendingEdit: state.pendingEdit } : {}),
    corrections: state.corrections.slice(0, THREAD_LIMITS.maxSteps * 4),
    turns: state.turns.slice(-THREAD_LIMITS.storedTurns),
    // An undo snapshot with goal steps is not kept: its goals are not stored (undo then goes further back).
    undo: state.undo.filter((snapshot) => !snapshot.some(isGoalStep)).slice(-THREAD_LIMITS.undoSnapshots).map((snapshot) => snapshot.map(stepToThread)),
    ...(goals.length > 0 ? { goals } : {}),
    ...(state.confirmDigest ? { confirmDigest: state.confirmDigest } : {}),
    ...(state.textOrigin ? { textOrigin: state.textOrigin } : {}),
  };
  while (serialisedBytes(thread) > THREAD_LIMITS.maxBytes && (thread.undo.length > 0 || thread.turns.length > 0)) {
    thread = thread.undo.length > 0 ? { ...thread, undo: thread.undo.slice(1) } : { ...thread, turns: thread.turns.slice(1) };
  }
  if (serialisedBytes(thread) > THREAD_LIMITS.maxBytes) {
    throw new PlatformError("THREAD_INVALID", "This task no longer fits in a thread. Start a new one with a shorter sentence.", 400, [{ path: "thread", message: "Too large." }]);
  }
  return thread;
}

/* ------------------------------------------------------------ decide */

export interface TurnDecision {
  /** `handoff`: a perps trade, native order or automation for its own surface (round 9); nothing to plan here. */
  readonly status: "ready" | "needs_input" | "cancelled" | "handoff";
  readonly turn: TurnKindName;
  readonly thread: ClarifyThread;
  readonly questions: readonly Question[];
  readonly assumptions: readonly Assumption[];
  /** Ready turns: the actions to plan, after departure.ts's rules. */
  readonly actions?: readonly ResolvedAction[];
  /** Ready turns: the canonical sentence, or null when a step has no sentence shape (structured fallback). */
  readonly sentence?: string | null;
  readonly departure?: IntentDeparture;
  /** Ready turns: gas top-ups the person chose on GAS_ON_ARRIVAL (constraints.gasOnArrival of the plan request). */
  readonly gasOnArrival?: Readonly<Record<string, string>>;
  /** The plan carries a model-assisted reading (confirmed by the person), or the open question confirms one. */
  readonly modelReading?: true;
  /** Option sentences by question id and option id ("the sentence this choice leads to"). */
  readonly optionSentences: ReadonlyMap<string, string>;
  readonly state: WorkState;
  /** Hand-off turns: the surface, its typed input and a summary. */
  readonly handoff?: IntentHandoff;
}

/** Runs the reducer over this turn's facts, reading more until the policy asks for nothing new. */
async function reduceWithFacts(previous: WorkState | null, input: TurnInput, ctx: TurnContext, facts: TurnFacts, id: string, readings?: ReadonlyMap<number, readonly Goal[]>): Promise<ReduceOutcome> {
  for (let round = 0; ; round += 1) {
    let outcome: ReduceOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = reduceTurn(previous, input, ctx, facts, () => id, readings);
    } catch (error) {
      failure = error;
    }
    if (!facts.pending || round >= 6) {
      if (failure) throw failure;
      return outcome as ReduceOutcome;
    }
    await facts.read();
  }
}

function departureReader(facts: TurnFacts): DepartureBalanceReader {
  return async (reads) => {
    const lookup = () => reads.map((read) => facts.balanceUnits(read.network, read.asset));
    lookup();
    if (facts.pending) await facts.read();
    return lookup();
  };
}

/** Applies the request's departure with departure.ts's rules (fixed or auto) to ready actions. */
async function applyDeparture(actions: readonly ResolvedAction[], ctx: TurnContext, facts: TurnFacts, constraints: IntentRequest["constraints"]): Promise<{ actions: ResolvedAction[]; departure?: IntentDeparture }> {
  if (!ctx.sourceNetwork || actions.length === 0) return { actions: [...actions] };
  const request = { accounts: ctx.accounts, sourceNetwork: ctx.sourceNetwork, ...(constraints ? { constraints } : {}) } as IntentRequest;
  const outcome = await resolveDeparture(toActionSpecs(actions), actions.map((action) => action.explicit === true), request, ctx.accounts as IntentRequest["accounts"], departureReader(facts));
  return { actions: fromActionSpecs(outcome.actions, actions), ...(outcome.departure ? { departure: outcome.departure } : {}) };
}

/**
 * Decides one turn without planning: the reducer and policy over this turn's
 * facts, the departure rules on a ready thread, and the canonical sentence.
 * Throws PlatformError for refusals (the given thread is never changed).
 */
export async function decideTurn(thread: ClarifyThread | null, input: TurnInput, ctx: TurnContext, constraints?: IntentRequest["constraints"]): Promise<TurnDecision> {
  if (thread && (thread.status === "cancelled" || thread.rev >= THREAD_LIMITS.maxTurns)) {
    throw new PlatformError("THREAD_CLOSED", thread.status === "cancelled" ? "This task was cancelled. Start a new thread." : "This thread reached 50 turns. Start a new thread.", 409, [
      { path: "thread", message: "Closed." },
    ]);
  }
  // Secrets first: a message or an answer that carries one is refused before anything is read or kept.
  if ("text" in input) assertNoSecret(input.text, "text");
  if ("answer" in input) assertNoSecret(input.answer.text, "answer.text");
  const facts = new TurnFacts(ctx.accounts as IntentRequest["accounts"]);
  const id = thread?.id ?? newThreadId();
  // Round 9: perps trades, native orders and automations are handed to their surface, never planned as intents.
  const handed = await handoffTurn(thread, input, ctx, facts, id, { decideTurn, inexactReading, stateFromThread });
  if (handed && "fresh" in handed) return decideTurn(null, input, ctx, constraints);
  if (handed) return handed;
  const previous = thread ? stateFromThread(thread) : null;
  let outcome: ReduceOutcome;
  try {
    outcome = await reduceWithFacts(previous, input, ctx, facts, id);
  } catch (error) {
    // Seam S2: clauses no deterministic rule could read go to the model-assisted reading hook (when the HTTP layer set
    // one: switch, eligibility and consent), outside the reducer; its readings are proposals the policy confirms.
    const readings = await modelReadings(error, input, ctx);
    if (readings) outcome = await reduceWithFacts(previous, input, ctx, facts, id, readings);
    else {
      // T3: a free-text answer that fits no option may be mapped to one option of the open question, shown as
      // "Did you mean", never applied.
      const mapped = thread && previous ? await mappedAnswer(error, thread, previous, input, ctx, facts, id) : null;
      if (mapped) return mapped;
      throw error;
    }
  }
  const next = threadFromState(outcome.state);
  if (outcome.status === "cancelled") {
    return { status: "cancelled", turn: "control", thread: next, questions: [], assumptions: [], optionSentences: new Map(), state: outcome.state };
  }
  const { analysis } = outcome;
  if (analysis.pending) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Kletia could not read your holdings for this request right now. Try again, or name the asset, amount and network.", 422, [{ path: "text", message: "Holdings unavailable." }]);
  }
  // A.4.14 over the text: a typed member of a look-alike family Kletia does not list is asked, or refused.
  if ("text" in input) {
    const typed = unlistedLookalikes(normalizeMessage(input.text), LOOKALIKE_FAMILIES, isKnownSymbol);
    const asked = analysis.questions[0]?.reason === "ASSET_LOOKALIKE" || analysis.questions[0]?.reason === "ASSET_TYPO";
    if (typed[0] && !asked) throw lookalikeRefusal(typed[0]);
  }
  let assumptions = [...analysis.assumptions];
  if (outcome.status === "needs_input") {
    // Each option that makes the thread ready carries the sentence it leads to (no new reads for a preview).
    const optionSentences = new Map<string, string>();
    facts.frozen = true;
    for (const q of analysis.questions) {
      for (const option of q.options) {
        facts.misses = 0;
        try {
          const trial = reduceTurn(outcome.state, { answer: { question: q.id, option: option.id } }, ctx, facts, () => id);
          const sentence = trial.status === "ready" && trial.analysis.resolved ? render(trial.analysis.resolved) : null;
          if (sentence && facts.misses === 0 && sentence.length <= 1_000) optionSentences.set(`${q.id}|${option.id}`, sentence);
        } catch {
          // An option that would be refused simply carries no sentence.
        }
      }
    }
    facts.frozen = false;
    return {
      status: "needs_input", turn: outcome.turn, thread: next, questions: analysis.questions, assumptions: chipsFirst(assumptions), optionSentences, state: outcome.state,
      // The open question confirms a model-assisted reading: only the person may answer it (CONFIRM_AUTHORITY_REQUIRED).
      ...(analysis.modelReading ? { modelReading: true as const } : {}),
    };
  }
  const resolved = analysis.resolved ?? [];
  const departed = await applyDeparture(resolved, ctx, facts, constraints);
  // The ready-time invariants again over the legs the departure added (continuity, address family, no round trip).
  if (departed.departure?.bridged) {
    const violations = readyViolations({
      actions: departed.actions,
      meta: departed.actions.map(() => ({ step: null })),
      steps: [],
      saidRecipients: departed.actions.flatMap((action) => (action.recipient ? [action.recipient] : [])),
      thirdParty: () => false,
      confirmed: true,
    });
    if (violations.length > 0) throw invariantRefusal(violations);
  }
  // A departure leg the policy did not show (a payment to the recipient's network, a staking leg) gets its chip.
  if (departed.departure?.bridged && !assumptions.some((entry) => entry.field === "actions[0].network")) {
    const leg = departed.actions[0];
    if (leg?.toNetwork) {
      assumptions.unshift(assumption("actions[0].network", `Starts on ${networkName(departed.departure.network)}: bridges to ${networkName(leg.toNetwork)} first`, { network: leg.toNetwork },
        departed.departure.chosen === "auto" ? "balance" : "context", departed.departure.reason ?? `Your departure is ${networkName(departed.departure.network)}.`, [], true));
    }
  }
  return {
    status: "ready",
    turn: outcome.turn,
    thread: next,
    questions: [],
    assumptions: chipsFirst(assumptions).slice(0, CLARIFY_LIMITS.chipsPerPlan),
    actions: departed.actions,
    sentence: render(departed.actions),
    ...(departed.departure ? { departure: departed.departure } : {}),
    ...(analysis.gasOnArrival ? { gasOnArrival: analysis.gasOnArrival } : {}),
    // A model reading the person just confirmed (its goal leaves "llm" on the confirm) still marks the plan.
    ...(analysis.modelReading || confirmedModelReading(previous) ? { modelReading: true as const } : {}),
    optionSentences: new Map(),
    state: outcome.state,
  };
}

/** The previous state held a model-assisted reading still waiting for the person's confirm. */
function confirmedModelReading(previous: WorkState | null): boolean {
  return (previous?.steps ?? []).some((step) => isGoalStep(step) && step.goal.confidence === "llm");
}

/** A non-serialised list of the clauses the reader could not read (seam S1), when the refusal carries one. */
function unreadClausesOf(error: unknown): readonly UnreadClause[] | null {
  if (!(error instanceof PlatformError) || error.code !== "INTENT_UNSUPPORTED") return null;
  const unread = (error as PlatformError & { unreadClauses?: unknown }).unreadClauses;
  return Array.isArray(unread) && unread.length > 0 ? (unread as UnreadClause[]) : null;
}

/** Seam S2: the hook's readings for the unread clauses of a new message, or null (the deterministic refusal stands). */
async function modelReadings(error: unknown, input: TurnInput, ctx: TurnContext): Promise<ReadonlyMap<number, readonly Goal[]> | null> {
  if (!ctx.reader || !("text" in input)) return null;
  const unread = unreadClausesOf(error);
  if (!unread) return null;
  try {
    const readings = await ctx.reader.readClauses(unread, null);
    return readings.size > 0 ? readings : null;
  } catch {
    return null;
  }
}

/**
 * T3: an answer text that fits none of the open question's options, mapped
 * by the hook to one option id of that question (closed set). The thread is
 * not changed: the question comes back with "Did you mean" and the mapped
 * option first, for the person to pick.
 */
async function mappedAnswer(error: unknown, thread: ClarifyThread, previous: WorkState, input: TurnInput, ctx: TurnContext, facts: TurnFacts, id: string): Promise<TurnDecision | null> {
  if (!ctx.reader?.mapAnswer || !(error instanceof PlatformError) || error.code !== "ANSWER_INVALID" || !("answer" in input) || !input.answer.text) return null;
  const open = await reduceWithFacts(previous, { none: true }, ctx, facts, id);
  const q = open.analysis.questions.find((entry) => entry.id === input.answer.question);
  if (!q) return null;
  let mapped: string | null = null;
  try {
    mapped = await ctx.reader.mapAnswer(q, input.answer.text);
  } catch {
    mapped = null;
  }
  const option = q.options.find((entry) => entry.id === mapped);
  if (!option || option.value.target === "cancel") return null;
  const question: Question = { ...q, prompt: clip(`Did you mean: ${option.label}?`, CLARIFY_LIMITS.prompt), options: [option, ...q.options.filter((entry) => entry !== option)] };
  return { status: "needs_input", turn: "answer", thread, questions: [question], assumptions: chipsFirst(open.analysis.assumptions), optionSentences: new Map(), state: previous };
}

/** Corrections and material chips first (§4.6), otherwise in policy order. */
function chipsFirst(list: readonly Assumption[]): Assumption[] {
  const rank = (entry: Assumption) => (entry.source === "correction" ? 0 : entry.material ? 1 : 2);
  return [...list].map((entry, order) => ({ entry, order })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.order - b.order).map(({ entry }) => entry);
}

/* ------------------------------------------------------------ public views */

function publicOption(option: Option, reason: Question["reason"], sentence: string | undefined): ClarifyOption {
  return {
    id: option.id,
    label: clip(option.label, CLARIFY_LIMITS.optionLabel),
    ...(option.detail ? { detail: clip(option.detail, CLARIFY_LIMITS.optionDetail) } : {}),
    // Gap and recipient questions never suggest (UNSUGGESTED_REASONS), whatever the policy produced.
    ...(option.recommended && !UNSUGGESTED_REASONS.has(reason) ? { recommended: true as const } : {}),
    ...(option.value.network ? { network: option.value.network } : {}),
    ...(sentence ? { sentence } : {}),
  };
}

export function publicQuestion(q: Question, sentences: ReadonlyMap<string, string> = new Map()): ClarifyQuestion {
  return {
    id: q.id,
    field: q.field,
    kind: q.kind,
    reason: q.reason,
    purpose: PURPOSE_REASONS.has(q.reason),
    prompt: q.prompt,
    why: q.why,
    options: q.options.map((option) => publicOption(option, q.reason, sentences.get(`${q.id}|${option.id}`))),
    allowsText: q.allowsText,
    ...(q.placeholder ? { placeholder: q.placeholder } : {}),
  };
}

export function publicAssumption(a: Assumption): ClarifyAssumption {
  return {
    id: a.id,
    field: a.field,
    label: a.label,
    reason: a.reason,
    source: a.source,
    material: a.material,
    alternatives: a.alternatives.map((option) => publicOption(option, "VENUE_MISSING", undefined)).map(({ recommended: _recommended, ...rest }) => rest),
  };
}

function amountWord(step: WorkStep): string | undefined {
  const amount = step.amount?.v;
  if (!amount) return undefined;
  if (amount.t === "exact") return amount.value;
  if (amount.t === "usd") return `$${amount.value}`;
  if (amount.bps === 10_000) return amount.t === "previous" ? "it" : "all";
  if (amount.bps === 5_000) return "half";
  return `${amount.bps / 100}%`;
}

const TITLE: Readonly<Record<string, string>> = {
  swap: "Swap", bridge: "Bridge", transfer: "Send", stake: "Stake", deposit: "Deposit", withdraw: "Withdraw", call: "Run", action: "Run",
};

function draftOf(state: WorkState, missing: readonly string[], sentence: string | null): ClarifyDraft {
  const steps: ClarifyDraftStep[] = state.steps.map((step, index) => ({
    index,
    ...(step.kind ? { kind: step.kind.v } : step.goal?.op ? { kind: step.goal.op } : {}),
    ...(isGoalStep(step) && step.goal.spend.asset && "symbol" in step.goal.spend.asset ? { from: step.goal.spend.asset.symbol } : {}),
    ...(isGoalStep(step) && step.goal.want.asset && "symbol" in step.goal.want.asset ? { to: step.goal.want.asset.symbol } : {}),
    ...(isGoalStep(step) && (step.goal.want.at?.network ?? step.goal.spend.from?.network) ? { network: (step.goal.want.at?.network ?? step.goal.spend.from?.network) as NetworkKey } : {}),
    ...(step.network ? { network: step.network.v } : {}),
    ...(step.toNetwork ? { toNetwork: step.toNetwork.v } : {}),
    ...(step.from ? { from: step.from.v } : {}),
    ...(step.to ? { to: step.to.v } : {}),
    ...(amountWord(step) ? { amount: amountWord(step) as string } : {}),
    ...(step.recipient ? { recipient: step.recipient.v } : {}),
    ...(step.protocol ? { protocol: step.protocol.v } : step.provider ? { protocol: step.provider.v } : step.contract ? { protocol: step.contract.v.split("#")[0] as string } : {}),
  }));
  const summary = steps.map((step) => {
    const words = [TITLE[step.kind ?? ""] ?? "Do", step.amount && step.amount !== "it" ? step.amount : "", step.from ?? "",
      step.to ? `to ${step.to}` : "", step.recipient ? `to ${step.recipient.length > 20 ? `${step.recipient.slice(0, 6)}…${step.recipient.slice(-4)}` : step.recipient}` : "",
      step.toNetwork ? `to ${networkName(step.toNetwork)}` : "", step.network ? `on ${networkName(step.network as NetworkKey)}` : ""];
    return words.filter(Boolean).join(" ");
  }).join(", then ");
  return { summary: clip(summary || "New task", 200), sentence, missing: [...missing], steps };
}

/* ------------------------------------------------------------ the turn */

/** Phrases of the registrations the key may use (as the planner reads them). */
async function contractPhrases(ownerKeyId: string | undefined): Promise<readonly ContractPhrase[]> {
  const directory = contractDirectory();
  if (!ownerKeyId || !directory || !contractsEnabled()) return [];
  return directory.phrases(ownerKeyId);
}

export interface ClarifyTurnOptions {
  readonly ownerKeyId?: string;
  readonly dryRun?: boolean;
  readonly preview?: boolean;
  /** Accepted for the journey surface; the journey is fetched by its own route. */
  readonly journey?: boolean;
  /** The thread this turn continues: the client-held blob, or the Kletia-held thread the HTTP layer loaded. */
  readonly thread: ClarifyThread | null;
  /** Seam S2: the model-assisted reading hook, set by the HTTP layer only when the switch, eligibility and consent allow it. */
  readonly reader?: TurnContext["reader"];
  /** Who answers this turn (the HTTP layer knows): the first-party desk, a wallet-bound token, or a plain API caller. */
  readonly confirmAuthority?: TurnContext["confirmAuthority"];
  /** The caller could opt in to model-assisted reading: an unread-clause refusal says `details.modelReading: "available"`. */
  readonly modelReadingAvailable?: boolean;
  /** Families of an agreed model reading (interpretation.modelReading.families). */
  readonly modelFamilies?: number;
  /** The caller's perps rights (the key's rule book chain) for perps hand-offs; absent: the project defaults. */
  readonly perps?: TurnContext["perps"];
  /** The caller's prediction-market rights (round 10); absent: the project defaults. */
  readonly predictions?: TurnContext["predictions"];
}

function turnInput(request: IntentTurnRequest): TurnInput {
  if (request.text !== undefined) return { text: request.text };
  if (request.answer) return { answer: request.answer };
  if (request.assumption) return { assumption: request.assumption };
  return { none: true };
}

/**
 * One clarify turn (`POST /v1/intents?clarify=true`). Returns needs_input,
 * planned (a dry run or a stored intent) or cancelled with the next thread
 * (the full blob; the HTTP layer turns it into a ThreadRef for Kletia-held
 * threads). Refusals throw PlatformError; the thread is then unchanged.
 */
export async function clarifyTurn(request: IntentTurnRequest, options: ClarifyTurnOptions): Promise<IntentTurnResponse> {
  // Secrets first: nothing is validated, read, planned or stored for a message that carries one.
  assertNoSecret((request as { text?: unknown }).text, "text");
  assertNoSecret((request as { answer?: { text?: unknown } }).answer?.text, "answer.text");
  const validated = validateIntentTurnRequest(request);
  if (!validated.ok) {
    const onlyThread = validated.issues.every((issue) => issue.path === "thread" || issue.path.startsWith("thread."));
    if (onlyThread) throw new PlatformError("THREAD_INVALID", "The thread is not valid. Send it exactly as the last response returned it, or start a new one.", 400, validated.issues);
    throw new PlatformError("INVALID_REQUEST", "The clarify turn is invalid.", 400, validated.issues);
  }
  const turn = validated.value;
  const supplied = options.thread ?? turn.thread ?? null;
  if (options.thread) {
    const checked = validateThread(options.thread);
    if (!checked.ok) throw new PlatformError("THREAD_INVALID", "The thread is not valid. Start a new one.", 400, checked.issues);
  }
  const accounts = turn.accounts ?? [];
  if (accounts.length === 0) throw new PlatformError("INVALID_REQUEST", "A clarify turn needs the accounts it plans for.", 400, [{ path: "accounts", message: "Required." }]);
  const input = turnInput(turn);
  if ("none" in input && !supplied) throw new PlatformError("INVALID_REQUEST", "A first turn needs text.", 400, [{ path: "text", message: "Required." }]);
  const ctx: TurnContext = {
    accounts,
    ...(turn.defaultNetwork ? { defaultNetwork: turn.defaultNetwork } : {}),
    ...(turn.sourceNetwork ? { sourceNetwork: turn.sourceNetwork } : {}),
    contracts: await contractPhrases(options.ownerKeyId),
    ...(options.reader ? { reader: options.reader } : {}),
    ...(options.confirmAuthority ? { confirmAuthority: options.confirmAuthority } : {}),
    ...(turn.textOrigin ? { textOrigin: turn.textOrigin } : {}),
    ...(options.perps ? { perps: options.perps } : {}),
    ...(options.predictions ? { predictions: options.predictions } : {}),
  };
  let decision: TurnDecision;
  try {
    decision = await decideTurn(supplied, input, ctx, turn.constraints);
  } catch (error) {
    // A refusal of clauses no rule could read tells an eligible caller that model-assisted reading is available.
    if (options.modelReadingAvailable && !options.reader && unreadClausesOf(error) && error instanceof PlatformError) {
      throw new PlatformError(error.code, error.message, error.status, error.issues, error.hints, { ...(error.details ?? {}), modelReading: "available" });
    }
    throw error;
  }
  if (decision.status === "cancelled") return { status: "cancelled", turn: "control", thread: decision.thread };
  if (decision.status === "handoff" && decision.handoff) {
    return { status: "handoff", turn: decision.turn, handoff: decision.handoff, assumptions: decision.assumptions.map(publicAssumption), thread: decision.thread };
  }
  if (decision.status === "needs_input") {
    return {
      status: "needs_input",
      turn: decision.turn,
      questions: decision.questions.map((q) => publicQuestion(q, decision.optionSentences)),
      assumptions: decision.assumptions.slice(0, CLARIFY_LIMITS.chipsPerPlan).map(publicAssumption),
      draft: draftOf(decision.state, decision.thread.open, null),
      thread: decision.thread,
    };
  }
  const actions = decision.actions ?? [];
  const sentence = decision.sentence ?? null;
  const reference = turn.clientReference ? `${turn.clientReference}:r${decision.thread.rev}` : `thread:${decision.thread.id}:r${decision.thread.rev}`;
  // A gas top-up the person chose (GAS_ON_ARRIVAL) rides on the leg that arrives there; the caller's own values win.
  const constraints = decision.gasOnArrival
    ? { ...(turn.constraints ?? {}), gasOnArrival: { ...decision.gasOnArrival, ...(turn.constraints?.gasOnArrival ?? {}) } }
    : turn.constraints;
  const planRequest: IntentRequest = {
    accounts,
    ...(turn.defaultNetwork ? { defaultNetwork: turn.defaultNetwork } : {}),
    ...(constraints ? { constraints } : {}),
    ...(turn.metadata ? { metadata: turn.metadata } : {}),
    clientReference: reference,
    // A step with no sentence shape (a bridge paying a third party) is planned as structured actions; the
    // closest sentence is kept as the request text so the stored intent still reads in Kletia's words.
    ...(sentence ? { text: sentence } : { text: closestSentence(actions).slice(0, 1_000), actions: toActionSpecs(actions) }),
  } as IntentRequest;
  const created = await createIntentDetailed(planRequest, {
    ...(options.ownerKeyId ? { ownerKeyId: options.ownerKeyId } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.preview ? { preview: true } : {}),
    interpretation: {
      ...(decision.assumptions.length > 0
        ? { assumptions: decision.assumptions.map((entry) => ({ field: entry.field, label: entry.label, source: entry.source, material: entry.material })) }
        : {}),
      thread: { id: decision.thread.id, rev: decision.thread.rev },
      ...(decision.departure ? { departure: decision.departure } : {}),
      // No vendor or model names, no cache flag (design D.1): only that a masked clause was read and confirmed.
      ...(decision.modelReading ? { modelReading: { used: true, sent: "masked_clause", families: options.modelFamilies ?? 2, agreed: true, confirmed: true } as const } : {}),
    },
  });
  return {
    status: "planned",
    turn: decision.turn,
    intent: created.intent,
    ...(created.preview ? { preview: created.preview } : {}),
    assumptions: decision.assumptions.map(publicAssumption),
    sentence: sentence ?? closestSentence(actions),
    thread: decision.thread,
    ...(created.replayed ? { replayed: true } : {}),
  };
}
