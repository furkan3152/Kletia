/**
 * Liquidity and lending handlers.
 */
import { encodeFunctionData, formatUnits, type Address } from "viem";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { ARC_LENDING_ABI, ARC_SWAP_ABI } from "../abis.js";
import {
  ARC_CONTRACTS,
  arcPublicClient,
} from "../../../shared/config/networks.js";
import {
  ArcPlanError,
  assertArcAsset,
  assertKletiaProtocol,
  createApproval,
  parsePositiveAmount,
  resolveTokenOrLpAmount,
  transactionResult,
} from "./plan.js";

export async function handleAddLiquidity(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc liquidity addition");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc liquidity addition", "tokenIn");
  assertArcAsset(
    intent.tokenOut,
    ["KLET"],
    "Arc liquidity addition",
    "tokenOut",
  );
  const usdcAmount = parsePositiveAmount(intent.amount, "Arc liquidity");
  const [usdcReserve, tokenReserve] = await Promise.all([
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Swap,
      abi: ARC_SWAP_ABI,
      functionName: "usdcReserve",
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Swap,
      abi: ARC_SWAP_ABI,
      functionName: "tokenReserve",
    }),
  ]);
  if (usdcReserve <= 0n || tokenReserve <= 0n) {
    throw new ArcPlanError(
      "ARC_EMPTY_POOL",
      "Arc liquidity pool reserves are not ready.",
    );
  }

  const requiredKlet = (usdcAmount * tokenReserve) / usdcReserve;
  if (requiredKlet <= 0n) {
    throw new ArcPlanError(
      "ARC_LIQUIDITY_AMOUNT_TOO_LOW",
      "Arc liquidity amount does not generate a positive KLET requirement at live reserve ratio.",
    );
  }
  const userMaxKlet = parsePositiveAmount(
    intent.secondaryAmount,
    "Arc liquidity KLET maximum",
  );
  if (userMaxKlet < requiredKlet) {
    throw new ArcPlanError(
      "ARC_LIQUIDITY_KLET_CAP_EXCEEDED",
      `Live reserves require at least ${formatUnits(requiredKlet, 18)} KLET, which would exceed the user's ${formatUnits(userMaxKlet, 18)} KLET cap. No route was prepared.`,
    );
  }

  const protocolSlippageCap = (requiredKlet * 105n + 99n) / 100n;
  const maxKlet =
    userMaxKlet < protocolSlippageCap ? userMaxKlet : protocolSlippageCap;
  return transactionResult("add_liquidity", {
    name: "Kletia Arc Liquidity",
    router: ARC_CONTRACTS.Swap,
    calldata: encodeFunctionData({
      abi: ARC_SWAP_ABI,
      functionName: "addLiquidity",
      args: [maxKlet],
    }),
    value: usdcAmount.toString(),
    amountInWei: usdcAmount.toString(),
    isNativeIn: true,
    secondaryTokenAddress: ARC_CONTRACTS.Token,
    secondaryAmountInWei: maxKlet.toString(),
    approvals: [
      createApproval(ARC_CONTRACTS.Token, ARC_CONTRACTS.Swap, maxKlet),
    ],
    expectedOutput:
      `${formatUnits(usdcAmount, 18)} USDC + ` +
      `${formatUnits(requiredKlet, 18)} KLET live requirement ` +
      `(hard cap ${formatUnits(maxKlet, 18)} KLET)`,
  });
}

export async function handleRemoveLiquidity(intent: ParsedIntent, user: Address) {
  const amount = await resolveTokenOrLpAmount(
    intent.amount,
    ARC_CONTRACTS.Swap,
    user,
    "Arc LP removal",
  );
  return transactionResult("remove_liquidity", {
    name: "Kletia Arc Liquidity",
    router: ARC_CONTRACTS.Swap,
    calldata: encodeFunctionData({
      abi: ARC_SWAP_ABI,
      functionName: "removeLiquidity",
      args: [amount],
    }),
    value: "0",
    amountInWei: amount.toString(),
    isNativeIn: false,
    expectedOutput: `${formatUnits(amount, 18)} LP removal`,
  });
}

