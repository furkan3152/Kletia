import express from 'express';
import {
    AgentKit, ViemWalletProvider,
    // Core
    walletActionProvider,
    // Token
    erc20ActionProvider, erc721ActionProvider, wethActionProvider,
    // DeFi & Swap
    morphoActionProvider, compoundActionProvider,
    // Data & Oracle
    pythActionProvider, defillamaActionProvider, alloraActionProvider,
    // Base Naming
    basenameActionProvider,
    // Memecoin / Social Token
    wowActionProvider, flaunchActionProvider,
    // Yield
    yelayActionProvider,
    // Swap
    sushiRouterActionProvider,
    // Lending, Routing, Deployment & Streams
    moonwellActionProvider,
    clankerActionProvider,
    ensoActionProvider,
    superfluidActionProvider,
    acrossActionProvider,
    zoraActionProvider,
    cdpApiActionProvider,
    cdpEvmWalletActionProvider,
} from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import * as fs from 'fs';
import { publicClient } from '../config/client.js';
import * as path from 'path';
import { customActionProvider } from '@coinbase/agentkit';
import { z } from 'zod';
import { getX402Tool } from './tools/x402Tool.js';
import { webacyActionProvider } from './tools/webacyActionProvider.js';
import { KletiaVaultProvider } from './KletiaVaultProvider.js';
import { createPublicClient, http, parseAbi, encodeFunctionData, createWalletClient, getAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { CdpEvmWalletProvider } from '@coinbase/agentkit';

const USDC_CONTRACT_ADDRESSES: Record<string, `0x${string}`> = {
    "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
};

const erc20Abi = parseAbi([
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)'
]);

const router = express.Router();

const WALLETS_DIR = path.join(process.cwd(), "wallets");
if (!fs.existsSync(WALLETS_DIR)) {
    fs.mkdirSync(WALLETS_DIR, { recursive: true });
}

// In-memory cache for active agents
interface AgentInstance {
    agentkit: AgentKit;
    agent: any;
    walletProvider: any;
    config: any;
}
const activeAgents = new Map<string, AgentInstance>();



