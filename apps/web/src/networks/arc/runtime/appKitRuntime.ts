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
import type { ArcAppKitExecutionPlan, ArcAppKitToken } from "../../../types";

const ARC_CHAIN_ID = 5_042_002;
const DECIMAL_INPUT = /^(?:\d+\.?\d*|\.\d+)$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKENS = new Set<ArcAppKitToken>(["USDC", "EURC", "cirBTC"]);
const DESTINATIONS = new Set([
  "Arbitrum_Sepolia",
  "Avalanche_Fuji",
  "Base_Sepolia",
  "Ethereum_Sepolia",
  "Optimism_Sepolia",
]);

export type ArcAppKitQuote = {
  operation: ArcAppKitExecutionPlan["operation"];
  headline: string;
  estimatedOutput?: string;
  minimumOutput?: string;
  fees: string[];
  feeDisclosure: string;
  planFingerprint: string;
  expectedAddress: string;
  provider: "Circle App Kit";
  environment: "testnet";
  observedAt: string;
};

export type ArcAppKitExecutionResult = {
  state: "success" | "pending" | "recoverable" | "blocked";
  consumed: boolean;
  statusMessage: string;
  txHash?: string;
  explorerUrl?: string;
  steps: {
    name: string;
    state: string;
    txHash?: string;
    explorerUrl?: string;
    forwarded?: boolean;
    batched?: boolean;
    batchId?: string;
    errorCategory?: string;
  }[];
};

type BridgePlan = Extract<ArcAppKitExecutionPlan, { operation: "bridge" }>;

const bridgeRecovery = new Map<
  string,
  { result: BridgeResult; plan: BridgePlan; expectedAddress: string }
>();

type JournalState = "started" | ArcAppKitExecutionResult["state"];

type JournalEntry = {
  version: 1;
  fingerprint: string;
  expectedAddress: string;
  state: JournalState;
  consumed: boolean;
  statusMessage: string;
  updatedAt: string;
  txHash?: string;
};

const JOURNAL_PREFIX = "kletia:arc-app-kit:v1";

export function arcAppKitPlanFingerprint(plan: ArcAppKitExecutionPlan): string {
  if (plan.operation === "swap") {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.tokenIn,
      plan.tokenOut,
      plan.amount,
      plan.slippageBps,
      plan.minimumOutput || "",
    ]);
  }
  if (plan.operation === "send") {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.token,
      plan.amount,
      getAddress(plan.recipient),
    ]);
  }
  return JSON.stringify([
    plan.version,
    plan.environment,
    plan.traceId,
    plan.sourceChain,
    plan.operation,
    plan.token,
    plan.amount,
    plan.destinationChain,
    getAddress(plan.recipient),
    plan.useForwarder,
    plan.transferSpeed,
    plan.maxFee || "",
  ]);
}

const journalKey = (
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): string => `${JOURNAL_PREFIX}:${plan.traceId}:${getAddress(expectedAddress)}`;

function readJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): JournalEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(journalKey(plan, expectedAddress));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<JournalEntry>;
    if (
      entry.version !== 1 ||
      entry.fingerprint !== arcAppKitPlanFingerprint(plan) ||
      entry.expectedAddress !== getAddress(expectedAddress) ||
      typeof entry.statusMessage !== "string" ||
      typeof entry.updatedAt !== "string" ||
      !["started", "success", "pending", "recoverable", "blocked"].includes(
        String(entry.state),
      )
    ) {
      return {
        version: 1,
        fingerprint: arcAppKitPlanFingerprint(plan),
        expectedAddress: getAddress(expectedAddress),
        state: "blocked",
        consumed: true,
        statusMessage:
          "Local execution record for this trace ID does not match the plan. Resubmission blocked for security.",
        updatedAt: new Date().toISOString(),
      };
    }
    return entry as JournalEntry;
  } catch {
    return {
      version: 1,
      fingerprint: arcAppKitPlanFingerprint(plan),
      expectedAddress: getAddress(expectedAddress),
      state: "blocked",
      consumed: true,
      statusMessage:
        "Local execution log could not be read. Resubmission blocked to prevent potential double-spend risk.",
      updatedAt: new Date().toISOString(),
    };
  }
}

function writeJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
  entry: Pick<JournalEntry, "state" | "consumed" | "statusMessage" | "txHash">,
): boolean {
  if (typeof window === "undefined") return false;
  const value: JournalEntry = {
    version: 1,
    fingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    state: entry.state,
    consumed: entry.consumed,
    statusMessage: entry.statusMessage,
    updatedAt: new Date().toISOString(),
    ...(entry.txHash ? { txHash: entry.txHash } : {}),
  };
  try {
    window.localStorage.setItem(
      journalKey(plan, expectedAddress),
      JSON.stringify(value),
    );
    return true;
  } catch {
    return false;
  }
}

function clearJournal(plan: ArcAppKitExecutionPlan, expectedAddress: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(journalKey(plan, expectedAddress));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // journal is a safety aid; failure to delete it must not crash rendering.
  }
}

export function getArcAppKitJournalState(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): {
  state: ArcAppKitExecutionResult["state"];
  statusMessage: string;
  txHash?: string;
} | null {
  const entry = readJournal(plan, expectedAddress);
  if (!entry) return null;
  return {
    state: entry.state === "started" ? "blocked" : entry.state,
    statusMessage:
      entry.state === "started"
        ? "Previous App Kit attempt was interrupted during signature/broadcast phase. The same intent cannot be resubmitted without chain state verification."
        : entry.statusMessage,
    txHash: entry.txHash,
  };
}

const tokenDecimals = (token: ArcAppKitToken): number =>
  token === "cirBTC" ? 8 : 6;

function assertDecimal(
  value: unknown,
  decimals: number,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) {
    throw new Error(`${field} is not a valid decimal number.`);
  }
  if ((value.split(".")[1] || "").length > decimals) {
    throw new Error(`${field} exceeds ${decimals} decimal precision.`);
  }
  if (parseUnits(value, decimals) <= 0n) {
    throw new Error(`${field} must be greater than zero.`);
  }
}

function assertNonNegativeDecimal(
  value: unknown,
  decimals: number,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) {
    throw new Error(`${field} is not a valid decimal number.`);
  }
  if ((value.split(".")[1] || "").length > decimals) {
    throw new Error(`${field} exceeds ${decimals} decimal precision.`);
  }
  parseUnits(value, decimals);
}

function assertSameDecimal(
  actual: unknown,
  expected: string,
  decimals: number,
  field: string,
): asserts actual is string {
  assertDecimal(actual, decimals, field);
  if (parseUnits(actual, decimals) !== parseUnits(expected, decimals)) {
    throw new Error(`${field} does not match the signed intent.`);
  }
}

function assertSameAddress(
  actual: unknown,
  expected: string,
  field: string,
): asserts actual is string {
  if (
    typeof actual !== "string" ||
    !isAddress(actual) ||
    getAddress(actual) !== getAddress(expected)
  ) {
    throw new Error(`${field} does not match the active intent.`);
  }
}

function assertTransactionHash(
  value: unknown,
  field: string,
): asserts value is `0x${string}` {
  if (typeof value !== "string" || !TX_HASH.test(value)) {
    throw new Error(`${field} is not a valid transaction hash.`);
  }
}

const arcExplorerUrl = (hash: string): string =>
  `https://testnet.arcscan.app/tx/${hash}`;

const recoveryKey = (traceId: string, expectedAddress: string): string =>
  `${traceId}:${getAddress(expectedAddress)}`;