export function handleLendingDeposit(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc lending collateral deposit");
  assertArcAsset(
    intent.tokenIn,
    ["KLET"],
    "Arc lending collateral deposit",
    "tokenIn",
  );
  assertArcAsset(
    intent.collateralToken,
    ["KLET"],
    "Arc lending collateral deposit",
    "collateralToken",
  );
  const amount = parsePositiveAmount(intent.amount, "Arc collateral deposit");
  return transactionResult("lending_deposit", {
    name: "Kletia Arc Lending",
    router: ARC_CONTRACTS.Lending,
    calldata: encodeFunctionData({
      abi: ARC_LENDING_ABI,
      functionName: "depositCollateral",
      args: [amount],
    }),
    value: "0",
    amountInWei: amount.toString(),
    isNativeIn: false,
    tokenInAddress: ARC_CONTRACTS.Token,
    primaryTokenAddress: ARC_CONTRACTS.Token,
    primaryAmountInWei: amount.toString(),
    approvals: [
      createApproval(ARC_CONTRACTS.Token, ARC_CONTRACTS.Lending, amount),
    ],
    expectedOutput: `${formatUnits(amount, 18)} KLET collateral deposit`,
  });
}

export async function handleLendingWithdraw(intent: ParsedIntent, user: Address) {
  assertKletiaProtocol(intent, "Arc lending withdrawal");
  const token = assertArcAsset(
    intent.tokenIn || "KLET",
    ["KLET", "USDC"],
    "Arc lending withdrawal",
    "tokenIn",
    true,
  )!;
  const tokenOut = assertArcAsset(
    intent.tokenOut,
    ["KLET", "USDC"],
    "Arc lending withdrawal",
    "tokenOut",
  );
  if (tokenOut && tokenOut !== token) {
    throw new ArcPlanError(
      "ARC_INTENT_ASSET_MISMATCH",
      "Arc lending withdrawal tokenIn and tokenOut fields must represent the same asset.",
    );
  }

  const available = await arcPublicClient.readContract({
    address: ARC_CONTRACTS.Lending,
    abi: ARC_LENDING_ABI,
    functionName: token === "KLET" ? "collateralBalance" : "getSuppliedBalance",
    args: [user],
  });
  const maxRequested = String(intent.amount || "").toUpperCase() === "MAX";
  const amount = maxRequested
    ? available
    : parsePositiveAmount(intent.amount, "Arc lending withdrawal");
  if (amount <= 0n || amount > available) {
    throw new ArcPlanError(
      "ARC_LENDING_WITHDRAW_BALANCE",
      `Insufficient withdrawable ${token} balance.`,
    );
  }

  return transactionResult("lending_withdraw", {
    name: "Kletia Arc Lending",
    router: ARC_CONTRACTS.Lending,
    calldata: encodeFunctionData({
      abi: ARC_LENDING_ABI,
      functionName: token === "KLET" ? "withdrawCollateral" : "withdrawUSDC",
      args: [amount],
    }),
    value: "0",
    amountInWei: amount.toString(),
    isNativeIn: false,
    expectedOutput: `${formatUnits(amount, 18)} ${token} lending withdrawal`,
  });
}

export function handleLendingBorrow(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc lending borrow");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc lending borrow", "tokenIn");
  assertArcAsset(
    intent.borrowToken,
    ["USDC"],
    "Arc lending borrow",
    "borrowToken",
  );
  assertArcAsset(
    intent.collateralToken,
    ["KLET"],
    "Arc lending borrow",
    "collateralToken",
  );
  const amount = parsePositiveAmount(intent.amount, "Arc borrow");
  return transactionResult("lending_borrow", {
    name: "Kletia Arc Lending",
    router: ARC_CONTRACTS.Lending,
    calldata: encodeFunctionData({
      abi: ARC_LENDING_ABI,
      functionName: "borrow",
      args: [amount],
    }),
    value: "0",
    amountInWei: "0",
    isNativeIn: false,
    expectedOutput: `${formatUnits(amount, 18)} USDC borrow`,
  });
}

export function handleLendingRepay(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc lending repayment");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc lending repayment", "tokenIn");
  assertArcAsset(
    intent.borrowToken,
    ["USDC"],
    "Arc lending repayment",
    "borrowToken",
  );
  const amount = parsePositiveAmount(intent.amount, "Arc debt repayment");
  return transactionResult("lending_repay", {
    name: "Kletia Arc Lending",
    router: ARC_CONTRACTS.Lending,
    calldata: encodeFunctionData({
      abi: ARC_LENDING_ABI,
      functionName: "repay",
    }),
    value: amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: true,
    expectedOutput: `${formatUnits(amount, 18)} USDC debt repayment`,
  });
}
