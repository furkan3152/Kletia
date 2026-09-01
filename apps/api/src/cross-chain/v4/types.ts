import type {
  AddressRef,
  AssetRef,
  ChainRef,
  DisclosureDeltaV3,
  EnvironmentLane,
  EvidenceLevel,
  IntentLegV3,
  PrivacyBudgetV3,
  RouteCandidateV3,
  WorkflowPlanV3,
} from "../v3/types.js";

export type CapabilityStageV4 =
  | "discover"
  | "quote"
  | "hydrate"
  | "simulate"
  | "execute"
  | "verify"
  | "recover";

export type CapabilityStageReadinessV4 =
  | "ready"
  | "legacy_only"
  | "capability_disabled"
  | "adapter_required"
  | "deployment_required"
  | "unavailable";

export interface CapabilityEdgeV1 {
  readonly schemaVersion: "kletia_capability_edge_v1";
  readonly id: string;
  readonly lane: EnvironmentLane;
  readonly source: ChainRef["key"];
  readonly destination: ChainRef["key"];
  readonly protocol: string;
  readonly operations: readonly string[];
  readonly stages: Readonly<Record<CapabilityStageV4, CapabilityStageReadinessV4>>;
  readonly exactBinding:
    | "v4_exact"
    | "reviewed_v3"
    | "reviewed_v2"
    | "network_local_legacy"
    | "read_only";
  readonly officialSources: readonly string[];
  readonly limitations: readonly string[];
  readonly mockDataAllowed: false;
}

export interface NetworkRoleV4 {
  readonly chain: ChainRef["key"];
  readonly lane: EnvironmentLane;
  readonly role:
    | "intent_control_policy_receipt_center"
    | "stablecoin_agent_hub"
    | "liquidity_execution_domain";
  readonly readiness: "live_legacy" | "capability_gated" | "deployment_required";
  readonly responsibilities: readonly string[];
  readonly nonClaims: readonly string[];
}

export interface PolicyProfileCoreV1 {
  readonly schemaVersion: "kletia_policy_profile_core_v1";
  readonly policyId: string;
  readonly owner: AddressRef;
  readonly lane: EnvironmentLane;
  readonly allowedChains: readonly ChainRef["key"][];
  readonly allowedProtocols: readonly string[];
  readonly allowedAssets: readonly string[];
  /** Canonical protocol combinations the user permits one route to use. */
  readonly allowedRouteProtocolSets: readonly (readonly string[])[];
  /** Canonical network-specific asset combinations the user permits one route to use. */
  readonly allowedRouteAssetSets: readonly (readonly string[])[];
  /**
   * BN254 field commitments produced on-device before route selection.
   * policyRoot binds the private min/max amount, lane, expiry, the three
   * allowlist roots and a private salt in KletiaPolicyV2.
   */
  readonly policyCircuit: "kletia_policy_v2";
  readonly verifierVersion: 2;
  readonly publicInputCount: 12;
  readonly policyRoot: `0x${string}`;
  readonly protocolRegistryRoot: `0x${string}`;
  readonly assetRegistryRoot: `0x${string}`;
  readonly recipientPolicyRoot: `0x${string}`;
  readonly privacyBudgetCommitment: `0x${string}`;
  readonly risk: {
    readonly tolerance: "conservative" | "balanced" | "aggressive";
    readonly minimumHealthFactor: "1.5" | "1.6" | "1.8" | "2.0";
    readonly maximumSlippageBps: number;
  };
  /** Exact public Stellar ledger expiry bound inside policyRoot. */
  readonly executionExpiresAtLedger: number;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly nonce: `0x${string}`;
  readonly requireStellarControlPlane: true;
  readonly perFinancialStepWalletApproval: true;
  readonly solverMayCustodyUserFunds: false;
}

export interface PolicyProfileV1 {
  readonly schemaVersion: "kletia_policy_profile_v1";
  readonly core: PolicyProfileCoreV1;
  readonly profileHash: `0x${string}`;
  readonly authorization: {
    readonly scheme: "stellar_sep53";
    readonly signer: AddressRef;
    readonly signature: string;
    readonly verifiedAt: string;
  };
}

export interface IntentIRV4 {
  readonly schemaVersion: "kletia_intent_ir_v4";
  readonly requestId: string;
  readonly semanticGoal: string;
  readonly lane: EnvironmentLane;
  readonly legs: readonly IntentLegV3[];
  readonly privateBindings: readonly {
    readonly field: "amount" | "recipient" | "budget";
    readonly reference: `private://${string}`;
    readonly commitment: `0x${string}`;
  }[];
  readonly privacyBudget: PrivacyBudgetV3;
  readonly policyProfile: PolicyProfileV1 | null;
  readonly unresolved: readonly {
    readonly field: string;
    readonly question: string;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
      readonly effect: string;
    }[];
  }[];
}

