import { describe, it, expect, vi } from 'vitest';
import { executeKletiaEngine } from '../src/intent/engine.js';
import type { ParsedIntent } from '../src/ai/parser.js';

// Mock dependencies
vi.mock('../src/config/client.js', () => ({
    publicClient: {
        readContract: vi.fn().mockResolvedValue(18),
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
        call: vi.fn().mockResolvedValue({}),
    }
}));

describe('Kletia Engine (Unit Tests)', () => {
    it('should correctly bypass chat intents', async () => {
        const intent: ParsedIntent = {
            isComplete: false,
            action: 'chat',
            message: 'Hello!',
            targetContract: '',
            calldata: ''
        };
        
        const result = await executeKletiaEngine(intent, '0x1234567890123456789012345678901234567890');
        expect(result.status).toBe('question');
        expect(result.message).toBe('Hello!');
    });

    it('should throw an error for missing token in swap', async () => {
        const intent: ParsedIntent = {
            isComplete: true,
            action: 'swap',
            message: 'Swap ETH to USDC',
            targetContract: '',
            calldata: ''
            // tokenIn is missing
        };
        
        await expect(executeKletiaEngine(intent, '0x1234567890123456789012345678901234567890')).rejects.toThrow('🚨 Target token could not be determined.');
    });
});
