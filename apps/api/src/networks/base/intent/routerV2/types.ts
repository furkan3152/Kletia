/**
 * Router V2 error, adapter and deployment evidence, execution config,
 * reviewed route and swap plan types.
 */
import type { Address, Hex } from "viem";
import { PUBLIC_ERRORS } from "./constants.js";

export type BaseIntentV2PlanErrorCode = keyof typeof PUBLIC_ERRORS;

export class BaseIntentV2PlanError extends Error {
  readonly code: BaseIntentV2PlanErrorCode;
  readonly statusCode: number;

  constructor(code: BaseIntentV2PlanErrorCode) {
    const definition = PUBLIC_ERRORS[code];
    super(definition.message);
    this.name = "BaseIntentV2PlanError";
    this.code = code;
    this.statusCode = definition.statusCode;
  }
}

export interface BaseIntentV2UniV2AdapterEvidence {
  readonly kind: "uniswap_v2_compatible";
  readonly reviewStatus: "reviewed";
  readonly protocolId: string;
  readonly policyKey?: string;
  readonly enabled: true;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly adapterCodehash: Hex;
  readonly targetCodehash: Hex;
  readonly spenderCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly adapterConfigurationHash: Hex;
  readonly adapterConfigHash: Hex;
}

export interface BaseIntentV2UniV3AdapterEvidence {
  readonly kind: "uniswap_v3_swaprouter02";
  readonly reviewStatus: "reviewed";
  readonly protocolId: string;
  readonly policyKey: string;
  readonly enabled: true;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly adapterCodehash: Hex;
  readonly targetCodehash: Hex;
  readonly spenderCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly adapterFormatVersion: Hex;
  readonly adapterConfigurationHash: Hex;
  readonly adapterConfigHash: Hex;
}

export type BaseIntentV2AdapterEvidence =
  BaseIntentV2UniV2AdapterEvidence | BaseIntentV2UniV3AdapterEvidence;

export type BaseIntentV2DeploymentSchemaVersion =
  "kletia_base_intent_v2_deployment_v1" | "kletia_base_intent_v2_deployment_v2";

export interface BaseIntentV2DeploymentEvidence {
  readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
  readonly validationStatus: "validated";
  readonly chainId: 8453;
  readonly observedAtBlock: bigint;
  readonly router: Address;
  readonly routerCodehash: Hex;
  readonly wrappedNative: Address;
  readonly wrappedNativeCodehash: Hex;
  readonly feeBps: number;
  readonly adapters: readonly BaseIntentV2AdapterEvidence[];
}

export interface LegacyV1ExecutionConfig {
  readonly mode: "legacy_v1";
}

export interface IntentV2ExecutionConfig {
  readonly mode: "intent_v2";
  readonly chainId: 8453;
  readonly router: Address;
  readonly deployment: BaseIntentV2DeploymentEvidence;
}

export type BaseSwapExecutionConfig =
  LegacyV1ExecutionConfig | IntentV2ExecutionConfig;

export interface ReviewedUniV2ExactInputRoute {
  readonly kind: "uniswap_v2_compatible";
  readonly reviewStatus: "reviewed";
  readonly quoteStatus: "quoted";
  readonly chainId: 8453;
  readonly protocolId: string;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly slippageBps: number;
  readonly path: readonly Address[];
}

export interface ReviewedUniV3ExactInputRoute {
  readonly kind: "uniswap_v3_swaprouter02";
  readonly reviewStatus: "reviewed";
  readonly quoteStatus: "quoted";
  readonly chainId: 8453;
  readonly protocolId: string;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly slippageBps: number;
  readonly packedPath: Hex;
}

export type ReviewedBaseIntentV2ExactInputRoute =
  ReviewedUniV2ExactInputRoute | ReviewedUniV3ExactInputRoute;

export interface BuildBaseIntentV2SwapPlanInput {
  readonly executionConfig: BaseSwapExecutionConfig;
  readonly route: ReviewedBaseIntentV2ExactInputRoute;
  readonly owner: Address;
  readonly recipient: Address;
  readonly nonce: bigint;
  readonly issuedAt: bigint;
  readonly validAfter: bigint;
  readonly deadline: bigint;
  readonly now: bigint;
  readonly executor: Address;
  readonly maxFeeBps: number;
  readonly minimumNetAmountOut?: bigint;
}

export interface BaseIntentV2SerializableSwapIntent {
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

export interface BaseIntentV2SwapPlan {
  readonly chainId: 8453;
  readonly executionMode: "kletia_intent_router_v2";
  readonly targetContract: Address;
  readonly router: Address;
  readonly adapter: Address;
  readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
  readonly adapterDataEncoding:
    "abi_address_array_v1" | "uniswap_v3_packed_path_v1";
  readonly underlyingTarget: Address;
  readonly underlyingSpender: Address;
  readonly underlyingFactory: Address;
  readonly wrappedNative: Address;
  readonly calldata: Hex;
  readonly value: string;
  readonly adapterData: Hex;
  readonly intent: BaseIntentV2SerializableSwapIntent;
  readonly approvals: readonly {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: string;
    readonly calldata: Hex;
    readonly required: true;
  }[];
  readonly policyTargets: readonly Address[];
  readonly economics: {
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
  };
  readonly configEvidence: {
    readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
    readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
    readonly observedAtBlock: string;
    readonly routerCodehash: Hex;
    readonly wrappedNativeCodehash: Hex;
    readonly adapterConfigHash: Hex;
    readonly adapterConfigurationHash: Hex;
  };
}
