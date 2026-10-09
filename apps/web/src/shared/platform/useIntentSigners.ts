import { useMemo } from "react";
import { useAccount } from "wagmi";
import type { AccountId } from "@kletia/core";
import type { IntentSigners } from "@kletia/sdk";

import { signAndSendSolanaTransaction } from "../wallet/solana/executeSolanaTransaction";
import { useSolanaWallet } from "../wallet/solana/solanaWalletContext";
import type { ConnectedAccount } from "../wallet/types";
import { useWallets } from "../wallet/useWallets";
import { lazyEip1193Signer, walletStandardIntentSigner } from "./intentSigners";

export interface ConnectedIntentSigners {
  /** Signers for each connected namespace (empty when nothing is connected). */
  readonly signers: IntentSigners;
  /** CAIP-10 ids of the connected accounts (real wallets only). */
  readonly accounts: readonly AccountId[];
  readonly evm: ConnectedAccount | null;
  readonly solana: ConnectedAccount | null;
  /** True when at least one wallet can sign. */
  readonly canSign: boolean;
}

/**
 * SDK signers for the wallets the user connected. Must render inside
 * `WalletProviders` (wagmi + RainbowKit + Solana Wallet Standard).
 */
export function useIntentSigners(): ConnectedIntentSigners {
  const { connector } = useAccount();
  const { wallet: solanaWallet, account: solanaAccount } = useSolanaWallet();
  const { evm, solana, accounts } = useWallets();

  const evmAddress = evm?.address ?? null;
  const evmSigner = useMemo(() => {
    if (!evmAddress || !connector || typeof connector.getProvider !== "function") return undefined;
    // The connector's switchChain only accepts chains in the wagmi config
    // (SUPPORTED_CHAINS) and adds a known one the wallet lacks (e.g. Polygon).
    const switchChain =
      typeof connector.switchChain === "function"
        ? (chainId: number) => connector.switchChain!({ chainId })
        : undefined;
    return lazyEip1193Signer(evmAddress, () => connector.getProvider(), switchChain);
  }, [connector, evmAddress]);

  const solanaSigner = useMemo(() => {
    if (!solanaWallet || !solanaAccount || !solana) return undefined;
    return walletStandardIntentSigner(solanaWallet, solanaAccount, signAndSendSolanaTransaction);
  }, [solana, solanaAccount, solanaWallet]);

  // The signers keep their identity while only the wallet's network changes:
  // a chain switch in the middle of a step (approve, switch, supply) must not
  // look like a new wallet to callers that lease or key on them (`/embed`).
  const signers = useMemo<IntentSigners>(
    () => ({
      ...(evmSigner ? { evm: evmSigner } : {}),
      ...(solanaSigner ? { solana: solanaSigner } : {}),
    }),
    [evmSigner, solanaSigner],
  );

  return useMemo(
    () => ({
      signers,
      accounts,
      evm,
      solana,
      canSign: Boolean(evmSigner || solanaSigner),
    }),
    [accounts, evm, evmSigner, signers, solana, solanaSigner],
  );
}
