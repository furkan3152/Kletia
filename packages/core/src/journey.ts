/**
 * Journey contract, `kletia.journey/v1`: where the money is after every step of
 * an intent, and what follows from it.
 *
 * A journey is a deterministic per-stop ledger of one intent. Every step
 * boundary becomes a stop (network, who holds the money, asset and its
 * identity, expected and at-least amounts, USD value with its source and
 * time, custody, ETA) and every step a leg (venue, signatures, ETA, refund
 * path). Next to it, consequences: what follows from each stop, with a
 * severity assigned by rule (R1-R12), an honest certainty, the facts used and
 * concrete options. The journey never simulates: it reads the preview (the
 * fare stays the authority for what moves) and facts the engine gathered
 * under a budget; a fact that could not be read is reported as unknown, never
 * guessed.
 *
 * This module holds the types and constants every surface shares (API, SDK,
 * widget, web) and the pure builder: `buildJourney` (stops, legs, holdings,
 * custody, valuation, consequences, digest), `journeyDigest`,
 * `actionsFromGraph`, `continuationRequest`, `openBlockers` and
 * `refundPath`. No I/O: the engine gathers the facts.
 */
import { CHAINS, type NetworkKey } from "./chains.js";
import { nativeAssetId, parseAccountId, parseAssetId, sameAddressAccount, type AccountId } from "./caip.js";
import { findAssetByAddress, findAssetBySymbol, getAsset, type AssetDescriptor } from "./assets.js";
import { fromBaseUnits } from "./amounts.js";
import { getProtocol, getYieldVenue, YIELD_VENUES, type ProtocolId, type YieldVenue } from "./protocols.js";
import { CERTAINTY_ORDER, formatPreviewAmount, PREVIEW_CHANGE_LIMITS, type Certainty, type IntentPreview, type StepPreview } from "./preview.js";
import type { PolicyDocument } from "./policy.js";
import { scheduleState } from "./policyEvaluate.js";
import { canonicalJson } from "./contracts.js";
import { sha256Hex } from "./hash.js";
import { topologicalOrder } from "./lifecycle.js";
import { fundedFlow, fundingParent, isOwnRequestAccount, type FundedFlow, type ParentCredit } from "./flow.js";
import type {
  AssetAmount,
  AssetRef,
  IntentActionKind,
  IntentActionSpec,
  IntentGraph,
  IntentRequest,
  IntentStep,
  StepStatus,
} from "./intent.js";

export const JOURNEY_SPEC = "kletia.journey/v1" as const;
export const JOURNEY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/* ------------------------------------------------------------- vocabulary */

/** `plan` while nothing was submitted, `final` once the intent is terminal, else `live`. */
export const JOURNEY_STAGES = Object.freeze(["plan", "live", "final"] as const);
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** The preview's certainty labels plus `observed` (seen on-chain; strongest). */
export type JourneyCertainty = "observed" | Certainty;
/** Strongest first, like `CERTAINTY_ORDER` of the preview. */
export const JOURNEY_CERTAINTY_ORDER: readonly JourneyCertainty[] = Object.freeze(["observed", ...CERTAINTY_ORDER]);

/** `start` (input waits for a signature), `transit` (with a provider), `arrival` (spent by a later leg), `end`. */
export const STOP_KINDS = Object.freeze(["start", "transit", "arrival", "end"] as const);
export type StopKind = (typeof STOP_KINDS)[number];

export const STOP_STATES = Object.freeze(["upcoming", "current", "passed", "skipped", "failed"] as const);
export type StopState = (typeof STOP_STATES)[number];

/** Who controls the money at a stop. */
export const CUSTODY_STATES = Object.freeze(["wallet", "venue", "provider", "refund-due", "third-party", "unknown"] as const);
export type CustodyState = (typeof CUSTODY_STATES)[number];

/** What a holding at a stop is: spent by the next leg, kept, gas, a venue position, paid away, or a refund. */
export const HOLDING_ROLES = Object.freeze(["spent-next", "kept", "gas", "position", "paid", "refund"] as const);
export type HoldingRole = (typeof HOLDING_ROLES)[number];

export const ASSET_IDENTITY_KINDS = Object.freeze([
  /** The network's gas asset. */
  "native",
  /** Issued on this network by its issuer (Circle USDC/EURC: CCTP domain). */
  "issuer",
  /** 1:1 wrapper of the gas asset on the same network (WETH, WPOL, wSOL). */
  "wrapped",
  /** A bridge's representation (Polygon WETH: PoS bridge; USDbC on Base). */
  "bridged",
  /** Custodian-issued (cbBTC: Coinbase). */
  "custodial",
  /** Claim on staked SOL or ETH with a moving exchange rate (JitoSOL, mSOL, JupSOL, wstETH, rETH, weETH). */
  "liquid-staking",
  /** A venue position token (aToken, Comet balance, vault shares, mToken, jlToken, fToken, sUSDC). */
  "receipt",
  /** Another asset of Kletia's registry (DAI, AERO, JUP, ...). */
  "listed",
  /** Not in the registry: never valued by symbol, flagged. */
  "unlisted",
] as const);
export type AssetIdentityKind = (typeof ASSET_IDENTITY_KINDS)[number];

/** Where a USD value comes from; `unpriced` is never shown as $0. */
export const JOURNEY_VALUE_SOURCES = Object.freeze(["usd-par", "jupiter", "chainlink", "pyth", "venue-rate", "testnet", "unpriced"] as const);
export type JourneyValueSource = (typeof JOURNEY_VALUE_SOURCES)[number];

/** How a cross-network leg returns the money when it cannot fill. */
export const REFUND_MODES = Object.freeze(["automatic", "after-deadline", "after-cancel", "none"] as const);
export type RefundMode = (typeof REFUND_MODES)[number];

/** Consequence kinds in the order of the rule table (also the display tie-break). */
export const CONSEQUENCE_KINDS = Object.freeze([
  "gas-to-continue", "gas-to-leave", "asset-identity", "price-exposure", "venue-capacity", "rule-book",
  "if-stopped", "refund-path", "allowance-left", "time-window", "idle-funds", "exit-path",
] as const);
export type ConsequenceKind = (typeof CONSEQUENCE_KINDS)[number];

/**
 * Severity is assigned by rule, never by an adapter. `block`: a later leg
 * cannot be signed, or will be refused, with the facts read (must be answered
 * before the next signature, client-side). `act`: an action now avoids a
 * likely problem. `warn`: a risk worth knowing before departure. `info`:
 * facts about the route. Most severe first.
 */
export const CONSEQUENCE_SEVERITIES = Object.freeze(["block", "act", "warn", "info"] as const);
export type ConsequenceSeverity = (typeof CONSEQUENCE_SEVERITIES)[number];

/** The consequence rules R1-R12 and the kind each one emits. */
export const JOURNEY_RULES = Object.freeze({
  R1: "gas-to-continue",
  R2: "gas-to-leave",
  R3: "asset-identity",
  R4: "price-exposure",
  R5: "venue-capacity",
  R6: "rule-book",
  R7: "if-stopped",
  R8: "refund-path",
  R9: "allowance-left",
  R10: "time-window",
  R11: "idle-funds",
  R12: "exit-path",
} as const satisfies Readonly<Record<string, ConsequenceKind>>);
export type JourneyRuleId = keyof typeof JOURNEY_RULES;
export const JOURNEY_RULE_IDS = Object.freeze(Object.keys(JOURNEY_RULES) as JourneyRuleId[]);

/** What choosing an option does (`JourneyOption.action.type`). */
export const JOURNEY_OPTION_ACTION_TYPES = Object.freeze(["replan", "plan-new", "retry", "stop", "acknowledge", "link"] as const);
export type JourneyOptionActionType = (typeof JOURNEY_OPTION_ACTION_TYPES)[number];

/**
 * Option ids a consequence may offer (stable, so answers are remembered by id),
 * plus `deposit:<venueId>` suggestions for idle funds.
 */
export const JOURNEY_OPTION_KINDS = Object.freeze([
  /** Re-plan with `constraints.gasOnArrival` on the leg arriving there (Relay). */
  "gas-topup",
  /** Prepend a small bridge into the network's gas asset (Solana, or no top-up route). */
  "gas-leg",
  /** The user brings gas (acknowledge, with the exact amount and current balance). */
  "bring-gas",
  /** Prepare the failed leg again. */
  "retry",
  /** Plan the rest again from the stop, same venue (a continuation intent). */
  "replan-same-venue",
  /** Plan the rest again from the stop, any listed venue. */
  "replan-any-venue",
  /** Stop the intent at the current stop (POST /v1/intents/{id}/stop). */
  "end-here",
  /** A new intent bringing the money back (a sentence). */
  "bring-back",
  /** Provider status page or explorer link. */
  "track",
  /** Understood; nothing to do. */
  "ok",
] as const);
export type JourneyOptionKind = (typeof JOURNEY_OPTION_KINDS)[number] | `deposit:${string}`;
/** Prefix of idle-funds suggestions: `deposit:<YIELD_VENUES id>`. */
export const JOURNEY_DEPOSIT_OPTION_PREFIX = "deposit:" as const;

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

/* ================================================================ builder */

/* ------------------------------------------------------------- helpers */

const SEVERITY_RANK: Readonly<Record<ConsequenceSeverity, number>> = { block: 0, act: 1, warn: 2, info: 3 };
const KIND_RANK = new Map<ConsequenceKind, number>(CONSEQUENCE_KINDS.map((kind, index) => [kind, index]));
/** Payload lifetime of a prepared EVM step (engine `PAYLOAD_TTL_SECONDS`). */
const PAYLOAD_TTL_SECONDS = 90;
/** Unresolved settlement goes to manual review after this long (engine poller). */
const MANUAL_REVIEW_SECONDS = 3 * 60 * 60;
/** Overhead of a Relay gas top-up on top of the delivered amount (live A8). */
const TOPUP_OVERHEAD_USD = 0.02;
/** Relayer fee of the $1 gas leg into SOL (live A10). */
const GAS_LEG_COST_USD = 0.03;
const ONE_E18 = 10n ** 18n;
const EXPLORER_REFERENCE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/u;

const STARTED_STATUSES: ReadonlySet<StepStatus> = new Set(["submitted", "confirmed", "settling", "settled", "indeterminate"]);
const IN_FLIGHT_STATUSES: ReadonlySet<StepStatus> = new Set(["submitted", "confirmed", "settling", "indeterminate"]);
const UNSIGNED_STATUSES: ReadonlySet<StepStatus> = new Set(["pending", "ready", "awaiting_signature", "failed"]);
const TERMINAL_INTENT_STATUSES: ReadonlySet<string> = new Set(["completed", "partially_completed", "failed", "expired", "cancelled"]);

function started(step: IntentStep): boolean {
  return STARTED_STATUSES.has(step.status);
}

function normalizedAsset(asset: string): string {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : asset;
}

function sameAsset(a: string, b: string): boolean {
  return normalizedAsset(a) === normalizedAsset(b);
}

function addressOf(account: string): string {
  const parsed = parseAccountId(account);
  if (!parsed) return account;
  return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
}

function nativeKey(network: NetworkKey, account: string): string {
  return `${network}:${addressOf(account)}`;
}

function refOf(amount: Pick<AssetAmount, "asset" | "symbol" | "decimals">): AssetRef {
  return { asset: amount.asset, symbol: amount.symbol, decimals: amount.decimals };
}

function nativeRef(network: NetworkKey): AssetRef {
  const chain = CHAINS[network];
  return { asset: nativeAssetId(network), symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals };
}

