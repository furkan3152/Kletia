import type { NetworkId } from "../config/networks.js";
import {
  issueSemanticConsentToken,
  issueSemanticSessionConsentToken,
} from "./semanticConsent.js";

/**
 * Builds the `kletia_intent_decision_v1` privacy decision returned when the
 * deterministic parser cannot resolve a prompt and the semantic model would
 * have to see it. The caller decides; no prompt leaves the process here.
 */
export function privacyDecisionContract(input: {
  network: NetworkId;
  chainId: number;
  userAddress: string;
  prompt: string;
}) {
  const consent = issueSemanticConsentToken(input);
  const sessionConsent = issueSemanticSessionConsentToken(input);
  return {
    schemaVersion: "kletia_intent_decision_v1" as const,
    questionId: "semantic-planner-consent" as const,
    kind: "privacy" as const,
    blockingField: "semanticPlanner" as const,
    sensitivity: "public_semantics_may_include_private_values" as const,
    whyAsked:
      "This wording needs Kletia's semantic model. Transaction building and wallet approval remain deterministic.",
    question:
      "Turn on smart intent interpretation for this browser session?",
    options: [
      {
        id: "allow_ai_for_this_intent" as const,
        label: "Allow AI for this intent",
        description:
          "Allow semantic-model interpretation for this intent; transaction construction and signing remain deterministic and wallet-controlled.",
        impact:
          "The full prompt, unmasked (amounts, addresses and names included), and the earlier turns of this conversation go to a model provider through OpenRouter, without zero-data-retention routing.",
      },
      {
        id: "allow_ai_for_session" as const,
        label: "Turn on smart parsing",
        description:
          "Understand natural language for this wallet and network for up to 8 hours.",
        impact:
          "For up to 8 hours, every prompt the deterministic parser cannot read goes to the model provider the same way (unmasked, with the conversation so far) without asking again.",
      },
      {
        id: "edit_intent" as const,
        label: "Edit intent",
        description:
          "Rewrite the request with a supported explicit action, asset, network and constraints.",
        impact: "No semantic-model request is made.",
      },
    ],
    network: input.network,
    decisionToken: consent.token,
    sessionDecisionToken: sessionConsent.token,
    expiresAt: consent.expiresAt,
    sessionExpiresAt: sessionConsent.expiresAt,
  };
}
