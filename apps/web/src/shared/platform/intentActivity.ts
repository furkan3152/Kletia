/**
 * Mirrors intent step progress into the shared activity feed and the
 * cross-feature bus: every step that is submitted, settles or fails becomes
 * an activity entry, and settled/failed steps invalidate the portfolio views
 * of the accounts they touched (the destination too, for cross-network steps).
 *
 * Idempotent per (intent, step, status): the executor, the event stream and a
 * resume can all report the same transition without duplicating anything.
 */
import {
  CHAINS,
  explorerTxUrl,
  formatAccountId,
  parseAccountId,
  type AccountId,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
} from "@kletia/core";

import { recordActivity, type ActivityStatus } from "../sync/activityStore";
import { emitPortfolioInvalidated } from "../sync/bus";
import { httpsUrl, isStepReference, sourceEvidence } from "./intentLinks";

const IN_FLIGHT = new Set<IntentStep["status"]>(["submitted", "confirmed", "settling", "indeterminate"]);

/** Last activity status recorded per `intentId:stepId` in this tab. */
const recorded = new Map<string, ActivityStatus>();

export function stepActivityId(intentId: string, stepId: string): string {
  return `intent:${intentId}:${stepId}`;
}

function stepReference(step: IntentStep): string | undefined {
  const references = step.references ?? [];
  const last = references[references.length - 1];
  if (isStepReference(last)) return last;
  const evidence = sourceEvidence(step);
  return isStepReference(evidence?.reference) ? evidence?.reference : undefined;
}

/** Account that receives a cross-network step's output on its destination network. */
function destinationAccount(intent: IntentGraph, step: IntentStep, destination: NetworkKey): AccountId | null {
  const recipient = step.recipient ? parseAccountId(step.recipient) : null;
  if (recipient && recipient.chain.key === destination) return recipient.id;
  const namespace = CHAINS[destination].namespace;
  for (const account of intent.request.accounts) {
    const parsed = parseAccountId(account);
    if (parsed && parsed.chain.namespace === namespace) {
      try {
        return formatAccountId(destination, parsed.address);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function invalidate(intent: IntentGraph, step: IntentStep, reason: string) {
  emitPortfolioInvalidated(step.account, step.network, reason);
  const destination = step.settlement?.destinationNetwork;
  if (destination && destination !== step.network && CHAINS[destination]) {
    const account = destinationAccount(intent, step, destination);
    if (account) emitPortfolioInvalidated(account, destination, reason);
  }
}

/**
 * Record activity for every step of `intent` whose status changed since the
 * last call (in this tab) and emit `portfolio.invalidated` for steps that
 * reached `settled` or `failed`. Never throws.
 */
export function syncIntentActivity(intent: IntentGraph): void {
  for (const step of intent.steps) {
    if (step.mode === "read") continue;
    let status: ActivityStatus | null = null;
    if (step.status === "settled") status = "confirmed";
    else if (step.status === "failed") status = "failed";
    else if (IN_FLIGHT.has(step.status) && stepReference(step)) status = "pending";
    if (!status) continue;
    const key = `${intent.id}:${step.id}`;
    if (recorded.get(key) === status) continue;
    recorded.set(key, status);
    try {
      const reference = stepReference(step);
      const url =
        httpsUrl(sourceEvidence(step)?.url) ??
        (reference ? explorerTxUrl(step.network, reference) : undefined);
      recordActivity({
        id: stepActivityId(intent.id, step.id),
        network: step.network,
        title: step.title,
        status,
        ...(reference ? { reference } : {}),
        ...(url ? { url } : {}),
      });
      if (status !== "pending") {
        invalidate(intent, step, `${step.title} ${status === "confirmed" ? "settled" : "failed"}`);
      }
    } catch {
      // Activity and refresh hints are conveniences; they never break execution.
    }
  }
}
