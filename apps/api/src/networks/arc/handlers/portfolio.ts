/**
 * The Arc portfolio read.
 */
import { formatUnits, getAddress, keccak256 } from "viem";
import {
  ARC_ERC20_ABI,
  ARC_LENDING_ABI,
  ARC_STAKING_ABI,
  ARC_VAULT_ABI,
} from "../abis.js";
import {
  ARC_CONTRACTS,
  ARC_LEGACY_VAULT_ADDRESS,
  ARC_VAULT_EXECUTION_MODE,
  ARC_VAULT_V2_RUNTIME_CODEHASH,
  NETWORKS,
  arcPublicClient,
} from "../../../shared/config/networks.js";
import { ArcPlanError } from "./plan.js";

export async function getArcPortfolio(userAddress: string) {
  const user = getAddress(userAddress);
  const observedBlock = await arcPublicClient.getBlockNumber();
  if (ARC_VAULT_EXECUTION_MODE === "vault_v2") {
    const activeVaultCode = await arcPublicClient.getCode({
      address: ARC_CONTRACTS.Vault,
      blockNumber: observedBlock,
    });
    if (
      !activeVaultCode ||
      activeVaultCode === "0x" ||
      keccak256(activeVaultCode).toLowerCase() !==
        ARC_VAULT_V2_RUNTIME_CODEHASH
    ) {
      throw new ArcPlanError(
        "ARC_VAULT_V2_RUNTIME_MISMATCH",
        "Arc Vault V2 runtime bytecode does not match deployment evidence; portfolio response not generated.",
        503,
      );
    }
  }

  const [
    nativeBalance,
    kletBalance,
    vaultDeposit,
    vaultPending,
    stakingInfo,
    stakingPending,
    lendingCollateral,
    lendingBorrowed,
    lendingSupplied,
    lendingHealth,
    legacyVaultPosition,
  ] = await Promise.all([
    arcPublicClient.getBalance({ address: user, blockNumber: observedBlock }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Token,
      abi: ARC_ERC20_ABI,
      functionName: "balanceOf",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Vault,
      abi: ARC_VAULT_ABI,
      functionName: "deposits",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Vault,
      abi: ARC_VAULT_ABI,
      functionName: "pendingInterest",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: ARC_STAKING_ABI,
      functionName: "getStakerInfo",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: ARC_STAKING_ABI,
      functionName: "pendingRewards",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Lending,
      abi: ARC_LENDING_ABI,
      functionName: "collateralBalance",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Lending,
      abi: ARC_LENDING_ABI,
      functionName: "getBorrowedBalance",
      args: [user],
      blockNumber: observedBlock,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Lending,
      abi: ARC_LENDING_ABI,
      functionName: "getSuppliedBalance",
      args: [user],
      blockNumber: observedBlock,
    }),
    // healthFactor prices collateral through the pool oracle; an oracle outage reverts it.
    // The rest of the portfolio is still read, and the health factor is reported unavailable.
    arcPublicClient
      .readContract({
        address: ARC_CONTRACTS.Lending,
        abi: ARC_LENDING_ABI,
        functionName: "healthFactor",
        args: [user],
        blockNumber: observedBlock,
      })
      .catch(() => null),
    ARC_VAULT_EXECUTION_MODE === "vault_v2"
      ? Promise.all([
          arcPublicClient.readContract({
            address: ARC_LEGACY_VAULT_ADDRESS,
            abi: ARC_VAULT_ABI,
            functionName: "deposits",
            args: [user],
            blockNumber: observedBlock,
          }),
          arcPublicClient.readContract({
            address: ARC_LEGACY_VAULT_ADDRESS,
            abi: ARC_VAULT_ABI,
            functionName: "pendingInterest",
            args: [user],
            blockNumber: observedBlock,
          }),
        ])
      : Promise.resolve(null),
  ]);

  const legacyVault =
    legacyVaultPosition && legacyVaultPosition[0][0] > 0n
      ? {
          address: ARC_LEGACY_VAULT_ADDRESS,
          principal: formatUnits(legacyVaultPosition[0][0], 18),
          accruedInterest: formatUnits(legacyVaultPosition[0][2], 18),
          pendingInterest: formatUnits(legacyVaultPosition[1], 18),
          migrationRequired: true as const,
        }
      : undefined;

  return {
    status: "success",
    action: "portfolio",
    data: {
      network: "arc",
      chainId: NETWORKS.arc.chainId,
      wallet: [
        {
          symbol: "USDC",
          name: "Native USDC",
          balance: nativeBalance.toString(),
          formatted: formatUnits(nativeBalance, 18),
        },
        {
          symbol: "KLET",
          name: "Kletia Token",
          balance: kletBalance.toString(),
          formatted: formatUnits(kletBalance, 18),
          address: ARC_CONTRACTS.Token,
        },
      ],
      vault: {
        executionMode: ARC_VAULT_EXECUTION_MODE,
        address: ARC_CONTRACTS.Vault,
        principal: formatUnits(vaultDeposit[0], 18),
        accruedInterest: formatUnits(vaultDeposit[2], 18),
        pendingInterest: formatUnits(vaultPending, 18),
      },
      ...(legacyVault ? { legacyVault } : {}),
      staking: {
        stakedAmount: formatUnits(stakingInfo[0], 18),
        pendingUnstake: formatUnits(stakingInfo[3], 18),
        pendingRewards: formatUnits(stakingPending, 18),
        cooldownRemaining: Number(stakingInfo[5]),
      },
      lending: {
        collateralKLET: formatUnits(lendingCollateral, 18),
        borrowedUSDC: formatUnits(lendingBorrowed, 18),
        suppliedUSDC: formatUnits(lendingSupplied, 18),
        healthFactor: lendingHealth === null ? null : formatUnits(lendingHealth, 18),
        healthAvailability: lendingHealth === null ? ("unavailable" as const) : ("available" as const),
      },
      routeAvailability: {
        status: "available_for_intent_planning",
        contractRoutes: [
          "swap USDC/KLET",
          "vault deposit/full withdrawal",
          "native USDC stake/unstake with reward and cooldown claims",
          "KLET collateral and native USDC lending",
          "USDC/KLET liquidity",
          "native USDC memo transfer",
        ],
        circleAppKitRoutes: [
          "USDC/EURC/cirBTC stable swap",
          "USDC/EURC send",
          "USDC testnet bridge",
          "unified balance reads",
        ],
        officialExtensionRoutes: [
          "public memo reference payment",
          "atomic native USDC payout",
        ],
        executionPolicy:
          "Every value-moving request is rebuilt from explicit inputs, bound to Arc Testnet, checked against its action target, and simulated before wallet approval. This portfolio response sends no transaction.",
      },
      observedAtBlock: observedBlock.toString(),
    },
    message:
      "Arc Testnet portfolio scanned with the currently available intent-route families and execution policy.",
  };
}
