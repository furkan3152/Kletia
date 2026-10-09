/**
 * The developer key a visitor pastes into the portal. It lives only in React
 * state for this page: never in localStorage, sessionStorage, cookies, the
 * URL or a snippet, and it is gone when the tab reloads or leaves the page.
 */
import { createContext, useContext } from "react";

export interface SessionKeyState {
  /** The raw key, or "" when none is loaded. */
  readonly key: string;
  readonly setKey: (key: string) => void;
  readonly clear: () => void;
}

export const SessionKeyContext = createContext<SessionKeyState>({
  key: "",
  setKey: () => undefined,
  clear: () => undefined,
});

export function useSessionKey(): SessionKeyState {
  return useContext(SessionKeyContext);
}

/** Developer key shape: `kl_dev_` + 32 base62 characters. */
export const DEV_KEY_PATTERN = /^kl_dev_[0-9A-Za-z]{32}$/u;

/** `kl_dev_…r7VC` (never render a full key outside the one-time reveal). */
export function maskKey(key: string): string {
  if (!key) return "";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
