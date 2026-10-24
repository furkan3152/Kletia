/**
 * Internal shapes of the clarify engine. The working state mirrors the
 * thread (`ClarifyThread`, @kletia/core) with mutable slots, plus a few
 * transient hints the parser gives the policy for one turn only (never
 * serialised: they would carry the user's own words).
 */
import type {
  AssumptionSource,
  ClosedClassHit,
  ConfirmAuthority,
  Goal,
  ClarifyQuestionKind,
  ClarifyReason,
  ClarifyStepKind,
  NetworkKey,
  PerpsPolicyView,
  PredictionPolicyView,
  ReadingSource,
  SlotProvenance,
  TextOrigin,
  ThreadAmount,
  ThreadCorrection,
  ThreadKeep,
  ThreadProvenance,
  ThreadReadAs,
  ThreadStatus,
  ThreadTurn,
} from "@kletia/core";
import type { ContractPhrase } from "../contracts/directory.js";
import type { Snapshot } from "../solver/snapshot.js";

export type Kind = ClarifyStepKind;

export interface Slot<T> {
  v: T;
  by: ThreadProvenance;
  /** Assumed slots only: a template code, so the chip and its reason stay the same on later turns. */
  why?: { source: AssumptionSource; code: string };
  /** The grounding ledger entry: span, rule, assumption, answered question or model reading. */
  prov?: SlotProvenance;
}

export interface WorkStep {
  kind?: Slot<Kind>;
  kindCandidates?: Kind[];
  amount?: Slot<ThreadAmount>;
  from?: Slot<string>;
  to?: Slot<string>;
  network?: Slot<NetworkKey>;
  toNetwork?: Slot<NetworkKey>;
  recipient?: Slot<string>;
  protocol?: Slot<string>;
  vault?: Slot<string>;
  provider?: Slot<string>;
  /** Bring-your-own-contract step: "<alias>#<verb>" in the registration's own words. */
  contract?: Slot<string>;
  usdFrom?: boolean;
  usdTo?: boolean;
  /** Transient (this turn only): the recipient word was a nickname ("my friend"). */
  nickname?: boolean;
  /** Transient (this turn only): the sentence was "buy X". */
  buy?: boolean;
  /** Transient (this turn only): the sentence was "sell X" (received in a dollar stablecoin unless named). */
  sell?: boolean;
  /** Transient (this turn only): the clause named the action but nothing it acts on ("swap some tokens"). */
  vague?: boolean;
  /** Transient (this turn only): "stake my SOL", "earn yield on my USDC": all of the holding when one network holds it. */
  possessive?: boolean;
  /** Pins of a goal step that are not part of its Goal (an amount answer, "all networks"); stored on its placeholder step. */
  goalPins?: { amount?: ThreadAmount; scope?: "all" };
  /**
   * Transient (this turn only): the Goal this step stands for. A goal step the
   * reader could not lower has only this (and `goalRead`); the solver expands
   * it into ordinary slots.
   */
  goal?: Goal;
  /** Transient (this turn only): how the Goal reader read the step (orderOnly: a role filled by word order alone, D12). */
  goalRead?: { lowered: boolean; orderOnly?: true; possessive?: true };
  /** Transient (this turn only): an unknown symbol within one edit of listed symbols ("SLO"), for ASSET_TYPO (D9). */
  assetTypo?: { field: "from" | "to"; raw: string; candidates: string[] };
  /** Where the money is now, as said ("from base", "my base usdc"): the crossing source. */
  fundFrom?: Slot<NetworkKey>;
  /** Amounts kept back ("keep 50", "keep 0.05 eth on base for gas"), subtracted before "the rest" and before a crossing. */
  keep?: ThreadKeep[];
  /** Read with model-assisted reading: always confirmed, lowered or not. */
  modelRead?: true;
  /** "Read as" items (units, fractions, arithmetic, corrections, "the same"): the confirm names each one. */
  readAs?: ThreadReadAs[];
  /** Asked as a question or with a polite opener: never ready without a confirm of the solved plan. */
  questionForm?: true;
  /** How the step was read: E exact, F order-only frame, C corrected or derived, M model proposal. */
  source?: ReadingSource;
  /** Transient (this turn only, never serialised: threads keep no words): reviewed fillers dropped, for the "Ignored" chip. */
  ignored?: string[];
  /** Transient (this turn only): the clause's closed-class record, so every later layer sees what it may not drop. */
  closedClass?: ClosedClassRecord;
}

