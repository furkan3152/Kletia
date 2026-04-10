// backend/src/config/client.ts
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

export const publicClient = createPublicClient({ 
  chain: base, 
  transport: http(alchemyUrl),
  // ✨ BAŞ MİMAR DOKUNUŞU: İşlemleri tek pakette birleştirip Alchemy kredilerini korur ve hızı uçurur!
  batch: {
    multicall: true,
  }
});