import type {
  AbiFunctionClassification,
  AccountId,
  AssetAmount,
  AssetChange,
  AssetDescriptor,
  AssetId,
  ChainDescriptor,
  ContractDefinition,
  ContractInspection,
  ContractReview,
  ContractStatus,
  ContractStepCall,
  ContractTestRequest,
  ContractTestResult,
  ContractView,
  ContractVm,
  ErrorCatalogRow,
  EvmContractDefinition,
  EvmContractInspectionView,
  IntentGraph,
  IntentPreview,
  IntentRequest,
  LinkDefinition,
  LinkFundingChoice,
  LinkOwnerView,
  LinkStats,
  LinkView,
  NetworkKey,
  PolicyComparison,
  PolicyDecision,
  PolicyDefaults,
  PolicyDocument,
  PolicyRuleResult,
  PolicyTemplateFill,
  PolicyViolation,
  PolicyTemplateId,
  PolicyWarning,
  ReceiptDisclosure,
  ReceiptInclusion,
  ReceiptKey,
  ReceiptLogBatch,
  ReceiptPayload,
  ReceiptProfile,
  ValidationIssue,
  ProtocolDescriptor,
  ProtocolId,
  SessionCreateRequest,
  SessionIntentRequest,
  SessionView,
  SolanaActionDefinition,
  SolanaProgramInspectionView,
  StepExecutionPayload,
  StepSettlement,
  TransactionRequest,
} from "@kletia/core";

export interface NetworkCapabilities extends ChainDescriptor {
  readonly actions: readonly string[];
  readonly protocols: readonly ProtocolId[];
}

export interface NetworkHealth {
  readonly network: NetworkKey;
  readonly chain: string;
  readonly name: string;
  readonly environment: "mainnet" | "testnet";
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Latest block number (EVM) or slot (Solana). */
  readonly height?: string;
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: "ok" | "degraded" | "down";
  readonly api: "v1";
  readonly version: string;
  readonly time: string;
  readonly uptimeSeconds: number;
  readonly networks: readonly NetworkHealth[];
  readonly storage: { readonly intents: string; readonly apiKeys: string; readonly webhooks: string };
  readonly webhooks: {
    readonly status: "enabled" | "needs_configuration";
    /** How webhook secrets are sealed: a configured secret, the development key (memory stores only) or none. */
    readonly sealing: "configured" | "development_fallback" | "missing";
    /** Delivery counters for this API process; null when the dispatcher is not running. */
    readonly dispatcher: WebhookDispatcherStats | null;
  };
}

export interface WebhookDispatcherStats {
  readonly running: boolean;
  readonly queued: number;
  readonly inFlight: number;
  readonly scheduledRetries: number;
  readonly delivered: number;
  readonly failed: number;
  readonly dropped: number;
  /** Webhooks paused after consecutive delivery failures (absent on older API versions). */
  readonly pausedWebhooks?: number;
}

export interface QuoteRequest {
  readonly from: {
    readonly network: NetworkKey;
    /** Symbol, address/mint or CAIP-19 asset id. */
    readonly asset: string;
    /** Decimal amount in display units, e.g. "25" or "0.5". */
    readonly amount: string;
    /** CAIP-10 account that will sign (improves accuracy for cross-network quotes). */
    readonly account?: AccountId;
  };
  readonly to: {
    readonly network: NetworkKey;
    readonly asset: string;
    /** Destination address or CAIP-10 account. Defaults to `from.account` on the same VM; across VMs, set it for an executable quote. */
    readonly recipient?: string;
  };
  readonly slippageBps?: number;
  /** Longest acceptable settlement estimate in seconds (10-86400, default 600); slower routes are not eligible as best. */
  readonly maxSeconds?: number;
}

