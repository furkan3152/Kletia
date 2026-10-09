/**
 * Intent link events (links design §11.1): `link.created`, `link.activated`,
 * `link.updated`, `link.paused`, `link.suspended`, `link.exhausted`,
 * `link.expired`, `link.deleted`, with `{ linkId, ownerKeyId, revision,
 * reason? }`. Routed to the owning key's webhooks (and opted-in ancestors'),
 * like contract registration events.
 */
import type { KletiaEvent, LinkEventData, LinkEventType } from "@kletia/core";
import { buildEvent, platformEvents } from "../../index.js";

export type LinkEvent = KletiaEvent<LinkEventType>;

const listeners = new Set<(event: LinkEvent) => void>();

export function publishLinkEvent(type: LinkEventType, data: LinkEventData): LinkEvent {
  const event = buildEvent(type, data);
  platformEvents.emit(type, data);
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("[platform] link event listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return event;
}

export function subscribeLinkEvents(listener: (event: LinkEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
