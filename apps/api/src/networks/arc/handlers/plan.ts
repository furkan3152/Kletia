/**
 * Arc plan types, asset and amount checks, transaction results and
 * simulation.
 */
import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { ARC_ERC20_ABI } from "../abis.js";
import {
  ARC_CONTRACTS,
  ARC_NATIVE_USDC_ADDRESS,
  NETWORKS,
  arcPublicClient,
  isNetworkTargetAllowed,
} from "../../../shared/config/networks.js";

export class ArcPlanError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ArcPlanError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ApprovalMetadata {
  token: Address;
  spender: Address;
  amount: string;
  calldata: Hex;
  currentAllowance?: string;
  required: boolean;
}

export interface ArcSimulation {
  status: "simulated" | "approval_required";
  finalTransactionSimulated: boolean;
  requiresPostApprovalSimulation: boolean;
  gasEstimate?: string;
  reason?: string;
}

export interface ArcRoutePlan {
  name: string;
  router: Address;
  calldata: Hex;
  value: string;
  expectedOutput: string;
  expectedOutputAtomic?: string;
  outputTokenAddress?: Address;
  primaryTokenAddress?: Address;
  primaryAmountInWei?: string;
  secondaryTokenAddress?: Address;
  secondaryAmountInWei?: string;
  approvals: ApprovalMetadata[];
  simulation?: ArcSimulation;
}

export interface ArcTransactionResult {
  status: "success";
  action: string;
  winner: string;
  winnerMessage: string;
  expectedOutput: string;
  expectedOutputAtomic?: string;
  outputTokenAddress?: Address;
  targetContract: Address;
  calldata: Hex;
  value: string;
  amountInWei: string;
  isNativeIn: boolean;
  tokenInAddress?: Address;
  approvals: ApprovalMetadata[];
  simulation?: ArcSimulation;
  allRoutes: ArcRoutePlan[];
}

export const ARC_DECIMALS = NETWORKS.arc.nativeAsset.decimals;

function normalizeArcAsset(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    const lower = raw.toLowerCase();
    if (lower === ARC_CONTRACTS.Token.toLowerCase()) return "KLET";
    if (lower === ARC_NATIVE_USDC_ADDRESS.toLowerCase()) return "USDC";
    return raw;
  }
  const normalized = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (normalized === "NATIVEUSDC" || normalized === "USDCOIN") {
    return "USDC";
  }
  if (normalized === "KLETIATOKEN") return "KLET";
  return normalized;
}

export function assertArcAsset(
  value: unknown,
  allowed: readonly string[],
  action: string,
  field: string,
  required = false,
): string | undefined {
  const asset = normalizeArcAsset(value);
  if (!asset && !required) return undefined;
  if (!asset || !allowed.includes(asset)) {
    throw new ArcPlanError(
      "ARC_INTENT_ASSET_MISMATCH",
      `${action} for ${field} can only be ${allowed.join(" or ")}; user intent was not silently converted to a different asset.`,
    );
  }
  return asset;
}

export function assertKletiaProtocol(intent: ParsedIntent, action: string) {
  const protocol = String(intent.protocol ?? "").trim();
  if (!protocol) return;
  const normalized = protocol.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (!normalized.includes("kletia") && normalized !== "arc") {
    throw new ArcPlanError(
      "ARC_INTENT_PROTOCOL_MISMATCH",
      `${action} can only be prepared for the Kletia Arc target in the deploy manifest; different protocol was not silently redirected.`,
    );
  }
}

export function parsePositiveAmount(
  amount: string | undefined,
  label: string,
): bigint {
  const normalized = String(amount || "").trim();
  if (!normalized || normalized.toUpperCase() === "MAX") {
    throw new ArcPlanError(
      "ARC_AMOUNT_REQUIRED",
      `You must specify a positive and non-zero amount for ${label}.`,
    );
  }

  try {
    const value = parseUnits(normalized, ARC_DECIMALS);
    if (value <= 0n) throw new Error("zero");
    return value;
  } catch {
    throw new ArcPlanError(
      "ARC_INVALID_AMOUNT",
      `The ${label} amount must be a valid decimal number.`,
    );
  }
}

export async function resolveTokenOrLpAmount(
  amount: string | undefined,
  token: Address,
  user: Address,
  label: string,
): Promise<bigint> {
  if (
    String(amount || "")
      .trim()
      .toUpperCase() !== "MAX"
  ) {
    return parsePositiveAmount(amount, label);
  }

  const balance = await arcPublicClient.readContract({
    address: token,
    abi: ARC_ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
  });
  if (balance <= 0n) {
    throw new ArcPlanError(
      "ARC_INSUFFICIENT_BALANCE",
      `No available balance found for ${label}.`,
    );
  }
  return balance;
}

