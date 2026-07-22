export type NetworkMode = 'base' | 'arc';

export const NETWORKS = {
  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    color: '#0052FF',
    icon: '🔵',
    isTestnet: false,
  },
  arc: {
    name: 'ARC Testnet',
    chainId: 5042002,
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.network',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    klet: '0xa564b7dad27bCc65895e7dc5F3fBd1eCfc8fC6b3',
    color: '#3E74BB',
    icon: '🌀',
    isTestnet: true,
    // ARC-specific contract addresses (to be filled after deployment)
    contracts: {
      swap: '',
      vault: '',
      memoTransfer: '',
      batchPay: '',
      agentRegistry: '',
      jobMarket: '',
    },
  },
} as const;

export const getNetwork = (mode: NetworkMode) => NETWORKS[mode];
export const getApiPrefix = (mode: NetworkMode) => mode === 'arc' ? '/api/arc' : '/api';
