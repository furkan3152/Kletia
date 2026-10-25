/**
 * Journey, facts and venue shapes, and the journey limits.
 */
import type { NetworkKey } from "../chains.js";
import type { AccountId } from "../caip.js";
import type { ProtocolId } from "../protocols.js";
import type { Certainty } from "../preview.js";
import type { PolicyDocument } from "../policy.js";
import type {
  AssetAmount,
  AssetRef,
  IntentActionKind,
  IntentActionSpec,
  IntentRequest,
  StepStatus,
} from "../intent.js";
import type {
  AssetIdentityKind,
  ConsequenceKind,
  ConsequenceSeverity,
  CustodyState,
  HoldingRole,
  JOURNEY_SPEC,
  JourneyCertainty,
  JourneyOptionKind,
  JourneyStage,
  JourneyValueSource,
  RefundMode,
  StopKind,
  StopState,
} from "./constants.js";

/* --------------------------------------------------------------- the ledger */

export interface AssetIdentity {
  readonly kind: AssetIdentityKind;
  /** One line, e.g. "Circle-issued USDC (CCTP domain 6)", "Your Aave V3 USDC position: 1 aBasUSDC = 1 USDC plus interest". */
  readonly label: string;
  /** Receipts and liquid-staking tokens: what they are a claim on. */
  readonly underlying?: AssetRef;
}

export interface AmountView {
  /** Positive base units. */
  readonly amount: string;
  /** Display text without sign, at most 6 significant digits (core formatPreviewAmount rules). */
  readonly formatted: string;
}

export interface JourneyValue {
  readonly expectedUsd: number | null;
  readonly atLeastUsd: number | null;
  /** USD per whole token (receipts: per share, through `basis`). Null: unpriced. */
  readonly price: number | null;
  readonly source: JourneyValueSource;
  /** ISO time of the price reading; null when unpriced. */
  readonly at: string | null;
  /** How a receipt or a share was converted, e.g. "1 steakUSDC = 1.0474 USDC (convertToAssets, 13:51 UTC)". */
  readonly basis?: string;
}

export interface JourneyHolding {
  readonly asset: AssetRef;
  readonly identity: AssetIdentity;
  readonly expected: AmountView;
  /** Bound in the user's disfavour (the smallest credit). */
  readonly atLeast: AmountView;
  readonly certainty: JourneyCertainty;
  readonly value: JourneyValue;
  readonly role: HoldingRole;
  /** `spent-next`: the leg that spends it and its share. */
  readonly next?: { readonly legId: string; readonly portionBps: number };
}

export interface JourneyStop {
  /** `start:<stepId>` | `transit:<stepId>` | `out:<stepId>`; stable across polls. */
  readonly id: string;
  readonly index: number;
  readonly kind: StopKind;
  readonly network: NetworkKey;
  readonly holder: {
    readonly account: AccountId | null;
    readonly own: boolean;
    /** "Your wallet", "Relay (in transit)", "Aave V3 USDC", "0x0000…dEaD", "vitalik.eth". */
    readonly label: string;
  };
  readonly custody: CustodyState;
  readonly state: StopState;
  readonly holdings: readonly JourneyHolding[];
  /** Network time from the first signature until the money is here (sum of earlier legs); `remaining` while live. */
  readonly eta?: { readonly afterFirstSignatureSeconds: number; readonly remainingSeconds?: number; readonly certainty: "quoted" | "estimated" | "observed" };
  readonly reachedAt?: string;
  readonly evidence?: { readonly reference: string; readonly url?: string };
  /** Venue stops (deposits, withdraw sources). */
  readonly venue?: { readonly id: string; readonly name: string; readonly protocol: ProtocolId };
}

export interface JourneyRefund {
  readonly mode: RefundMode;
  readonly network: NetworkKey;
  readonly to: AccountId | null;
  readonly asset: AssetRef | null;
  /** Upper bound (the leg's input), less the refund's own gas. */
  readonly upTo?: AmountView;
  /** Honest one-liner, e.g. "If Relay cannot fill, it refunds up to 100 USDC to your Solana wallet, minus the refund's gas." */
  readonly label: string;
  /** deBridge: the cancel must be sent from the destination authority and pays a native fee there. */
  readonly needs?: { readonly network: NetworkKey; readonly account: AccountId | null; readonly asset: AssetRef; readonly why: string };
  readonly typicalDelay: "minutes" | "hours" | "unknown";
}

export interface JourneyLeg {
  /** The step id. */
  readonly id: string;
  readonly index: number;
  readonly from: string;
  readonly via?: string;
  readonly to: string;
  readonly kind: IntentActionKind;
  readonly title: string;
  readonly network: NetworkKey;
  readonly destinationNetwork: NetworkKey;
  readonly venue: { readonly protocol: ProtocolId; readonly name: string; readonly venueId?: string };
  readonly signer: AccountId | null;
  readonly signatures: number;
  /** step.estimatedSeconds (settlement included); null when unknown. */
  readonly seconds: number | null;
  readonly status: StepStatus;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly refund?: JourneyRefund;
  readonly gasTopup?: { readonly asset: AssetRef; readonly amount: AmountView; readonly usd: number | null };
  /** Provider status page (https, known hosts only) or explorer: the leg's main transaction, never its approval. */
  readonly tracking?: { readonly url: string; readonly label: string };
  /** Explorer links of every transaction the leg sent, the main one first (present when it sent more than one). */
  readonly transactions?: readonly { readonly url: string; readonly label: string }[];
}

