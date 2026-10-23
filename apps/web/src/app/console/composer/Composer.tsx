/**
 * The desk's one text box. Before anything leaves the browser the
 * sentence is checked: empty or too long (inline error), secrets (refused
 * and cleared: nothing is sent or stored), template placeholders (blocked
 * and selected), desk commands (open a view). Enter plans, Shift and
 * Enter add a line, IME composition never submits, and "/" outside a
 * field focuses the box.
 *
 * Context chips above the text: the departure (always), the engine pin set
 * by a tool, "Answering" while a task's open question is being answered,
 * and "Editing" when the focused task is planned and the text reads as a
 * follow-up (`classifyMessage`: an edit, an append or a control such as
 * "make it 2", "undo", "cancel"), or when the task's Edit button armed it.
 * Enter then sends the text to that task as its next turn; a complete
 * sentence is a new task; the chip's × makes it a new task.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { CHAINS, classifyMessage } from "@kletia/core";

import { DESK_COPY } from "../content/copy";
import type { NetworkActions } from "../content/starters";
import { COMPOSER_LIMIT, composerVerdict, laneOf, type Departure, type DeskView, type LegacyNetwork } from "../state/deskModel";
import { getDeskStore, useDeskStore } from "../state/deskStore";
import { composerChoice, editsTask, turnAnswer } from "../tasks/questionModel";
import { isDeskQuestion } from "../tasks/slots";
import { DepartureChip } from "./DepartureChip";
import { StarterMenu } from "./StarterMenu";

const copy = {
  ...DESK_COPY.composer,
  editing: (title: string) => `Editing: ${title}`,
  editingLabel: (title: string) => `Editing: ${title}. Remove to make this a new task`,
  editingHint: "Enter changes this task · × makes it a new task",
  answeringHint: "Enter answers the question · × makes it a new task",
  editSent: (title: string) => `Sent to the task ${title}.`,
  sendEdit: "Change this task",
  sendEditShort: "Change",
};

export interface ComposerHandle {
  /** Puts a sentence in the box (nothing is sent) and focuses it. */
  fill(text: string): void;
  focus(): void;
}

export interface ComposerProps {
  readonly departure: Departure;
  readonly departureCaption: string;
  readonly boardOpen: boolean;
  readonly onOpenBoard: () => void;
  readonly chipRef: React.RefObject<HTMLButtonElement>;
  readonly enginePin: LegacyNetwork | null;
  readonly onClearPin: () => void;
  /** Title of the task whose question the composer answers; null when not answering. */
  readonly answeringTitle: string | null;
  readonly onClearAnswering: () => void;
  readonly actions: NetworkActions;
  /** A sentence passed every check: plan it (or send it as the answer). */
  readonly onSubmit: (text: string) => void;
  readonly onCommand: (view: DeskView) => void;
  /** The board, rendered next to the chip so the popover opens from it. */
  readonly picker: React.ReactNode;
}

function placeholderFor(departure: Departure): string {
  if (departure === "auto") return copy.placeholderAuto;
  const chain = CHAINS[departure];
  if (chain.lane === "testnet") return `send 1 USDC to <address> on ${departure === "arbitrum-sepolia" ? "arbitrum sepolia" : departure === "solana-devnet" ? "solana devnet" : departure}`;
  return departure === "solana" ? "swap 1 SOL to USDC" : `deposit 100 USDC into aave on ${departure}`;
}