export async function getOrCreateAgent(userAddress: string): Promise<AgentInstance | null> {
    if (!process.env.CDP_API_KEY_NAME || !process.env.CDP_API_KEY_PRIVATE_KEY) {
        console.warn("⚠️ CDP API Keys not found. Agent mode will be disabled.");
        return null;
    }

    if (activeAgents.has(userAddress)) {
        return activeAgents.get(userAddress)!;
    }

    try {
        const walletFile = path.join(WALLETS_DIR, `${userAddress}_cdp_wallet.txt`);
        let cdpWalletDataStr: string | undefined = undefined;
        let savedAddress: string | undefined = undefined;

        if (fs.existsSync(walletFile)) {
            cdpWalletDataStr = fs.readFileSync(walletFile, 'utf8');
            try {
                const parsed = JSON.parse(cdpWalletDataStr);
                if (parsed.address) savedAddress = parsed.address;
            } catch (e) {
                console.warn(`⚠️ Autonomous wallet file corrupted: ${walletFile}`);
            }
        }

        const config: any = {
            apiKeyName: process.env.CDP_API_KEY_NAME,
            apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            networkId: "base-mainnet"
        };
        
        if (cdpWalletDataStr) {
            config.cdpWalletData = cdpWalletDataStr;
        }

        const walletProvider = await CdpEvmWalletProvider.configureWithWallet(config);

        // Save wallet state explicitly so it's always preserved
        const exportedWallet = await walletProvider.exportWallet();
        const exportedStr = typeof exportedWallet === "string" ? exportedWallet : JSON.stringify(exportedWallet);
        fs.writeFileSync(walletFile, exportedStr);

        const customX402Tool = await getX402Tool(walletProvider as any);

        const agentkit = await AgentKit.from({
            walletProvider,
            actionProviders: [
                // Core wallet
                walletActionProvider(),

                // Token operations
                erc20ActionProvider(),
                erc721ActionProvider(),
                wethActionProvider(),

                // DeFi & Swap
                morphoActionProvider(),
                compoundActionProvider(),
                sushiRouterActionProvider(),

                // Data, Oracle & AI Predictions
                pythActionProvider(),
                defillamaActionProvider(),
                alloraActionProvider(),

                // Base Naming Service
                basenameActionProvider(),

                // Memecoin & Social Token
                wowActionProvider(),
                flaunchActionProvider(),

                // Yield
                yelayActionProvider(),

                // Custom Protocols & Base Ecosystem
                moonwellActionProvider(),
                clankerActionProvider(),
                ensoActionProvider(),
                superfluidActionProvider(),

                // Core CDP Features
                cdpApiActionProvider({
                    apiKeyName: process.env.CDP_API_KEY_NAME,
                    apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY
                }),
                cdpEvmWalletActionProvider({
                    apiKeyName: process.env.CDP_API_KEY_NAME,
                    apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY
                }),

                // Security (Webacy DD.xyz)
                webacyActionProvider(),

                // Custom X402
                customX402Tool
            ]
        });

        const agentKitTools = await getLangChainTools(agentkit);
        
        let mcpTools: any[] = [];
        try {
            const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
            const mcpClient = new MultiServerMCPClient({
                cdpDocs: {
                    transport: "sse",
                    url: "https://docs.cdp.coinbase.com/mcp",
                }
            });
            mcpTools = await mcpClient.getTools();
            console.log("✅ MCP Tools loaded (CDP Docs)");
        } catch (mcpError) {
            console.error("⚠️ MCP Tools failed to load:", mcpError);
        }

        const tools = [...agentKitTools, ...mcpTools];
        const memory = new MemorySaver();
        const agentConfig = { 
            configurable: { thread_id: `Kletia_Agent_${userAddress}` },
            networkId: "base-mainnet" // Ensure we lock to mainnet explicitly 
        };

        const llm = new ChatOpenAI({
            model: "openai/gpt-4o-mini",
            apiKey: process.env.OPENROUTER_API_KEY,
            configuration: {
                baseURL: "https://openrouter.ai/api/v1",
            }
        });

        const agent = createReactAgent({
            llm,
            tools: tools as any,
            checkpointSaver: memory,
            messageModifier: `You are Kletia's Autonomous AI Agent. You are acting on the Base network on behalf of user ${userAddress}.
You have your own CDP-managed EVM wallet (vault). You can perform transactions directly.

YOUR CAPABILITIES:
🔹 SECURITY (Webacy / DD.xyz): Before interacting with smart contracts (Swap, Lend, Mint, etc.) or transferring to unknown addresses, you MUST perform a security check using the 'check_contract_risk' or 'check_transaction_risk' tools. If the score is higher than 50 or a warning is returned, cancel the transaction and warn the user!
🔹 WALLET: Show your address, check balance, send ETH/tokens
🔹 SWAP/TRADE: Perform token transactions using 0x or ERC20 actions.
🔹 ERC-20 TOKEN: Transfer, check balance, approve transactions
🔹 ERC-721 NFT: Mint NFT, transfer NFT
🔹 WETH: ETH↔WETH wrap/unwrap
🔹 DEFi LENDING: Lend/borrow with Morpho, Lend/borrow with Compound. (Morpho Base USDC Vault addresses: Moonwell Flagship USDC = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca, Morph USDC Vault = 0x833346d03d4924c58252277d337f90915f01C304. Use these vault addresses if the user wants to lend USDC).
🔹 BRIDGE: Cross-chain transfer with Across (Base↔Ethereum↔Arbitrum↔Optimism)
🔹 BASENAME: Register a name (basename) on the Base network
🔹 PRICE DATA: Get current prices with Pyth oracle, TVL/protocol data with DefiLlama, AI predictions with Allora
🔹 ONRAMP: Create a fiat-to-crypto purchase link
🔹 MEMECOIN: Create/buy/sell memecoins with Wow.xyz, launch tokens with Flaunch
🔹 YIELD STRATEGY: If the user requests the best return (APY) or yield farming strategy, use the 'fetch_x402_resource' tool to make an X402 payment to 'http://localhost:3001/api/premium/yield-strategy' and fetch the data.
🔹 MEV & ARBITRAGE SOLVER: If the user requests a risk-free profit, arbitrage route, or MEV transaction, use the 'fetch_x402_resource' tool to make an X402 payment (0.05 USDC) to 'http://localhost:3001/api/premium/route-solver' and fetch the route.
🔹 X402 PAYMENT: Autonomous X402 payment protocol for premium data services
🔹 SYBIL ANALYSIS (X402): If the user requests a deep Sybil Analysis (Premium Report) using data like wallet age, active days, transaction variance, use the 'fetch_x402_resource' tool to make an X402 payment (0.05 USDC) to 'http://localhost:3001/api/premium/sybil-report?address=<TARGET_WALLET_ADDRESS>' and summarize the resulting JSON report clearly to the user.
🔹 MCP (Model Context Protocol): You can gather information using tools coming through MCP for CDP documentation and external integrations. Use MCP tools especially for questions like "How to do ... in Coinbase docs".

RULES:
- When the user requests a swap, use the appropriate functions.
- If the user asks for your address, give your wallet address.
- Use the 'fetch_x402_resource' tool for Premium data or alpha signals ('http://localhost:3001/api/premium/alpha-signals').
- Use the 'fetch_x402_resource' tool for Yield strategies ('http://localhost:3001/api/premium/yield-strategy').
- Use the 'fetch_x402_resource' tool for Arbitrage routes or risk-free profit opportunities ('http://localhost:3001/api/premium/route-solver').
- Use the 'fetch_x402_resource' tool for Advanced Sybil or X402 Premium Analysis ('http://localhost:3001/api/premium/sybil-report?address=...').
- Always reply in English.
- Be concise and helpful.
- Explain to the user what you will do before making a transaction.`
        });

        console.log(`🤖 User ${userAddress} agent started! Vault Wallet: ${await walletProvider.getAddress()}`);

        const instance = { agentkit, agent, walletProvider, config: agentConfig };
        activeAgents.set(userAddress, instance);
        return instance;
    } catch (e) {
        console.error(`Agent init failed for user ${userAddress}:`, e);
        throw e;
    }
}

