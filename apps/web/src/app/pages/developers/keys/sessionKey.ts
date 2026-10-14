/**
 * The developer key a visitor loads into the portal, read from the in-memory
 * store (sessionKeyStore.ts): it survives client-side navigation for the
 * tab's session, never touches localStorage, sessionStorage, cookies, the
 * URL or a snippet, and is gone on reload or after Forget key.
 */
import { useMemo, useSyncExternalStore } from "react";

import { clearSessionKey, getSessionKey, setSessionKey, subscribeSessionKey } from "./sessionKeyStore";

export interface SessionKeyState {
  /** The raw key, or "" when none is loaded. */
  readonly key: string;
  readonly setKey: (key: string) => void;
  readonly clear: () => void;
}

const noKeyOnTheServer = () => "";

/** The key in memory, re-rendering on every change (any page, any mount). */
export function useSessionKey(): SessionKeyState {
  const key = useSyncExternalStore(subscribeSessionKey, getSessionKey, noKeyOnTheServer);
  return useMemo<SessionKeyState>(() => ({ key, setKey: setSessionKey, clear: clearSessionKey }), [key]);
}

/** Developer key shape: `kl_dev_` + 32 base62 characters. */
export const DEV_KEY_PATTERN = /^kl_dev_[0-9A-Za-z]{32}$/u;
/** Agent key shape (Rule Book): `kl_agt_` + 32 base62 characters. */
export const AGENT_KEY_SHAPE = /^kl_agt_[0-9A-Za-z]{32}$/u;

export type PortalKeyKind = "developer" | "agent";

/** Which kind of complete key is loaded, or null (empty, partial or an operator key). */
export function portalKeyKind(key: string): PortalKeyKind | null {
  if (DEV_KEY_PATTERN.test(key)) return "developer";
  if (AGENT_KEY_SHAPE.test(key)) return "agent";
  return null;
}

/** `kl_dev_…r7VC` (never render a full key outside the one-time reveal). */
export function maskKey(key: string): string {
  if (!key) return "";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
