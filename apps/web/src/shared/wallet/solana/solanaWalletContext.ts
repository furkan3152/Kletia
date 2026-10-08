import { createContext, useContext } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

export type SolanaWalletStatus = "disconnected" | "connecting" | "connected";

export interface SolanaWalletContextValue {
  /** Wallet Standard wallets that support Solana signing, as discovered. */
  readonly wallets: readonly Wallet[];
  /** The connected wallet, if any. */
  readonly wallet: Wallet | null;
  /** The connected Solana account, if any. */
  readonly account: WalletAccount | null;
  readonly status: SolanaWalletStatus;
  /** Last connection error (user rejection, missing feature, ...). */
  readonly error: string | null;
  connect: (walletName: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** Open the accessible wallet picker dialog. */
  openPicker: () => void;
  closePicker: () => void;
  readonly pickerOpen: boolean;
}

const unavailable = async () => {
  throw new Error("SolanaWalletProvider is not mounted.");
};

export const SolanaWalletContext = createContext<SolanaWalletContextValue>({
  wallets: [],
  wallet: null,
  account: null,
  status: "disconnected",
  error: null,
  connect: unavailable,
  disconnect: unavailable,
  openPicker: () => undefined,
  closePicker: () => undefined,
  pickerOpen: false,
});

/** Solana wallet state for components rendered inside `SolanaWalletProvider`. */
export function useSolanaWallet(): SolanaWalletContextValue {
  return useContext(SolanaWalletContext);
}

export const SOLANA_WALLET_STORAGE_KEY = "kletia-solana-wallet";
