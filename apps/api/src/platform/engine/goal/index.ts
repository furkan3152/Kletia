/**
 * The Goal reader: a clause the strict slot reader could not read is
 * normalised, split (F7), lexed and read by frames into Goals. Each piece
 * is first offered to the strict reader again (after normalisation, "hey
 * could you move 25 USDC from base over to solana" is a strict sentence);
 * otherwise its Goal is lowered to slots when it maps one-to-one onto verb
 * steps (lower.ts).
 *
 * A Goal that only the solver can place becomes a goal step (`WorkStep.goal`),
 * which the policy solves each turn (clarify/goals.ts). Goal steps are on by
 * default; `configureGoalSteps(false)` turns them off (the clause is then
 * refused: the reader never plans a guess).
 */
import { GOAL_LIMITS, normalizeMessage, SENTENCE_VERBS, type Goal, type ThreadCorrection } from "@kletia/core";
import { splitClauses } from "../grammar.js";
import { spellNumbers } from "./amounts.js";
import type { Slot, WorkStep } from "../clarify/types.js";
import { splitGoalClauses } from "./clauses.js";
import { readFrame, type ReadGoal } from "./frames.js";
import { lex, normalizeClause, type Token } from "./lexer.js";
import { lowerGoal } from "./lower.js";

export { renderAmount, readNumber, spellNumbers, toThreadAmount } from "./amounts.js";
export { lex, normalizeClause, symbolTypoCandidates, type Token } from "./lexer.js";
export { readFrame, type GoalNotes, type ReadGoal } from "./frames.js";
export { lowerGoal } from "./lower.js";
export { splitGoalClauses } from "./clauses.js";

/** "rent: send 500 USDC ...": one to three words, then a colon and a space (never "solana:...", "eip155:..."). */
const LABEL = /^(?<label>[a-z][a-z'-]{0,23}(?:\s+[a-z][a-z'-]{0,23}){0,2})\s*:\s+(?<rest>\S.*)$/iu;

/**
 * A leading label ("rent:", "diversify:") is a note, never part of the
 * sentence: it is dropped when none of its words names an asset, network,
 * venue, amount, recipient or connector. A label that is a verb ("rebalance:
 * half my USDC ...") is kept when the rest has no verb of its own (the Goal
 * reader reads the colon as a pause).
 */
export function stripLabel(text: string): { text: string; label?: string } {
  const match = LABEL.exec(text);
  if (!match?.groups) return { text };
  const label = match.groups.label as string;
  const rest = (match.groups.rest as string).trim();
  const words = lex(normalizeClause(label));
  if (words.length === 0 || words.some((token) => token.t !== "NOISE" && token.t !== "ASSET?" && token.t !== "VERB")) return { text };
  const restVerb = lex(normalizeClause(rest))[0]?.t === "VERB" || Object.hasOwn(SENTENCE_VERBS, (rest.split(/\s+/u)[0] ?? "").toLowerCase());
  if (words.some((token) => token.t === "VERB") && !restVerb) return { text };
  return { text: rest, label };
}

let goalStepsEnabled = true;

/** Whether unsolved goals become goal steps (on by default; tests pass `false`, then `null` to restore the default). */
export function configureGoalSteps(enabled: boolean | null): void {
  goalStepsEnabled = enabled ?? true;
}

export interface ReadClauseOptions {
  /** A step comes before this clause (earlier clause or thread). */
  readonly previousExists: boolean;
  /** The action index of this clause's first step (for correction fields). */
  readonly index: number;
  /** The strict slot reader for one normalised piece (slots.ts parseClause). */
  readonly strict: (text: string, previousExists: boolean) => WorkStep | null;
  /** The step before this clause (earlier clause or thread), when known. */
  readonly previousStep?: WorkStep;
  /** True for a step whose output goes to someone else: a piece after it is never chained to that output implicitly. */
  readonly paysOther?: (step: WorkStep) => boolean;
}

export interface ClauseReading {
  readonly steps: WorkStep[];
  readonly corrections: ThreadCorrection[];
  /** The Goals the frames read (lowered or not), in step order; strict pieces have none. */
  readonly goals: readonly Goal[];
}

const VERB_START = (tokens: readonly Token[]) => tokens[0]?.t === "VERB";

/** The first word of a piece when it is a verb the strict reader knows (for F7 inheritance). */
function leadingVerb(text: string, tokens: readonly Token[]): string | undefined {
  const first = tokens[0];
  if (first?.t !== "VERB") return undefined;
  return text.slice(first.span[0], first.span[1]);
}