export interface QuoteRoute {
  readonly protocol: ProtocolId;
  readonly label: string;
  readonly network: NetworkKey;
  readonly toNetwork: NetworkKey;
  readonly input: AssetAmount;
  readonly output: AssetAmount;
  readonly minimumOutput: AssetAmount;
  /** Guaranteed output net of extra costs; absent when those costs cannot be priced. */
  readonly netMinimumOutput?: AssetAmount;
  readonly feesUsd?: number;
  /** Value paid on top of the input (e.g. a bridge's fixed native fee). */
  readonly extraCosts?: readonly AssetAmount[];
  readonly estimatedSeconds: number;
  readonly transactionCount: number;
  readonly settlement: StepSettlement;
  readonly warnings: readonly string[];
  readonly quoteId?: string;
  /** False when the route cannot be chosen as best (too slow, unpriced extra costs, another asset). Absent on older API versions. */
  readonly eligible?: boolean;
}

/** One EVM lending venue from `GET /v1/venues` (advisory, read on-chain and cached for 60 s). */
export interface LendingVenueMetrics {
  /** Registry venue id, e.g. `base:aave-v3:usdc` (use as `params.venue`). */
  readonly venue: string;
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly name: string;
  /** Underlying asset symbol. */
  readonly asset: string;
  /** Variable supply APY as a fraction (0.045 = 4.5%); null when unreadable. */
  readonly supplyApy: number | null;
  readonly apySource: "rate" | "share-price" | "unavailable";
  readonly apyWindowSeconds?: number;
  readonly totalSupplied: AssetAmount | null;
  readonly exitLiquidity: AssetAmount | null;
  readonly utilization: number | null;
  readonly observedAt: string;
  readonly warnings: readonly string[];
}

export interface VenuesResponse {
  readonly venues: readonly LendingVenueMetrics[];
  /** Venues whose on-chain reads failed or no longer match the registry. */
  readonly unavailable: readonly { readonly venue: string; readonly code: string; readonly message: string }[];
}

export interface QuoteResponse {
  readonly routes: readonly QuoteRoute[];
  readonly best: QuoteRoute | null;
  readonly quotedAt: string;
  /** Venues that could not quote this movement, with the reason. */
  readonly unavailable: readonly { readonly protocol: ProtocolId; readonly code: string; readonly message: string }[];
}

export interface PortfolioHolding {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  readonly usd: number | null;
  readonly verified: boolean;
  readonly isNative: boolean;
}

export interface PortfolioResponse {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly holdings: readonly PortfolioHolding[];
  readonly totalUsd: number;
  readonly unpricedCount: number;
  readonly observedAt: string;
}

export interface CreateIntentOptions {
  /** Plan and quote without persisting the intent. */
  readonly dryRun?: boolean;
  /**
   * Also compute the plan-stage asset-change preview (`?preview=true`). The
   * call then resolves with `{ intent, preview }` instead of the intent.
   */
  readonly preview?: boolean;
}

/** `POST /v1/intents?preview=true`: the intent and its plan-stage preview (absent when the API could not compute one). */
export interface IntentWithPreview {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
}

export interface PreparedStep {
  readonly intent: IntentGraph;
  readonly payload: StepExecutionPayload;
  /** The intent preview recomputed with the just-simulated step (preview-capable API versions). */
  readonly preview?: IntentPreview;
  /**
   * With `acknowledgedPreview`: `matched` when the API found that digest and
   * the payload is not materially worse, `unknown` when it no longer holds it
   * (show `preview` again before signing).
   */
  readonly previewAck?: "matched" | "unknown";
}

/** Options of `intents.prepareStep`. */
export interface PrepareStepOptions {
  readonly signal?: AbortSignal;
  /**
   * Digest (`sha256:…`) of the preview the user approved. A materially worse
   * payload is refused with 409 PREVIEW_CHANGED (`KletiaPreviewChangedError`
   * carries the fresh preview).
   */
  readonly acknowledgedPreview?: string;
}

export interface WebhookRecord {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly createdAt: string;
  /** Present only in the creation response. */
  readonly secret?: string;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly createdAt?: string;
  /** Present only in the creation response. */
  readonly key?: string;
}

