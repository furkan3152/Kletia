/**
 * Rule Book outcomes for the web app's intent views: the plan-time hold of
 * an intent and refusals or holds from API errors, with approval links that
 * are https (or rebuilt on this page's own origin in local development).
 */
import type { IntentGraph } from "@kletia/core";
import { policyHold, policyOutcome, type PolicyErrorLike, type PolicyOutcomeView } from "@kletia/widget/review";

/** This page's origin, for approval links when the API's URL is not https (local development). */
function pageOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

/** The Rule Book hold of a planned intent (`intent.policy.outcome === "confirm"`), or null. */
export function holdOf(intent: Pick<IntentGraph, "policy"> | null | undefined): PolicyOutcomeView | null {
  return policyHold(intent, { fallbackOrigin: pageOrigin() });
}

/** A Rule Book refusal or hold from an API error, or null for other errors. */
export function outcomeOf(error: PolicyErrorLike | null | undefined): PolicyOutcomeView | null {
  return policyOutcome(error, { fallbackOrigin: pageOrigin() });
}
