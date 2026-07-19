import { describe, it, expect, vi } from 'vitest';
import { getLiquidityRoutes } from '../dex/liquidity.js';

// Mock viem and publicClient
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation((args: any) => {
            if (args.functionName === 'decimals') return Promise.resolve(18);
            if (args.functionName === 'balanceOf') return Promise.resolve(10000000000000000000n);
            if (args.functionName === 'getAmountsOut') return Promise.resolve([1000000000000000000n, 1000000000000000000n]);
            if (args.functionName === 'getPair' || args.functionName === 'getPool') return Promise.resolve("0x1111111111111111111111111111111111111111");
            if (args.functionName === 'totalSupply') return Promise.resolve(1000000000000000000n);
            if (args.functionName === 'getReserves') return Promise.resolve([500000000000000000n, 500000000000000000n, 0]);
            return Promise.resolve(0n);
        })
    }
}));

describe('Liquidity Module Tests', () => {
    const mockUser = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

    it('should generate add_liquidity route for Aerodrome', async () => {
        const routes = await getLiquidityRoutes('add_liquidity', 'AERO', 'USDC', '10', mockUser);
        
        expect(routes.length).toBeGreaterThan(0);
        expect(routes[0].name).toContain('Aerodrome');
        expect(routes[0].calldata).toBeDefined();
        expect(routes[0].router).toBeDefined();
    });

    it('should generate remove_liquidity route for Aerodrome', async () => {
        const routes = await getLiquidityRoutes('remove_liquidity', 'AERO', 'USDC', 'MAX', mockUser);
        
        expect(routes.length).toBeGreaterThan(0);
        expect(routes[0].name).toContain('Aerodrome (Remove LP)');
        expect(routes[0].calldata).toBeDefined();
        expect(routes[0].router).toBeDefined();
    });
});
