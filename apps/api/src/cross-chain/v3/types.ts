export type EnvironmentLane = "production" | "testnet";

export type EvmChainId = 8453 | 42_161 | 5_042_002 | 421_614;

export type ChainRef =
  | {
      readonly family: "evm";
      readonly chainId: EvmChainId;
      readonly key:
        | "base_mainnet"
        | "arbitrum_one"
        | "arc_testnet"
        | "arbitrum_sepolia";
      readonly caip2: `eip155:${EvmChainId}`;
      readonly lane: EnvironmentLane;
    }
  | {
      readonly family: "stellar";
      readonly network: "testnet" | "public";
      readonly key: "stellar_testnet" | "stellar_mainnet";
      readonly caip2: "stellar:testnet" | "stellar:public";
      readonly lane: EnvironmentLane;
      readonly networkPassphrase: string;
    };

export type AddressRef =
  | {
      readonly family: "evm";
      readonly chainId: EvmChainId;
      readonly address: `0x${string}`;
    }
  | {
      readonly family: "stellar";
      readonly network: "testnet" | "public";
      readonly address: string;
    };

export type AssetRef =
  | {
      readonly family: "evm";
      readonly chainId: EvmChainId;
      readonly symbol: string;
      readonly decimals: number;
      readonly address: `0x${string}` | null;
      readonly native: boolean;
    }
  | {
      readonly family: "stellar";
      readonly network: "testnet" | "public";
      readonly symbol: string;
      readonly code: string;
      readonly issuer: string | null;
      readonly sac: string | null;
      readonly decimals: 7;
      readonly native: boolean;
    };

export type PrivacyField =
  | "amount"
  | "recipient"
  | "balance"
  | "budget"
  | "strategy"
  | "route"
  | "wallet_identity"
  | "timing";

export type DisclosureLevel =
  | "device_only"
  | "selected_provider"
  | "public_execution";

export interface PrivacyBudgetV3 {
  readonly schemaVersion: "kletia_privacy_budget_v3";
  readonly defaultLevel: DisclosureLevel;
  readonly fields: Readonly<Partial<Record<PrivacyField, DisclosureLevel>>>;
  readonly approvedProviders: readonly string[];
  readonly aiMode: "redacted_semantic" | "deterministic_only";
  readonly ledgerMode: "public" | "stellar_confidential_required";
  readonly failClosed: true;
}

export interface SensitiveFieldBindingV3 {
  readonly field: "amount" | "recipient" | "budget";
  readonly reference: `private://${string}`;
  readonly commitment: `0x${string}`;
  readonly disclosureLevel: DisclosureLevel;
}

export type IntentOperationV3 =
  | "portfolio"
  | "trustline"
  | "transfer"
  | "swap"
  | "bridge"
  | "supply"
  | "withdraw"
  | "borrow_capacity"
  | "repay"
  | "path_payment"
  | "vault_deposit"
  | "vault_withdraw"
  | "liquidity_add"
  | "liquidity_remove"
  | "data_purchase";

export interface IntentLegV3 {
  readonly operation: IntentOperationV3;
  readonly chain: ChainRef;
  readonly protocol?: string;
  readonly assetIn?: AssetRef;
  readonly assetOut?: AssetRef;
  readonly recipient?: AddressRef | { readonly source: "private_binding" };
}

