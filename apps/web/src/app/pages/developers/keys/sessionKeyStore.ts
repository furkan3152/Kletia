/**
 * The developer key a visitor loads into the developer portal, held in this
 * module's memory for the tab's single-page session. It survives client-side
 * navigation, leaving /developers and coming back included, and it is gone
 * after a reload (the module starts again) or after Forget key. No shell or
 * page clears it on unmount.
 *
 * It never touches localStorage, sessionStorage, cookies, the URL, the
 * document title or a snippet: the only copy lives in `current` below, and
 * pages read it through `useSessionKey()` (sessionKey.ts). No relative
 * imports, so the node tests load this file directly.
 */

type Listener = () => void;

let current = "";
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The key in memory, or "" when none is loaded. */
export function getSessionKey(): string {
  return current;
}

/** Loads a key into memory (trimmed). Never persisted anywhere. */
export function setSessionKey(next: string): void {
  const value = typeof next === "string" ? next.trim() : "";
  if (value === current) return;
  current = value;
  emit();
}

/** Forget key: drops the key from memory. */
export function clearSessionKey(): void {
  setSessionKey("");
}

/** Calls `listener` after every change; returns the unsubscribe function. */
export function subscribeSessionKey(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
