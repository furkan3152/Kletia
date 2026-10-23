/**
 * Every task of this tab, newest first (console design 3.8): serial, title,
 * From and To bullets, engine badge, status and time. Picking one opens the
 * desk at its ticket; "New task" focuses the composer; "Clear finished"
 * removes finished tasks (a signing task never goes).
 */
import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { isFinishedStatus } from "../state/deskSession";
import { getDeskStore, tasksNewestFirst, useDeskStore } from "../state/deskStore";
import { clockOf, serialOf, taskStatusLabel } from "./taskModel";

const copy = DESK_COPY.tasks;

export interface TaskListProps {
  readonly onOpenTask: (taskId: string) => void;
  readonly onNewTask: () => void;
  readonly headingLevel?: 2 | 3;
  /** The full Tasks view: the heading reads like every other view's title (the rail keeps the small label). */
  readonly asView?: boolean;
}

export function TaskList({ onOpenTask, onNewTask, headingLevel = 2, asView = false }: TaskListProps) {
  const all = useDeskStore((state) => state.tasks);
  // A selector must return a stable value: sort the stored list, not a fresh one per read.
  const tasks = useMemo(() => tasksNewestFirst({ tasks: all }), [all]);
  const focusedTaskId = useDeskStore((state) => state.focusedTaskId);
  const anyFinished = tasks.some((task) => isFinishedStatus(task.status));
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="flex flex-col gap-3">
      <Heading className={asView ? "font-display text-2xl font-bold" : "text-xs font-black uppercase tracking-[0.16em] text-muted"}>{asView ? copy.viewTitle : copy.railTitle}</Heading>
      <button
        type="button"
        onClick={onNewTask}
        className="inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-control bg-surface text-xs font-black uppercase tracking-wider text-fg shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] dark:shadow-[2px_2px_0_#475569]"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {copy.newTask}
      </button>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted">{copy.none}</p>
      ) : (
        <ul aria-label={copy.listLabel} className="flex flex-col gap-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpenTask(task.id)}
                aria-current={focusedTaskId === task.id ? "true" : undefined}
                className="flex min-h-11 w-full flex-col gap-1 border-2 border-control bg-surface px-3 py-2 text-left text-fg hover:bg-surface-2 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] aria-[current=true]:border-[3px]"
              >
                <span className="flex items-center gap-2 font-code text-xs font-bold">
                  <span aria-hidden="true">{isFinishedStatus(task.status) ? "○" : "●"}</span>
                  {serialOf(task.intentId ?? task.id)}
                  {task.engine.kind === "network" ? <LineBullet line={LINES[task.engine.network]} /> : null}
                </span>
                <span className="line-clamp-2 break-words text-sm font-bold">{task.title}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted">
                  {task.ends ? (
                    <>
                      <LineBullet line={LINES[task.ends.from]} />
                      {task.ends.to !== task.ends.from ? <LineBullet line={LINES[task.ends.to]} /> : null}
                    </>
                  ) : null}
                  <span>
                    {taskStatusLabel(task)} {clockOf(task.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {anyFinished ? (
        <button
          type="button"
          onClick={() => getDeskStore().getState().clearFinished()}
          className="inline-flex min-h-11 items-center gap-2 self-start text-xs font-black uppercase tracking-wider text-fg underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {copy.clearFinished}
        </button>
      ) : null}
    </div>
  );
}
