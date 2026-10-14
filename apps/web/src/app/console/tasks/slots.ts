/**
 * Slots the journey ledger and the clarify engine fill inside each desk task
 * (console design 3.11, clarify design 8.1, journey design 9.2). The desk
 * owns placement, data and lifecycle; the other packages own what renders,
 * and register one component per slot. The defaults render nothing, so the
 * desk ships on its own.
 *
 * Placement: Journey `review` between the ticket and the review, `live`
 * between the ticket and the gate and progress, `after` with the outcome.
 * Question: above the task's body, at most one open question per task.
 *
 * The same components serve the widget's `kw-journey` and `kw-clarify`
 * slots, which pass `holdings: null` and no `onFollowUp`, so a slot component
 * must never need either. Journey prompts render inside the journey slot
 * (never as a DeskQuestion); DeskQuestion carries clarify questions only.
 *
 * Pure (type-only imports): node --test loads it.
 */
import type { ClarifyQuestion, IntentGraph, IntentPreview, NetworkKey } from "@kletia/core";
import type { ComponentType } from "react";

import type { DeskQuestion as StoredQuestion } from "../state/deskStore.ts";
import type { HoldingsSnapshot } from "../state/holdings.ts";

export type JourneyPhase = "review" | "live" | "after";

export interface JourneySlotProps {
  readonly taskId: string;
  readonly phase: JourneyPhase;
  /** The live graph (local step phases applied). */
  readonly intent: IntentGraph;
  /** The fare in force; null when the API returned none. */
  readonly preview: IntentPreview | null;
  /** The same snapshot the Holdings panel shows (null in the widget). */
  readonly holdings: HoldingsSnapshot | null;
  readonly lane: "production" | "testnet";
  /**
   * Fills the composer with a follow-up ("deposit it into aave on base") and
   * sets its departure. The desk always passes it; the widget does not.
   */
  readonly onFollowUp?: (text: string, departure?: NetworkKey) => void;
}

/**
 * One open clarify question on a task (clarify questions only: journey
 * prompts render in the journey slot). The first entry of `questions`
 * mirrors the top-level fields.
 */
export interface DeskQuestion extends Omit<StoredQuestion, "kind"> {
  readonly kind: "clarify";
  /** Up to two independent questions shown in one card. */
  readonly questions?: readonly ClarifyQuestion[];
}

export type QuestionAnswer = { readonly optionId: string } | { readonly text: string };

export interface QuestionSlotProps {
  readonly taskId: string;
  readonly question: DeskQuestion;
  readonly holdings: HoldingsSnapshot | null;
  /** Answering never discards the task's sentence; the desk re-plans with what the clarify engine returns. */
  readonly onAnswer: (answer: QuestionAnswer) => void;
  /** Dismissing leaves the task as it was. */
  readonly onDismiss: () => void;
}

export interface DeskSlots {
  readonly Journey: ComponentType<JourneySlotProps>;
  readonly Question: ComponentType<QuestionSlotProps>;
}

/** Renders nothing: the desk ships before the journey ledger and clarify engine do. */
function EmptyJourney(): null {
  return null;
}

function EmptyQuestion(): null {
  return null;
}

export const DEFAULT_DESK_SLOTS: DeskSlots = Object.freeze({ Journey: EmptyJourney, Question: EmptyQuestion });

let slots: DeskSlots = DEFAULT_DESK_SLOTS;
const listeners = new Set<() => void>();

/**
 * Registers slot components (a later registration of the same slot wins).
 * Returns a function that restores the previous components.
 */
export function registerDeskSlots(partial: Partial<DeskSlots>): () => void {
  const previous = slots;
  slots = Object.freeze({ ...slots, ...partial });
  for (const listener of listeners) listener();
  return () => {
    slots = previous;
    for (const listener of listeners) listener();
  };
}

export function getDeskSlots(): DeskSlots {
  return slots;
}

/** For `useSyncExternalStore`: re-render when a package registers its slot after the desk mounted. */
export function subscribeDeskSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True for a question the desk may show: a clarify question with a prompt and at least one way to answer. */
export function isDeskQuestion(value: unknown): value is DeskQuestion {
  if (typeof value !== "object" || value === null) return false;
  const question = value as Partial<DeskQuestion>;
  return (
    question.kind === "clarify" &&
    typeof question.id === "string" &&
    typeof question.prompt === "string" &&
    question.prompt.length > 0 &&
    Array.isArray(question.options) &&
    (question.options.length > 0 || question.allowsText === true)
  );
}
