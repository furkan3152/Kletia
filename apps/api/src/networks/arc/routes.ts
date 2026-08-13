import { Router, type Request, type Response } from "express";
import {
  formatUnits,
  getAddress,
  isHash,
  parseUnits,
  type Address,
  type Hash,
} from "viem";
import {
  ARC_AGENT_REGISTRY_ABI,
  ARC_BATCH_PAY_ABI,
  ARC_ERC20_ABI,
  ARC_LENDING_ABI,
  ARC_MEMO_TRANSFER_ABI,
  ARC_STAKING_ABI,
  ARC_SWAP_ABI,
  ARC_VAULT_ABI,
} from "./abis.js";
import {
  ARC_CONTRACTS,
  NETWORKS,
  arcPublicClient,
} from "../../config/networks.js";
import {
  ControlledRouteError,
  resolvePublicRouteFailure,
} from "../../security/routeError.js";

const router = Router();
const arc = NETWORKS.arc;

function metadata() {
  return { network: arc.id, chainId: arc.chainId };
}

function scalarParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function addressParam(value: string | string[]): Address {
  try {
    return getAddress(scalarParam(value));
  } catch {
    throw new ControlledRouteError(
      "INVALID_ADDRESS",
      "Geçerli bir EVM adresi gerekli.",
      400,
    );
  }
}

function uintParam(value: string | string[], label: string): bigint {
  const scalar = scalarParam(value);
  if (!/^\d+$/.test(scalar)) {
    throw new ControlledRouteError(
      "INVALID_ID",
      `${label} pozitif bir tam sayı olmalı.`,
      400,
    );
  }
  return BigInt(scalar);
}

function arcRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error: any) {
      const failure = resolvePublicRouteFailure(error, {
        code: "ARC_RPC_ERROR",
        message: "Arc RPC sorgusu tamamlanamadı.",
        statusCode: 502,
      });
      if (!(error instanceof ControlledRouteError)) {
        console.error("[ARC RPC ROUTE FAILED]", {
          code: typeof error?.code === "string" ? error.code : "ARC_RPC_ERROR",
          path: req.route?.path,
        });
      }
      res.status(failure.statusCode).json({
        success: false,
        code: failure.code,
        error: failure.message,
        ...metadata(),
      });
    }
  };
}

router.get(
  "/health",
  arcRoute(async (_req, res) => {
    const [blockNumber, chainId] = await Promise.all([
      arcPublicClient.getBlockNumber(),
      arcPublicClient.getChainId(),
    ]);
    res.json({
      success: chainId === arc.chainId,
      status: chainId === arc.chainId ? "ok" : "degraded",
      blockNumber: blockNumber.toString(),
      rpcUrl: "https://rpc.testnet.arc.network",
      explorer: arc.explorerUrl,
      contracts: ARC_CONTRACTS,
      ...metadata(),
    });
  }),
);

router.get(
  "/balance/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const [nativeBalance, kletBalance, kletDecimals, kletSymbol] =
      await Promise.all([
        arcPublicClient.getBalance({ address }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Token,
          abi: ARC_ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Token,
          abi: ARC_ERC20_ABI,
          functionName: "decimals",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Token,
          abi: ARC_ERC20_ABI,
          functionName: "symbol",
        }),
      ]);

    res.json({
      success: true,
      address,
      nativeUSDC: {
        balance: formatUnits(nativeBalance, arc.nativeAsset.decimals),
        balanceRaw: nativeBalance.toString(),
        symbol: arc.nativeAsset.symbol,
        decimals: arc.nativeAsset.decimals,
      },
      klet: {
        balance: formatUnits(kletBalance, kletDecimals),
        balanceRaw: kletBalance.toString(),
        symbol: kletSymbol,
        decimals: kletDecimals,
      },
      ...metadata(),
    });
  }),
);

router.get(
  "/swap/info",
  arcRoute(async (_req, res) => {
    const [kletPrice, tokenAddress, reserveUSDC, reserveToken] =
      await Promise.all([
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Swap,
          abi: ARC_SWAP_ABI,
          functionName: "consultKletPrice",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Swap,
          abi: ARC_SWAP_ABI,
          functionName: "token",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Swap,
          abi: ARC_SWAP_ABI,
          functionName: "reserveUSDC",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Swap,
          abi: ARC_SWAP_ABI,
          functionName: "reserveToken",
        }),
      ]);
    res.json({
      success: true,
      contract: ARC_CONTRACTS.Swap,
      kletPrice: kletPrice.toString(),
      kletPriceFormatted: formatUnits(kletPrice, 18),
      tokenAddress,
      reserveUSDC: formatUnits(reserveUSDC, 18),
      reserveToken: formatUnits(reserveToken, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/swap/preview",
  arcRoute(async (req, res) => {
    const amount = String(req.query.amount || "");
    if (!amount) {
      throw new ControlledRouteError(
        "AMOUNT_REQUIRED",
        "amount parametresi gerekli.",
        400,
      );
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, 18);
      if (amountWei <= 0n) throw new Error("zero");
    } catch {
      throw new ControlledRouteError(
        "INVALID_AMOUNT",
        "amount pozitif bir sayı olmalı.",
        400,
      );
    }
    const tokenToUsdc = req.query.direction === "token_to_usdc";
    const estimatedOut = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.Swap,
      abi: ARC_SWAP_ABI,
      functionName: tokenToUsdc
        ? "previewSwapTokenForUSDC"
        : "previewSwapUSDCForToken",
      args: [amountWei],
    });
    res.json({
      success: true,
      direction: tokenToUsdc ? "KLET → USDC" : "USDC → KLET",
      amountIn: amount,
      amountInRaw: amountWei.toString(),
      estimatedOut: formatUnits(estimatedOut, 18),
      estimatedOutRaw: estimatedOut.toString(),
      ...metadata(),
    });
  }),
);

