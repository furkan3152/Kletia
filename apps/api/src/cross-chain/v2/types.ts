export type WorkflowEnvironmentLane = "production" | "testnet";
export type WorkflowV2Network =
  | "arc_testnet"
  | "stellar_testnet"
  | "arbitrum_sepolia";
export type WorkflowV2RouteKind =
  | "direct_cctp"
  | "stellar_centered_public";
export type WorkflowV2Status =
  | "planned"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "attesting"
  | "filled"
  | "ready"
  | "failed"
  | "refunded"
  | "indeterminate"
  | "recovery_required";

export type WorkflowPolicyAnchorMode =
  | "local_manifest"
  | "stellar_public_registry";

export type WorkflowWalletBinding =
  | {
      readonly id: "arc_wallet" | "arbitrum_sepolia_wallet";
      readonly family: "evm";
      readonly network: "arc_testnet" | "arbitrum_sepolia";
      readonly address: `0x${string}`;
    }
  | {
      readonly id: "stellar_wallet";
      readonly family: "stellar";
      readonly network: "stellar_testnet";
      readonly address: string;
    };

export type WorkflowAssetBinding =
  | {
      readonly family: "evm";
      readonly network: "arc_testnet" | "arbitrum_sepolia";
      readonly symbol: "USDC";
      readonly address: `0x${string}`;
      readonly decimals: 6;
    }
  | {
      readonly family: "stellar";
      readonly network: "stellar_testnet";
      readonly symbol: "USDC";
      readonly code: "USDC";
      readonly issuer: string;
      readonly sac: string;
      readonly decimals: 7;
    };

export interface PrivacyDisclosure {
  readonly field:
    | "amount"
    | "recipient"
    | "balance"
    | "timing"
    | "route"
    | "wallet_identity"
    | "workflow_linkage"
    | "policy_commitment"
    | "privacy_budget_commitment"
    | "receipt_hash";
  readonly visibleTo: readonly (
    | "device"
    | "wallet_extension"
    | "kletia_ai"
    | "kletia_api"
    | "circle"
    | "rpc"
    | "public_ledger"
  )[];
  readonly reason: string;
}

export interface WorkflowV2Step {
  readonly id: string;
  readonly order: number;
  readonly action:
    | "cctp_approve"
    | "cctp_burn"
    | "cctp_attestation"
    | "cctp_mint"
    | "aave_approve"
    | "aave_supply"
    | "borrow_capacity"
    | "stellar_policy_commit"
    | "stellar_receipt_finalize";
  readonly network: WorkflowV2Network;
  readonly walletBinding: WorkflowWalletBinding["id"] | "circle_attestation";
  readonly dependsOn: readonly string[];
  readonly status: WorkflowV2Status;
  readonly amount:
    | { readonly source: "private_commitment"; readonly commitment: `0x${string}` }
    | { readonly source: "previous_output" }
    | { readonly source: "none" };
  readonly target?: string;
  readonly binding?: {
    readonly protocol:
      | "cctp_v2"
      | "aave_v3"
      | "kletia_policy_registry";
    readonly method: string;
    readonly sourceDomain?: 26 | 27;
    readonly destinationDomain?: 3 | 27;
    readonly recipientBinding?:
      | "stellar_forwarder"
      | "stellar_wallet"
      | "arbitrum_sepolia_wallet";
    readonly destinationCaller?: "stellar_forwarder" | "open";
    readonly finalityThreshold?: 2_000;
    readonly policyRegistryCall?:
      | {
          readonly schemaVersion: "kletia_policy_registry_call_v1";
          readonly operation: "commit";
          readonly owner: string;
          readonly nonce: string;
          readonly policyCommitment: `0x${string}`;
          readonly privacyBudgetCommitment: `0x${string}`;
          readonly executionExpiresAtLedger: number;
          readonly receiptCloseByLedger: number;
          readonly retentionFloorLedger: number;
          readonly expectedWasmSha256: string;
          readonly stateObservedAtLedger: number;
          readonly recordingSimulationLatestLedger: number;
          readonly invocationSha256: `0x${string}`;
          readonly enforcingSimulationRequiredBeforeSigning: true;
        }
      | {
          readonly schemaVersion: "kletia_policy_registry_call_v1";
          readonly operation: "finalize";
          readonly owner: string;
          readonly nonce: string;
          readonly receiptHash: `0x${string}`;
          readonly executionPlanCoreSha256: `0x${string}`;
          readonly executionManifestSha256: `0x${string}`;
          readonly executionPrivacyBudgetSha256: `0x${string}`;
          readonly executionDisclosureDiffSha256: `0x${string}`;
          readonly checkpointEvidenceSha256: `0x${string}`;
          readonly receiptGeneratedAt: string;
          readonly expectedWasmSha256: string;
          readonly stateObservedAtLedger: number;
          readonly recordingSimulationLatestLedger: number;
          readonly invocationSha256: `0x${string}`;
          readonly enforcingSimulationRequiredBeforeSigning: true;
        };
  };
  readonly deadline?: number;
  readonly evidenceRequired: readonly string[];
  readonly disclosure: readonly PrivacyDisclosure[];
  readonly result?: {
    readonly kind: "evm_transaction" | "stellar_transaction" | "circle_attestation" | "read_result";
    readonly reference: string;
    readonly observedAt: string;
    readonly blockOrLedger?: string;
    readonly amountAtomic?: string;
    readonly feeAtomic?: string;
    readonly maxFeeAtomic?: string;
    readonly feeQuoteBps?: number;
    readonly feeQuoteObservedAt?: string;
    readonly nonce?: string;
    readonly message?: string;
    readonly attestation?: string;
    readonly safeBorrowCapacityAtomic?: string;
    readonly capacityStatus?: "theoretical_read_only" | "borrowing_disabled";
    readonly targetHealthFactor?: string;
    readonly limitations?: readonly string[];
    readonly policyRegistry?: {
      readonly schemaVersion: "kletia_policy_registry_evidence_v1";
      readonly contractId: string;
      readonly method: "commit" | "finalize";
      readonly owner: string;
      readonly nonce: string;
      readonly eventName: "policy_committed" | "policy_finalized";
      readonly effectiveStatus:
        | "Active"
        | "ExecutionExpiredAwaitingReceipt"
        | "ReceiptWindowClosed"
        | "Finalized"
        | "Cancelled";
      readonly recordStatus: "Active" | "Finalized" | "Cancelled";
      readonly policyCommitment?: `0x${string}`;
      readonly privacyBudgetCommitment?: `0x${string}`;
      readonly receiptHash?: `0x${string}`;
      readonly externalTruthProven: false;
    };
  };
}

