/**
 * The desk's question slot, in the Card machine's conversation: Kletia asks as a normal turn, the
 * choices are option keys (four, then "Other…"; every network for network questions), free text
 * when the question takes it, and "Not now" (or Esc) leaves it for later. The chosen key turns lime
 * and the others dim, with "Sending…", until the task's next turn answers; the choice is echoed as
 * the user's reply by the task (its answer turn). The task card remounts the slot for every answer
 * Kletia gives, so a refusal frees the key.
 *
 * Keyboard: arrows move between keys (a roving tab stop), 1-9 choose, Tab reaches the text field,
 * Esc is "Not now". Focus moves to the first key when the question appears, unless the person is
 * typing in a field outside it.
 *
 * Clarify questions only: journey prompts render once, inside the journey panel (plan conflict 9).
 * Registered as the desk's Question slot (`registerSlots.ts`).
 */
import "./conversation.css";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CHAINS, isNetworkKey } from "@kletia/core";
import { clarifyQuestionView, cleanText, type QuestionCard } from "@kletia/widget/review";

import { Key, LinkButton, OptionKey } from "../../kit";
import { DESK_COPY } from "../content/copy";
import { KletiaTurn, Say } from "./Conversation";
import { OTHER_OPTION_ID, questionCard } from "./questionModel";
import type { QuestionSlotProps } from "./slots";

interface OptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly network: string | null;
  readonly suggested: boolean;
}

interface QuestionView {
  readonly id: string;
  readonly prompt: string;
  readonly why: string;
  readonly options: readonly OptionView[];
  readonly allowsText: boolean;
  readonly placeholder: string;
}

/** The card's questions as the widget reads them (the same cleaning and limits as ClarifyCard). */
function questionsOf(card: QuestionCard): QuestionView[] {
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
  const active = document.activeElement as HTMLElement | null;
  if (!active || (root && root.contains(active))) return false;
  return TYPING.has(active.tagName) || active.isContentEditable;
}

type Answer = { readonly optionId: string; readonly questionId: string } | { readonly text: string; readonly questionId: string };

function QuestionBlock({
  question,
  position,
  count,
  busy,
  pending,
  onAnswer,
  registerFirst,
}: {
  readonly question: QuestionView;
  readonly position: number;
  readonly count: number;
  readonly busy: boolean;
  readonly pending: string | null;
  readonly onAnswer: (answer: Answer) => void;
  readonly registerFirst: (element: HTMLButtonElement | null) => void;
}) {
  const promptId = useId();
  const textId = useId();
  const [focusIndex, setFocusIndex] = useState(0);
  const [text, setText] = useState("");
  const keys = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (option: OptionView) => {
    if (busy) return;
    onAnswer({ optionId: option.id, questionId: question.id });
  };
  const move = (index: number) => {
    const total = question.options.length;
    if (total === 0) return;
    const next = (index + total) % total;
    setFocusIndex(next);
    keys.current[next]?.focus();
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
    <div className="kd-q">
      <Say>
        {count > 1 ? <span className="kd-q-count">{position + 1} of {count}</span> : null}
        <span id={promptId}>{question.prompt}</span>
      </Say>
      {question.why ? <p className="kd-say-why">{question.why}</p> : null}
      {question.options.length > 0 ? (
        <div className="k-opts" role="group" aria-labelledby={promptId} onKeyDown={onKeyDown}>
          {question.options.map((option, index) => {
            const pressed = pending === option.id;
            const network = option.network && isNetworkKey(option.network) ? CHAINS[option.network] : null;
            return (
              <span
                key={option.id}
                className="contents"
                ref={(element) => {
                  const button = element?.querySelector("button") ?? null;
                  keys.current[index] = button;
                  if (index === 0) registerFirst(button);
                  if (button) button.tabIndex = index === focusIndex ? 0 : -1;
                }}
                onFocus={() => setFocusIndex(index)}
              >
                <OptionKey
                  className={network ? "kd-opt-net" : undefined}
                  title={
                    <>
                      {index < 9 ? (
                        <span className="kd-opt-n" aria-hidden="true">
                          {index + 1}
                        </span>
                      ) : null}
                      {network ? <span className="kd-net-dot" style={{ background: network.color, marginRight: 8 }} aria-hidden="true" /> : null}
                      {option.label}
                      {option.suggested ? <span className="kd-opt-tag">· suggested</span> : null}
                    </>
                  }
                  detail={pressed ? "Sending…" : option.detail ?? undefined}
                  selected={pressed}
                  dim={pending !== null && !pressed}
                  disabled={busy && !pressed}
                  onSelect={() => choose(option)}
                />
              </span>
            );
          })}
        </div>
      ) : null}
      {question.allowsText ? (
        <form
          className="kd-q-text"
          onSubmit={(event) => {
            event.preventDefault();
            submitText();
          }}
        >
          <label className="sr-only" htmlFor={textId}>
            {question.options.length > 0 ? `Or type your answer: ${question.prompt}` : question.prompt}
          </label>
          <input
            id={textId}
            value={text}
            maxLength={1000}
            autoComplete="off"
            placeholder={question.placeholder || "Type your answer"}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <Key type="submit" size="sm" disabled={busy || !text.trim()}>
            {pending === "text" ? "Sending…" : "Use"}
          </Key>
        </form>
      ) : null}
    </div>
  );
}

