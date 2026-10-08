import type { StateStorage } from "zustand/middleware";

/**
 * Browser storage can throw (private mode, disabled site data, quota, sandboxed
 * iframes). Every read and write goes through these helpers so a storage
 * failure never breaks rendering; callers treat a missing value as "unset".
 */

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStorage(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Storage is a convenience; failing to persist must not interrupt the user.
  }
}

export function removeStorage(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // See writeStorage.
  }
}

/** zustand `persist` adapter backed by the guarded helpers above. */
export const safeLocalStorage: StateStorage = {
  getItem: (name) => readStorage(name),
  setItem: (name, value) => writeStorage(name, value),
  removeItem: (name) => removeStorage(name),
};

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Tab-scoped storage (sessionStorage) with the same failure guarantees as above. */
export function readSessionStorage(key: string): string | null {
  try {
    return sessionStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSessionStorage(key: string, value: string): void {
  try {
    sessionStore()?.setItem(key, value);
  } catch {
    // See writeStorage.
  }
}

export function removeSessionStorage(key: string): void {
  try {
    sessionStore()?.removeItem(key);
  } catch {
    // See writeStorage.
  }
}

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(String(key)) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(String(key)),
    setItem: (key: string, value: string) => void items.set(String(key), String(value)),
  };
}

/**
 * When the browser refuses site data (a third-party /embed iframe with
 * third-party cookies blocked, or "block all cookies"), merely reading
 * `window.localStorage` throws a SecurityError. Wallet libraries read it
 * directly while rendering, so the page would fail to load its wallets.
 * Replace each refused storage with an in-memory one for this page load:
 * nothing persists, which is exactly what the user asked the browser for.
 */
export function installMemoryStorageFallback(): void {
  if (typeof window === "undefined") return;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      void window[name];
      continue;
    } catch {
      // Refused by the browser: fall through to the in-memory replacement.
    }
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        value: createMemoryStorage(),
      });
    } catch {
      // Not configurable here; callers keep using the guarded helpers above.
    }
  }
}
