/**
 * Automation events: `automation.created`, `.updated`, `.deleted`, `.fired`,
 * `.skipped`, `.failed`, with `{ automationId, ownerKeyId, runId?,
 * intentId?, status?, reason? }`. Routed to the owning key's webhooks (and
 * opted-in ancestors'), like link events. Wallet-owned automations publish
 * nothing: their owner reads the inbox.
 */
import type { AutomationEventData, AutomationEventType, AutomationOwner, KletiaEvent } from "@kletia/core";
import { buildEvent, platformEvents } from "../index.js";

export type AutomationEvent = KletiaEvent<AutomationEventType>;

const listeners = new Set<(event: AutomationEvent) => void>();

export function publishAutomationEvent(type: AutomationEventType, owner: AutomationOwner, data: Omit<AutomationEventData, "ownerKeyId">): AutomationEvent | null {
  if (owner.kind !== "key") return null;
  const payload: AutomationEventData = { ...data, ownerKeyId: owner.keyId };
  const event = buildEvent(type, payload);
  platformEvents.emit(type, payload);
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("[platform] automation event listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return event;
}

export function subscribeAutomationEvents(listener: (event: AutomationEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
