import { executeKletiaEngine } from '../intent/engine.js';
import { parseUserIntent } from '../ai/parser.js';

// Mock the openrouter fetch to simulate AI parsing a bridge command
global.fetch = vi.fn((url: string) => {
    if (url.includes('openrouter')) {
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            isComplete: true,
                            action: "bridge",
                            tokenIn: "USDC",
                            amount: "100",
                            destinationChain: "arbitrum",
                            message: "100 USDC'yi Arbitrum ağına köprülüyorum."
                        })
                    }
                }]
            })
        });
    }

    if (url.includes('across.to')) {
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                spokePoolAddress: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
                timestamp: "1710000000",
                totalRelayFee: { total: "100000" }, // small fee
                exclusiveRelayer: "0x0000000000000000000000000000000000000000",
                exclusivityDeadline: 0
            })
        });
    }

    // Goplus mock
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: {} })
    });
}) as any;

// Mock publicClient reads
vi.mock('../config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockImplementation((args: any) => {
            if (args.functionName === 'decimals') return Promise.resolve(6);
            if (args.functionName === 'balanceOf') return Promise.resolve(1000000000000000000n);
            return Promise.resolve(0n);
        }),
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
        call: vi.fn().mockResolvedValue("0x")
    }
}));

import { describe, it, expect, vi } from 'vitest';

describe('Bridge Integration via KletiaSmartRouter', () => {
    it('should parse a bridge command and wrap it with KletiaSmartRouter', async () => {
        const { executeKletiaEngine } = await import('../intent/engine.js');
        const intent = await parseUserIntent("100 USDC'yi arbitruma köprüle");
        
        expect(intent.action).toBe('bridge');
        expect(intent.destinationChain).toBe('arbitrum');

        const mockUser = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
        const result = await executeKletiaEngine(intent, mockUser, "100 USDC'yi arbitruma köprüle");

        // Verify that the target contract is the Kletia Smart Router Address, NOT the Across SpokePool!
        expect(result.targetContract).toBe("0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf");
        expect(result.expectedOutput).toContain("Includes %0.1 Kletia Fee");
    }, 15000);
});
