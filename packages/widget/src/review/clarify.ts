/**
 * Clarifying questions, assumption chips and journey prompts as question
 * cards.
 */
import {
  isNetworkKey,
  UNSUGGESTED_REASONS,
  type ClarifyAssumption,
  type ClarifyOption,
  type ClarifyQuestion,
  type ClarifyQuestionKind,
  type ClarifyReason,
  type IntentTurnResponse,
  type JourneyConsequence,
  type NetworkKey,
} from "@kletia/core";
import { cleanText } from "./text.js";

/* =============================================================== clarify */

/** One choice on a question card (the desk's DeskQuestion options). */
export interface QuestionCardOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly network?: NetworkKey;
  readonly recommended?: boolean;
}

/**
 * What `ClarifyCard` renders: the desk's `DeskQuestion` plus optional
 * card copy. `questions` carries up to two independent clarify
 * questions shown in one card; the first mirrors the top-level fields.
 */
export interface QuestionCard {
  readonly id: string;
  readonly kind: "clarify" | "journey" | (string & {});
  readonly prompt: string;
  readonly options: readonly QuestionCardOption[];
  readonly allowsText: boolean;
  readonly questions?: readonly ClarifyQuestion[];
  /** The fact behind a single question ("You hold 2.5 SOL on Solana."). */
  readonly why?: string;
  readonly placeholder?: string;
  /** Card heading: "One question", "Before you sign · one question". */
  readonly title?: string;
  /** A closing line, e.g. "Facts: Base RPC read at 13:51:04 UTC". */
  readonly note?: string;
}

export interface ClarifyOptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly network: NetworkKey | null;
  /** Kletia's suggestion: at most one per question, never on gap or recipient questions. */
  readonly suggested: boolean;
}

export interface ClarifyQuestionView {
  readonly id: string;
  readonly field: string;
  readonly kind: ClarifyQuestionKind;
  readonly reason: ClarifyReason;
  readonly purpose: boolean;
  readonly prompt: string;
  readonly why: string;
  readonly options: readonly ClarifyOptionView[];
  readonly allowsText: boolean;
  readonly placeholder: string;
}

export interface AssumptionView {
  readonly id: string;
  readonly field: string;
  readonly label: string;
  readonly reason: string;
  /** Changes where money goes or how much moves: highlighted, announced, listed first. */
  readonly material: boolean;
  readonly alternatives: readonly ClarifyOptionView[];
}

export interface ClarifyView {
  readonly status: IntentTurnResponse["status"];
  /** "One question", "Two quick details"; empty when nothing is asked. */
  readonly title: string;
  /** What the task is so far ("Swap SOL to USDC on Solana"), or the planned sentence. */
  readonly summary: string;
  readonly questions: readonly ClarifyQuestionView[];
  /** The card for `ClarifyCard`; null when nothing is asked. */
  readonly card: QuestionCard | null;
  /** At most three, material first ("Kletia assumed"). */
  readonly assumptions: readonly AssumptionView[];
  /** The polite announcement for screen readers. */
  readonly announcement: string;
}

/** Questions shown in one card (clarify R12). */
export const CLARIFY_CARD_MAX_QUESTIONS = 2;
/** Assumption chips per plan (corpus invariant). */
export const ASSUMPTION_CHIPS_MAX = 3;

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

function optionViews(options: readonly ClarifyOption[] | undefined, suggestAllowed: boolean): ClarifyOptionView[] {
  let suggested = false;
  return (options ?? []).slice(0, 8).flatMap((option) => {
    const id = typeof option?.id === "string" ? option.id.slice(0, 120) : "";
    const label = cleanText(option?.label, 48);
    if (!id || !label) return [];
    const suggest = suggestAllowed && option.recommended === true && !suggested;
    if (suggest) suggested = true;
    return [{
      id,
      label,
      detail: cleanText(option.detail, 96) || null,
      network: isNetworkKey(option.network) ? option.network : null,
      suggested: suggest,
    }];
  });
}

/** One clarify question as display data; the suggestion is dropped on gap and recipient questions whatever the server says. */
export function clarifyQuestionView(question: ClarifyQuestion): ClarifyQuestionView {
  const reason = question.reason;
  return {
    id: cleanText(question.id, 120),
    field: cleanText(question.field, 120),
    kind: question.kind,
    reason,
    purpose: question.purpose === true,
    prompt: cleanText(question.prompt, 160),
    why: cleanText(question.why, 160),
    options: optionViews(question.options, !UNSUGGESTED_REASONS.has(reason)),
    allowsText: question.allowsText === true,
    placeholder: cleanText(question.placeholder, 60),
  };
}

function assumptionView(assumption: ClarifyAssumption): AssumptionView {
  return {
    id: cleanText(assumption.id, 120),
    field: cleanText(assumption.field, 120),
    label: cleanText(assumption.label, 60),
    reason: cleanText(assumption.reason, 160),
    material: assumption.material === true,
    alternatives: optionViews(assumption.alternatives, false).slice(0, 4),
  };
}

/** Assumption chips in display order: material first, at most three. */
export function assumptionViews(assumptions: readonly ClarifyAssumption[] | null | undefined): AssumptionView[] {
  return [...(assumptions ?? [])]
    .map((assumption, position) => ({ view: assumptionView(assumption), position }))
    .filter(({ view }) => view.id && view.label)
    .sort((a, b) => Number(b.view.material) - Number(a.view.material) || a.position - b.position)
    .slice(0, ASSUMPTION_CHIPS_MAX)
    .map(({ view }) => view);
}

