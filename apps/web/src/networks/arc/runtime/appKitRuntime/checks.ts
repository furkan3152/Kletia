/**
 * App Kit runtime, swap and bridge parameters, and the checks that an
 * estimate or result matches the plan.
 */
import {
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type EIP1193Provider,
} from "viem";
import type { Connector } from "wagmi";
import type {
  BridgeResult,
  EstimateResult as BridgeEstimate,
  SwapEstimate,
  SwapResult,
} from "@circle-fin/app-kit";
import type { ArcAppKitExecutionPlan } from "../../../../shared/types";
import {
  ARC_CHAIN_ID,
  type ArcAppKitExecutionResult,
  arcExplorerUrl,
  assertDecimal,
  assertNonNegativeDecimal,
  assertSameAddress,
  assertSameDecimal,
  assertTransactionHash,
  type BridgePlan,
  tokenDecimals,
} from "./plan";

type RequestProvider = EIP1193Provider & {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
};

export async function createRuntime(connector: Connector, expectedAddress: string) {
  const [
    { AppKit, isRetryableError, isUserCancellationError },
    { createViemAdapterFromProvider },
  ] = await Promise.all([
    import("@circle-fin/app-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const rawProvider = await connector.getProvider({
    chainId: ARC_CHAIN_ID,
  });
  if (
    !rawProvider ||
    typeof (rawProvider as { request?: unknown }).request !== "function"
  ) {
    throw new Error("Connected wallet does not provide an EIP-1193 provider.");
  }
  const provider = rawProvider as RequestProvider;
  const [chainValue, accountValue] = await Promise.all([
    provider.request({ method: "eth_chainId" }),
    provider.request({ method: "eth_accounts" }),
  ]);
  const providerChainId =
    typeof chainValue === "string" ? Number.parseInt(chainValue, 16) : NaN;
  if (providerChainId !== ARC_CHAIN_ID) {
    throw new Error(
      "Circle App Kit only operates during an active Arc Testnet session.",
    );
  }
  const providerAccount =
    Array.isArray(accountValue) && typeof accountValue[0] === "string"
      ? accountValue[0]
      : "";
  if (
    !isAddress(providerAccount) ||
    getAddress(providerAccount) !== getAddress(expectedAddress)
  ) {
    throw new Error(
      "Circle App Kit provider account does not match the active wallet.",
    );
  }

  const adapter = await createViemAdapterFromProvider({
    provider,
    capabilities: {
      addressContext: "user-controlled",
    },
  });
  const kit = new AppKit({
    disableErrorReporting: true,
  });
  return { kit, adapter, isRetryableError, isUserCancellationError };
}

export const feeText = (
  rawFee: unknown,
  token: string,
  decimals?: number,
): string | null => {
  if (rawFee === null || rawFee === undefined) return null;
  const value = String(rawFee);
  if (!/^\d+$/.test(value) || decimals === undefined) {
    return `${value} ${token}`;
  }
  return `${formatUnits(BigInt(value), decimals)} ${token}`;
};

export function swapParams(
  plan: Extract<ArcAppKitExecutionPlan, { operation: "swap" }>,
  adapter: Awaited<ReturnType<typeof createRuntime>>["adapter"],
) {
  return {
    from: { adapter, chain: "Arc_Testnet" as const },
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amount,
    config: {
      slippageBps: plan.slippageBps,
      ...(plan.minimumOutput ? { stopLimit: plan.minimumOutput } : {}),
    },
  };
}

export function bridgeParams(
  plan: BridgePlan,
  adapter: Awaited<ReturnType<typeof createRuntime>>["adapter"],
) {
  return {
    from: { adapter, chain: "Arc_Testnet" as const },
    to: {
      chain: plan.destinationChain,
      recipientAddress: getAddress(plan.recipient),
      useForwarder: true as const,
    },
    amount: plan.amount,
    token: "USDC" as const,
    config: {
      transferSpeed: plan.transferSpeed,
      batchTransactions: true,
      ...(plan.maxFee ? { maxFee: plan.maxFee } : {}),
    },
    invocationMeta: { traceId: plan.traceId },
  };
}

export function assertSwapEstimateMatchesPlan(
  estimate: SwapEstimate,
  plan: Extract<ArcAppKitExecutionPlan, { operation: "swap" }>,
  expectedAddress: string,
) {
  if (
    estimate.tokenIn !== plan.tokenIn ||
    estimate.tokenOut !== plan.tokenOut ||
    estimate.chainIn !== "Arc_Testnet" ||
    estimate.chainOut !== "Arc_Testnet" ||
    estimate.chain !== "Arc_Testnet"
  ) {
    throw new Error("Circle swap estimate does not match the Arc intent route.");
  }
  assertSameDecimal(
    estimate.amountIn,
    plan.amount,
    tokenDecimals(plan.tokenIn),
    "Circle swap input amount",
  );
  assertSameAddress(
    estimate.fromAddress,
    expectedAddress,
    "Circle swap sender",
  );
  assertSameAddress(estimate.toAddress, expectedAddress, "Circle swap recipient");
  if (
    estimate.stopLimit.token !== plan.tokenOut ||
    estimate.estimatedOutput.token !== plan.tokenOut
  ) {
    throw new Error("Circle swap output token does not match the intent.");
  }
  assertDecimal(
    estimate.stopLimit.amount,
    tokenDecimals(plan.tokenOut),
    "Circle swap korunan minimumu",
  );
  assertDecimal(
    estimate.estimatedOutput.amount,
    tokenDecimals(plan.tokenOut),
    "Circle swap estimated output",
  );
  if (
    plan.minimumOutput &&
    parseUnits(estimate.stopLimit.amount, tokenDecimals(plan.tokenOut)) <
      parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
  ) {
    throw new Error("Circle swap provider does not honor user minimum.");
  }
  for (const fee of estimate.fees || []) {
    if (
      typeof fee.token !== "string" ||
      fee.token.length === 0 ||
      typeof fee.type !== "string" ||
      fee.type.length === 0
    ) {
      throw new Error("Circle swap fee item could not be validated.");
    }
    assertNonNegativeDecimal(fee.amount, 18, "Circle swap fee");
  }
}

export function assertSwapResultMatchesPlan(
  result: SwapResult,
  plan: Extract<ArcAppKitExecutionPlan, { operation: "swap" }>,
  expectedAddress: string,
) {
  if (
    result.tokenIn !== plan.tokenIn ||
    result.tokenOut !== plan.tokenOut ||
    result.chainIn !== "Arc_Testnet" ||
    result.chainOut !== "Arc_Testnet" ||
    result.chain !== "Arc_Testnet"
  ) {
    throw new Error("Circle swap result does not match the Arc intent route.");
  }
  assertSameDecimal(
    result.amountIn,
    plan.amount,
    tokenDecimals(plan.tokenIn),
    "Circle swap execution amount",
  );
  assertSameAddress(
    result.fromAddress,
    expectedAddress,
    "Circle swap sender",
  );
  assertSameAddress(result.toAddress, expectedAddress, "Circle swap recipient");
  if (
    !result.config ||
    result.config.slippageBps !== plan.slippageBps ||
    (plan.minimumOutput
      ? result.config.stopLimit !== plan.minimumOutput
      : result.config.stopLimit !== undefined)
  ) {
    throw new Error("Circle swap execution limits do not match the intent.");
  }
  assertTransactionHash(result.txHash, "Circle swap");
  if (result.amountOut !== undefined) {
    assertDecimal(
      result.amountOut,
      tokenDecimals(plan.tokenOut),
      "Circle swap realized output",
    );
  }
  if (
    result.progress.status === "DONE" &&
    plan.minimumOutput &&
    result.amountOut !== undefined &&
    parseUnits(result.amountOut, tokenDecimals(plan.tokenOut)) <
      parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
  ) {
    throw new Error("Circle swap result is below the user minimum.");
  }
}

export function assertBridgeEstimateMatchesPlan(
  estimate: BridgeEstimate,
  plan: BridgePlan,
  expectedAddress: string,
) {
  if (
    estimate.token !== "USDC" ||
    estimate.source.chain !== "Arc_Testnet" ||
    estimate.destination.chain !== plan.destinationChain
  ) {
    throw new Error("Circle bridge estimate does not match the intent networks.");
  }
  assertSameDecimal(estimate.amount, plan.amount, 6, "Circle bridge amount");
  assertSameAddress(
    estimate.source.address,
    expectedAddress,
    "Circle bridge source",
  );
  assertSameAddress(
    estimate.destination.recipientAddress || estimate.destination.address,
    plan.recipient,
    "Circle bridge recipient",
  );

  if (estimate.fees.length === 0 || estimate.gasFees.length === 0) {
    throw new Error("Circle bridge did not return a complete fee estimate.");
  }
  for (const fee of estimate.fees) {
    if (fee.error != null || fee.amount === null) {
      throw new Error(
        `Circle bridge ${fee.type} fee cannot be verified at this time.`,
      );
    }
    assertNonNegativeDecimal(fee.amount, 6, `Circle bridge ${fee.type} fee`);
  }
  for (const gasFee of estimate.gasFees) {
    assertArcAppKitBridgeGasEstimate(gasFee, plan.destinationChain);
  }
}

type BridgeGasEstimate = BridgeEstimate["gasFees"][number];

export function assertArcAppKitBridgeGasEstimate(
  gasFee: BridgeGasEstimate,
  destinationChain: BridgePlan["destinationChain"],
): void {
  if (gasFee.error != null || gasFee.fees === null) {
    throw new Error(
      `Circle bridge ${String(gasFee.blockchain)} gas fee cannot be verified.`,
    );
  }
  if (
    gasFee.blockchain !== "Arc_Testnet" &&
    gasFee.blockchain !== destinationChain
  ) {
    throw new Error("Circle bridge gas estimate contains an unexpected network.");
  }
  if (
    typeof gasFee.name !== "string" ||
    gasFee.name.length < 1 ||
    gasFee.name.length > 80 ||
    typeof gasFee.token !== "string" ||
    gasFee.token.length < 1 ||
    gasFee.token.length > 32 ||
    typeof gasFee.fees.gas !== "bigint" ||
    gasFee.fees.gas <= 0n ||
    typeof gasFee.fees.gasPrice !== "bigint" ||
    gasFee.fees.gasPrice < 0n ||
    typeof gasFee.fees.fee !== "string" ||
    gasFee.fees.fee.length > 96
  ) {
    throw new Error("Circle bridge gas estimate is invalid.");
  }
  assertNonNegativeDecimal(gasFee.fees.fee, 18, "Circle bridge gas fee");
}

export function assertBridgeResultMatchesPlan(
  result: BridgeResult,
  plan: BridgePlan,
  expectedAddress: string,
) {
  if (
    result.token !== "USDC" ||
    result.source.chain.chain !== "Arc_Testnet" ||
    result.source.chain.isTestnet !== true ||
    result.destination.chain.chain !== plan.destinationChain ||
    result.destination.chain.isTestnet !== true ||
    result.destination.useForwarder !== true
  ) {
    throw new Error("Circle bridge result does not match intent networks.");
  }
  assertSameDecimal(
    result.amount,
    plan.amount,
    6,
    "Circle bridge execution amount",
  );
  assertSameAddress(
    result.source.address,
    expectedAddress,
    "Circle bridge source",
  );
  assertSameAddress(
    result.destination.recipientAddress || result.destination.address,
    plan.recipient,
    "Circle bridge recipient",
  );
  if (
    !result.config ||
    result.config.transferSpeed !== plan.transferSpeed ||
    result.config.batchTransactions !== true ||
    (plan.maxFee
      ? result.config.maxFee !== plan.maxFee
      : result.config.maxFee !== undefined && result.config.maxFee !== "0")
  ) {
    throw new Error("Circle bridge execution limits do not match intent.");
  }
  if (typeof result.provider !== "string" || result.provider.length === 0) {
    throw new Error("Circle bridge provider could not be verified.");
  }
  if (result.steps.length === 0) {
    throw new Error("Circle bridge step proof is missing.");
  }
  for (const step of result.steps) {
    if (
      typeof step.name !== "string" ||
      step.name.length === 0 ||
      !["pending", "success", "error", "noop"].includes(step.state)
    ) {
      throw new Error("Circle bridge step proof is invalid.");
    }
    if (step.txHash !== undefined) {
      assertTransactionHash(step.txHash, `Circle bridge ${step.name}`);
    }
    if (step.batchId !== undefined && step.batchId.length === 0) {
      throw new Error("Circle bridge batch ID is invalid.");
    }
  }
  if (
    result.state === "success" &&
    result.steps.some(
      (step) => step.state === "pending" || step.state === "error",
    )
  ) {
    throw new Error("Circle bridge success state is inconsistent with steps.");
  }
  if (
    result.state === "error" &&
    !result.steps.some((step) => step.state === "error")
  ) {
    throw new Error("Circle bridge error state is inconsistent with steps.");
  }
}

export function formatBridgeExecutionResult(
  result: BridgeResult,
  retryable: boolean,
): ArcAppKitExecutionResult {
  const steps = result.steps.map((step) => ({
    name: step.name,
    state: step.state,
    txHash: step.txHash,
    forwarded: step.forwarded,
    batched: step.batched,
    batchId: step.batchId,
    errorCategory: step.errorCategory,
  }));
  const sourceStep = result.steps.find(
    (step) =>
      Boolean(step.txHash) &&
      step.name.toLocaleLowerCase("en-US").includes("burn"),
  );
  const consumed = result.steps.some(
    (step) => Boolean(step.txHash) || Boolean(step.batchId),
  );

  if (result.state === "success") {
    return {
      state: "success",
      consumed,
      statusMessage: "Circle bridge completed all steps.",
      txHash: sourceStep?.txHash,
      explorerUrl: sourceStep?.txHash
        ? arcExplorerUrl(sourceStep.txHash)
        : undefined,
      steps,
    };
  }
  if (result.state === "pending") {
    return {
      state: "pending",
      consumed,
      statusMessage:
        "Source transaction sent; Circle attestation/forwarder path is ongoing. Do not resend the same intent.",
      txHash: sourceStep?.txHash,
      explorerUrl: sourceStep?.txHash
        ? arcExplorerUrl(sourceStep.txHash)
        : undefined,
      steps,
    };
  }
  return {
    state: retryable ? "recoverable" : "blocked",
    consumed,
    statusMessage: retryable
      ? "Bridge partially progressed. Official SDK can resume from where it left off; the source transaction will not be restarted."
      : "Bridge partially progressed but no safe automatic continuation condition exists. Do not resend the same intent and review the transaction steps.",
    txHash: sourceStep?.txHash,
    explorerUrl: sourceStep?.txHash
      ? arcExplorerUrl(sourceStep.txHash)
      : undefined,
    steps,
  };
}
