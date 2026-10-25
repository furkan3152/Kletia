/**
 * App Kit plan constants and result types, decimal and address checks,
 * and plan validation.
 */
import { getAddress, isAddress, parseUnits } from "viem";
import type { BridgeResult } from "@circle-fin/app-kit";
import type {
  ArcAppKitExecutionPlan,
  ArcAppKitToken,
} from "../../../../shared/types";

export const ARC_CHAIN_ID = 5_042_002;
const DECIMAL_INPUT = /^(?:\d+\.?\d*|\.\d+)$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
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

export type BridgePlan = Extract<ArcAppKitExecutionPlan, { operation: "bridge" }>;

export const bridgeRecovery = new Map<
  string,
  { result: BridgeResult; plan: BridgePlan; expectedAddress: string }
>();

type JournalState = "started" | ArcAppKitExecutionResult["state"];

export type JournalEntry = {
  version: 1;
  fingerprint: string;
  expectedAddress: string;
  state: JournalState;
  consumed: boolean;
  statusMessage: string;
  updatedAt: string;
  txHash?: string;
};

export const tokenDecimals = (token: ArcAppKitToken): number =>
  token === "cirBTC" ? 8 : 6;

export function assertDecimal(
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

export function assertNonNegativeDecimal(
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

export function assertSameDecimal(
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

export function assertSameAddress(
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

export function assertTransactionHash(
  value: unknown,
  field: string,
): asserts value is `0x${string}` {
  if (typeof value !== "string" || !TX_HASH.test(value)) {
    throw new Error(`${field} is not a valid transaction hash.`);
  }
}

export const arcExplorerUrl = (hash: string): string =>
  `https://testnet.arcscan.app/tx/${hash}`;

export const recoveryKey = (traceId: string, expectedAddress: string): string =>
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