export type WorkflowPolicyAnchorV2 =
  | {
      readonly schemaVersion: "kletia_workflow_policy_anchor_v1";
      readonly mode: "local_manifest";
      readonly onchainAnchor: false;
      readonly limitations: readonly [
        "The signed manifest is kept in the sealed application workflow and is not written to an onchain registry.",
      ];
    }
  | {
      readonly schemaVersion: "kletia_workflow_policy_anchor_v1";
      readonly mode: "stellar_public_registry";
      readonly onchainAnchor: true;
      readonly network: "stellar_testnet";
      readonly contractId: string;
      readonly owner: string;
      readonly nonce: string;
      readonly policyCommitment: `0x${string}`;
      readonly privacyBudgetCommitment: `0x${string}`;
      readonly commitmentSchemes: {
        readonly policy: "KLETIA_POLICY_COMMITMENT_V1";
        readonly policyEnvelope: "KLETIA_POLICY_ENVELOPE_V1";
        readonly privacyBudget: "KLETIA_PRIVACY_BUDGET_COMMITMENT_V1";
        readonly browserGeneratedBlindedPreimages: true;
        readonly rawBlindReceivedByApi: false;
        readonly mutableQuotesAndCheckpointStatusExcluded: true;
      };
      readonly executionExpiresAtLedger: number;
      readonly receiptCloseByLedger: number;
      readonly retentionFloorLedger: number;
      readonly stateObservedAtLedger: number;
      readonly recordingSimulationLatestLedger: number;
      readonly commitInvocationSha256: `0x${string}`;
      readonly expectedWasmSha256: string;
      readonly finalization:
        | {
            readonly status: "pending_execution_receipt";
            readonly ownerAcknowledgementRequired: true;
          }
        | {
            readonly status: "awaiting_owner_signature";
            readonly ownerAcknowledgementRequired: true;
            readonly receiptHash: `0x${string}`;
          }
        | {
            readonly status: "finalized";
            readonly ownerAcknowledgementRequired: true;
            readonly receiptHash: `0x${string}`;
            readonly transactionHash: string;
          };
      readonly limitations: readonly string[];
    };

