/**
 * The developer account session of this tab: the token from wallet sign-in
 * and its view, held in this module's memory like the developer key
 * (sessionKeyStore.ts). It survives client-side navigation and is gone after
 * a reload or Sign out; signing in again (on this or any device) brings the
 * same projects back. It never touches localStorage, sessionStorage, cookies
 * or the URL. No relative imports, so the node tests load this file directly.
 */

export interface AccountSessionState {
  readonly token: string;
  readonly walletKind: "evm" | "solana";
  readonly address: string;
  readonly expiresAt: string;
}

type Listener = () => void;

let current: AccountSessionState | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function getAccountSession(): AccountSessionState | null {
  return current;
}

/** Holds a session after sign-in (the token shape is checked; anything else clears it). */
export function setAccountSession(next: AccountSessionState | null): void {
  const valid = next !== null && /^kl_acs_[A-Za-z0-9_-]{43}$/u.test(next.token) ? next : null;
  if (valid === current) return;
  current = valid;
  emit();
}

export function clearAccountSession(): void {
  setAccountSession(null);
}

export function subscribeAccountSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