function isNativeOf(asset: string, network: NetworkKey): boolean {
  const parsed = parseAssetId(asset);
  return parsed !== null && parsed.isNative && parsed.chain.key === network;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function view(units: bigint, decimals: number): AmountView {
  const positive = nonNegative(units);
  return { amount: positive.toString(), formatted: formatPreviewAmount(positive, decimals).replace(/^\+/u, "") };
}

/** Round half-even to cents (display only). */
function cents(value: number): number {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = Math.abs(diff - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return rounded / 100 + 0;
}

function wholeUnits(units: bigint, decimals: number): number {
  return Number(units) / 10 ** decimals;
}

function networkName(network: NetworkKey): string {
  return CHAINS[network]?.name ?? network;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function timeOf(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown time" : `${date.toISOString().slice(11, 16)} UTC`;
}

function usdText(value: number | null): string {
  return value === null ? "an unknown amount" : `$${value.toFixed(2)}`;
}

function symbolText(amount: AmountView, symbol: string): string {
  return `${amount.formatted} ${symbol}`;
}

/** Registry descriptor of an asset id (EVM addresses compared case-insensitively). */
function lookupAsset(asset: string): AssetDescriptor | null {
  const direct = getAsset(asset);
  if (direct) return direct;
  const parsed = parseAssetId(asset);
  if (!parsed || parsed.isNative) return parsed ? getAsset(nativeAssetId(parsed.chain.key)) : null;
  return findAssetByAddress(parsed.chain.key, parsed.reference);
}

function isStable(asset: string): boolean {
  return lookupAsset(asset)?.category === "stablecoin";
}

/** The request's own account on `network` (same address on that network's VM). */
function ownAccountOn(graph: IntentGraph, network: NetworkKey): AccountId | null {
  const namespace = CHAINS[network].namespace;
  for (const account of graph.request.accounts) {
    const parsed = parseAccountId(account);
    if (parsed && parsed.chain.namespace === namespace) return `${CHAINS[network].id}:${parsed.address}` as AccountId;
  }
  return null;
}

function destinationOf(step: IntentStep): NetworkKey {
  return step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork ?? step.network : step.network;
}

function isCross(step: IntentStep): boolean {
  return step.settlement?.kind === "cross-network";
}

/** Who receives a step's output: the recipient, else the own account on the destination network. */
function holderOf(graph: IntentGraph, step: IntentStep): AccountId {
  if (step.recipient) return step.recipient;
  const destination = destinationOf(step);
  if (destination === step.network) return step.account;
  return ownAccountOn(graph, destination) ?? step.account;
}

function outputOf(step: IntentStep): AssetAmount | undefined {
  return step.actualOutput ?? step.observedCredit ?? step.minimumOutput ?? step.expectedOutput;
}

function venueName(step: IntentStep): string {
  return getProtocol(step.protocol)?.name ?? step.protocol;
}

function portionText(portionBps: number): string {
  if (portionBps >= 10_000) return "";
  if (portionBps === 5_000) return "half of ";
  const percent = portionBps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}% of `;
}

/* -------------------------------------------------------------- identity */

const RECEIPT_KIND_LABEL: Readonly<Record<string, string>> = {
  "aave-reserve": "aToken",
  comet: "Compound balance",
  erc4626: "vault shares",
  ctoken: "mToken",
  "jupiter-lend": "jlToken",
  "kamino-reserve": "Kamino collateral",
  "save-reserve": "cToken",
  "fluid-ftoken": "fToken shares",
  "spark-vault": "savings shares",
  "yearn-vault": "vault shares",
  "savings-vault": "savings shares",
};

/** 1:1 receipts: the balance is the underlying (aTokens, Comet balances). */
function oneToOne(venue: YieldVenue): boolean {
  return venue.kind === "aave-reserve" || venue.kind === "comet";
}

function receiptVenue(asset: string, network: NetworkKey): YieldVenue | null {
  const parsed = parseAssetId(asset);
  if (!parsed || parsed.isNative) return null;
  const reference = parsed.chain.namespace === "eip155" ? parsed.reference.toLowerCase() : parsed.reference;
  return YIELD_VENUES.find((venue) => {
    if (venue.network !== network || !("receipt" in venue)) return false;
    const address = parsed.chain.namespace === "eip155" ? venue.receipt.address.toLowerCase() : venue.receipt.address;
    return address === reference;
  }) ?? null;
}

function underlyingRef(venue: YieldVenue): AssetRef | undefined {
  const network = venue.network;
  if (CHAINS[network].nativeAsset.symbol.toUpperCase() === venue.asset.toUpperCase()) return nativeRef(network);
  const descriptor = findAssetBySymbol(network, venue.asset);
  return descriptor ? { asset: descriptor.id, symbol: descriptor.symbol, decimals: descriptor.decimals } : undefined;
}

/**
 * The identity of an asset at a stop: what it is a claim on. `venueHint`
 * names the venue of a deposit or withdraw step, for receipts the registry
 * does not list (Kamino collateral).
 */
export function assetIdentity(asset: AssetRef, network: NetworkKey, venueHint?: YieldVenue | null): AssetIdentity {
  const chain = CHAINS[network];
  if (isNativeOf(asset.asset, network)) {
    return { kind: "native", label: `${chain.name}'s gas asset (${chain.nativeAsset.symbol})` };
  }
  const venue = receiptVenue(asset.asset, network) ?? (venueHint && !lookupAsset(asset.asset) ? venueHint : null);
  if (venue) {
    const underlying = underlyingRef(venue);
    const what = RECEIPT_KIND_LABEL[venue.kind] ?? "position token";
    const label = oneToOne(venue)
      ? `Your ${venue.name} position: 1 ${asset.symbol} = 1 ${venue.asset} plus interest (${what})`
      : `Your ${venue.name} position (${what}); its value in ${venue.asset} follows the venue's share rate`;
    return { kind: "receipt", label, ...(underlying ? { underlying } : {}) };
  }
  const descriptor = lookupAsset(asset.asset);
  if (!descriptor) return { kind: "unlisted", label: `${asset.symbol} is not in Kletia's asset registry; it is never valued by its symbol` };
  if (descriptor.transferOnly) return { kind: "bridged", label: `${descriptor.name} (${descriptor.symbol}), a bridged token distinct from native USDC` };
  if ((descriptor.group === "USDC" || descriptor.group === "EURC") && descriptor.category === "stablecoin" && chain.settlement.cctpDomain !== undefined) {
    return { kind: "issuer", label: `Circle-issued ${descriptor.symbol} (CCTP domain ${chain.settlement.cctpDomain})` };
  }
  if (descriptor.category === "wrapped") {
    if (descriptor.symbol.toUpperCase() === `W${chain.nativeAsset.symbol.toUpperCase()}`) {
      return { kind: "wrapped", label: `${descriptor.symbol}: 1:1 wrapper of ${chain.nativeAsset.symbol} on ${chain.name}` };
    }
    return { kind: "bridged", label: `${descriptor.symbol} on ${chain.name} is bridged ${descriptor.group ?? descriptor.symbol}, not the network's gas asset` };
  }
  if (descriptor.category === "liquid-staking") {
    const staked = descriptor.group === "SOL" || chain.vm === "svm" ? "SOL" : "ETH";
    const underlying = descriptor.group === "SOL" || chain.vm === "svm" ? nativeRef(network) : undefined;
    return { kind: "liquid-staking", label: `${descriptor.symbol}: a claim on staked ${staked} with a moving exchange rate`, ...(underlying ? { underlying } : {}) };
  }
  if (descriptor.category === "btc") {
    const issuer = descriptor.symbol === "cbBTC" ? "Coinbase" : "its custodian";
    return { kind: "custodial", label: `${descriptor.symbol}: bitcoin held by ${issuer}, issued 1:1` };
  }
  return { kind: "listed", label: `${descriptor.name} (${descriptor.symbol}), listed on ${chain.name}` };
}

/* ------------------------------------------------------------- valuation */

function priceFact(facts: JourneyFacts, asset: string): { readonly usd: number; readonly source: JourneyValueSource; readonly at: string } | null {
  const direct = facts.prices[asset] ?? facts.prices[normalizedAsset(asset)];
  if (direct && Number.isFinite(direct.usd) && direct.usd >= 0) return direct;
  return null;
}

/** Underlying per whole share as a number (18-decimal fixed point in facts); null when unknown. */
function shareRateOf(venue: YieldVenue, facts: JourneyFacts): { readonly rate: number; readonly at: string } | null {
  if (oneToOne(venue)) return { rate: 1, at: facts.at };
  const fact = facts.venues[venue.id];
  if (!fact || fact.shareRate === null || !/^\d+$/u.test(fact.shareRate)) return null;
  const raw = BigInt(fact.shareRate);
  if (raw <= 0n) return null;
  return { rate: Number(raw) / Number(ONE_E18), at: fact.at };
}

/**
 * USD value of a holding: the price fact of the asset itself, else, for a
 * receipt, its underlying's price through the venue's share rate. Unpriced is
 * never 0.
 */
function valueOf(asset: AssetRef, identity: AssetIdentity, expected: bigint, atLeast: bigint, facts: JourneyFacts, network: NetworkKey, venueHint?: YieldVenue | null): JourneyValue {
  const usd = (units: bigint, price: number) => cents(wholeUnits(units, asset.decimals) * price);
  const direct = priceFact(facts, asset.asset);
  if (direct && identity.kind !== "receipt") {
    return {
      expectedUsd: usd(expected, direct.usd),
      atLeastUsd: usd(atLeast, direct.usd),
      price: direct.usd,
      source: direct.source,
      at: direct.at,
      ...(identity.kind === "liquid-staking" ? { basis: identity.label } : {}),
    };
  }
  if (identity.kind === "receipt" && identity.underlying) {
    const venue = receiptVenue(asset.asset, network) ?? venueHint ?? null;
    const underlying = priceFact(facts, identity.underlying.asset);
    const rate = venue ? shareRateOf(venue, facts) : null;
    if (venue && underlying && rate) {
      // Price per whole share = underlying price × underlying per whole share.
      const price = underlying.usd * rate.rate;
      const basis = oneToOne(venue)
        ? `1 ${asset.symbol} = 1 ${identity.underlying.symbol} plus interest (${RECEIPT_KIND_LABEL[venue.kind] ?? "receipt"})`
        : `1 ${asset.symbol} = ${rate.rate.toPrecision(6).replace(/\.?0+$/u, "")} ${identity.underlying.symbol} (share rate at ${timeOf(rate.at)})`;
      return {
        expectedUsd: usd(expected, price),
        atLeastUsd: usd(atLeast, price),
        price,
        source: underlying.source === "testnet" ? "testnet" : "venue-rate",
        at: rate.at < underlying.at ? rate.at : underlying.at,
        basis,
      };
    }
  }
  return { expectedUsd: null, atLeastUsd: null, price: null, source: "unpriced", at: null };
}

/* ----------------------------------------------------------- refund path */

function lifiTool(step: IntentStep): "across" | "polymer" | "unknown" {
  const text = [step.title, ...(step.warnings ?? []), ...step.evidence.map((entry) => entry.detail ?? "")].join(" ");
  if (/polymer|cctp/iu.test(text)) return "polymer";
  if (/across/iu.test(text)) return "across";
  return "unknown";
}

/**
 * How a cross-network leg returns the money when it cannot fill (plus Across
 * and CCTP V2). Null for same-network legs (atomic).
 */
export function refundPath(graph: IntentGraph, step: IntentStep): JourneyRefund | null {
  if (!isCross(step)) return null;
  const origin = networkName(step.network);
  const destinationKey = destinationOf(step);
  const destination = networkName(destinationKey);
  const input = step.input;
  const upTo = input ? view(BigInt(input.amount), input.decimals) : undefined;
  const what = input && upTo ? symbolText(upTo, input.symbol) : "the deposit";
  const base = { network: step.network, to: step.account, asset: input ? refOf(input) : null, ...(upTo ? { upTo } : {}) };
  switch (step.protocol) {
    case "relay":
      return { ...base, mode: "automatic", label: `If Relay cannot fill, it refunds up to ${what} to your ${origin} wallet, minus the refund's gas.`, typicalDelay: "minutes" };
    case "across":
      return { ...base, mode: "after-deadline", label: `If no relayer fills before the fill deadline, Across refunds ${what} to your ${origin} wallet; this can take several hours.`, typicalDelay: "hours" };
    case "cctp-v2":
      return {
        mode: "none",
        network: destinationKey,
        to: holderOf(graph, step),
        asset: null,
        label: `USDC is burned on ${origin} and minted on ${destination} by Circle's CCTP; there is no refund. If the mint is not completed, the transfer is indeterminate until it is minted on ${destination} with Circle's attestation (the message hash is the reference).`,
        typicalDelay: "unknown",
      };
    case "lifi": {
      const tool = lifiTool(step);
      if (tool === "polymer") {
        return {
          mode: "none",
          network: destinationKey,
          to: holderOf(graph, step),
          asset: null,
          label: `USDC is burned on ${origin} and minted on ${destination}; there is no refund. If the relayer stalls, the mint can be completed on ${destination} with Circle's attestation.`,
          typicalDelay: "unknown",
        };
      }
      return { ...base, mode: "after-deadline", label: `If no relayer fills before the fill deadline, Across (through LI.FI) refunds ${what} to your ${origin} wallet; this can take several hours.`, typicalDelay: tool === "across" ? "hours" : "unknown" };
    }
    case "debridge-dln": {
      const authority = holderOf(graph, step);
      const own = isOwnRequestAccount(graph, authority);
      const native = nativeRef(destinationKey);
      return {
        ...base,
        mode: "after-cancel",
        label: `If no solver fills, cancel the order from your ${destination} account (it needs ${native.symbol} there for the cancel fee); the full deposit then returns to your ${origin} wallet.`,
        needs: { network: destinationKey, account: own ? authority : null, asset: native, why: `A deBridge cancel is sent from the destination account with a positive ${native.symbol} value.` },
        typicalDelay: "minutes",
      };
    }
    default:
      return { ...base, mode: "automatic", label: `If ${venueName(step)} cannot complete the transfer, it returns ${what} on ${origin} under its own rules.`, typicalDelay: "unknown" };
  }
}

/* --------------------------------------------------------- stops and legs */

interface Credit {
  readonly asset: AssetRef;
  readonly expected: bigint;
  readonly worst: bigint;
  readonly certainty: JourneyCertainty;
}

interface StopDraft {
  id: string;
  kind: StopKind;
  network: NetworkKey;
  holder: JourneyStop["holder"];
  custody: CustodyState;
  state: StopState;
  holdings: JourneyHolding[];
  eta?: JourneyStop["eta"];
  reachedAt?: string;
  evidence?: JourneyStop["evidence"];
  venue?: JourneyStop["venue"];
  readonly stepId: string;
  readonly role: "start" | "transit" | "out";
}

interface Walk {
  readonly graph: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly facts: JourneyFacts;
  readonly order: readonly IntentStep[];
  readonly stops: StopDraft[];
  readonly byId: Map<string, StopDraft>;
  /** Main output credit at out:<step>. */
  readonly credits: Map<string, Credit | null>;
  /** Funded flow of each funded step (what it spends of its parent's credit). */
  readonly flows: Map<string, FundedFlow>;
  /** Steps funded by each step, in order. */
  readonly children: Map<string, IntentStep[]>;
  /** Input stop id of each leg. */
  readonly inputStop: Map<string, string>;
}

function previewStepOf(preview: IntentPreview | null, stepId: string): StepPreview | undefined {
  return preview?.steps.find((entry) => entry.stepId === stepId);
}

function fundingOptions(walk: Pick<Walk, "facts">, step: IntentStep): { portionBps?: number; gasReserve?: bigint } {
  if (step.funding) return {};
  const fact = walk.facts.funding[step.id];
  if (!fact) return {};
  return {
    portionBps: fact.portionBps,
    ...(fact.gasReserve && /^\d+$/u.test(fact.gasReserve) ? { gasReserve: BigInt(fact.gasReserve) } : {}),
  };
}

function portionOf(walk: Pick<Walk, "facts">, step: IntentStep): number {
  return step.funding?.portionBps ?? walk.facts.funding[step.id]?.portionBps ?? 10_000;
}

/** Main output credit of a step: observed, else the preview's row, else the graph through core flow. */
function outputCredit(walk: Walk, step: IntentStep, flow: FundedFlow | null): Credit | null {
  if (step.status === "settled" && step.actualOutput) {
    const units = BigInt(step.actualOutput.amount);
    return { asset: refOf(step.actualOutput), expected: units, worst: units, certainty: "observed" };
  }
  if (step.status === "failed" && step.observedCredit) {
    const units = BigInt(step.observedCredit.amount);
    return { asset: refOf(step.observedCredit), expected: units, worst: units, certainty: "observed" };
  }
  const output = step.minimumOutput ?? step.expectedOutput;
  if (!output) return null;
  const asset = refOf(output);
  const holder = holderOf(walk.graph, step);
  const destination = destinationOf(step);
  const entry = previewStepOf(walk.preview, step.id);
  if (entry) {
    const row = entry.deltas.find((delta) =>
      delta.network === destination && sameAddressAccount(delta.account, holder) && sameAsset(delta.asset, asset.asset) && (BigInt(delta.expected.amount) > 0n || BigInt(delta.worst.amount) > 0n));
    if (row) return { asset, expected: nonNegative(BigInt(row.expected.amount)), worst: nonNegative(BigInt(row.worst.amount)), certainty: row.certainty };
    const payment = entry.payments.find((candidate) => candidate.stepId === step.id && sameAsset(candidate.asset, asset.asset));
    if (payment) return { asset, expected: nonNegative(BigInt(payment.expected.amount)), worst: nonNegative(BigInt(payment.worst.amount)), certainty: payment.certainty };
  }
  const expectedRaw = BigInt((step.expectedOutput ?? output).amount);
  const minimumRaw = BigInt((step.minimumOutput ?? output).amount);
  let expected = expectedRaw;
  let worst = minimumRaw;
  let certainty: JourneyCertainty = isCross(step) ? "venue-minimum" : "quoted";
  if (flow && flow.encoded > 0n) {
    if (flow.spends.expected !== flow.encoded) {
      expected = (expectedRaw * flow.spends.expected) / flow.encoded;
      certainty = "estimated";
    }
    if (flow.spends.worst < flow.encoded) worst = (minimumRaw * flow.spends.worst) / flow.encoded;
  }
  if (expected < worst) expected = worst;
  return { asset, expected, worst, certainty };
}

function holding(walk: Walk, network: NetworkKey, asset: AssetRef, expected: bigint, worst: bigint, certainty: JourneyCertainty, role: HoldingRole, venueHint: YieldVenue | null, next?: JourneyHolding["next"]): JourneyHolding {
  const identity = assetIdentity(asset, network, venueHint);
  return {
    asset,
    identity,
    expected: view(expected, asset.decimals),
    atLeast: view(worst, asset.decimals),
    certainty,
    value: valueOf(asset, identity, nonNegative(expected), nonNegative(worst), walk.facts, network, venueHint),
    role,
    ...(next ? { next } : {}),
  };
}

function stepVenue(step: IntentStep): YieldVenue | null {
  return step.venue ? getYieldVenue(step.venue) : null;
}

function holderLabel(graph: IntentGraph, step: IntentStep, account: AccountId, network: NetworkKey): JourneyStop["holder"] {
  const own = isOwnRequestAccount(graph, account);
  if (own) return { account, own, label: `Your ${networkName(network)} wallet` };
  const parsed = parseAccountId(account);
  return { account, own, label: step.recipientName ?? shortAddress(parsed?.address ?? account) };
}

function settledAt(step: IntentStep): string | undefined {
  const evidence = [...step.evidence].reverse().find((entry) => entry.kind === "settlement" || entry.kind === "receipt" || entry.kind === "balance");
  return evidence?.observedAt;
}

function explorerLink(network: NetworkKey, reference: string | undefined): { url: string; label: string } | null {
  if (!reference || !EXPLORER_REFERENCE.test(reference)) return null;
  const explorer = CHAINS[network].explorer;
  if (!explorer.tx.startsWith("https://")) return null;
  return { url: explorer.tx.replace("{hash}", reference), label: `View on ${explorer.name}` };
}

/**
 * The step's main transaction: the last one its wallet sent (approvals are
 * prepared before the swap, deposit or bridge they allow).
 */
function mainReference(step: IntentStep): string | undefined {
  const references = step.references ?? [];
  return references[references.length - 1];
}

/** Explorer links of every transaction a step sent, the main one first; earlier ones named by their prepared description. */
function transactionLinks(step: IntentStep): { url: string; label: string }[] {
  const references = step.references ?? [];
  const described = step.prepared?.transactions.length === references.length ? step.prepared.transactions : null;
  const links: { url: string; label: string }[] = [];
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const link = explorerLink(step.network, references[index]);
    if (!link) continue;
    const main = index === references.length - 1;
    const what = described?.[index]?.description.trim().slice(0, 60) || `Transaction ${index + 1} of ${references.length}`;
    links.push(main ? link : { url: link.url, label: `${what} on ${CHAINS[step.network].explorer.name}` });
  }
  return links;
}

