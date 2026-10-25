/**
 * Shared shapes of the response envelope checks and their error class.
 */
import type { Address, Hex } from "viem";

export class IntentResponseError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "IntentResponseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RouteLike {
  name?: string;
  protocol?: string;
  router?: string;
  targetContract?: string;
  calldata?: Hex;
  value?: string | number | bigint;
  approvals?: unknown[];
  network?: unknown;
  chainId?: unknown;
  requestId?: unknown;
  userAddress?: unknown;
  quoteExpiresAt?: unknown;
  executionMode?: unknown;
  feeRouterCompatible?: unknown;
  policyTargets?: unknown;
  [key: string]: unknown;
}

export interface ResultLike {
  action?: string;
  actionType?: string;
  winner?: string;
  targetContract?: string;
  target?: string;
  calldata?: Hex;
  value?: string | number | bigint;
  amountInWei?: string | number | bigint;
  allRoutes?: RouteLike[];
  approvals?: unknown[];
  [key: string]: unknown;
}

export type UnknownRecord = Record<string, unknown>;

export interface CheckedV2Intent {
  readonly owner: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: string;
  readonly minAmountOut: string;
  readonly recipient: Address;
  readonly adapter: Address;
  readonly adapterConfigHash: Hex;
  readonly adapterDataHash: Hex;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly validAfter: string;
  readonly deadline: string;
  readonly executor: Address;
  readonly maxFeeBps: number;
}

export interface CheckedV2Economics {
  readonly quotedGrossAmountOut: string;
  readonly grossMinimumAfterSlippage: string;
  readonly estimatedFeeAtObservedRate: string;
  readonly maximumFeeAtSignedCap: string;
  readonly netMinimumAmountOut: string;
  readonly userMinimumNetAmountOut: string | null;
  readonly bindingMinimumSource: "slippage_and_fee_cap" | "user_minimum";
  readonly observedFeeBps: number;
  readonly maxFeeBps: number;
  readonly slippageBps: number;
}