/**
 * A clarify turn response as display data: the card (up to two questions), the
 * assumption chips and the announcement.
 */
export function clarifyView(response: IntentTurnResponse): ClarifyView {
  const assumptions = response.status === "cancelled" ? [] : assumptionViews(response.assumptions);
  if (response.status !== "needs_input") {
    const summary = response.status === "planned" ? cleanText(response.sentence, 200) : "";
    const material = assumptions.filter((assumption) => assumption.material);
    return {
      status: response.status,
      title: "",
      summary,
      questions: [],
      card: null,
      assumptions,
      announcement: material.length > 0 ? `Kletia assumed: ${material.map((assumption) => `${assumption.label}, ${assumption.reason}`.replace(/\.$/u, "")).join("; ")}.` : "",
    };
  }
  const shown = response.questions.slice(0, CLARIFY_CARD_MAX_QUESTIONS);
  const questions = shown.map(clarifyQuestionView);
  const summary = cleanText(response.draft?.summary, 120) || "this task";
  const first = questions[0];
  const card: QuestionCard | null = first
    ? {
        id: first.id,
        kind: "clarify",
        prompt: first.prompt,
        options: first.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.detail ? { detail: option.detail } : {}),
          ...(option.network ? { network: option.network } : {}),
          ...(option.suggested ? { recommended: true } : {}),
        })),
        allowsText: first.allowsText,
        questions: shown,
        ...(first.why ? { why: first.why } : {}),
        ...(first.placeholder ? { placeholder: first.placeholder } : {}),
        title: questions.length > 1 ? "Two quick details" : "One question",
      }
    : null;
  const choices = (count: number) => (count === 0 ? "Type your answer." : `${NUMBER_WORDS[count] ?? count} choice${count === 1 ? "" : "s"}.`);
  const announcement = questions.length === 0
    ? ""
    : questions.length === 1
      ? `Kletia has a question about ${summary}: ${first!.prompt} ${choices(first!.options.length)}`
      : `Kletia has ${NUMBER_WORDS[questions.length]?.toLowerCase() ?? questions.length} questions about ${summary}: ${questions.map((question) => question.prompt).join(" ")}`;
  return { status: "needs_input", title: card?.title ?? "", summary, questions, card, assumptions, announcement };
}

/** What the `onClarify` callback and the embed's `kletia:question` event carry: no values, only what was asked and why. */
export interface ClarifyEvent {
  readonly count: number;
  readonly reasons: readonly ClarifyReason[];
  readonly questions: readonly { readonly reason: ClarifyReason; readonly kind: ClarifyQuestionKind; readonly purpose: boolean }[];
}

export function clarifyEventOf(response: IntentTurnResponse): ClarifyEvent | null {
  if (response.status !== "needs_input") return null;
  const questions = response.questions.slice(0, CLARIFY_CARD_MAX_QUESTIONS).map((question) => ({
    reason: question.reason,
    kind: question.kind,
    purpose: question.purpose === true,
  }));
  return { count: questions.length, reasons: questions.map((question) => question.reason), questions };
}

/** The option a journey prompt always ends with, so the user is never trapped. */
export const JOURNEY_HANDLE_IT_OPTION = "ok";

/**
 * A journey prompt as a question card: the question, the options with
 * their effect as the detail, the default as the suggestion, no free
 * text, and "I will handle it" (or the consequence's own do-it-yourself
 * options) last. Null when the consequence asks nothing.
 */
export function journeyPromptView(consequence: JourneyConsequence): QuestionCard | null {
  if (!consequence.prompt || (consequence.severity !== "block" && consequence.severity !== "act")) return null;
  const defaultId = consequence.prompt.defaultOptionId;
  const ordered = [...consequence.options]
    .map((option, position) => ({ option, position, last: option.id === JOURNEY_HANDLE_IT_OPTION ? 2 : option.action?.type === "acknowledge" ? 1 : 0 }))
    .sort((a, b) => a.last - b.last || a.position - b.position)
    .map(({ option }) => option);
  const options: QuestionCardOption[] = ordered.flatMap((option) => {
    const label = cleanText(option.label, 48);
    if (!label || typeof option.id !== "string") return [];
    const detail = cleanText(option.effect, 200);
    return [{ id: option.id, label, ...(detail ? { detail } : {}), ...(option.id === defaultId ? { recommended: true } : {}) }];
  });
  if (!consequence.options.some((option) => option.action?.type === "acknowledge")) {
    options.push({ id: JOURNEY_HANDLE_IT_OPTION, label: "I will handle it", detail: "Nothing changes; you take care of it yourself." });
  }
  const source = cleanText(consequence.source, 160);
  const why = [cleanText(consequence.title, 160), cleanText(consequence.detail, 300)].filter(Boolean).join(" ");
  return {
    id: consequence.id,
    kind: "journey",
    prompt: cleanText(consequence.prompt.question, 160) || cleanText(consequence.title, 160),
    options,
    allowsText: false,
    ...(why ? { why } : {}),
    title: consequence.severity === "block" ? "Before you sign · one question" : "One suggestion",
    ...(source ? { note: `Facts: ${source}` } : {}),
  };
}
