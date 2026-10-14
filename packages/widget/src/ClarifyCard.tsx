import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CHAINS } from "@kletia/core";
import { clarifyQuestionView, cleanText, type ClarifyOptionView, type QuestionCard } from "./review.js";

/** An answer from the card: a chosen option, or typed text, for one of its questions. */
export type ClarifyCardAnswer =
  | { readonly optionId: string; readonly questionId?: string }
  | { readonly text: string; readonly questionId?: string };

export interface ClarifyCardProps {
  /** A clarify question (from `clarifyView`) or a journey prompt (from `journeyPromptView`). */
  readonly question: QuestionCard;
  readonly onAnswer: (answer: ClarifyCardAnswer) => void;
  /** "Not now" (and Esc): the question stays with the task; nothing is answered. */
  readonly onDismiss: () => void;
  /** Tighter spacing (the widget at narrow widths). */
  readonly compact?: boolean;
  /**
   * The answer in flight: an option id (pressed, with a busy mark) or
   * `"text"`; every control is disabled meanwhile.
   */
  readonly pending?: string | null;
  /** Disables every control (e.g. while the host is busy). */
  readonly disabled?: boolean;
  /**
   * Move focus to the first choice when the card appears, unless the user is
   * typing in a field outside the card (cards never steal focus from typing).
   */
  readonly autoFocus?: boolean;
  /** Label of the dismiss button (default "Not now"). */
  readonly dismissLabel?: string;
  /** False for prompts that must be answered (journey blockers): no dismiss button, Esc does nothing. */
  readonly dismissible?: boolean;
}

interface CardQuestionView {
  readonly id: string;
  readonly prompt: string;
  readonly why: string;
  readonly options: readonly ClarifyOptionView[];
  readonly allowsText: boolean;
  readonly placeholder: string;
}

/** The card's questions: the clarify questions it carries, else the single top-level one. */
function questionsOf(card: QuestionCard): CardQuestionView[] {
  if (card.questions && card.questions.length > 0) return card.questions.slice(0, 2).map(clarifyQuestionView);
  return [
    {
      id: cleanText(card.id, 120),
      prompt: cleanText(card.prompt, 160),
      why: cleanText(card.why, 400),
      options: card.options.flatMap((option) => {
        const label = cleanText(option.label, 48);
        if (!label || typeof option.id !== "string") return [];
        return [{ id: option.id, label, detail: cleanText(option.detail, 200) || null, network: option.network ?? null, suggested: option.recommended === true }];
      }),
      allowsText: card.allowsText,
      placeholder: cleanText(card.placeholder, 60),
    },
  ];
}

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function typingElsewhere(root: HTMLElement | null): boolean {
  const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  if (!active || (root && root.contains(active))) return false;
  return TYPING.has(active.tagName) || active.isContentEditable;
}

