import { useCallback, useMemo } from "react";
import { useAccount } from "wagmi";
import {
  CHAINS,
  formatAccountId,
  isEvmAddress,
  isSolanaAddress,
  resolveChain,
  type AccountId,
  type NetworkKey,
} from "@kletia/core";

import { safeWalletIcon, type ConnectedAccount } from "./types";
import { useSolanaWallet } from "./solana/solanaWalletContext";

export interface WalletsState {
  /** Connected EVM account (wagmi / RainbowKit), on the wallet's active chain. */
  readonly evm: ConnectedAccount | null;
  /** Connected Solana account (Wallet Standard), identified on Solana mainnet. */
  readonly solana: ConnectedAccount | null;
  /** CAIP-10 ids of every connected account, one per namespace. */
  readonly accounts: readonly AccountId[];
  /** CAIP-10 id for the connected account that can act on `network`. */
  accountFor: (network: NetworkKey) => AccountId | null;
}

function evmIcon(icon: unknown): string | undefined {
  if (typeof icon !== "string") return undefined;
  return safeWalletIcon(icon) ?? (icon.startsWith("https://") ? icon : undefined);
}

/** One view of every wallet the user connected, across namespaces. */
export function useWallets(): WalletsState {
  const { address: evmAddress, chainId, connector, status: evmStatus } = useAccount();
  const { account: solanaAccount, wallet: solanaWallet } = useSolanaWallet();

  const connectorName = connector?.name;
  const connectorIcon = connector?.icon;
  const evm = useMemo<ConnectedAccount | null>(() => {
    if (evmStatus !== "connected" || !evmAddress || !isEvmAddress(evmAddress)) return null;
    const chain = resolveChain(chainId ?? CHAINS.base.evmChainId);
    const network = chain && chain.namespace === "eip155" ? chain : CHAINS.base;
    const icon = evmIcon(connectorIcon);
    return {
      namespace: "eip155",
      address: evmAddress,
      accountId: formatAccountId(network, evmAddress),
      walletName: connectorName ?? "EVM wallet",
      ...(icon ? { walletIcon: icon } : {}),
    };
  }, [chainId, connectorIcon, connectorName, evmAddress, evmStatus]);

  const solanaAddress = solanaAccount?.address;
  const solanaWalletName = solanaWallet?.name;
  const solanaIcon = solanaWallet?.icon;
  const solana = useMemo<ConnectedAccount | null>(() => {
    if (!solanaAddress || !isSolanaAddress(solanaAddress)) return null;
    const icon = safeWalletIcon(solanaIcon);
    return {
      namespace: "solana",
      address: solanaAddress,
      accountId: formatAccountId("solana", solanaAddress),
      walletName: solanaWalletName ?? "Solana wallet",
      ...(icon ? { walletIcon: icon } : {}),
    };
  }, [solanaAddress, solanaIcon, solanaWalletName]);

  const accounts = useMemo(
    () => [evm?.accountId, solana?.accountId].filter((id): id is AccountId => Boolean(id)),
    [evm?.accountId, solana?.accountId],
  );

  const accountFor = useCallback(
    (network: NetworkKey): AccountId | null => {
      const chain = CHAINS[network];
      const connected = chain.namespace === "eip155" ? evm : solana;
      if (!connected) return null;
      try {
        return formatAccountId(chain, connected.address);
      } catch {
        return null;
      }
    },
    [evm, solana],
  );

  return useMemo(
    () => ({ evm, solana, accounts, accountFor }),
    [accountFor, accounts, evm, solana],
  );
}
