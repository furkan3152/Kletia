/**
 * The topbar's "Tasks (n)" popover (from 1024 px): the task list without leaving the view. The
 * rest of the old header moved into the machine shell (shell/machine).
 */
import { useEffect, useId, useRef, useState } from "react";

import { keyClass } from "../../kit";
import { DESK_COPY } from "../content/copy";
import { TaskList } from "../tasks/TaskList";

const copy = DESK_COPY.header;

export function TasksPopover({ count, onOpenTask, onNewTask }: { readonly count: number; readonly onOpenTask: (id: string) => void; readonly onNewTask: () => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative hidden lg:block">
      <button ref={buttonRef} type="button" className={keyClass({ tone: "flat", size: "sm" })} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>
        {copy.tasksButton(count)}
      </button>
      {open ? (
        <div id={panelId} className="absolute right-0 top-full z-50 mt-2 max-h-[70dvh] w-80 overflow-y-auto rounded-[16px] border border-[var(--k-line-2)] bg-[var(--k-raised)] p-3 shadow-obj">
          <TaskList
            headingLevel={2}
            onOpenTask={(id) => {
              setOpen(false);
              onOpenTask(id);
            }}
            onNewTask={() => {
              setOpen(false);
              onNewTask();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
