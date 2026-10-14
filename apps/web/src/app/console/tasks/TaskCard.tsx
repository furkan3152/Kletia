/**
 * One task in the thread (console design 3.7): an article labelled by its
 * heading, with the open question (slot), then the body for its engine. A
 * finished task that is not the newest collapses to a one-line stub; it is
 * only hidden, never unmounted, because unmounting an execution cancels its
 * run and refuses any open gate.
 */
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { CHAINS } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { isFinishedStatus } from "../state/deskSession";
import { getDeskStore, type TaskRecord } from "../state/deskStore";
import { useDeskSlots } from "../hooks/useDeskSlots";
import { EngineTaskBody } from "./EngineTaskBody";
import { PlatformTaskBody } from "./PlatformTaskBody";
import { isDeskQuestion } from "./slots";
import { clockOf, serialOf } from "./taskModel";

const copy = DESK_COPY.tasks;

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
            {copy.stub(serial, task.title, route, copy.status[task.status], clockOf(task.createdAt))}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-wider">
            {collapsed ? copy.open : copy.collapse}
            <ChevronDown className={`h-4 w-4 transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-180"}`} aria-hidden="true" />
          </span>
        </button>
      ) : null}
      <div hidden={collapsed} className="flex min-w-0 flex-col gap-4">
        {question ? (
          <Question
            taskId={task.id}
            question={question}
            holdings={actions.holdings}
            onAnswer={(answer) =>
              getDeskStore()
                .getState()
                .patchTask(task.id, {
                  question: null,
                  turn: { kind: "answer", at: Date.now(), label: "optionId" in answer ? answer.optionId : answer.text },
                })
            }
            onDismiss={() => getDeskStore().getState().patchTask(task.id, { question: null })}
          />
        ) : null}
        {task.engine.kind === "network" ? <EngineTaskBody task={task} /> : <PlatformTaskBody task={task} />}
      </div>
    </article>
  );
}
