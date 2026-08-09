
import { createPublicClient, http, defineChain } from 'viem';
import * as dotenv from 'dotenv';
dotenv.config();

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Native USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.drpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

const rpcUrl = process.env.ARC_RPC_URL || 'https://rpc.drpc.testnet.arc.io';

export const publicClient = createPublicClient({ 
  chain: arcTestnet, 
  transport: http(rpcUrl),
  batch: {
    multicall: true,
  }
});