export function assertArcAppKitPlan(
  plan: unknown,
): asserts plan is ArcAppKitExecutionPlan {
  if (!plan || typeof plan !== "object") {
    throw new Error("Circle App Kit plan is missing.");
  }
  const candidate = plan as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.environment !== "testnet" ||
    candidate.sourceChain !== "Arc_Testnet" ||
    typeof candidate.traceId !== "string" ||
    !TRACE_ID.test(candidate.traceId)
  ) {
    throw new Error("Circle App Kit plan does not comply with Arc Testnet policy.");
  }
  if (candidate.operation === "swap") {
    if (
      !TOKENS.has(candidate.tokenIn as ArcAppKitToken) ||
      !TOKENS.has(candidate.tokenOut as ArcAppKitToken) ||
      candidate.tokenIn === candidate.tokenOut
    ) {
      throw new Error("Circle App Kit swap token pair is invalid.");
    }
    assertDecimal(
      candidate.amount,
      tokenDecimals(candidate.tokenIn as ArcAppKitToken),
      "App Kit amount",
    );
    if (
      !Number.isSafeInteger(candidate.slippageBps) ||
      Number(candidate.slippageBps) <= 0 ||
      Number(candidate.slippageBps) > 500
    ) {
      throw new Error("Circle App Kit swap slippage tolerance is invalid.");
    }
    if (candidate.minimumOutput !== undefined) {
      assertDecimal(
        candidate.minimumOutput,
        tokenDecimals(candidate.tokenOut as ArcAppKitToken),
        "Minimum output amount",
      );
    }
    return;
  }

  if (candidate.operation === "send") {
    if (
      (candidate.token !== "USDC" && candidate.token !== "EURC") ||
      !isAddress(String(candidate.recipient || ""))
    ) {
      throw new Error("Circle App Kit Send plan is invalid.");
    }
    assertDecimal(candidate.amount, 6, "App Kit amount");
    return;
  }

  if (candidate.operation === "bridge") {
    if (
      candidate.token !== "USDC" ||
      !DESTINATIONS.has(String(candidate.destinationChain || "")) ||
      !isAddress(String(candidate.recipient || "")) ||
      candidate.useForwarder !== true ||
      (candidate.transferSpeed !== "FAST" && candidate.transferSpeed !== "SLOW")
    ) {
      throw new Error("Circle App Kit bridge plan is invalid.");
    }
    assertDecimal(candidate.amount, 6, "App Kit amount");
    if (candidate.transferSpeed === "FAST" && candidate.maxFee === undefined) {
      throw new Error("Maximum fee limit is missing for FAST bridge.");
    }
    if (candidate.maxFee !== undefined) {
      assertDecimal(candidate.maxFee, 6, "Maximum bridge fee");
    }
    if (
      candidate.transferSpeed === "FAST" &&
      parseUnits(candidate.maxFee as string, 6) >=
        parseUnits(candidate.amount, 6)
    ) {
      throw new Error(
        "FAST bridge maximum fee must be less than the amount to send.",
      );
    }
    if (candidate.transferSpeed === "SLOW" && candidate.maxFee !== undefined) {
      throw new Error("SLOW bridge plan cannot include FAST maxFee field.");
    }
    return;
  }

  throw new Error("Desteklenmeyen Circle App Kit operasyonu.");
}

type RequestProvider = EIP1193Provider & {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
};