router.get(
  "/vault/info",
  arcRoute(async (_req, res) => {
    const [apyBps, totalDeposited, vaultBalance] = await Promise.all([
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "apyBps",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "totalDeposited",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "vaultBalance",
      }),
    ]);
    res.json({
      success: true,
      contract: ARC_CONTRACTS.Vault,
      apyBps: Number(apyBps),
      apyPercent: Number(apyBps) / 100,
      totalDeposited: formatUnits(totalDeposited, 18),
      vaultBalance: formatUnits(vaultBalance, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/vault/user/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const [deposit, pendingInterest, claimable] = await Promise.all([
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "deposits",
        args: [address],
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "pendingInterest",
        args: [address],
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: ARC_VAULT_ABI,
        functionName: "claimableAmount",
        args: [address],
      }),
    ]);
    res.json({
      success: true,
      address,
      principal: formatUnits(deposit[0], 18),
      principalRaw: deposit[0].toString(),
      lastAccrualTimestamp: Number(deposit[1]),
      accruedInterest: formatUnits(deposit[2], 18),
      pendingInterest: formatUnits(pendingInterest, 18),
      claimableAmount: formatUnits(claimable, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/staking/info",
  arcRoute(async (_req, res) => {
    const [aprBps, totalStaked, cooldownPeriod, rewardPoolBalance] =
      await Promise.all([
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Staking,
          abi: ARC_STAKING_ABI,
          functionName: "aprBps",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Staking,
          abi: ARC_STAKING_ABI,
          functionName: "totalStaked",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Staking,
          abi: ARC_STAKING_ABI,
          functionName: "cooldownPeriod",
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Staking,
          abi: ARC_STAKING_ABI,
          functionName: "rewardPoolBalance",
        }),
      ]);
    res.json({
      success: true,
      contract: ARC_CONTRACTS.Staking,
      aprBps: Number(aprBps),
      aprPercent: Number(aprBps) / 100,
      totalStaked: formatUnits(totalStaked, 18),
      cooldownPeriod: Number(cooldownPeriod),
      rewardPoolBalance: formatUnits(rewardPoolBalance, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/staking/user/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const [info, pendingRewards] = await Promise.all([
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Staking,
        abi: ARC_STAKING_ABI,
        functionName: "getStakerInfo",
        args: [address],
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Staking,
        abi: ARC_STAKING_ABI,
        functionName: "pendingRewards",
        args: [address],
      }),
    ]);
    res.json({
      success: true,
      address,
      stakedAmount: formatUnits(info[0], 18),
      stakingTimestamp: Number(info[1]),
      accruedRewards: formatUnits(info[2], 18),
      pendingUnstake: formatUnits(info[3], 18),
      unstakeRequestTime: Number(info[4]),
      cooldownRemaining: Number(info[5]),
      pendingRewards: formatUnits(pendingRewards, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/memo-transfers/count",
  arcRoute(async (_req, res) => {
    const count = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.MemoTransfer,
      abi: ARC_MEMO_TRANSFER_ABI,
      functionName: "totalTransfers",
    });
    res.json({
      success: true,
      totalTransfers: Number(count),
      ...metadata(),
    });
  }),
);

router.get(
  "/memo-transfers/sent/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const [ids, count] = await Promise.all([
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.MemoTransfer,
        abi: ARC_MEMO_TRANSFER_ABI,
        functionName: "getSentTransferIds",
        args: [address],
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.MemoTransfer,
        abi: ARC_MEMO_TRANSFER_ABI,
        functionName: "sentTransferCount",
        args: [address],
      }),
    ]);
    res.json({
      success: true,
      address,
      sentCount: Number(count),
      sentTransferIds: ids.map(Number),
      ...metadata(),
    });
  }),
);

