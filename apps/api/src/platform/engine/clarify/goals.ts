/**
 * Goal steps in the clarify engine: a step the Goal reader could not lower
 * is solved each turn from its Goal, the pins the person set on it and this
 * turn's snapshot, and expanded into ordinary steps for the policy. Nothing
 * the solver chose is stored: the thread keeps the Goal (no user words) and
 * the pins, so assumed choices never go stale.
 *
 * - Answers and chip changes become pins (`applyGoalOption`): a source
 *   network, the asset spent, the earn kind, a venue, a destination or a
 *   recipient are folded into the Goal itself; an amount answer and "all
 *   networks" stay pins (`WorkStep.goalPins`).
 * - In a thread, a goal step is a placeholder step (no kind) whose Goal is
 *   the matching entry of `thread.goals`; the placeholder carries the pins
 *   that are not part of the Goal (`amount`, and `protocol: "scope-all"`).
 * - `GoalReadNotes` are re-derived from the Goal on later turns: word order
 *   only (D12) is `confidence: "frame"` (a confirmed or unambiguous reading
 *   is stored as `exact`), a typo (D9) is a symbol within one edit of listed
 *   ones, the possessive scope (D4) is `spend.amount: max`.
 */
import { findAssetBySymbol, getProtocol, type Custody, type Goal, type NetworkKey, type Place, type ProtocolId, type ThreadAmount } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { symbolTypoCandidates } from "../goal/lexer.js";
import { readNotesOf, solveGoals, type GoalPins, type GoalReadNotes } from "../solver/index.js";
import type { Snapshot } from "../solver/snapshot.js";
import { qid } from "./copy.js";
import { parseIndex } from "./edits.js";
import type { Assumption, EditOp, FactsView, OptionValue, Question, TurnContext, WorkState, WorkStep } from "./types.js";

export type { GoalPins, GoalReadNotes };

/** Where an action index of the expanded thread comes from: a state step, and for a goal step which of its expanded steps. */
export interface StepOrigin {
  readonly step: number;
  readonly part: number;
  readonly goal: boolean;
}

/** The pin value of "all networks" on a placeholder step's protocol slot. */
export const SCOPE_ALL = "scope-all";

export const isGoalStep = (step: WorkStep | undefined): step is WorkStep & { goal: Goal } => step?.goal !== undefined && step.kind === undefined;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

const symbolOf = (asset: Goal["spend"]["asset"]): string | undefined => (asset && "symbol" in asset ? asset.symbol : undefined);

/** The decision-table notes of a goal step: from the reader this turn, else re-derived from the Goal. */
export function notesOf(step: WorkStep & { goal: Goal }): GoalReadNotes {
  const goal = step.goal;
  const out: { orderOnly?: boolean; possessive?: boolean; typo?: GoalReadNotes["typo"] } = {};
  const orderOnly = step.goalRead ? step.goalRead.orderOnly === true && goal.confidence !== "exact" : goal.confidence === "frame";
  if (orderOnly) out.orderOnly = true;
  if (step.goalRead?.possessive || goal.spend.amount?.t === "max") out.possessive = true;
  for (const side of ["spend", "want"] as const) {
    const raw = symbolOf(goal[side].asset);
    if (!raw || out.typo) continue;
    const candidates = symbolTypoCandidates(raw);
    if (candidates.length > 0) out.typo = { side, raw: raw.slice(0, 16), candidates };
  }
  return readNotesOf({ notes: { orderOnly: out.orderOnly === true, possessive: out.possessive === true, ...(out.typo ? { typo: out.typo } : {}) } });
}

export function pinsOf(step: WorkStep): GoalPins | undefined {
  const pins = step.goalPins;
  if (!pins || (!pins.amount && !pins.scope)) return undefined;
  return { ...(pins.amount ? { amount: pins.amount } : {}), ...(pins.scope ? { scope: pins.scope } : {}) };
}

/** The Goal as the thread stores it: the reading's confirm state in `confidence` (see the header). */
export function storedGoal(step: WorkStep & { goal: Goal }): Goal {
  const notes = notesOf(step);
  const confidence = step.goal.confidence === "llm" ? "llm" : notes.orderOnly ? "frame" : "exact";
  // A chain points into the reader's goal list, not the thread's: stored as "spends the previous output" (the expansion re-links it).
  const { chain, ...goal } = step.goal;
  if (chain && !goal.spend.amount) return { ...goal, spend: { ...goal.spend, amount: { t: "previous" } }, confidence };
  return { ...goal, confidence };
}

