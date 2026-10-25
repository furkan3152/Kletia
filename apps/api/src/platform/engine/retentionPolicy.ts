/**
 * Retention policy of stored intents, pure (docs/platform/data-retention.md):
 * which stage a graph is in, and the graph without its request text. The
 * sweep and the delete route live in retention.ts; the stores use this file
 * to pick candidates.
 */
import { randomBytes } from "node:crypto";
import {
  base64UrlEncode,
  deriveIntentStatus,
  FINAL_INTENT_STATUSES,
  INTENT_RETENTION,
  planRecordDigest,
  requestTextDigest,
  requestTextLength,
  type IntentGraph,
  type IntentStatus,
  type StepStatus,
} from "@kletia/core";

export type RetentionStage = "keep" | "redact" | "purge";

/** Receipt disclosure groups that carry the request text (or its normalized copy). */
export type TextBearingGroup = "intent.request" | "intent.plan" | "intent.outcome";

const IN_FLIGHT: readonly StepStatus[] = ["submitted", "confirmed", "settling"];

export function inFlight(graph: IntentGraph): boolean {
  return graph.status !== "cancelled" && graph.steps.some((step) => IN_FLIGHT.includes(step.status));
}

function effectiveStatus(graph: IntentGraph, now: number): IntentStatus {
  return graph.status === "cancelled" ? "cancelled" : deriveIntentStatus(graph.steps, graph.expiresAt, now);
}

/** When the intent became final (ms), or null while it can still change. */
export function finalSince(graph: IntentGraph, now: number): number | null {
  const status = effectiveStatus(graph, now);
  if (!FINAL_INTENT_STATUSES.includes(status) || inFlight(graph)) return null;
  const at = status === "expired" ? Date.parse(graph.expiresAt) : Date.parse(graph.updatedAt);
  return Number.isFinite(at) ? at : null;
}

/** True while the graph still holds the request text or a normalized copy of it. */
export function holdsRequestText(graph: IntentGraph): boolean {
  return (
    graph.request.text !== undefined ||
    graph.interpretation.normalizedText !== undefined ||
    (graph.plan?.record.interpretation.normalizedText ?? null) !== null
  );
}

/** What retention does with this graph now. */
export function intentRetentionStage(graph: IntentGraph, now: number): RetentionStage {
  const final = finalSince(graph, now);
  const changed = Date.parse(graph.updatedAt);
  if (final !== null && now - final >= INTENT_RETENTION.purgeAfterMs) return "purge";
  if (Number.isFinite(changed) && now - changed >= INTENT_RETENTION.stalePurgeMs) return "purge";
  if (!holdsRequestText(graph)) return "keep";
  if (final !== null && now - final >= INTENT_RETENTION.textGraceMs) return "redact";
  if (Number.isFinite(changed) && now - changed >= INTENT_RETENTION.staleTextMs) return "redact";
  return "keep";
}

/** The SQL-friendly bounds of a sweep at `now` (ISO times). */
export function retentionCutoffs(now: number): { readonly textFinal: string; readonly textStale: string; readonly purgeFinal: string; readonly purgeStale: string } {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    textFinal: iso(now - INTENT_RETENTION.textGraceMs),
    textStale: iso(now - INTENT_RETENTION.staleTextMs),
    purgeFinal: iso(now - INTENT_RETENTION.purgeAfterMs),
    purgeStale: iso(now - INTENT_RETENTION.stalePurgeMs),
  };
}

/**
 * The graph without its request text: `textRedaction` (salted digest and
 * length) instead of `text`, no normalized text, a neutral title when the
 * title was the normalized text, and the plan record's digest recomputed.
 * Null when there is nothing to remove.
 */
export function redactIntentText(graph: IntentGraph, now: number, salt: string = base64UrlEncode(randomBytes(16))): { readonly graph: IntentGraph; readonly groups: readonly TextBearingGroup[] } | null {
  if (!holdsRequestText(graph)) return null;
  const { text, ...request } = graph.request;
  const { normalizedText, ...interpretation } = graph.interpretation;
  const titleWasText = normalizedText !== undefined && graph.summary.title === normalizedText;
  const record = graph.plan ? { ...graph.plan.record, interpretation: { ...graph.plan.record.interpretation, normalizedText: null } } : null;
  const redacted: IntentGraph = {
    ...graph,
    request: {
      ...request,
      ...(text !== undefined
        ? { textRedaction: { alg: "sha256-salted-v1" as const, digest: requestTextDigest(text, salt), salt, length: requestTextLength(text), redactedAt: new Date(now).toISOString() } }
        : {}),
    },
    interpretation,
    summary: titleWasText ? { ...graph.summary, title: `${graph.steps.length}-step intent` } : graph.summary,
    ...(graph.plan && record ? { plan: { digest: planRecordDigest(record), record } } : {}),
  };
  const groups: TextBearingGroup[] = ["intent.request", "intent.plan"];
  if (titleWasText) groups.push("intent.outcome");
  return { graph: redacted, groups };
}