export interface WorkflowPlanV4 {
  readonly version: 4;
  readonly schemaVersion: "kletia_workflow_plan_v4";
  readonly workflowId: string;
  readonly requestId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lane: EnvironmentLane;
  readonly intent: IntentIRV4;
  readonly walletBindings: readonly AddressRef[];
  readonly policy: {
    readonly required: boolean;
    readonly verified: boolean;
    readonly profileHash: `0x${string}` | null;
    readonly authorizationScheme: "stellar_sep53" | null;
    readonly constraintsAppliedBeforeRouteSelection: true;
    readonly proofBinding: {
      readonly status: "not_required" | "device_proof_required" | "bound";
      readonly routeId: string | null;
      readonly verifierVersion: 2 | null;
      readonly publicInputsHash: `0x${string}` | null;
      readonly proofSha256: `0x${string}` | null;
      readonly nullifier: `0x${string}` | null;
      readonly executionContextCommitment: `0x${string}` | null;
      readonly verifiedAtLedger: string | null;
    };
  };
  readonly controlPlane: {
    readonly requiredForEveryFinancialIntent: true;
    readonly network: "stellar_testnet" | "stellar_mainnet";
    readonly failClosedWhenUnavailable: true;
    readonly readOnlyMayContinueWhenUnavailable: true;
    readonly ready: boolean;
    /** Exact live-attested V2 contract. Null until deployment readiness passes. */
    readonly contractId: string | null;
    readonly reason: string | null;
    readonly externalExecutionTruthProvenByStellar: false;
    readonly commitment: {
      readonly status:
        | "not_required"
        | "awaiting_policy_proof"
        | "awaiting_signature"
        | "confirmed";
      readonly transactionHash: string | null;
      readonly nonce: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptCloseByLedger: number | null;
      readonly retentionFloorLedger: number | null;
    };
  };
  readonly capabilityEdges: readonly CapabilityEdgeV1[];
  readonly routes: readonly RouteCandidateV3[];
  readonly selectedRouteId: string | null;
  readonly currentStepId: string | null;
  readonly executionHandoff: {
    readonly status: "not_bound" | "bound";
    readonly executor: "workflow_v2" | null;
    readonly executorWorkflowId: string | null;
    readonly parentPlanHashAtHandoff: `0x${string}` | null;
    readonly executorPlanCoreSha256: `0x${string}` | null;
    readonly executorExpiresAt: number | null;
    readonly boundAt: string | null;
    readonly progressStatus: "not_started" | "in_progress" | "completed" | "failed" | "indeterminate" | "recovery_required" | "refunded";
    readonly confirmedCheckpointCount: number;
    readonly totalCheckpointCount: number;
    readonly currentAction: string | null;
    readonly terminalReceiptSha256: `0x${string}` | null;
    readonly lastSyncedAt: string | null;
  };
  readonly privacy: {
    readonly budget: PrivacyBudgetV3;
    readonly disclosureDiff: readonly DisclosureDeltaV3[];
    readonly rawPrivateFieldsReceivedByAi: false;
    readonly rawPrivateFieldsReceivedByApi: false;
    readonly publicLedgerDisclosureStillApplies: true;
  };
  readonly evidencePolicy: {
    readonly minimumLevel: EvidenceLevel;
    readonly transactionHashAloneIsSuccess: false;
    readonly indeterminateMayRetryAutomatically: false;
  };
  readonly executionGate: {
    readonly signable: boolean;
    readonly status:
      | "read_only"
      | "ready"
      | "clarification_required"
      | "policy_required"
      | "policy_proof_required"
      | "control_plane_commit_required"
      | "control_plane_unavailable"
      | "reviewed_executor_bound"
      | "exact_adapter_required";
    readonly reasons: readonly string[];
  };
  readonly compatibility: {
    readonly engine: "workflow_v3";
    readonly planHash: `0x${string}`;
    readonly plan: WorkflowPlanV3;
    readonly v3ExecutionTokenExposed: false;
  };
}

export interface IntentInterpretationV4 {
  readonly schemaVersion: "kletia_intent_interpretation_v4";
  readonly requestId: string;
  readonly semanticGoal: string;
  readonly lane: EnvironmentLane | null;
  readonly legs: readonly IntentLegV3[];
  readonly privateReferences: readonly string[];
  readonly questions: IntentIRV4["unresolved"];
  readonly rawPrivateFieldsReceivedByApi: false;
  readonly deterministicCompilerRequired: true;
}

export type { AddressRef, AssetRef, ChainRef, EnvironmentLane };