export function createApproval(
  token: Address,
  spender: Address,
  amount: bigint,
): ApprovalMetadata {
  return {
    token,
    spender,
    amount: amount.toString(),
    calldata: encodeFunctionData({
      abi: ARC_ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
    }),
    required: true,
  };
}

export function transactionResult(
  action: string,
  route: Omit<ArcRoutePlan, "approvals"> & {
    approvals?: ApprovalMetadata[];
    amountInWei: string;
    isNativeIn: boolean;
    tokenInAddress?: Address;
  },
): ArcTransactionResult {
  if (!isNetworkTargetAllowed("arc", route.router, action)) {
    throw new ArcPlanError(
      "ARC_TARGET_NOT_ALLOWED",
      `Arc transaction target is outside the allowlist: ${route.router}.`,
    );
  }

  const approvals = route.approvals || [];
  const normalizedRoute: ArcRoutePlan = {
    name: route.name,
    router: route.router,
    calldata: route.calldata,
    value: route.value,
    expectedOutput: route.expectedOutput,
    expectedOutputAtomic: route.expectedOutputAtomic,
    outputTokenAddress: route.outputTokenAddress,
    primaryTokenAddress: route.primaryTokenAddress,
    primaryAmountInWei: route.primaryAmountInWei,
    secondaryTokenAddress: route.secondaryTokenAddress,
    secondaryAmountInWei: route.secondaryAmountInWei,
    approvals,
  };

  return {
    status: "success",
    action,
    winner: route.name,
    winnerMessage: `Arc Testnet transaction ready: ${route.expectedOutput}.`,
    expectedOutput: route.expectedOutput,
    expectedOutputAtomic: route.expectedOutputAtomic,
    outputTokenAddress: route.outputTokenAddress,
    targetContract: route.router,
    calldata: route.calldata,
    value: route.value,
    amountInWei: route.amountInWei,
    isNativeIn: route.isNativeIn,
    tokenInAddress: route.tokenInAddress,
    approvals,
    allRoutes: [normalizedRoute],
  };
}

export async function simulateArcTransaction(
  result: ArcTransactionResult,
  user: Address,
): Promise<ArcTransactionResult> {
  let approvalMissing = false;

  for (const approval of result.approvals) {
    const [balance, allowance] = await Promise.all([
      arcPublicClient.readContract({
        address: approval.token,
        abi: ARC_ERC20_ABI,
        functionName: "balanceOf",
        args: [user],
      }),
      arcPublicClient.readContract({
        address: approval.token,
        abi: ARC_ERC20_ABI,
        functionName: "allowance",
        args: [user, approval.spender],
      }),
    ]);

    const required = BigInt(approval.amount);
    if (balance < required) {
      throw new ArcPlanError(
        "ARC_INSUFFICIENT_TOKEN_BALANCE",
        `${formatUnits(required, 18)} tokens are required for the Arc transaction; insufficient balance.`,
      );
    }

    approval.currentAllowance = allowance.toString();
    approval.required = allowance < required;
    approvalMissing ||= approval.required;
  }

  if (approvalMissing) {
    const simulation: ArcSimulation = {
      status: "approval_required",
      finalTransactionSimulated: false,
      requiresPostApprovalSimulation: true,
      reason:
        "The final transaction to be signed must be re-simulated after ERC20 approval is completed.",
    };
    result.simulation = simulation;
    result.allRoutes[0].simulation = simulation;
    return result;
  }

  try {
    const tx = {
      account: user,
      to: result.targetContract,
      data: result.calldata,
      value: BigInt(result.value || "0"),
    } as const;
    await arcPublicClient.call(tx);
    const gasEstimate = await arcPublicClient.estimateGas(tx);
    const simulation: ArcSimulation = {
      status: "simulated",
      finalTransactionSimulated: true,
      requiresPostApprovalSimulation: false,
      gasEstimate: gasEstimate.toString(),
    };
    result.simulation = simulation;
    result.allRoutes[0].simulation = simulation;
    result.expectedOutput = `${result.expectedOutput} | Est. gas: ${gasEstimate}`;
    result.allRoutes[0].expectedOutput = result.expectedOutput;
    return result;
  } catch (error: any) {
    console.error("[ARC TRANSACTION SIMULATION FAILED]", {
      action: result.action,
      code:
        typeof error?.code === "string" ? error.code : "ARC_SIMULATION_REVERT",
    });
    throw new ArcPlanError(
      "ARC_SIMULATION_FAILED",
      "Arc transaction failed live network simulation.",
    );
  }
}
