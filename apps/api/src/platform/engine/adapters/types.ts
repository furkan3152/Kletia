/**
 * Protocol adapter contract. An adapter turns one resolved action into a
 * quote-backed planned step, re-quotes it into wallet-ready transactions on
 * prepare, verifies submitted references on-chain and, for cross-network
 * venues, polls settlement.
 */
import type {
  AssetAmount,
  ExecutionMode,
  IntentActionKind,
  IntentGraph,
  IntentStep,
  NetworkKey,
  ParsedAccountId,
  PreparedStepRecord,
  ProtocolId,
  StepEvidence,
  StepSettlement,
  TransactionRequest,
} from "@kletia/core";
import type { ResolvedAsset } from "../assets.js";

/** The shape an adapter needs to decide whether it can serve an action. */
export interface AdapterRoute {
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly destinationNetwork: NetworkKey;
  readonly input: ResolvedAsset;
  readonly output: ResolvedAsset;
}

export interface AdapterAction extends AdapterRoute {
  /** Base units of `input`. */
  readonly amount: string;
  readonly account: ParsedAccountId;
  readonly recipient: ParsedAccountId;
  readonly slippageBps: number;
  /** Liquid-staking provider label for stake actions (e.g. "Marinade"). */
  readonly provider?: string;
}

export interface PlannedStep {
  readonly protocol: ProtocolId;
  readonly title: string;
  readonly mode: ExecutionMode;
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly feesUsd?: number;
  readonly estimatedSeconds: number;
  readonly settlement: StepSettlement;
  readonly warnings: readonly string[];
  /** Provider quote handle (e.g. a Relay request id). */
  readonly quoteId?: string;
  /** Wallet transactions the step is expected to need. */
  readonly transactionCount: number;
  /** Slippage actually applied (may be tighter than requested). */
  readonly slippageBps: number;
}

export interface PrepareContext {
  readonly graph: IntentGraph;
  readonly step: IntentStep;
  /** The step's action rebuilt from the graph with the amount to execute now. */
  readonly action: AdapterAction;
  readonly now: number;
}

export interface PreparedPayload {
  readonly transactions: readonly TransactionRequest[];
  readonly records: PreparedStepRecord["transactions"];
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly feesUsd?: number;
  /** Settlement-network tracking id (e.g. Relay request id). */
  readonly trackingId?: string;
  readonly quoteId?: string;
  readonly warnings: readonly string[];
}

export interface VerifyContext {
  readonly step: IntentStep;
  readonly references: readonly string[];
  /** Unix ms when the references were submitted. */
  readonly submittedAt: number;
  readonly now: number;
}

export interface StepFailure {
  readonly code: string;
  readonly message: string;
}

export type VerificationResult =
  | { readonly status: "confirmed"; readonly evidence: readonly StepEvidence[]; readonly actualOutput?: AssetAmount }
  | { readonly status: "pending"; readonly evidence: readonly StepEvidence[]; readonly reason: string; readonly stale: boolean }
  | { readonly status: "failed"; readonly evidence: readonly StepEvidence[]; readonly failure: StepFailure };

export type SettlementResult =
  | { readonly status: "settling"; readonly evidence: readonly StepEvidence[]; readonly trackingId?: string }
  | { readonly status: "settled"; readonly evidence: readonly StepEvidence[]; readonly actualOutput?: AssetAmount }
  | { readonly status: "failed"; readonly evidence: readonly StepEvidence[]; readonly failure: StepFailure };

export interface ProtocolAdapter {
  /** Primary protocol id; `protocols` lists every id this adapter executes. */
  readonly id: ProtocolId;
  readonly protocols: readonly ProtocolId[];
  readonly label: string;
  supports(route: AdapterRoute): boolean;
  plan(action: AdapterAction): Promise<PlannedStep>;
  prepare(context: PrepareContext): Promise<PreparedPayload>;
  verify(context: VerifyContext): Promise<VerificationResult>;
  poll?(step: IntentStep, now: number): Promise<SettlementResult>;
}