export type JourneyOptionAction =
  /** Plan this request as a new intent (the client shows its fare and journey, then the user signs). */
  | { readonly type: "replan"; readonly request: IntentRequest }
  /** A separate new intent, as a sentence (e.g. deposit idle funds, bring it back). */
  | { readonly type: "plan-new"; readonly text: string }
  /** Prepare the failed leg again. */
  | { readonly type: "retry"; readonly legId: string }
  /** POST /v1/intents/{id}/stop. */
  | { readonly type: "stop" }
  /** The user takes care of it (client-side, remembered per intent). */
  | { readonly type: "acknowledge" }
  /** https link to a provider status page or an explorer. */
  | { readonly type: "link"; readonly url: string };

export interface JourneyOption {
  /** One of JOURNEY_OPTION_KINDS, or `deposit:<venueId>`. */
  readonly id: JourneyOptionKind;
  readonly label: string;
  /** What happens, with costs, e.g. "Relay delivers about 0.000201 ETH with the fill; costs about $0.51 from the bridged USDC; re-plans the intent." */
  readonly effect: string;
  readonly costUsd: number | null;
  readonly recommended: boolean;
  readonly action: JourneyOptionAction;
}

export interface JourneyConsequence {
  /** `<kind>:<stopId>[:<qualifier>]`, stable across polls (answers are remembered by id). */
  readonly id: string;
  readonly kind: ConsequenceKind;
  readonly severity: ConsequenceSeverity;
  readonly stopId: string | null;
  readonly legIds: readonly string[];
  readonly title: string;
  readonly detail: string;
  readonly certainty: JourneyCertainty;
  /** Machine-readable numbers used (need, have, headroom, ...), base units or decimal USD strings. */
  readonly facts: Readonly<Record<string, string>>;
  /** Where the facts come from, e.g. "Base RPC read at 13:51:04 UTC", "Relay capability", "Aave V3 on-chain caps". */
  readonly source: string;
  readonly options: readonly JourneyOption[];
  /** Present on `block`, and on `act` with a recommended option: the one question to ask. */
  readonly prompt?: { readonly question: string; readonly defaultOptionId: string | null };
  /** Folded under "More about this route" by default. */
  readonly collapsed: boolean;
}

export interface Journey {
  readonly spec: typeof JOURNEY_SPEC;
  readonly intentId: string;
  readonly computedAt: string;
  readonly stage: JourneyStage;
  readonly basis: {
    readonly intentUpdatedAt: string;
    readonly previewDigest: string | null;
    /** `live`: facts read now; `cached`: facts from the caches; `none`: no account reads (demo or indicative). */
    readonly reads: "live" | "cached" | "none";
    readonly factsAt: string | null;
  };
  readonly stops: readonly JourneyStop[];
  readonly legs: readonly JourneyLeg[];
  /** Where the money is now and what the journey waits for. */
  readonly now: { readonly stopIds: readonly string[]; readonly legId: string | null; readonly waitingFor: "signature" | "settlement" | "decision" | "nothing" };
  readonly consequences: readonly JourneyConsequence[];
  /** Ids of `block` consequences the user must answer before the next signature. */
  readonly blockers: readonly string[];
  /** "sha256:" over stops, holdings amounts and consequence ids/severities (no USD, no times). */
  readonly digest: string;
}

/* -------------------------------------------------------------------- facts */

/** Inputs of the consequence analysis, read by the engine; every entry carries its time. */
export interface JourneyFacts {
  readonly at: string;
  readonly reads: "live" | "cached" | "none";
  /** Gas-asset balance by `${network}:${address}` (EVM lower-case); null = read failed. */
  readonly native: Readonly<Record<string, { readonly amount: string; readonly at: string } | null>>;
  readonly gasPrice: Readonly<Partial<Record<NetworkKey, { readonly wei: string; readonly at: string }>>>;
  readonly solanaRent: { readonly walletLamports: string; readonly tokenAccountLamports: string; readonly at: string } | null;
  /** Solana token accounts by `${owner}:${mint}`: true when it exists. */
  readonly tokenAccounts: Readonly<Record<string, boolean>>;
  readonly prices: Readonly<Record<string, { readonly usd: number; readonly source: JourneyValueSource; readonly at: string } | null>>;
  readonly venues: Readonly<Record<string, JourneyVenueFacts | null>>;
  readonly policy: JourneyPolicyFacts | null;
  /** Remaining allowances to spenders this intent approved (live and final stages). */
  readonly allowances: readonly { readonly network: NetworkKey; readonly token: AssetRef; readonly spender: string; readonly spenderLabel: string; readonly amount: string; readonly at: string }[];
  /** Network fee of each unsigned wallet step: the preview's fee lines when simulated, else an estimate. */
  readonly fees: Readonly<Record<string, { readonly network: NetworkKey; readonly asset: AssetRef; readonly amount: string; readonly certainty: Certainty }>>;
  /** Gas-asset units to leave each network later (one exit transaction, estimated). */
  readonly exitFees: Readonly<Partial<Record<NetworkKey, string>>>;
  /** What can deliver gas on each leg (capability from the registry, no quote). */
  readonly gasOptions: Readonly<Record<string, { readonly topup: boolean; readonly gasLeg: IntentActionSpec | null }>>;
  /** Funding of older stored intents (from the step ref) when `IntentStep.funding` is absent. */
  readonly funding: Readonly<Record<string, { readonly portionBps: number; readonly gasReserve?: string }>>;
}

