/**
 * The desk's question rules, pure so node --test loads them:
 *
 * - a clarify `needs_input` response becomes one DeskQuestion per task (up to
 *   two independent questions in one card, R12); journey prompts never do
 *   (they render inside the journey panel through `journeyPromptView`);
 * - options show as chips, four at most and then "Other…", except network
 *   questions, which show every network the server offers for the lane, so
 *   Solana is never hidden behind "Other…" for an EVM departure;
 * - the composer's Editing chip appears only for a planned task and a
 *   message `classifyMessage` reads as an edit, an append or a control (or
 *   when the task's Edit button armed it); a complete sentence is a new task;
 * - every turn carries the task's own thread, never another task's.
 */
import {
  classifyMessage,
  type ClarifyQuestion,
  type ClarifyThread,
  type IntentTurnRequest,
  type IntentTurnResponse,
} from "@kletia/core";
import { clarifyView, type QuestionCard, type QuestionCardOption } from "@kletia/widget/review";

import type { DeskQuestion, QuestionAnswer } from "./slots.ts";

/** Chips shown before "Other…" (network questions show them all). */
export const QUESTION_CHIPS = 4;
/** The "Other…" chip: expands the card, never sent to the API. */
export const OTHER_OPTION_ID = "desk:other";

/** True when every choice of a question is a network (a network question). */
export function isNetworkQuestion(question: Pick<ClarifyQuestion, "options">): boolean {
  return question.options.length > 0 && question.options.every((option) => typeof option.network === "string");
}

/**
 * The desk's one open question for a `needs_input` response; null for any
 * other status or a response that asks nothing it can show.
 */
export function deskQuestionFrom(response: IntentTurnResponse): DeskQuestion | null {
  if (response.status !== "needs_input") return null;
  const card = clarifyView(response).card;
  if (!card) return null;
  const question: DeskQuestion = {
    id: card.id,
    kind: "clarify",
    prompt: card.prompt,
    options: card.options,
    allowsText: card.allowsText,
    ...(card.questions ? { questions: card.questions } : {}),
  };
  return question.prompt && (question.options.length > 0 || question.allowsText || (question.questions?.length ?? 0) > 1) ? question : null;
}

function withOther<T extends { readonly id: string; readonly label: string }>(options: readonly T[], other: T): T[] {
  return [...options.slice(0, QUESTION_CHIPS), other];
}

/**
 * The card `ClarifyCard` renders for a desk question: four chips and then
 * "Other…" until the user expands it, every network for network questions.
 */
export function questionCard(question: DeskQuestion, expanded: boolean): QuestionCard {
  const questions = question.questions && question.questions.length > 0 ? question.questions : null;
  const trim = (count: number, network: boolean) => !expanded && !network && count > QUESTION_CHIPS;
  const shownQuestions = questions?.map((entry) =>
    trim(entry.options.length, isNetworkQuestion(entry))
      ? { ...entry, options: withOther(entry.options, { id: OTHER_OPTION_ID, label: "Other…", detail: `${entry.options.length - QUESTION_CHIPS} more` }) }
      : entry,
  );
  const topNetwork = question.options.length > 0 && question.options.every((option) => typeof option.network === "string");
  const options: QuestionCardOption[] = trim(question.options.length, topNetwork)
    ? withOther(question.options, { id: OTHER_OPTION_ID, label: "Other…", detail: `${question.options.length - QUESTION_CHIPS} more` })
    : [...question.options];
  return {
    id: question.id,
    kind: "clarify",
    prompt: question.prompt,
    options,
    allowsText: question.allowsText,
    ...(shownQuestions ? { questions: shownQuestions } : {}),
    title: (questions?.length ?? 1) > 1 ? "Two quick details" : "One question",
  };
}

/** The question an answer is for: the one it names, else the first open one. */
export function answerTarget(question: Pick<DeskQuestion, "id" | "questions">, questionId?: string): string {
  if (questionId && (questionId === question.id || question.questions?.some((entry) => entry.id === questionId))) return questionId;
  return question.questions?.[0]?.id ?? question.id;
}

