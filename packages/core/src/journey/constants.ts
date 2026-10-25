/**
 * Journey enumerations: stages, stop kinds and states, custody, roles,
 * value sources, consequence kinds and rules, option kinds.
 */
import { CERTAINTY_ORDER, type Certainty } from "../preview.js";

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
