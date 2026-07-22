import { describe, it, expect } from 'vitest';
import { KletiaErrorTracker } from '../ai/errorEngine.js';

describe('Error Engine (KEE) Tests', () => {
    it('should analyze Allowance/Approval error correctly', () => {
        const error = { message: 'transfer amount exceeds allowance' };
        const result = KletiaErrorTracker.analyzeError(error, 'swap');
        
        expect(result.category).toBe('ALLOWANCE');
        expect(result.aiHint).toContain('Approve');
    });

    it('should analyze Insufficient Balance error correctly', () => {
        const error = { message: 'insufficient funds' };
        const result = KletiaErrorTracker.analyzeError(error, 'lend');
        
        expect(result.category).toBe('INSUFFICIENT_FUNDS');
        expect(result.aiHint).toContain('insufficient');
    });

    it('should analyze Slippage error correctly', () => {
        const error = { message: 'insufficient output amount' };
        const result = KletiaErrorTracker.analyzeError(error, 'swap');
        
        expect(result.category).toBe('SLIPPAGE');
        expect(result.aiHint.toLowerCase()).toContain('slippage');
    });

    it('should fallback to Unknown error for weird errors', () => {
        const error = { message: 'Some weird block error' };
        const result = KletiaErrorTracker.analyzeError(error, 'stake');
        
        expect(result.category).toBe('UNKNOWN_REVERT');
    });
});
