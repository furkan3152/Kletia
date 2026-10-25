/**
 * One task in the thread, as a conversation (Card machine):
 * the person's sentence as a keycap bubble ("You · 09:41"), what was said since (answers and
 * edits as the person's replies, Kletia's earlier words, system notes), the open question as a
 * Kletia turn, and the body for its engine (thinking, the printed card, signing, the outcome).
 * The task's own memory folds under it ("This task, 4 turns") with Edit and Undo.
 *
 * Order: turns up to Kletia's last reply, then that reply live (the question, or the body's card),
 * then anything said after it (the answer just sent, a note). A finished task that is not the
 * newest folds to one line; it is only hidden, never unmounted, because unmounting an execution
 * cancels its run and refuses any open gate.
 *
 * An answer is recorded as the task's next turn; the task's body sends it with the task's own
 * thread (never another task's) and replaces the question with whatever Kletia answers.
 */
import "./conversation.css";

import { useId, useState, type ReactNode } from "react";

import { Icon, Key } from "../../kit";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { shortSerial } from "../shell/machine/machineModel";
import { isFinishedStatus } from "../state/deskSession";
import { getDeskStore, isEditable, useDeskStore, type TaskRecord, type TaskTurn } from "../state/deskStore";
import { useDeskSlots } from "../hooks/useDeskSlots";
import { EngineTaskBody } from "./EngineTaskBody";
import { PlatformTaskBody } from "./PlatformTaskBody";
import { RatesTaskBody } from "./RatesTaskBody";
import { AssistantTaskBody } from "../assistant/AssistantTaskBody";
import { KletiaTurn, Say, SystemNote, UserTurn } from "./Conversation";
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
    <details className="kd-memory">
      <summary>
        This task, {turns} turn{turns === 1 ? "" : "s"}
      </summary>
      <ol>
        {lines.map((line, index) => (
          <li key={index}>
            <span>{line.who === "you" ? "You" : "Kletia"}</span>
            <span className="min-w-0 break-words">{line.text}</span>
          </li>
        ))}
      </ol>
      {editable ? (
        <div className="kd-keys">
          <Key
            size="sm"
            aria-pressed={editing}
            onClick={() => {
              getDeskStore().getState().edit(editing ? null : task.id);
              if (!editing) actions.fill("");
            }}
          >
            <Icon name="sig" />
            {editing ? "Stop editing" : "Edit this task"}
          </Key>
          {canUndo ? (
            <Key size="sm" onClick={() => getDeskStore().getState().patchTask(task.id, { turn: { kind: "edit", at: Date.now(), text: "undo" } })}>
              <Icon name="replay" />
              Undo
            </Key>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/** A turn said before Kletia's live reply (or after it): the person's replies, Kletia's earlier words, notes. */
function TranscriptTurn({ turn }: { readonly turn: TaskTurn }) {
  switch (turn.kind) {
    case "answer":
    case "assumption":
      return <UserTurn text={turn.label} meta={`You · ${clockOf(turn.at)}`} at={turn.at} />;
    case "edit":
      return <UserTurn text={turn.text} meta={`You · ${clockOf(turn.at)}`} at={turn.at} />;
    case "kletia":
      return (
        <KletiaTurn>
          <Say muted>{turn.label}</Say>
        </KletiaTurn>
      );
    case "note":
      return <SystemNote icon="flip">{turn.text}</SystemNote>;
    default:
      return null;
  }
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
  const question = task.question && isDeskQuestion(task.question) ? task.question : null;
  // Kletia's answers remount the slot, so a refused answer frees its pressed key.
  const kletiaTurns = task.turns.filter((turn) => turn.kind === "kletia" || turn.kind === "note").length;
  // "Not now" folds the question away; it stays on the task until it is answered.
  const [setAside, setSetAside] = useState<string | null>(null);

  // Turns up to Kletia's last reply, that reply live (question or body), then what came after it.
  let last = -1;
  task.turns.forEach((turn, index) => {
    if (turn.kind === "kletia") last = index;
  });
  const history = task.turns.slice(1, last === -1 ? undefined : last);
  const trailing = last === -1 ? [] : task.turns.slice(last + 1);
  const sentence = task.sentence || (task.restored ? "" : task.title);
  const yard = task.lane === "testnet";

  let live: ReactNode = null;
  if (question && setAside === question.id) {
    live = (
      <Key size="sm" className="self-start" onClick={() => setSetAside(null)}>
        {question.questions && question.questions.length > 1 ? "Kletia has 2 questions: show them" : "Kletia has 1 question: show it"}
      </Key>
    );
  } else if (question) {
    live = (
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
        onAskAgain={() => getDeskStore().getState().patchTask(task.id, { question: null, turn: { kind: "ask-again", at: Date.now() } })}
        onDismiss={() => {
          // "Not now": the question stays on the task (its "1 question" stamp); the composer stops answering it.
          const store = getDeskStore().getState();
          if (store.answering === task.id) store.answer(null);
          setSetAside(question.id);
          document.getElementById(`task-${task.id}`)?.querySelector<HTMLElement>("h2[tabindex]")?.focus();
        }}
      />
    );
  }

  const body =
    task.engine.kind === "network" ? (
      <EngineTaskBody task={task} />
    ) : task.engine.kind === "rates" ? (
      <RatesTaskBody task={task} />
    ) : task.engine.kind === "assistant" ? (
      <AssistantTaskBody task={task} />
    ) : (
      <PlatformTaskBody task={task} />
    );

  return (
    <article id={`task-${task.id}`} className="kd-task" aria-labelledby={headingId} data-task-status={task.status}>
      <h2 id={headingId} tabIndex={-1} className="sr-only">
        {DESK_COPY.ticket.articleLabel(serial, task.title)}
      </h2>
      {finished && !newest ? (
        <button type="button" aria-expanded={!collapsed} onClick={() => setExpanded((current) => !current)} className="kd-stub">
          <span className="kd-stub-serial" aria-hidden="true">
            #{shortSerial(task.id)}
          </span>
          <span className="kd-stub-t">{task.title || task.sentence}</span>
          <span className="kd-stub-s">
            {taskStatusLabel(task)} · {clockOf(task.createdAt)}
          </span>
          <span className="sr-only">{collapsed ? copy.open : copy.collapse}</span>
          <Icon name="chev" />
        </button>
      ) : null}
      {/* Hidden, never unmounted: `hidden` alone would lose to the flex display class. */}
      <div hidden={collapsed} className={collapsed ? "hidden" : "kd-task-body"}>
        {sentence ? (
          <UserTurn
            text={sentence}
            at={task.createdAt}
            meta={
              <>
                You · {clockOf(task.createdAt)}
                {yard ? <span className="kd-yard">{DESK_COPY.ticket.testYardRibbon}</span> : null}
              </>
            }
          />
        ) : null}
        {history.map((turn, index) => (
          <TranscriptTurn key={`h${index}`} turn={turn} />
        ))}
        {live}
        {question ? trailing.map((turn, index) => <TranscriptTurn key={`t${index}`} turn={turn} />) : null}
        {body}
        {question ? null : trailing.map((turn, index) => <TranscriptTurn key={`t${index}`} turn={turn} />)}
        {task.engine.kind === "platform" ? <TaskMemory task={task} /> : null}
      </div>
    </article>
  );
}
