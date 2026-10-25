/**
 * The machine panel's "Now" feed: a task body publishes its plan's legs and their live state
 * here, the panel reads the active task's. Memory only, one entry per task, removed when the
 * task body unmounts. A leg is "done" only when the API says its step settled or confirmed:
 * the feed mirrors execution state, it never runs ahead of it.
 */
import { useSyncExternalStore } from "react";

import type { MachineLeg } from "./machineModel";

const legsByTask = new Map<string, readonly MachineLeg[]>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function same(a: readonly MachineLeg[] | undefined, b: readonly MachineLeg[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((leg, index) => {
    const other = b[index]!;
    return leg.id === other.id && leg.state === other.state && leg.word === other.word && leg.title === other.title && leg.detail === other.detail;
  });
}

export function publishLegs(taskId: string, legs: readonly MachineLeg[]): void {
  if (same(legsByTask.get(taskId), legs)) return;
  legsByTask.set(taskId, legs);
  emit();
}

export function clearLegs(taskId: string): void {
  if (legsByTask.delete(taskId)) emit();
}

export function legsOf(taskId: string | null): readonly MachineLeg[] | null {
  return taskId ? (legsByTask.get(taskId) ?? null) : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The legs a task published (null when it published none). */
export function useMachineLegs(taskId: string | null): readonly MachineLeg[] | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return legsOf(taskId);
}
