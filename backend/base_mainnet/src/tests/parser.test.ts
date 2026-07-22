import { describe, it, expect, vi } from 'vitest';
import { parseUserIntent, explainKletiaError } from '../ai/parser.js';

// Mocking fetch for testing API calls without real network requests
global.fetch = vi.fn();

describe('AI Parser & Engine Tests', () => {
    
    it('should correctly explain a Web3 error to the user', async () => {
        const mockResponse = {
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'İşlem yetersiz bakiye nedeniyle iptal edildi dostum.' } }]
            })
        };
        (global.fetch as any).mockResolvedValueOnce(mockResponse);

        const explanation = await explainKletiaError('Paramı swap yap', 'insufficient funds for gas * price + value');
        expect(explanation).toBe('İşlem yetersiz bakiye nedeniyle iptal edildi dostum.');
        expect(global.fetch).toHaveBeenCalled();
    });

    it('should correctly parse user intent for swap', async () => {
        const mockResponse = {
            ok: true,
            json: async () => ({
                choices: [{ 
                    message: { 
                        content: '{"action":"swap", "isComplete":true, "message":"Aero ile takas ediyorum.", "amount":"100"}' 
                    } 
                }]
            })
        };
        (global.fetch as any).mockResolvedValueOnce(mockResponse);

        const intent = await parseUserIntent('100 USDC ile AERO al');
        expect(intent.action).toBe('swap');
        expect(intent.isComplete).toBe(true);
        expect(intent.amount).toBe('100');
    });

    it('should ask a question if intent is not complete', async () => {
        const mockResponse = {
            ok: true,
            json: async () => ({
                choices: [{ 
                    message: { 
                        content: '{"action":"swap", "isComplete":false, "message":"Hangi tokeni almak istersin?"}' 
                    } 
                }]
            })
        };
        (global.fetch as any).mockResolvedValueOnce(mockResponse);

        const intent = await parseUserIntent('Bana biraz kripto al');
        expect(intent.isComplete).toBe(false);
        expect(intent.message).toBe('Hangi tokeni almak istersin?');
    });

});