export interface IntentIRV3 {
  readonly schemaVersion: "kletia_intent_ir_v3";
  readonly requestId: string;
  /**
   * Optional binding to the exact user-facing intent receipt that preceded
   * this V3 control-plane workflow. The hash is produced by the reviewed V2
   * compiler; it is not accepted as evidence that any financial step ran.
   */
  readonly sourceIntentReceipt: {
    readonly schemaVersion: "kletia_source_intent_receipt_v1";
    readonly engine: "workflow_v2";
    readonly scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
    readonly workflowId: string;
    readonly requestId: string;
    readonly planCoreSha256: `0x${string}`;
    readonly selectedRoute: "direct_cctp" | "stellar_centered_public";
  } | null;
  readonly semanticGoal: string;
  /** Exact reviewed route requested by structured user state, if any. */
  readonly preferredRouteId: string | null;
  readonly lane: EnvironmentLane;
  readonly legs: readonly IntentLegV3[];
  readonly privateBindings: readonly SensitiveFieldBindingV3[];
  readonly privacyBudget: PrivacyBudgetV3;
  readonly risk: {
    readonly tolerance: "conservative" | "balanced" | "aggressive";
    readonly minimumHealthFactor: "1.5" | "1.6" | "1.8" | "2.0";
    readonly maximumSlippageBps: number;
  };
  readonly gasPolicy: {
    readonly preserveDestinationGas: true;
    readonly automaticSpendingAllowed: false;
  };
  readonly coordination: {
    readonly mode: "automatic" | "direct" | "competitive";
    readonly minimumEvidenceLevel: EvidenceLevel;
    readonly solverMayCustodyUserFunds: false;
    readonly indeterminateResultMayBeRetried: false;
  };
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

export type CapabilityReadiness =
  | "read"
  | "quote"
  | "execute"
  | "verify"
  | "unavailable";

export interface ProtocolCapabilityV3 {
  readonly id: string;
  readonly label: string;
  readonly chains: readonly ChainRef["key"][];
  readonly operations: readonly IntentOperationV3[];
  readonly readiness: readonly CapabilityReadiness[];
  readonly executionEnabled: boolean;
  readonly executionChains?: readonly ChainRef["key"][];
  readonly reason?: string;
  readonly officialSources: readonly string[];
  readonly deploymentBinding:
    | { readonly mode: "pinned"; readonly identifiers: readonly string[] }
    | { readonly mode: "runtime_attested"; readonly identifiers: readonly string[] }
    | { readonly mode: "discovery_only"; readonly identifiers: readonly string[] };
  readonly mockDataAllowed: false;
}

export type EvidenceLevel =
  | "observed"
  | "chain_native_verified"
  | "protocol_verified"
  | "attested"
  | "zk_verified";

/**
 * A canonical, big-endian BN254 scalar encoded as exactly 32 bytes.
 *
 * The type is only a compile-time marker. Runtime code must still reject zero
 * and values greater than or equal to the BN254 scalar-field modulus.
 */
export type Bn254ScalarHex = `0x${string}`;

export type WorkflowStepStatusV3 =
  | "planned"
  | "blocked"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "attesting"
  | "ready"
  | "failed"
  | "indeterminate"
  | "recovery_required"
  | "refunded";

export interface DisclosureDeltaV3 {
  readonly stepId: string;
  readonly field: PrivacyField;
  readonly level: DisclosureLevel;
  readonly newlyVisibleTo: readonly string[];
  readonly reason: string;
  readonly userApprovalRequired: boolean;
}

export interface WorkflowStepV3 {
  readonly id: string;
  readonly order: number;
  readonly operation:
    | IntentOperationV3
    | "approve"
    | "cctp_mint"
    | "control_plane_commit"
    | "receipt_registry_commit"
    | "receipt_registry_finalize"
    | "control_plane_finalize"
    | "attestation";
  readonly chain: ChainRef;
  readonly protocol: string;
  readonly dependsOn: readonly string[];
  readonly status: WorkflowStepStatusV3;
  readonly signer: "evm_wallet" | "stellar_wallet" | "none";
  readonly amountBinding: "none" | "private_amount" | "previous_output";
  readonly receiptBinding?: "workflow_receipt_root";
  readonly target?: string;
  readonly method?: string;
  readonly deadline: number;
  readonly quoteExpiresAt?: number;
  readonly evidenceRequired: readonly {
    readonly kind: string;
    readonly minimumLevel: EvidenceLevel;
  }[];
  readonly disclosure: readonly DisclosureDeltaV3[];
  readonly executionReadiness: "ready" | "capability_disabled" | "deployment_required";
  readonly unavailableReason?: string;
}

export interface RouteCandidateV3 {
  readonly id: string;
  readonly solverRouteHash: `0x${string}`;
  readonly label: string;
  readonly lane: EnvironmentLane;
  readonly chains: readonly ChainRef["key"][];
  readonly protocols: readonly string[];
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly quoteExpiresAt: number;
  readonly hydration?: {
    readonly schemaVersion: "kletia_route_hydration_v1";
    readonly status: "live_quote_bound";
    readonly amountCommitment: `0x${string}`;
    readonly quoteCommitment: `0x${string}`;
    readonly observedAt: string;
    readonly observedAtBlock: string;
    readonly quoteExpiresAt: number;
    readonly sourceBalanceSufficient: boolean;
    readonly publicAmountDisclosureApproved: true;
    readonly standardFeeBps: number;
    readonly sources: readonly string[];
  };
  readonly metrics: {
    readonly estimatedOutputAtomic: string | null;
    readonly gasCostUsd: string | null;
    readonly bridgeFeeUsd: string | null;
    readonly slippageBps: number | null;
    readonly estimatedDurationSeconds: { readonly min: number; readonly max: number };
    readonly estimatedApyBps: number | null;
    readonly failureRisk: number;
    readonly protocolRisk: number;
    readonly disclosureCost: number;
    readonly score: number;
    readonly amountDependentCostsComplete: boolean;
  };
  readonly rankingExplanation: readonly string[];
  readonly steps: readonly WorkflowStepV3[];
}

export interface WorkflowPlanV3 {
  readonly version: 3;
  readonly schemaVersion: "kletia_workflow_plan_v3";
  readonly workflowId: string;
  readonly requestId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lane: EnvironmentLane;
  readonly intent: IntentIRV3;
  readonly walletBindings: readonly AddressRef[];
  readonly controlPlane: {
    readonly required: boolean;
    readonly mode: "local_manifest" | "stellar_intent_control_plane";
    readonly network: "stellar_testnet" | "stellar_mainnet" | null;
    readonly status: "ready" | "deployment_required" | "not_required";
    /** Public plan/candidate-graph input derived by the deterministic compiler. */
    readonly workflowRoot: Bn254ScalarHex;
    /**
     * SHA-256 commitments used by the public receipt registry. They are not
     * Groth16 public inputs and are never presented as Poseidon policy roots.
     */
    readonly planningPolicyCommitment: `0x${string}`;
    readonly privacyBudgetCommitment: `0x${string}`;
    /**
     * These values can only be produced with the device-private policy
     * witness. They remain null until a separately verified proof-binding
     * transition is completed.
     */
    readonly policyRoot: Bn254ScalarHex | null;
    readonly nullifier: Bn254ScalarHex | null;
    readonly proofBinding: {
      readonly schemaVersion: "kletia_policy_proof_binding_v1";
      readonly status: "not_required" | "device_proof_required" | "bound";
      readonly routeId: string | null;
      readonly verifierVersion: number | null;
      readonly protocolRegistryRoot: Bn254ScalarHex | null;
      readonly assetRegistryRoot: Bn254ScalarHex | null;
      readonly recipientPolicyRoot: Bn254ScalarHex | null;
      readonly executionExpiresAtLedger: number | null;
      readonly executionContextCommitment: Bn254ScalarHex | null;
      readonly publicInputsHash: `0x${string}` | null;
      readonly proofSha256: `0x${string}` | null;
      readonly verifiedAtLedger: string | null;
    };
    readonly commitment: {
      readonly status:
        | "not_required"
        | "device_proof_required"
        | "awaiting_signature"
        | "confirmed"
        | "finalized";
      readonly owner: string | null;
      readonly nonce: string | null;
      readonly transactionHash: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptCloseByLedger: number | null;
      readonly retentionFloorLedger: number | null;
      readonly receiptRoot?: `0x${string}` | null;
      readonly finalizedTransactionHash?: string | null;
      readonly finalizedAtLedger?: string | null;
    };
    readonly receiptRegistry: {
      readonly status:
        | "not_required"
        | "control_plane_required"
        | "awaiting_signature"
        | "confirmed"
        | "finalized";
      readonly owner: string | null;
      readonly nonce: string | null;
      readonly transactionHash: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptRoot?: `0x${string}` | null;
      readonly finalizedTransactionHash?: string | null;
      readonly finalizedAtLedger?: string | null;
    };
    readonly externalExecutionTruthProven: false;
  };
  readonly coordinationMarket: {
    readonly required: boolean;
    readonly mode: "direct_adapter" | "stellar_commit_reveal_auction";
    readonly network: "stellar_testnet" | "stellar_mainnet" | null;
    readonly status:
      | "not_required"
      | "deployment_required"
      | "auction_open_required"
      | "awaiting_bids"
      | "winner_selected"
      | "indeterminate"
      | "settled";
    readonly reasons: readonly string[];
    readonly auctionRoot: `0x${string}`;
    readonly constraintsHash: `0x${string}`;
    readonly winner: {
      readonly solver: string;
      readonly routeId: string;
      readonly routeHash: `0x${string}`;
      readonly netOutputAtomic: string;
      readonly observedAtLedger: string;
    } | null;
    readonly contracts: {
      readonly sourceReady: true;
      readonly bondVault: string | null;
      readonly routeAuction: string | null;
      readonly deploymentManifest: "contracts/stellar/deployments/testnet/solver-market.v1.json";
    };
    readonly auctionPolicy: {
      readonly commitmentScheme: "sha256_soroban_xdr_kletia_route_bid_v1";
      readonly winnerRule: "highest_promised_net_output_then_shortest_duration";
      readonly maximumBids: 32;
      readonly minimumBondAtomic?: string | null;
      readonly exactWorkflowBondRequired: true;
      readonly staleQuoteCanWin: false;
      readonly automaticTimeoutSlashing: false;
    };
    readonly publicDisclosure: {
      readonly auctionTermsOnStellar: boolean;
      readonly commitmentsHideBidTermsUntilReveal: true;
      readonly revealedBidEconomicsPublic: boolean;
      readonly solverIdentityPublic: boolean;
      readonly workflowTimingPublic: boolean;
    };
    readonly evidenceBoundary: {
      readonly bidCommitmentProvesQuoteTruth: false;
      readonly stellarProvesForeignExecutionByItself: false;
      readonly slashOnlyForProvableSolverFault: true;
      readonly bridgeDelayOrIndeterminateMayBeSlashed: false;
    };
  };
  readonly routes: readonly RouteCandidateV3[];
  readonly selectedRouteId: string | null;
  readonly currentStepId: string | null;
  readonly privacy: {
    readonly budget: PrivacyBudgetV3;
    readonly disclosureDiff: readonly DisclosureDeltaV3[];
    readonly aiReceivedRawPrivateFields: false;
    readonly ledgerConfidentiality: "none" | "stellar_confidential_zone_only";
    readonly anonymityGuaranteed: false;
  };
  readonly executionPolicy: {
    readonly perFinancialStepWalletApproval: true;
    readonly crossChainAtomicity: "staged_checkpointed_no_global_rollback";
    readonly environmentMixingAllowed: false;
    readonly silentRetryAllowed: false;
    readonly mockDataAllowed: false;
  };
  readonly compatibility?: {
    readonly engine: "workflow_v2";
    readonly routeId: string;
    /** Immutable route/policy hash selected before the Stellar policy proof. */
    readonly policyRouteHash: `0x${string}`;
    readonly workflowId: string;
    readonly parentPlanHash: `0x${string}`;
    readonly planCoreSha256: `0x${string}`;
    /** Short-lived execution evidence independently sealed by the V2 manifest. */
    readonly executionEvidenceObservedAt: string;
    readonly executionQuoteExpiresAt: number;
    readonly amountCommitment: `0x${string}`;
    readonly recipientCommitment: `0x${string}`;
    /** Last V2 plan-core hash observed through a server-opened bearer seal. */
    readonly latestPlanCoreSha256: `0x${string}`;
    readonly confirmedCheckpointCount: number;
    readonly totalCheckpointCount: number;
    readonly currentAction: WorkflowV2ExecutorActionV3 | null;
    readonly terminalReceiptSha256: `0x${string}` | null;
    readonly updatedAt: string;
    readonly status:
      | "bound"
      | "in_progress"
      | "completed"
      | "failed"
      | "indeterminate"
      | "recovery_required"
      | "refunded";
  };
}

export type WorkflowV2ExecutorActionV3 =
  | "cctp_approve"
  | "cctp_burn"
  | "cctp_attestation"
  | "cctp_mint"
  | "aave_approve"
  | "aave_supply"
  | "borrow_capacity";

export interface WorkflowEvidenceV3 {
  readonly stepId: string;
  readonly kind:
    | "evm_receipt"
    | "stellar_ledger"
    | "circle_attestation"
    | "protocol_read"
    | "solver_bond"
    | "solver_bid"
    | "auction_result"
    | "route_quote"
    | "execution_binding";
  readonly reference: string;
  readonly level: EvidenceLevel;
  readonly observedAt: string;
  readonly chain: ChainRef;
  readonly details?: Readonly<Record<string, unknown>>;
}