/**
 * The closed-class scan of one clause, recorded before any word is dropped,
 * corrected or masked: the question mark, a question or polite opener, every
 * never-drop, unit and network hit with its span, and typed symbols of a
 * look-alike family that are not exactly a listed symbol. Internal: carries the
 * person's words and is never serialised.
 */
export interface ClosedClassRecord {
  readonly questionMark: boolean;
  readonly opener?: { readonly kind: "question" | "polite"; readonly phrase: string };
  readonly hits: readonly ClosedClassHit[];
  readonly lookalikes: readonly { readonly typed: string; readonly family: string; readonly start: number; readonly end: number }[];
}

/** A clause no deterministic layer could read, as handed to the reading hook. */
export interface UnreadClause {
  readonly index: number;
  readonly text: string;
  readonly closedClass: ClosedClassRecord;
}

/** Kletia's own rendering of the previous step, sent when an unread clause says "it" or "then" (never the person's words). */
export interface PreviousHint {
  readonly asset?: string;
  readonly network?: NetworkKey;
}

/**
 * The model-assisted reading hook, set by the HTTP layer only when
 * the server switch, the caller's eligibility and consent allow it. Every
 * result is a proposal: the decision layer validates it and the person
 * confirms the solved plan before anything is planned.
 */
export interface ReadingHook {
  /** Goals per clause index for the clauses it could read (absent: unchanged deterministic refusal). */
  readClauses(clauses: readonly UnreadClause[], hint: PreviousHint | null): Promise<ReadonlyMap<number, readonly Goal[]>>;
  /** Further readings of an order-only clause (T2): options added to its confirm, never a removed confirm. */
  crossCheck?(clause: UnreadClause, reading: readonly Goal[], hint: PreviousHint | null): Promise<readonly (readonly Goal[])[]>;
  /** A free-text answer mapped to one option id of the open question (T3), or null; shown as "Did you mean", never applied. */
  mapAnswer?(question: Question, text: string): Promise<string | null>;
}

/** A follow-up waiting for EDIT_TARGET_AMBIGUOUS (thread.pendingEdit). */
export type EditOp =
  | { op: "amount"; amount: ThreadAmount; unit?: string }
  | { op: "network"; dir: "from" | "to" | "on" | "use"; network: NetworkKey }
  | { op: "recipient"; recipient: string }
  | { op: "asset"; symbol: string }
  | { op: "provider"; provider: string }
  | { op: "bridgeVenue"; protocol: string }
  | { op: "lending"; protocol: string }
  | { op: "dex"; protocol: string };

export interface WorkState {
  id: string;
  rev: number;
  status: ThreadStatus;
  steps: WorkStep[];
  open: string[];
  pendingEdit?: EditOp;
  corrections: ThreadCorrection[];
  turns: ThreadTurn[];
  undo: WorkStep[][];
  /** Digest of the end state the person confirmed ("sha256:<hex>"): a plan with another end state is confirmed again. */
  confirmDigest?: string;
  /** How the first message reached Kletia (session consent covers typed text only). */
  textOrigin?: TextOrigin;
}

/** What choosing an option does (internal; the public option carries only id, label, detail, network, sentence). */
export interface OptionValue {
  network?: NetworkKey;
  source?: NetworkKey;
  asset?: string;
  amount?: ThreadAmount;
  recipient?: string;
  protocol?: string;
  venue?: string;
  provider?: string;
  kind?: Kind;
  target?: string;
}

export interface Option {
  id: string;
  label: string;
  detail?: string;
  value: OptionValue;
  recommended?: true;
}

export interface Question {
  id: string;
  field: string;
  kind: ClarifyQuestionKind;
  reason: ClarifyReason;
  prompt: string;
  why: string;
  options: Option[];
  allowsText: boolean;
  placeholder?: string;
}

export interface Assumption {
  id: string;
  field: string;
  label: string;
  value: OptionValue;
  source: AssumptionSource;
  reason: string;
  alternatives: Option[];
  material: boolean;
}

