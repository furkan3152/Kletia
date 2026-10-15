/**
 * The Goal reader (intent engine v2 §3): a clause the strict slot reader
 * could not read is normalised, split (F7), lexed and read by frames into
 * Goals. Each piece is first offered to the strict reader again (after
 * normalisation, "hey could you move 25 USDC from base over to solana" is a
 * strict sentence); otherwise its Goal is lowered to slots when it maps
 * one-to-one onto verb steps (lower.ts).
 *
 * A Goal that only the solver can place (package P4) becomes a goal step
 * (`WorkStep.goal`) when goal steps are on, and is refused until then: the
 * reader never plans a guess. Goal steps are off by default; package P5
 * turns them on with the solver (`configureGoalSteps`).
 */
import { GOAL_LIMITS, type Goal, type ThreadCorrection } from "@kletia/core";
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

let goalStepsEnabled = false;

/** Whether unsolved goals become goal steps (true once the solver handles them, package P5). Tests pass `true`, then `null` to restore. */
export function configureGoalSteps(enabled: boolean | null): void {
  goalStepsEnabled = enabled ?? false;
}

export function goalStepsOn(): boolean {
  return goalStepsEnabled;
}

export interface ReadClauseOptions {
  /** A step comes before this clause (earlier clause or thread). */
  readonly previousExists: boolean;
  /** The action index of this clause's first step (for correction fields). */
  readonly index: number;
  /** The strict slot reader for one normalised piece (slots.ts parseClause). */
  readonly strict: (text: string, previousExists: boolean) => WorkStep | null;
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
    const read: ReadGoal | null = readFrame(tokens, { previousExists, index: goals.length });
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
