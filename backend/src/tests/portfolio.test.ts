import { describe, it, expect, vi } from 'vitest';
import { getPortfolio } from '../portfolio/viewer.js';

// Mock viem and fetch
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockResolvedValue(0n),
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
    }
}));

global.fetch = vi.fn().mockImplementation(async (url) => {
    if (url.includes('alchemy_getTokenBalances')) {
        return {
            json: async () => ({
                result: {
                    tokenBalances: [
                        { contractAddress: '0xUSDC', tokenBalance: '0x05f5e100' } // 100 USDC
                    ]
                }
            })
        };
    }
    if (url.includes('dexscreener')) {
        return {
            json: async () => ({
                pairs: [
                    { baseToken: { address: '0x4200000000000000000000000000000000000006' }, priceUsd: '3000' }
                ]
            })
        };
    }
    return { json: async () => ({}) };
});

describe('Portfolio Module Tests', () => {
    it('should generate a comprehensive portfolio overview', async () => {
        const result = await getPortfolio('0x1234567890123456789012345678901234567890');
        
        expect(result.status).toBe('success');
        expect(result.action).toBe('portfolio');
        expect(result.data.wallet.find((t: any) => t.symbol === 'ETH')).toBeDefined();
        expect(result.data.summary.totalNetWorthUSD).toBeDefined();
    });
});