/** Transactions a planned step asks for (prepared count when known; else the usual approve + action). */
function signaturesOf(step: IntentStep, preview: IntentPreview | null): number {
  if (step.mode !== "wallet") return 0;
  if (step.prepared) return step.prepared.transactions.length;
  const entry = previewStepOf(preview, step.id);
  if (CHAINS[step.network].vm === "svm") return 1;
  const tokenInput = step.input !== undefined && !isNativeOf(step.input.asset, step.network);
  if (entry && entry.approvals.length > 0) return entry.approvals.length + 1;
  if (!tokenInput || step.kind === "transfer" || step.kind === "withdraw") return 1;
  return 2;
}

function legTitle(walk: Walk, step: IntentStep): string {
  const parent = fundingParent(walk.graph, step);
  if (!parent || !step.input) return step.title;
  const share = portionText(portionOf(walk, step));
  const match = /^(\S+)\s+[\d.,]+\s+(\S+)\s*(.*)$/u.exec(step.title);
  if (!match) return step.title;
  const verb = match[1] as string;
  const rest = match[3] ? ` ${match[3]}` : "";
  return `${verb} ${share}the ${step.input.symbol} that arrives${rest}`;
}

function etaOf(seconds: number, quoted: boolean): NonNullable<JourneyStop["eta"]> {
  return { afterFirstSignatureSeconds: Math.max(0, Math.round(seconds)), certainty: quoted ? "quoted" : "estimated" };
}

function legSeconds(step: IntentStep): number | null {
  const seconds = step.estimatedSeconds ?? step.settlement?.expectedSeconds;
  return seconds === undefined || !Number.isFinite(seconds) ? null : seconds;
}

/** Builds stops, their amounts and states. */
function walkGraph(graph: IntentGraph, preview: IntentPreview | null, facts: JourneyFacts): Walk {
  const order = topologicalOrder(graph.steps);
  const walk: Walk = {
    graph, preview, facts, order, stops: [], byId: new Map(), credits: new Map(), flows: new Map(), children: new Map(), inputStop: new Map(),
  };
  const add = (stop: StopDraft) => {
    walk.stops.push(stop);
    walk.byId.set(stop.id, stop);
  };
  const cumulative = new Map<string, number>();
  for (const step of order) {
    const parent = fundingParent(graph, step);
    const parentCredit = parent ? walk.credits.get(parent.id) ?? null : null;
    let flow: FundedFlow | null = null;
    if (parent && parentCredit && step.input && sameAsset(parentCredit.asset.asset, step.input.asset)) {
      const credit: ParentCredit = { expected: parentCredit.expected, worst: parentCredit.worst, certainty: parentCredit.certainty === "observed" ? "observed" : parentCredit.certainty };
      flow = fundedFlow(graph, step, credit, fundingOptions(walk, step));
      walk.flows.set(step.id, flow);
      walk.children.set(parent.id, [...(walk.children.get(parent.id) ?? []), step]);
    }
    // Seconds from the first signature until this leg can start: the slowest dependency.
    const before = step.dependsOn.reduce((total, id) => Math.max(total, cumulative.get(id) ?? 0), 0);
    const own = legSeconds(step);
    cumulative.set(step.id, before + (own ?? 0));
    const quoted = step.estimatedSeconds !== undefined;
    const venue = stepVenue(step);

    // Input stop.
    if (parent && walk.byId.has(`out:${parent.id}`)) {
      walk.inputStop.set(step.id, `out:${parent.id}`);
    } else if (step.input) {
      const id = `start:${step.id}`;
      const withdraw = step.kind === "withdraw";
      const input = step.input;
      const units = BigInt(input.amount);
      add({
        id, kind: "start", network: step.network, stepId: step.id, role: "start",
        holder: withdraw && venue
          ? { account: step.account, own: true, label: venue.name }
          : holderLabel(graph, step, step.account, step.network),
        custody: withdraw ? "venue" : "wallet",
        state: "upcoming",
        holdings: [holding(walk, step.network, refOf(input), units, units, started(step) ? "observed" : "quoted", withdraw ? "position" : "spent-next", venue, { legId: step.id, portionBps: 10_000 })],
        ...(before > 0 ? { eta: etaOf(before, quoted) } : {}),
        ...(withdraw && venue ? { venue: { id: venue.id, name: venue.name, protocol: venue.protocol } } : {}),
      });
      walk.inputStop.set(step.id, id);
    }

    // Transit stop (cross-network legs only).
    if (isCross(step)) {
      const input = step.input;
      const deposited = flow ? flow.spends : input ? { expected: BigInt(input.amount), worst: BigInt(input.amount) } : null;
      const certainty: JourneyCertainty = flow ? (parentCredit?.certainty ?? "quoted") : started(step) ? "observed" : "quoted";
      const reference = mainReference(step);
      const link = explorerLink(step.network, reference);
      add({
        id: `transit:${step.id}`, kind: "transit", network: step.network, stepId: step.id, role: "transit",
        holder: { account: null, own: false, label: `${venueName(step)} (in transit)` },
        custody: "provider",
        state: "upcoming",
        holdings: input && deposited ? [holding(walk, step.network, refOf(input), deposited.expected, deposited.worst, certainty, "spent-next", null, { legId: step.id, portionBps: 10_000 })] : [],
        eta: etaOf(before, quoted),
        ...(reference ? { evidence: { reference, ...(link ? { url: link.url } : {}) } } : {}),
      });
    }

    // Output stop.
    const credit = outputCredit(walk, step, flow);
    walk.credits.set(step.id, credit);
    const destination = destinationOf(step);
    const holderAccount = holderOf(graph, step);
    const holderInfo = holderLabel(graph, step, holderAccount, destination);
    const custody: CustodyState = !holderInfo.own ? "third-party" : step.kind === "deposit" ? "venue" : "wallet";
    const reachedAt = step.status === "settled" ? settledAt(step) : undefined;
    const total = cumulative.get(step.id) ?? 0;
    add({
      id: `out:${step.id}`, kind: "end", network: destination, stepId: step.id, role: "out",
      holder: custody === "venue" && venue ? { account: holderAccount, own: true, label: venue.name } : holderInfo,
      custody,
      state: "upcoming",
      holdings: [],
      eta: etaOf(total, quoted),
      ...(reachedAt ? { reachedAt } : {}),
      ...(custody === "venue" && venue ? { venue: { id: venue.id, name: venue.name, protocol: venue.protocol } } : {}),
    });
    if (!walk.inputStop.has(step.id)) walk.inputStop.set(step.id, `out:${step.id}`);
  }

  // Holdings at output stops: the credit, split between the legs that spend it, what stays and gas.
  for (const step of order) {
    const stop = walk.byId.get(`out:${step.id}`);
    const credit = walk.credits.get(step.id) ?? null;
    if (!stop) continue;
    const venue = stepVenue(step);
    const children = walk.children.get(step.id) ?? [];
    if (children.length > 0) stop.kind = "arrival";
    if (credit) {
      if (children.length === 0) {
        const role: HoldingRole = stop.custody === "third-party" ? "paid" : stop.custody === "venue" ? "position" : "kept";
        stop.holdings.push(holding(walk, stop.network, credit.asset, credit.expected, credit.worst, credit.certainty, role, venue));
      } else {
        let spentExpected = 0n;
        let spentWorst = 0n;
        let reserve = 0n;
        for (const child of children) {
          const flow = walk.flows.get(child.id) as FundedFlow;
          spentExpected += flow.spends.expected;
          spentWorst += flow.spends.worst;
          reserve += flow.reserve;
          stop.holdings.push(holding(walk, stop.network, credit.asset, flow.spends.expected, flow.spends.worst, credit.certainty, "spent-next", venue, { legId: child.id, portionBps: portionOf(walk, child) }));
        }
        const keptExpected = nonNegative(credit.expected - spentExpected - reserve);
        const keptWorst = nonNegative(credit.worst - spentWorst - reserve);
        if (keptExpected > 0n || keptWorst > 0n) {
          stop.holdings.push(holding(walk, stop.network, credit.asset, keptExpected, keptWorst, credit.certainty, "kept", venue));
        }
        if (reserve > 0n) {
          const reserveWorst = credit.worst - spentWorst < reserve ? nonNegative(credit.worst - spentWorst) : reserve;
          stop.holdings.push(holding(walk, stop.network, credit.asset, reserve, reserveWorst, credit.certainty, "gas", null));
        }
      }
    }
    if (step.gasTopup && step.status !== "failed" && step.status !== "skipped") {
      const units = BigInt(step.gasTopup.amount);
      stop.holdings.push(holding(walk, stop.network, refOf(step.gasTopup), units, units, "quoted", "gas", null));
    }
  }
  assignStates(walk);
  return walk;
}

