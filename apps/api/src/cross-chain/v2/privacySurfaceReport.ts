/**
 * PrivacySurfaceReportV1 is the machine-readable truth boundary for Kletia's
 * current privacy claims.
 *
 * It deliberately describes each reachable surface separately. A clean
 * WorkflowPlanV2 private-planning path must never be used to imply that the
 * legacy intent endpoint, standalone Stellar tools, x402, or a public ledger
 * are confidential. This is a reviewed source manifest, not a non-interference
 * proof and not a substitute for live capability readiness.
 */

export type PrivacySurfaceIdV1 =
  | "legacy_base_arc_intent"
  | "workflow_v2_private_planning"
  | "stellar_portfolio"
  | "stellar_sdex"
  | "stellar_transfer"
  | "base_x402_buyer"
  | "browser_egress_guard"
  | "unified_superapp_ui"
  | "stellar_private_payments"
  | "stellar_confidential_treasury";

export type PrivacySurfaceAvailabilityV1 =
  | "runtime"
  | "capability_gated"
  | "blocked";

export interface PrivacySurfaceV1 {
  readonly id: PrivacySurfaceIdV1;
  readonly category:
    | "intent"
    | "workflow"
    | "read"
    | "transaction"
    | "payment"
    | "browser_measurement"
    | "user_interface"
    | "confidential_execution";
  readonly availability: PrivacySurfaceAvailabilityV1;
  readonly endpoints: readonly string[];
  readonly networks: readonly string[];
  /** True only when the surface is part of the sealed WorkflowPlanV2 state machine. */
  readonly sealedWorkflowV2: boolean;
  readonly aiAccess: {
    readonly default: "none" | "redacted_semantics" | "raw_prompt" | "not_applicable";
    readonly optIn: "none" | "redacted_semantics" | "raw_prompt_and_recent_context";
    readonly consent: string;
  };
  readonly kletiaApiReceives: readonly string[];
  readonly externalObservers: readonly string[];
  readonly localPersistence: string;
  readonly settlementVisibility:
    | "public_ledger"
    | "read_only_public_state"
    | "no_settlement"
    | "unavailable";
  readonly onchainConfidentiality:
    | "none"
    | "not_applicable"
    | "zk_shielded_pool"
    | "blocked_no_reviewed_runtime";
  readonly limitations: readonly string[];
}

export interface PrivacySurfaceReportV1 {
  readonly schemaVersion: "kletia_privacy_surface_report_v1";
  readonly assurance: "reviewed_source_manifest_not_noninterference_proof";
  readonly defaultPolicy: {
    readonly semanticPlanner: "deterministic_only";
    readonly financialChatPersistence: "browser_redacted";
    readonly confidentialRequestFallback: "fail_closed_no_public_downgrade";
    readonly ledgerConfidentiality: "stellar_testnet_shielded_pool_only";
  };
  readonly claimScope: {
    readonly privatePlanning: "workflow_v2_only";
    readonly zeroPrivateFieldEgressMeasurement: "registered_v2_fields_in_wrapped_browser_realm_only";
    readonly legacyIntentApiBlindness: false;
    readonly standaloneStellarToolsSealedByWorkflowV2: false;
    readonly x402PaymentConfidential: false;
    readonly systemwideLedgerConfidentiality: false;
  };
  readonly surfaces: readonly PrivacySurfaceV1[];
  readonly prohibitedClaims: readonly string[];
}