/** F7: an ellipsis piece without an asset reuses the previous step's; a network said only on the last piece applies to the group. */
function shareEllipsis(group: WorkStep[]): void {
  if (group.length < 2) return;
  for (let index = 1; index < group.length; index += 1) {
    const step = group[index] as WorkStep;
    const before = group[index - 1] as WorkStep;
    if (!step.from && !step.usdFrom && before.from && step.amount?.v.t === "exact") step.from = { ...before.from } as Slot<string>;
  }
  const last = group[group.length - 1] as WorkStep;
  if (last.network?.by === "user") {
    for (const step of group.slice(0, -1)) {
      if (!step.network && step.kind?.v === last.kind?.v) step.network = { v: last.network.v, by: "user" };
    }
  }
}

/**
 * One clause read by the Goal reader: its steps (strict pieces and lowered
 * goals, plus goal steps when they are on), or null when any piece cannot be
 * read (the caller refuses the clause, as today). A clause of fillers only
 * ("please") reads as no steps; the caller refuses a message with none.
 */
export function readClause(clause: string, options: ReadClauseOptions): ClauseReading | null {
  const pieces = splitGoalClauses(clause, GOAL_LIMITS.maxGoals);
  if (!pieces || pieces.length === 0) return null;
  const steps: WorkStep[] = [];
  const corrections: ThreadCorrection[] = [];
  const goals: Goal[] = [];
  let verbWord: string | undefined;
  let group: WorkStep[] = [];
  for (const piece of pieces) {
    const previousExists = options.previousExists || steps.length > 0;
    let text = normalizeClause(piece.text);
    // A piece of fillers only ("please," before the sentence) says nothing.
    if (!text) continue;
    let tokens = lex(text);
    if (piece.joinedBy === "and" && !VERB_START(tokens) && verbWord && tokens[0]?.t !== "WORK") {
      text = `${verbWord} ${text}`;
      tokens = lex(text);
    } else {
      if (group.length > 0) shareEllipsis(group);
      group = [];
    }
    verbWord = leadingVerb(text, tokens) ?? verbWord;
    const strict = options.strict(text, previousExists);
    if (strict) {
      steps.push(strict);
      group.push(strict);
      continue;
    }
    const before = steps.length > 0 ? steps[steps.length - 1] : options.previousStep;
    const chainable = !(before && options.paysOther?.(before));
    const read: ReadGoal | null = readFrame(tokens, { previousExists, index: goals.length, ...(chainable ? {} : { chainable: false }) });
    if (!read) return null;
    goals.push(read.goal);
    const lowered = lowerGoal(read, { previousExists });
    if (lowered) {
      if (read.notes.rewritten) {
        corrections.push({ field: `actions[${options.index + steps.length}].amount`, from: read.notes.rewritten.from, to: read.notes.rewritten.to, material: true });
      }
      steps.push(...lowered);
      group.push(...lowered);
      continue;
    }
    if (!goalStepsEnabled) return null;
    const step: WorkStep = { goal: read.goal, goalRead: { lowered: false, ...(read.notes.orderOnly ? { orderOnly: true } : {}), ...(read.notes.possessive ? { possessive: true } : {}) } };
    steps.push(step);
    group = [];
  }
  if (group.length > 0) shareEllipsis(group);
  if (steps.length > GOAL_LIMITS.maxGoals) return null;
  return { steps, corrections, goals };
}

/**
 * Every piece of a message read by the frames alone (no strict reader, no
 * lowering): one ReadGoal per piece, or null for a piece the frames cannot
 * read. For tests, the eval and the solver's thread memory.
 */
export function readGoals(message: string, previousExists = false): (ReadGoal | null)[] {
  const out: (ReadGoal | null)[] = [];
  let index = 0;
  for (const clause of splitClauses(stripLabel(normalizeMessage(spellNumbers(message, 2))).text)) {
    let verbWord: string | undefined;
    for (const piece of splitGoalClauses(clause, GOAL_LIMITS.maxGoals) ?? []) {
      let text = normalizeClause(piece.text);
      if (!text) continue;
      let tokens = lex(text);
      if (piece.joinedBy === "and" && !VERB_START(tokens) && verbWord && tokens[0]?.t !== "WORK") {
        text = `${verbWord} ${text}`;
        tokens = lex(text);
      }
      verbWord = leadingVerb(text, tokens) ?? verbWord;
      out.push(readFrame(tokens, { previousExists: previousExists || index > 0, index }));
      index += 1;
    }
  }
  return out;
}
