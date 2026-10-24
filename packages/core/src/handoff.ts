/**
 * Hand-offs: a sentence the intent graph does not plan, read into the typed
 * input of the surface that runs it. "long ETH 5x with 100 USDC" opens the
 * Perps ticket, "sell 1 WETH at 4000 on base" the Orders form, "buy $50 of
 * ETH every Monday" an automation draft, "bet $20 on yes for <market>" the
 * Predict ticket. The reader validates the input with each surface's own
 * checks, asks for whatever is missing (never guesses leverage, side,
 * amount, price or period) and shows every assumption as a chip. Nothing is executed: the person confirms and signs on the
 * surface, which quotes and prepares again.
 */
import type { NetworkKey } from "./chains.js";
import type { ValidatedAutomationDraft } from "./automation.js";
import type { PerpsSide, PerpsVenueId } from "./perps.js";
import type { PredictionVenueId } from "./predictions.js";

export const HANDOFF_SURFACES = Object.freeze(["perps", "orders", "automations", "predictions"] as const);
export type HandoffSurface = (typeof HANDOFF_SURFACES)[number];

/** The perps request as the sentence gave it (`planPerpsIntent` input; POST /v1/perps/quote after the desk adds the account). */
export interface PerpsHandoffInput {
  readonly market: string;
  readonly side: PerpsSide;
  readonly action: "open" | "decrease" | "close";
  /** Position size (open) or size removed (decrease), USD decimal. */
  readonly sizeUsd?: string;
  /** USDC put up as collateral (open). */
  readonly collateral?: string;
  readonly leverage?: number;
  /** Named venue; absent: the scorer picks the cheapest eligible venue at quote time. */
  readonly venue?: PerpsVenueId;
  readonly network?: NetworkKey;
}

/** A native order as the sentence gave it (`planNativeOrder` input; POST /v1/orders/quote after the desk adds the owner). */
export interface OrderHandoffOrder {
  readonly kind: "limit" | "dca";
  readonly sell: string;
  readonly buy: string;
  readonly amount: string;
  readonly amountIn?: "sell" | "buy";
  readonly price?: string;
  readonly period?: "minute" | "hour" | "day" | "week" | "month";
  readonly count?: number;
  readonly network?: NetworkKey;
  /** Limit: ISO time after which the order stops filling. */
  readonly expiresAt?: string;
}

export type OrdersHandoffInput =
  | { readonly action: "create"; readonly order: OrderHandoffOrder; readonly protocol: string; readonly network: NetworkKey }
  | { readonly action: "cancel"; readonly orderId: string };

/** A validated automation draft (POST /v1/automations). Each run waits for the owner's signature. */
export interface AutomationsHandoffInput {
  readonly draft: ValidatedAutomationDraft;
}

/**
 * A prediction-market sentence. A question ("what are the odds of
 * X?") opens the market search; a buy names the market the person picked
 * from the search (never a guess); a sell opens the person's positions
 * matching the words, where they pick the shares.
 */
export type PredictionsHandoffInput =
  | { readonly action: "search"; readonly query: string }
  | {
      readonly action: "buy";
      readonly venue: PredictionVenueId;
      readonly marketId: string;
      /** The market's question as the venue lists it. */
      readonly market: string;
      readonly outcome: string;
      /** USD to spend, fees included. */
      readonly amountUsd: string;
    }
  | { readonly action: "sell"; readonly query: string; readonly outcome?: string; readonly shares?: string };

interface HandoffBase {
  /** One line in Kletia's words ("Long ETH 5x with 100 USDC"). */
  readonly summary: string;
  /**
   * `native`: the protocol runs it after one signature (native orders); `signature`: the person signs on the
   * surface (perps) or once per run (automations).
   */
  readonly execution: "native" | "signature";
}

export type IntentHandoff =
  | (HandoffBase & { readonly surface: "perps"; readonly input: PerpsHandoffInput })
  | (HandoffBase & { readonly surface: "orders"; readonly input: OrdersHandoffInput })
  | (HandoffBase & { readonly surface: "automations"; readonly input: AutomationsHandoffInput })
  | (HandoffBase & { readonly surface: "predictions"; readonly input: PredictionsHandoffInput });

/** The desk route each surface opens at, prefilled from the hand-off. */
export const HANDOFF_VIEWS: Readonly<Record<HandoffSurface, string>> = Object.freeze({
  perps: "/app/perps",
  orders: "/app/orders",
  automations: "/app/automations",
  predictions: "/app/predict",
});

/**
 * The hand-off a thread is building (engine-written, re-validated every
 * turn): the surface, the input read so far in the surface's own field names,
 * and for automations the sentence each run plans with the answers given to
 * its questions (replayed on every turn).
 */
export interface ThreadHandoff {
  readonly surface: HandoffSurface;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inner?: { readonly text: string; readonly answers: readonly { readonly question: string; readonly option?: string; readonly text?: string }[] };
}

export const HANDOFF_LIMITS = Object.freeze({
  /** Characters of a run's sentence kept in a thread. */
  innerText: 300,
  /** Answers to a run's sentence replayed per turn. */
  innerAnswers: 4,
  /** Nesting of the stored input (automation triggers are objects). */
  inputDepth: 3,
});

const KEY = /^[a-zA-Z]{1,24}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const printable = (value: string, max: number) => value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

function valueOk(value: unknown, depth: number): boolean {
  if (typeof value === "string") return printable(value, HANDOFF_LIMITS.innerText);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (depth >= HANDOFF_LIMITS.inputDepth) return false;
  if (Array.isArray(value)) return value.length <= 8 && value.every((entry) => valueOk(entry, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, entry]) => KEY.test(key) && valueOk(entry, depth + 1));
}

/** Shape of a thread's `handoff` (the engine checks the values against the surface every turn). */
export function handoffStateIssues(value: unknown, path: string): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (!isRecord(value) || Object.keys(value).some((key) => !["surface", "input", "inner"].includes(key))) {
    return [{ path, message: "A hand-off is { surface, input, inner? }." }];
  }
  if (!(HANDOFF_SURFACES as readonly unknown[]).includes(value.surface)) issues.push({ path: `${path}.surface`, message: `One of ${HANDOFF_SURFACES.join(", ")}.` });
  if (!isRecord(value.input) || !valueOk(value.input, 0)) issues.push({ path: `${path}.input`, message: "Plain fields of the surface's input." });
  const inner = value.inner;
  if (inner !== undefined) {
    const answers = isRecord(inner) ? inner.answers : undefined;
    const ok = isRecord(inner) && Object.keys(inner).every((key) => key === "text" || key === "answers") &&
      typeof inner.text === "string" && inner.text.trim().length > 0 && printable(inner.text, HANDOFF_LIMITS.innerText) &&
      Array.isArray(answers) && answers.length <= HANDOFF_LIMITS.innerAnswers &&
      answers.every((answer) => isRecord(answer) && Object.keys(answer).every((key) => ["question", "option", "text"].includes(key)) &&
        typeof answer.question === "string" && printable(answer.question, 96) &&
        (answer.option === undefined || (typeof answer.option === "string" && printable(answer.option, 128))) &&
        (answer.text === undefined || (typeof answer.text === "string" && printable(answer.text, 200))));
    if (!ok) issues.push({ path: `${path}.inner`, message: `{ text (at most ${HANDOFF_LIMITS.innerText} characters), answers (at most ${HANDOFF_LIMITS.innerAnswers}) }.` });
  }
  return issues;
}