const SURFACES: readonly PrivacySurfaceV1[] = [
  {
    id: "legacy_base_arc_intent",
    category: "intent",
    availability: "runtime",
    endpoints: ["POST /api/intent"],
    networks: ["base_mainnet", "arc_testnet", "arbitrum_one"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "none",
      optIn: "raw_prompt_and_recent_context",
      consent:
        "A short-lived token bound to the exact prompt, wallet, network and chain is required when deterministic parsing cannot resolve the request.",
    },
    kletiaApiReceives: [
      "raw_prompt",
      "wallet_address",
      "network_and_chain_identity",
      "request_identity",
      "clarification_selection_when_used",
    ],
    externalObservers: [
      "configured_semantic_model_only_after_explicit_consent",
      "selected_public_rpc_and_protocol_during_execution",
    ],
    localPersistence:
      "Financial chat text is redacted before browser persistence; the API still receives the raw prompt and may retain bounded raw conversation context in process memory for clarification.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "none",
    limitations: [
      "This surface provides deterministic-by-default interpretation and AI consent, not API-blind intent privacy.",
      "Its public execution paths are not governed by the WorkflowPlanV2 Privacy Budget or Disclosure Diff.",
    ],
  },
  {
    id: "workflow_v2_private_planning",
    category: "workflow",
    availability: "capability_gated",
    endpoints: [
      "POST /api/workflows/v2/plan",
      "POST /api/workflows/v2/advance",
      "POST /api/workflows/v2/refresh-authorization",
      "POST /api/intent with network=stellar and chainRef=stellar:testnet",
    ],
    networks: ["arc_testnet", "stellar_testnet", "arbitrum_sepolia"],
    sealedWorkflowV2: true,
    aiAccess: {
      default: "none",
      optIn: "redacted_semantics",
      consent:
        "The browser selects a Privacy Budget preset; deterministic_only_public_execution is the default and any semantic-model mode receives only the allowlisted redacted envelope.",
    },
    kletiaApiReceives: [
      "redacted_semantic_envelope",
      "amount_commitment_not_exact_amount_during_planning",
      "recipient_commitment",
      "public_execution_wallet_bindings_including_destination",
      "route_preference",
      "privacy_budget_preset",
      "one_shot_commitment_openings_at_the_first_public_checkpoint",
      "checkpoint_evidence",
    ],
    externalObservers: [
      "circle_for_cctp_public_amount_recipient_and_timing",
      "route_scoped_public_rpcs_and_ledgers",
      "aave_v3_for_public_destination_position_and_supply",
      "stellar_archive_only_on_the_public_stellar_corridor",
    ],
    localPersistence:
      "Exact private slots remain in browser memory unless the user exports encrypted recovery data; commitments, public bindings and sealed workflow state may be persisted.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "none",
    limitations: [
      "The exact amount is isolated during planning, but the public destination wallet is received by the API before execution.",
      "Amount, recipient and timing become public when the user authorizes a public checkpoint.",
      "A public Stellar hop adds a public observer and provides no unlinkability credit.",
    ],
  },
  {
    id: "stellar_portfolio",
    category: "read",
    availability: "capability_gated",
    endpoints: ["GET /api/stellar/portfolio/:account"],
    networks: ["stellar_testnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent: "No semantic model is used by this read endpoint.",
    },
    kletiaApiReceives: ["stellar_account_address"],
    externalObservers: ["configured_stellar_horizon"],
    localPersistence: "The UI may hold the returned reviewed-asset balances in component memory.",
    settlementVisibility: "read_only_public_state",
    onchainConfidentiality: "not_applicable",
    limitations: [
      "Stellar account identity and balances are public ledger data.",
      "This standalone read is not covered by a sealed Privacy Budget or execution receipt.",
    ],
  },
  {
    id: "stellar_sdex",
    category: "transaction",
    availability: "capability_gated",
    endpoints: ["POST /api/stellar/quote", "browser-built Stellar path-payment XDR"],
    networks: ["stellar_testnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent: "No semantic model is used by the standalone quote or XDR builder.",
    },
    kletiaApiReceives: [
      "exact_quote_amount",
      "source_and_destination_asset_identity",
      "route_mode",
    ],
    externalObservers: [
      "stellar_horizon_receives_exact_amount_and_asset_query",
      "aquarius_quote_api_receives_exact_amount_and_sac_endpoints",
      "stellar_horizon_receives_source_account_when_the_browser_builds_or_submits_xdr",
      "stellar_public_ledger_after_submission",
    ],
    localPersistence: "Quote and unsigned XDR are held in browser memory for the signing flow.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "none",
    limitations: [
      "This is a public standalone tool outside WorkflowPlanV2, its Privacy Budget and its Disclosure Diff.",
      "The supported quote request rejects account identity because pathfinding does not need it.",
      "Aquarius is comparison-only; its response is not a signable or privacy-preserving route.",
    ],
  },
  {
    id: "stellar_transfer",
    category: "transaction",
    availability: "capability_gated",
    endpoints: ["browser-built Stellar payment XDR"],
    networks: ["stellar_testnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent: "No semantic model is used by the standalone transfer builder.",
    },
    kletiaApiReceives: [],
    externalObservers: [
      "configured_stellar_horizon_receives_source_recipient_asset_and_amount",
      "freighter_receives_exact_transaction_envelope",
      "stellar_public_ledger_after_submission",
    ],
    localPersistence: "The unsigned and signed transaction envelope is held in browser memory during signing.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "none",
    limitations: [
      "Direct browser-to-Horizon preparation reduces Kletia API disclosure but does not make the transfer private.",
      "This standalone tool is not covered by WorkflowPlanV2 or a Kletia execution receipt.",
    ],
  },
  {
    id: "base_x402_buyer",
    category: "payment",
    availability: "runtime",
    endpoints: [
      "POST /api/base/x402-buyer/session",
      "GET /api/base/x402-buyer/session/:sessionId",
      "GET /api/base/x402-buyer/session/:sessionId/status",
    ],
    networks: ["base_mainnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "none",
      optIn: "raw_prompt_and_recent_context",
      consent:
        "Intent interpretation follows the legacy consent boundary; the payment relay itself does not require an AI call.",
    },
    kletiaApiReceives: [
      "resource_url",
      "http_method",
      "maximum_payment",
      "wallet_address",
      "payment_requirement",
      "wallet_signed_eip_3009_authorization",
      "paid_upstream_response",
    ],
    externalObservers: [
      "target_x402_resource",
      "official_facilitator",
      "base_rpc",
      "base_public_ledger",
    ],
    localPersistence: "The server keeps a short-lived in-memory, one-use buyer session.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "none",
    limitations: [
      "Payment amount, payer, payee, nonce and settlement timing are public Base evidence.",
      "The paid response is untrusted external data even after payment settlement is verified.",
    ],
  },
  {
    id: "browser_egress_guard",
    category: "browser_measurement",
    availability: "runtime",
    endpoints: ["wrapped browser fetch/xhr/websocket/beacon/console/storage/error surfaces"],
    networks: ["browser_runtime"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent: "The guard measures registered fields; it does not disclose them to a model.",
    },
    kletiaApiReceives: [],
    externalObservers: [],
    localPersistence: "Registered private needles remain module-local and are not serialized into the report.",
    settlementVisibility: "no_settlement",
    onchainConfidentiality: "not_applicable",
    limitations: [
      "Coverage is limited to registered values and wrapped operations in the observed browser realm.",
      "Low-entropy values and transformed derivatives cannot be claimed as protected.",
      "A clean observed session is not a systemwide non-interference proof.",
    ],
  },
  {
    id: "unified_superapp_ui",
    category: "user_interface",
    availability: "runtime",
    endpoints: [],
    networks: [
      "base_mainnet",
      "arc_testnet",
      "arbitrum_one",
      "stellar_testnet",
      "arbitrum_sepolia",
    ],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent:
        "The interface presents the semantic-model consent decision; it is not itself a model boundary.",
    },
    kletiaApiReceives: [],
    externalObservers: [],
    localPersistence:
      "Workspace and theme preferences may be stored locally. Financial chat text is redacted before browser persistence; exact V2 private fields stay in component memory unless the user explicitly exports encrypted recovery data.",
    settlementVisibility: "no_settlement",
    onchainConfidentiality: "not_applicable",
    limitations: [
      "Privacy Budget and Disclosure Diff cards currently describe sealed WorkflowPlanV2 only; the shielded XLM surface renders its own explicit public/private boundary.",
      "Legacy Base/Arc execution and standalone Stellar tools do not yet receive the same per-step disclosure UI or sealed receipt.",
      "A private or confidential label cannot upgrade a public transaction or an unavailable execution surface.",
    ],
  },
  {
    id: "stellar_private_payments",
    category: "confidential_execution",
    availability: "capability_gated",
    endpoints: [
      "GET /api/stellar/private-payments/readiness",
      "browser-only Nethermind Stellar Private Payments SDK",
    ],
    networks: ["stellar_testnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent:
        "The shielded wallet does not invoke a semantic model; note secrets, witnesses, private amounts and recipient keys remain in the browser SDK and workers.",
    },
    kletiaApiReceives: [],
    externalObservers: [
      "stellar_rpc_receives_public_pool_calls_and_timing",
      "nethermind_bootnode_receives_event_queries_only_after_explicit_consent_when_rpc_retention_is_insufficient",
      "freighter_receives_the_exact_transaction_or_authorization_request",
      "stellar_ledger_observes_deposit_and_withdraw_amounts_addresses_and_pool_interaction_timing",
    ],
    localPersistence:
      "The upstream SDK stores encrypted/decrypted note index state in browser OPFS. Deterministically derived privacy keys, witnesses and note openings are not sent to Kletia API.",
    settlementVisibility: "public_ledger",
    onchainConfidentiality: "zk_shielded_pool",
    limitations: [
      "In-pool amounts, balances and recipient-output links are protected by the Groth16 privacy-pool proof; deposit and withdrawal amounts and addresses remain public.",
      "The transaction submitter or Soroban authorization address and timing can remain observable, so this is not full network-layer anonymity.",
      "The pinned upstream SDK and contracts are an unaudited Testnet research alpha and must not be used with real assets.",
      "The current upstream deployment provides XLM and EURC pools, not a Kletia USDC pool, private bridge or private EVM execution.",
      "Registering recipient discovery keys publicly links a G-account to shielded receive keys; users may avoid that link only by exchanging note and encryption keys out of band.",
    ],
  },
  {
    id: "stellar_confidential_treasury",
    category: "confidential_execution",
    availability: "blocked",
    endpoints: [],
    networks: ["stellar_testnet"],
    sealedWorkflowV2: false,
    aiAccess: {
      default: "not_applicable",
      optIn: "none",
      consent: "No confidential invocation can be prepared by the current runtime.",
    },
    kletiaApiReceives: [],
    externalObservers: [],
    localPersistence: "No production holder state or confidential recovery root is created by this runtime.",
    settlementVisibility: "unavailable",
    onchainConfidentiality: "blocked_no_reviewed_runtime",
    limitations: [
      "This surface refers specifically to the OpenZeppelin Confidential Token design, which is distinct from the live Kletia SPP privacy-pool surface above.",
      "A working unaudited official Testnet Confidential Token reference exists, but Kletia has not pinned and validated its holder SDK, USDC deployment, auditor policy, recovery path or signable lifecycle.",
      "Browser proving capability alone cannot open this surface.",
      "Kletia must fail closed rather than silently compile a public substitute.",
    ],
  },
] as const;

