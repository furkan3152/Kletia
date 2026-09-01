export type ScalarHexV4 = `0x${string}`;

export type AddressRef =
  | { readonly family: "evm"; readonly chainId: number; readonly address: `0x${string}` }
  | { readonly family: "stellar"; readonly network: "testnet" | "public"; readonly address: string };

export interface PrivacyBudgetV3 {
  readonly schemaVersion: "kletia_privacy_budget_v3";
  readonly defaultLevel: "device_only" | "selected_provider" | "public_execution";
  readonly fields: Readonly<Partial<Record<
    "amount" | "recipient" | "balance" | "budget" | "strategy" | "route" | "wallet_identity" | "timing",
    "device_only" | "selected_provider" | "public_execution"
  >>>;
  readonly approvedProviders: readonly string[];
  readonly aiMode: "redacted_semantic" | "deterministic_only";
  readonly ledgerMode: "public" | "stellar_confidential_required";
  readonly failClosed: true;
}

export interface RouteCandidateV4View {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly protocols: readonly string[];
  readonly chains: readonly string[];
  readonly unavailableReason?: string;
}

export interface PolicyProfileCoreV4 {
  readonly schemaVersion: "kletia_policy_profile_core_v1";
  readonly policyId: string;
  readonly owner: AddressRef;
  readonly lane: "production" | "testnet";
  readonly allowedChains: readonly string[];
  readonly allowedProtocols: readonly string[];
  readonly allowedAssets: readonly string[];
  readonly allowedRouteProtocolSets: readonly (readonly string[])[];
  readonly allowedRouteAssetSets: readonly (readonly string[])[];
  readonly policyCircuit: "kletia_policy_v2";
  readonly verifierVersion: 2;
  readonly publicInputCount: 12;
  readonly policyRoot: ScalarHexV4;
  readonly protocolRegistryRoot: ScalarHexV4;
  readonly assetRegistryRoot: ScalarHexV4;
  readonly recipientPolicyRoot: ScalarHexV4;
  readonly privacyBudgetCommitment: ScalarHexV4;
  readonly risk: {
    readonly tolerance: "conservative" | "balanced" | "aggressive";
    readonly minimumHealthFactor: "1.5" | "1.6" | "1.8" | "2.0";
    readonly maximumSlippageBps: number;
  };
  readonly executionExpiresAtLedger: number;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly nonce: ScalarHexV4;
  readonly requireStellarControlPlane: true;
  readonly perFinancialStepWalletApproval: true;
  readonly solverMayCustodyUserFunds: false;
}

export interface PolicyProfileV4 {
  readonly schemaVersion: "kletia_policy_profile_v1";
  readonly core: PolicyProfileCoreV4;
  readonly profileHash: ScalarHexV4;
  readonly authorization: {
    readonly scheme: "stellar_sep53";
    readonly signer: AddressRef;
    readonly signature: string;
  };
}

export type PolicyRecipientMaterialV4 =
  | {
      readonly mode: "private_recipient_commitment";
      readonly commitment: ScalarHexV4;
    }
  | {
      readonly mode: "execution_wallet";
      readonly wallet: AddressRef;
    };

export interface PolicyOptionsV4 {
  readonly schemaVersion: "kletia_policy_options_v1";
  readonly lane: "production" | "testnet";
  readonly allowedChains: readonly string[];
  readonly allowedProtocols: readonly string[];
  readonly allowedAssets: readonly string[];
  readonly allowedRouteProtocolSets: readonly (readonly string[])[];
  readonly allowedRouteAssetSets: readonly (readonly string[])[];
  readonly recipientMaterials: readonly PolicyRecipientMaterialV4[];
  readonly privacyBudget: PrivacyBudgetV3;
  readonly privacyBudgetCommitment: ScalarHexV4;
  readonly routes: readonly {
    readonly id: string;
    readonly label: string;
    readonly protocolSet: readonly string[];
    readonly assetSet: readonly string[];
    readonly available: boolean;
    readonly unavailableReason?: string;
  }[];
}

export interface PolicyMerklePathV4 {
  readonly leaf: bigint;
  readonly root: bigint;
  readonly leafIndex: number;
  readonly siblings: readonly string[];
  readonly pathIndices: readonly string[];
}

export interface LocalPolicyWitnessV4 {
  readonly schemaVersion: "kletia_local_policy_witness_v2";
  readonly minimumAmountAtomic: string;
  readonly maximumAmountAtomic: string;
  readonly policySalt: string;
  readonly ownerSecret: string;
  readonly protocolTree: PolicyMerkleTreeV4;
  readonly assetTree: PolicyMerkleTreeV4;
  readonly recipientTree: PolicyMerkleTreeV4;
}

