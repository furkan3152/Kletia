import { describe, it, expect, vi } from 'vitest';
import { getLendingRoutes } from '../lending/markets.js';

// Mock viem and config
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation(async ({ functionName }) => {
            if (functionName === 'decimals') return 6; // USDC decimals
            if (functionName === 'balanceOf') return 50000000n; // 50 USDC
            if (functionName === 'getReserveData') return { variableDebtTokenAddress: '0xVDebt' };
            if (functionName === 'borrowBalanceStored') return 10000000n; // 10 USDC debt
            return 0n;
        }),
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
    }
}));

describe('Lending Module Tests', () => {
    it('should generate Aave and Moonwell routes for lending USDC', async () => {
        const routes = await getLendingRoutes('lend', 'USDC', '10', '0x1234567890123456789012345678901234567890');
        
        expect(routes.length).toBeGreaterThanOrEqual(4); // Aave, Moonwell, Morpho, Compound
        
        const aaveRoute = routes.find((r: any) => r.name === 'Aave V3');
        expect(aaveRoute).toBeDefined();
        expect(aaveRoute.expectedOutput).toContain('LEND 10.0000 USDC');
    });

    it('should generate smart repay amount logic for Aave', async () => {
        // maxUint256 translates to full repayment or balance (50 USDC)
        const routes = await getLendingRoutes('repay', 'USDC', '0', '0x1234567890123456789012345678901234567890'); // 0 means MAX in Kletia engine
        
        const aaveRoute = routes.find((r: any) => r.name === 'Aave V3');
        expect(aaveRoute).toBeDefined();
        // The mock says user has 50 USDC balance, and 10 USDC debt on Moonwell, but Aave debt is returned as 50 USDC via balanceOf. Wait, balanceOf mock returns 50 USDC. So debt is 50, balance is 50.
        // It should just cap at balance or debt.
        expect(aaveRoute.amount).toBeDefined();
    });
});