function setState(walk: Walk, id: string, state: StopState, custody?: CustodyState): void {
  const stop = walk.byId.get(id);
  if (!stop) return;
  stop.state = state;
  if (custody) stop.custody = custody;
}

/** Stop states and custody from step statuses. */
function assignStates(walk: Walk): void {
  for (const step of walk.order) {
    const start = `start:${step.id}`;
    const transit = `transit:${step.id}`;
    const out = `out:${step.id}`;
    const cross = isCross(step);
    const code = step.failure?.code ?? "";
    switch (step.status) {
      case "pending":
      case "ready":
      case "awaiting_signature":
        setState(walk, start, "current");
        break;
      case "submitted":
      case "confirmed":
      case "settling":
        setState(walk, start, "passed");
        if (cross) setState(walk, transit, "current", "provider");
        break;
      case "settled":
        setState(walk, start, "passed");
        setState(walk, transit, "passed");
        setState(walk, out, "current");
        break;
      case "indeterminate":
        setState(walk, start, "passed");
        if (cross) setState(walk, transit, "current", "unknown");
        else setState(walk, out, "current", "unknown");
        break;
      case "failed":
        if (code === "SETTLEMENT_REFUNDED") {
          setState(walk, start, "passed");
          setState(walk, transit, "current", "refund-due");
          setState(walk, out, "skipped");
        } else if (step.observedCredit) {
          setState(walk, start, "passed");
          setState(walk, transit, "passed");
          setState(walk, out, "current", isOwnRequestAccount(walk.graph, holderOf(walk.graph, step)) ? "wallet" : "third-party");
        } else if (code === "SETTLEMENT_FAILED" && cross) {
          setState(walk, start, "passed");
          setState(walk, transit, "current", "unknown");
          setState(walk, out, "skipped");
        } else {
          // Failed before landing (reverted, references rejected): the money is still at the input stop.
          setState(walk, start, "current");
        }
        break;
      case "skipped":
        setState(walk, start, "skipped");
        setState(walk, transit, "skipped");
        setState(walk, out, "skipped");
        break;
    }
  }
  // A settled stop is passed once a leg spending from it is under way (a failed leg leaves it current).
  for (const step of walk.order) {
    if (step.status !== "settled") continue;
    const children = walk.children.get(step.id) ?? [];
    if (children.some((child) => started(child))) setState(walk, `out:${step.id}`, "passed");
  }
  // Skipped steps whose input waits in a settled parent's stop leave it current (stopped there).
}

function legsOf(walk: Walk): JourneyLeg[] {
  return walk.order.map((step, index) => {
    const venue = stepVenue(step);
    const refund = refundPath(walk.graph, step);
    const transactions = transactionLinks(step);
    const tracking = transactions[0] ?? null;
    return {
      id: step.id,
      index,
      from: walk.inputStop.get(step.id) ?? `out:${step.id}`,
      ...(isCross(step) ? { via: `transit:${step.id}` } : {}),
      to: `out:${step.id}`,
      kind: step.kind,
      title: legTitle(walk, step),
      network: step.network,
      destinationNetwork: destinationOf(step),
      venue: { protocol: step.protocol, name: venue?.name ?? venueName(step), ...(step.venue ? { venueId: step.venue } : {}) },
      signer: step.mode === "wallet" ? step.account : null,
      signatures: signaturesOf(step, walk.preview),
      seconds: legSeconds(step),
      status: step.status,
      ...(step.failure ? { failure: { code: step.failure.code, message: step.failure.message } } : {}),
      ...(refund ? { refund } : {}),
      ...(step.gasTopup ? { gasTopup: { asset: refOf(step.gasTopup), amount: view(BigInt(step.gasTopup.amount), step.gasTopup.decimals), usd: step.gasTopup.usd ?? null } } : {}),
      ...(tracking ? { tracking } : {}),
      ...(transactions.length > 1 ? { transactions } : {}),
    };
  });
}

/* ------------------------------------------------------------ consequences */

type Draft = Omit<JourneyConsequence, "collapsed" | "prompt"> & { readonly question?: string };

function option(id: JourneyOptionKind, label: string, effect: string, action: JourneyOptionAction, costUsd: number | null = null, recommended = false): JourneyOption {
  return { id, label, effect, costUsd, recommended, action };
}

const OK_OPTION = option("ok", "I will handle it", "Nothing changes; you take care of it yourself.", { type: "acknowledge" });

function priceOfNative(facts: JourneyFacts, network: NetworkKey): number | null {
  return priceFact(facts, nativeAssetId(network))?.usd ?? null;
}

function unitsUsd(units: bigint, decimals: number, price: number | null): number | null {
  return price === null ? null : wholeUnits(units, decimals) * price;
}

/** A request without its text: the structured actions replace it. */
function actionsRequest(graph: IntentGraph, actions: readonly IntentActionSpec[]): IntentRequest {
  const { text: _text, actions: _actions, sourceNetwork: _source, ...rest } = graph.request;
  void _text;
  void _actions;
  void _source;
  return { ...rest, actions: [...actions] };
}

function topupRequest(graph: IntentGraph, network: NetworkKey, usd: string): IntentRequest {
  const constraints = graph.request.constraints ?? {};
  return { ...graph.request, constraints: { ...constraints, gasOnArrival: { ...(constraints.gasOnArrival ?? {}), [network]: usd } } };
}

function topupUsd(needUsd: number | null, exitUsd: number | null): string {
  if (needUsd === null) return "0.50";
  const raw = Math.ceil(3 * (needUsd + (exitUsd ?? 0)) * 100) / 100;
  const clamped = Math.min(JOURNEY_LIMITS.topupMaxUsd, Math.max(JOURNEY_LIMITS.topupMinUsd, raw));
  return clamped.toFixed(2);
}

/** Wallet legs of own accounts not signed yet, by `${network}:${address}`, in order. */
function unsignedLegsByAccount(walk: Walk): Map<string, IntentStep[]> {
  const out = new Map<string, IntentStep[]>();
  for (const step of walk.order) {
    if (step.mode !== "wallet" || !UNSIGNED_STATUSES.has(step.status) || (step.references?.length ?? 0) > 0) continue;
    if (!isOwnRequestAccount(walk.graph, step.account)) continue;
    const key = nativeKey(step.network, step.account);
    out.set(key, [...(out.get(key) ?? []), step]);
  }
  return out;
}

/** Gas-asset units earlier unsettled legs deliver to `account` on `network` (top-ups, reserves, kept gas-asset outputs). */
function deliveredGas(walk: Walk, network: NetworkKey, account: string, beforeIndex: number): bigint {
  let total = 0n;
  walk.order.forEach((step, index) => {
    if (index >= beforeIndex || step.status === "settled" || step.status === "failed" || step.status === "skipped") return;
    if (destinationOf(step) !== network || !sameAddressAccount(holderOf(walk.graph, step), `${CHAINS[network].id}:${addressOf(account)}`)) return;
    const stop = walk.byId.get(`out:${step.id}`);
    for (const entry of stop?.holdings ?? []) {
      if (!isNativeOf(entry.asset.asset, network)) continue;
      if (entry.role === "gas" || entry.role === "kept") total += BigInt(entry.atLeast.amount);
    }
  });
  return total;
}

/** The first unsettled cross-network leg arriving on `network` for the account (where a top-up or gas leg attaches). */
function arrivingLeg(walk: Walk, network: NetworkKey, account: string): IntentStep | null {
  return walk.order.find((step) =>
    isCross(step) && destinationOf(step) === network && step.status !== "settled" && step.status !== "skipped" &&
    sameAddressAccount(holderOf(walk.graph, step), `${CHAINS[network].id}:${addressOf(account)}`)) ?? null;
}

interface GasFinding {
  readonly network: NetworkKey;
  readonly account: string;
  readonly stopId: string;
  readonly legIds: string[];
  readonly need: bigint;
  readonly have: bigint | null;
  readonly fees: bigint;
}

function gasOptions(walk: Walk, network: NetworkKey, account: string, need: bigint, have: bigint | null): JourneyOption[] {
  const { facts, graph } = walk;
  const native = nativeRef(network);
  const price = priceOfNative(facts, network);
  const options: JourneyOption[] = [];
  const leg = arrivingLeg(walk, network, account);
  const capability = leg ? facts.gasOptions[leg.id] : undefined;
  const chain = CHAINS[network];
  const needUsd = unitsUsd(need, native.decimals, price);
  const exit = facts.exitFees[network];
  const exitUsd = exit && /^\d+$/u.test(exit) ? unitsUsd(BigInt(exit), native.decimals, price) : null;
  if (leg && capability?.topup && chain.vm === "evm") {
    const usd = topupUsd(needUsd, exitUsd);
    const delivered = price ? view(BigInt(Math.floor((Number(usd) / price) * 10 ** native.decimals)), native.decimals) : null;
    options.push(option(
      "gas-topup",
      `Add ${usd === "0.50" && needUsd === null ? "about $0.50" : `$${usd}`} of ${native.symbol} with the ${venueName(leg)} leg`,
      `${venueName(leg)} delivers ${delivered ? `about ${symbolText(delivered, native.symbol)}` : `$${usd} of ${native.symbol}`} on ${chain.name} with the fill; it costs about $${(Number(usd) + TOPUP_OVERHEAD_USD).toFixed(2)} from the bridged amount and re-plans the intent.`,
      { type: "replan", request: topupRequest(graph, network, usd) },
      cents(Number(usd) + TOPUP_OVERHEAD_USD),
      true,
    ));
  }
  const gasLeg = capability?.gasLeg ?? null;
  const actions = actionsFromGraph(graph);
  if (gasLeg && actions && !(leg && capability?.topup && chain.vm === "evm")) {
    options.push(option(
      "gas-leg",
      `Bridge $${JOURNEY_LIMITS.gasLegUsd} into ${native.symbol} first`,
      `A small ${getProtocol(gasLeg.protocol ?? "relay")?.name ?? "Relay"} bridge of $${JOURNEY_LIMITS.gasLegUsd} of the first leg's input into ${native.symbol} on ${chain.name} runs before the main leg: one more signature, about $${GAS_LEG_COST_USD.toFixed(2)} in fees, and $${JOURNEY_LIMITS.gasLegUsd} less of the input for the rest.`,
      { type: "replan", request: actionsRequest(graph, [gasLeg, ...actions]) },
      cents(JOURNEY_LIMITS.gasLegUsd + GAS_LEG_COST_USD),
      options.length === 0,
    ));
  }
  const needText = symbolText(view(need, native.decimals), native.symbol);
  options.push(option(
    "bring-gas",
    `I will bring ${native.symbol} myself`,
    `Send at least ${needText} to your ${chain.name} wallet before that step${have !== null ? `; it holds ${symbolText(view(have, native.decimals), native.symbol)} now` : ""}.`,
    { type: "acknowledge" },
    needUsd === null ? null : cents(needUsd),
  ));
  return options;
}

