/**
 * Clarify copy: question and assumption shapes, length limits, and the
 * reason templates an assumed slot keeps as a code (`why.code`). Reasons are
 * always rendered here from the code and the current facts, never echoed
 * from a client-held thread. English, no emoji, no em dashes.
 */
import { CLARIFY_LIMITS, type AssumptionSource, type ClarifyQuestionKind, type ClarifyReason } from "@kletia/core";
import type { Assumption, Option, OptionValue, Question } from "./types.js";

/** Cuts text to `max` characters on a word boundary, ending with "…" when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, "")}…`;
}

export const qid = (path: string) => `q.${path.replace(/\[(\d+)\]/gu, ".$1")}`;
export const aid = (path: string) => `a.${path.replace(/\[(\d+)\]/gu, ".$1")}`;
export const short = (address: string) => (address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

export function question(path: string, kind: ClarifyQuestionKind, reason: ClarifyReason, prompt: string, why: string, options: Option[], allowsText: boolean, placeholder?: string): Question {
  return {
    id: qid(path),
    field: path,
    kind,
    reason,
    prompt: clip(prompt, CLARIFY_LIMITS.prompt),
    why: clip(why, CLARIFY_LIMITS.why),
    options: options.slice(0, CLARIFY_LIMITS.optionsPerQuestion),
    allowsText,
    ...(placeholder ? { placeholder } : {}),
  };
}

export function assumption(path: string, label: string, value: OptionValue, source: AssumptionSource, reason: string, alternatives: Option[], material: boolean): Assumption {
  return {
    id: aid(path),
    field: path,
    label: clip(label, CLARIFY_LIMITS.optionLabel),
    value,
    source,
    reason: clip(reason, CLARIFY_LIMITS.why),
    alternatives: alternatives.slice(0, CLARIFY_LIMITS.alternativesPerAssumption),
    material,
  };
}

export interface ReasonParams {
  readonly symbol?: string;
  readonly network?: string;
  readonly recipient?: string;
  readonly protocol?: string;
  readonly kind?: string;
  readonly departure?: string;
  readonly targets?: string;
  readonly holder?: string;
  readonly held?: string;
}

/** Reason codes an assumed slot keeps (`why.code`). */
export type ReasonCode =
  | "balance.only"
  | "balance.largest"
  | "balance.short"
  | "default.network"
  | "default.kletia"
  | "default.provider"
  | "context.kept"
  | "position.only"
  | "position.found"
  | "venue.rate"
  | "departure.fixed"
  | "departure.auto"
  // the goal solver's codes (intent engine v2 §4.4; solver/explain.ts SOLVER_CODES)
  | "solver.source"
  | "solver.venue-apy"
  | "solver.bridge"
  | "solver.scope"
  | "solver.target-amount"
  | "price.usd";

const REASONS: Readonly<Record<ReasonCode, (p: ReasonParams) => string>> = {
  "balance.only": (p) => `The only network where you hold enough ${p.symbol ?? "of it"}.`,
  "balance.largest": (p) => `Your largest ${p.symbol ?? ""} balance.`.replace("  ", " "),
  "balance.short": (p) => `Your largest ${p.symbol ?? ""} balance (not enough for this amount).`.replace("  ", " "),
  "default.network": () => "Your default network.",
  "default.kletia": () => "Kletia's default network for this action.",
  "default.provider": (p) => `${p.protocol ?? "This provider"} is Kletia's default liquid staking provider for ${p.symbol ?? "it"}.`,
  "context.kept": () => "Kept from earlier in this task.",
  "position.only": (p) => `Your only ${p.protocol ?? ""} ${p.symbol ?? ""} position.`.replace(/\s+/gu, " "),
  "venue.rate": (p) => `${p.protocol ?? "This venue"} pays the best rate for its risk${p.kind ? ` (${p.kind})` : ""} among the venues Kletia lists here; rates are variable.`,
  "position.found": (p) => `The ${p.protocol ?? ""} ${p.symbol ?? ""} position Kletia found; positions on some networks could not be read.`.replace(/\s+/gu, " "),
  "departure.fixed": (p) => `Your departure is ${p.departure ?? "fixed"}, and this ${p.kind ?? "step"} runs on ${p.targets ?? "another network"}.`,
  "solver.source": (p) => `Kletia picked where the ${p.symbol ?? "money"} comes from${p.network ? ` (${p.network})` : ""}: the holding that covers it at the lowest cost.`,
  "solver.venue-apy": (p) => `${p.protocol ?? "This venue"} pays the best rate for its risk${p.kind ? ` (${p.kind})` : ""}; rates are variable.`,
  "solver.bridge": (p) => `A bridge${p.network ? ` to ${p.network}` : ""} is needed; the one with the best quote is picked at planning.`,
  "solver.scope": (p) => `Only your ${p.symbol ?? "holding"}${p.network ? ` on ${p.network}` : ""} is used; the rest stays where it is.`,
  "solver.target-amount": (p) => `The amount that delivers what you asked for${p.symbol ? ` in ${p.symbol}` : ""}, with fees and a 1% buffer.`,
  "price.usd": (p) => `A dollar amount converted to ${p.symbol ?? "the token"} at the current price; the signed amount is in ${p.symbol ?? "the token"}.`,
  "departure.auto": (p) => `${p.holder ?? "Another network"} holds ${p.held ?? "enough"} ${p.symbol ?? ""}; no network where this runs holds enough.`.replace("  ", " "),
};

export function isReasonCode(code: string): code is ReasonCode {
  return Object.hasOwn(REASONS, code);
}

/** The reason line of an assumed slot; transfers also remind where the recipient must receive. */
export function reasonText(code: ReasonCode, params: ReasonParams): string {
  const base = REASONS[code](params);
  return params.recipient && params.network ? `${base} Make sure ${params.recipient} receives on ${params.network}.` : base;
}

export function placeholderFor(kind: ClarifyQuestionKind, symbol?: string, solana = false): string | undefined {
  if (kind === "amount") return symbol ? `Amount in ${symbol}` : "Amount";
  if (kind === "address") return solana ? "Solana address or name.sns" : "0x… or name.eth";
  return undefined;
}

/**
 * Copy of the questions the protocol hooks add (protocols design 3.3, 3.6):
 * staking ETH on a network without staking, and a deposit that names no
 * venue. Prompts and why-lines only; the options come from the catalog
 * (`l2StakeOptions`, `rankedVenueOptions`).
 */
export const PROTOCOL_QUESTION_COPY = Object.freeze({
  l2Stake: (amount: string, network: string) => ({
    prompt: `Staking ETH runs on Ethereum. How should ${amount} on ${network} earn staking yield?`,
    why: `There is no staking contract on ${network}: Kletia can buy a liquid staking token there at market, or bridge to Ethereum and stake at the protocol rate.`,
  }),
  venueMissing: (amount: string, network: string) => ({
    prompt: `Where should ${amount} earn yield on ${network}?`,
    why: "Each venue has its own rate and risks; rates are variable.",
  }),
});
