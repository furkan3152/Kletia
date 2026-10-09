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
  ContractReview,
  ContractStepCall,
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
import type { RegisteredContract } from "../contracts/directory.js";

/** A call / action step's registration snapshot before the adapter attaches its review. */
export type ContractCallSnapshot = Omit<ContractStepCall, "review"> & { readonly review?: ContractReview };

/**
 * What a call (EVM) or action (Solana Actions) step executes: the
 * self-contained snapshot (`IntentStep.call`) plus the context its bindings
 * need. The planner builds it from the active revision; at prepare it is the
 * step's own snapshot and the registration re-read by the service.
 */
export interface ContractCallContext {
  readonly snapshot: ContractCallSnapshot;
  /** The entry's input asset; null when the entry spends nothing (e.g. claim). */
  readonly input: ResolvedAsset | null;
  /** The declared output asset; null when the entry declares none. */
  readonly output: ResolvedAsset | null;
  /** Output of the previous step on the same network (`$previous.*`): guaranteed minimum at plan, observed output at prepare. */
  readonly previousOutput?: AssetAmount;
  /** The registration (plan, test: the resolved one; prepare: re-read and matched to the snapshot by the service). */
  readonly registration?: RegisteredContract;
  /** True when the step spends the previous step's output (it may not be in the wallet at plan time). */
  readonly funded: boolean;
  /** `plan` may override the input balance in simulation; `prepare` and `test` simulate real state. */
  readonly stage: "plan" | "prepare" | "test";
}

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
  /** Call / action steps only: the registration snapshot and binding context (`adapterForProtocol` adapters). */
  readonly call?: ContractCallContext;
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
  /** Call / action steps: the snapshot the step executes (with the plan review). */
  readonly call?: ContractStepCall;
  readonly review?: ContractReview;
}

/**
 * Plan of a call / action step. Unlike other steps, a non-spending entry
 * (`claim`) has no input and an entry without a declared output has no
 * outputs; the planner then leaves those IntentStep fields unset.
 */
export interface ContractPlannedStep extends Omit<PlannedStep, "input" | "expectedOutput" | "minimumOutput" | "call" | "review"> {
  readonly kind: "call";
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly call: ContractStepCall;
  readonly review: ContractReview;
}

export interface PrepareContext {
  readonly graph: IntentGraph;
  readonly step: IntentStep;
  /** The step's action rebuilt from the graph with the amount to execute now. */
  readonly action: AdapterAction;
  readonly now: number;
  /** Unix seconds the payload expires at (call steps bind `$deadline` to it + 900 s). */
  readonly expiresAt?: number;
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
  /** Call / action steps: the review of exactly these transactions (returned as `payload.review`). */
  readonly review?: ContractReview;
}

/** Prepared payload of a call / action step (input and outputs optional, review required). */
export interface ContractPreparedPayload extends Omit<PreparedPayload, "input" | "expectedOutput" | "minimumOutput" | "review"> {
  readonly kind: "call";
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly review: ContractReview;
  /** Evidence binding the payload beyond the quote binding (Solana Actions: the instruction digest). */
  readonly evidence?: readonly StepEvidence[];
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

/**
 * Adapters of call / action steps (`custom-call`, `solana-actions`). Route
 * search never picks them (`supports` is false); the planner selects them by
 * protocol and uses `planCall` / `prepareCall`, whose results may lack input
 * and outputs. `plan` / `prepare` refuse.
 */
export interface ContractProtocolAdapter extends ProtocolAdapter {
  readonly contract: true;
  planCall(action: AdapterAction): Promise<ContractPlannedStep>;
  prepareCall(context: PrepareContext): Promise<ContractPreparedPayload>;
}
