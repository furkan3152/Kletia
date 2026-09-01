import type { NetworkMode } from "../config/networks";

export interface IntentPrivacyTraceV1 {
  readonly schemaVersion: "kletia_intent_privacy_trace_v1";
  readonly traceSha256: `0x${string}`;
  readonly binding: {
    readonly requestId: string;
    readonly network: NetworkMode;
    readonly chainId: number;
  };
  readonly stage:
    | "semantic_consent"
    | "clarification"
    | "planned"
    | "rejected";
  readonly policy: "privacy_first_minimum_disclosure";
  readonly semantic: {
    readonly requestedMode: "deterministic_only" | "ai_assisted";
    readonly modelRequestAttemptedForThisRequest: boolean;
    readonly modelInfluencedCurrentPlan: boolean;
    readonly promptDisclosureToModelProviderOccurred: boolean;
    readonly deterministicTransactionCompilerRequired: true;
  };
  readonly inputBoundary: {
    readonly rawPromptReceivedByKletiaApi: true;
    readonly rawPromptWrittenToApplicationLogs: false;
    readonly durablePromptPersistence: false;
    readonly ephemeralConversationMemory:
      | "none"
      | "clarification_only_with_ttl";
    readonly detectedFieldClasses: readonly (
      | "numeric_value"
      | "evm_address"
      | "stellar_address"
      | "url"
      | "portfolio_scope"
    )[];
  };
  readonly executionBoundary: {
    readonly actionClass:
      | "unknown"
      | "read_only"
      | "financial_public_if_executed";
    readonly ledgerVisibility:
      | "none"
      | "public_queries"
      | "route_specific_public_settlement";
    readonly perStepWalletApprovalRequired: true;
    readonly aiCanSignOrConstructCalldata: false;
  };
  readonly disclosureDiff: readonly {
    readonly phase: "planning";
    readonly field: "natural_language_prompt";
    readonly newlyVisibleTo: "kletia_api" | "semantic_model_provider";
    readonly reason: string;
  }[];
  readonly limitations: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isIntentPrivacyTrace(
  value: unknown,
  binding: { readonly requestId: string; readonly network: NetworkMode; readonly chainId: number },
): value is IntentPrivacyTraceV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "traceSha256",
    "binding",
    "stage",
    "policy",
    "semantic",
    "inputBoundary",
    "executionBoundary",
    "disclosureDiff",
    "limitations",
  ])) return false;
  if (
    value.schemaVersion !== "kletia_intent_privacy_trace_v1" ||
    value.policy !== "privacy_first_minimum_disclosure" ||
    typeof value.traceSha256 !== "string" ||
    !/^0x[a-f\d]{64}$/u.test(value.traceSha256) ||
    !["semantic_consent", "clarification", "planned", "rejected"].includes(String(value.stage)) ||
    !isRecord(value.binding) ||
    value.binding.requestId !== binding.requestId ||
    value.binding.network !== binding.network ||
    value.binding.chainId !== binding.chainId
  ) return false;

  const semantic = value.semantic;
  if (
    !isRecord(semantic) ||
    !exactKeys(semantic, [
      "requestedMode",
      "modelRequestAttemptedForThisRequest",
      "modelInfluencedCurrentPlan",
      "promptDisclosureToModelProviderOccurred",
      "deterministicTransactionCompilerRequired",
    ]) ||
    !["deterministic_only", "ai_assisted"].includes(String(semantic.requestedMode)) ||
    typeof semantic.modelRequestAttemptedForThisRequest !== "boolean" ||
    typeof semantic.modelInfluencedCurrentPlan !== "boolean" ||
    typeof semantic.promptDisclosureToModelProviderOccurred !== "boolean" ||
    semantic.promptDisclosureToModelProviderOccurred !==
      semantic.modelRequestAttemptedForThisRequest ||
    semantic.deterministicTransactionCompilerRequired !== true
  ) return false;

  const input = value.inputBoundary;
  const fieldClasses = new Set([
    "numeric_value",
    "evm_address",
    "stellar_address",
    "url",
    "portfolio_scope",
  ]);
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "rawPromptReceivedByKletiaApi",
      "rawPromptWrittenToApplicationLogs",
      "durablePromptPersistence",
      "ephemeralConversationMemory",
      "detectedFieldClasses",
    ]) ||
    input.rawPromptReceivedByKletiaApi !== true ||
    input.rawPromptWrittenToApplicationLogs !== false ||
    input.durablePromptPersistence !== false ||
    !["none", "clarification_only_with_ttl"].includes(String(input.ephemeralConversationMemory)) ||
    !Array.isArray(input.detectedFieldClasses) ||
    !input.detectedFieldClasses.every((field) => fieldClasses.has(String(field)))
  ) return false;

  const execution = value.executionBoundary;
  if (
    !isRecord(execution) ||
    !exactKeys(execution, [
      "actionClass",
      "ledgerVisibility",
      "perStepWalletApprovalRequired",
      "aiCanSignOrConstructCalldata",
    ]) ||
    !["unknown", "read_only", "financial_public_if_executed"].includes(String(execution.actionClass)) ||
    !["none", "public_queries", "route_specific_public_settlement"].includes(String(execution.ledgerVisibility)) ||
    execution.perStepWalletApprovalRequired !== true ||
    execution.aiCanSignOrConstructCalldata !== false
  ) return false;

  if (
    !Array.isArray(value.disclosureDiff) ||
    value.disclosureDiff.length < 1 ||
    value.disclosureDiff.length > 2 ||
    !value.disclosureDiff.every((entry) =>
      isRecord(entry) &&
      exactKeys(entry, ["phase", "field", "newlyVisibleTo", "reason"]) &&
      entry.phase === "planning" &&
      entry.field === "natural_language_prompt" &&
      ["kletia_api", "semantic_model_provider"].includes(String(entry.newlyVisibleTo)) &&
      typeof entry.reason === "string" &&
      entry.reason.length > 0 &&
      entry.reason.length <= 300,
    ) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length < 1 ||
    value.limitations.length > 6 ||
    !value.limitations.every((item) => typeof item === "string" && item.length > 0 && item.length <= 400)
  ) return false;
  return true;
}
