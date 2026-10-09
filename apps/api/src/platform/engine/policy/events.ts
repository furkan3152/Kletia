/**
 * Rule Book events (policy design §11.4): `policy.violation`,
 * `policy.approval_requested`, `policy.spend_threshold`, … published by the
 * gate to the typed bus and to envelope subscribers; the HTTP layer routes
 * them to the subject key's and opted-in ancestors' webhooks. Kept apart
 * from intent events like receipt events (stored webhooks keep their lists).
 */
import type { KletiaEvent, KletiaEventMap, PolicyEventType } from "@kletia/core";
import { buildEvent, platformEvents } from "../events.js";

export type PolicyEvent = { [K in PolicyEventType]: KletiaEvent<K> }[PolicyEventType];

const listeners = new Set<(event: PolicyEvent) => void>();

/** Records and fans out one policy event (typed bus and envelope subscribers). */
export function publishPolicyEvent<K extends PolicyEventType>(type: K, data: KletiaEventMap[K]): KletiaEvent<K> {
  const event = buildEvent(type, data);
  platformEvents.emit(type, data);
  for (const listener of [...listeners]) {
    try {
      listener(event as unknown as PolicyEvent);
    } catch (error) {
      console.error("[platform] policy event listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return event;
}

/** Subscribe to policy event envelopes (webhook dispatch). Returns an unsubscribe function. */
export function subscribePolicyEvents(listener: (event: PolicyEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