/** A key of the caller's project as `GET /v1/keys` lists it. Secrets are never listed. */
export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  /** Last four characters of the current secret. */
  readonly last4: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  /** When the previous secret stops authenticating; null when no grace window is open. */
  readonly previousExpiresAt: string | null;
  readonly revokedAt: string | null;
  /** True for the key that made the request. */
  readonly current: boolean;
}

/** `POST /v1/keys/{id}/rotate`: the same key id with a new secret (shown once). */
export interface RotatedApiKey {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly createdAt: string;
  readonly key: string;
  readonly rotatedAt: string;
  /** When the previous secret stops authenticating (null: it already has). */
  readonly previousExpiresAt: string | null;
}

export type WebhookDeliveryStatus = "succeeded" | "failed" | "dropped";
export type WebhookDeliveryError =
  | "timeout"
  | "connection_failed"
  | "http_status"
  | "redirect"
  | "forbidden_address"
  | "queue_full"
  | "paused";

/** One delivery attempt (or drop) in a webhook's log. Payloads are never stored. */
export interface WebhookDelivery {
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly intentId?: string;
  readonly attempt: number;
  readonly status: WebhookDeliveryStatus;
  readonly httpStatus?: number;
  readonly durationMs?: number;
  readonly error?: WebhookDeliveryError;
  readonly nextRetryAt?: string;
  /** True for deliveries sent by `webhooks.test`. */
  readonly test?: boolean;
  readonly at: string;
}

export type UsageWindow = "24h" | "7d";

export interface UsageReport {
  readonly keyId: string;
  readonly tier: string;
  readonly window: UsageWindow;
  readonly since: string;
  readonly generatedAt: string;
  readonly rateLimit: {
    readonly limit: number;
    readonly remaining: number;
    readonly resetAt: string | null;
    readonly windowSeconds: number;
  };
  readonly totals: { readonly requests: number; readonly byStatusClass: Readonly<Record<string, number>> };
  readonly byRoute: readonly {
    readonly route: string;
    readonly requests: number;
    readonly byStatusClass: Readonly<Record<string, number>>;
  }[];
  readonly series: readonly { readonly hour: string; readonly requests: number }[];
  readonly intents: { readonly created: number; readonly byStatus: Readonly<Record<string, number>> };
}

/** `GET /v1/errors`: the catalog from `@kletia/core` with documentation links. */
export interface ErrorCatalogResponse {
  readonly errors: readonly (ErrorCatalogRow & { readonly docs: string })[];
  /** Provider codes such as RELAY_UNAVAILABLE resolve to the entry named by `code`. */
  readonly families: readonly { readonly pattern: string; readonly code: string }[];
}

/** Methods of the low-level `KletiaClient.request` helper. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Per-call options accepted by every client method. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
  /**
   * `Idempotency-Key` for this call. By default the client generates one for
   * POSTs that change state when it has an API key, and reuses it across
   * retries. `false` sends none (and disables retries of such POSTs).
   */
  readonly idempotencyKey?: string | false;
  /** Overrides the client's `maxRetries` for this call (prepare is never retried). */
  readonly maxRetries?: number;
}

/* ------------------------------------------------- custom contracts (BYOC) */

/** One revision of a registration, as `GET /v1/contracts/{id}` lists them for the owner. */
export interface ContractRevisionSummary {
  readonly revision: number;
  /** sha256 hex of the revision's security-relevant fields. */
  readonly definitionHash: string;
  readonly createdAt: string;
}

/** `GET /v1/contracts/{id}`: the view, plus the revision history when the caller owns the registration. */
export type ContractWithRevisions = ContractView & { readonly revisions?: readonly ContractRevisionSummary[] };

/** `POST /v1/contracts` response. */
export interface ContractRegistration {
  readonly contract: ContractView;
}

/** Filters of `GET /v1/contracts`. */
export interface ContractListFilter {
  readonly network?: NetworkKey;
  readonly vm?: ContractVm;
  readonly status?: ContractStatus;
}

