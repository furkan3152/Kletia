/**
 * ARC Network Routes
 * 
 * Tüm ARC Testnet rotaları burada tanımlanır.
 * Base Mainnet rotalarından tamamen bağımsızdır.
 * 
 * Prefix: /api/arc/*
 * 
 * ⚡ ABI'ler doğrudan arcConfig.ts'den import edilir.
 *    Lokal ABI tanımlaması YAPILMAZ.
 */

import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import { 
    ARC_CONTRACTS, 
    ARC_SWAP_ABI, 
    ARC_VAULT_ABI, 
    ARC_MEMOTRANSFER_ABI, 
    ARC_BATCHPAY_ABI, 
    ARC_AGENTREGISTRY_ABI, 
    ARC_STAKING_ABI,
    ARC_LENDING_ABI,
    ARC_FORWARDER_ABI,
    ARC_OTC_ABI
} from '../config/arcConfig.js';

const ARC_CONFIG = {
  RPC_URL: "https://rpc.drpc.testnet.arc.io",
  CHAIN_ID: 5042002, // Official Arc Testnet Chain ID
  NETWORK_NAME: "Arc Testnet",
  EXPLORER_URL: "https://testnet.arcscan.app",
  FEATURES: [],
  CONTRACTS: ARC_CONTRACTS
};

const router = express.Router();

// ── Minimal ERC20 ABI (KLET Token sorguları için) ────────────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];


// ── ARC Provider Singleton ────────────────────────────────────────────────
let arcProviderInstance: ethers.JsonRpcProvider | null = null;

const getArcProvider = () => {
  if (arcProviderInstance) return arcProviderInstance;

  const provider = new ethers.JsonRpcProvider(ARC_CONFIG.RPC_URL, ARC_CONFIG.CHAIN_ID, {
    staticNetwork: true
  });
  
  // Rate limit interceptor (Retry logic for 429 and 32011)
  const originalSend = provider.send.bind(provider);
  provider.send = async (method: string, params: any[] | Record<string, any>): Promise<any> => {
      let attempts = 0;
      while (attempts < 10) {
          try {
              return await originalSend(method, params);
          } catch (error: any) {
              const msg = error.message ? error.message.toLowerCase() : "";
              console.error(`[RPC Interceptor] Error on ${method}:`, error.message);
              if (msg.includes("429") || msg.includes("rate limit") || msg.includes("32011") || msg.includes("network") || msg.includes("timeout") || msg.includes("fetch failed")) {
                  attempts++;
                  await new Promise(r => setTimeout(r, 1000)); // wait 1s
              } else {
                  throw error;
              }
          }
      }
      throw new Error(`RPC Rate Limit failed after 10 retries`);
  };
  
  arcProviderInstance = provider;
  return arcProviderInstance;
};


