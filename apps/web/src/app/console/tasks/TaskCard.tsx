/**
 * One task in the thread (console design 3.7 and 3.8): an article labelled
 * by its heading, with the open question (slot), then the body for its
 * engine, and the task's own memory folded under it ("This task, 4 turns",
 * clarify W6) with Edit and Undo. A finished task that is not the newest
 * collapses to a one-line stub; it is only hidden, never unmounted, because
 * unmounting an execution cancels its run and refuses any open gate.
 *
 * An answer is recorded as the task's next turn; the task's body sends it
 * with the task's own thread (never another task's) and replaces the
 * question with whatever Kletia answers.
 */
import { useId, useState } from "react";
import { ChevronDown, PenLine, Undo2 } from "lucide-react";
import { CHAINS } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { isFinishedStatus } from "../state/deskSession";
import { getDeskStore, isEditable, useDeskStore, type TaskRecord, type TaskTurn } from "../state/deskStore";
import { useDeskSlots } from "../hooks/useDeskSlots";
import { EngineTaskBody } from "./EngineTaskBody";
import { PlatformTaskBody } from "./PlatformTaskBody";
import { RatesTaskBody } from "./RatesTaskBody";
import { AssistantTaskBody } from "../assistant/AssistantTaskBody";
import { answerLabel, turnAnswer } from "./questionModel";
import { registerDeskTaskSlots } from "./registerSlots";
import { isDeskQuestion } from "./slots";
import { clockOf, serialOf, taskStatusLabel } from "./taskModel";

const copy = DESK_COPY.tasks;

// The journey and question slots are filled as soon as the desk's task modules load.
registerDeskTaskSlots();

/** One line of the task's memory: who said it and what (the user's own words stay in this tab's memory). */
function turnLine(task: TaskRecord, turn: TaskTurn): { readonly who: "you" | "kletia"; readonly text: string } | null {
  switch (turn.kind) {
    case "sentence":
      return task.sentence ? { who: "you", text: task.sentence } : null;
    case "answer":
      return { who: "you", text: turn.label };
    case "edit":
      return { who: "you", text: turn.text };
    case "assumption":
      return { who: "you", text: turn.label };
    case "kletia":
      return { who: "kletia", text: turn.label };
    case "note":
      return { who: "kletia", text: turn.text };
    default:
      return null;
  }
}

function TaskMemory({ task }: { readonly task: TaskRecord }) {
  const editing = useDeskStore((state) => state.editing === task.id);
  const actions = useDeskActions();
  const lines = task.turns.map((turn) => turnLine(task, turn)).filter((line): line is NonNullable<typeof line> => line !== null);
  const editable = isEditable(task) && task.status !== "question";
  const canUndo = editable && (task.thread?.undo.length ?? 0) > 0;
  if (lines.length < 2 && !editable) return null;
  // A turn is what the user said (the sentence, an answer, an edit): Kletia's replies are not counted.
  const turns = lines.filter((line) => line.who === "you").length;
  return (
    <details className="border-2 border-dashed border-control bg-surface-2">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]">
        This task, {turns} turn{turns === 1 ? "" : "s"}
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {lines.map((line, index) => (
            <li key={index} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm">
              <span className="font-code text-xs font-black uppercase tracking-wider text-muted">{line.who === "you" ? "You" : "Kletia"}</span>
              <span className="min-w-0 break-words">{line.text}</span>
            </li>
          ))}
        </ol>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={editing}
              className="inline-flex min-h-11 items-center gap-1.5 border-2 border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
              onClick={() => {
                getDeskStore().getState().edit(editing ? null : task.id);
                if (!editing) actions.fill("");
              }}
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              {editing ? "Stop editing" : "Edit this task"}
            </button>
            {canUndo ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1.5 border-2 border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
                onClick={() => getDeskStore().getState().patchTask(task.id, { turn: { kind: "edit", at: Date.now(), text: "undo" } })}
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export interface TaskCardProps {
  readonly task: TaskRecord;
  /** The newest task never collapses. */
  readonly newest: boolean;
}

export function TaskCard({ task, newest }: TaskCardProps) {
  const headingId = useId();
  const actions = useDeskActions();
  const { Question } = useDeskSlots();
  const [expanded, setExpanded] = useState(false);
  const serial = serialOf(task.intentId ?? task.id);
  const finished = isFinishedStatus(task.status);
  const collapsed = finished && !newest && !expanded;
  const route = task.ends
    ? copy.route(CHAINS[task.ends.from].shortName, CHAINS[task.ends.to].shortName)
    : "";
  const question = task.question && isDeskQuestion(task.question) ? task.question : null;
  // Kletia's answers remount the slot, so a refused answer frees its pressed chip.
  const kletiaTurns = task.turns.filter((turn) => turn.kind === "kletia" || turn.kind === "note").length;
  // "Not now" folds the card away; the question stays on the task until it is answered.
  const [setAside, setSetAside] = useState<string | null>(null);

  return (
    <article id={`task-${task.id}`} className="kd-task" data-rise="" aria-labelledby={headingId} data-task-status={task.status}>
      <h2 id={headingId} tabIndex={-1} className="sr-only">
        {DESK_COPY.ticket.articleLabel(serial, task.title)}
      </h2>
      {finished && !newest ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-h-11 w-full flex-wrap items-center gap-2 border-2 border-dashed border-control bg-surface-2 px-3 py-2 text-left text-sm font-semibold text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
        >
          {task.ends ? <LineBullet line={LINES[task.ends.from]} decorative /> : null}
          <span className="min-w-0 flex-1 truncate">
            {copy.stub(serial, task.title, route, taskStatusLabel(task), clockOf(task.createdAt))}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-wider">
            {collapsed ? copy.open : copy.collapse}
            <ChevronDown className={`h-4 w-4 transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-180"}`} aria-hidden="true" />
          </span>
        </button>
      ) : null}
      {/* Hidden, never unmounted: `hidden` alone would lose to the flex display class. */}
      <div hidden={collapsed} className={collapsed ? "hidden" : "flex min-w-0 flex-col gap-4"}>
        {question && setAside === question.id ? (
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 self-start border-2 border-control bg-surface px-3 text-sm font-bold text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
            onClick={() => setSetAside(null)}
          >
            {question.questions && question.questions.length > 1 ? "Kletia has 2 questions: show them" : "Kletia has 1 question: show it"}
          </button>
        ) : question ? (
          <Question
            key={`${question.id}:${kletiaTurns}`}
            taskId={task.id}
            question={question}
            holdings={actions.holdings}
            onAnswer={(answer) => {
              const structured = turnAnswer(question, answer);
              if (!structured) return;
              getDeskStore()
                .getState()
                .patchTask(task.id, { turn: { kind: "answer", at: Date.now(), label: answerLabel(question, answer), answer: structured } });
            }}
            onDismiss={() => {
              // "Not now": the question stays on the task (its "1 question" stamp); the composer stops answering it.
              const store = getDeskStore().getState();
              if (store.answering === task.id) store.answer(null);
              setSetAside(question.id);
              document.getElementById(`task-${task.id}`)?.querySelector<HTMLElement>("h2[tabindex]")?.focus();
            }}
          />
        ) : null}
        {task.engine.kind === "network" ? (
          <EngineTaskBody task={task} />
        ) : task.engine.kind === "rates" ? (
          <RatesTaskBody task={task} />
        ) : task.engine.kind === "assistant" ? (
          <AssistantTaskBody task={task} />
        ) : (
          <PlatformTaskBody task={task} />
        )}
        {task.engine.kind === "platform" ? <TaskMemory task={task} /> : null}
      </div>
    </article>
  );
}
