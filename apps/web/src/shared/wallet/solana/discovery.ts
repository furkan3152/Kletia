import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

/**
 * Wallet Standard discovery for Solana wallets (Phantom, Solflare, Backpack
 * and any other wallet that registers itself). Wallets announce themselves
 * asynchronously, so the list is a small external store that React reads
 * with `useSyncExternalStore`.
 */

export const SOLANA_WALLET_CHAINS = ["solana:mainnet", "solana:devnet"] as const;
export type SolanaWalletChain = (typeof SOLANA_WALLET_CHAINS)[number];

export const STANDARD_CONNECT = "standard:connect";
export const STANDARD_DISCONNECT = "standard:disconnect";
export const STANDARD_EVENTS = "standard:events";
export const SOLANA_SIGN_AND_SEND = "solana:signAndSendTransaction";
export const SOLANA_SIGN_TRANSACTION = "solana:signTransaction";

export function isSolanaChain(value: unknown): value is SolanaWalletChain {
  return value === "solana:mainnet" || value === "solana:devnet";
}

/** A wallet Kletia can connect to and ask to sign Solana transactions. */
export function isSolanaWallet(wallet: Wallet): boolean {
  const features = wallet.features;
  return (
    STANDARD_CONNECT in features &&
    (SOLANA_SIGN_AND_SEND in features || SOLANA_SIGN_TRANSACTION in features) &&
    wallet.chains.some(isSolanaChain)
  );
}

/** Prefer an account that can act on Solana mainnet, then devnet. */
export function pickSolanaAccount(
  accounts: readonly WalletAccount[],
  preferredAddress?: string | null,
): WalletAccount | null {
  const solanaAccounts = accounts.filter(
    (account) => account.chains.length === 0 || account.chains.some(isSolanaChain),
  );
  if (preferredAddress) {
    const same = solanaAccounts.find((account) => account.address === preferredAddress);
    if (same) return same;
  }
  return (
    solanaAccounts.find((account) => account.chains.includes("solana:mainnet")) ??
    solanaAccounts[0] ??
    null
  );
}

let snapshot: readonly Wallet[] = [];
let initialized = false;
const listeners = new Set<() => void>();

function refresh() {
  snapshot = getWallets().get().filter(isSolanaWallet);
  for (const listener of [...listeners]) listener();
}

function ensureDiscovery() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const api = getWallets();
  api.on("register", refresh);
  api.on("unregister", refresh);
  snapshot = api.get().filter(isSolanaWallet);
}

export function subscribeSolanaWallets(listener: () => void): () => void {
  ensureDiscovery();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSolanaWalletsSnapshot(): readonly Wallet[] {
  ensureDiscovery();
  return snapshot;
}

export function getServerSolanaWalletsSnapshot(): readonly Wallet[] {
  return [];
}