router.get(
  "/memo-transfers/:id",
  arcRoute(async (req, res) => {
    const transferId = uintParam(req.params.id, "transfer id");
    const transfer = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.MemoTransfer,
      abi: ARC_MEMO_TRANSFER_ABI,
      functionName: "getTransfer",
      args: [transferId],
    });
    res.json({
      success: true,
      transferId: transfer.id.toString(),
      from: transfer.from,
      to: transfer.to,
      amount: formatUnits(transfer.amount, 18),
      amountRaw: transfer.amount.toString(),
      memo: transfer.memo,
      timestamp: Number(transfer.timestamp),
      ...metadata(),
    });
  }),
);

router.get(
  "/batch/count",
  arcRoute(async (_req, res) => {
    const count = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.BatchPay,
      abi: ARC_BATCH_PAY_ABI,
      functionName: "totalBatches",
    });
    res.json({ success: true, totalBatches: Number(count), ...metadata() });
  }),
);

router.get(
  "/batch/:id",
  arcRoute(async (req, res) => {
    const batchId = uintParam(req.params.id, "batch id");
    const batch = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.BatchPay,
      abi: ARC_BATCH_PAY_ABI,
      functionName: "getBatch",
      args: [batchId],
    });
    res.json({
      success: true,
      batchId: batch.id.toString(),
      sender: batch.sender,
      totalAmount: formatUnits(batch.totalAmount, 18),
      totalAmountRaw: batch.totalAmount.toString(),
      recipientCount: Number(batch.recipientCount),
      memo: batch.memo,
      timestamp: Number(batch.timestamp),
      ...metadata(),
    });
  }),
);

router.get(
  "/agents/count",
  arcRoute(async (_req, res) => {
    const count = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.AgentRegistry,
      abi: ARC_AGENT_REGISTRY_ABI,
      functionName: "totalAgents",
    });
    res.json({ success: true, totalAgents: Number(count), ...metadata() });
  }),
);

router.get(
  "/agents/owner/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const ids = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.AgentRegistry,
      abi: ARC_AGENT_REGISTRY_ABI,
      functionName: "getAgentsByOwner",
      args: [address],
    });
    res.json({
      success: true,
      address,
      agentIds: ids.map(Number),
      ...metadata(),
    });
  }),
);

router.get(
  "/agents/:id",
  arcRoute(async (req, res) => {
    const agentId = uintParam(req.params.id, "agent id");
    const agent = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.AgentRegistry,
      abi: ARC_AGENT_REGISTRY_ABI,
      functionName: "getAgent",
      args: [agentId],
    });
    res.json({
      success: true,
      agentId: agent.id.toString(),
      name: agent.name,
      description: agent.description,
      skills: agent.skills,
      endpointUrl: agent.endpointUrl,
      owner: agent.agentOwner,
      active: agent.active,
      reputation: Number(agent.reputation),
      registeredAt: Number(agent.registeredAt),
      updatedAt: Number(agent.updatedAt),
      ...metadata(),
    });
  }),
);

router.get(
  "/lending/info",
  arcRoute(async (_req, res) => {
    const [
      borrowRate,
      liquidityRate,
      ltvBips,
      liqThreshold,
      borrowIndex,
      liquidityIndex,
    ] = await Promise.all([
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "currentBorrowRate",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "currentLiquidityRate",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "LTV_BIPS",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "LIQ_THRESHOLD_BIPS",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "borrowIndex",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "liquidityIndex",
      }),
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
      ...metadata(),
    });
  }),
);

router.get(
  "/lending/user/:address",
  arcRoute(async (req, res) => {
    const address = addressParam(req.params.address);
    const [collateral, borrowed, supplied, health, maxBorrow, kletPrice] =
      await Promise.all([
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "collateralBalance",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "getBorrowedBalance",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "getSuppliedBalance",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "healthFactor",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "_getMaxBorrow",
          args: [address],
        }),
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Lending,
          abi: ARC_LENDING_ABI,
          functionName: "_getKletPrice",
        }),
      ]);
    res.json({
      success: true,
      address,
      collateralKLET: formatUnits(collateral, 18),
      borrowedUSDC: formatUnits(borrowed, 18),
      suppliedUSDC: formatUnits(supplied, 18),
      healthFactor: formatUnits(health, 18),
      maxBorrowUSDC: formatUnits(maxBorrow, 18),
      kletPriceUSDC: formatUnits(kletPrice, 18),
      ...metadata(),
    });
  }),
);

router.get(
  "/tx/:hash",
  arcRoute(async (req, res) => {
    const hashParam = scalarParam(req.params.hash);
    if (!isHash(hashParam)) {
      throw new ControlledRouteError(
        "INVALID_TRANSACTION_HASH",
        "Geçerli bir işlem hash’i gerekli.",
        400,
      );
    }
    const hash = hashParam as Hash;
    const transaction = await arcPublicClient.getTransaction({ hash });
    let receipt = null;
    try {
      receipt = await arcPublicClient.getTransactionReceipt({ hash });
    } catch {}
    res.json({
      success: true,
      hash,
      transaction,
      receipt,
      explorerUrl: `${arc.explorerUrl}/tx/${hash}`,
      ...metadata(),
    });
  }),
);

export default router;
