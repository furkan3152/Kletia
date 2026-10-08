import type {
  AccountId,
  AssetDescriptor,
  ChainDescriptor,
  IntentGraph,
  IntentRequest,
  NetworkKey,
  ProtocolDescriptor,
  ProtocolId,
  StepExecutionPayload,
} from "@kletia/core";

export interface NetworkCapabilities extends ChainDescriptor {
  readonly actions: readonly string[];
  readonly protocols: readonly ProtocolId[];
}

export interface HealthReport {
  readonly status: "ok" | "degraded" | "down";
  readonly version?: string;
  readonly networks: readonly {
    readonly network: NetworkKey;
    readonly ok: boolean;
    readonly latencyMs?: number;
    readonly detail?: string;
  }[];
}

export interface QuoteRequest {
  readonly from: { readonly network: NetworkKey; readonly asset: string; readonly amount: string };
  readonly to: { readonly network: NetworkKey; readonly asset: string };
  /** CAIP-10 account that will sign (improves accuracy for cross-network quotes). */
  readonly account?: AccountId;
  readonly recipient?: string;
  readonly slippageBps?: number;
}

export interface QuoteRoute {
  readonly protocol: ProtocolId;
  readonly input: { readonly asset: string; readonly symbol: string; readonly amount: string; readonly formatted: string };
  readonly output: { readonly asset: string; readonly symbol: string; readonly amount: string; readonly formatted: string };
  readonly minimumOutput?: { readonly amount: string; readonly formatted: string };
  readonly feesUsd?: number;
  readonly estimatedSeconds?: number;
  readonly warnings?: readonly string[];
}

export interface QuoteResponse {
  readonly routes: readonly QuoteRoute[];
  readonly best: QuoteRoute | null;
}

export interface PortfolioHolding {
  readonly asset?: string;
  readonly symbol: string;
  readonly name?: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  readonly usdValue: number | null;
}

export interface PortfolioResponse {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly totalUsd: number;
  readonly holdings: readonly PortfolioHolding[];
  readonly observedAt?: string;
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
  /** Present only in the creation response. */
  readonly key?: string;
}

export type { AssetDescriptor, IntentGraph, IntentRequest, ProtocolDescriptor };
