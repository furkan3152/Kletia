/**
 * Kletia Intent Specification v1.
 *
 * An intent is a user-level outcome ("move 100 USDC from Base to Solana and
 * stake half as JitoSOL"). The planner compiles it into an IntentGraph: a
 * DAG of network-bound steps, each owned by exactly one account and executed
 * by exactly one protocol adapter. Cross-network steps settle asynchronously
 * and carry their own evidence; nothing in the graph is globally atomic.
 */
import type { CaipChainId, NetworkKey, VirtualMachine } from "./chains.js";
import type { AccountId, AssetId } from "./caip.js";
import type { ProtocolId } from "./protocols.js";
import type { ContractReview, ContractStepCall } from "./contracts.js";

export const INTENT_SPEC_VERSION = "kletia.intent/v1" as const;

export type IntentActionKind =
  | "swap"
  | "transfer"
  | "bridge"
  | "stake"
  | "unstake"
  | "deposit"
  | "withdraw"
  | "borrow"
  | "repay"
  | "approve"
  | "claim"
  | "read"
  /** Call of an integrator-registered EVM contract action (protocol `custom-call`). */
  | "call"
  /** Integrator-registered Solana Action (protocol `solana-actions`). */
  | "action";

export interface AssetAmount {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units as a decimal integer string. */
  readonly amount: string;
  /** Human-readable decimal string. */
  readonly formatted: string;
  readonly usd?: number;
}

export interface AssetRef {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
}

/** A structured action an integrator can submit instead of natural language. */
export interface IntentActionSpec {
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  /** Input asset: symbol on `network`, or a CAIP-19 id. */
  readonly from?: string;
  /** Output asset: symbol, or a CAIP-19 id (for bridges may be on `toNetwork`). */
  readonly to?: string;
  /**
   * Decimal amount of `from` (human units), or "max": the previous step's
   * output, or for a `withdraw` the whole position at the venue.
   */
  readonly amount?: string;
  readonly toNetwork?: NetworkKey;
  /**
   * Recipient address, CAIP-10 account or name (`*.eth`, `*.base.eth`,
   * `*.sns`). Defaults to the acting account.
   */
  readonly recipient?: string;
  readonly protocol?: ProtocolId;
  /**
   * Action options: `venue` (deposit/withdraw: a YIELD_VENUES id, slug or
   * vault/market address on `network`), `portionBps` (share of the previous
   * output), `provider` (liquid-staking provider label). For `call` and
   * `action`: the entry's declared parameters (plus `portionBps`).
   */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /**
   * `call` / `action` only (required there, refused elsewhere): a contract
   * registration id (`ct_…`) or alias usable by the API key that creates the
   * intent.
   */
  readonly contract?: string;
  /** `call` / `action` only (required there): the registration's entry id, e.g. `deposit`. */
  readonly entry?: string;
}

export interface IntentConstraints {
  /** Maximum acceptable slippage per swap step in basis points. Default 50. */
  readonly maxSlippageBps?: number;
  /** Unix seconds after which the plan must not be executed. */
  readonly deadline?: number;
  /** Upper bound for total fees across all steps, in USD. */
  readonly maxFeeUsd?: number;
  /**
   * Longest acceptable settlement estimate for a cross-network step, in
   * seconds (default 600). Slower venue quotes lose the auction.
   */
  readonly maxSeconds?: number;
  /** Venues to choose first when several can serve a step. */
  readonly preferProtocols?: readonly ProtocolId[];
  /** Venues never to use. */
  readonly avoidProtocols?: readonly ProtocolId[];
  /** Only produce routes inside one capital lane (default: enforced). */
  readonly allowTestnets?: boolean;
}

export interface IntentRequest {
  /** Natural-language outcome. Either `text` or `actions` is required. */
  readonly text?: string;
  readonly actions?: readonly IntentActionSpec[];
  /** Accounts the user controls, as CAIP-10 ids (one per VM is typical). */
  readonly accounts: readonly AccountId[];
  /** Network to assume when the text does not name one. */
  readonly defaultNetwork?: NetworkKey;
  readonly constraints?: IntentConstraints;
  /** Opaque integrator metadata echoed in events and webhooks. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Integrator-supplied idempotency key. */
  readonly clientReference?: string;
}

export type IntentStatus =
  | "planned"
  | "executing"
  | "settling"
  | "completed"
  | "partially_completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "indeterminate";

export type StepStatus =
  | "pending"
  | "ready"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "settling"
  | "settled"
  | "failed"
  | "skipped"
  | "indeterminate";

export type ExecutionMode =
  /** User signs a transaction in their wallet. */
  | "wallet"
  /** An off-chain network (solver/attestation) completes the step. */
  | "settlement"
  /** Read-only step: no value moves. */
  | "read";

export interface EvmTransactionRequest {
  readonly vm: "evm";
  readonly network: NetworkKey;
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  /** Wei as a decimal integer string. */
  readonly value: string;
  readonly gas?: string;
  readonly description: string;
}

