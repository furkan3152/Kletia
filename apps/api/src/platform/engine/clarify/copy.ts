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
  | "departure.fixed"
  | "departure.auto";

const REASONS: Readonly<Record<ReasonCode, (p: ReasonParams) => string>> = {
  "balance.only": (p) => `The only network where you hold enough ${p.symbol ?? "of it"}.`,
  "balance.largest": (p) => `Your largest ${p.symbol ?? ""} balance.`.replace("  ", " "),
  "balance.short": (p) => `Your largest ${p.symbol ?? ""} balance (not enough for this amount).`.replace("  ", " "),
  "default.network": () => "Your default network.",
  "default.kletia": () => "Kletia's default network for this action.",
  "default.provider": (p) => `${p.protocol ?? "This provider"} is Kletia's default liquid staking provider for ${p.symbol ?? "it"}.`,
  "context.kept": () => "Kept from earlier in this task.",
  "position.only": (p) => `Your only ${p.protocol ?? ""} ${p.symbol ?? ""} position.`.replace(/\s+/gu, " "),
  "departure.fixed": (p) => `Your departure is ${p.departure ?? "fixed"}, and this ${p.kind ?? "step"} runs on ${p.targets ?? "another network"}.`,
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
