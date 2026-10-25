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
import type { StepPreview } from "./preview.js";
import type { PlanRecord } from "./receipts.js";
import type { AssumptionSource } from "./clarify.js";
import type { IntentTextRedaction } from "./retention.js";

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
  /**
   * Payments (`transfer`, or a `bridge` that pays a recipient): the recipient
   * receives exactly `amount`; the input is sized up to cover the crossing's
   * fees (inverse quote). Absent: `amount` is what is spent.
   */
  readonly receiveExact?: true;
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
  /**
   * Gas to deliver with the first cross-network leg arriving on each named
   * EVM network, in USD (decimal string, "0.05" to "5.00"), e.g.
   * `{ base: "0.50" }`. Opt-in: only venues that deliver gas with the fill can
   * serve that leg (Relay today); otherwise planning fails with
   * GAS_TOPUP_UNAVAILABLE. Validated by `validateIntentRequest`.
   */
  readonly gasOnArrival?: Readonly<Partial<Record<NetworkKey, string>>>;
  /**
   * What the route choice optimises: the expected value delivered after costs
   * (default), the fastest settlement, or the fewest wallet signatures.
   */
  readonly routePreference?: RoutePreference;
  /** "single": only single-signature route shapes (one bridge or one cross-network swap per crossing). Default "auto". */
  readonly routeShapes?: "auto" | "single";
  /**
   * Structured `actions[]` only: allow Kletia to insert a crossing leg (a
   * bridge or a cross-network swap) where an action spends funds on another
   * network than the previous action's output. Default false: such a request
   * is refused.
   */
  readonly allowCrossings?: boolean;
}

export const ROUTE_PREFERENCES = Object.freeze(["value", "fastest", "fewest-signatures"] as const);
export type RoutePreference = (typeof ROUTE_PREFERENCES)[number];

/** Where the money of a request starts: a network key, or "auto" (the funded network). */
export type SourceNetwork = NetworkKey | "auto";

export interface IntentRequest {
  /** Natural-language outcome. Either `text` or `actions` is required. */
  readonly text?: string;
  readonly actions?: readonly IntentActionSpec[];
  /** Accounts the user controls, as CAIP-10 ids (one per VM is typical). */
  readonly accounts: readonly AccountId[];
  /** Network to assume when the text does not name one. */
  readonly defaultNetwork?: NetworkKey;
  /**
   * Where the funds start. A network key: the first action spends funds that
   * are there, and when that action runs on another network the planner adds a
   * bridge from this one first. "auto": the planner picks a network on which
   * the accounts hold enough of the first action's input. Absent: unchanged
   * behaviour. A network key also serves as defaultNetwork when that is absent.
   * With preview (demo) accounts "auto" behaves as absent.
   */
  readonly sourceNetwork?: SourceNetwork;
  readonly constraints?: IntentConstraints;
  /** Opaque integrator metadata echoed in events and webhooks. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Integrator-supplied idempotency key. */
  readonly clientReference?: string;
  /**
   * Stored intents only, never accepted in a request: set when retention
   * removed `text` (docs/platform/data-retention.md). Carries a salted digest
   * and the length of the removed text.
   */
  readonly textRedaction?: IntentTextRedaction;
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
  /**
   * Pinned account nonce (decimal), set when the owner's rule book pins
   * nonces (policy `execution.pinNonce`): two payloads with the same nonce
   * cannot both land. Signers that declare `honorsNonce` must use it.
   */
  readonly nonce?: string;
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
  /**
   * Simulated (or quoted) effect of exactly these transactions; its
   * `quoteBinding` equals the payload's (asset-change preview).
   */
  readonly preview?: StepPreview;
  /** Rule Book clearance of this payload: the decision and the exposure counted against caps. */
  readonly policy?: StepPolicyClearance;
}

/** Ties a prepared payload to the policy decision that cleared it. */
export interface StepPolicyClearance {
  readonly decisionId: string;
  readonly exposureId: string;
  /** USD notional counted, decimal with 2 decimals; null when no USD rule applied. */
  readonly notionalUsd: string | null;
  /** Hashes (`sha256:…`) of every rule book in the owner's chain, root first. */
  readonly chainHashes: readonly string[];
}