/** The placeholder thread step of a goal step: no kind, only the pins that are not part of the Goal. */
export function placeholderOf(step: WorkStep): WorkStep {
  const out: WorkStep = {};
  if (step.goalPins?.amount) out.amount = { v: step.goalPins.amount, by: "answer" };
  if (step.goalPins?.scope === "all") out.protocol = { v: SCOPE_ALL, by: "answer" };
  return out;
}

/** True for a thread step that stands for a goal (no kind and no kind candidates). */
export function isPlaceholder(step: { readonly kind?: unknown; readonly kindCandidates?: unknown }): boolean {
  return step.kind === undefined && step.kindCandidates === undefined;
}

/** A goal step back from its placeholder and its stored Goal. */
export function goalStepFrom(placeholder: WorkStep, goal: Goal): WorkStep {
  const pins: NonNullable<WorkStep["goalPins"]> = {};
  if (placeholder.amount) pins.amount = placeholder.amount.v;
  if (placeholder.protocol?.v === SCOPE_ALL) pins.scope = "all";
  return { goal: JSON.parse(JSON.stringify(goal)) as Goal, ...(pins.amount || pins.scope ? { goalPins: pins } : {}) };
}

/* -------------------------------------------------------------- answers */

const isProtocol = (id: string | undefined): id is ProtocolId => typeof id === "string" && getProtocol(id) !== null;

function setWantPlace(goal: Mutable<Goal>, place: { network?: NetworkKey; custody?: Custody }): void {
  const current = goal.want.at;
  const next: Mutable<Place> = { custody: (place.custody ?? current?.custody ?? { kind: "wallet" }) as Mutable<Custody> };
  const network = place.network ?? current?.network;
  if (network) next.network = network;
  goal.want.at = next;
}

function setSource(goal: Mutable<Goal>, network: NetworkKey): void {
  goal.spend.from = { network, custody: (goal.spend.from?.custody ?? { kind: "wallet" }) as Mutable<Custody> };
}

function venueCustody(goal: Goal, protocol: string | undefined, venue: string | undefined, category: "lending" | "staking"): Custody {
  const current = goal.want.at?.custody;
  const keep = current?.kind === "venue" ? current : undefined;
  const id = isProtocol(protocol) ? protocol : keep?.protocol;
  return {
    kind: "venue",
    ...(id ? { protocol: id } : {}),
    ...(category === "lending" && venue ? { vault: venue } : category === "lending" && keep?.vault && keep.protocol === id ? { vault: keep.vault } : {}),
    category,
  };
}

/** An amount answer as the Goal's spend amount kind is not needed: answers stay pins (D2 must not ask again). */
function amountPin(step: WorkStep, amount: ThreadAmount): void {
  step.goalPins = { ...step.goalPins, amount };
}

/**
 * Applies a chosen option (or a text answer read as one) to a goal step: a
 * pin, or a change of its Goal. `name` is the field's slot name, `part` the
 * expanded step the field was on. Returns "cancel" for "Neither, cancel".
 */
export function applyGoalOption(step: WorkStep & { goal: Goal }, name: string, part: number, value: OptionValue): "cancel" | void {
  const goal = JSON.parse(JSON.stringify(step.goal)) as Mutable<Goal>;
  if (value.target === "cancel") return "cancel";
  if (value.target === "confirm") {
    goal.confidence = "exact";
    if (step.goalRead) delete step.goalRead.orderOnly;
  }
  if (value.target === "all") step.goalPins = { ...step.goalPins, scope: "all" };
  if (value.kind === "stake" || (value.provider && !value.kind)) {
    setWantPlace(goal, { custody: venueCustody(step.goal, value.provider, undefined, "staking") });
  } else if (value.kind === "deposit" || value.venue || (value.protocol && !value.kind)) {
    setWantPlace(goal, { custody: venueCustody(step.goal, value.protocol, value.venue, "lending") });
  }
  if (value.asset) {
    if (name === "to") goal.want.asset = { symbol: value.asset };
    else goal.spend.asset = { symbol: value.asset };
  }
  if (value.source) setSource(goal, value.source);
  if (value.network) {
    // The network of a position or of the money spent; otherwise where the money should land.
    if (name === "network" && (goal.kind === "exit" || goal.spend.from?.custody.kind === "position")) setSource(goal, value.network);
    else setWantPlace(goal, { network: value.network });
  }
  if (value.recipient) goal.holder = /\.(?:eth|sns|sol)$/iu.test(value.recipient) ? { t: "name", value: value.recipient } : { t: "address", value: value.recipient };
  if (value.amount) {
    if (part === 0) amountPin(step, value.amount);
    else throw new PlatformError("ANSWER_INVALID", "That answer does not fit this step.", 422, [{ path: "answer", message: "Does not fit the question." }]);
  }
  step.goal = goal as Goal;
}

