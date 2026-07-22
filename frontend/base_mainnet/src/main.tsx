import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import '@rainbow-me/rainbowkit/styles.css';
import { getDefaultConfig, RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

import { http } from 'wagmi';

import { base } from 'viem/chains';
import { hardhat } from 'viem/chains';



const config = getDefaultConfig({
  appName: 'Kletia Omni-Engine',
  projectId: 'YOUR_PROJECT_ID', // WalletConnect ID (Can be left empty for test)
  chains: [base, hardhat],
  transports: {
    [base.id]: http(),
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
          <OnchainKitProvider apiKey={cdpProjectId} chain={base}>
            <App />
          </OnchainKitProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);