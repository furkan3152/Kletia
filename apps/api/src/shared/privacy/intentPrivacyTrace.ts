import { createHash } from "node:crypto";

import type { NetworkId } from "../config/networks.js";
import type { IntentSemanticPlannerMode, ParsedIntent } from "../ai/parser.js";

export type IntentPrivacyTraceStage =
  | "semantic_consent"
  | "clarification"
  | "planned"
  | "rejected";

export interface IntentPrivacyTraceV1 {
  readonly schemaVersion: "kletia_intent_privacy_trace_v1";
  readonly traceSha256: `0x${string}`;
  readonly binding: {
    readonly requestId: string;
    readonly network: NetworkId;
    readonly chainId: number;
  };
  readonly stage: IntentPrivacyTraceStage;
  readonly policy: "privacy_first_minimum_disclosure";
  readonly semantic: {
    readonly requestedMode: IntentSemanticPlannerMode;
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

const READ_ONLY_ACTIONS = new Set([
  "allora_prediction",
  "borrow_capacity",
  "chat",
  "portfolio",
  "positions",
  "security_scan",
  "webacy_scan",
  "x402_discover",
  "yield_compare",
]);

function detectedFieldClasses(prompt: string): IntentPrivacyTraceV1["inputBoundary"]["detectedFieldClasses"] {
  const normalized = prompt.normalize("NFKC");
  const detected: Array<IntentPrivacyTraceV1["inputBoundary"]["detectedFieldClasses"][number]> = [];
  if (/\p{Number}/u.test(normalized)) detected.push("numeric_value");
  if (/0x[a-f\d]{40}/iu.test(normalized)) detected.push("evm_address");
  if (/[GC][A-Z2-7]{55}/u.test(normalized)) detected.push("stellar_address");
  if (/https:\/\/[^\s]+/iu.test(normalized)) detected.push("url");
  if (/\b(?:my|all|wallet|portfolio|balance|portf[oö]y|bakiye)\b/iu.test(normalized)) {
    detected.push("portfolio_scope");
  }
  return detected;
}

function executionClass(
  action: string | undefined,
): Pick<IntentPrivacyTraceV1["executionBoundary"], "actionClass" | "ledgerVisibility"> {
  const normalized = String(action ?? "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") {
    return { actionClass: "unknown", ledgerVisibility: "none" };
  }
  if (READ_ONLY_ACTIONS.has(normalized)) {
    return { actionClass: "read_only", ledgerVisibility: "public_queries" };
  }
  return {
    actionClass: "financial_public_if_executed",
    ledgerVisibility: "route_specific_public_settlement",
  };
}

function canonicalTracePayload(
  trace: Omit<IntentPrivacyTraceV1, "traceSha256">,
): string {
  // The construction order below is fixed and contains no user-provided object
  // keys, so JSON serialization is byte-stable across supported Node runtimes.
  return JSON.stringify(trace);
}

/**
 * Produces an honest diagnostic receipt for the legacy `/api/intent` surface.
 *
 * This is deliberately not called a privacy proof: the API receives the raw
 * legacy prompt. The trace makes that fact, any semantic-provider disclosure,
 * and public-ledger execution explicit so the privacy-first default applies to
 * Base and Arc as well as WorkflowPlanV2.
 */
export function createIntentPrivacyTrace(input: {
  readonly requestId: string;
  readonly network: NetworkId;
  readonly chainId: number;
  readonly prompt: string;
  readonly stage: IntentPrivacyTraceStage;
  readonly semanticPlanner: IntentSemanticPlannerMode;
  readonly semanticProviderRequestAttempted: boolean;
  readonly semanticModelInfluencedPlan: boolean;
  readonly intent?: Pick<ParsedIntent, "action">;
  readonly clarificationStored: boolean;
}): IntentPrivacyTraceV1 {
  const execution = executionClass(input.intent?.action);
  const withoutHash: Omit<IntentPrivacyTraceV1, "traceSha256"> = {
    schemaVersion: "kletia_intent_privacy_trace_v1",
    binding: {
      requestId: input.requestId,
      network: input.network,
      chainId: input.chainId,
    },
    stage: input.stage,
    policy: "privacy_first_minimum_disclosure",
    semantic: {
      requestedMode: input.semanticPlanner,
      modelRequestAttemptedForThisRequest:
        input.semanticProviderRequestAttempted,
      modelInfluencedCurrentPlan: input.semanticModelInfluencedPlan,
      promptDisclosureToModelProviderOccurred:
        input.semanticProviderRequestAttempted,
      deterministicTransactionCompilerRequired: true,
    },
    inputBoundary: {
      rawPromptReceivedByKletiaApi: true,
      rawPromptWrittenToApplicationLogs: false,
      durablePromptPersistence: false,
      ephemeralConversationMemory: input.clarificationStored
        ? "clarification_only_with_ttl"
        : "none",
      detectedFieldClasses: detectedFieldClasses(input.prompt),
    },
    executionBoundary: {
      ...execution,
      perStepWalletApprovalRequired: true,
      aiCanSignOrConstructCalldata: false,
    },
    disclosureDiff: [
      {
        phase: "planning",
        field: "natural_language_prompt",
        newlyVisibleTo: "kletia_api",
        reason:
          "The legacy intent endpoint requires the prompt to resolve network, asset and action constraints.",
      },
      ...(input.semanticProviderRequestAttempted
        ? ([
            {
              phase: "planning" as const,
              field: "natural_language_prompt" as const,
              newlyVisibleTo: "semantic_model_provider" as const,
              reason:
                "The deterministic parser stopped and the user explicitly authorized semantic-model interpretation for this intent.",
            },
          ] as const)
        : []),
    ],
    limitations: [
      "This diagnostic hash is recomputable but unsigned; it is not an anonymity proof or an onchain attestation.",
      "Legacy Base and Arc prompts are visible to the Kletia API even when the semantic model is disabled.",
      execution.actionClass === "financial_public_if_executed"
        ? "Amounts, recipients and timing become public according to the selected chain and protocol if the user signs execution."
        : "Read-only providers and public RPC endpoints may observe query metadata.",
    ],
  };
  return {
    ...withoutHash,
    traceSha256: `0x${createHash("sha256")
      .update(canonicalTracePayload(withoutHash), "utf8")
      .digest("hex")}`,
  };
}
