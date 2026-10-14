/**
 * The network engines live in the lazily loaded legacy chunk, one instance
 * per engine network (`LegacyEngineHost`), while their tasks render inside
 * the desk's thread. The hosts publish their engine here on every render and
 * the task bodies subscribe, so the desk's own chunk never imports the
 * engines. Each task's sentence goes to its engine once (StrictMode
 * remounts included).
 */
import type { LegacyEngine } from "../legacy";
import type { LegacyNetwork } from "../state/deskModel";

const engines = new Map<LegacyNetwork, LegacyEngine>();
const listeners = new Set<() => void>();
const submitted = new Set<string>();

export function publishEngine(network: LegacyNetwork, engine: LegacyEngine | null): void {
  if (engine) engines.set(network, engine);
  else engines.delete(network);
  for (const listener of listeners) listener();
}

export function getEngine(network: LegacyNetwork): LegacyEngine | null {
  return engines.get(network) ?? null;
}

export function subscribeEngines(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True the first time for a task: its sentence may go to the engine now. */
export function claimSubmission(taskId: string): boolean {
  if (submitted.has(taskId)) return false;
  submitted.add(taskId);
  return true;
}