export interface JourneyVenueFacts {
  readonly name: string;
  readonly apy: number | null;
  readonly utilization: number | null;
  /** Underlying base units that can leave the venue now; null when the venue does not expose it. */
  readonly exitLiquidity: string | null;
  /** Underlying base units that still fit under the venue's supply cap; null = no cap or unknown. */
  readonly capRemaining: string | null;
  readonly paused: boolean;
  readonly frozen: boolean;
  /** Underlying per whole share, 18-decimal fixed point, for valuing shares; null for 1:1 receipts. */
  readonly shareRate: string | null;
  readonly at: string;
}

export interface JourneyPolicyFacts {
  readonly perStepUsd: string | null;
  readonly perIntentUsd: string | null;
  readonly dailyRemainingUsd: string | null;
  readonly weeklyRemainingUsd: string | null;
  readonly schedule: PolicyDocument["schedule"] | null;
  readonly approvalExpiresAt: string | null;
}

/* --------------------------------------------------------- venue positions */

/**
 * A position the account holds at a venue, valued in the underlying with
 * the rate used. Adapters report them through `positionOf`;
 * `GET /v1/portfolio/{accountId}?positions=true` lists them.
 */
export interface VenuePosition {
  /** YIELD_VENUES id, or `<network>:<protocol>:<symbol>` for a liquid-staking token held in the wallet. */
  readonly venue: string;
  readonly network: NetworkKey;
  readonly protocol: ProtocolId;
  /** "Aave V3 USDC", "Spark Savings USDC (sUSDC)", "Lido wstETH". */
  readonly name: string;
  /** The position token held (aToken, shares, mToken, jlToken, LST). */
  readonly receipt: AssetAmount;
  /** What it is worth in the underlying at `rate`. */
  readonly underlying: AssetAmount;
  /** Underlying per whole receipt, 18-decimal fixed point; null for 1:1 receipts (aTokens, Comet). */
  readonly rate: string | null;
  readonly usd: number | null;
  readonly apy: number | null;
  /** Underlying that can leave now (exit liquidity bounded by the position); null when unknown. */
  readonly withdrawableNow: AssetAmount | null;
  readonly observedAt: string;
}

/**
 * Capacity of a venue (rule R5): what still fits under its supply
 * cap, what can leave it now, pause and freeze flags and the share rate.
 * Unknown values are null, never zero.
 */
export interface VenueCapacity {
  /** YIELD_VENUES id. */
  readonly venue: string;
  /** Underlying base units that still fit under the supply cap; null = no cap or unknown. */
  readonly capRemaining: string | null;
  /** Underlying base units that can leave the venue now; null when the venue does not expose it. */
  readonly exitLiquidity: string | null;
  readonly paused: boolean;
  readonly frozen: boolean;
  /** Underlying per whole share, 18-decimal fixed point; null for 1:1 receipts. */
  readonly shareRate: string | null;
  readonly observedAt: string;
  /** Supply APY as a fraction when the adapter reads it with the capacity (venues without lending metrics); optional. */
  readonly apy?: number | null;
  /** Borrowed share of supply in [0, 1] when the adapter reads it; optional. */
  readonly utilization?: number | null;
}

/* ------------------------------------------------------------------- limits */

/** Thresholds of the sensitivity and suggestion rules. */
export const JOURNEY_LIMITS = Object.freeze({
  /** Holdings below are hidden from consequences. */
  dustUsd: 0.01,
  /** Idle money below gets no suggestion. */
  idleMinUsd: 1,
  suggestionMinApy: 0.01,
  suggestionMaxUtilization: 0.98,
  suggestionMinExitMultiple: 10,
  /** Cap headroom under 10x the amount: warn. */
  capWarnMultiple: 10,
  /** Multiplier on typical (not limit) gas values and quote gas hints. */
  feeSafety: 1.5,
  /** Gas reserve = 2 x fees of the remaining steps there. */
  reserveMultiple: 2,
  topupMinUsd: 0.05,
  /** Recommendation ceiling (validation allows up to 5). */
  topupMaxUsd: 2,
  gasLegUsd: 1,
  maxExpanded: 3,
});
