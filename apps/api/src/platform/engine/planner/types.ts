/**
 * Shapes passed between the planner stages.
 */
import type {
  AssetAmount,
  IntentActionKind,
  IntentInterpretation,
  IntentStep,
  NetworkKey,
  ParsedAccountId,
  ProtocolId,
  YieldVenue,
  RoutePreference,
} from "@kletia/core";
import type {
  ContractPlannedStep,
  PlannedStep,
  ProtocolAdapter,
} from "../adapters/types.js";
import type { ResolvedAsset } from "../assets.js";
import type { AuctionResult, QuoteContact } from "../auction.js";
import type { DepartureBalanceReader } from "../departure.js";
import type { NameResolution } from "../names.js";
import { PlanBudget } from "../routing/caps.js";

/**
 * - `exact`: a decimal amount of the input.
 * - `previous`: a share of the previous step's output.
 * - `position`: a withdraw of the whole position at the venue ("withdraw all").
 */
export type AmountSpec =
  | { readonly type: "exact"; readonly value: string }
  | { readonly type: "previous"; readonly portionBps: number }
  | { readonly type: "position" }
  /** Call / action entries that spend nothing (e.g. claim). */
  | { readonly type: "none" };

/** An action after normalisation, before assets are resolved. */
export interface NormalizedAction {
  readonly index: number;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly destinationNetwork: NetworkKey;
  readonly amount: AmountSpec;
  readonly from?: string;
  readonly to?: string;
  readonly recipient?: string;
  readonly protocol?: ProtocolId;
  readonly provider?: string;
  /** Deposit / withdraw venue reference from `params.venue` (id, slug or address). */
  readonly venue?: string;
  /** Call / action: registration id or alias, entry id and the entry's parameter values. */
  readonly contract?: string;
  readonly entry?: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** A payment whose recipient receives exactly `amount`: the input is sized by inverse quoting. */
  readonly receiveExact?: true;
  /** The venue this leg is planned with (a composed shape's pre-screen winner); not a named venue. */
  readonly pin?: ProtocolId;
  /** A crossing leg the planner inserted between dependent steps on different networks. */
  readonly inserted?: true;
}

export interface PlanOptions {
  readonly now?: number;
  readonly id?: string;
  /**
   * API key id the intent is created with: registrations this key may use
   * can be called (structured `call` / `action` actions and their aliases in
   * text). Intents without a key can never contain call / action steps.
   */
  readonly ownerKeyId?: string;
  /**
   * The key whose registrations the plan may call instead of the owner's: a
   * session minted from a project flow is owned by the publishable key and
   * calls the registrations of the key that saved the flow. Default:
   * `ownerKeyId`.
   */
  readonly contractAuthorityKeyId?: string;
  /**
   * Intent lifetime (default INTENT_TTL_MS): intents held for Rule Book
   * approval live longer so a human has time. Still capped by
   * `constraints.deadline`.
   */
  readonly ttlMs?: number;
  /**
   * Interpretation extras from the clarify layer (assumptions, thread,
   * departure), merged into `graph.interpretation`. When it carries a
   * `departure`, clarify already applied it: the request's `sourceNetwork`
   * is then ignored, so a departure is never applied twice.
   */
  readonly interpretation?: PlanInterpretation;
  /** Balance reader of the departure step (tests); default: holdings.ts. */
  readonly readBalance?: DepartureBalanceReader;
  /**
   * Called with each action's networks once the request is
   * understood and before any provider is quoted (the Rule Book's network
   * rules refuse here, so a provider failure never masks a policy refusal).
   */
  readonly beforeQuote?: (legs: readonly { readonly network: NetworkKey; readonly destinationNetwork: NetworkKey }[]) => Promise<void>;
  /**
   * Fee sanity: refuse fees above 5 % of the value moved for a
   * text request without `maxFeeUsd` (FEE_LIMIT_EXCEEDED with details).
   * Default: on for text requests, off for clarify turns (a request
   * with `interpretation.thread`) until the decision layer turns the refusal
   * into a FEE_HIGH question; the decision layer passes `true` once it does.
   */
  readonly feeSanity?: boolean;
}

/** What the clarify layer adds to `graph.interpretation`. */
export type PlanInterpretation = Partial<Pick<IntentInterpretation, "departure" | "assumptions" | "thread" | "modelReading">>;

export interface PreviousStep {
  readonly step: IntentStep;
  /** Null after a call / action step that declares no output. */
  readonly output: ResolvedAsset | null;
  readonly network: NetworkKey;
  /** Account the previous step pays its output to. */
  readonly recipient: ParsedAccountId;
}

export interface ResolvedRecipient {
  readonly recipient: ParsedAccountId;
  /** Present when the recipient was given as a name. */
  readonly name?: NameResolution;
}

export interface VenueChoice {
  readonly venue: YieldVenue;
  readonly warnings: readonly string[];
}

type AnyPlannedStep = PlannedStep | ContractPlannedStep;

export interface CandidateSelection {
  readonly adapter: ProtocolAdapter;
  readonly planned: PlannedStep;
  /** Present when several venues competed (cross-network steps). */
  readonly auction?: AuctionResult;
}

export interface StepDraft {
  readonly action: NormalizedAction;
  readonly adapter: ProtocolAdapter;
  readonly planned: AnyPlannedStep;
  readonly account: ParsedAccountId;
  readonly recipient: ParsedAccountId;
  /** Name the recipient was resolved from. */
  readonly name?: NameResolution;
  readonly venue?: YieldVenue;
  readonly auction?: AuctionResult;
  /** Planner warnings for the step (venue defaults, auction notes). */
  readonly notes: readonly string[];
  /** Null for a call / action step without a declared output. */
  readonly output: ResolvedAsset | null;
  readonly funded: boolean;
  readonly portionBps?: number;
  readonly merged?: string;
  /** F6: gas-asset units kept back from what arrives (recorded as `funding.gasReserve`). */
  readonly gasReserve?: AssetAmount;
  /** Gas on arrival this leg delivers (USD asked; the venue's amount is `planned.gasTopup`). */
  readonly gasTopupUsd?: string;
}

/** How a draft is planned beyond the action itself (later actions, reserves already kept, gas on arrival). */
export interface DraftContext {
  /** Actions after this one (the F6 reserve covers the later steps on the same network). */
  readonly later: readonly NormalizedAction[];
  /** `${network}|${account}` pairs whose gas reserve an earlier step already keeps. */
  readonly reserved: ReadonlySet<string>;
  /** USD of destination gas this leg should deliver (constraints.gasOnArrival), when it is eligible. */
  readonly gasTopupUsd?: string;
  /** What the whole plan has used so far: auctions (caps) and providers contacted. */
  readonly trace?: PlanTrace;
}

/** Per-plan counters shared by every draft (failed merge attempts included). */
export interface PlanTrace {
  readonly budget: PlanBudget;
  readonly contacts: QuoteContact[];
}

/* ------------------------------------------- route options and crossings */

/** Route options of a request, read strictly. */
export interface RouteOptions {
  readonly routePreference?: RoutePreference;
  readonly routeShapes?: "auto" | "single";
  readonly allowCrossings: boolean;
}
