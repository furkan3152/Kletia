import type { NetworkMode } from "../config/networks";

export type IntentSemanticPlannerMode =
  | "deterministic_only"
  | "ai_assisted";

export interface IntentPrivacyDecisionOptionV1 {
  readonly id:
    | "allow_ai_for_this_intent"
    | "allow_ai_for_session"
    | "open_private_composer"
    | "edit_intent";
  readonly label: string;
  readonly description: string;
  readonly impact: string;
}

export interface IntentPrivacyDecisionV1 {
  readonly schemaVersion: "kletia_intent_decision_v1";
  readonly questionId: "semantic-planner-consent";
  readonly kind: "privacy";
  readonly blockingField: "semanticPlanner";
  readonly sensitivity: "public_semantics_may_include_private_values";
  readonly whyAsked: string;
  readonly question: string;
  readonly options: readonly IntentPrivacyDecisionOptionV1[];
  readonly network: NetworkMode;
  /** Opaque, short-lived server grant bound to this exact semantic disclosure. */
  readonly decisionToken: string;
  readonly sessionDecisionToken: string;
  readonly expiresAt: number;
  readonly sessionExpiresAt: number;
}

const FINANCIAL_ACTION =
  /\b(?:swap|buy|sell|send|transfer|bridge|lend|supply|borrow|repay|withdraw|stake|unstake|vault|liquidity|payment|pay|x402|takas|al|sat|gönder|gonder|köprü|kopru|borç|borc|yatır|yatir|çek|cek|öde|ode)\b/iu;

const EVM_ADDRESS = /0x[a-f\d]{40}/giu;
const STELLAR_ADDRESS = /\b[GC][A-Z2-7]{55}\b/gu;
const FINANCIAL_NUMBER =
  /(?<![\p{L}\p{N}_])\d+(?:[.,]\d+)?(?![\p{L}\p{N}_])/gu;
const MAX_OR_BALANCE =
  /\b(?:all|everything|max|my\s+(?:balance|holdings|portfolio)|tüm(?:ü|unu)?|hepsi|bakiyem(?:in|i)?)\b/giu;

export function isFinancialIntent(value: string): boolean {
  return FINANCIAL_ACTION.test(value.normalize("NFKC"));
}

/**
 * Produces the only prompt representation Kletia persists in chat history by
 * default. The exact prompt may still be sent to the deterministic Kletia API,
 * which is why the UI describes this as AI/history minimisation rather than
 * API invisibility.
 */
export function redactIntentForPersistentHistory(value: string): string {
  if (!isFinancialIntent(value)) return value.trim();
  return value
    .normalize("NFKC")
    .replace(EVM_ADDRESS, "[[private recipient]]")
    .replace(STELLAR_ADDRESS, "[[private recipient]]")
    .replace(FINANCIAL_NUMBER, "[[private amount]]")
    .replace(MAX_OR_BALANCE, "[[private balance rule]]")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function isDecisionOption(value: unknown): value is IntentPrivacyDecisionOptionV1 {
  if (!value || typeof value !== "object") return false;
  const option = value as Partial<IntentPrivacyDecisionOptionV1>;
  return (
    (option.id === "allow_ai_for_this_intent" ||
      option.id === "allow_ai_for_session" ||
      option.id === "open_private_composer" ||
      option.id === "edit_intent") &&
    typeof option.label === "string" &&
    option.label.length > 0 &&
    option.label.length <= 80 &&
    typeof option.description === "string" &&
    option.description.length > 0 &&
    option.description.length <= 500 &&
    typeof option.impact === "string" &&
    option.impact.length > 0 &&
    option.impact.length <= 500
  );
}

export function isIntentPrivacyDecision(
  value: unknown,
  expectedNetwork: NetworkMode,
): value is IntentPrivacyDecisionV1 {
  if (!value || typeof value !== "object") return false;
  const decision = value as Partial<IntentPrivacyDecisionV1>;
  return (
    decision.schemaVersion === "kletia_intent_decision_v1" &&
    decision.questionId === "semantic-planner-consent" &&
    decision.kind === "privacy" &&
    decision.blockingField === "semanticPlanner" &&
    decision.sensitivity === "public_semantics_may_include_private_values" &&
    decision.network === expectedNetwork &&
    typeof decision.decisionToken === "string" &&
    decision.decisionToken.length > 0 &&
    decision.decisionToken.length <= 4_096 &&
    typeof decision.sessionDecisionToken === "string" &&
    decision.sessionDecisionToken.length > 0 &&
    decision.sessionDecisionToken.length <= 4_096 &&
    typeof decision.expiresAt === "number" &&
    Number.isFinite(decision.expiresAt) &&
    decision.expiresAt > Date.now() &&
    typeof decision.sessionExpiresAt === "number" &&
    Number.isFinite(decision.sessionExpiresAt) &&
    decision.sessionExpiresAt > decision.expiresAt &&
    typeof decision.whyAsked === "string" &&
    decision.whyAsked.length > 0 &&
    decision.whyAsked.length <= 700 &&
    typeof decision.question === "string" &&
    decision.question.length > 0 &&
    decision.question.length <= 500 &&
    Array.isArray(decision.options) &&
    decision.options.length === 4 &&
    decision.options.every(isDecisionOption) &&
    new Set(decision.options.map((option) => option.id)).size === 4
  );
}