export interface SelectedPolicyWitnessV4 {
  readonly schemaVersion: "kletia_selected_policy_witness_v2";
  readonly minimumAmountAtomic: string;
  readonly maximumAmountAtomic: string;
  readonly policySalt: string;
  readonly ownerSecret: string;
  readonly protocol: PolicyMerklePathV4;
  readonly asset: PolicyMerklePathV4;
  readonly recipient: PolicyMerklePathV4;
}

export interface PolicyMerkleTreeV4 {
  readonly namespace: "protocol" | "asset" | "recipient";
  readonly depth: 16;
  readonly root: bigint;
  readonly paths: ReadonlyMap<string, PolicyMerklePathV4>;
}

export interface WorkflowPlanV4View {
  readonly version: 4;
  readonly schemaVersion: "kletia_workflow_plan_v4";
  readonly workflowId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly lane: "production" | "testnet";
  readonly selectedRouteId: string | null;
  readonly routes: readonly RouteCandidateV4View[];
  readonly executionHandoff: {
    readonly status: "not_bound" | "bound";
    readonly executor: "workflow_v2" | null;
    readonly executorWorkflowId: string | null;
    readonly parentPlanHashAtHandoff: ScalarHexV4 | null;
    readonly executorPlanCoreSha256: ScalarHexV4 | null;
    readonly executorExpiresAt: number | null;
    readonly boundAt: string | null;
    readonly progressStatus: "not_started" | "in_progress" | "completed" | "failed" | "indeterminate" | "recovery_required" | "refunded";
    readonly confirmedCheckpointCount: number;
    readonly totalCheckpointCount: number;
    readonly currentAction: string | null;
    readonly terminalReceiptSha256: ScalarHexV4 | null;
    readonly lastSyncedAt: string | null;
  };
  readonly policy: {
    readonly verified: boolean;
    readonly profileHash: ScalarHexV4 | null;
    readonly proofBinding: {
      readonly status: "not_required" | "device_proof_required" | "bound";
      readonly routeId: string | null;
      readonly verifierVersion: 2 | null;
      readonly publicInputsHash: ScalarHexV4 | null;
      readonly proofSha256: ScalarHexV4 | null;
      readonly nullifier: ScalarHexV4 | null;
      readonly executionContextCommitment: ScalarHexV4 | null;
      readonly verifiedAtLedger: string | null;
    };
  };
  readonly walletBindings: readonly AddressRef[];
  readonly controlPlane: {
    readonly ready: boolean;
    readonly network: "stellar_testnet" | "stellar_mainnet";
    readonly contractId: string | null;
    readonly reason: string | null;
    readonly externalExecutionTruthProvenByStellar: false;
    readonly commitment: {
      readonly status: "not_required" | "awaiting_policy_proof" | "awaiting_signature" | "confirmed";
      readonly transactionHash: string | null;
      readonly nonce: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptCloseByLedger: number | null;
      readonly retentionFloorLedger: number | null;
    };
  };
  readonly executionGate: {
    readonly signable: boolean;
    readonly status: string;
    readonly reasons: readonly string[];
  };
  readonly compatibility: {
    readonly engine: "workflow_v3";
    readonly plan: unknown;
  };
}

export interface PolicyChallengeV4 {
  readonly schemaVersion: "kletia_policy_challenge_v2";
  readonly routeId: string;
  readonly workflowRoot: ScalarHexV4;
  readonly policyRoot: ScalarHexV4;
  readonly protocolRegistryRoot: ScalarHexV4;
  readonly assetRegistryRoot: ScalarHexV4;
  readonly recipientPolicyRoot: ScalarHexV4;
  readonly selectedProtocolLeaf: ScalarHexV4;
  readonly selectedAssetLeaf: ScalarHexV4;
  readonly selectedRecipientLeaf: ScalarHexV4;
  readonly environmentLane: 0 | 1;
  readonly executionExpiresAtLedger: number;
  readonly verifierVersion: 2;
}

export interface DevicePolicyProofEnvelopeV4 extends Omit<PolicyChallengeV4, "schemaVersion"> {
  readonly schemaVersion: "kletia_policy_proof_envelope_v2";
  readonly nullifier: ScalarHexV4;
  readonly executionContextCommitment: ScalarHexV4;
  readonly proof: `0x${string}`;
}
