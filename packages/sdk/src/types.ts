import type {
  AccountId,
  AssetAmount,
  AssetDescriptor,
  AssetId,
  ChainDescriptor,
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
  readonly webhooks: { readonly status: "enabled" | "needs_configuration" };
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
  readonly label: string;
  readonly network: NetworkKey;
  readonly toNetwork: NetworkKey;
  readonly input: AssetAmount;
  readonly output: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly feesUsd?: number;
  readonly estimatedSeconds: number;
  readonly transactionCount: number;
  readonly settlement: StepSettlement;
  readonly warnings: readonly string[];
  readonly quoteId?: string;
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
  /** Present only in the creation response. */
  readonly key?: string;
}

export type { AssetDescriptor, IntentGraph, IntentRequest, ProtocolDescriptor };
