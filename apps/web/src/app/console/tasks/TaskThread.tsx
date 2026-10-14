/**
 * The desk's thread: every task of this tab, oldest first so the newest
 * sits above the composer, plus restored cross-chain workflows of the
 * old engines. Focusing a task (from the task list) scrolls to its
 * ticket and focuses its heading.
 */
import { useEffect, useMemo, useRef } from "react";

import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { useAppStore } from "../../../shared/state/useAppStore";
import type { NetworkMode } from "../../../shared/config/networks";
import { DESK_COPY } from "../content/copy";
import { DESK_MORE_COPY } from "../shell/deskCopy";
import { isLegacyNetwork } from "../state/deskModel";
import { useDeskStore, type TaskRecord } from "../state/deskStore";
import { EngineTaskBody } from "./EngineTaskBody";

/** Workflow threads (`wf:<id>`) the old engines restored, as read-only engine tasks. */
function useWorkflowTasks(): readonly TaskRecord[] {
  const messagesByNetwork = useAppStore((state) => state.messagesByNetwork);
  return useMemo(() => {
    const tasks: TaskRecord[] = [];
    for (const [network, messages] of Object.entries(messagesByNetwork) as [NetworkMode, typeof messagesByNetwork.base][]) {
      if (!isLegacyNetwork(network)) continue;
      const threads = new Set(messages.map((message) => message.threadId).filter((id): id is string => Boolean(id?.startsWith("wf:"))));
      for (const id of threads) {
        tasks.push({
          id,
          createdAt: 0,
          sentence: "",
          title: DESK_MORE_COPY.tasks.restoredWorkflow,
          departure: network,
          lane: network === "arc" ? "testnet" : "production",
          engine: { kind: "network", network, why: "tool" },
          intentId: null,
          status: "engine",
          question: null,
          turns: [],
          ends: { from: network, to: network },
          restored: true,
        });
      }
    }
    return tasks;
  }, [messagesByNetwork]);
}

export function TaskThread({ renderTask }: { readonly renderTask: (task: TaskRecord, newest: boolean) => React.ReactNode }) {
  const tasks = useDeskStore((state) => state.tasks);
  const focusedTaskId = useDeskStore((state) => state.focusedTaskId);
  const workflows = useWorkflowTasks();
  const previousCount = useRef(tasks.length);

  useEffect(() => {
    if (!focusedTaskId) return;
    const article = document.getElementById(`task-${focusedTaskId}`);
    if (!article) return;
    const added = tasks.length > previousCount.current;
    article.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: added ? "end" : "start" });
    // A task picked from the list gets focus; a task just added leaves focus in the composer.
    if (!added) article.querySelector<HTMLElement>("h2[tabindex]")?.focus({ preventScroll: true });
  }, [focusedTaskId, tasks.length]);

  useEffect(() => {
    previousCount.current = tasks.length;
  }, [tasks.length]);

  const newestId = tasks[tasks.length - 1]?.id;
  return (
    <section aria-label={DESK_COPY.tasks.regionLabel} className="kd-thread">
      {workflows.map((task) => (
        <article key={task.id} className="kd-task" aria-label={DESK_MORE_COPY.tasks.restoredWorkflow}>
          <EngineTaskBody task={task} />
        </article>
      ))}
      {tasks.map((task) => renderTask(task, task.id === newestId))}
    </section>
  );
}