const REPORT: PrivacySurfaceReportV1 = {
  schemaVersion: "kletia_privacy_surface_report_v1",
  assurance: "reviewed_source_manifest_not_noninterference_proof",
  defaultPolicy: {
    semanticPlanner: "deterministic_only",
    financialChatPersistence: "browser_redacted",
    confidentialRequestFallback: "fail_closed_no_public_downgrade",
    ledgerConfidentiality: "stellar_testnet_shielded_pool_only",
  },
  claimScope: {
    privatePlanning: "workflow_v2_only",
    zeroPrivateFieldEgressMeasurement:
      "registered_v2_fields_in_wrapped_browser_realm_only",
    legacyIntentApiBlindness: false,
    standaloneStellarToolsSealedByWorkflowV2: false,
    x402PaymentConfidential: false,
    systemwideLedgerConfidentiality: false,
  },
  surfaces: SURFACES,
  prohibitedClaims: [
    "Kletia currently provides systemwide ledger confidentiality.",
    "A public Stellar checkpoint makes Arc or Arbitrum execution unlinkable.",
    "Legacy Base or Arc intent prompts are hidden from the Kletia API.",
    "Standalone Stellar transfer or SDEX tools are sealed WorkflowPlanV2 steps.",
    "x402 payment settlement is confidential.",
    "A clean browser egress report proves that no unobserved code path leaked data.",
    "The shielded XLM pool makes CCTP, Aave or another public-chain execution private.",
  ],
};

export function readPrivacySurfaceReportV1(): PrivacySurfaceReportV1 {
  return REPORT;
}