// ══════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── Health Check ────────────────────────────────────────────────────────
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const blockNumber = await provider.getBlockNumber();
    const network = await provider.getNetwork();

    res.json({
      success: true,
      network: ARC_CONFIG.NETWORK_NAME,
      chainId: Number(network.chainId),
      blockNumber,
      rpcUrl: ARC_CONFIG.RPC_URL,
      explorer: ARC_CONFIG.EXPLORER_URL,
      features: ARC_CONFIG.FEATURES,
      contracts: ARC_CONFIG.CONTRACTS,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Native USDC Balance (Arc'ın native coin'i) ─────────────────────────
router.get('/balance/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'Geçersiz adres' });
    }

    const provider = getArcProvider();
    
    // Arc'ta USDC native coin'dir (ETH gibi). ERC20 değildir.
    const nativeBalance = await provider.getBalance(address);
    const formattedNative = ethers.formatEther(nativeBalance); // 18 decimals

    // KLET token bakiyesi (ERC20)
    const klet = new ethers.Contract(ARC_CONTRACTS.Token, ERC20_ABI, provider);
    const [kletBalance, kletDecimals, kletSymbol] = await Promise.all([
      klet.balanceOf(address),
      klet.decimals(),
      klet.symbol(),
    ]);
    const formattedKlet = ethers.formatUnits(kletBalance, kletDecimals);

    res.json({
      success: true,
      address,
      nativeUSDC: {
        balance: formattedNative,
        balanceRaw: nativeBalance.toString(),
        symbol: "USDC",
        decimals: 18,
      },
      klet: {
        balance: formattedKlet,
        balanceRaw: kletBalance.toString(),
        symbol: kletSymbol,
        decimals: Number(kletDecimals),
      },
      network: ARC_CONFIG.NETWORK_NAME,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Swap Info ───────────────────────────────────────────────────────────
router.get('/swap/info', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const swap = new ethers.Contract(ARC_CONTRACTS.Swap, ARC_SWAP_ABI, provider);
    
    const [kletPrice, tokenAddress, reserveUSDC, reserveToken] = await Promise.all([
      swap.consultKletPrice(),
      swap.token(),
      swap.reserveUSDC(),
      swap.reserveToken(),
    ]);

    res.json({
      success: true,
      contract: ARC_CONTRACTS.Swap,
      kletPrice: kletPrice.toString(),
      kletPriceFormatted: ethers.formatEther(kletPrice),
      tokenAddress,
      reserveUSDC: ethers.formatEther(reserveUSDC),
      reserveToken: ethers.formatEther(reserveToken),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Swap Preview ────────────────────────────────────────────────────────
router.get('/swap/preview', async (req: Request, res: Response) => {
  try {
    const { amount, direction } = req.query;
    if (!amount) return res.status(400).json({ success: false, error: 'amount parametresi gerekli' });
    
    const provider = getArcProvider();
    const swap = new ethers.Contract(ARC_CONTRACTS.Swap, ARC_SWAP_ABI, provider);
    const amountWei = ethers.parseEther(amount as string);
    
    if (direction === 'token_to_usdc') {
      const usdcOut = await swap.previewSwapTokenForUSDC(amountWei);
      res.json({ success: true, direction: 'KLET → USDC', amountIn: amount, estimatedOut: ethers.formatEther(usdcOut), estimatedOutRaw: usdcOut.toString() });
    } else {
      const tokenOut = await swap.previewSwapUSDCForToken(amountWei);
      res.json({ success: true, direction: 'USDC → KLET', amountIn: amount, estimatedOut: ethers.formatEther(tokenOut), estimatedOutRaw: tokenOut.toString() });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vault Info ──────────────────────────────────────────────────────────
router.get('/vault/info', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const vault = new ethers.Contract(ARC_CONTRACTS.Vault, ARC_VAULT_ABI, provider);
    
    const [apyBps, totalDeposited, vaultBalance] = await Promise.all([
      vault.apyBps(),
      vault.totalDeposited(),
      vault.vaultBalance(),
    ]);

    res.json({
      success: true,
      contract: ARC_CONTRACTS.Vault,
      apyBps: Number(apyBps),
      apyPercent: Number(apyBps) / 100,
      totalDeposited: ethers.formatEther(totalDeposited),
      vaultBalance: ethers.formatEther(vaultBalance),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vault User Info ─────────────────────────────────────────────────────
router.get('/vault/user/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'Geçersiz adres' });
    }

    const provider = getArcProvider();
    const vault = new ethers.Contract(ARC_CONTRACTS.Vault, ARC_VAULT_ABI, provider);
    
    // deposits(address) returns (uint256 principal, uint256 lastAccrualTimestamp, uint256 accruedInterest)
    const depositInfo = await vault.deposits(address);
    const pendingInterest = await vault.pendingInterest(address);
    const claimable = await vault.claimableAmount(address);

    res.json({
      success: true,
      address,
      principal: ethers.formatEther(depositInfo[0]),
      principalRaw: depositInfo[0].toString(),
      lastAccrualTimestamp: Number(depositInfo[1]),
      accruedInterest: ethers.formatEther(depositInfo[2]),
      pendingInterest: ethers.formatEther(pendingInterest),
      claimableAmount: ethers.formatEther(claimable),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Staking Info ────────────────────────────────────────────────────────
router.get('/staking/info', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const staking = new ethers.Contract(ARC_CONTRACTS.Staking, ARC_STAKING_ABI, provider);
    
    const [aprBps, totalStaked, cooldownPeriod, rewardPoolBalance] = await Promise.all([
      staking.aprBps(),
      staking.totalStaked(),
      staking.cooldownPeriod(),
      staking.rewardPoolBalance(),
    ]);

    res.json({
      success: true,
      contract: ARC_CONTRACTS.Staking,
      aprBps: Number(aprBps),
      aprPercent: Number(aprBps) / 100,
      totalStaked: ethers.formatEther(totalStaked),
      cooldownPeriod: Number(cooldownPeriod),
      rewardPoolBalance: ethers.formatEther(rewardPoolBalance),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Staking User Info ───────────────────────────────────────────────────
router.get('/staking/user/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'Geçersiz adres' });
    }

    const provider = getArcProvider();
    const staking = new ethers.Contract(ARC_CONTRACTS.Staking, ARC_STAKING_ABI, provider);
    
    const info = await staking.getStakerInfo(address);
    const pending = await staking.pendingRewards(address);

    res.json({
      success: true,
      address,
      stakedAmount: ethers.formatEther(info[0]),
      stakingTimestamp: Number(info[1]),
      accruedRewards: ethers.formatEther(info[2]),
      pendingUnstake: ethers.formatEther(info[3]),
      unstakeRequestTime: Number(info[4]),
      cooldownRemaining: Number(info[5]),
      pendingRewards: ethers.formatEther(pending),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Memo Transfer Count ─────────────────────────────────────────────────
router.get('/memo-transfers/count', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const memo = new ethers.Contract(ARC_CONTRACTS.MemoTransfer, ARC_MEMOTRANSFER_ABI, provider);
    const count = await memo.totalTransfers();

    res.json({ success: true, totalTransfers: Number(count) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Memo Transfer Detail ────────────────────────────────────────────────
router.get('/memo-transfers/:id', async (req: Request, res: Response) => {
  try {
    const transferId = req.params.id;
    const provider = getArcProvider();
    const memo = new ethers.Contract(ARC_CONTRACTS.MemoTransfer, ARC_MEMOTRANSFER_ABI, provider);
    
    // getTransfer returns struct TransferRecord { id, from, to, amount, memo, timestamp }
    const transfer = await memo.getTransfer(transferId);

    res.json({
      success: true,
      transferId,
      from: transfer[1],     // from
      to: transfer[2],       // to
      amount: ethers.formatEther(transfer[3]), // amount (native USDC, 18 decimals)
      memo: transfer[4],     // memo string
      timestamp: Number(transfer[5]),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Memo Transfers by Address ───────────────────────────────────────────
router.get('/memo-transfers/sent/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const provider = getArcProvider();
    const memo = new ethers.Contract(ARC_CONTRACTS.MemoTransfer, ARC_MEMOTRANSFER_ABI, provider);
    
    const [sentIds, sentCount] = await Promise.all([
      memo.getSentTransferIds(address),
      memo.sentTransferCount(address),
    ]);

    res.json({ success: true, address, sentCount: Number(sentCount), sentTransferIds: sentIds.map(Number) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BatchPay Info ───────────────────────────────────────────────────────
router.get('/batch/count', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const batch = new ethers.Contract(ARC_CONTRACTS.BatchPay, ARC_BATCHPAY_ABI, provider);
    const totalBatches = await batch.totalBatches();

    res.json({ success: true, totalBatches: Number(totalBatches) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BatchPay Detail ─────────────────────────────────────────────────────
router.get('/batch/:id', async (req: Request, res: Response) => {
  try {
    const batchId = req.params.id;
    const provider = getArcProvider();
    const batch = new ethers.Contract(ARC_CONTRACTS.BatchPay, ARC_BATCHPAY_ABI, provider);
    
    // getBatch returns struct BatchRecord { id, sender, totalAmount, recipientCount, memo, timestamp }
    const record = await batch.getBatch(batchId);

    res.json({
      success: true,
      batchId,
      sender: record[1],
      totalAmount: ethers.formatEther(record[2]),
      recipientCount: Number(record[3]),
      memo: record[4],
      timestamp: Number(record[5]),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Agent Registry Count ────────────────────────────────────────────────
router.get('/agents/count', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const registry = new ethers.Contract(ARC_CONTRACTS.AgentRegistry, ARC_AGENTREGISTRY_ABI, provider);
    const count = await registry.totalAgents();

    res.json({ success: true, totalAgents: Number(count) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Agent Registry Detail ───────────────────────────────────────────────
router.get('/agents/:id', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.id;
    const provider = getArcProvider();
    const registry = new ethers.Contract(ARC_CONTRACTS.AgentRegistry, ARC_AGENTREGISTRY_ABI, provider);
    
    // getAgent returns struct Agent { id, name, description, skills[], endpointUrl, agentOwner, active, reputation, registeredAt, updatedAt }
    const agent = await registry.getAgent(agentId);

    res.json({
      success: true,
      agentId,
      name: agent[1],
      description: agent[2],
      skills: agent[3],
      endpointUrl: agent[4],
      owner: agent[5],
      active: agent[6],
      reputation: Number(agent[7]),
      registeredAt: Number(agent[8]),
      updatedAt: Number(agent[9]),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Agents by Owner ─────────────────────────────────────────────────────
router.get('/agents/owner/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const provider = getArcProvider();
    const registry = new ethers.Contract(ARC_CONTRACTS.AgentRegistry, ARC_AGENTREGISTRY_ABI, provider);
    const ids = await registry.getAgentsByOwner(address);

    res.json({ success: true, address, agentIds: ids.map(Number) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Lending Info ────────────────────────────────────────────────────────
router.get('/lending/info', async (_req: Request, res: Response) => {
  try {
    const provider = getArcProvider();
    const lending = new ethers.Contract(ARC_CONTRACTS.Lending, ARC_LENDING_ABI, provider);
    
    const [borrowRate, liquidityRate, ltvBips, liqThreshold, borrowIndex, liquidityIndex] = await Promise.all([
      lending.currentBorrowRate(),
      lending.currentLiquidityRate(),
      lending.LTV_BIPS(),
      lending.LIQ_THRESHOLD_BIPS(),
      lending.borrowIndex(),
      lending.liquidityIndex(),
    ]);

    res.json({
      success: true,
      contract: ARC_CONTRACTS.Lending,
      currentBorrowRate: borrowRate.toString(),
      currentLiquidityRate: liquidityRate.toString(),
      ltvBips: Number(ltvBips),
      ltvPercent: Number(ltvBips) / 100,
      liqThresholdBips: Number(liqThreshold),
      liqThresholdPercent: Number(liqThreshold) / 100,
      borrowIndex: borrowIndex.toString(),
      liquidityIndex: liquidityIndex.toString(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Lending User Info ───────────────────────────────────────────────────
router.get('/lending/user/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'Geçersiz adres' });
    }

    const provider = getArcProvider();
    const lending = new ethers.Contract(ARC_CONTRACTS.Lending, ARC_LENDING_ABI, provider);
    
    const [collateral, borrowed, supplied, healthFact, maxBorrow, kletPrice] = await Promise.all([
      lending.collateralBalance(address),
      lending.getBorrowedBalance(address),
      lending.getSuppliedBalance(address),
      lending.healthFactor(address),
      lending._getMaxBorrow(address),
      lending._getKletPrice(),
    ]);

    res.json({
      success: true,
      address,
      collateralKLET: ethers.formatEther(collateral),
      borrowedUSDC: ethers.formatEther(borrowed),
      suppliedUSDC: ethers.formatEther(supplied),
      healthFactor: ethers.formatEther(healthFact),
      maxBorrowUSDC: ethers.formatEther(maxBorrow),
      kletPriceUSDC: ethers.formatEther(kletPrice),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Relay Endpoints Removed ────────────────────────
// Gasless mechanics removed. All transactions are standard native transactions.

// ── TX Explorer Link ────────────────────────────────────────────────────
router.get('/tx/:hash', (req: Request, res: Response) => {
  const { hash } = req.params;
  res.json({
    success: true,
    explorerUrl: `${ARC_CONFIG.EXPLORER_URL}/tx/${hash}`,
    hash,
  });
});

console.log('🌀 ARC Network rotaları yüklendi');

export default router;
