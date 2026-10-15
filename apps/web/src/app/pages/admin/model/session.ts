/**
 * Session rules the panel applies on its side (admin design A, G.2 gate
 * states), with the owner's two admin wallets: an EVM wallet (EIP-4361) and a
 * Solana wallet (Sign In With Solana style text). Either one signs a session
 * with the same panel access; on-chain EVM actions still need the EVM wallet
 * connected to sign them. Pure, so `node --test` loads it.
 */
import type { AdminContractState, AdminSessionView, AdminWalletKind } from "./types.ts";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
/** Solana public keys: 32 bytes in base58, 32 to 44 characters. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

export function isSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS.test(value);
}

/** The wallet family of a session (read from the address when an older API leaves `walletKind` out). */
export function sessionKind(session: Pick<AdminSessionView, "address"> & { readonly walletKind?: AdminWalletKind }): AdminWalletKind {
  if (session.walletKind === "evm" || session.walletKind === "solana") return session.walletKind;
  return isEvmAddress(session.address) ? "evm" : "solana";
}

/** EVM addresses compare without case; base58 is case sensitive. */
export function sameAddress(kind: AdminWalletKind, a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `0xabcd…1234` / `D2Ts…tvm` for headers and gate copy. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** The wallets the panel can see, by family. */
export interface ConnectedWallets {
  readonly evm: string | null;
  readonly evmChainId: number | null;
  readonly solana: string | null;
}

/**
 * Gate state 7: the wallet that signed the session switched to another
 * account, so the panel signs out. A wallet that disconnects keeps the
 * session (reads still work; signing asks to reconnect).
 */
export function walletSwitchedAway(session: AdminSessionView, wallets: ConnectedWallets): boolean {
  const kind = sessionKind(session);
  const current = kind === "evm" ? wallets.evm : wallets.solana;
  return current !== null && !sameAddress(kind, current, session.address);
}

/** Admin panel hosts (admin design A.2): same-site with api.kletiaai.xyz, or a local development host. */
export const ADMIN_HOSTS: readonly string[] = ["kletiaai.xyz", "www.kletiaai.xyz"];
const DEV_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1"];

/** Gate state 2: the cookie cannot work cross-site, so other origins send the owner to kletiaai.xyz. */
export function adminOriginSupported(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (DEV_HOSTNAMES.includes(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && ADMIN_HOSTS.includes(url.host);
}

/** When the session ends: the earlier of the absolute and the idle expiry. */
export function sessionEndsAt(session: Pick<AdminSessionView, "expiresAt" | "idleExpiresAt">): number {
  const absolute = Date.parse(session.expiresAt);
  const idle = Date.parse(session.idleExpiresAt);
  const values = [absolute, idle].filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : Number.NaN;
}

/** "7 h 12 min", "4 min", "under a minute", "expired". */
export function countdownText(endsAt: number, now: number): string {
  if (!Number.isFinite(endsAt)) return "unknown";
  const left = endsAt - now;
  if (left <= 0) return "expired";
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Who can sign on-chain EVM actions right now. A Solana session has the same
 * panel access, but contracts are owned by EVM addresses: deploys, owner
 * actions and Safe signatures need the EVM wallet connected in this browser.
 */
export type EvmSigner =
  | { readonly ready: true; readonly address: string; readonly chainId: number | null }
  | { readonly ready: false; readonly reason: string };

export const SOLANA_ONLY_NOTICE =
  "You are signed in with the Solana admin wallet. Reading, recording and exporting work as usual; deploys, owner actions and Safe signatures happen on EVM networks and need the EVM admin wallet connected to sign them.";

export function evmSignerFor(session: AdminSessionView, wallets: ConnectedWallets): EvmSigner {
  if (wallets.evm) {
    // The API names the EVM wallets that may send admin transactions for this session (the EVM allowlist for a
    // Solana session); the panel refuses any other before a wallet prompt, as the API would after it.
    const actors = session.evmActors ?? [];
    if (actors.length > 0 && !actors.some((actor) => sameAddress("evm", actor, wallets.evm))) {
      return { ready: false, reason: `The connected EVM wallet ${shortAddress(wallets.evm)} is not an admin wallet. Connect one listed in KLETIA_ADMIN_ADDRESSES.` };
    }
    return { ready: true, address: wallets.evm, chainId: wallets.evmChainId };
  }
  return sessionKind(session) === "solana"
    ? { ready: false, reason: "Connect the EVM admin wallet to sign on-chain actions. Your Solana session stays signed in." }
    : { ready: false, reason: "Reconnect the EVM admin wallet to sign on-chain actions." };
}

/**
 * How the connected EVM wallet can act on a contract. The API computes
 * `adminCanAct` against the session address, which is a Solana key in a
 * Solana session; the panel decides from the owner it read and the wallet
 * that would actually sign.
 */
export type ActorMode = "direct" | "via-safe" | "pending-owner" | "no";

export function actorFor(state: Pick<AdminContractState, "owner" | "pendingOwner" | "ownerKind" | "safe">, signer: string | null): ActorMode {
  if (!signer) return "no";
  if (state.owner && sameAddress("evm", state.owner, signer)) return "direct";
  if (state.ownerKind === "safe" && state.safe?.owners.some((owner) => sameAddress("evm", owner, signer))) return "via-safe";
  if (state.pendingOwner && sameAddress("evm", state.pendingOwner, signer)) return "pending-owner";
  return "no";
}

/** The sentence a disabled action shows when the connected wallet cannot act. */
export function cannotActReason(state: Pick<AdminContractState, "owner" | "ownerKind">, signer: string | null, session: AdminSessionView): string {
  if (!signer) {
    return sessionKind(session) === "solana"
      ? "Connect the EVM admin wallet to act. The Solana session can read and record, not sign on EVM networks."
      : "Connect the EVM admin wallet to act.";
  }
  if (!state.owner) return "This contract has no owner.";
  const owner = shortAddress(state.owner);
  return state.ownerKind === "safe"
    ? `Owned by the Safe ${owner}, and the connected wallet is not one of its owners.`
    : `Owned by ${owner}. Connect that wallet (add it to KLETIA_ADMIN_ADDRESSES) or transfer ownership.`;
}

/** A wallet error as one sentence; rejections are inline and non-blocking (admin design G.2). */
export function walletErrorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 4001 || /UserRejected|User rejected|user denied|rejected the request|User canceled|cancelled by user/iu.test(text)) {
    return "You rejected the request in your wallet.";
  }
  if (/insufficient funds/iu.test(text)) return "The wallet does not hold enough native gas for this transaction.";
  if (/chain mismatch|does not match the target chain|Unrecognized chain/iu.test(text)) return "The wallet is on another network. Switch networks and try again.";
  const short = error instanceof Error && "shortMessage" in error && typeof (error as { shortMessage?: unknown }).shortMessage === "string" ? (error as { shortMessage: string }).shortMessage : null;
  return short ?? (error instanceof Error && error.message ? error.message.split("\n")[0] ?? "The wallet request failed." : "The wallet request failed.");
}
