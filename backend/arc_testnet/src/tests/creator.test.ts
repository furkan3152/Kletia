import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeKletiaEngine } from '../intent/engine.js';
import { ROUTERS } from '../config/constants.js';
import { getAddress } from 'viem';

// Mocks
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockResolvedValue(18n),
        getBalance: vi.fn().mockResolvedValue(100000000000000000000n), // 100 ETH
        call: vi.fn().mockResolvedValue({ data: '0x' }) // xRaySimulate
    }
}));

describe('Kletia Creator Engine Tests', () => {

    const userAddress = '0x1234567890123456789012345678901234567890';

    it('should handle deploy_token successfully', async () => {
        const intent: any = {
            action: 'deploy_token',
            name: 'Kletia Coin',
            symbol: 'KLT',
            amount: '1000000'
        };

        const result = await executeKletiaEngine(intent, userAddress);

        expect(result.actionType).toBe('deploy_token');
        expect(result.targetContract).toBe(ROUTERS.KLETIA_TOKEN_FACTORY);
        expect(result.calldata).toBeDefined();
        expect(result.value).toBe(0n);
        expect(result.summary).toContain('Kletia Coin');
        expect(result.summary).toContain('KLT');
        expect(result.summary.match(/1[,.]000[,.]000/)).toBeTruthy();
    });

    it('should throw error on deploy_token without name or symbol', async () => {
        const intent: any = {
            action: 'deploy_token',
            amount: '1000000'
        };

        await expect(executeKletiaEngine(intent, userAddress)).rejects.toThrow("Token oluşturmak için bir isim (name) ve sembol (symbol) belirtmelisin");
    });

    it('should handle mint_nft successfully', async () => {
        const targetCollection = '0xabc123abc123abc123abc123abc123abc123abc1';
        const intent: any = {
            action: 'mint_nft',
            tokenIn: targetCollection,
            amount: '2'
        };

        const result = await executeKletiaEngine(intent, userAddress);

        expect(result.actionType).toBe('mint_nft');
        expect(result.targetContract).toBe(getAddress(targetCollection));
        expect(result.calldata).toBeDefined();
        // 2 * 0.000777 ETH = 0.001554 ETH
        expect(result.value.toString()).toBe('1554000000000000'); 
        expect(result.summary).toContain('2 adet NFT');
    });

    it('should throw error on mint_nft with invalid address', async () => {
        const intent: any = {
            action: 'mint_nft',
            tokenIn: 'invalid-address',
            amount: '2'
        };

        await expect(executeKletiaEngine(intent, userAddress)).rejects.toThrow("Geçerli bir NFT kontrat adresi girmelisin (0x...).");
    });
});