export interface WorkflowRouteCandidateV2 {
  readonly kind: WorkflowV2RouteKind;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly networks: readonly WorkflowV2Network[];
  readonly estimatedDurationSeconds: { readonly minimum: number; readonly maximum: number };
  readonly privacyGain: "private_intent_only";
  /**
   * The raw, unscaled disclosure weight of the route as priced by RouteGraphV1.
   * It is reported alongside the score so a reviewer can see the gross cost
   * before the unlinkability credit is applied.
   */
  readonly disclosureCost: number;
  readonly failureRiskScore: number;
  readonly rankingReason: string;
  readonly score: {
    readonly methodology: "kletia_normalized_route_score_v2";
    readonly lowerIsBetter: true;
    readonly bridgeFeeBps: number;
    readonly latencyPenalty: number;
    readonly failurePenalty: number;
    /**
     * Net disclosure term: the gross per-(field, observer) weight minus the
     * ledger unlinkability credit, divided by `disclosureScale`. This is the
     * value that actually participates in `total`, so disclosure is no longer
     * inert in route ranking.
     */
    readonly disclosurePenalty: number;
    readonly disclosureRawWeight: number;
    readonly ledgerLinkageCredit: number;
    readonly correlationDomainsRequired: number;
    readonly disclosureScale: number;
    readonly apyCredit: number;
    readonly total: number;
    readonly limitations: readonly string[];
  };
  /**
   * The per-observer disclosure breakdown behind `score.disclosurePenalty`.
   * Exposed so the ranking is auditable rather than asserted.
   */
  readonly disclosureProfile: {
    readonly schemaVersion: "kletia_route_disclosure_profile_v1";
    readonly rawWeight: number;
    readonly scale: number;
    readonly pairs: readonly {
      readonly field: PrivacyDisclosure["field"];
      readonly observer: string;
      readonly weight: number;
    }[];
    readonly ledgerObservers: readonly string[];
    readonly correlationDomainsRequired: number;
    readonly ledgerLinkageCredit: number;
    readonly netPenalty: number;
    readonly reasoning: string;
    readonly limitations: readonly string[];
  };
  /** Which graph edges this candidate traverses. */
  readonly routeGraph: {
    readonly schemaVersion: "kletia_route_graph_v1";
    readonly edgeIds: readonly string[];
    readonly traversedNodes: readonly string[];
    readonly stepCount: number;
  };
  readonly liveEvidence: {
    readonly observedAt: string;
    readonly quoteExpiresAt: number;
    readonly cctpStandardFeeBps: number;
    readonly cctpHops: 1 | 2;
    readonly cctpLegs: readonly {
      readonly sourceDomain: 26 | 27;
      readonly destinationDomain: 3 | 27;
      readonly standardFeeBps: number;
    }[];
    readonly aaveSupplyApyBps: number;
    readonly sources: readonly ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"];
  };
}