/** R1 gas to continue, and the per-network findings R2 skips. */
function ruleGasToContinue(walk: Walk, drafts: Draft[]): Set<NetworkKey> {
  const fired = new Set<NetworkKey>();
  const { facts } = walk;
  const byAccount = unsignedLegsByAccount(walk);
  if (facts.reads === "none") {
    const networks = [...new Set([...byAccount.keys()].map((key) => key.slice(0, key.indexOf(":")) as NetworkKey))];
    if (networks.length > 0) {
      drafts.push({
        id: "gas-to-continue:reads-none",
        kind: "gas-to-continue",
        severity: "info",
        stopId: null,
        legIds: [...byAccount.values()].flat().map((step) => step.id),
        title: `Connect your wallets to check gas on ${networks.map(networkName).join(" and ")}`,
        detail: "Balances were not read for these accounts, so Kletia cannot tell whether every step can pay its network fee.",
        certainty: "estimated",
        facts: {},
        source: "No account reads (demo or indicative)",
        options: [],
      });
    }
    return new Set(networks);
  }
  for (const [key, legs] of byAccount) {
    const first = legs[0] as IntentStep;
    const network = first.network;
    const native = nativeRef(network);
    const have = facts.native[key];
    let fees = 0n;
    let need = 0n;
    const short: string[] = [];
    let unknownFee = false;
    for (const leg of legs) {
      const fee = facts.fees[leg.id];
      if (!fee || !/^\d+$/u.test(fee.amount)) {
        unknownFee = true;
        continue;
      }
      fees += BigInt(fee.amount);
      if (have === null || have === undefined) continue;
      const index = walk.order.indexOf(leg);
      const available = BigInt(have.amount) + deliveredGas(walk, network, leg.account, index);
      if (available < fees) {
        if (fees - available > need) need = fees - available;
        short.push(leg.id);
      }
    }
    const stopId = walk.inputStop.get(first.id) ?? `start:${first.id}`;
    const certainty: JourneyCertainty = legs.some((leg) => facts.fees[leg.id]?.certainty === "estimated") ? "estimated" : (facts.fees[first.id]?.certainty ?? "estimated");
    if (have === null || have === undefined) {
      fired.add(network);
      drafts.push({
        id: `gas-to-continue:${stopId}`,
        kind: "gas-to-continue",
        severity: "warn",
        stopId,
        legIds: legs.map((leg) => leg.id),
        title: `Could not read your ${native.symbol} balance on ${networkName(network)}`,
        detail: `The steps on ${networkName(network)} need about ${symbolText(view(fees, native.decimals), native.symbol)} for network fees; your balance there could not be read, so check it before you sign.`,
        certainty,
        facts: { fees: fees.toString() },
        source: `${networkName(network)} RPC read failed at ${timeOf(facts.at)}`,
        options: gasOptions(walk, network, first.account, fees, null),
      });
      continue;
    }
    if (need === 0n) continue;
    fired.add(network);
    const needText = symbolText(view(need, native.decimals), native.symbol);
    const legNumbers = short.map((id) => walk.order.findIndex((step) => step.id === id) + 1);
    const which = legNumbers.length === 1 ? `step ${legNumbers[0]}` : `steps ${legNumbers.join(", ")}`;
    const options = gasOptions(walk, network, first.account, need, BigInt(have.amount));
    drafts.push({
      id: `gas-to-continue:${stopId}`,
      kind: "gas-to-continue",
      severity: "block",
      stopId,
      legIds: short,
      title: `${networkName(network)} needs ${needText} more for network fees`,
      detail: `Your ${networkName(network)} wallet holds ${symbolText(view(BigInt(have.amount), native.decimals), native.symbol)}; ${which} cannot be signed without about ${needText} more${unknownFee ? " (some fees could not be estimated)" : ""}. Nothing tops up on its own.`,
      certainty,
      facts: { need: need.toString(), have: have.amount, fees: fees.toString() },
      source: `${networkName(network)} balance read at ${timeOf(have.at)}; fees ${certainty === "estimated" ? "estimated" : "from the simulation"}`,
      options,
      question: `How should the network fee on ${networkName(network)} be paid?`,
    });
  }
  return fired;
}

/** R2 gas to leave: an end stop holding no gas asset where no gas is left after the journey. */
function ruleGasToLeave(walk: Walk, drafts: Draft[], skip: ReadonlySet<NetworkKey>): void {
  const { facts } = walk;
  if (facts.reads === "none") return;
  const seen = new Set<string>();
  for (const stop of walk.stops) {
    if (stop.kind !== "end" || stop.state === "skipped" || !stop.holder.own || (stop.custody !== "wallet" && stop.custody !== "venue")) continue;
    if (skip.has(stop.network) || !stop.holder.account) continue;
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    if (!main || isNativeOf(main.asset.asset, stop.network)) continue;
    const key = nativeKey(stop.network, stop.holder.account);
    if (seen.has(key)) continue;
    seen.add(key);
    const have = facts.native[key];
    const exit = facts.exitFees[stop.network];
    if (!have || !exit || !/^\d+$/u.test(exit)) continue;
    const delivered = deliveredGas(walk, stop.network, stop.holder.account, walk.order.length);
    const spent = walk.order
      .filter((step) => step.mode === "wallet" && UNSIGNED_STATUSES.has(step.status) && nativeKey(step.network, step.account) === key)
      .reduce((total, step) => total + (facts.fees[step.id] && /^\d+$/u.test(facts.fees[step.id]!.amount) ? BigInt(facts.fees[step.id]!.amount) : 0n), 0n);
    const left = BigInt(have.amount) + delivered - spent;
    if (left >= BigInt(exit)) continue;
    const native = nativeRef(stop.network);
    const options = gasOptions(walk, stop.network, stop.holder.account, nonNegative(BigInt(exit) - left), BigInt(have.amount))
      .filter((entry) => entry.id !== "bring-gas");
    drafts.push({
      id: `gas-to-leave:${stop.id}`,
      kind: "gas-to-leave",
      severity: "warn",
      stopId: stop.id,
      legIds: [],
      title: `No ${native.symbol} left on ${networkName(stop.network)} to move ${main.asset.symbol} later`,
      detail: `After this journey your ${networkName(stop.network)} wallet holds about ${symbolText(view(nonNegative(left), native.decimals), native.symbol)}; moving the ${main.asset.symbol} again needs about ${symbolText(view(BigInt(exit), native.decimals), native.symbol)}.`,
      certainty: "estimated",
      facts: { left: nonNegative(left).toString(), exitFee: exit, have: have.amount },
      source: `${networkName(stop.network)} balance read at ${timeOf(have.at)}; exit fee estimated`,
      options: [...options, OK_OPTION],
    });
  }
}

function belowDust(entry: JourneyHolding): boolean {
  return entry.value.expectedUsd !== null && entry.value.expectedUsd < JOURNEY_LIMITS.dustUsd;
}

/** R3 asset identity of arrival and end holdings. */
function ruleAssetIdentity(walk: Walk, drafts: Draft[]): void {
  const seen = new Set<string>();
  for (const stop of walk.stops) {
    if ((stop.kind !== "arrival" && stop.kind !== "end") || stop.state === "skipped") continue;
    for (const entry of stop.holdings) {
      if (entry.role === "gas" || entry.identity.kind === "native" || entry.identity.kind === "issuer" || belowDust(entry)) continue;
      const id = `asset-identity:${stop.id}:${normalizedAsset(entry.asset.asset)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      drafts.push({
        id,
        kind: "asset-identity",
        severity: entry.identity.kind === "unlisted" ? "warn" : "info",
        stopId: stop.id,
        legIds: [],
        title: `${entry.asset.symbol} on ${networkName(stop.network)}: ${entry.identity.kind.replace("-", " ")}`,
        detail: entry.identity.label,
        certainty: "quoted",
        facts: { asset: entry.asset.asset },
        source: "Kletia asset and venue registry",
        options: [],
      });
    }
  }
}

/** R4 price exposure. */
function rulePriceExposure(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if (step.status === "settled" || step.status === "skipped") continue;
    const input = step.input;
    const output = step.minimumOutput ?? step.expectedOutput;
    const stopId = `out:${step.id}`;
    if (isCross(step) && input && output) {
      const sameKind = (lookupAsset(input.asset)?.group ?? input.symbol) === (lookupAsset(output.asset)?.group ?? output.symbol);
      if (sameKind && !isStable(input.asset)) {
        drafts.push({
          id: `price-exposure:${stopId}:units`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
          title: `${input.symbol} units are fixed; their dollar value moves`,
          detail: `The ${input.symbol} amount is fixed when you sign; its dollar value moves with ${input.symbol} for about ${legSeconds(step) ?? 20} s until it arrives.`,
          certainty: "quoted", facts: {}, source: "Rule (volatile asset in transit)", options: [],
        });
      } else if (!sameKind) {
        drafts.push({
          id: `price-exposure:${stopId}:cross-asset`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
          title: `${venueName(step)} swaps ${input.symbol} into ${output.symbol} on arrival`,
          detail: `The ${output.symbol} amount is fixed when you sign; a refund would return ${input.symbol} on ${networkName(step.network)}, not ${output.symbol}.`,
          certainty: "quoted", facts: {}, source: "Rule (cross-asset leg)", options: [],
        });
      }
    }
    const parent = fundingParent(walk.graph, step);
    if (parent && isCross(parent) && input && output && ["swap", "stake", "bridge"].includes(step.kind)) {
      const volatile = !isStable(input.asset) || !isStable(output.asset);
      drafts.push({
        id: `price-exposure:${walk.inputStop.get(step.id) ?? stopId}:reprice`, kind: "price-exposure", severity: volatile ? "warn" : "info",
        stopId: walk.inputStop.get(step.id) ?? stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is priced again when the money arrives`,
        detail: `${legTitle(walk, step)} is quoted again before you sign it; you are asked again if its guaranteed amount is more than ${(PREVIEW_CHANGE_LIMITS.amountToleranceBps / 100).toFixed(1)}% worse than what you approved.`,
        certainty: "quoted", facts: { toleranceBps: String(PREVIEW_CHANGE_LIMITS.amountToleranceBps) }, source: "Rule (preview binding tolerance)", options: [],
      });
    }
    const venue = stepVenue(step);
    if (step.kind === "deposit" && venue && !oneToOne(venue) && venue.kind !== "jupiter-lend" && venue.kind !== "kamino-reserve" && venue.kind !== "save-reserve") {
      drafts.push({
        id: `price-exposure:${stopId}:shares`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
        title: `${venue.name} shares can lose value`,
        detail: `You hold vault shares; their value in ${venue.asset} follows the vault and can fall if the vault loses money.`,
        certainty: "quoted", facts: {}, source: "Rule (vault shares)", options: [],
      });
    }
  }
}

/** The whole intent as actions with `step` free to use any listed venue (plan stage: nothing landed yet). */
function withoutVenue(graph: IntentGraph, step: IntentStep): IntentRequest | null {
  const actions = actionsFromGraph(graph);
  const index = topologicalOrder(graph.steps).filter((candidate) => candidate.mode !== "read").findIndex((candidate) => candidate.id === step.id);
  if (!actions || index < 0 || !actions[index]) return null;
  const { protocol: _protocol, params, ...rest } = actions[index] as IntentActionSpec;
  void _protocol;
  const kept = params ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== "venue")) : {};
  actions[index] = { ...rest, ...(Object.keys(kept).length > 0 ? { params: kept } : {}) };
  return actionsRequest(graph, actions);
}