/** `GET /v1/contracts/inspect`: an EVM address, or up to six Solana program ids. */
export type ContractInspectQuery =
  | { readonly network: NetworkKey; readonly address: string; readonly programs?: undefined }
  | { readonly network: NetworkKey; readonly programs: readonly string[]; readonly address?: undefined };

type DefinitionPatch<T> = { readonly [K in keyof T]?: T[K] | null };

/**
 * `PATCH /v1/contracts/{id}`: fields replaced on the latest revision (`null`
 * removes an optional field). `vm`, `network`, `address` and `origin` never
 * change. Changing anything but action labels and phrases creates a new
 * revision, which waits for the activation delay on mainnet networks.
 */
export type ContractDefinitionPatch =
  | DefinitionPatch<Omit<EvmContractDefinition, "vm" | "network" | "address">>
  | DefinitionPatch<Omit<SolanaActionDefinition, "vm" | "network" | "origin">>;

/** `sessions.createIntent` input: `hostOrigin` defaults to the page's origin in a browser. */
export interface SessionIntentInput extends Omit<SessionIntentRequest, "hostOrigin"> {
  /** Origin of the page the visitor is on; must be one of the session's `allowedOrigins`. */
  readonly hostOrigin?: string;
}

/** `POST /v1/sessions/{id}/intents` response. */
export interface SessionIntentResponse {
  readonly intent: IntentGraph;
}

/** Third argument of `executeIntent`'s `onReview` hook. */
export interface StepReviewContext {
  /** The intent as Kletia returned it with the prepared step. */
  readonly intent: IntentGraph;
  /** What the wallet will be asked to sign, in order. Checked against the review before the hook runs. */
  readonly transactions: readonly TransactionRequest[];
  /** The plan-time review (`step.call.review`), to show what moved since planning. */
  readonly planned?: ContractReview;
  /** Unix seconds (server clock) after which the prepared transactions must be prepared again. */
  readonly expiresAt: number;
}

/* ------------------------------------------------------------ receipts */

/** A receipt document as the API returns it (`{ receipt }`). Only `payload` is signed. */
export interface ReceiptDocumentView {
  readonly payload: ReceiptPayload;
  readonly digest: string;
  readonly signature: { readonly alg: "Ed25519"; readonly kid: string; readonly value: string };
  readonly disclosures?: Readonly<Record<string, ReceiptDisclosure>>;
  readonly inclusion?: ReceiptInclusion;
  readonly attestations?: { readonly eas?: unknown };
}

/** Why a receipt is not issued yet (`202`). */
export interface ReceiptPending {
  /** queued, awaiting_finality, finality_timeout, rpc_unavailable, anchor_reorged, signer_missing or issuer_error. */
  readonly reason: string;
  readonly expectedBy: string | null;
  readonly retryAfterSeconds: number;
}

/**
 * `GET /v1/intents/{id}/receipt`: the receipt (`null` while it is pending);
 * `pending` is also set when a newer state of the intent is queued for a
 * new sequence.
 */
export interface ReceiptResult {
  readonly receipt: ReceiptDocumentView | null;
  readonly pending?: ReceiptPending;
}

export interface ReceiptListEntry {
  readonly receiptId: string;
  readonly sequence: number;
  readonly status: string;
  readonly terminal: boolean;
  readonly digest: string;
  readonly issuedOn: string;
  readonly supersededBy: string | null;
}

