import { describe, it, expect, vi } from 'vitest';
import { getLiquidStakingRoutes } from '../staking/liquid.js';
import { getStakingRoutes } from '../staking/lockers.js';

vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation(async ({ functionName }) => {
            if (functionName === 'decimals') return 18;
            if (functionName === 'balanceOf') return 1000000000000000000000n;
            return 0n;
        }),
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
    }
}));

describe('Staking Module Tests', () => {
    it('should generate Liquid Staking routes for ETH', async () => {
        const routes = await getLiquidStakingRoutes('liquid_stake', 'ETH', '0.5', '0x1234567890123456789012345678901234567890');
        
        expect(routes.length).toBeGreaterThanOrEqual(3); // wstETH, cbETH, rETH
        expect(routes[0].name).toBe('Lido (wstETH)');
        expect(routes[1].name).toBe('Coinbase (cbETH)');
        expect(routes[2].name).toBe('Rocket Pool (rETH)');
    });

    it('should generate veAERO lock route for AERO', async () => {
        const routes = await getStakingRoutes('AERO', '100', 30, '0x1234567890123456789012345678901234567890');
        
        expect(routes.length).toBeGreaterThanOrEqual(1);
        expect(routes[0].name).toContain('Aerodrome Finance');
    });
});
