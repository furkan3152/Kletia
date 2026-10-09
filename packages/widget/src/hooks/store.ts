/** A tiny external store for `useSyncExternalStore`: snapshots are replaced, never mutated. */
export interface Store<S> {
  getState(): S;
  setState(next: S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (next) => {
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A failing subscriber must not stop the others.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** JSON with sorted object keys, so equal inputs written in another order compare equal. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
