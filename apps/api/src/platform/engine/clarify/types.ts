/**
 * Internal shapes of the clarify engine. The working state mirrors the
 * thread (`ClarifyThread`, @kletia/core) with mutable slots, plus a few
 * transient hints the parser gives the policy for one turn only (never
 * serialised: they would carry the user's own words).
 */
import type {
  AssumptionSource,
  Goal,
  ClarifyQuestionKind,
  ClarifyReason,
  ClarifyStepKind,
  NetworkKey,
  ThreadAmount,
  ThreadCorrection,
  ThreadProvenance,
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
  /** A name's address on a network; null when it cannot be resolved (or the read failed). */
  resolveName(name: string, network: NetworkKey): string | null;
  /** Supplied amount of a lending position; undefined when unknown (v1: positions are not read). */
  position(network: NetworkKey, protocol: string, symbol: string): string | undefined;
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