/** One rule book of a key's policy chain, as stamped on intents and decisions. */
export interface PolicyChainLink {
  readonly scope: "project" | "key";
  /** `prj_…` for the project rule book, the key id otherwise. */
  readonly id: string;
  readonly version: number;
  /** `sha256:` + hex of the canonical document. */
  readonly hash: string;
}

/**
 * Plan-time policy stamp of a stored intent (immutable, like the rest of the
 * graph). `confirm` intents are on hold until an approver approves.
 */
export interface IntentPolicyStamp {
  readonly decisionId: string;
  readonly outcome: "allow" | "confirm";
  /** Owner key whose chain was evaluated. */
  readonly keyId: string;
  readonly chain: readonly PolicyChainLink[];
  /** Fresh value of the intent in USD (2 decimals); null when no USD rule needed it. */
  readonly notionalUsd: string | null;
  readonly evaluatedAt: string;
  readonly approval?: {
    readonly id: string;
    /** `<web origin>/approve#apr_…`: safe to hand to the agent (reading is not approving). */
    readonly url: string;
    readonly expiresAt: string;
    readonly ceilingUsd: string;
    /** Rule ids that asked for the approval (`confirm.aboveUsd`, …). */
    readonly triggers: readonly string[];
  };
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

/**
 * How a step is funded by an earlier step (set by the planner; read by the
 * preview, the journey and prepare). Mirrors the `funds` edge, plus the share
 * and the gas kept back.
 */
export interface StepFunding {
  /** Step whose output this step spends (the `funds` edge's `from`). */
  readonly from: string;
  /** Share of that output, in basis points (10000 = all of it). */
  readonly portionBps: number;
  /**
   * Gas-asset units kept back from what arrives when the input is the
   * network's gas asset and the account held too little gas there at planning
   * (amount flow F6). Prepare spends share × landed − gasReserve.
   */
  readonly gasReserve?: AssetAmount;
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
  /** Present on steps that spend an earlier step's output. */
  readonly funding?: StepFunding;
  /**
   * Gas delivered with a cross-network fill (Relay `topupGas`): the planned
   * amount of the destination's gas asset, in base units, and its USD at
   * planning. Delivered by the venue, never bound on-chain; the step settles on
   * its main output alone.
   */
  readonly gasTopup?: AssetAmount;
  /**
   * Credit observed on the destination for a leg that failed its checks
   * (below the guaranteed floor). The money is in the recipient's wallet; the
   * step stays failed and no later step spends it.
   */
  readonly observedCredit?: AssetAmount;
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

/** How the network the money starts on was decided (`interpretation.departure`). */
export interface IntentDeparture {
  readonly network: NetworkKey;
  /** text: the sentence named it; request: sourceNetwork; auto: chosen by balance; inferred: no hint was given. */
  readonly chosen: "text" | "request" | "auto" | "inferred";
  /** True when the planner added a bridge from `network` in front of the first action. */
  readonly bridged?: boolean;
  /** One sentence, at most 160 characters ("Base holds 120.40 USDC; Solana 2.00"). */
  readonly reason?: string;
}

/** A default the clarify layer applied and showed as a chip (`interpretation.assumptions`). */
export interface InterpretationAssumption {
  /** Slot path, e.g. "actions[0].network". */
  readonly field: string;
  /** "On Base", "All your SOL: 2.49". */
  readonly label: string;
  readonly source: AssumptionSource;
  /** Changes where money goes or how much moves. */
  readonly material: boolean;
}

/** Route shapes a crossing or a step can take (`interpretation.routes[].shape`). */
export const ROUTE_SHAPES = Object.freeze(["single", "bridge", "one-shot", "bridge-swap", "swap-bridge", "swap-bridge-swap", "wrap"] as const);
export type RouteShape = (typeof ROUTE_SHAPES)[number];

/**
 * How a route was scored (all USD at quote time). `minimumKind`: "onchain"
 * when every leg's floor is enforced by a contract, "claimed" when a solver
 * promises it and it is checked after settlement (shown as "quoted minimum").
 */
export interface RouteScore {
  readonly valueUsd: number;
  readonly expectedUsd: number;
  readonly minimumUsd: number;
  readonly minimumKind: "onchain" | "claimed";
  readonly gasUsd: number;
  readonly feesUsd: number;
  readonly seconds: number;
  readonly signatures: number;
  readonly riskUsd: number;
  /** Set when a number comes from a cached pre-screen quote, not a fresh one. */
  readonly estimate?: true;
}

/** Every score input of one route choice, so "the same plan" is checkable over it. */
export interface RouteSnapshot {
  readonly quotes: readonly {
    readonly venue: ProtocolId;
    readonly id?: string;
    readonly expected: string;
    readonly minimum: string;
    /** Unix ms. */
    readonly at: number;
  }[];
  readonly cutByDeadline: readonly ProtocolId[];
  readonly breakerSkipped: readonly ProtocolId[];
  readonly haircutsBps: Readonly<Record<string, number>>;
  readonly gas: Readonly<Record<string, string>>;
}

/** Why a leg (or a step) took its route, in Kletia's own words (`interpretation.routes`). */
export interface RouteChoice {
  /** Step ids of this leg. */
  readonly steps: readonly string[];
  readonly shape: RouteShape;
  /** The token carried across networks by a composite ("USDC"). */
  readonly carrier?: string;
  readonly venues: readonly ProtocolId[];
  readonly score: RouteScore;
  /** At most 200 characters. */
  readonly reason: string;
  /** At most 6: the other shapes and venues compared, scored or with why they were excluded. */
  readonly compared: readonly { readonly label: string; readonly score?: RouteScore; readonly excluded?: string }[];
  /** At most 3 re-plans with a constraint (Fastest, Fewest signatures, a named bridge). */
  readonly alternatives: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly constraints: Partial<IntentConstraints>;
  }[];
  readonly snapshot: RouteSnapshot;
}

/** A provider that received a quote request for this plan, and whether it saw the person's account. */
export interface ProviderContact {
  readonly provider: ProtocolId;
  readonly sawAccount: boolean;
}

/**
 * Set when a step was read with model-assisted reading: the masked clause was
 * sent, every family agreed, and whether the person confirmed the rendered
 * plan. No vendor or model names.
 */
export interface InterpretationModelReading {
  readonly used: true;
  readonly sent: "masked_clause";
  readonly families: number;
  readonly agreed: true;
  readonly confirmed: boolean;
}

export interface IntentInterpretation {
  readonly source: "structured" | "grammar" | "assistant";
  readonly normalizedText?: string;
  readonly confidence: number;
  /** Planner rewrites applied (e.g. merged bridge + swap into one cross-network swap). */
  readonly optimizations?: readonly string[];
  /** Where the money starts, when the request set `sourceNetwork` or clarify applied a departure. */
  readonly departure?: IntentDeparture;
  /** Defaults the clarify layer applied (the chips the user saw). */
  readonly assumptions?: readonly InterpretationAssumption[];
  /** The clarify thread revision this intent was planned from. */
  readonly thread?: { readonly id: string; readonly rev: number };
  /** How each crossing or step took its route (shape, venues, score, compared, alternatives, snapshot). */
  readonly routes?: readonly RouteChoice[];
  /** Every provider that received a quote request for this plan. */
  readonly providersContacted?: readonly ProviderContact[];
  /** Present when a step was read with model-assisted reading. */
  readonly modelReading?: InterpretationModelReading;
}

export interface IntentGraph {
  readonly spec: typeof INTENT_SPEC_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly status: IntentStatus;
  readonly request: IntentRequest;
  readonly interpretation: IntentInterpretation;
  readonly steps: readonly IntentStep[];
  readonly edges: readonly IntentEdge[];
  readonly summary: IntentSummary;
  readonly warnings: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * The plan as created, captured once at planning (`buildPlanRecord`), and
   * its digest (`planRecordDigest`). Absent on intents created before plan
   * records. Receipts commit to it; prepare never changes it. Retention
   * sets `record.interpretation.normalizedText` to null when it removes the
   * request text, and recomputes the digest (docs/platform/data-retention.md).
   */
  readonly plan?: { readonly digest: string; readonly record: PlanRecord };
  /** Rule Book stamp of an intent planned for a key with a policy chain. */
  readonly policy?: IntentPolicyStamp;
}
