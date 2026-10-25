/**
 * Pure helpers of useIntentExecution: status ranks, error mapping, event
 * folding, previews and remembered journey answers.
 */
import {
  KletiaApiError,
  KletiaExecutionError,
  type KletiaClient,
  type PrepareStepOptions,
} from "@kletia/sdk";
import type {
  AnyKletiaEvent,
  IntentGraph,
  IntentPreview,
  IntentStep,
  StepStatus,
} from "@kletia/core";
import type { JourneyAnswerMemory } from "@kletia/widget/review";
import {
  readSessionStorage,
  writeSessionStorage,
} from "../../state/safeStorage";
import { describePlatformError, toPlatformError } from "../kletiaClient";
import { readableRevert } from "../../wallet/revertReason";
import type {
  IntentExecutionError,
  IntentExecutionStatus,
  IntentRequestInput,
} from "./types";

export const TERMINAL_INTENT = new Set<IntentGraph["status"]>([
  "completed",
  "partially_completed",
  "failed",
  "expired",
  "cancelled",
]);

const STEP_RANK: Readonly<Record<StepStatus, number>> = {
  pending: 0,
  ready: 1,
  awaiting_signature: 2,
  submitted: 3,
  confirmed: 4,
  settling: 5,
  indeterminate: 5,
  settled: 6,
  failed: 6,
  skipped: 6,
};

export const MAX_STREAM_RECONNECTS = 3;
/** A stream that stayed open this long is considered healthy when it ends. */
export const STABLE_STREAM_MS = 60_000;

export function isIntentGraph(value: unknown): value is IntentGraph {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IntentGraph).id === "string" &&
    Array.isArray((value as IntentGraph).steps)
  );
}

export function terminalStatus(intent: IntentGraph): IntentExecutionStatus | null {
  if (intent.status === "completed") return "completed";
  if (intent.status === "cancelled") return "cancelled";
  if (TERMINAL_INTENT.has(intent.status)) return "failed";
  return null;
}

/** True once the API has accepted a reference for the step (or it moved past signing). */
export function stepWasSubmitted(step: IntentStep): boolean {
  return STEP_RANK[step.status] >= STEP_RANK.submitted || (step.references?.length ?? 0) > 0;
}

export function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function walletMessage(message: string): string {
  if (/user rejected|rejected the request|declined|denied|cancel/iu.test(message)) {
    return "The signature request was declined in your wallet. Nothing was sent for this step.";
  }
  if (/blockhash not found|block height exceeded|expired/iu.test(message)) {
    return "The prepared transaction expired before it was signed. Retry to prepare it again.";
  }
  return readableRevert(message);
}

/** References the SDK reports as broadcast but not yet recorded by Kletia (newer SDKs only). */
function unreportedReferences(error: KletiaExecutionError): readonly string[] {
  const references = (error as { references?: unknown }).references;
  return Array.isArray(references) ? references.filter((item): item is string => typeof item === "string") : [];
}

export function toExecutionError(error: unknown): IntentExecutionError {
  if (error instanceof KletiaExecutionError) {
    const cause = error.cause;
    const unreported = unreportedReferences(error).length;
    if (cause instanceof KletiaApiError) {
      const platform = toPlatformError(cause);
      if (unreported > 0) {
        const what = unreported === 1 ? "this step's transaction" : `${unreported} transactions for this step`;
        const it = unreported === 1 ? "it" : "them";
        const reason = describePlatformError(platform).replace(/\.$/u, "");
        return {
          code: platform.code,
          message: platform.retryable
            ? `Your wallet already sent ${what}, but Kletia could not record ${it} yet (${reason}). Retrying reports ${it} without signing again.`
            : `Your wallet already sent ${what}, but Kletia did not accept ${it}: ${describePlatformError(platform)} This step will not be signed again; check your wallet's activity.`,
          stepId: error.stepId,
          // Only a retryable API failure can still record the references.
          retryable: platform.retryable,
          platform,
        };
      }
      return {
        code: platform.code,
        message: describePlatformError(platform),
        stepId: error.stepId,
        retryable: true,
        platform,
      };
    }
    return {
      code: "EXECUTION_FAILED",
      message: walletMessage(error.message),
      stepId: error.stepId,
      retryable: true,
      platform: null,
    };
  }
  if (error instanceof KletiaApiError) {
    const platform = toPlatformError(error);
    return {
      code: platform.code,
      message: describePlatformError(platform),
      stepId: null,
      retryable: platform.retryable || platform.status === 409,
      platform,
      hints: error.hints,
      details: apiErrorDetails(error),
    };
  }
  const message = error instanceof Error && error.message ? error.message : "Execution failed.";
  return { code: "CLIENT_ERROR", message: walletMessage(message), stepId: null, retryable: true, platform: null };
}

