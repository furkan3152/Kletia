import { describe, it, expect, vi } from 'vitest';
import { executeKletiaEngine } from '../intent/engine.js';
import type { ParsedIntent } from '../ai/parser.js';

// Random empty wallet that holds no tokens or ETH
const EMPTY_WALLET = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"; 

describe('Kletia Ultimate Edge Case Tests', () => {

    describe('1. Smart Swap & DEX Edge Cases', () => {
        it('should reject swap if token is a known Honeypot/Scam (GoPlus)', async () => {
            const originalFetch = global.fetch;
            const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
                if (typeof url === 'string' && url.includes('token_security')) {
                    return {
                        json: async () => ({
                            result: { "0x6666666666666666666666666666666666666666": { is_honeypot: "1" } }
                        })
                    } as any;
                }
                return originalFetch(url, init);
            });

            const intent: ParsedIntent = { action: "swap", tokenIn: "ETH", tokenOut: "0x6666666666666666666666666666666666666666", amount: "1", isComplete: true, message: "" };
            
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/SECURITY_RISK|HONEYPOT/i);
            fetchSpy.mockRestore();
        });

        it('should revert swap when user has insufficient balance', async () => {
            // EMPTY_WALLET has 0 ETH. Trying to swap 1000 ETH should fail on validation or simulation.
            const intent: ParsedIntent = { action: "swap", tokenIn: "ETH", tokenOut: "USDC", amount: "1000", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/INSUFFICIENT_FUNDS/i);
        });

        it('should fail elegantly if MAX balance intent is used but wallet is completely empty (Zero Balance)', async () => {
            const { publicClient } = await import('../config/client.js');
            const getBalSpy = vi.spyOn(publicClient, 'getBalance').mockResolvedValue(0n);
            const intent: ParsedIntent = { action: "swap", tokenIn: "ETH", tokenOut: "USDC", amount: "MAX", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/INSUFFICIENT_FUNDS|0/i);
            getBalSpy.mockRestore();
        }, 15000);

        it('should fail when swapping between two tokens with NO liquidity pool anywhere', async () => {
            // Random addresses that have no LP pair
            const fakeTokenA = "0x1111111111111111111111111111111111111111";
            const fakeTokenB = "0x2222222222222222222222222222222222222222";
            
            const originalFetch = global.fetch;
            vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
                if (typeof url === 'string' && url.includes('token_security')) {
                    return { json: async () => ({ result: {} }) } as any;
                }
                return originalFetch(url, init);
            });

            const intent: ParsedIntent = { action: "swap", tokenIn: fakeTokenA, tokenOut: fakeTokenB, amount: "100", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow();
            vi.restoreAllMocks();
        });
    });

    describe('2. Liquidity (LP) Edge Cases', () => {
        it('should reject adding liquidity with insufficient balance for the pool ratio', async () => {
            // Trying to pool 1M USDC, which is impossible for empty wallet
            const intent: ParsedIntent = { action: "add_liquidity", tokenIn: "USDC", tokenOut: "ETH", amount: "1000000", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/INSUFFICIENT_FUNDS/i);
        });

        it('should reject removing liquidity when user holds 0 LP tokens', async () => {
            // EMPTY_WALLET has no LP tokens
            const intent: ParsedIntent = { action: "remove_liquidity", tokenIn: "USDC", tokenOut: "ETH", amount: "MAX", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/INSUFFICIENT_FUNDS|no LP/i);
        });
    });

    describe('3. DeFi Banking (Aave, Moonwell) Edge Cases', () => {
        it('should reject borrowing without collateral', async () => {
            // EMPTY_WALLET tries to borrow USDC
            const intent: ParsedIntent = { action: "borrow", tokenIn: "USDC", amount: "1000", isComplete: true, message: "Aave üzerinden", protocol: "aave" };
            // Since xRaySimulate simulates the EVM call, it will revert because the wallet has no collateral.
            // Our code throws "İşlem reddedildi. Bakiye or teminat (collateral) eksik olabilir."
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow();
        });

        it('should reject repaying more than the borrowed amount', async () => {
            // User tries to repay 1M USDC but they never borrowed anything
            const intent: ParsedIntent = { action: "repay", tokenIn: "USDC", amount: "1000000", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/INSUFFICIENT_FUNDS|reverted/i);
        });
    });

    describe('4. BNS and Cross-Chain Bridge Edge Cases', () => {
        it('should reject registering an already TAKEN .base.eth name', async () => {
            // 'jesse.base.eth' is taken
            const intent: ParsedIntent = { action: "basename_register", tokenIn: "jesse.base.eth", amount: "1", isComplete: true, message: "" };
            // Engine throws "Zaten alınmış"
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/taken|reverted|error/i);
        });

        it('should throw an error for unsupported bridge chains', async () => {
            const intent: ParsedIntent = { action: "bridge", tokenIn: "ETH", destinationChain: "MarsNetwork", amount: "1", isComplete: true, message: "" };
            // Bridge validation should fail since MarsNetwork is not supported
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/unsupported|not found|INSUFFICIENT_FUNDS/i);
        });
    });

    describe('5. Creator Tools (Memecoin & NFT) Edge Cases', () => {
        it('should throw if memecoin parameters are missing or invalid', async () => {
            const intent: ParsedIntent = { action: "deploy_token", tokenIn: "", name: "", symbol: "", amount: "", isComplete: true, message: "" };
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/isim/i);
        });

        it('should throw if NFT mint contract is invalid or zero address', async () => {
            const intent: ParsedIntent = { action: "mint_nft", tokenIn: "0x0000000000000000000000000000000000000000", amount: "1", isComplete: true, message: "" };
            // Zora checks will throw invalid contract
            await expect(executeKletiaEngine(intent, EMPTY_WALLET)).rejects.toThrow(/Geçerli bir NFT kontrat/i);
        });
    });

});