/** R5 venue capacity of deposit and withdraw legs. */
function ruleVenueCapacity(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if ((step.kind !== "deposit" && step.kind !== "withdraw") || started(step) || step.status === "skipped") continue;
    const venue = stepVenue(step);
    if (!venue) continue;
    const fact = walk.facts.venues[venue.id];
    const stopId = step.kind === "deposit" ? `out:${step.id}` : (walk.inputStop.get(step.id) ?? `start:${step.id}`);
    const flow = walk.flows.get(step.id);
    const amount = flow ? flow.spends.expected : step.input ? BigInt(step.input.amount) : 0n;
    const decimals = step.input?.decimals ?? 0;
    const symbol = step.input?.symbol ?? venue.asset;
    const replan = continuationRequest(walk.graph, walk.inputStop.get(step.id) ?? `start:${step.id}`, { anyVenue: true }) ?? withoutVenue(walk.graph, step);
    const anyVenue = replan ? [option("replan-any-venue", "Plan it at another listed venue", "Re-plans the rest of the journey without this venue; you review the new fare before signing.", { type: "replan", request: replan }, null, true)] : [];
    if (walk.facts.reads === "none" && fact === undefined) continue;
    if (fact === undefined || fact === null) {
      drafts.push({
        id: `venue-capacity:${stopId}`, kind: "venue-capacity", severity: "info", stopId, legIds: [step.id],
        title: `Could not read ${venue.name}'s capacity`,
        detail: `Kletia could not read ${venue.name}'s caps and liquidity; the venue is checked again when the step is prepared.`,
        certainty: "estimated", facts: {}, source: `${venue.name} reads failed at ${timeOf(walk.facts.at)}`, options: [],
      });
      continue;
    }
    const base = { kind: "venue-capacity" as const, stopId, legIds: [step.id], certainty: "observed" as const, source: `${venue.name} on-chain state read at ${timeOf(fact.at)}` };
    if (fact.paused || fact.frozen) {
      drafts.push({
        ...base, id: `venue-capacity:${stopId}`, severity: "block",
        title: `${venue.name} is ${fact.paused ? "paused" : "frozen"}`,
        detail: `${venue.name} does not accept ${step.kind === "deposit" ? "deposits" : "withdrawals"} right now, so step ${walk.order.indexOf(step) + 1} would be refused.`,
        facts: { paused: String(fact.paused), frozen: String(fact.frozen) },
        options: [...anyVenue, OK_OPTION], question: `${venue.name} is not accepting this step. What should happen?`,
      });
      continue;
    }
    if (step.kind === "deposit" && fact.capRemaining !== null && /^\d+$/u.test(fact.capRemaining)) {
      const headroom = BigInt(fact.capRemaining);
      if (headroom < amount) {
        drafts.push({
          ...base, id: `venue-capacity:${stopId}`, severity: "block",
          title: `${venue.name} is nearly full`,
          detail: `${venue.name} can take ${symbolText(view(headroom, decimals), symbol)} more under its supply cap; this step deposits about ${symbolText(view(amount, decimals), symbol)}.`,
          facts: { capRemaining: fact.capRemaining, amount: amount.toString() },
          options: [...anyVenue, OK_OPTION], question: `${venue.name} cannot take the whole deposit. What should happen?`,
        });
        continue;
      }
      if (headroom < amount * BigInt(JOURNEY_LIMITS.capWarnMultiple)) {
        drafts.push({
          ...base, id: `venue-capacity:${stopId}`, severity: "warn",
          title: `${venue.name} has little room under its cap`,
          detail: `${symbolText(view(headroom, decimals), symbol)} still fits under ${venue.name}'s supply cap; it could fill before this step runs.`,
          facts: { capRemaining: fact.capRemaining, amount: amount.toString() },
          options: anyVenue,
        });
      }
    }
    if (step.kind === "withdraw" && fact.exitLiquidity !== null && /^\d+$/u.test(fact.exitLiquidity) && BigInt(fact.exitLiquidity) < amount) {
      drafts.push({
        ...base, id: `venue-capacity:${stopId}`, severity: "block",
        title: `${venue.name} cannot pay out ${symbolText(view(amount, decimals), symbol)} right now`,
        detail: `${symbolText(view(BigInt(fact.exitLiquidity), decimals), symbol)} can leave ${venue.name} now; borrowers hold the rest.`,
        facts: { exitLiquidity: fact.exitLiquidity, amount: amount.toString() },
        options: [OK_OPTION], question: `${venue.name} cannot pay out the whole amount now. What should happen?`,
      });
    }
  }
}

function usdMicrosOf(value: string | null): number | null {
  if (value === null || !/^\d+(\.\d+)?$/u.test(value)) return null;
  return Number(value);
}