/** `error.details` of an API error, when the SDK in use keeps it (newer SDKs do). */
function apiErrorDetails(error: KletiaApiError): Readonly<Record<string, unknown>> | null {
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Readonly<Record<string, unknown>>)
    : null;
}

export function localError(code: string, message: string, stepId: string | null = null): IntentExecutionError {
  return { code, message, stepId, retryable: true, platform: null };
}

export class LocalPlanError extends Error {
  readonly detail: IntentExecutionError;
  constructor(detail: IntentExecutionError) {
    super(detail.message);
    this.detail = detail;
  }
}

export function requestFromGraph(graph: IntentGraph): IntentRequestInput {
  const { request } = graph;
  return {
    ...(request.text ? { text: request.text } : {}),
    ...(request.actions ? { actions: request.actions } : {}),
    ...(request.defaultNetwork ? { defaultNetwork: request.defaultNetwork } : {}),
    ...(request.sourceNetwork ? { sourceNetwork: request.sourceNetwork } : {}),
    ...(request.constraints ? { constraints: request.constraints } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

/** Apply one stream event to the local graph. Step status only moves forward. */
export function applyEvent(intent: IntentGraph, event: AnyKletiaEvent): IntentGraph | null {
  if (event.type === "intent.step_updated") {
    const { data } = event;
    if (data.intentId !== intent.id) return null;
    let changed = false;
    const steps = intent.steps.map((step) => {
      if (step.id !== data.stepId) return step;
      const nextStatus = STEP_RANK[data.status] > STEP_RANK[step.status] ? data.status : step.status;
      const evidence = data.evidence;
      const hasEvidence =
        !evidence ||
        step.evidence.some(
          (item) =>
            item.kind === evidence.kind &&
            item.network === evidence.network &&
            item.reference === evidence.reference &&
            item.url === evidence.url,
        );
      if (nextStatus === step.status && hasEvidence) return step;
      changed = true;
      return {
        ...step,
        status: nextStatus,
        evidence: hasEvidence || !evidence ? step.evidence : [...step.evidence, evidence],
      };
    });
    return changed ? { ...intent, steps } : null;
  }
  if (event.type === "intent.status_changed") {
    const { data } = event;
    if (data.intentId !== intent.id || data.status === intent.status || TERMINAL_INTENT.has(intent.status)) {
      return null;
    }
    return { ...intent, status: data.status };
  }
  return null;
}

/**
 * The same client, but the intent returned by `prepareStep` (step now
 * awaiting a signature) is committed too; `executeIntent` only reports the
 * versions returned by submit and refresh.
 */
export function observeClient(client: KletiaClient, onIntent: (intent: IntentGraph) => void): KletiaClient {
  const observed = Object.create(client) as KletiaClient;
  Object.defineProperty(observed, "intents", {
    value: {
      ...client.intents,
      // Options (acknowledgedPreview, signal) must reach the API untouched.
      prepareStep: async (id: string, stepId: string, options?: PrepareStepOptions) => {
        const prepared = await client.intents.prepareStep(id, stepId, options);
        if (prepared?.intent && prepared.intent.id === id) onIntent(prepared.intent);
        return prepared;
      },
    },
  });
  return observed;
}

/**
 * A fresh fare for a stored intent (resuming after a reload): recomputed now,
 * else the last one Kletia kept; null when neither is available.
 */
export async function loadPreview(client: KletiaClient, intentId: string, signal: AbortSignal): Promise<IntentPreview | null> {
  try {
    return await client.intents.preview(intentId, { signal, maxRetries: 0 });
  } catch {
    // Rate limited or unavailable: the kept fare still has to be approved before signing.
  }
  try {
    return await client.intents.getPreview(intentId, { signal });
  } catch {
    return null;
  }
}

export function stepTitle(step: IntentStep): string {
  return `Step ${step.index + 1}: ${step.title}`;
}

export const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** sessionStorage key of one intent's journey answers. */
export function journeyAnswersKey(intentId: string): string {
  return `kletia-journey-answers:${intentId}`;
}

const ANSWER_ID = /^[\w:.@-]{1,160}$/u;

/** The answers kept for an intent in this tab; anything malformed is dropped. */
export function readJourneyMemory(intentId: string): Record<string, JourneyAnswerMemory> {
  const raw = readSessionStorage(journeyAnswersKey(intentId));
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, JourneyAnswerMemory> = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      const memory = entry as Partial<JourneyAnswerMemory> | null;
      if (!ANSWER_ID.test(id) || typeof memory?.option !== "string" || !ANSWER_ID.test(memory.option) || typeof memory.facts !== "string" || memory.facts.length > 2_000) continue;
      out[id] = { option: memory.option, facts: memory.facts };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeJourneyMemory(intentId: string, memory: Readonly<Record<string, JourneyAnswerMemory>>): void {
  writeSessionStorage(journeyAnswersKey(intentId), JSON.stringify(memory));
}
