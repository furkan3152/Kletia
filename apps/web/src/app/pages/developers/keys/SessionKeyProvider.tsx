import React from "react";

/**
 * Kept for pages that still wrap themselves in it. The key now lives in the
 * module-level store (sessionKeyStore.ts) that `useSessionKey()` reads, so
 * it survives navigation between pages; the provider holds nothing and
 * never clears the key on unmount.
 */
export function SessionKeyProvider({ children }: { readonly children: React.ReactNode }) {
  return <>{children}</>;
}