function QuestionBlock({
  question,
  position,
  count,
  busy,
  pending,
  onAnswer,
  registerFirst,
}: {
  readonly question: CardQuestionView;
  readonly position: number;
  readonly count: number;
  readonly busy: boolean;
  readonly pending: string | null;
  readonly onAnswer: (answer: ClarifyCardAnswer) => void;
  readonly registerFirst: (element: HTMLButtonElement | null) => void;
}) {
  const promptId = useId();
  const textId = useId();
  const [focusIndex, setFocusIndex] = useState(0);
  const [text, setText] = useState("");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (option: ClarifyOptionView) => {
    if (busy) return;
    onAnswer({ optionId: option.id, questionId: question.id });
  };
  const move = (index: number) => {
    const total = question.options.length;
    if (total === 0) return;
    const next = (index + total) % total;
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(focusIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(focusIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(question.options.length - 1);
    } else if (/^[1-9]$/u.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const option = question.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        choose(option);
      }
    }
  };
  const submitText = () => {
    const value = text.trim();
    if (!value || busy) return;
    onAnswer({ text: value.slice(0, 1000), questionId: question.id });
  };
  return (
    <div className="kw-q">
      <p className="kw-q-prompt" id={promptId}>
        {count > 1 ? <span className="kw-q-count">{position + 1} of {count}</span> : null}
        {question.prompt}
      </p>
      {question.why ? <p className="kw-q-why">{question.why}</p> : null}
      {question.options.length > 0 ? (
        <div className="kw-opts" role="radiogroup" aria-labelledby={promptId} onKeyDown={onKeyDown}>
          {question.options.map((option, index) => {
            const chain = option.network ? CHAINS[option.network] : null;
            const pressed = pending === option.id;
            return (
              <button
                key={option.id}
                ref={(element) => {
                  buttons.current[index] = element;
                  if (index === 0) registerFirst(element);
                }}
                type="button"
                role="radio"
                aria-checked={pressed}
                tabIndex={index === focusIndex ? 0 : -1}
                className="kw-opt"
                data-suggested={option.suggested ? "true" : undefined}
                data-pending={pressed ? "true" : undefined}
                disabled={busy && !pressed}
                aria-disabled={busy || undefined}
                onFocus={() => setFocusIndex(index)}
                onClick={() => choose(option)}
              >
                {index < 9 ? (
                  <span className="kw-opt-key" aria-hidden="true">
                    {index + 1}
                  </span>
                ) : null}
                <span className="kw-opt-body">
                  <span className="kw-opt-label">
                    {chain ? <span className="kw-dot" style={{ background: chain.color }} aria-hidden="true" /> : null}
                    {option.label}
                    {option.suggested ? <span className="kw-opt-tag">Suggested</span> : null}
                    {pressed ? <span className="kw-opt-busy">Sending…</span> : null}
                  </span>
                  {option.detail ? <span className="kw-opt-detail">{option.detail}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {question.allowsText ? (
        <form
          className="kw-q-text"
          onSubmit={(event) => {
            event.preventDefault();
            submitText();
          }}
        >
          <label className="kw-sr" htmlFor={textId}>
            {question.options.length > 0 ? `Or type your answer: ${question.prompt}` : question.prompt}
          </label>
          <input
            id={textId}
            className="kw-input"
            value={text}
            maxLength={1000}
            autoComplete="off"
            placeholder={question.placeholder || "Type your answer"}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="kw-btn kw-btn-sm" disabled={busy || !text.trim()}>
            {pending === "text" ? "Sending…" : "Use"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * One question card for clarifying questions and journey prompts. The card
 * is a group labelled by its heading; each question's choices form a radio
 * group with a roving tab stop: arrow keys move, Enter or Space (or 1-9
 * while focus is inside) picks and submits, Tab reaches the free-text
 * field, Esc is "Not now". The suggested choice is marked by its border
 * and the word "Suggested", never by colour alone.
 */
export function ClarifyCard(props: ClarifyCardProps) {
  const { question, onAnswer, onDismiss, compact, pending = null, disabled = false, autoFocus = false, dismissLabel = "Not now", dismissible = true } = props;
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstOption = useRef<HTMLButtonElement | null>(null);
  const questions = questionsOf(question);
  const busy = disabled || pending !== null;
  const title = cleanText(question.title, 80) || (questions.length > 1 ? "Two quick details" : "One question");
  const note = cleanText(question.note, 200);
  const allAnswer = questions.length > 1;

  useEffect(() => {
    if (!autoFocus || typingElsewhere(rootRef.current)) return;
    (firstOption.current ?? rootRef.current)?.focus();
    // Focus moves once per question, never on re-renders.
  }, [autoFocus, question.id]);

  return (
    <div
      ref={rootRef}
      className="kw-card"
      role="group"
      aria-labelledby={headingId}
      tabIndex={-1}
      data-kind={question.kind}
      data-compact={compact ? "true" : undefined}
      aria-busy={pending !== null || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy && dismissible) {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <p className="kw-card-title" id={headingId}>
        {title}
      </p>
      {questions.map((entry, position) => (
        <QuestionBlock
          key={entry.id || position}
          question={entry}
          position={position}
          count={questions.length}
          busy={busy}
          pending={pending}
          onAnswer={onAnswer}
          registerFirst={(element) => {
            if (position === 0) firstOption.current = element;
          }}
        />
      ))}
      {note ? <p className="kw-q-why">{note}</p> : null}
      <div className="kw-card-foot">
        <span className="kw-muted" aria-hidden="true">
          {allAnswer ? "Kletia plans once both are answered." : dismissible ? "1-9 choose · Esc not now" : "1-9 choose"}
        </span>
        {dismissible ? (
          <button type="button" className="kw-btn kw-btn-sm" disabled={busy} onClick={onDismiss}>
            {dismissLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default ClarifyCard;
