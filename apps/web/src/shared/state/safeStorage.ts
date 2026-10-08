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