async function createRuntime(connector: Connector, expectedAddress: string) {
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

const feeText = (
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

function swapParams(
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

function bridgeParams(
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

function assertSwapEstimateMatchesPlan(
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

function assertSwapResultMatchesPlan(
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

function assertBridgeEstimateMatchesPlan(
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

function assertBridgeResultMatchesPlan(
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

function formatBridgeExecutionResult(
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

export async function quoteArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitQuote> {
  assertArcAppKitPlan(plan);
  const { kit, adapter } = await createRuntime(connector, expectedAddress);
  const base = {
    operation: plan.operation,
    planFingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    provider: "Circle App Kit" as const,
    environment: "testnet" as const,
    observedAt: new Date().toISOString(),
  };

  if (plan.operation === "swap") {
    const estimate = await kit.estimateSwap(swapParams(plan, adapter));
    assertSwapEstimateMatchesPlan(estimate, plan, expectedAddress);
    const estimatedOutput = estimate.estimatedOutput.amount;
    if (
      plan.minimumOutput &&
      parseUnits(estimatedOutput, tokenDecimals(plan.tokenOut)) <
        parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
    ) {
      throw new Error(
        `Live output ${plan.minimumOutput} does not meet the user limit under ${plan.tokenOut}.`,
      );
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.tokenIn} → approximately ${estimatedOutput} ${plan.tokenOut}`,
      estimatedOutput: `${estimatedOutput} ${plan.tokenOut}`,
      minimumOutput: `${estimate.stopLimit.amount} ${plan.tokenOut}`,
      fees: (estimate.fees || []).map(
        (fee) => `${fee.amount} ${String(fee.token)} (${fee.type})`,
      ),
      feeDisclosure:
        "If the provider fee item is absent, this does not guarantee zero gas; the wallet separately displays the final gas amount. The production kit key is not embedded in the client; anonymous SDK quota may apply.",
    };
  }

  if (plan.operation === "send") {
    const estimate = await kit.estimateSend({
      from: { adapter, chain: "Arc_Testnet" },
      to: getAddress(plan.recipient),
      amount: plan.amount,
      token: plan.token,
    });
    if (
      estimate.gas < 0n ||
      estimate.gasPrice < 0n ||
      !/^\d+$/.test(estimate.fee)
    ) {
      throw new Error("Circle Send gas estimate could not be verified.");
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.token} → ${getAddress(plan.recipient)}`,
      fees: [feeText(estimate.fee, "USDC gas", 18) as string],
      feeDisclosure:
        "Arc gas is paid with native USDC; the displayed gas is an estimate and the wallet approval determines the final amount.",
    };
  }

  const estimate = await kit.estimateBridge(bridgeParams(plan, adapter));
  assertBridgeEstimateMatchesPlan(estimate, plan, expectedAddress);
  const protocolFees = estimate.fees.map(
    (fee) => `${fee.amount as string} ${fee.token} (${fee.type})`,
  );
  const gasFees = estimate.gasFees.map(
    (fee) =>
      `${(fee.fees as { fee: string }).fee} ${fee.token} gas / ` +
      `${String(fee.blockchain)} (${fee.name})`,
  );
  return {
    ...base,
    headline:
      `${plan.amount} USDC → ${plan.destinationChain} ` +
      `(${plan.transferSpeed}, Circle Forwarder)`,
    fees: [...protocolFees, ...gasFees],
    feeDisclosure:
      `${plan.maxFee ? `${plan.maxFee} USDC SDK burn fee cap applied.` : ""}` +
      "Protocol/forwarder fees and network gas are separate items; Kletia will not execute if the fee estimate is uncertain or incomplete.",
  };
}

export async function executeArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  const existingJournal = readJournal(plan, expectedAddress);
  if (existingJournal) {
    throw new Error(
      "This App Kit intent has already been executed. To avoid double-spend risk, a new source transaction was not initiated.",
    );
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: "started",
      consumed: false,
      statusMessage:
        "Waiting for wallet signature/broadcast result; this trace cannot be restarted.",
    })
  ) {
    throw new Error(
      "Secure execution log could not be created. App Kit will not run without double-spend protection.",
    );
  }

  if (plan.operation === "swap") {
    let result: SwapResult;
    try {
      result = await kit.swap(swapParams(plan, adapter));
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error("Wallet signature was cancelled by the user.", {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Swap execution was interrupted by an unknown error after signature/broadcast. Do not resend the same intent without chain verification.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertSwapResultMatchesPlan(result, plan, expectedAddress);
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Swap provider result could not be re-verified against the signed intent. Check your transaction hash in the wallet; do not resend the intent.",
        txHash: TX_HASH.test(result.txHash) ? result.txHash : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const state =
      result.progress.status === "DONE"
        ? "success"
        : result.progress.status === "PENDING"
          ? "pending"
          : "blocked";
    const executionResult: ArcAppKitExecutionResult = {
      state,
      consumed: true,
      statusMessage:
        state === "success"
          ? "Arc stable swap completed on-chain."
          : state === "pending"
            ? "Swap source transaction sent but SDK status is not yet finalized. Do not resend the same intent."
            : "Swap source transaction sent but provider did not confirm terminal success. Do not resend the same intent.",
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: "Arc stable swap",
          state: result.progress.status,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  if (plan.operation === "send") {
    let result: Awaited<ReturnType<typeof kit.send>>;
    try {
      result = await kit.send({
        from: { adapter, chain: "Arc_Testnet" },
        to: getAddress(plan.recipient),
        amount: plan.amount,
        token: plan.token,
      });
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error("Wallet signature was cancelled by the user.", {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send execution was interrupted by an unknown error after signature/broadcast. Do not resend the same intent without chain verification.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const submitted = Boolean(result.txHash) || Boolean(result.batchId);
    if (result.state !== "success" || !result.txHash) {
      if (!submitted) {
        clearJournal(plan, expectedAddress);
        throw new Error("Circle App Kit Send stopped before being sent on-chain.");
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send transaction may have been broadcast but success was not confirmed. Do not resend the same intent.",
        txHash:
          result.txHash && TX_HASH.test(result.txHash)
            ? result.txHash
            : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertTransactionHash(result.txHash, "Circle Send");
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send result could not be verified. Review wallet history and do not resend the same intent.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const executionResult: ArcAppKitExecutionResult = {
      state: "success",
      consumed: true,
      statusMessage: "Arc Send completed on-chain.",
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: result.name,
          state: result.state,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
          batched: result.batched,
          batchId: result.batchId,
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  let result: BridgeResult;
  try {
    result = await kit.bridge(bridgeParams(plan, adapter));
  } catch (error) {
    if (isUserCancellationError(error)) {
      clearJournal(plan, expectedAddress);
      throw new Error("Wallet signature was cancelled by the user.", {
        cause: error,
      });
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge execution was interrupted by an unknown error after signing/broadcasting. Do not reburn the same intent before chain confirmation.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const likelySubmitted =
    result.state !== "error" ||
    result.steps.some((step) => Boolean(step.txHash) || Boolean(step.batchId));
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    if (!likelySubmitted) {
      clearJournal(plan, expectedAddress);
      throw new Error(
        "Circle bridge result did not match the intent; execution halted due to missing source transaction proof.",
      );
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge provider result could not be re-verified with the intent. Do not resend the same source intent.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const failedStep = result.steps.find((step) => step.state === "error");
  const retryable = Boolean(
    failedStep?.error && isRetryableError(failedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (result.state === "error" && !executionResult.consumed) {
    clearJournal(plan, expectedAddress);
    throw new Error(
      "Circle bridge stopped without sending a source transaction; you may refresh the live estimate.",
    );
  }
  if (executionResult.state === "recoverable") {
    bridgeRecovery.set(recoveryKey(plan.traceId, expectedAddress), {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(recoveryKey(plan.traceId, expectedAddress));
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}

export async function retryArcAppKitBridge(
  connector: Connector,
  expectedAddress: string,
  plan: BridgePlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const key = recoveryKey(plan.traceId, expectedAddress);
  const recovery = bridgeRecovery.get(key);
  if (
    !recovery ||
    recovery.expectedAddress !== getAddress(expectedAddress) ||
    arcAppKitPlanFingerprint(recovery.plan) !== arcAppKitPlanFingerprint(plan)
  ) {
    throw new Error(
      "Safe SDK retry context not found in this browser session. Do not restart the source bridge; review recorded transaction steps.",
    );
  }
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  assertBridgeResultMatchesPlan(recovery.result, plan, expectedAddress);
  const failedStep = recovery.result.steps.find(
    (step) => step.state === "error",
  );
  if (!failedStep?.error || !isRetryableError(failedStep.error)) {
    throw new Error(
      "Circle bridge error is not retryable by the official SDK.",
    );
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: "started",
      consumed: true,
      statusMessage:
        "Bridge is continuing with the official SDK, preserving completed source steps.",
    })
  ) {
    throw new Error("Bridge retry log could not be safely updated.");
  }

  let result: BridgeResult;
  try {
    result = await kit.retryBridge(recovery.result, {
      from: adapter,
      to: undefined,
    });
  } catch (error) {
    if (isUserCancellationError(error)) {
      const previous = formatBridgeExecutionResult(recovery.result, true);
      writeJournal(plan, expectedAddress, previous);
      throw new Error(
        "Bridge continuation signature was cancelled by the user.",
        {
          cause: error,
        },
      );
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge retry call was interrupted in an uncertain state. Source burn was not restarted; check chain and forwarder status.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge retry result could not be verified against the original intent. Source burn was not restarted.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const nextFailedStep = result.steps.find((step) => step.state === "error");
  const retryable = Boolean(
    nextFailedStep?.error && isRetryableError(nextFailedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (executionResult.state === "recoverable") {
    bridgeRecovery.set(key, {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(key);
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}
