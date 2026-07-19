import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseUserIntent } from './parser.js';

describe('AI Intent Parser (Niyet Anlama Testleri)', () => {
    beforeEach(() => {
        process.env.OPENROUTER_API_KEY = "mock_key";
        global.fetch = vi.fn() as any;
    });

    const mockApiResponse = (action: string, overrides: any = {}) => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                isComplete: true,
                                action,
                                message: "Mocked AI Response",
                                ...overrides
                            })
                        }
                    }
                ]
            })
        });
    };

    it('should correctly parse arc_lending_deposit', async () => {
        mockApiResponse('arc_lending_deposit', { tokenIn: 'KLET', amount: '500' });
        
        const result = await parseUserIntent('Arc lending protokolüne 500 KLET teminat ekle');
        
        expect(result.action).toBe('arc_lending_deposit');
        expect(result.amount).toBe('500');
        expect(result.tokenIn).toBe('KLET');
    });

    it('should correctly parse arc_lending_borrow', async () => {
        mockApiResponse('arc_lending_borrow', { tokenIn: 'USDC', amount: '50' });
        
        const result = await parseUserIntent('Arc üzerinden 50 USDC borç al');
        
        expect(result.action).toBe('arc_lending_borrow');
        expect(result.amount).toBe('50');
    });
    
    it('should correctly parse generic borrow intent and infer protocol', async () => {
        mockApiResponse('borrow', { tokenIn: 'USDC', amount: '10', protocol: 'aave' });
        
        const result = await parseUserIntent('Aave üzerinden 10 USDC borç al');
        
        expect(result.action).toBe('borrow');
        expect(result.amount).toBe('10');
        expect(result.protocol).toBe('aave');
    });

    it('should correctly prioritize BNS renewal with conversation history', async () => {
        const history = [{ role: 'assistant', content: 'Hangi ismin süresini uzatmak istiyorsun?' }];
        mockApiResponse('basename_renew', { tokenIn: 'kopil', durationInDays: 365 });
        
        const result = await parseUserIntent('kopil.base.eth', history);
        
        expect(result.action).toBe('basename_renew');
        expect(result.tokenIn).toBe('kopil');
    });
});
