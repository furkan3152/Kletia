import type {
  AccountId,
  AssetAmount,
  AssetDescriptor,
  AssetId,
  ChainDescriptor,
  ErrorCatalogRow,
  IntentGraph,
  IntentRequest,
  NetworkKey,
  ProtocolDescriptor,
  ProtocolId,
  StepExecutionPayload,
  StepSettlement,
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
}

export interface PreparedStep {
  readonly intent: IntentGraph;
  readonly payload: StepExecutionPayload;
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

export type { AssetDescriptor, IntentGraph, IntentRequest, ProtocolDescriptor };