/** What the task's turns show for an answer: the chip's label, or the typed text. */
export function answerLabel(question: DeskQuestion | null, answer: QuestionAnswer): string {
  if ("text" in answer) return answer.text.slice(0, 200);
  if (answer.label) return answer.label;
  const options = [...(question?.options ?? []), ...(question?.questions ?? []).flatMap((entry) => entry.options)];
  return options.find((option) => option.id === answer.optionId)?.label ?? answer.optionId;
}

/** The clarify `answer` of a turn; null for "Other…" (it only expands the card). */
export function turnAnswer(question: Pick<DeskQuestion, "id" | "questions">, answer: QuestionAnswer): NonNullable<IntentTurnRequest["answer"]> | null {
  const target = answerTarget(question, answer.questionId);
  if ("text" in answer) {
    const text = answer.text.trim().slice(0, 1000);
    return text ? { question: target, text } : null;
  }
  if (answer.optionId === OTHER_OPTION_ID) return null;
  return { question: target, option: answer.optionId };
}

export type TurnInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "answer"; readonly answer: NonNullable<IntentTurnRequest["answer"]> }
  | { readonly kind: "assumption"; readonly id: string; readonly option: string }
  /** No input: plan the thread again (new accounts) or, without dryRun, commit it. */
  | { readonly kind: "none" };

/** The request context a desk turn carries every time (client-held threads keep none of it). */
export interface TurnContext {
  readonly accounts: IntentTurnRequest["accounts"];
  readonly sourceNetwork?: IntentTurnRequest["sourceNetwork"];
  readonly defaultNetwork?: IntentTurnRequest["defaultNetwork"];
  readonly metadata?: IntentTurnRequest["metadata"];
}

/**
 * One turn of a task: its context, its own thread (none on the first turn,
 * which sends the sentence), and at most one input.
 */
export function turnRequest(context: TurnContext, thread: ClarifyThread | null, input: TurnInput, sentence: string): IntentTurnRequest {
  const base: IntentTurnRequest = {
    ...(context.accounts ? { accounts: context.accounts } : {}),
    ...(context.sourceNetwork ? { sourceNetwork: context.sourceNetwork } : {}),
    ...(context.defaultNetwork ? { defaultNetwork: context.defaultNetwork } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
  };
  if (!thread) return { ...base, text: input.kind === "text" ? input.text : sentence };
  switch (input.kind) {
    case "text":
      return { ...base, thread, text: input.text };
    case "answer":
      return { ...base, thread, answer: input.answer };
    case "assumption":
      return { ...base, thread, assumption: { id: input.id, option: input.option } };
    default:
      return { ...base, thread };
  }
}

/** What a turn's response says in the task's memory ("This task"): Kletia's own words. */
export function responseLabel(response: IntentTurnResponse): string {
  if (response.status === "needs_input") {
    const view = clarifyView(response);
    return view.questions.map((question) => question.prompt).join(" ") || "Kletia has a question.";
  }
  if (response.status === "planned") return response.sentence.slice(0, 200);
  return "Cancelled.";
}

/**
 * Whether the composer's next message edits the focused task: only a
 * planned task that can still change, and only a message that reads as an
 * edit, an append or a control, or any message when the task's Edit
 * button armed the chip. A complete sentence starts a new task.
 */
export function editsTask(
  text: string,
  task: { readonly status: string; readonly engine: { readonly kind: string }; readonly sentence: string } | null,
  armed: boolean,
): boolean {
  if (!task || task.engine.kind !== "platform" || !task.sentence) return false;
  if (task.status !== "preview" && task.status !== "review") return false;
  if (!text.trim()) return armed;
  if (armed) return true;
  const kind = classifyMessage(text, { hasOpenQuestion: false, hasTask: true });
  return kind === "edit" || kind === "append" || kind === "control";
}
