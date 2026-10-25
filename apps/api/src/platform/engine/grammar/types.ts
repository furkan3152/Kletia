/**
 * Grammar context, result, drafts, clause errors, the missing-source error
 * and network and protocol name lookups.
 */
import {
  getProtocol,
  resolveChain,
  type AccountId,
  type IntentActionKind,
  type IntentActionSpec,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import {
  PlatformError,
  unsupported,
  type PlatformIssue,
} from "../../errors.js";
import type { ContractPhrase } from "../contracts/directory.js";
import { GRAMMAR_EXAMPLES } from "./examples.js";

export interface GrammarContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accounts?: readonly AccountId[];
  /**
   * Phrases of the contract registrations the caller's API key may use: a
   * clause naming one of their aliases with one of their verbs becomes a
   * `call` / `action` step (tried before the built-in sentences).
   */
  readonly contracts?: readonly ContractPhrase[];
}

export interface GrammarResult {
  readonly actions: IntentActionSpec[];
  readonly normalizedText: string;
  readonly clauses: readonly string[];
  readonly confidence: number;
  /** Per action: true when its clause named the network or the source ("on base", "from base", a CAIP-10 recipient). */
  readonly explicitNetwork: readonly boolean[];
  /** Readings the user should know about (e.g. bare "spark" read as Spark Savings). */
  readonly warnings: readonly string[];
}

/**
 * A bridge clause without a source and nothing to infer it from. Same code
 * (INTENT_UNSUPPORTED), message, hints and issues as every other clause
 * refusal; the planner's departure step (`sourceNetwork: "auto"`) reads
 * `missing` to choose a funded source instead.
 */
export class MissingSourceError extends PlatformError {
  readonly missing: { readonly asset: string | null; readonly amount: string | null; readonly toNetwork: NetworkKey };

  constructor(message: string, issues: readonly PlatformIssue[], missing: MissingSourceError["missing"]) {
    super("INTENT_UNSUPPORTED", message, 422, issues, GRAMMAR_EXAMPLES);
    this.missing = missing;
  }
}

export type AmountPhrase =
  | { readonly type: "exact"; readonly value: string; readonly usd: boolean }
  /** `whole`: said as "all" / "max" / "everything" (a withdraw then closes the position). */
  | { readonly type: "previous"; readonly portionBps: number; readonly whole?: boolean };

export interface Draft {
  readonly clause: string;
  readonly kind: IntentActionKind;
  readonly amount: AmountPhrase;
  readonly from?: string;
  readonly to?: string;
  readonly network?: NetworkKey;
  readonly toNetwork?: NetworkKey;
  readonly recipient?: string;
  readonly lst?: string;
  /** Native SOL staking (stake account); `vote` is the validator the clause named. */
  readonly native?: { readonly vote?: string };
  readonly protocol?: ProtocolId;
  /** Vault slug named in the clause (Morpho, Spark Savings, Yearn, Kamino, Sky). */
  readonly venue?: string;
  /** A swap's Jupiter venue filter ("dexes:phoenix", "avoid:raydium"). */
  readonly provider?: string;
  /** True when the clause named its network or source. */
  readonly explicit: boolean;
  readonly warnings?: readonly string[];
}

export function resolveNetworkName(raw: string): NetworkKey | null {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  return resolveChain(value)?.key ?? resolveChain(value.replace(/ /gu, "-"))?.key ?? null;
}

export function clauseMessage(clause: string, message: string): string {
  return `${message} (in "${clause.slice(0, 120)}")`;
}

export function clauseError(clause: string, message: string): PlatformError {
  return unsupported(clauseMessage(clause, message), GRAMMAR_EXAMPLES, [{ path: "text", message }]);
}

export function protocolName(id: ProtocolId): string {
  return getProtocol(id)?.name ?? id;
}
