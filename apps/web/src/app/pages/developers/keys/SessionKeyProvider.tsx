import React, { useCallback, useMemo, useState } from "react";

import { SessionKeyContext, type SessionKeyState } from "./sessionKey";

/** Holds the visitor's developer key in memory for the developer portal. */
export function SessionKeyProvider({ children }: { readonly children: React.ReactNode }) {
  const [key, setRawKey] = useState("");
  const setKey = useCallback((next: string) => setRawKey(next.trim()), []);
  const clear = useCallback(() => setRawKey(""), []);
  const value = useMemo<SessionKeyState>(() => ({ key, setKey, clear }), [key, setKey, clear]);
  return <SessionKeyContext.Provider value={value}>{children}</SessionKeyContext.Provider>;
}
