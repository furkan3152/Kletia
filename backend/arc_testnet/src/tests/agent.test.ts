import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { agentRoutes } from '../agent/index.js';
import * as fs from 'fs';

// Mock process.env for CDP
process.env.CDP_API_KEY_NAME = 'mock-key-name';
process.env.CDP_API_KEY_PRIVATE_KEY = 'mock-private-key';

// Mocks
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs') as any;
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue('mocked-wallet-data'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn()
    };
});

vi.mock('@coinbase/agentkit', () => {
    return {
        AgentKit: {
            from: vi.fn().mockResolvedValue({})
        },
        CdpEvmWalletProvider: {
            configureWithWallet: vi.fn().mockResolvedValue({
                exportWallet: vi.fn().mockResolvedValue('mocked-wallet-data'),
                getAddress: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
                sendTransaction: vi.fn().mockResolvedValue('0xTxHash123')
            })
        },
        walletActionProvider: vi.fn(),
        erc20ActionProvider: vi.fn(),
        erc721ActionProvider: vi.fn(),
        wethActionProvider: vi.fn(),
        morphoActionProvider: vi.fn(),
        compoundActionProvider: vi.fn(),
        pythActionProvider: vi.fn(),
        defillamaActionProvider: vi.fn(),
        alloraActionProvider: vi.fn(),
        basenameActionProvider: vi.fn(),
        wowActionProvider: vi.fn(),
        flaunchActionProvider: vi.fn(),
        yelayActionProvider: vi.fn(),
        sushiRouterActionProvider: vi.fn(),
        moonwellActionProvider: vi.fn(),
        clankerActionProvider: vi.fn(),
        ensoActionProvider: vi.fn(),
        superfluidActionProvider: vi.fn(),
        acrossActionProvider: vi.fn(),
        zoraActionProvider: vi.fn(),
        cdpApiActionProvider: vi.fn(),
        cdpEvmWalletActionProvider: vi.fn(),
        customActionProvider: vi.fn()
    };
});

vi.mock('@coinbase/agentkit-langchain', () => ({
    getLangChainTools: vi.fn().mockResolvedValue([])
}));

vi.mock('@langchain/openai', () => ({
    ChatOpenAI: class { constructor() {} }
}));

vi.mock('@langchain/langgraph', () => ({
    MemorySaver: class { constructor() {} }
}));

vi.mock('@langchain/mcp-adapters', () => ({
    MultiServerMCPClient: class {
        getTools() { return []; }
    }
}));

vi.mock('@langchain/langgraph/prebuilt', () => ({
    createReactAgent: vi.fn().mockImplementation(() => ({
        stream: async function* () {
            yield { agent: { messages: [{ content: 'Mock AI Response' }] } };
        }
    }))
}));

vi.mock('../agent/tools/x402Tool.js', () => ({
    getX402Tool: vi.fn().mockResolvedValue({})
}));

vi.mock('../config/client.js', () => ({
    publicClient: {
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
        readContract: vi.fn().mockResolvedValue(0n),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({})
    }
}));

vi.mock('viem', async () => {
    const actual = await vi.importActual('viem') as any;
    return {
        ...actual,
        createPublicClient: vi.fn().mockReturnValue({
            getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
            readContract: vi.fn().mockResolvedValue(50000000n),
            waitForTransactionReceipt: vi.fn().mockResolvedValue({})
        })
    };
});

// Setup express app
const app = express();
app.use(express.json());
app.use('/agent', agentRoutes);

describe('Agent API and Vault Tests', () => {

    it('should return 403 on export vault route', async () => {
        const response = await request(app).get('/agent/vault/export');
        expect(response.status).toBe(403);
        expect(response.body.error).toContain('Güvenlik nedeniyle kasa private key dışa aktarımı devre dışı bırakılmıştır');
    });

    it('should initialize agent and return vault address', async () => {
        const response = await request(app).get('/agent/vault?userAddress=0xUser123');
        expect(response.status).toBe(200);
        expect(response.body.address).toBe('0x1111111111111111111111111111111111111111');
    });

    it('should deduct fee and return chat response', async () => {
        const response = await request(app)
            .post('/agent/chat')
            .send({ prompt: 'Hello agent', userAddress: '0xUser123' });
        
        expect(response.status).toBe(200);
        expect(response.text).toContain('event: done');
        expect(response.text).toContain('Mock AI Response');
    });

    it('should return native and USDC balances', async () => {
        const response = await request(app).get('/agent/vault/balance?userAddress=0xUser123');
        
        expect(response.status).toBe(200);
        expect(response.body.address).toBe('0x1111111111111111111111111111111111111111');
        expect(response.body.balances.ETH).toBeDefined();
        expect(response.body.balances.USDC).toBeDefined();
    });

    it('should process withdraw requests successfully', async () => {
        const response = await request(app)
            .post('/agent/vault/withdraw')
            .send({ userAddress: '0xUser123', amount: '0.1', asset: 'ETH' });
            
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.txHash).toBe('0xTxHash123');
    });
});
