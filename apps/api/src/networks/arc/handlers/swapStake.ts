/**
 * Swap, stake, unstake and reward-claim handlers.
 */
import { encodeFunctionData, formatUnits, type Address } from "viem";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { ARC_STAKING_ABI, ARC_SWAP_ABI } from "../abis.js";
import {
  ARC_CONTRACTS,
  arcPublicClient,
} from "../../../shared/config/networks.js";
import {
  ARC_DECIMALS,
  ArcPlanError,
  assertArcAsset,
  assertKletiaProtocol,
  createApproval,
  parsePositiveAmount,
  resolveTokenOrLpAmount,
  transactionResult,
} from "./plan.js";

export async function handleSwap(intent: ParsedIntent, user: Address) {
  assertKletiaProtocol(intent, "Arc swap");
  const tokenIn = assertArcAsset(
    intent.tokenIn,
    ["USDC", "KLET"],
    "Arc swap",
    "tokenIn",
    true,
  )!;

  const isUsdcToKlet = tokenIn === "USDC";
  const expectedTokenOut = isUsdcToKlet ? "KLET" : "USDC";
  assertArcAsset(intent.tokenOut, [expectedTokenOut], "Arc swap", "tokenOut");
  const amount = isUsdcToKlet
    ? parsePositiveAmount(intent.amount, "Arc swap")
    : await resolveTokenOrLpAmount(
        intent.amount,
        ARC_CONTRACTS.Token,
        user,
        "KLET swap",
      );

  const calldata = isUsdcToKlet
    ? encodeFunctionData({
        abi: ARC_SWAP_ABI,
        functionName: "swapUSDCForToken",
      })
    : encodeFunctionData({
        abi: ARC_SWAP_ABI,
        functionName: "swapTokenForUSDC",
        args: [amount],
      });

  const output = await arcPublicClient.readContract({
    address: ARC_CONTRACTS.Swap,
    abi: ARC_SWAP_ABI,
    functionName: isUsdcToKlet
      ? "previewSwapUSDCForToken"
      : "previewSwapTokenForUSDC",
    args: [amount],
  });

  return transactionResult("swap", {
    name: "Kletia Arc Swap",
    router: ARC_CONTRACTS.Swap,
    calldata,
    value: isUsdcToKlet ? amount.toString() : "0",
    amountInWei: amount.toString(),
    isNativeIn: isUsdcToKlet,
    tokenInAddress: isUsdcToKlet ? undefined : ARC_CONTRACTS.Token,
    primaryTokenAddress: isUsdcToKlet ? undefined : ARC_CONTRACTS.Token,
    primaryAmountInWei: isUsdcToKlet ? undefined : amount.toString(),
    approvals: isUsdcToKlet
      ? []
      : [createApproval(ARC_CONTRACTS.Token, ARC_CONTRACTS.Swap, amount)],
    expectedOutputAtomic: output.toString(),
    outputTokenAddress: isUsdcToKlet ? ARC_CONTRACTS.Token : undefined,
    expectedOutput: `${formatUnits(output, 18)} ${isUsdcToKlet ? "KLET" : "USDC"}`,
  });
}

export function handleStake(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc staking");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc staking", "tokenIn");
  assertArcAsset(intent.tokenOut, ["USDC"], "Arc staking", "tokenOut");
  const amount = parsePositiveAmount(intent.amount, "Arc staking");
  return transactionResult("stake", {
    name: "Kletia Arc Staking",
    router: ARC_CONTRACTS.Staking,
    calldata: encodeFunctionData({
      abi: ARC_STAKING_ABI,
      functionName: "stake",
    }),
    value: amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: true,
    expectedOutput: `${formatUnits(amount, 18)} USDC stake`,
  });
}

export async function handleUnstake(intent: ParsedIntent, user: Address) {
  assertKletiaProtocol(intent, "Arc unstake");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc unstake", "tokenIn");
  assertArcAsset(intent.tokenOut, ["USDC"], "Arc unstake", "tokenOut");
  let amount: bigint;
  if (String(intent.amount || "").toUpperCase() === "MAX") {
    const info = await arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: ARC_STAKING_ABI,
      functionName: "getStakerInfo",
      args: [user],
    });
    amount = info[0];
    if (amount <= 0n) {
      throw new ArcPlanError(
        "ARC_NO_STAKE",
        "Arc staking position not found.",
      );
    }
  } else {
    amount = parsePositiveAmount(intent.amount, "Arc unstake");
  }

  return transactionResult("unstake", {
    name: "Kletia Arc Staking",
    router: ARC_CONTRACTS.Staking,
    calldata: encodeFunctionData({
      abi: ARC_STAKING_ABI,
      functionName: "unstake",
      args: [amount],
    }),
    value: "0",
    amountInWei: amount.toString(),
    isNativeIn: false,
    expectedOutput: `${formatUnits(amount, 18)} USDC unstake request`,
  });
}

export async function handleClaimRewards(intent: ParsedIntent, user: Address) {
  assertKletiaProtocol(intent, "Arc staking reward claim");
  const [pendingRewards, rewardPoolBalance] = await Promise.all([
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: ARC_STAKING_ABI,
      functionName: "pendingRewards",
      args: [user],
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: ARC_STAKING_ABI,
      functionName: "rewardPoolBalance",
    }),
  ]);

  if (pendingRewards <= 0n) {
    throw new ArcPlanError(
      "ARC_NO_STAKING_REWARDS",
      "No claimable Arc staking rewards currently available for this wallet.",
    );
  }
  if (rewardPoolBalance < pendingRewards) {
    throw new ArcPlanError(
      "ARC_REWARD_POOL_INSUFFICIENT",
      "Arc staking reward pool does not fully cover this claim; no partial payment plan created.",
      503,
    );
  }

  return transactionResult("claim_rewards", {
    name: "Kletia Arc Staking Rewards",
    router: ARC_CONTRACTS.Staking,
    calldata: encodeFunctionData({
      abi: ARC_STAKING_ABI,
      functionName: "claimRewards",
    }),
    value: "0",
    amountInWei: "0",
    isNativeIn: false,
    expectedOutput: `${formatUnits(pendingRewards, ARC_DECIMALS)} native USDC rewards`,
  });
}

export async function handleClaimUnstaked(intent: ParsedIntent, user: Address) {
  assertKletiaProtocol(intent, "Arc unstake claim");
  const info = await arcPublicClient.readContract({
    address: ARC_CONTRACTS.Staking,
    abi: ARC_STAKING_ABI,
    functionName: "getStakerInfo",
    args: [user],
  });
  const pendingUnstake = info[3];
  const cooldownRemaining = info[5];

  if (pendingUnstake <= 0n) {
    throw new ArcPlanError(
      "ARC_NO_PENDING_UNSTAKE",
      "No pending Arc unstake claim request for this wallet.",
    );
  }
  if (cooldownRemaining > 0n) {
    throw new ArcPlanError(
      "ARC_STAKING_COOLDOWN_ACTIVE",
      `Arc unstake cooldown is active; approximately ${cooldownRemaining.toString()} seconds remaining.`,
    );
  }

  return transactionResult("claim_unstaked", {
    name: "Kletia Arc Staking Unstake Claim",
    router: ARC_CONTRACTS.Staking,
    calldata: encodeFunctionData({
      abi: ARC_STAKING_ABI,
      functionName: "claimUnstaked",
    }),
    value: "0",
    amountInWei: "0",
    isNativeIn: false,
    expectedOutput: `${formatUnits(pendingUnstake, ARC_DECIMALS)} native USDC unstaked funds`,
  });
}
