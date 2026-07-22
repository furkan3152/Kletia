import { describe, it, expect, vi } from 'vitest';
import { getAerodromeRoutes } from '../dex/aerodrome.js';

// Mock viem and config
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation(async ({ functionName }) => {
            if (functionName === 'getAmountsOut') {
                return [1000000000000000000n, 2000000000000000000n]; // mock 1 ETH -> 2 AERO
            }
            if (functionName === 'quoteExactInputSingle') {
                return [2500000000000000000n]; // mock V3 route
            }
            throw new Error('Not mocked');
        }),
    }
}));

describe('DEX Module Tests', () => {
    it('should generate Aerodrome V1 and Slipstream routes', async () => {
        const routes = await getAerodromeRoutes(
            1000000000000000000n,
            '0x4200000000000000000000000000000000000006',
            '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
            'WETH',
            'AERO',
            false,
            '0x1234567890123456789012345678901234567890',
            1000000000n,
            18
        );
        
        expect(routes.length).toBe(2);
        
        expect(routes[0].name).toBe('Aerodrome V1');
        expect(routes[0].amountOut).toBe(2000000000000000000n);
        expect(routes[0].expectedOutput).toBe('2');
        
        expect(routes[1].name).toBe('Aerodrome Slipstream');
        expect(routes[1].amountOut).toBe(2500000000000000000n);
        expect(routes[1].expectedOutput).toBe('2.5');
    });
});
