import React from "react";
import {
  connectorsForWallets,
  darkTheme,
  RainbowKitProvider,
} from "@rainbow-me/rainbowkit";
import {
  base as baseWallet,
  injectedWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createConfig, createStorage, WagmiProvider } from "wagmi";

import {
  ALLOW_PUBLIC_BASE_RPC_FALLBACK,
  ARBITRUM_SEPOLIA_RPC_URL,
  INTENT_WALLET_NETWORKS,
  NETWORKS,
  OFFICIAL_BASE_PUBLIC_RPC_URL,
  SUPPORTED_CHAINS,
} from "../shared/config/networks";
import { readStorage, removeStorage, writeStorage } from "../shared/state/safeStorage";
import { WalletSyncBridge } from "../shared/sync/WalletSyncBridge";
import { SolanaWalletProvider } from "../shared/wallet/solana/SolanaWalletProvider";

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  string | undefined;
const hasWalletConnectProjectId =
  Boolean(walletConnectProjectId) &&
  !walletConnectProjectId!.toLowerCase().startsWith("your_");

const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: [
        injectedWallet,
        baseWallet,
        ...(hasWalletConnectProjectId ? [walletConnectWallet] : []),
      ],
    },
  ],
  {
    appName: "Kletia Omni-Engine",
    projectId: hasWalletConnectProjectId ? walletConnectProjectId! : "",
  },
);

const uniqueRpcUrls = (...urls: Array<string | undefined>) => [
  ...new Set(urls.filter((url): url is string => Boolean(url))),
];

/** One HTTP transport per endpoint, tried in order (a single endpoint needs no fallback). */
const rpcTransport = (urls: readonly string[]) => {
  const transports = uniqueRpcUrls(...urls).map((url) => http(url));
  return transports.length > 1 ? fallback(transports) : transports[0];
};

const config = createConfig({
  connectors,
  chains: SUPPORTED_CHAINS,
  transports: {
    [NETWORKS.base.chainId]: (() => {
      const transports = uniqueRpcUrls(
        NETWORKS.base.rpcUrl,
        ...(ALLOW_PUBLIC_BASE_RPC_FALLBACK
          ? [OFFICIAL_BASE_PUBLIC_RPC_URL]
          : []),
      ).map((url) => http(url));
      return transports.length > 1 ? fallback(transports) : transports[0];
    })(),
    [NETWORKS.arc.chainId]: fallback(
      uniqueRpcUrls(
        NETWORKS.arc.rpcUrl,
        "https://rpc.drpc.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
      ).map((url) => http(url)),
    ),
    [NETWORKS.arbitrum.chainId]: http(NETWORKS.arbitrum.rpcUrl),
    [arbitrumSepolia.id]: http(ARBITRUM_SEPOLIA_RPC_URL),
    // Intent-only networks (Studio and /embed switch the wallet to them per
    // step). Signing and receipts go through the wallet itself; these
    // transports serve wallet-UI reads such as balances.
    [INTENT_WALLET_NETWORKS.ethereum.chain.id]: rpcTransport(INTENT_WALLET_NETWORKS.ethereum.rpcUrls),
    [INTENT_WALLET_NETWORKS.optimism.chain.id]: rpcTransport(INTENT_WALLET_NETWORKS.optimism.rpcUrls),
    [INTENT_WALLET_NETWORKS.polygon.chain.id]: rpcTransport(INTENT_WALLET_NETWORKS.polygon.rpcUrls),
  },
  ssr: false,
  // wagmi's default storage reads `window.localStorage` eagerly, which throws
  // when site data is blocked (e.g. /embed in a third-party iframe). The
  // guarded helpers fall back to "nothing remembered" instead.
  storage: createStorage({
    storage: { getItem: readStorage, setItem: writeStorage, removeItem: removeStorage },
  }),
});

const queryClient = new QueryClient();
const walletTheme = darkTheme({
  accentColor: "#0052FF",
  borderRadius: "small",
});

/** The subtree rendered inside the providers; read through context (see `ProviderShell`). */
const ProvidedChildren = React.createContext<React.ReactNode>(null);

function ProvidedChildrenSlot() {
  return <>{React.useContext(ProvidedChildren)}</>;
}

/**
 * The provider stack, rendered once. wagmi's `WagmiProvider` (its Hydrate
 * step) starts a reconnect on every render; when a parent re-rendered the
 * providers, an EVM connection went `reconnecting` and back each time, which
 * looped on /embed (wallet state -> page state -> providers re-render). The
 * children arrive through context instead of props, so a parent re-render
 * only updates the slot and never re-renders this shell.
 */
const ProviderShell = React.memo(function ProviderShell() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider locale="en-US" theme={walletTheme}>
          <SolanaWalletProvider>
            <WalletSyncBridge />
            <ProvidedChildrenSlot />
          </SolanaWalletProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
});

/**
 * Wallet and data providers for every route that talks to a wallet: wagmi +
 * RainbowKit for EVM networks and Wallet Standard for Solana. Loaded lazily
 * so marketing and documentation routes stay light.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  return (
    <ProvidedChildren.Provider value={children}>
      <ProviderShell />
    </ProvidedChildren.Provider>
  );
}

export default WalletProviders;
