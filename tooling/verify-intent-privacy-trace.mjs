import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createIntentPrivacyTrace } from "../apps/api/dist/shared/privacy/intentPrivacyTrace.js";

const request = {
  requestId: "5c36ee9b-bc11-4f20-8e88-5db735a86543",
  network: "base",
  chainId: 8453,
  prompt:
    "Send 12.5 USDC to 0x1111111111111111111111111111111111111111",
  stage: "planned",
  semanticPlanner: "deterministic_only",
  intent: { action: "transfer" },
  clarificationStored: false,
};

function recompute(trace) {
  const { traceSha256: _ignored, ...payload } = trace;
  return `0x${createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")}`;
}

const deterministic = createIntentPrivacyTrace({
  ...request,
  semanticProviderRequestAttempted: false,
  semanticModelInfluencedPlan: false,
});
assert.equal(
  deterministic.semantic.promptDisclosureToModelProviderOccurred,
  false,
);
assert.equal(deterministic.semantic.modelInfluencedCurrentPlan, false);
assert.equal(deterministic.disclosureDiff.length, 1);
assert.equal(deterministic.traceSha256, recompute(deterministic));

const rejectedProviderRequest = createIntentPrivacyTrace({
  ...request,
  stage: "rejected",
  semanticPlanner: "ai_assisted",
  semanticProviderRequestAttempted: true,
  semanticModelInfluencedPlan: false,
});
assert.equal(
  rejectedProviderRequest.semantic.promptDisclosureToModelProviderOccurred,
  true,
  "A failed provider response does not undo prompt disclosure",
);
assert.equal(
  rejectedProviderRequest.semantic.modelInfluencedCurrentPlan,
  false,
);
assert.equal(rejectedProviderRequest.disclosureDiff.length, 2);

const priorConsentContext = createIntentPrivacyTrace({
  ...request,
  semanticProviderRequestAttempted: false,
  semanticModelInfluencedPlan: true,
  clarificationStored: true,
});
assert.equal(
  priorConsentContext.semantic.promptDisclosureToModelProviderOccurred,
  false,
  "A prior consent must not be reported as a new provider request",
);
assert.equal(priorConsentContext.semantic.modelInfluencedCurrentPlan, true);
assert.equal(priorConsentContext.disclosureDiff.length, 1);

const withContext = createIntentPrivacyTrace({
  ...request,
  semanticPlanner: "ai_assisted",
  semanticProviderRequestAttempted: true,
  semanticModelInfluencedPlan: true,
  semanticContextTurns: 2,
});
assert.deepEqual(
  withContext.disclosureDiff.map((entry) => entry.field),
  ["natural_language_prompt", "natural_language_prompt", "conversation_context"],
  "Earlier turns sent to the model provider are disclosed as conversation context",
);
assert.ok(
  withContext.limitations.some((line) => line.includes("zero-data-retention")),
  "A provider request names the provider routing it ran under",
);
assert.equal(
  createIntentPrivacyTrace({ ...request, semanticProviderRequestAttempted: false, semanticModelInfluencedPlan: false, semanticContextTurns: 4 }).disclosureDiff.length,
  1,
  "Without a provider request no context was disclosed",
);
assert.ok(
  deterministic.limitations.some((line) => line.includes("POST /v1/intents") && line.includes("24 hours")),
  "The legacy trace says it does not describe Platform API v1, which stores intents",
);

const serialized = JSON.stringify(deterministic);
assert.equal(serialized.includes("12.5"), false);
assert.equal(
  serialized.includes("0x1111111111111111111111111111111111111111"),
  false,
);

console.log(
  "Intent privacy trace verified: current-request disclosure, conversation context, prior consent context, scope, hash binding and value omission.",
);