/* ------------------------------------------------------------ expansion */

export interface Expansion {
  /** The thread's steps with goal steps replaced by their expansions, up to the first goal that asks. */
  readonly steps: WorkStep[];
  readonly layout: StepOrigin[];
  /** The asking goal's questions (fields on expanded action indices), or none. */
  readonly questions: Question[];
  readonly assumptions: Assumption[];
  /** Goal steps are waiting for this turn's snapshot. */
  readonly pending: boolean;
  /** A goal step that cannot be solved until the steps before it are decided (refused if they ask nothing). */
  readonly blocked?: PlatformError;
}

/** What a decided step leaves in the wallet: its output asset and network (null when it leaves nothing to spend). */
function landingOf(step: WorkStep | undefined): { network: NetworkKey; symbol: string } | null {
  const kind = step?.kind?.v;
  if (!step || !kind) return null;
  const network = kind === "bridge" ? step.toNetwork?.v : step.network?.v;
  const symbol = kind === "swap" || kind === "bridge" ? step.to?.v ?? (kind === "bridge" ? step.from?.v : undefined) : kind === "withdraw" ? step.from?.v : undefined;
  if (!network || !symbol || step.usdTo) return null;
  return { network, symbol };
}

/** The snapshot with the holding of `symbol` on `network` unknown (money a previous step will deliver). */
function withUnknownHolding(snapshot: Snapshot, network: NetworkKey, symbol: string): Snapshot {
  const listed = findAssetBySymbol(network, symbol);
  if (!listed) return snapshot;
  const holdings = snapshot.holdings.filter((holding) => !(holding.network === network && holding.symbol.toUpperCase() === listed.symbol.toUpperCase()));
  holdings.push({ network, asset: listed.id, symbol: listed.symbol, decimals: listed.decimals, status: "unknown", usd: null, source: "facts", reason: "not-read" });
  return { ...snapshot, holdings };
}

/** Moves a question to another action index (an asking goal step stays one step in the expanded thread). */
function moveQuestion(q: Question, index: number): Question {
  const { name } = parseIndex(q.field);
  const field = `actions[${index}].${name}`;
  return { ...q, field, id: qid(field) };
}

/**
 * Expands the goal steps of a thread (in order, one solve per run of
 * consecutive goal steps). Strict steps stay the same objects, so the
 * policy's changes to their assumed slots stick.
 */