/** R6 Rule Book headroom, schedule and approval expiry. */
function ruleRuleBook(walk: Walk, drafts: Draft[], now: number): void {
  const policy = walk.facts.policy;
  if (!policy || !walk.graph.policy) return;
  const later = walk.order.filter((step) => !started(step) && step.status !== "skipped" && step.status !== "settled" && step.mode === "wallet");
  const notional = (step: IntentStep): number | null => {
    const stop = walk.byId.get(walk.inputStop.get(step.id) ?? "");
    const entry = stop?.holdings.find((candidate) => candidate.next?.legId === step.id) ?? stop?.holdings[0];
    return entry?.value.expectedUsd ?? null;
  };
  const source = `Rule Book read at ${timeOf(walk.facts.at)}`;
  const perStep = usdMicrosOf(policy.perStepUsd);
  let total = 0;
  let priced = true;
  for (const step of later) {
    const value = notional(step);
    if (value === null) {
      priced = false;
      continue;
    }
    total += value;
    if (perStep === null || walk.order.indexOf(step) === 0) continue;
    const stopId = walk.inputStop.get(step.id) ?? null;
    if (value > perStep) {
      drafts.push({
        id: `rule-book:${stopId}:per-step`, kind: "rule-book", severity: "block", stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is above your Rule Book's per-step cap`,
        detail: `It moves about $${value.toFixed(2)}; the cap is $${perStep.toFixed(2)}, so prepare would refuse it.`,
        certainty: "estimated", facts: { notionalUsd: value.toFixed(2), perStepUsd: policy.perStepUsd ?? "" }, source,
        options: [OK_OPTION], question: "This step exceeds your Rule Book. What should happen?",
      });
    } else if (value > perStep * 0.8) {
      drafts.push({
        id: `rule-book:${stopId}:per-step`, kind: "rule-book", severity: "warn", stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is close to your per-step cap`,
        detail: `About $${value.toFixed(2)} of a $${perStep.toFixed(2)} cap; a price move could push it over.`,
        certainty: "estimated", facts: { notionalUsd: value.toFixed(2), perStepUsd: policy.perStepUsd ?? "" }, source, options: [OK_OPTION],
      });
    }
  }
  for (const [label, remaining] of [["daily", usdMicrosOf(policy.dailyRemainingUsd)], ["weekly", usdMicrosOf(policy.weeklyRemainingUsd)]] as const) {
    if (remaining === null || !priced || later.length === 0) continue;
    if (total > remaining) {
      drafts.push({
        id: `rule-book:${label}`, kind: "rule-book", severity: "block", stopId: null, legIds: later.map((step) => step.id),
        title: `The remaining steps exceed your ${label} Rule Book allowance`,
        detail: `They move about $${total.toFixed(2)}; $${remaining.toFixed(2)} is left in the ${label === "daily" ? "rolling 24 h" : "rolling 7 d"} window.`,
        certainty: "estimated", facts: { totalUsd: total.toFixed(2), remainingUsd: remaining.toFixed(2) }, source,
        options: [OK_OPTION], question: `The ${label} allowance would be exceeded. What should happen?`,
      });
    } else if (total > remaining * 0.8) {
      drafts.push({
        id: `rule-book:${label}`, kind: "rule-book", severity: "warn", stopId: null, legIds: later.map((step) => step.id),
        title: `The remaining steps use most of your ${label} allowance`,
        detail: `About $${total.toFixed(2)} of $${remaining.toFixed(2)} left.`,
        certainty: "estimated", facts: { totalUsd: total.toFixed(2), remainingUsd: remaining.toFixed(2) }, source, options: [OK_OPTION],
      });
    }
  }
  const eta = walk.stops.reduce((max, stop) => Math.max(max, stop.eta?.afterFirstSignatureSeconds ?? 0), 0);
  if (policy.schedule) {
    for (const step of later) {
      const at = now + (walk.byId.get(walk.inputStop.get(step.id) ?? "")?.eta?.afterFirstSignatureSeconds ?? 0) * 1000;
      const state = scheduleState(policy.schedule, at);
      if (state.open) continue;
      drafts.push({
        id: `rule-book:${walk.inputStop.get(step.id) ?? step.id}:schedule`, kind: "rule-book", severity: "warn", stopId: walk.inputStop.get(step.id) ?? null, legIds: [step.id],
        title: `Your Rule Book is closed when step ${walk.order.indexOf(step) + 1} would run`,
        detail: `Its schedule opens again at ${state.nextChange ? timeOf(state.nextChange) : "a later time"}; the money waits at that stop until then.`,
        certainty: "estimated", facts: { nextChange: state.nextChange ?? "" }, source, options: [OK_OPTION],
      });
      break;
    }
  }
  if (policy.approvalExpiresAt) {
    const expires = Date.parse(policy.approvalExpiresAt);
    if (Number.isFinite(expires) && expires < now + eta * 1000) {
      drafts.push({
        id: "rule-book:approval", kind: "rule-book", severity: "warn", stopId: null, legIds: later.map((step) => step.id),
        title: "The approval expires before the journey ends",
        detail: `The approval hold ends at ${timeOf(policy.approvalExpiresAt)}; later steps need a new approval after that.`,
        certainty: "observed", facts: { approvalExpiresAt: policy.approvalExpiresAt }, source,
        options: walk.graph.policy.approval ? [option("ok", "Understood", "Nothing changes.", { type: "link", url: walk.graph.policy.approval.url })] : [OK_OPTION],
      });
    }
  }
}

const RETRY_REFUSED_CODES: ReadonlySet<string> = new Set(["SETTLEMENT_REFUNDED", "SETTLEMENT_FAILED", "SETTLEMENT_MISMATCH"]);

function bringBackText(stop: StopDraft, origin: NetworkKey): string | null {
  const main = stop.holdings.find((entry) => entry.role !== "gas" && entry.role !== "paid");
  if (!main || stop.network === origin) return null;
  return `bridge ${fromBaseUnits(main.atLeast.amount, main.asset.decimals)} ${main.asset.symbol} from ${stop.network} to ${origin}`;
}

/** The stop where the money waits after a failed leg. */
function failureStop(walk: Walk, step: IntentStep): string {
  const code = step.failure?.code ?? "";
  if (code === "SETTLEMENT_REFUNDED" || (code === "SETTLEMENT_FAILED" && isCross(step))) return `transit:${step.id}`;
  if (step.observedCredit) return `out:${step.id}`;
  return walk.inputStop.get(step.id) ?? `start:${step.id}`;
}

/** R7 if stopped (plan: folded notes per arrival stop; live: options after a failed leg). */
function ruleIfStopped(walk: Walk, drafts: Draft[]): void {
  const origin = walk.order[0]?.network ?? "base";
  for (const step of walk.order) {
    if (step.status !== "failed") continue;
    const stopId = failureStop(walk, step);
    const stop = walk.byId.get(stopId);
    if (!stop) continue;
    const code = step.failure?.code ?? "";
    const options: JourneyOption[] = [];
    const retryable = !RETRY_REFUSED_CODES.has(code) && !step.observedCredit;
    if (retryable) options.push(option("retry", `Try step ${walk.order.indexOf(step) + 1} again`, "Prepares the same leg again with a fresh quote; you sign it again.", { type: "retry", legId: step.id }, null, true));
    const resumeFrom = stop.role === "transit" ? `start:${step.id}` : stopId;
    const same = continuationRequest(walk.graph, resumeFrom);
    const any = continuationRequest(walk.graph, resumeFrom, { anyVenue: true });
    if (same) options.push(option("replan-same-venue", "Plan the rest again", "Plans what is left from here as a new intent with the amount that landed; you review its fare first.", { type: "replan", request: same }, null, !retryable));
    if (any) options.push(option("replan-any-venue", "Plan the rest at any listed venue", "Same, without holding to this venue.", { type: "replan", request: any }));
    options.push(option("end-here", "End the journey here", `Stops the intent; the money stays where it is (${stop.holder.label}).`, { type: "stop" }));
    const back = bringBackText(stop, origin);
    if (back) options.push(option("bring-back", `Bring it back to ${networkName(origin)}`, "A separate new intent you review before signing.", { type: "plan-new", text: back }));
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    drafts.push({
      id: `if-stopped:${stopId}`,
      kind: "if-stopped",
      severity: "act",
      stopId,
      legIds: [step.id],
      title: `Step ${walk.order.indexOf(step) + 1} did not complete`,
      detail: `${step.failure?.message ?? "The leg failed."} ${main ? `Your ${symbolText(main.atLeast, main.asset.symbol)} ${stop.custody === "refund-due" ? "is being refunded to" : stop.custody === "unknown" ? "is with" : "waits at"} ${stop.custody === "refund-due" ? `your ${networkName(step.network)} wallet` : stop.holder.label}.` : ""}`.trim(),
      certainty: main?.certainty ?? "observed",
      facts: { code },
      source: "Step status",
      options,
      question: `Step ${walk.order.indexOf(step) + 1} did not complete. What next?`,
    });
  }
  for (const stop of walk.stops) {
    if (stop.kind !== "arrival" || stop.state === "skipped" || stop.state === "passed") continue;
    const main = stop.holdings.find((entry) => entry.role === "spent-next");
    if (!main?.next) continue;
    const child = walk.graph.steps.find((candidate) => candidate.id === main.next?.legId);
    if (!child || child.status === "failed") continue;
    const number = walk.order.indexOf(child) + 1;
    drafts.push({
      id: `if-stopped:${stop.id}`, kind: "if-stopped", severity: "info", stopId: stop.id, legIds: [child.id],
      title: `If step ${number} cannot run, the money waits in ${stop.holder.label}`,
      detail: `Your ${symbolText(main.atLeast, main.asset.symbol)} would stay in ${stop.holder.label} on ${networkName(stop.network)}; nothing is re-planned on its own. You can retry, plan the rest again or end the journey there.`,
      certainty: main.certainty, facts: {}, source: "Rule (amount flow F5)", options: [],
    });
  }
}

/** R8 refund path of every cross-network leg. */
function ruleRefundPath(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if (!isCross(step) || step.status === "settled" || step.status === "skipped") continue;
    const refund = refundPath(walk.graph, step);
    if (!refund) continue;
    const stopId = `transit:${step.id}`;
    let severity: ConsequenceSeverity = "info";
    const options: JourneyOption[] = [];
    let detail = refund.label;
    if (refund.needs && refund.needs.account) {
      const balance = walk.facts.native[nativeKey(refund.needs.network, refund.needs.account)];
      if (balance && BigInt(balance.amount) === 0n) {
        severity = "act";
        detail = `${refund.label} Your ${networkName(refund.needs.network)} account holds no ${refund.needs.asset.symbol} now: to cancel an unfilled order you need ${refund.needs.asset.symbol} on ${networkName(refund.needs.network)}.`;
        options.push(option("bring-gas", `Keep some ${refund.needs.asset.symbol} on ${networkName(refund.needs.network)}`, `Send a little ${refund.needs.asset.symbol} to that account if the order stays unfilled.`, { type: "acknowledge" }));
      }
    }
    drafts.push({
      id: `refund-path:${stopId}`, kind: "refund-path", severity, stopId, legIds: [step.id],
      title: `If ${venueName(step)} cannot fill`,
      detail,
      certainty: "quoted",
      facts: { mode: refund.mode, delay: refund.typicalDelay },
      source: `${venueName(step)} documentation`,
      options,
    });
  }
}

/** R9 approvals that stay open. */
function ruleAllowanceLeft(walk: Walk, drafts: Draft[]): void {
  const seen = new Set<string>();
  const push = (network: NetworkKey, token: AssetRef, spender: string, spenderLabel: string, amount: string, source: string, stepId: string | null) => {
    const id = `allowance-left:${network}:${normalizedAsset(token.asset)}:${spender.toLowerCase()}`;
    if (seen.has(id) || !/^\d+$/u.test(amount) || BigInt(amount) === 0n) return;
    seen.add(id);
    const explorer = CHAINS[network].explorer.address.replace("{address}", spender);
    drafts.push({
      id, kind: "allowance-left", severity: "warn", stopId: stepId ? `out:${stepId}` : null, legIds: stepId ? [stepId] : [],
      title: `${symbolText(view(BigInt(amount), token.decimals), token.symbol)} stays approved to ${spenderLabel}`,
      detail: `${spenderLabel} can still move that much ${token.symbol} from your ${networkName(network)} wallet. To close it, call approve(${spender}, 0) on the ${token.symbol} contract.`,
      certainty: "simulated", facts: { amount, spender }, source,
      options: [option("ok", "Understood", "Nothing changes; you can revoke it any time.", { type: "link", url: explorer })],
    });
  };
  for (const approval of walk.preview?.approvals ?? []) {
    if (approval.leftAfter !== null) push(approval.network, approval.token, approval.spender, approval.spenderLabel, approval.leftAfter, "Simulation of the step", approval.stepId);
  }
  for (const allowance of walk.facts.allowances) push(allowance.network, allowance.token, allowance.spender, allowance.spenderLabel, allowance.amount, `RPC read at ${timeOf(allowance.at)}`, null);
}

/** R10 time windows: expiry, payload lifetime, legs overdue in transit. */
function ruleTimeWindow(walk: Walk, drafts: Draft[], now: number, stage: JourneyStage): void {
  if (stage === "plan") {
    const first = walk.stops[0];
    const across = walk.order.some((step) => step.protocol === "across" || (step.protocol === "lifi" && lifiTool(step) !== "polymer" && isCross(step)));
    const solana = walk.order.some((step) => CHAINS[step.network].vm === "svm" && step.mode === "wallet");
    drafts.push({
      id: `time-window:${first?.id ?? "plan"}`, kind: "time-window", severity: "info", stopId: first?.id ?? null, legIds: [],
      title: "Time limits of this plan",
      detail: [
        `The plan expires at ${timeOf(walk.graph.expiresAt)} if nothing is signed.`,
        `Each prepared step is valid for ${PAYLOAD_TTL_SECONDS} s${solana ? " (Solana: until its blockhash expires)" : ""}.`,
        ...(across ? ["Across fills have a fill deadline of at least 10 minutes; unfilled deposits are refunded after it."] : []),
      ].join(" "),
      certainty: "quoted", facts: { expiresAt: walk.graph.expiresAt }, source: "Plan", options: [],
    });
    return;
  }
  for (const step of walk.order) {
    if (step.status !== "submitted" && step.status !== "settling" && step.status !== "confirmed") continue;
    const seconds = legSeconds(step);
    const evidence = step.evidence.find((entry) => entry.kind === "transaction")?.observedAt ?? step.prepared?.preparedAt;
    const since = evidence ? Date.parse(evidence) : NaN;
    if (seconds === null || !Number.isFinite(since)) continue;
    const elapsed = (now - since) / 1000;
    if (elapsed <= seconds * 2 + 60) continue;
    const tracking = explorerLink(step.network, mainReference(step));
    const left = Math.max(0, MANUAL_REVIEW_SECONDS - elapsed);
    drafts.push({
      id: `time-window:transit:${step.id}`, kind: "time-window", severity: "warn", stopId: isCross(step) ? `transit:${step.id}` : `out:${step.id}`, legIds: [step.id],
      title: `Step ${walk.order.indexOf(step) + 1} is taking longer than usual`,
      detail: `It usually takes about ${Math.round(seconds)} s and has taken ${Math.round(elapsed)} s. Kletia keeps checking; after 3 hours an unresolved leg goes to manual review (${Math.round(left / 60)} min left).`,
      certainty: "observed", facts: { elapsedSeconds: String(Math.round(elapsed)), expectedSeconds: String(Math.round(seconds)) }, source: "Clock and step evidence",
      options: tracking ? [option("track", tracking.label, "Opens the explorer for the deposit transaction.", { type: "link", url: tracking.url })] : [],
    });
  }
}

/** R11 idle funds: listed venues on the same network for kept or end wallet holdings. */
function ruleIdleFunds(walk: Walk, drafts: Draft[]): void {
  const { facts } = walk;
  for (const stop of walk.stops) {
    if (stop.custody !== "wallet" || !stop.holder.own || stop.state === "skipped") continue;
    for (const entry of stop.holdings) {
      const idle = entry.role === "kept" && (stop.kind === "end" || stop.kind === "arrival");
      if (!idle || isNativeOf(entry.asset.asset, stop.network)) continue;
      const usd = entry.value.atLeastUsd;
      if (usd === null || usd < JOURNEY_LIMITS.idleMinUsd) continue;
      const amount = BigInt(entry.atLeast.amount);
      const candidates = YIELD_VENUES.filter((venue) => {
        if (venue.network !== stop.network || !venue.actions.includes("deposit")) return false;
        const underlying = underlyingRef(venue);
        if (!underlying || !sameAsset(underlying.asset, entry.asset.asset)) return false;
        const fact = facts.venues[venue.id];
        if (!fact || fact.paused || fact.frozen || fact.apy === null || fact.apy < JOURNEY_LIMITS.suggestionMinApy) return false;
        if (fact.utilization === null || fact.utilization >= JOURNEY_LIMITS.suggestionMaxUtilization) return false;
        if (fact.exitLiquidity === null || !/^\d+$/u.test(fact.exitLiquidity)) return false;
        return BigInt(fact.exitLiquidity) >= amount * BigInt(JOURNEY_LIMITS.suggestionMinExitMultiple);
      }).sort((a, b) => (facts.venues[b.id]?.apy ?? 0) - (facts.venues[a.id]?.apy ?? 0) || a.id.localeCompare(b.id)).slice(0, 2);
      if (candidates.length === 0) continue;
      drafts.push({
        id: `idle-funds:${stop.id}:${normalizedAsset(entry.asset.asset)}`, kind: "idle-funds", severity: "info", stopId: stop.id, legIds: [],
        title: `${symbolText(entry.atLeast, entry.asset.symbol)} stays idle on ${networkName(stop.network)}`,
        detail: `It earns nothing in your wallet. Listed venues there: ${candidates.map((venue) => `${venue.name} ${((facts.venues[venue.id]?.apy ?? 0) * 100).toFixed(2)}% APY`).join(", ")} (variable, not guaranteed).`,
        certainty: entry.certainty, facts: { amount: entry.atLeast.amount }, source: `Venue reads at ${timeOf(facts.at)}`,
        options: candidates.map((venue) => option(
          `${JOURNEY_DEPOSIT_OPTION_PREFIX}${venue.id}`,
          `Deposit into ${venue.name}`,
          "A separate new intent you review before signing; nothing runs on its own.",
          { type: "plan-new", text: `deposit ${fromBaseUnits(entry.atLeast.amount, entry.asset.decimals)} ${entry.asset.symbol} into ${(getProtocol(venue.protocol)?.name ?? venue.protocol).toLowerCase()} on ${stop.network}` },
        )),
      });
    }
  }
}

/** R12 exit path of end stops: venue liquidity, liquid staking, money bridged away. */
function ruleExitPath(walk: Walk, drafts: Draft[]): void {
  const origin = walk.order[0]?.network;
  for (const stop of walk.stops) {
    if (stop.kind !== "end" || stop.state === "skipped" || !stop.holder.own) continue;
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    if (!main || belowDust(main)) continue;
    const step = walk.graph.steps.find((candidate) => candidate.id === stop.stepId);
    const venue = step ? stepVenue(step) : null;
    if (stop.custody === "venue" && venue) {
      const fact = walk.facts.venues[venue.id];
      const underlying = underlyingRef(venue);
      const flowIn = step ? walk.flows.get(step.id) : undefined;
      const deposited = flowIn ? flowIn.spends.worst : step?.input ? BigInt(step.input.amount) : 0n;
      const decimals = underlying?.decimals ?? main.asset.decimals;
      const symbol = underlying?.symbol ?? venue.asset;
      if (!fact) {
        drafts.push({
          id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
          title: `Withdraw from ${venue.name} any time while liquidity lasts`,
          detail: `${venue.name}'s exit liquidity could not be read now.`,
          certainty: "estimated", facts: {}, source: "Venue reads unavailable", options: [],
        });
        continue;
      }
      const exit = fact.exitLiquidity !== null && /^\d+$/u.test(fact.exitLiquidity) ? BigInt(fact.exitLiquidity) : null;
      const limited = (fact.utilization !== null && fact.utilization >= JOURNEY_LIMITS.suggestionMaxUtilization) || (exit !== null && exit < deposited);
      const liquidity = exit !== null ? `${symbolText(view(exit, decimals), symbol)} available now` : "exit liquidity not exposed";
      const utilization = fact.utilization !== null ? ` (${Math.round(fact.utilization * 100)}% utilized)` : "";
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: limited ? "warn" : "info", stopId: stop.id, legIds: [],
        title: limited ? `Withdrawals from ${venue.name} are limited right now` : `Withdraw from ${venue.name} any time while liquidity lasts`,
        detail: `${liquidity}${utilization}.`,
        certainty: "observed", facts: { ...(fact.exitLiquidity !== null ? { exitLiquidity: fact.exitLiquidity } : {}), ...(fact.utilization !== null ? { utilization: String(fact.utilization) } : {}) },
        source: `${venue.name} read at ${timeOf(fact.at)}`, options: [],
      });
      continue;
    }
    if (main.identity.kind === "liquid-staking") {
      const solana = CHAINS[stop.network].vm === "svm";
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
        title: `Leaving ${main.asset.symbol}`,
        detail: solana
          ? `Swap ${main.asset.symbol} back to SOL through Jupiter any time, or unstake it (about 2 days).`
          : `Swap ${main.asset.symbol} back to ETH through a listed DEX any time, or redeem it through its issuer (days, the withdrawal queue).`,
        certainty: "quoted", facts: {}, source: "Rule (liquid staking)", options: [],
      });
      continue;
    }
    if (origin && stop.network !== origin && stop.custody === "wallet") {
      const crossFees = walk.order.filter((candidate) => isCross(candidate)).reduce((total, candidate) => total + (candidate.feesUsd ?? 0), 0);
      const back = bringBackText(stop, origin);
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
        title: `Bringing it back to ${networkName(origin)}`,
        detail: `Bringing it back costs about ${usdText(crossFees > 0 ? cents(crossFees) : null)} today (this route's fee; quote to be sure).`,
        certainty: "estimated", facts: { routeFeeUsd: crossFees.toFixed(4) }, source: "This route's fee",
        options: back ? [option("bring-back", `Bring it back to ${networkName(origin)}`, "A separate new intent you review before signing.", { type: "plan-new", text: back })] : [],
      });
    }
  }
}

