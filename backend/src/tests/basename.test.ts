import { describe, it, expect, vi } from 'vitest';
import { handleBaseName } from '../intent/basename.js';

// Mock publicClient for viem
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation((args: any) => {
            if (args.functionName === 'available') {
                return Promise.resolve(args.args[0] === 'kletiafree'); 
            }
            if (args.functionName === 'registerPrice') {
                return Promise.resolve(5000000000000000n); // 0.005 ETH
            }
            if (args.functionName === 'addr') {
                return Promise.resolve("0x1234567890123456789012345678901234567890"); // resolved BNS address
            }
            return Promise.resolve(0n);
        })
    }
}));

describe('Base Name Service (BNS) Integration', () => {
    const mockUser = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

    it('should generate register route for a new base name', async () => {
        const intent = { action: 'basename_register', tokenIn: 'kletiafree', durationInDays: 365, isComplete: true };
        const result = await handleBaseName(intent as any, mockUser);
        
        expect(result.status).toBe('success');
        expect(result.targetContract).toBeDefined();
        expect(result.calldata).toBeDefined();
        expect(result.expectedOutput).toContain('kletiafree.base.eth');
        expect(result.value).not.toBe("0"); // registration costs ETH
    });

    it('should generate renew route for an existing base name', async () => {
        const intent = { action: 'basename_renew', tokenIn: 'kletiataken', durationInDays: 730, isComplete: true };
        const result = await handleBaseName(intent as any, mockUser);
        
        expect(result.status).toBe('success');
        expect(result.targetContract).toBeDefined();
        expect(result.calldata).toBeDefined();
        expect(result.expectedOutput).toContain('kletiataken.base.eth');
        expect(result.value).not.toBe("0"); 
    });

    it('should handle BNS resolution inside engine (indirectly testable via engine bypass)', async () => {
        // Just verify our namehash works with viem
        const { resolveBasename } = await import('../intent/utils.js');
        const resolved = await resolveBasename("kletiatest.base.eth");
        expect(resolved).toBe("0x1234567890123456789012345678901234567890");
    });
});
