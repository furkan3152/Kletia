/**
 * Platform event fan-out.
 *
 * - `platformEvents`: typed payload bus (KletiaEventMap) for in-process
 *   features (portfolio invalidation, activity feeds, analytics).
 * - Envelope stream: every intent event is wrapped as a KletiaEvent
 *   `{ id, type, at, data }`, kept in a per-intent ring buffer (last 100
 *   events, 2000 intents) so SSE clients can resume with Last-Event-ID, and
 *   delivered to envelope subscribers (SSE connections, webhook dispatch).
 */
import {
  createEventBus,
  type AnyKletiaEvent,
  type IntentGraph,
  type KletiaEvent,
  type KletiaEventMap,
} from "@kletia/core";
import { canonicalJson, newEventId } from "./util.js";

export type IntentEventType = "intent.created" | "intent.status_changed" | "intent.step_updated";
export type IntentEvent = Extract<AnyKletiaEvent, { type: IntentEventType }>;

const MAX_EVENTS_PER_INTENT = 100;
const MAX_BUFFERED_INTENTS = 2_000;

export const platformEvents = createEventBus<KletiaEventMap>((error) => {
  console.error("[platform] event listener failed:", error instanceof Error ? error.message : error);
});

const buffers = new Map<string, IntentEvent[]>();
const envelopeListeners = new Set<(event: IntentEvent) => void>();

export function buildEvent<K extends keyof KletiaEventMap>(type: K, data: KletiaEventMap[K], at: Date = new Date()): KletiaEvent<K> {
  return { id: newEventId(), type, at: at.toISOString(), data };
}

function buffer(event: IntentEvent): void {
  const intentId = event.data.intentId;
  const existing = buffers.get(intentId) ?? [];
  buffers.delete(intentId);
  existing.push(event);
  if (existing.length > MAX_EVENTS_PER_INTENT) existing.splice(0, existing.length - MAX_EVENTS_PER_INTENT);
  buffers.set(intentId, existing);
  while (buffers.size > MAX_BUFFERED_INTENTS) {
    const oldest = buffers.keys().next().value;
    if (oldest === undefined) break;
    buffers.delete(oldest);
  }
}

/** Records, buffers and fans out one intent event. */
export function publishIntentEvent<K extends IntentEventType>(type: K, data: KletiaEventMap[K]): KletiaEvent<K> {
  const event = buildEvent(type, data);
  const envelope = event as unknown as IntentEvent;
  buffer(envelope);
  platformEvents.emit(type, data);
  for (const listener of [...envelopeListeners]) {
    try {
      listener(envelope);
    } catch (error) {
      console.error("[platform] envelope listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return event;
}

/** Subscribe to every intent event envelope (all intents). Returns an unsubscribe function. */
export function subscribeIntentEvents(listener: (event: IntentEvent) => void): () => void {
  envelopeListeners.add(listener);
  return () => {
    envelopeListeners.delete(listener);
  };
}

/**
 * Buffered events for one intent, oldest first. With `afterEventId`, only
 * events after that id; an unknown id replays the whole buffer.
 */
export function readIntentEvents(intentId: string, afterEventId?: string): IntentEvent[] {
  const events = buffers.get(intentId) ?? [];
  if (!afterEventId) return [...events];
  const index = events.findIndex((event) => event.id === afterEventId);
  return index === -1 ? [...events] : events.slice(index + 1);
}

/** Emits status/step events for everything that changed between two versions of a graph. */
export function emitGraphChanges(before: IntentGraph | null, after: IntentGraph): void {
  if (!before) {
    publishIntentEvent("intent.created", {
      intentId: after.id,
      summary: after.summary,
      ...(after.metadata ? { metadata: after.metadata } : {}),
    });
    for (const step of after.steps) {
      publishIntentEvent("intent.step_updated", {
        intentId: after.id,
        stepId: step.id,
        network: step.network,
        status: step.status,
      });
    }
    return;
  }
  for (const step of after.steps) {
    const previous = before.steps.find((candidate) => candidate.id === step.id);
    const latest = step.evidence[step.evidence.length - 1];
    // Evidence is capped (oldest dropped), so compare the newest entry rather than the length.
    const evidenceChanged = latest !== undefined &&
      canonicalJson(latest) !== canonicalJson(previous?.evidence[previous.evidence.length - 1] ?? null);
    if (previous && previous.status === step.status && !evidenceChanged) continue;
    publishIntentEvent("intent.step_updated", {
      intentId: after.id,
      stepId: step.id,
      network: step.network,
      status: step.status,
      ...(latest && evidenceChanged ? { evidence: latest } : {}),
    });
  }
  if (before.status !== after.status) {
    publishIntentEvent("intent.status_changed", { intentId: after.id, status: after.status, previous: before.status });
  }
}
