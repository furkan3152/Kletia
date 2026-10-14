/**
 * The desk's dry run with its fare (`POST /v1/intents?dryRun=true&preview=true`,
 * console design 4.3 and 5.5). Plain fetch rather than the SDK client so a
 * refusal keeps everything the API said: `hints` (example phrases on
 * INTENT_UNSUPPORTED) and `details` (the candidate networks of
 * SOURCE_REQUIRED), which the SDK in this round drops.
 *
 * Nothing is persisted and nothing can be signed from a dry run. Pure apart
 * from the injected fetch: node --test drives it.
 */
import type { IntentGraph, IntentPreview, IntentRequest } from "@kletia/core";

/** A refused or failed plan, with what the desk needs to route it (taskModel `routePlanFailure`). */
export interface DeskPlanFailure {
  readonly code: string;
  readonly message: string;
  /** HTTP status; 0 when the API could not be reached. */
  readonly status: number;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
  readonly hints: readonly string[];
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
}

export type PlanPreviewResult =
  | { readonly ok: true; readonly intent: IntentGraph; readonly preview: IntentPreview | null }
  | { readonly ok: false; readonly failure: DeskPlanFailure };

const TIMEOUT_MS = 20_000;
const MAX_HINTS = 8;
const MAX_ISSUES = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntentGraph(value: unknown): value is IntentGraph {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.steps) && isRecord(value.summary);
}

/** The API's error envelope, bounded and typed; unknown shapes become a generic failure. */
export function failureFromBody(status: number, body: unknown, requestId: string | null): DeskPlanFailure {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const issues = Array.isArray(error.issues)
    ? error.issues.slice(0, MAX_ISSUES).flatMap((issue) =>
        isRecord(issue) && typeof issue.message === "string"
          ? [{ path: typeof issue.path === "string" ? issue.path : "", message: issue.message.slice(0, 400) }]
          : [],
      )
    : [];
  const hints = Array.isArray(error.hints)
    ? error.hints.filter((hint): hint is string => typeof hint === "string" && hint.length > 0 && hint.length <= 200).slice(0, MAX_HINTS)
    : [];
  return {
    code: typeof error.code === "string" ? error.code : `HTTP_${status}`,
    message: typeof error.message === "string" ? error.message.slice(0, 600) : `The Kletia API answered ${status}.`,
    status,
    issues,
    hints,
    details: isRecord(error.details) ? error.details : null,
    requestId,
    retryable: status === 429 || status >= 500,
  };
}

function unreachable(timedOut: boolean): DeskPlanFailure {
  return {
    code: timedOut ? "REQUEST_TIMEOUT" : "UNREACHABLE",
    message: timedOut ? "The Kletia API did not respond in time." : "The Kletia API is unreachable from this browser right now.",
    status: 0,
    issues: [],
    hints: [],
    details: null,
    requestId: null,
    retryable: true,
  };
}

/**
 * Plans `request` without persisting it and returns the plan with its fare,
 * or the API's refusal with its hints and details.
 */
export async function planPreview(
  origin: string,
  request: IntentRequest,
  { signal, fetchImpl = fetch }: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<PlanPreviewResult> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/v1/intents?dryRun=true&preview=true`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, failure: unreachable(timeout.aborted) };
  }
  const requestId = response.headers.get("x-request-id");
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, failure: failureFromBody(response.status, body, requestId) };
  if (!isRecord(body) || !isIntentGraph(body.intent)) {
    return { ok: false, failure: { ...failureFromBody(502, null, requestId), code: "INVALID_RESPONSE", message: "The Kletia API returned a plan this page cannot read." } };
  }
  const preview = isRecord(body.preview) && typeof body.preview.digest === "string" ? (body.preview as unknown as IntentPreview) : null;
  return { ok: true, intent: body.intent, preview };
}