export function QuestionSlot({ question, onAnswer, onDismiss, onAskAgain }: QuestionSlotProps) {
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [pendingFor, setPendingFor] = useState<{ readonly question: string; readonly answer: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const firstKey = useRef<HTMLButtonElement | null>(null);
  const expanded = expandedFor === question.id;
  const pending = pendingFor?.question === question.id ? pendingFor.answer : null;
  const card = questionCard(question, expanded);
  const questions = questionsOf(card);
  const expired = question.expired === true;
  const busy = expired || pending !== null;
  const both = questions.length > 1;

  useEffect(() => {
    if (expired || typingElsewhere(root.current)) return;
    (firstKey.current ?? root.current)?.focus({ preventScroll: true });
    // Focus moves once per question (and when "Other…" shows every choice), never on re-renders.
  }, [expired, question.id, expanded]);

  const answer = (value: Answer) => {
    if ("optionId" in value && value.optionId === OTHER_OPTION_ID) {
      setExpandedFor(question.id);
      return;
    }
    setPendingFor({ question: question.id, answer: "optionId" in value ? value.optionId : "text" });
    if ("optionId" in value) {
      const options = [...card.options, ...(card.questions ?? []).flatMap((entry) => entry.options)];
      const label = options.find((option) => option.id === value.optionId)?.label;
      onAnswer({ optionId: value.optionId, ...(value.questionId ? { questionId: value.questionId } : {}), ...(label ? { label } : {}) });
    } else {
      onAnswer({ text: value.text, ...(value.questionId ? { questionId: value.questionId } : {}) });
    }
  };

  return (
    <KletiaTurn fresh asks={!expired} label={both ? "Two quick details" : "One question"}>
      <div
        ref={root}
        className="kd-qs"
        role="group"
        tabIndex={-1}
        aria-busy={pending !== null || undefined}
        data-kind="clarify"
        data-question-id={question.id}
        data-expired={expired ? "" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onDismiss();
          }
        }}
      >
        {questions.map((entry, position) => (
          <QuestionBlock
            key={entry.id || position}
            question={entry}
            position={position}
            count={questions.length}
            busy={busy}
            pending={pending}
            onAnswer={answer}
            registerFirst={(element) => {
              if (position === 0) firstKey.current = element;
            }}
          />
        ))}
        {expired ? (
          <p className="kd-alert" data-tone="warn" role="status">
            <span>{DESK_COPY.tasks.questionExpired}</span>
            {onAskAgain ? (
              <Key size="sm" tone="lime" onClick={onAskAgain}>
                {DESK_COPY.tasks.askAgain}
              </Key>
            ) : null}
          </p>
        ) : (
          <p className="kd-q-foot">
            <span aria-hidden="true">{both ? "Kletia plans once both are answered." : "1-9 choose · Esc not now"}</span>
            <LinkButton disabled={busy} onClick={onDismiss}>
              Not now
            </LinkButton>
          </p>
        )}
      </div>
    </KletiaTurn>
  );
}
