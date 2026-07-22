// backend/src/config/client.ts
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const cdpNodeKey = process.env.CDP_NODE_API_KEY;
const rpcUrl = cdpNodeKey ? `https://api.developer.coinbase.com/rpc/v1/base/${cdpNodeKey}` : 'https://mainnet.base.org';

export const publicClient = createPublicClient({ 
  chain: base, 
  transport: http(rpcUrl),
  // ✨ BAŞ MİMAR DOKUNUŞU: İşlemleri tek pakette birleştirip Alchemy kredilerini korur ve hızı uçurur!
  batch: {
    multicall: true,
  }
});