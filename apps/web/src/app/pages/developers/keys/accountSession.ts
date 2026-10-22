/**
 * The developer account session of this tab (accountSessionStore.ts), read
 * by components and re-rendering on every change.
 */
import { useSyncExternalStore } from "react";

import { getAccountSession, subscribeAccountSession, type AccountSessionState } from "./accountSessionStore";

const noSessionOnTheServer = () => null;

export function useAccountSession(): AccountSessionState | null {
  return useSyncExternalStore(subscribeAccountSession, getAccountSession, noSessionOnTheServer);
}