const REMOVE_CHIP =
  "inline-flex min-h-11 items-center gap-1.5 border-2 border-control bg-surface-2 px-2.5 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]";

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    departure,
    departureCaption,
    boardOpen,
    onOpenBoard,
    chipRef,
    enginePin,
    onClearPin,
    answeringTitle,
    onClearAnswering,
    actions,
    onSubmit,
    onCommand,
    picker,
  },
  ref,
) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The task whose Editing chip the user removed (until the focus moves to another task). */
  const [declined, setDeclined] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const labelId = useId();
  const hintId = useId();

  // The task a follow-up would edit: the armed one, else the focused one.
  const armedId = useDeskStore((state) => state.editing);
  const editTarget = useDeskStore((state) => state.tasks.find((task) => task.id === (state.editing ?? state.focusedTaskId)) ?? null);
  const editing =
    editTarget !== null &&
    answeringTitle === null &&
    enginePin === null &&
    declined !== editTarget.id &&
    editsTask(text, editTarget, armedId === editTarget.id);

  useImperativeHandle(ref, () => ({
    fill(next: string) {
      setText(next);
      setError(null);
      requestAnimationFrame(() => {
        const box = textareaRef.current;
        if (!box) return;
        box.focus({ preventScroll: true });
        box.setSelectionRange(next.length, next.length);
        box.scrollIntoView({ block: "nearest" });
      });
    },
    focus() {
      textareaRef.current?.focus();
    },
  }));

  // "/" anywhere outside a field focuses the composer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return;
      if (document.querySelector("dialog[open][aria-modal=true]")) return;
      event.preventDefault();
      textareaRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Grow with the text, up to the CSS max height. Empty, it stays one line (a long placeholder is cut, not wrapped).
  useEffect(() => {
    const box = textareaRef.current;
    if (!box) return;
    box.style.height = "auto";
    if (text) box.style.height = `${box.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    const verdict = composerVerdict(text);
    setNotice(null);
    switch (verdict.kind) {
      case "empty":
        setError(copy.errors.empty);
        return;
      case "too-long":
        setError(copy.errors.tooLong(verdict.limit));
        return;
      case "secret":
        // Refused and cleared: nothing was sent, stored or logged.
        setText("");
        setError(copy.errors.secret);
        return;
      case "placeholder": {
        setError(copy.errors.placeholder(verdict.placeholder));
        const box = textareaRef.current;
        box?.focus();
        box?.setSelectionRange(verdict.start, verdict.end);
        return;
      }
      case "command":
        setText("");
        setError(null);
        setNotice(
          verdict.view === "activity" ? copy.commands.activity
            : verdict.view === "tools" ? copy.commands.tools
              : verdict.view === "dashboard" ? copy.commands.dashboard
                : copy.commands.portfolio,
        );
        onCommand(verdict.view);
        return;
      case "sentence":
        setText("");
        setError(null);
        // A complete sentence while answering is a new task, never an answer (classifyMessage).
        if (answeringTitle && classifyMessage(verdict.text, { hasOpenQuestion: true, hasTask: true }) === "sentence") {
          getDeskStore().getState().answer(null);
        }
        if (editing && editTarget) {
          // The follow-up goes to that task as its next turn, with that task's own thread.
          const store = getDeskStore().getState();
          store.patchTask(editTarget.id, { turn: { kind: "edit", at: Date.now(), text: verdict.text } });
          store.edit(null);
          setNotice(copy.editSent(editTarget.title));
          return;
        }
        onSubmit(verdict.text);
        return;
    }
  };

  /** Answers the open question of the task the composer is about (answering, focused, or the only one asking). */
  const chooseByDigit = (digit: number): boolean => {
    const store = getDeskStore().getState();
    const asking = store.tasks.filter((task) => task.question !== null && task.status === "question");
    const target =
      asking.find((task) => task.id === store.answering) ??
      asking.find((task) => task.id === store.focusedTaskId) ??
      (asking.length === 1 ? asking[0] : undefined);
    const question = target?.question;
    if (!target || !question || !isDeskQuestion(question)) return false;
    const choice = composerChoice(question, digit);
    if (!choice) return false;
    const answer = turnAnswer(question, { optionId: choice.optionId });
    if (!answer) return false;
    store.patchTask(target.id, { turn: { kind: "answer", at: Date.now(), label: choice.label, answer } });
    setNotice(copy.choseOption(choice.label));
    return true;
  };

  const pickStarter = (sentence: string) => {
    setText(sentence);
    setError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const yard = laneOf(departure) === "testnet";
  const pinName = enginePin ? CHAINS[enginePin].shortName : null;

  return (
    <div className="kd-composer" id="desk-composer">
      <div className="relative">
        {picker}
        <form
          className="kd-composer__box p-2 sm:p-3"
          data-yard={yard || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <DepartureChip ref={chipRef} departure={departure} caption={departureCaption} expanded={boardOpen} onOpen={onOpenBoard} />
            {/* Phones: "Examples" shares the chip row, so the docked composer stays two rows tall. */}
            <StarterMenu departure={departure} actions={actions} onPick={pickStarter} variant="inline" className="ml-auto md:hidden" />
            {yard ? (
              <span className="kd-yard-ribbon inline-flex min-h-8 items-center px-2 text-[11px] font-black uppercase tracking-wider text-fg">
                {copy.testYardBadge}
              </span>
            ) : null}
            {pinName ? (
              <button type="button" className={REMOVE_CHIP} aria-label={copy.enginePinLabel(pinName)} onClick={onClearPin}>
                {copy.enginePin(pinName)}
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {answeringTitle ? (
              <button type="button" className={`${REMOVE_CHIP} max-w-full`} aria-label={copy.answeringLabel(answeringTitle)} onClick={onClearAnswering}>
                <span className="truncate">{copy.answering(answeringTitle)}</span>
                <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </button>
            ) : null}
            {editing && editTarget ? (
              <button
                type="button"
                className={`${REMOVE_CHIP} max-w-full`}
                aria-label={copy.editingLabel(editTarget.title)}
                onClick={() => {
                  setDeclined(editTarget.id);
                  getDeskStore().getState().edit(null);
                  textareaRef.current?.focus();
                }}
              >
                <span className="truncate">{copy.editing(editTarget.title)}</span>
                <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <label id={labelId} className="sr-only" htmlFor="desk-composer-input">
              {copy.label}
            </label>
            <textarea
              id="desk-composer-input"
              ref={textareaRef}
              rows={1}
              value={text}
              maxLength={COMPOSER_LIMIT * 2}
              placeholder={placeholderFor(departure)}
              aria-labelledby={labelId}
              aria-invalid={error ? true : undefined}
              aria-describedby={[error ? errorId : null, editing || answeringTitle ? hintId : null].filter(Boolean).join(" ") || undefined}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="send"
              onChange={(event) => {
                setText(event.target.value);
                if (error) setError(null);
                if (!event.target.value) setDeclined(null);
              }}
              onKeyDown={(event) => {
                // "1-9 choose" on an open question card works from the empty composer too.
                if (!text && /^[1-9]$/u.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && chooseByDigit(Number(event.key))) {
                  event.preventDefault();
                  return;
                }
                if (event.key !== "Enter" || event.shiftKey) return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                submit();
              }}
              className="px-1 py-2"
            />
            <button
              type="submit"
              aria-label={answeringTitle ? copy.sendAnswer : editing ? copy.sendEdit : copy.sendLabel}
              className="inline-flex h-12 min-w-12 shrink-0 items-center justify-center gap-1.5 border-[3px] border-[#1A1A1A] bg-[#0052FF] px-3 text-xs font-black uppercase tracking-wider text-white shadow-[2px_2px_0_#1A1A1A] hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] active:translate-y-0.5 active:shadow-none dark:border-[#64748B] motion-reduce:hover:translate-y-0"
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{answeringTitle ? copy.sendAnswer : editing ? copy.sendEditShort : copy.send}</span>
            </button>
          </div>
          {editing || answeringTitle ? (
            <p id={hintId} className="mt-2 text-xs font-semibold text-muted">
              {editing ? copy.editingHint : copy.answeringHint}
            </p>
          ) : null}
          {error ? (
            <p id={errorId} role="alert" className="mt-2 border-l-4 border-[var(--kl-danger)] bg-[var(--kl-danger-bg)] px-3 py-2 text-sm font-bold text-[var(--kl-danger)]">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mt-2 text-sm font-bold text-fg">
              {notice}
            </p>
          ) : null}
        </form>
        <StarterMenu departure={departure} actions={actions} onPick={pickStarter} className="hidden md:flex" />
      </div>
    </div>
  );
});