router.get('/vault', async (req, res) => {
    const userAddress = req.query.userAddress as string;
    if (!userAddress) return res.status(400).json({ error: "userAddress required" });

    try {
        const instance = await getOrCreateAgent(userAddress);
        if (!instance) return res.status(500).json({ error: "Agent initialization failed" });

        const address = await instance.walletProvider.getAddress();
        res.json({ address });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/vault/balance', async (req, res) => {
    const userAddress = req.query.userAddress as string;
    if (!userAddress) return res.status(400).json({ error: "userAddress required" });

    try {
        const instance = await getOrCreateAgent(userAddress);
        if (!instance) return res.status(500).json({ error: "Agent initialization failed" });

        const agentAddress = await instance.walletProvider.getAddress();
        const networkId = instance.config.networkId || process.env.NETWORK_ID || "base-mainnet";
        const chain = networkId === "base-mainnet" ? base : baseSepolia;
        
        const publicClient = createPublicClient({ chain, transport: http() });
        
        // Native Balance (ETH)
        const nativeBalanceWei = await publicClient.getBalance({ address: agentAddress as `0x${string}` });
        const nativeBalance = Number(nativeBalanceWei) / 1e18;

        // USDC Balance
        const rawUsdcAddress = USDC_CONTRACT_ADDRESSES[networkId as keyof typeof USDC_CONTRACT_ADDRESSES] || USDC_CONTRACT_ADDRESSES["base-mainnet"];
        const usdcAddress = getAddress(rawUsdcAddress);
        let usdcBalance = 0;
        try {
            const usdcBalanceRaw = await publicClient.readContract({
                address: usdcAddress,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [agentAddress as `0x${string}`]
            });
            usdcBalance = Number(usdcBalanceRaw) / 1e6; // USDC has 6 decimals
        } catch (e) {
            console.error("Failed to read USDC balance:", e);
        }

        res.json({
            address: agentAddress,
            network: networkId,
            balances: {
                ETH: nativeBalance.toString(),
                USDC: usdcBalance.toString()
            }
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/chat', async (req, res) => {
    const { prompt, userAddress } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });
    if (!userAddress) return res.status(400).json({ error: "userAddress required" });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const instance = await getOrCreateAgent(userAddress);
        if (!instance) {
            sendEvent("error", "Agent failed to start.");
            res.end();
            return;
        }
        const agentAddress = await instance.walletProvider.getAddress();
        const networkId = instance.config.networkId || "base-mainnet";
        const chain = networkId === "base-mainnet" ? base : baseSepolia;
        const publicClient = createPublicClient({ chain, transport: http() });
        const rawUsdcAddress = USDC_CONTRACT_ADDRESSES[networkId as keyof typeof USDC_CONTRACT_ADDRESSES] || USDC_CONTRACT_ADDRESSES["base-mainnet"];
        const usdcAddress = getAddress(rawUsdcAddress);

        // Commission fee: 0.00006 ETH
        const FEE_AMOUNT_ETH = 0.00006;
        const FEE_RECIPIENT = (process.env.KLETIA_FEE_RECIPIENT || "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A") as `0x${string}`;

        // Balance Check (ETH)
        const nativeBalanceWei = await publicClient.getBalance({ address: agentAddress as `0x${string}` });
        const nativeBalance = Number(nativeBalanceWei) / 1e18;

        if (nativeBalance < FEE_AMOUNT_ETH) {
            sendEvent('log', `⚠️ Warning: For Agent transaction ${FEE_AMOUNT_ETH} ETH commission is required. Your vault balance is insufficient: ${nativeBalance.toFixed(5)} ETH. Test mode active, transaction continuing free of charge.`);
        } else {
            // Komisyon Kesintisi (Transfer)
            const rawFeeAmount = BigInt(Math.floor(FEE_AMOUNT_ETH * 1e18));
            
            console.log(`🤖 Agent transaction fee is being deducted: ${FEE_AMOUNT_ETH} ETH -> ${FEE_RECIPIENT}`);
            sendEvent('log', `🤖 Agent transaction fee is being deducted: ${FEE_AMOUNT_ETH} ETH -> ${FEE_RECIPIENT.substring(0, 8)}...`);
            
            try {
                const txHash = await instance.walletProvider.sendTransaction({
                    to: FEE_RECIPIENT,
                    value: rawFeeAmount.toString() as any
                });
                
                sendEvent('log', `⏳ Transaction fee sent to network (${txHash}). Waiting for confirmation...`);
                await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
                sendEvent('log', `✅ Transaction fee successfully received!`);
            } catch (feeError: any) {
                console.error("Fee transfer failed:", feeError);
                sendEvent('log', `⚠️ Transaction fee could not be deducted, continuing due to test mode.`);
            }
        }

        const stream = await instance.agent.stream({ messages: [{ role: "user", content: prompt }] }, instance.config);
        let finalResponse = "";
        
        for await (const chunk of stream) {
            if ("agent" in chunk) {
                const msg = chunk.agent.messages[0].content;
                if (msg) {
                    finalResponse = msg;
                    sendEvent('agent', msg);
                }
            } else if ("tools" in chunk) {
                const toolMsg = chunk.tools.messages[0].content;
                if (toolMsg) {
                    sendEvent('tools', toolMsg);
                }
            }
        }

        sendEvent('done', {
            status: "success",
            action: "agent_action",
            winnerMessage: finalResponse
        });
        res.end();
    } catch (e: any) {
        console.error("Agent chat error:", e);
        sendEvent('error', `Agent error: ${e.message}`);
        res.end();
    }
});


router.post('/vault/withdraw', async (req, res) => {
    const { userAddress, amount, asset } = req.body;
    if (!userAddress || !amount) return res.status(400).json({ error: "userAddress and amount required" });

    const targetAsset = asset ? asset.toUpperCase() : "ETH";

    try {
        const instance = await getOrCreateAgent(userAddress);
        if (!instance) return res.status(500).json({ error: "Agent initialization failed" });

        console.log(`🤖 Kasa Para Çekme: ${amount} ${targetAsset} -> ${userAddress}`);
        
        let txHash;
        if (targetAsset === "ETH") {
            txHash = await instance.walletProvider.sendTransaction({
                to: userAddress as `0x${string}`,
                value: parseEther(amount) as any
            });
        } else if (targetAsset === "USDC") {
            const networkId = instance.config.networkId || "base-mainnet";
            const rawUsdcAddress = USDC_CONTRACT_ADDRESSES[networkId as keyof typeof USDC_CONTRACT_ADDRESSES] || USDC_CONTRACT_ADDRESSES["base-mainnet"];
            const usdcAddress = getAddress(rawUsdcAddress);
            
            const rawAmount = BigInt(Math.floor(parseFloat(amount) * 1e6)); // 6 decimals for USDC
            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [userAddress as `0x${string}`, rawAmount]
            });

            txHash = await instance.walletProvider.sendTransaction({
                to: usdcAddress,
                data
            });
        } else {
            return res.status(400).json({ error: "Unsupported asset. Use ETH or USDC." });
        }

        await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

        res.json({ success: true, txHash, asset: targetAsset, amount });
    } catch (e: any) {
        console.error("Withdraw Error:", e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/vault/export', async (req, res) => {
    return res.status(403).json({ error: "For security reasons, exporting vault private key is disabled." });
});

router.get('/identity', async (req, res) => {
    const userAddress = req.query.userAddress as string;
    if (!userAddress) return res.status(400).json({ error: "userAddress required" });

    try {
        const instance = await getOrCreateAgent(userAddress);
        if (!instance) return res.status(500).json({ error: "Agent initialization failed" });

        const agentAddress = await instance.walletProvider.getAddress();
        res.json({ agentAddress });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/vault/register', async (req, res) => {
    const { userAddress, vaultAddress } = req.body;
    if (!userAddress || !vaultAddress) return res.status(400).json({ error: "userAddress and vaultAddress required" });

    try {
        const vaultFile = path.join(WALLETS_DIR, `${userAddress}_vault_address.json`);
        fs.writeFileSync(vaultFile, JSON.stringify({ vaultAddress }));
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const agentRoutes = router;
