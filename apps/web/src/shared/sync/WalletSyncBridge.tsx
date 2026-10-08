import { useEffect, useRef } from "react";
import type { AccountId } from "@kletia/core";

import { useWallets } from "../wallet/useWallets";
import { emitWalletConnected, emitWalletDisconnected } from "./bus";

function usePublishedAccount(accountId: AccountId | null, walletName: string): void {
  const previousRef = useRef<AccountId | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    if (previous === accountId) return;
    previousRef.current = accountId;
    if (previous) emitWalletDisconnected(previous);
    if (accountId) emitWalletConnected(accountId, walletName);
  }, [accountId, walletName]);
}

/**
 * Publishes `wallet.connected` / `wallet.disconnected` on the Kletia bus
 * whenever the EVM or Solana account changes (connect, disconnect, account
 * switch or EVM chain switch). Renders nothing.
 */
export function WalletSyncBridge() {
  const { evm, solana } = useWallets();
  usePublishedAccount(evm?.accountId ?? null, evm?.walletName ?? "EVM wallet");
  usePublishedAccount(solana?.accountId ?? null, solana?.walletName ?? "Solana wallet");
  return null;
}

export default WalletSyncBridge;