export interface SolanaTransactionRequest {
  readonly vm: "svm";
  readonly network: NetworkKey;
  readonly feePayer: string;
  /** Serialized, unsigned versioned transaction. */
  readonly transaction: string;
  readonly encoding: "base64";
  readonly lastValidBlockHeight?: number;
  readonly description: string;
}

export type TransactionRequest = EvmTransactionRequest | SolanaTransactionRequest;

/** Ordered transactions that together complete one step (e.g. approve + swap). */
export interface StepExecutionPayload {
  readonly vm: VirtualMachine;
  readonly transactions: readonly TransactionRequest[];
  /** Unix seconds after which the payload must be re-prepared. */
  readonly expiresAt: number;
  /** Hash binding the payload to the quote it was prepared from. */
  readonly quoteBinding: string;
  /**
   * Call and action steps: the review of exactly these transactions
   * (integrator, decoded call, approvals, simulated asset changes, "Not
   * audited by Kletia"). Render it before handing the transactions to a wallet.
   */
  readonly review?: ContractReview;
}

export interface StepEvidence {
  readonly kind:
    | "transaction"
    | "receipt"
    | "settlement"
    | "quote"
    | "balance"
    | "note";
  readonly network: NetworkKey;
  readonly reference?: string;
  readonly url?: string;
  readonly observedAt: string;
  readonly detail?: string;
}

export interface StepSettlement {
  readonly kind: "same-network" | "cross-network";
  readonly destinationNetwork?: NetworkKey;
  /** External tracking reference (e.g. Relay request id). */
  readonly trackingId?: string;
  readonly expectedSeconds?: number;
}

/** What the wallet was asked to sign for a step (recorded at prepare time). */
export interface PreparedStepRecord {
  readonly quoteBinding: string;
  readonly preparedAt: string;
  readonly expiresAt: number;
  readonly transactions: readonly {
    readonly vm: VirtualMachine;
    readonly network: NetworkKey;
    /** EVM call target. */
    readonly to?: string;
    /** Solana fee payer. */
    readonly feePayer?: string;
    readonly description: string;
  }[];
}

export interface IntentStep {
  readonly id: string;
  readonly index: number;
  readonly kind: IntentActionKind;
  readonly title: string;
  readonly network: NetworkKey;
  readonly chain: CaipChainId;
  readonly account: AccountId;
  readonly protocol: ProtocolId;
  readonly mode: ExecutionMode;
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly recipient?: AccountId;
  /** Name the recipient was resolved from (ENS, Basenames, SNS); re-resolved before every prepare. */
  readonly recipientName?: string;
  /** Registry venue (YIELD_VENUES id) a deposit or withdraw step executes against. */
  readonly venue?: string;
  readonly dependsOn: readonly string[];
  readonly settlement?: StepSettlement;
  readonly feesUsd?: number;
  /** Value the step pays on top of its input (e.g. a bridge's fixed native fee). */
  readonly extraCosts?: readonly AssetAmount[];
  readonly estimatedSeconds?: number;
  readonly status: StepStatus;
  readonly evidence: readonly StepEvidence[];
  /** Adapter-private quote handle the planner uses to re-prepare payloads. */
  readonly quoteRef?: string;
  readonly warnings?: readonly string[];
  /** Present after `prepare`. */
  readonly prepared?: PreparedStepRecord;
  /** Transaction hashes / signatures submitted for this step, in order. */
  readonly references?: readonly string[];
  /** Output observed after settlement, when the venue reports it. */
  readonly actualOutput?: AssetAmount;
  /** Machine-readable reason when the step failed. */
  readonly failure?: { readonly code: string; readonly message: string };
  /**
   * Call and action steps: the registration snapshot (contract id, revision,
   * definition hash, entry, bindings, pins) and the review. Verification
   * only uses this snapshot, never the live registry.
   */
  readonly call?: ContractStepCall;
}

export interface IntentEdge {
  readonly from: string;
  readonly to: string;
  /** `funds`: output of `from` is the input of `to`. `orders`: sequencing only. */
  readonly kind: "funds" | "orders";
}

export interface IntentSummary {
  readonly title: string;
  readonly networks: readonly NetworkKey[];
  readonly inputs: readonly AssetAmount[];
  readonly outputs: readonly AssetAmount[];
  readonly totalFeesUsd?: number;
  readonly estimatedSeconds?: number;
  readonly signaturesRequired: number;
  readonly crossNetwork: boolean;
}

export interface IntentGraph {
  readonly spec: typeof INTENT_SPEC_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly status: IntentStatus;
  readonly request: IntentRequest;
  readonly interpretation: {
    readonly source: "structured" | "grammar" | "assistant";
    readonly normalizedText?: string;
    readonly confidence: number;
    /** Planner rewrites applied (e.g. merged bridge + swap into one cross-network swap). */
    readonly optimizations?: readonly string[];
  };
  readonly steps: readonly IntentStep[];
  readonly edges: readonly IntentEdge[];
  readonly summary: IntentSummary;
  readonly warnings: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}
