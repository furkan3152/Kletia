import React from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";

import { readStorage, removeStorage, writeStorage } from "../../state/safeStorage";
import {
  getServerSolanaWalletsSnapshot,
  getSolanaWalletsSnapshot,
  pickSolanaAccount,
  STANDARD_CONNECT,
  STANDARD_DISCONNECT,
  STANDARD_EVENTS,
  subscribeSolanaWallets,
} from "./discovery";
import {
  SOLANA_WALLET_STORAGE_KEY,
  SolanaWalletContext,
  type SolanaWalletContextValue,
} from "./solanaWalletContext";
import { SolanaWalletPicker } from "./SolanaWalletPicker";

type ConnectFeature = StandardConnectFeature[typeof STANDARD_CONNECT];
type DisconnectFeature = StandardDisconnectFeature[typeof STANDARD_DISCONNECT];
type EventsFeature = StandardEventsFeature[typeof STANDARD_EVENTS];

interface Session {
  readonly walletName: string;
  readonly account: WalletAccount;
}

function connectFeature(wallet: Wallet): ConnectFeature | null {
  const feature = wallet.features[STANDARD_CONNECT] as ConnectFeature | undefined;
  return feature && typeof feature.connect === "function" ? feature : null;
}

function connectionErrorMessage(error: unknown, walletName: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/reject|denied|cancel/iu.test(message)) {
    return `The connection request was declined in ${walletName}.`;
  }
  return message
    ? `${walletName} could not connect: ${message.slice(0, 160)}`
    : `${walletName} could not connect.`;
}

/**
 * Wallet Standard connection state for Solana. Mounted inside the EVM wallet
 * providers so both namespaces are available to every console feature.
 */
export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = React.useSyncExternalStore(
    subscribeSolanaWallets,
    getSolanaWalletsSnapshot,
    getServerSolanaWalletsSnapshot,
  );
  const [session, setSession] = React.useState<Session | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const silentAttemptRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const wallet = React.useMemo(
    () => (session ? wallets.find((candidate) => candidate.name === session.walletName) ?? null : null),
    [session, wallets],
  );
  const account = wallet && session ? session.account : null;

  // Silent reconnect: wallets register asynchronously, so retry whenever a
  // wallet with the remembered name appears. One attempt per wallet name.
  React.useEffect(() => {
    if (session) return;
    const remembered = readStorage(SOLANA_WALLET_STORAGE_KEY);
    if (!remembered || silentAttemptRef.current === remembered) return;
    const target = wallets.find((candidate) => candidate.name === remembered);
    const feature = target ? connectFeature(target) : null;
    if (!target || !feature) return;
    silentAttemptRef.current = remembered;
    feature
      .connect({ silent: true })
      .then(({ accounts }) => {
        if (!mountedRef.current) return;
        const picked = pickSolanaAccount(accounts.length > 0 ? accounts : target.accounts);
        if (picked) {
          setSession((current) => current ?? { walletName: target.name, account: picked });
        }
      })
      .catch(() => {
        // A silent reconnect that the wallet declines simply leaves the user disconnected.
      });
  }, [session, wallets]);

  // Follow account switches and wallet-side disconnects.
  React.useEffect(() => {
    if (!wallet) return;
    const events = wallet.features[STANDARD_EVENTS] as EventsFeature | undefined;
    if (!events || typeof events.on !== "function") return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      setSession((current) => {
        if (!current || current.walletName !== wallet.name) return current;
        const next = pickSolanaAccount(accounts, current.account.address);
        return next ? { walletName: wallet.name, account: next } : null;
      });
    });
  }, [wallet]);

  const connect = React.useCallback(async (walletName: string): Promise<boolean> => {
    const target = getSolanaWalletsSnapshot().find((candidate) => candidate.name === walletName);
    const feature = target ? connectFeature(target) : null;
    if (!target || !feature) {
      setError(`${walletName} is not available in this browser.`);
      return false;
    }
    setConnecting(true);
    setError(null);
    try {
      const { accounts } = await feature.connect();
      const picked = pickSolanaAccount(accounts.length > 0 ? accounts : target.accounts);
      if (!picked) {
        throw new Error("No Solana account was shared.");
      }
      silentAttemptRef.current = target.name;
      writeStorage(SOLANA_WALLET_STORAGE_KEY, target.name);
      if (mountedRef.current) setSession({ walletName: target.name, account: picked });
      return true;
    } catch (connectError) {
      if (mountedRef.current) setError(connectionErrorMessage(connectError, target.name));
      return false;
    } finally {
      if (mountedRef.current) setConnecting(false);
    }
  }, []);

  const disconnect = React.useCallback(async () => {
    const target = wallet;
    setSession(null);
    setError(null);
    removeStorage(SOLANA_WALLET_STORAGE_KEY);
    const feature = target?.features[STANDARD_DISCONNECT] as DisconnectFeature | undefined;
    if (feature && typeof feature.disconnect === "function") {
      try {
        await feature.disconnect();
      } catch {
        // The local session is already cleared; a wallet-side failure is not actionable.
      }
    }
  }, [wallet]);

  const openPicker = React.useCallback(() => {
    setError(null);
    setPickerOpen(true);
  }, []);
  const closePicker = React.useCallback(() => setPickerOpen(false), []);

  const value = React.useMemo<SolanaWalletContextValue>(
    () => ({
      wallets,
      wallet: account ? wallet : null,
      account,
      status: account ? "connected" : connecting ? "connecting" : "disconnected",
      error,
      connect,
      disconnect,
      openPicker,
      closePicker,
      pickerOpen,
    }),
    [account, closePicker, connect, connecting, disconnect, error, openPicker, pickerOpen, wallet, wallets],
  );

  return (
    <SolanaWalletContext.Provider value={value}>
      {children}
      <SolanaWalletPicker />
    </SolanaWalletContext.Provider>
  );
}

export default SolanaWalletProvider;