/** One resolved step, in the grammar's terms (render.ts writes it as a sentence). */
export interface ResolvedAction {
  kind: Kind;
  network: NetworkKey;
  toNetwork?: NetworkKey;
  from: string;
  to?: string;
  /** Decimal string, or "max" (all of the previous output / the whole position). */
  amount: string;
  portionBps?: number;
  recipient?: string;
  protocol?: string;
  vault?: string;
  provider?: string;
  /** Contract steps: the registration and entry the alias resolved to, and the words it was said in. */
  contract?: string;
  entry?: string;
  alias?: string;
  verb?: string;
  /** True when the user typed this step's network (departure rules: "the sentence wins"). */
  explicit?: boolean;
}

/** A USD price with its source and reading time (Unix ms). */
export interface UsdPrice {
  readonly usd: number;
  readonly source: string;
  readonly at: number;
}

/** Synchronous view of the wallet facts read for this turn (facts.ts). */
export interface FactsView {
  /** Decimal balance of the request's own account, or undefined when unknown (never "0" for unknown). */
  balance(network: NetworkKey, symbol: string): string | undefined;
  /**
   * A name's address on a network; null when it does not resolve (or was not
   * read); undefined when its records could not be read in time this turn
   * (the planner resolves it then, and fails closed if it cannot).
   */
  resolveName(name: string, network: NetworkKey): string | null | undefined;
  /** Supplied amount of a lending position; undefined when unknown (v1: positions are not read). */
  position(network: NetworkKey, protocol: string, symbol: string): string | undefined;
  /**
   * Every position held at one protocol on one network (positive amounts,
   * decimal), or undefined unless each of its venues there was read (unknown
   * is never "none").
   */
  positionsAt?(network: NetworkKey, protocol: string): readonly { readonly symbol: string; readonly amount: string }[] | undefined;
  /** The solver's snapshot for these goals, or undefined until read (goal steps; absent: goal steps cannot be solved). */
  goalSnapshot?(goals: readonly Goal[]): Snapshot | undefined;
  /** A token's USD price (D11), or undefined when unpriced or not read yet. */
  usdPrice?(network: NetworkKey, symbol: string): UsdPrice | undefined;
  /** A venue's supply APY (fraction), null when unknown, undefined until read. */
  venueApy?(venueId: string): number | null | undefined;
}

export interface TurnContext {
  readonly accounts: readonly string[];
  readonly defaultNetwork?: NetworkKey;
  readonly sourceNetwork?: NetworkKey | "auto";
  /** Contract phrases the caller's key may use (bring-your-own-contract clauses). */
  readonly contracts: readonly ContractPhrase[];
  /** Model-assisted reading: absent unless the server switch, eligibility and consent allow it. */
  readonly reader?: ReadingHook;
  /**
   * Who answers this turn, set by the HTTP layer: the first-party desk, a
   * caller holding the wallet-bound confirm token, or a plain API caller.
   * Absent counts as "api": a model-reading confirm then needs the person.
   */
  readonly confirmAuthority?: ConfirmAuthority;
  /** How this turn's text reached Kletia (absent: "prefilled"). */
  readonly textOrigin?: TextOrigin;
  /** Perps rights of the caller (the key's rule book chain), set by the HTTP layer; absent: the project defaults. */
  readonly perps?: PerpsPolicyView;
  /** Prediction-market rights of the caller, set by the HTTP layer; absent: the project defaults. */
  readonly predictions?: PredictionPolicyView;
  /** Internal: a run's sentence read for an automation is never read as a hand-off itself. */
  readonly noHandoff?: true;
}

export type TurnInput =
  | { readonly text: string }
  | { readonly answer: { readonly question: string; readonly option?: string; readonly text?: string } }
  | { readonly assumption: { readonly id: string; readonly option: string } }
  | { readonly none: true };

export type TurnKindName = "message" | "answer" | "edit" | "append" | "replace" | "control" | "none";

export interface Analysis {
  questions: Question[];
  assumptions: Assumption[];
  resolved: ResolvedAction[] | null;
  /**
   * Where each action index comes from when the thread has goal steps (they
   * expand into several actions): question and chip fields are on action
   * indices. Absent: action index = step index.
   */
  layout?: { readonly step: number; readonly part: number; readonly goal: boolean }[];
  /** Goal steps wait for this turn's snapshot (the caller reads it and runs again). */
  pending?: boolean;
}