export interface ReceiptShare {
  readonly id: string;
  readonly receiptId: string;
  readonly sequence: number;
  readonly groups: readonly string[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  /** Only in the creation response: the link carries the decryption key in its fragment, shown once. */
  readonly url?: string;
}

/** `POST /v1/intents/{id}/receipt/shares` body: a profile or explicit groups. */
export interface ReceiptShareRequest {
  readonly profile?: ReceiptProfile;
  /** Group paths or patterns, e.g. `["intent.outcome", "steps.*.evidence"]`. */
  readonly groups?: readonly string[];
  readonly sequence?: number;
  /** 3,600-31,536,000 seconds (default 30 days), or null for a share that never expires. */
  readonly expiresInSeconds?: number | null;
}

/** `GET /v1/receipts/keys`. */
export interface ReceiptKeySet {
  readonly keys: readonly ReceiptKey[];
  readonly attesters: readonly { readonly type: "eas"; readonly chain: string; readonly address: string; readonly schemaUid: string; readonly status: string }[];
}

/** One closed transparency-log batch. */
export interface ReceiptLogBatchView {
  readonly seq: number;
  readonly batch: ReceiptLogBatch;
  readonly batchDigest: string;
  readonly signature: string;
  readonly anchor: { readonly chain: string; readonly contract: string; readonly tx: string; readonly timestamp: number } | null;
  readonly closedAt: string;
}

/** `GET /v1/receipts/log/{seq}` (with `leaves` when asked). */
export interface ReceiptLogBatchResponse {
  readonly batch: ReceiptLogBatchView;
  readonly leaves?: { readonly offset: number; readonly limit: number; readonly total: number; readonly items: readonly string[] };
}

/** `GET /v1/receipts/{receiptId}/shares/{shareId}`: the encrypted disclosures of a share. */
export interface ReceiptShareCiphertext {
  readonly ciphertext: string;
  readonly alg: "A256GCM";
  readonly groups: readonly string[];
  readonly expiresAt: string | null;
}

/* ------------------------------------------------------------ Rule Book */

/** One stored version of a rule book. */
export interface PolicyVersionView {
  readonly scope: "project" | "key";
  readonly keyId?: string;
  readonly projectId?: string;
  readonly version: number;
  readonly hash: string | null;
  readonly status: string;
  readonly document: PolicyDocument | null;
  readonly activatesAt: string | null;
  readonly loosened: readonly string[];
  readonly tightened: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The pending amendment of a rule book (a loosening waiting for its delay). */
export interface PolicyPendingView {
  readonly version: number;
  readonly hash: string | null;
  readonly activatesAt: string | null;
  readonly loosened: readonly string[];
  readonly createdBy: string;
  readonly removal: boolean;
}

/** The active version (`status: "none"` when there is none) and the pending one. */
export type PolicyHeadView = (PolicyVersionView | { readonly status: "none"; readonly version: null; readonly hash: null; readonly document: null }) & {
  readonly pending: PolicyPendingView | null;
};

/** One rule book of a key's chain, as `effective.chain` lists it. */
export interface PolicyChainLinkView {
  readonly scope: "project" | "key";
  readonly id: string;
  readonly version: number;
  readonly hash: string;
}

/** The effective chain of a key (root first); each level's document has its defaults filled (display). */
export interface EffectivePolicyView {
  readonly keyActive: boolean;
  readonly chain: readonly PolicyChainLinkView[];
  readonly defaults: PolicyDefaults;
  readonly levels: readonly {
    readonly scope: "project" | "key";
    readonly id: string;
    readonly version: number | null;
    readonly hash: string | null;
    readonly defaults: PolicyDefaults;
    readonly document: PolicyDocument | null;
  }[];
}

/** `GET /v1/keys/{id}/policy` (and the project's, without `effective`). */
export interface PolicyReadResponse {
  readonly policy: PolicyHeadView | null;
  readonly effective?: EffectivePolicyView;
}

/** `PUT` / `DELETE …/policy`: the new version, and whether it applies now or waits. */
export interface PolicyWriteResponse {
  readonly policy: PolicyVersionView;
  readonly applied: "now" | "pending";
  readonly tightened: readonly string[];
  readonly loosened: readonly string[];
  readonly supersededPending: { readonly version: number; readonly hash: string | null } | null;
  readonly warnings: readonly PolicyWarning[];
}

/** `POST /v1/policy/validate`. */
export interface PolicyValidateResponse {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly warnings: readonly PolicyWarning[];
  readonly document?: PolicyDocument;
  readonly hash?: string;
  readonly comparison?: PolicyComparison;
  readonly against?: { readonly valid: false; readonly issues: readonly ValidationIssue[] };
}

/** `POST /v1/policy/evaluate` body. */
export interface PolicyEvaluateRequest {
  /** Default: the calling key; must be in its subtree. */
  readonly keyId?: string;
  /** A draft replacing that key's own rule book for this evaluation (null: none). */
  readonly policy?: PolicyDocument | null;
  readonly request: IntentRequest;
  readonly stage?: "plan" | "prepare";
  /** ISO time; affects only the schedule. */
  readonly at?: string;
}

/** `POST /v1/policy/evaluate`: every rule with pass, trigger, fail or warn (also when the outcome is deny). */
export interface PolicyEvaluateResponse {
  readonly evaluation: {
    readonly keyId: string;
    readonly decisionId?: string;
    readonly outcome: "allow" | "confirm" | "deny";
    readonly notionalUsd: string | null;
    readonly rules: readonly PolicyRuleResult[];
    readonly violations: readonly PolicyViolation[];
    readonly triggers: readonly PolicyViolation[];
    readonly warnings: readonly string[];
    /** Error code the API would refuse with (precedence of the design's §13); null when allowed or held. */
    readonly code: string | null;
    readonly effectiveConstraints?: Readonly<Record<string, unknown>>;
    readonly usage?: readonly { readonly scope: string; readonly window: string; readonly usedUsd: string; readonly capUsd: string | null }[];
    readonly schedule?: readonly { readonly scope: string; readonly open: boolean; readonly nextChange: string | null; readonly timezone: string }[];
    /** False when planning failed and only request-level rules ran. */
    readonly complete: boolean;
    readonly [extra: string]: unknown;
  };
  readonly intent: IntentGraph | null;
  readonly planError: { readonly code: string; readonly message: string } | null;
}

/** Filters of `GET /v1/policy/decisions`. */
export interface PolicyDecisionFilter {
  readonly keyId?: string;
  readonly intentId?: string;
  readonly outcome?: "allow" | "confirm" | "deny" | "approved" | "rejected" | "observed";
  readonly stage?: "plan" | "prepare" | "submit" | "evaluate" | "approval" | "amendment" | "key";
  readonly since?: string;
  readonly after?: string;
  readonly limit?: number;
}

/** `GET /v1/policy/decisions`: newest first, with the chain head to check continuity (`verifyDecisionChain`). */
export interface PolicyDecisionList {
  readonly decisions: readonly PolicyDecision[];
  readonly head: { readonly seq: number; readonly chainHash: string } | null;
}

/** `GET /v1/policy/spend`: usage and what remains for every scope of the key's chain. */
export interface PolicySpendReport {
  readonly keyId: string;
  readonly at: string;
  readonly scopes: readonly {
    readonly scope: string;
    readonly kind: "project" | "key";
    readonly capDailyUsd: string | null;
    readonly usedDailyUsd: string;
    readonly remainingDailyUsd: string | null;
    readonly capWeeklyUsd: string | null;
    readonly usedWeeklyUsd: string;
    readonly remainingWeeklyUsd: string | null;
    readonly perStepUsd: string | null;
    readonly perIntentUsd: string | null;
  }[];
}

/** An approval as `GET /v1/policy/approvals/{id}` shows it (addresses masked). */
export interface PolicyApprovalView {
  readonly id: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly intentId: string;
  readonly keyId: string;
  readonly title: string | null;
  readonly steps: readonly {
    readonly id: string;
    readonly kind: string;
    readonly network: NetworkKey;
    readonly destinationNetwork?: NetworkKey;
    readonly protocol: string;
    readonly input?: string;
    readonly output?: string;
    readonly recipient: string;
    readonly recipientName?: string;
  }[];
  readonly recipients: readonly string[];
  readonly notionalUsd: string | null;
  readonly ceilingUsd: string;
  readonly triggers: readonly string[];
  /** `0x` + sha256 of the approval digest input (core `approvalDigest`). */
  readonly digest: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly kind: "key" | "wallet"; readonly id: string } | null;
  readonly approvers: { readonly requireWallet: boolean; readonly wallets: readonly string[]; readonly keys: number };
  /** What a wallet signs (core `approvalTypedData` / `approvalMessageText`). */
  readonly signing: {
    readonly approvalId: string;
    readonly intentId: string;
    readonly digest: string;
    readonly ceilingUsdCents: string;
    /** Latest unix second a decision signature may be valid until. */
    readonly maxExpiresAt: number;
  };
}

/** Filters of `GET /v1/policy/approvals`. */
export interface PolicyApprovalFilter {
  /** `approver`: approvals the caller may decide; `requester` (default): the caller subtree's requests. */
  readonly role?: "approver" | "requester";
  readonly status?: "pending" | "approved" | "rejected" | "expired";
  readonly limit?: number;
}

/* ------------------------------------------------------------ agent keys */

/** `POST /v1/keys/{id}/children` body. */
export interface CreateChildKeyRequest {
  readonly name: string;
  /** 3,600-31,536,000 (default 30 days); never later than the parent's expiry. */
  readonly expiresInSeconds?: number;
  /** The agent's first rule book (or `template`; neither: the observer). */
  readonly policy?: PolicyDocument;
  readonly template?: PolicyTemplateId;
  /** Values for the template's `fill` paths. */
  readonly fill?: PolicyTemplateFill;
}

/** `POST /v1/keys/{id}/children` (201): the agent key (`key.key` holds the secret, shown once) and its rule book version 1. */
export interface CreatedChildKey {
  readonly key: {
    readonly id: string;
    readonly name: string;
    readonly tier: string;
    readonly kind: "agent";
    readonly parentId: string;
    readonly depth: number;
    readonly createdAt: string;
    readonly expiresAt: string;
    /** `kl_agt_…`, present only in this response. */
    readonly key?: string;
  };
  readonly policy: {
    readonly scope: "key";
    readonly keyId: string;
    readonly version: number;
    readonly hash: string | null;
    readonly status: string;
    readonly warnings: readonly PolicyWarning[];
  };
}

/* ---------------------------------------------------------------- links */

/** `PATCH /v1/links/{id}`: tighten only (anything else is LINK_IMMUTABLE_FIELD). */
export interface LinkPatch {
  readonly title?: string;
  readonly description?: string;
  readonly status?: "active" | "paused";
  /** With `status: "active"`: re-pin after a recipient or contract changed. */
  readonly accept?: readonly ("recipient_changed" | "contract_changed")[];
  readonly funding?: Partial<{
    readonly networks: readonly NetworkKey[];
    readonly assets: readonly string[];
    readonly amount: LinkDefinition["funding"]["amount"] | { readonly mode: "input"; readonly bounds: Readonly<Record<string, Partial<{ min: string; max: string; default: string }>>> };
  }>;
  readonly maxUses?: number;
  readonly perAccount?: { readonly maxUses: number };
  readonly expiresAt?: string;
  readonly blink?: false;
}

/** `POST /v1/links/{id}/quote` and `/intents` body (`accounts` optional for a quote). */
export interface LinkVisitorRequest {
  readonly accounts?: readonly string[];
  readonly source: { readonly network: NetworkKey; readonly asset: string };
  readonly amount?: string;
  /** Intents only: a retry with the same reference returns the stored intent. */
  readonly clientReference?: string;
}

/** A link quote or a visitor's intent with its fare (asset-change preview). */
export interface LinkIntentResponse {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview;
}

export type {
  AbiFunctionClassification,
  AssetChange,
  AssetDescriptor,
  ContractDefinition,
  ContractInspection,
  ContractReview,
  ContractStatus,
  ContractStepCall,
  ContractTestRequest,
  ContractTestResult,
  ContractView,
  ContractVm,
  EvmContractDefinition,
  EvmContractInspectionView,
  IntentGraph,
  IntentPreview,
  IntentRequest,
  LinkDefinition,
  LinkFundingChoice,
  LinkOwnerView,
  LinkStats,
  LinkView,
  ProtocolDescriptor,
  SessionCreateRequest,
  SessionIntentRequest,
  SessionView,
  SolanaActionDefinition,
  SolanaProgramInspectionView,
};