export function expandGoalSteps(state: WorkState, ctx: TurnContext, facts: FactsView): Expansion {
  const steps: WorkStep[] = [];
  const layout: StepOrigin[] = [];
  const assumptions: Assumption[] = [];
  for (let index = 0; index < state.steps.length;) {
    const step = state.steps[index] as WorkStep;
    if (!isGoalStep(step)) {
      steps.push(step);
      layout.push({ step: index, part: 0, goal: false });
      index += 1;
      continue;
    }
    const run: (WorkStep & { goal: Goal })[] = [];
    while (index + run.length < state.steps.length && isGoalStep(state.steps[index + run.length])) run.push(state.steps[index + run.length] as WorkStep & { goal: Goal });
    if (!facts.goalSnapshot) throw new PlatformError("INTENT_UNSUPPORTED", "Kletia cannot plan this sentence here.", 422, [{ path: "text", message: "Not supported." }]);
    const goals = run.map((entry) => entry.goal);
    const read = facts.goalSnapshot(goals);
    if (!read) return { steps, layout, questions: [], assumptions, pending: true };
    // A goal that spends the previous output: within the run it chains to the goal before it; the first one of the
    // run spends what the step before it lands (a strict step), as a holding that is not read yet (unknown, never zero).
    let snapshot = read;
    const solving = goals.map((goal, position) => {
      const chained = goal.chain !== undefined || goal.spend.amount?.t === "previous";
      if (!chained) return goal;
      const { chain: _chain, ...rest } = goal;
      if (position > 0) return { ...rest, chain: { after: position - 1 } };
      const landing = landingOf(steps[steps.length - 1]);
      if (!landing) return null;
      snapshot = withUnknownHolding(snapshot, landing.network, landing.symbol);
      return { ...rest, spend: { ...rest.spend, asset: { symbol: landing.symbol }, amount: { t: "previous" as const }, from: { network: landing.network, custody: { kind: "wallet" as const } } } };
    });
    if (solving.some((goal) => goal === null)) {
      // The step before has gaps (its asset or network): its questions come first; if it has none, the clause is refused.
      return {
        steps, layout, questions: [], assumptions, pending: false,
        blocked: new PlatformError("INTENT_UNSUPPORTED", "Kletia cannot tell what the previous step leaves to use; name the asset and the network.", 422, [{ path: "text", message: "Ambiguous reference." }]),
      };
    }
    const result = solveGoals(solving as Goal[], snapshot, {
      accounts: ctx.accounts,
      index: steps.length,
      reads: run.map((entry) => notesOf(entry)),
      pins: run.map((entry) => pinsOf(entry)),
    });
    assumptions.push(...result.assumptions);
    for (const outcome of result.outcomes) {
      const stateIndex = index + outcome.goal;
      if (outcome.status === "ready") {
        outcome.steps.forEach((expanded, part) => {
          steps.push(expanded as WorkStep);
          layout.push({ step: stateIndex, part, goal: true });
        });
        continue;
      }
      if (outcome.status === "ask") {
        // The asking goal is one action in the expanded thread (its questions may sit on a later hop: kept as the part).
        const at = steps.length;
        const questions = outcome.questions.map((q) => {
          const part = Math.max(0, parseIndex(q.field).index - at);
          return { q: moveQuestion(q, at), part };
        });
        layout.push({ step: stateIndex, part: questions[0]?.part ?? 0, goal: true });
        return { steps, layout, questions: questions.map((entry) => entry.q), assumptions, pending: false };
      }
      // Pending goals (after the one that asks) never come here: the solver stops at the first question.
      return { steps, layout, questions: [], assumptions, pending: false };
    }
    index += run.length;
  }
  return { steps, layout, questions: [], assumptions, pending: false };
}

/* ---------------------------------------------------------------- edits */

/**
 * A follow-up edit ("make it 50", "from arbitrum instead") on a task that is
 * one goal step: it changes the Goal or its pins. False when the edit does
 * not fit (the caller refuses it).
 */
export function applyGoalEdit(state: WorkState, edit: EditOp): boolean {
  if (state.steps.length !== 1) return false;
  const step = state.steps[0];
  if (!isGoalStep(step)) return false;
  const goal = JSON.parse(JSON.stringify(step.goal)) as Mutable<Goal>;
  switch (edit.op) {
    case "amount":
      // "get me 0.01 ETH", then "make it 0.02": a goal with a target changes its target; otherwise the amount spent.
      if (goal.want.amount && !goal.spend.amount && edit.amount.t === "exact") goal.want.amount = { t: "exact", value: edit.amount.value };
      else step.goalPins = { ...step.goalPins, amount: edit.amount };
      break;
    case "network":
      if (edit.dir === "from" || (edit.dir === "use" && (goal.spend.from !== undefined || goal.kind === "exit"))) setSource(goal, edit.network);
      else setWantPlace(goal, { network: edit.network });
      break;
    case "asset":
      goal.spend.asset = { symbol: edit.symbol };
      break;
    case "lending":
      setWantPlace(goal, { custody: venueCustody(step.goal, edit.protocol, undefined, "lending") });
      break;
    case "provider":
      setWantPlace(goal, { custody: venueCustody(step.goal, edit.provider, undefined, "staking") });
      break;
    case "bridgeVenue":
    case "dex":
      if (!isProtocol(edit.protocol)) return false;
      goal.constraints = { ...goal.constraints, via: [edit.protocol] } as Mutable<Goal["constraints"]>;
      break;
    case "recipient":
      goal.holder = /\.(?:eth|sns|sol)$/iu.test(edit.recipient) ? { t: "name", value: edit.recipient } : { t: "address", value: edit.recipient };
      break;
  }
  step.goal = goal as Goal;
  return true;
}
