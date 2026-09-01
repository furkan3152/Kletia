import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import type { ParsedIntent } from "../../shared/ai/parser.js";
import {
  ARC_ERC20_ABI,
  ARC_LENDING_ABI,
  ARC_MEMO_TRANSFER_ABI,
  ARC_STAKING_ABI,
  ARC_SWAP_ABI,
  ARC_VAULT_ABI,
} from "./abis.js";
import {
  ARC_CONTRACTS,
  ARC_LEGACY_VAULT_ADDRESS,
  ARC_NATIVE_USDC_ADDRESS,
  ARC_VAULT_EXECUTION_MODE,
  ARC_VAULT_V2_RUNTIME_CODEHASH,
  NETWORKS,
  arcPublicClient,
  isNetworkTargetAllowed,
} from "../../shared/config/networks.js";

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

const ARC_DECIMALS = NETWORKS.arc.nativeAsset.decimals;

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

function assertArcAsset(
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

function assertKletiaProtocol(intent: ParsedIntent, action: string) {
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

function parsePositiveAmount(
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

async function resolveTokenOrLpAmount(
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

function createApproval(
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

function transactionResult(
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

async function simulateArcTransaction(
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

async function handleSwap(intent: ParsedIntent, user: Address) {
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

function handleStake(intent: ParsedIntent) {
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

async function handleUnstake(intent: ParsedIntent, user: Address) {
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

async function handleClaimRewards(intent: ParsedIntent, user: Address) {
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

async function handleClaimUnstaked(intent: ParsedIntent, user: Address) {
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

export function assertArcVaultReserveForPlan(
  totalDeposited: bigint,
  vaultBalance: bigint,
  requestedInterest = 0n,
) {
  if (vaultBalance < totalDeposited) {
    throw new ArcPlanError(
      "ARC_VAULT_PRINCIPAL_RESERVE_INSUFFICIENT",
      "Arc Vault balance does not cover the total user principal; Kletia did not create a new vault transaction.",
      503,
    );
  }
  if (vaultBalance < totalDeposited + requestedInterest) {
    throw new ArcPlanError(
      "ARC_VAULT_WITHDRAWAL_RESERVE_INSUFFICIENT",
      "Arc Vault cannot cover the interest of this withdrawal without affecting other users' principal; transaction not created.",
      503,
    );
  }
}

async function handleVault(
  intent: ParsedIntent,
  withdraw: boolean,
  user: Address,
  legacyMigration = false,
) {
  if (legacyMigration && (!withdraw || ARC_VAULT_EXECUTION_MODE !== "vault_v2")) {
    throw new ArcPlanError(
      "ARC_VAULT_LEGACY_MIGRATION_INACTIVE",
      "Legacy Vault withdrawal is available only while the application is in Vault V2 migration mode.",
      409,
    );
  }
  const vaultAddress = legacyMigration
    ? ARC_LEGACY_VAULT_ADDRESS
    : ARC_CONTRACTS.Vault;
  const vaultMode = legacyMigration ? "legacy_v1" : ARC_VAULT_EXECUTION_MODE;
  const action = legacyMigration
    ? "Arc legacy vault migration withdrawal"
    : withdraw
      ? "Arc vault withdrawal"
      : "Arc vault deposit";
  assertKletiaProtocol(intent, action);
  assertArcAsset(intent.tokenIn, ["USDC"], action, "tokenIn");
  assertArcAsset(intent.tokenOut, ["USDC"], action, "tokenOut");
  const amount = withdraw
    ? 0n
    : parsePositiveAmount(intent.amount, "Arc vault deposit");
  const observedBlock = await arcPublicClient.getBlockNumber();
  const [totalDeposited, vaultBalance, pendingInterest, vaultCode, position] = await Promise.all([
    arcPublicClient.readContract({
      address: vaultAddress,
      abi: ARC_VAULT_ABI,
      functionName: "totalDeposited",
      blockNumber: observedBlock,
    }),
    arcPublicClient.getBalance({
      address: vaultAddress,
      blockNumber: observedBlock,
    }),
    withdraw
      ? arcPublicClient.readContract({
          address: vaultAddress,
          abi: ARC_VAULT_ABI,
          functionName: "pendingInterest",
          args: [user],
          blockNumber: observedBlock,
        })
      : Promise.resolve(0n),
    vaultMode === "vault_v2"
      ? arcPublicClient.getCode({
          address: vaultAddress,
          blockNumber: observedBlock,
        })
      : Promise.resolve(undefined),
    withdraw
      ? arcPublicClient.readContract({
          address: vaultAddress,
          abi: ARC_VAULT_ABI,
          functionName: "deposits",
          args: [user],
          blockNumber: observedBlock,
        })
      : Promise.resolve(null),
  ]);
  if (withdraw && (position === null || position[0] <= 0n)) {
    throw new ArcPlanError(
      legacyMigration ? "ARC_NO_LEGACY_VAULT_POSITION" : "ARC_NO_VAULT_POSITION",
      legacyMigration
        ? "This wallet has no legacy Arc Vault principal to migrate."
        : "This wallet has no active Arc Vault principal to withdraw.",
    );
  }
  if (vaultMode === "vault_v2") {
    if (
      !vaultCode ||
      vaultCode === "0x" ||
      keccak256(vaultCode).toLowerCase() !== ARC_VAULT_V2_RUNTIME_CODEHASH
    ) {
      throw new ArcPlanError(
        "ARC_VAULT_V2_RUNTIME_MISMATCH",
        "Arc Vault V2 runtime bytecode does not match deployment evidence; transaction not created.",
        503,
      );
    }
    const reserve = await arcPublicClient.readContract({
      address: vaultAddress,
      abi: ARC_VAULT_ABI,
      functionName: "reserveStatus",
      blockNumber: observedBlock,
    });
    if (!reserve[5] || reserve[0] < reserve[3]) {
      throw new ArcPlanError(
        "ARC_VAULT_V2_INSOLVENT",
        "Arc Vault V2 does not cover total principal and interest obligations; transaction not created.",
        503,
      );
    }
  } else {
    assertArcVaultReserveForPlan(
      totalDeposited,
      vaultBalance,
      pendingInterest,
    );
  }
  const resultAction = legacyMigration
    ? "vault_legacy_withdraw"
    : withdraw
      ? "vault_withdraw"
      : "vault_deposit";
  return transactionResult(resultAction, {
    name:
      vaultMode === "vault_v2"
        ? "Kletia Arc Vault V2"
        : legacyMigration
          ? "Kletia Arc Vault Legacy Migration"
          : "Kletia Arc Vault Legacy",
    router: vaultAddress,
    calldata: encodeFunctionData({
      abi: ARC_VAULT_ABI,
      functionName: withdraw ? "withdraw" : "deposit",
    }),
    value: withdraw ? "0" : amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: !withdraw,
    expectedOutput: withdraw
      ? `Full Arc vault principal and ${formatUnits(pendingInterest, 18)} USDC accrued yield; ${vaultMode} reserve checked at block ${observedBlock.toString()}`
      : `${formatUnits(amount, 18)} USDC vault deposit`,
  });
}

function handleMemo(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc memo transfer");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc memo transfer", "tokenIn");
  const amount = parsePositiveAmount(intent.amount, "Arc memo transfer");
  let recipient: Address;
  try {
    recipient = getAddress(String(intent.recipient || intent.tokenOut || ""));
  } catch {
    throw new ArcPlanError(
      "ARC_INVALID_RECIPIENT",
      "A valid EVM recipient address is required for memo transfer.",
    );
  }
  const memo = String(intent.memo || intent.name || "").trim();
  const memoBytes = new TextEncoder().encode(memo).length;
  if (!memo || memoBytes > 256) {
    throw new ArcPlanError(
      "ARC_INVALID_MEMO",
      "Memo cannot be empty and must be at most 256 bytes in UTF-8.",
    );
  }

  return transactionResult("memo_send", {
    name: "Kletia Arc Memo Transfer",
    router: ARC_CONTRACTS.MemoTransfer,
    calldata: encodeFunctionData({
      abi: ARC_MEMO_TRANSFER_ABI,
      functionName: "transferWithMemo",
      args: [recipient, memo],
    }),
    value: amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: true,
    expectedOutput: `${formatUnits(amount, 18)} USDC to ${recipient} with memo`,
  });
}

async function handleAddLiquidity(intent: ParsedIntent) {
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

async function handleRemoveLiquidity(intent: ParsedIntent, user: Address) {
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

function handleLendingDeposit(intent: ParsedIntent) {
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

async function handleLendingWithdraw(intent: ParsedIntent, user: Address) {
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

function handleLendingBorrow(intent: ParsedIntent) {
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

function handleLendingRepay(intent: ParsedIntent) {
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
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Lending,
      abi: ARC_LENDING_ABI,
      functionName: "healthFactor",
      args: [user],
      blockNumber: observedBlock,
    }),
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
        healthFactor: formatUnits(lendingHealth, 18),
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

export async function dispatchArcAction(
  intent: ParsedIntent,
  userAddress: string,
): Promise<ArcTransactionResult> {
  const user = getAddress(userAddress);
  const action = String(intent.action || "").toLowerCase();

  let result: ArcTransactionResult;
  switch (action) {
    case "swap":
      result = await handleSwap(intent, user);
      break;
    case "stake":
      result = handleStake(intent);
      break;
    case "unstake":
      result = await handleUnstake(intent, user);
      break;
    case "claim_rewards":
      result = await handleClaimRewards(intent, user);
      break;
    case "claim_unstaked":
      result = await handleClaimUnstaked(intent, user);
      break;
    case "vault_deposit":
      result = await handleVault(intent, false, user);
      break;
    case "vault_withdraw":
      result = await handleVault(intent, true, user);
      break;
    case "vault_legacy_withdraw":
      result = await handleVault(intent, true, user, true);
      break;
    case "memo_send":
      result = handleMemo(intent);
      break;
    case "add_liquidity":
      result = await handleAddLiquidity(intent);
      break;
    case "remove_liquidity":
      result = await handleRemoveLiquidity(intent, user);
      break;
    case "lending_deposit":
      result = handleLendingDeposit(intent);
      break;
    case "lending_withdraw":
      result = await handleLendingWithdraw(intent, user);
      break;
    case "lending_borrow":
      result = handleLendingBorrow(intent);
      break;
    case "lending_repay":
      result = handleLendingRepay(intent);
      break;
    default:
      throw new ArcPlanError(
        "UNSUPPORTED_ACTION",
        `Action "${action}" is not supported on Arc Testnet.`,
      );
  }

  return simulateArcTransaction(result, user);
}