/* -------------------------------------------------------------- assembly */

function compareDrafts(walk: Walk, a: Draft, b: Draft): number {
  const stopIndex = (draft: Draft) => (draft.stopId ? walk.stops.findIndex((stop) => stop.id === draft.stopId) : -1);
  const left = [SEVERITY_RANK[a.severity], stopIndex(a) === -1 ? Number.MAX_SAFE_INTEGER : stopIndex(a), KIND_RANK.get(a.kind) ?? 99];
  const right = [SEVERITY_RANK[b.severity], stopIndex(b) === -1 ? Number.MAX_SAFE_INTEGER : stopIndex(b), KIND_RANK.get(b.kind) ?? 99];
  for (let index = 0; index < left.length; index += 1) {
    const diff = (left[index] as number) - (right[index] as number);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Severity order, folding and the one question per block / recommended act. */
function finishConsequences(walk: Walk, drafts: readonly Draft[]): JourneyConsequence[] {
  const unique = new Map<string, Draft>();
  for (const draft of drafts) if (!unique.has(draft.id)) unique.set(draft.id, draft);
  const sorted = [...unique.values()].sort((a, b) => compareDrafts(walk, a, b));
  let expanded = 0;
  let warnShown = false;
  return sorted.map((draft) => {
    let open = false;
    if (draft.severity === "block") open = true;
    else if (draft.severity === "act" && expanded < JOURNEY_LIMITS.maxExpanded) open = true;
    else if (draft.severity === "warn" && !warnShown && expanded < JOURNEY_LIMITS.maxExpanded) {
      open = true;
      warnShown = true;
    }
    if (open) expanded += 1;
    const recommended = draft.options.find((entry) => entry.recommended) ?? null;
    const asks = draft.severity === "block" || (draft.severity === "act" && recommended !== null);
    const { question, ...rest } = draft;
    const options = draft.severity === "block" && !draft.options.some((entry) => entry.action.type === "acknowledge")
      ? [...draft.options, OK_OPTION]
      : draft.options;
    return {
      ...rest,
      options,
      ...(asks ? { prompt: { question: question ?? draft.title, defaultOptionId: recommended?.id ?? null } } : {}),
      collapsed: !open,
    };
  });
}

function stageOf(graph: IntentGraph): JourneyStage {
  if (TERMINAL_INTENT_STATUSES.has(graph.status)) return "final";
  return graph.steps.some((step) => started(step) || step.status === "failed" || (step.references?.length ?? 0) > 0) ? "live" : "plan";
}

function nowOf(walk: Walk): Journey["now"] {
  const current = walk.stops.filter((stop) => stop.state === "current").map((stop) => stop.id);
  const flight = walk.order.find((step) => IN_FLIGHT_STATUSES.has(step.status));
  if (flight) return { stopIds: current, legId: flight.id, waitingFor: "settlement" };
  const failed = walk.order.find((step) => step.status === "failed");
  if (failed) return { stopIds: current, legId: failed.id, waitingFor: "decision" };
  const next = walk.order.find((step) => (step.status === "ready" || step.status === "awaiting_signature") && step.mode === "wallet") ??
    walk.order.find((step) => step.status === "pending" && step.mode === "wallet");
  if (next) return { stopIds: current, legId: next.id, waitingFor: "signature" };
  return { stopIds: current, legId: null, waitingFor: "nothing" };
}

/** "sha256:" over stops, holding amounts and consequence ids and severities. */
export function journeyDigest(journey: Omit<Journey, "digest">): string {
  const material = {
    spec: journey.spec,
    intentId: journey.intentId,
    stops: journey.stops.map((stop) => [
      stop.id,
      stop.network,
      stop.custody,
      stop.state,
      stop.holdings.map((entry) => [normalizedAsset(entry.asset.asset), entry.expected.amount, entry.atLeast.amount, entry.role]),
    ]),
    consequences: journey.consequences.map((consequence) => [consequence.id, consequence.severity]),
  };
  return `sha256:${sha256Hex(canonicalJson(material))}`;
}

/**
 * The journey of an intent: a pure, deterministic function of the graph,
 * the preview it was built from and the facts the engine read. Same
 * inputs give byte-identical JSON.
 */
export function buildJourney(graph: IntentGraph, preview: IntentPreview | null, facts: JourneyFacts, now: string | number | Date): Journey {
  const at = new Date(now);
  const time = at.getTime();
  const walk = walkGraph(graph, preview, facts);
  const stage = stageOf(graph);
  const drafts: Draft[] = [];
  const gasFired = ruleGasToContinue(walk, drafts);
  ruleGasToLeave(walk, drafts, gasFired);
  ruleAssetIdentity(walk, drafts);
  rulePriceExposure(walk, drafts);
  ruleVenueCapacity(walk, drafts);
  ruleRuleBook(walk, drafts, time);
  ruleIfStopped(walk, drafts);
  ruleRefundPath(walk, drafts);
  ruleAllowanceLeft(walk, drafts);
  ruleTimeWindow(walk, drafts, time, stage);
  const nowView = nowOf(walk);
  if (nowView.waitingFor !== "decision" && !graph.steps.some((step) => step.status === "failed")) ruleIdleFunds(walk, drafts);
  ruleExitPath(walk, drafts);
  const consequences = finishConsequences(walk, drafts);
  const stops: JourneyStop[] = walk.stops.map((stop, index) => ({
    id: stop.id,
    index,
    kind: stop.kind,
    network: stop.network,
    holder: stop.holder,
    custody: stop.custody,
    state: stop.state,
    holdings: stop.holdings,
    ...(stop.eta ? { eta: stop.eta } : {}),
    ...(stop.reachedAt ? { reachedAt: stop.reachedAt } : {}),
    ...(stop.evidence ? { evidence: stop.evidence } : {}),
    ...(stop.venue ? { venue: stop.venue } : {}),
  }));
  const journey: Omit<Journey, "digest"> = {
    spec: JOURNEY_SPEC,
    intentId: preview?.intentId ?? graph.id,
    computedAt: at.toISOString(),
    stage,
    basis: { intentUpdatedAt: graph.updatedAt, previewDigest: preview?.digest ?? null, reads: facts.reads, factsAt: facts.reads === "none" ? null : facts.at },
    stops,
    legs: legsOf(walk),
    now: nowView,
    consequences,
    blockers: consequences.filter((consequence) => consequence.severity === "block").map((consequence) => consequence.id),
  };
  return { ...journey, digest: journeyDigest(journey) };
}

/** Blocking consequences not answered in `answered` (consequence id → option id of that consequence). */
export function openBlockers(journey: Journey, answered: Readonly<Record<string, string>>): readonly JourneyConsequence[] {
  return journey.consequences.filter((consequence) => {
    if (consequence.severity !== "block") return false;
    const answer = answered[consequence.id];
    return answer === undefined || !consequence.options.some((entry) => entry.id === answer);
  });
}

/* ------------------------------------------------------ actions from graph */

function decimalOf(units: bigint, decimals: number): string {
  return fromBaseUnits(units, decimals);
}

function actionFor(graph: IntentGraph, step: IntentStep, amount: string, portionBps: number | null, anyVenue: boolean): IntentActionSpec | null {
  if (step.kind === "call" || step.kind === "action" || step.mode === "read") return null;
  const output = step.minimumOutput ?? step.expectedOutput;
  const recipient = step.recipient && !isOwnRequestAccount(graph, step.recipient) ? step.recipient : undefined;
  const destination = destinationOf(step);
  const params: Record<string, string | number | boolean> = {};
  if (portionBps !== null && portionBps !== 10_000) params.portionBps = portionBps;
  if (step.venue && !anyVenue) params.venue = step.venue;
  const withOutput = step.kind === "swap" || step.kind === "bridge" || step.kind === "stake" || step.kind === "unstake";
  return {
    kind: step.kind,
    network: step.network,
    ...(step.input ? { from: step.input.asset } : {}),
    ...(withOutput && output ? { to: output.asset } : {}),
    amount,
    ...(destination !== step.network ? { toNetwork: destination } : {}),
    ...(recipient ? { recipient } : {}),
    ...(!anyVenue ? { protocol: step.protocol } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/**
 * Structured actions equivalent to the graph (merged legs are one bridge with
 * `to`); null when a step cannot be expressed (call / action steps).
 */
export function actionsFromGraph(graph: IntentGraph, options: { readonly anyVenue?: boolean } = {}): IntentActionSpec[] | null {
  const actions: IntentActionSpec[] = [];
  for (const step of topologicalOrder(graph.steps)) {
    if (step.mode === "read") continue;
    const funded = fundingParent(graph, step) !== null;
    const portion = step.funding?.portionBps ?? 10_000;
    const amount = funded ? "max" : step.input ? decimalOf(BigInt(step.input.amount), step.input.decimals) : "max";
    const action = actionFor(graph, step, amount, funded ? portion : null, options.anyVenue === true);
    if (!action) return null;
    actions.push(action);
  }
  return actions.length > 0 ? actions : null;
}

function descendantsOf(graph: IntentGraph, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of graph.steps) {
      if (out.has(step.id)) continue;
      if (step.dependsOn.some((id) => out.has(id)) || (fundingParent(graph, step) && out.has(fundingParent(graph, step)!.id))) {
        out.add(step.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * The request that re-plans what is left from a stop (amount flow F5): the
 * first action spends the landed amount (or the observed credit) exactly,
 * later ones keep their `max` + `portionBps` shape; same accounts and
 * constraints (a passed deadline dropped), `metadata.continues` = the intent
 * id. Null when nothing is left, the stop is unknown, or a step cannot be
 * expressed (call / action).
 */
export function continuationRequest(graph: IntentGraph, stopId: string, options: { readonly anyVenue?: boolean; readonly now?: number } = {}): IntentRequest | null {
  const match = /^(start|transit|out):(.+)$/u.exec(stopId);
  if (!match) return null;
  const [, role, stepId] = match as unknown as [string, string, string];
  const anchor = graph.steps.find((step) => step.id === stepId);
  if (!anchor) return null;
  const order = topologicalOrder(graph.steps);
  const anyVenue = options.anyVenue === true;
  let roots: IntentStep[];
  let firstAmount: (step: IntentStep) => string | null;
  if (role === "out") {
    const landed = anchor.status === "settled" ? anchor.actualOutput : anchor.observedCredit ?? anchor.actualOutput;
    if (!landed) return null;
    roots = order.filter((step) => fundingParent(graph, step)?.id === anchor.id && !started(step) && step.status !== "settled");
    firstAmount = (step) => {
      if (!step.input || !sameAsset(step.input.asset, landed.asset)) return null;
      const units = BigInt(landed.amount);
      const flow = fundedFlow(graph, step, { expected: units, worst: units, certainty: "observed" });
      return flow.spends.worst > 0n ? decimalOf(flow.spends.worst, step.input.decimals) : null;
    };
  } else {
    if (started(anchor) && anchor.status !== "failed") return null;
    roots = [anchor];
    firstAmount = (step) => {
      if (!step.input) return null;
      if (fundingParent(graph, step)) return null;
      return decimalOf(BigInt(step.input.amount), step.input.decimals);
    };
  }
  if (roots.length === 0) return null;
  const remaining = descendantsOf(graph, new Set(roots.map((step) => step.id)));
  const actions: IntentActionSpec[] = [];
  for (const step of order) {
    if (!remaining.has(step.id) || step.mode === "read") continue;
    if (step.status === "settled" || started(step)) continue;
    const isRoot = roots.includes(step);
    let action: IntentActionSpec | null;
    if (isRoot) {
      const amount = firstAmount(step);
      if (amount === null) return null;
      action = actionFor(graph, step, amount, null, anyVenue);
    } else {
      action = actionFor(graph, step, "max", step.funding?.portionBps ?? 10_000, anyVenue);
    }
    if (!action) return null;
    actions.push(action);
  }
  if (actions.length === 0) return null;
  const { text: _text, actions: _actions, sourceNetwork: _source, constraints, metadata, clientReference: _reference, ...rest } = graph.request;
  void _text;
  void _actions;
  void _source;
  void _reference;
  const now = options.now ?? Date.now();
  const keptConstraints = constraints
    ? Object.fromEntries(Object.entries(constraints).filter(([key, value]) => !(key === "deadline" && typeof value === "number" && value * 1000 <= now)))
    : undefined;
  return {
    ...rest,
    actions,
    ...(keptConstraints && Object.keys(keptConstraints).length > 0 ? { constraints: keptConstraints } : {}),
    metadata: { ...(metadata ?? {}), continues: graph.id },
  };
}
