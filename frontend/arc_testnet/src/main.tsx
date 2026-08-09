import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import '@rainbow-me/rainbowkit/styles.css';
import { getDefaultConfig, RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

import { http } from 'wagmi';

import { type Chain } from 'viem';
import { hardhat } from 'viem/chains';

export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Native USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.drpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
} as const satisfies Chain;

const config = getDefaultConfig({
  appName: 'Kletia Omni-Engine',
  projectId: 'YOUR_PROJECT_ID', 
  chains: [arcTestnet, hardhat],
  transports: {
    [arcTestnet.id]: http(),
    [hardhat.id]: http('http://127.0.0.1:8545'),
  },
  ssr: false,
});

const queryClient = new QueryClient();

import { OnchainKitProvider } from '@coinbase/onchainkit';

const cdpProjectId = import.meta.env.VITE_CDP_PROJECT_ID;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#0052FF', borderRadius: 'small' })}>
          <OnchainKitProvider apiKey={cdpProjectId} chain={arcTestnet}>
            <App />
          </OnchainKitProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);