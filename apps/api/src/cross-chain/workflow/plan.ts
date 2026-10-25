/**
 * Workflow plan types and the actions a workflow may contain.
 */
import type { Address, Hex } from "viem";
import type { NetworkId } from "../../shared/config/networks.js";

export type WorkflowStepStatus =
  | "planned"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "filled"
  | "ready"
  | "failed"
  | "refunded"
  | "indeterminate";

export interface WorkflowSemanticStep {
  readonly id: string;
  readonly order: number;
  readonly action: string;
  readonly network: NetworkId;
  readonly chainId: 8453 | 5042002 | 42161;
  readonly tokenIn?: string;
  readonly tokenOut?: string;
  readonly amount: string;
  readonly amountSource?: "explicit" | "wallet_balance" | "previous_output";
  readonly protocol?: string;
  readonly destinationChain?: string;
  readonly objective?: string;
  readonly url?: string;
  readonly method?: "GET";
  readonly maxPayment?: string;
  readonly dependsOn: readonly string[];
  readonly status: WorkflowStepStatus;
  readonly expectedOutputAtomic?: string;
  readonly actualOutputAtomic?: string;
  readonly outputTokenAddress?: Address;
  readonly execution?: {
    readonly target: Address;
    readonly calldataHash: Hex;
    readonly value: string;
    readonly quoteExpiresAt: number;
  };
  readonly payment?: {
    readonly asset: Address;
    readonly payTo: Address;
    readonly amountAtomic: string;
    readonly requestUrl: string;
    readonly observedAt: string;
  };
  readonly txHash?: Hex;
  readonly fillTxHash?: Hex;
  readonly authorizationNonce?: Hex;
  readonly readResult?: {
    readonly kind: "borrow_capacity";
    readonly protocolId: "aave-v3";
    readonly asset: string;
    readonly safeAmountAtomic: string;
    readonly safeAmount: string;
    readonly targetHealthFactor: string;
    readonly observedAtBlock: string;
    readonly mockData: false;
  };
}

export interface WorkflowPlanV1 {
  readonly version: 1;
  readonly workflowId: string;
  readonly requestId: string;
  readonly userAddress: Address;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly objective: "risk_adjusted_net_return";
  readonly atomicity: {
    readonly sameChain: "wallet_batch_when_verified";
    readonly crossChain: "staged_checkpointed_no_global_rollback";
  };
  readonly hardPolicies: {
    readonly minimumHealthFactor: "1.5";
    readonly requiresPerStepWalletApproval: true;
    readonly mockDataAllowed: false;
  };
  readonly currentStepIndex: number;
  readonly steps: readonly WorkflowSemanticStep[];
}

export type MutableWorkflowPlan = Omit<WorkflowPlanV1, "steps" | "currentStepIndex"> & {
  currentStepIndex: number;
  steps: WorkflowSemanticStep[];
};

const ARC_WORKFLOW_ACTIONS = new Set([
  "swap",
  "stake",
  "unstake",
  "vault_deposit",
  "vault_withdraw",
  "lending_deposit",
  "lending_withdraw",
  "lending_borrow",
  "lending_repay",
]);

export function workflowActionAllowed(network: NetworkId, action: string): boolean {
  if (network === "base") {
    return ["swap", "bridge", "data_purchase", "gas_acquire"].includes(action);
  }
  if (network === "arc") return ARC_WORKFLOW_ACTIONS.has(action);
  return !["bridge", "data_purchase", "gas_acquire"].includes(action);
}
