/**
 * The execution journal kept in local storage, keyed by plan fingerprint.
 */
import { getAddress } from "viem";
import type { ArcAppKitExecutionPlan } from "../../../../shared/types";
import type { ArcAppKitExecutionResult, JournalEntry } from "./plan";

const JOURNAL_PREFIX = "kletia:arc-app-kit:v1";

export function arcAppKitPlanFingerprint(plan: ArcAppKitExecutionPlan): string {
  if (plan.operation === "swap") {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.tokenIn,
      plan.tokenOut,
      plan.amount,
      plan.slippageBps,
      plan.minimumOutput || "",
    ]);
  }
  if (plan.operation === "send") {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.token,
      plan.amount,
      getAddress(plan.recipient),
    ]);
  }
  return JSON.stringify([
    plan.version,
    plan.environment,
    plan.traceId,
    plan.sourceChain,
    plan.operation,
    plan.token,
    plan.amount,
    plan.destinationChain,
    getAddress(plan.recipient),
    plan.useForwarder,
    plan.transferSpeed,
    plan.maxFee || "",
  ]);
}

const journalKey = (
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): string => `${JOURNAL_PREFIX}:${plan.traceId}:${getAddress(expectedAddress)}`;

export function readJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): JournalEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(journalKey(plan, expectedAddress));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<JournalEntry>;
    if (
      entry.version !== 1 ||
      entry.fingerprint !== arcAppKitPlanFingerprint(plan) ||
      entry.expectedAddress !== getAddress(expectedAddress) ||
      typeof entry.statusMessage !== "string" ||
      typeof entry.updatedAt !== "string" ||
      !["started", "success", "pending", "recoverable", "blocked"].includes(
        String(entry.state),
      )
    ) {
      return {
        version: 1,
        fingerprint: arcAppKitPlanFingerprint(plan),
        expectedAddress: getAddress(expectedAddress),
        state: "blocked",
        consumed: true,
        statusMessage:
          "Local execution record for this trace ID does not match the plan. Resubmission blocked for security.",
        updatedAt: new Date().toISOString(),
      };
    }
    return entry as JournalEntry;
  } catch {
    return {
      version: 1,
      fingerprint: arcAppKitPlanFingerprint(plan),
      expectedAddress: getAddress(expectedAddress),
      state: "blocked",
      consumed: true,
      statusMessage:
        "Local execution log could not be read. Resubmission blocked to prevent potential double-spend risk.",
      updatedAt: new Date().toISOString(),
    };
  }
}

export function writeJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
  entry: Pick<JournalEntry, "state" | "consumed" | "statusMessage" | "txHash">,
): boolean {
  if (typeof window === "undefined") return false;
  const value: JournalEntry = {
    version: 1,
    fingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    state: entry.state,
    consumed: entry.consumed,
    statusMessage: entry.statusMessage,
    updatedAt: new Date().toISOString(),
    ...(entry.txHash ? { txHash: entry.txHash } : {}),
  };
  try {
    window.localStorage.setItem(
      journalKey(plan, expectedAddress),
      JSON.stringify(value),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearJournal(plan: ArcAppKitExecutionPlan, expectedAddress: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(journalKey(plan, expectedAddress));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // journal is a safety aid; failure to delete it must not crash rendering.
  }
}

export function getArcAppKitJournalState(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): {
  state: ArcAppKitExecutionResult["state"];
  statusMessage: string;
  txHash?: string;
} | null {
  const entry = readJournal(plan, expectedAddress);
  if (!entry) return null;
  return {
    state: entry.state === "started" ? "blocked" : entry.state,
    statusMessage:
      entry.state === "started"
        ? "Previous App Kit attempt was interrupted during signature/broadcast phase. The same intent cannot be resubmitted without chain state verification."
        : entry.statusMessage,
    txHash: entry.txHash,
  };
}
