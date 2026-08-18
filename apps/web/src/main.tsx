import React from "react";
import ReactDOM from "react-dom/client";
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
import { createConfig, WagmiProvider } from "wagmi";

import App from "./app/App.tsx";
import {
  ALLOW_PUBLIC_BASE_RPC_FALLBACK,
  NETWORKS,
  OFFICIAL_BASE_PUBLIC_RPC_URL,
  SUPPORTED_CHAINS,
} from "./shared/config/networks";
import "./app/styles.css";

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
  },
  ssr: false,
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          locale="en-US"
          theme={darkTheme({
            accentColor: "#0052FF",
            borderRadius: "small",
          })}
        >
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
