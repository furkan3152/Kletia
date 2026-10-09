/**
 * Protocol adapter contract. An adapter turns one resolved action into a
 * quote-backed planned step, re-quotes it into wallet-ready transactions on
 * prepare, verifies submitted references on-chain and, for cross-network
 * venues, polls settlement.
 *
 * How an adapter declares what it serves:
 * - `protocols` + `supports(route)`: the action kinds, networks and assets.
 *   The registry (`PROTOCOLS[].kinds` in @kletia/core) documents the same kinds.
 * - Deposit / withdraw venues come from `YIELD_VENUES` in @kletia/core. The
 *   planner resolves and validates the venue before `plan` and passes its id
 *   as `AdapterAction.venue`; adapters look it up with `getYieldVenue` and
 *   never take a market or vault address from anywhere else.
 * - Value paid above the step amount (a bridge's fixed native fee) is reported
 *   in `PlannedStep.extraCosts` / `PreparedPayload.extraCosts` so the
 *   cross-network auction compares venues by net guaranteed output.
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
  /**
   * Base units of `input`. For a withdraw with `closePosition` this is "0" at
   * plan time (the adapter reads the position and returns its size as
   * `PlannedStep.input`) and the planned size at prepare (informational: the
   * adapter withdraws the whole position, e.g. amount = MAX / redeem(balanceOf)).
   */
  readonly amount: string;
  readonly account: ParsedAccountId;
  readonly recipient: ParsedAccountId;
  readonly slippageBps: number;
  /** Liquid-staking provider label for stake actions (e.g. "Marinade"). */
  readonly provider?: string;
  /**
   * Deposit / withdraw: the YIELD_VENUES id the planner resolved and validated
   * (its protocol, network and underlying asset match this action). Read it
   * with `getYieldVenue(action.venue)`.
   */
  readonly venue?: string;
  /** Withdraw only: close the whole position at `venue` ("withdraw all"). */
  readonly closePosition?: boolean;
  /**
   * Cross-network steps: the user's own account on `destinationNetwork`, when
   * the intent's accounts identify one. Unlike `recipient` (which may be a
   * third party), venues may hand it rights on the destination, such as
   * cancelling an unfilled deBridge DLN order.
   */
  readonly destinationAccount?: ParsedAccountId;
}

export interface PlannedStep {
  readonly protocol: ProtocolId;
  readonly title: string;
  readonly mode: ExecutionMode;
  /**
   * What the step consumes. For a withdraw: the underlying amount taken out of
   * the position (for `closePosition`, the position's current size).
   */
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly feesUsd?: number;
  /**
   * Value paid on top of `input` (e.g. DLN's fixed `msg.value` fee, in the
   * native asset). Set `usd` on each entry when known: the auction excludes a
   * venue whose extra costs it cannot price.
   */
  readonly extraCosts?: readonly AssetAmount[];
  /** Estimated seconds until the step's output is usable (settlement included). */
  readonly estimatedSeconds: number;
  readonly settlement: StepSettlement;
  readonly warnings: readonly string[];
  /** Provider quote handle (e.g. a Relay request id). */
  readonly quoteId?: string;
  /**
   * Route variant every prepare must keep (e.g. LI.FI's bridge tool, whose
   * settlement time the auction ranked). The planner records it in the step
   * ref; prepare receives it back as `AdapterAction.provider`.
   */
  readonly provider?: string;
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
  /**
   * Value paid on top of `input`, as in PlannedStep. Prepare refuses
   * (QUOTE_MOVED) an extra cost the plan did not have or one above the
   * planned amount plus the step's slippage.
   */
  readonly extraCosts?: readonly AssetAmount[];
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