export interface WorkflowPlanV2 {
  readonly version: 2;
  readonly schemaVersion: "kletia_workflow_plan_v2";
  readonly workflowId: string;
  readonly requestId: string;
  readonly environmentLane: "testnet";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly recoveryExpiresAt: number;
  readonly authorizationRefreshedAt?: number;
  readonly objective: "risk_adjusted_net_return_with_disclosure";
  readonly semanticGoal: string;
  /**
   * Present only when WorkflowPlanV2 is the exact financial executor selected
   * by a sealed WorkflowPlanV3 control-plane lifecycle. The parent binding is
   * part of the signed V2 plan core and caps every refreshed authorization.
   */
  readonly parentWorkflowV3?: {
    readonly schemaVersion: "kletia_workflow_v3_execution_parent_v1";
    readonly workflowId: string;
    readonly workflowRoot: `0x${string}`;
    readonly planHashAtHandoff: `0x${string}`;
    readonly expiresAt: number;
    readonly controlPlaneTransactionHash: string;
    readonly receiptRegistryTransactionHash: string;
    readonly externalExecutionTruthProvenByStellar: false;
  };
  readonly parentWorkflowV4?: {
    readonly schemaVersion: "kletia_workflow_v4_execution_parent_v1";
    readonly workflowId: string;
    readonly workflowRoot: `0x${string}`;
    readonly planHashAtHandoff: `0x${string}`;
    readonly expiresAt: number;
    readonly controlPlaneContractId: string;
    readonly controlPlaneTransactionHash: string;
    readonly controlPlaneNonce: string;
    readonly policyProofPublicInputsHash: `0x${string}`;
    readonly externalExecutionTruthProvenByStellar: false;
  };
  readonly policyAnchor: WorkflowPolicyAnchorV2;
  readonly authorizationBoundary: {
    readonly schemaVersion: "kletia_workflow_authorization_boundary_v2";
    readonly planCoreSha256: `0x${string}`;
    readonly manifestMessage: string;
    readonly requiredStepSigners: readonly WorkflowWalletBinding["id"][];
    readonly invalidatedBy: readonly [
      "wallet_change",
      "asset_change",
      "route_change",
      "target_or_method_change",
      "deadline_change",
      "fee_quote_change",
      "privacy_policy_change",
    ];
  };
  readonly manifestAuthorization?: {
    readonly family: "evm" | "stellar";
    readonly signer: string;
    readonly signature: string;
    readonly manifestSha256: `0x${string}`;
    readonly verifiedAt: string;
  };
  readonly walletBindings: readonly WorkflowWalletBinding[];
  readonly assets: readonly WorkflowAssetBinding[];
  readonly routeCandidates: readonly WorkflowRouteCandidateV2[];
  readonly selectedRoute: WorkflowV2RouteKind;
  readonly routeSelection: {
    readonly mode: "auto" | "explicit";
    readonly selectedScore: number;
    readonly rationale: string;
    readonly amountDependentCostsExcluded: true;
  };
  readonly currentStepIndex: number;
  readonly steps: readonly WorkflowV2Step[];
  /**
   * Present only after every reviewed executor checkpoint reached a terminal,
   * independently verified state. This summary is authenticated by the V2
   * bearer seal but deliberately excluded from the financial authorization
   * core: it records execution evidence and can never authorize a call.
   */
  readonly terminalReceipt?: {
    readonly schemaVersion: "kletia_workflow_terminal_receipt_v1";
    readonly receiptSha256: `0x${string}`;
    readonly generatedAt: string;
    readonly checkpointCount: number;
    readonly executorPlanCoreSha256: `0x${string}`;
    readonly externalExecutionTruthProvenByStellar: false;
  };
  readonly privacy: {
    readonly scope: "browser_private_fields_public_ledger";
    readonly semanticPlanner:
      | "openrouter_constrained"
      | "deterministic_registry";
    readonly privateFieldIsolationRequested: true;
    readonly onchainConfidentiality: "none";
    readonly privateAmountExcludedFromSemanticRequest: true;
    readonly recipientExcludedFromSemanticRequest: true;
    readonly rawPrivateAmountReceivedDuringPlanning: false;
    readonly recipientReceivedAsPublicWalletBinding: true;
    readonly publicAmountOpeningRequired: true;
    readonly amountCommitment: `0x${string}`;
    readonly recipientCommitment: `0x${string}`;
    readonly boundaryMap: {
      readonly schemaVersion: "kletia_privacy_boundary_map_v1";
      readonly planning: readonly PrivacyDisclosure[];
      readonly checkpoints: readonly {
        readonly stepId: string;
        readonly network: WorkflowV2Network;
        readonly action: WorkflowV2Step["action"];
        readonly disclosure: readonly PrivacyDisclosure[];
      }[];
      readonly commitmentOpeningSchedule: readonly [
        {
          readonly field: "amount";
          readonly openingStep: string;
          readonly reason: string;
        },
        {
          readonly field: "recipient";
          readonly openingStep: string;
          readonly reason: string;
        },
      ];
    };
    /**
     * User-selected, fail-closed disclosure policy. This is part of the
     * immutable plan core and therefore changing it invalidates the manifest
     * signature.
     */
    readonly privacyBudget: import("./privacyPolicy.js").PrivacyBudgetV1;
    /**
     * Per-checkpoint knowledge delta derived from the exact selected route.
     * It reports declared visibility; it is not an anonymity proof.
     */
    readonly disclosureDiff: import("./privacyPolicy.js").DisclosureDiffV1;
    readonly limitations: readonly string[];
  };
  readonly policies: {
    readonly requiresPerStepWalletApproval: true;
    readonly crossChainAtomicity: "staged_checkpointed_no_global_rollback";
    readonly minimumHealthFactor: "1.5";
    readonly mockDataAllowed: false;
    readonly environmentMixingAllowed: false;
    readonly silentRetryAllowed: false;
  };
}

export interface WorkflowIntentV2Result {
  readonly success: true;
  readonly status: "success";
  readonly executionKind: "workflow_plan_v2";
  readonly message: string;
  readonly network: "stellar";
  readonly chainRef: "stellar:testnet";
  readonly requestId: string;
  readonly workflowPlan: WorkflowPlanV2;
  readonly workflowToken: string;
}
