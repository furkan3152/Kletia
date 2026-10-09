/**
 * `intent.receipt_issued` for the SSE stream (receipts design §13.1).
 *
 * The engine publishes receipt events apart from its per-intent buffer of
 * intent events (stored webhooks keep their event lists), so the HTTP layer
 * keeps its own small buffer (last 10 receipt events of 2,000 intents) to
 * replay them after `Last-Event-ID`, merged with the intent events by time.
 */
import { subscribeReceiptEvents, type IntentEvent, type ReceiptEvent } from "../../index.js";

const MAX_PER_INTENT = 10;
const MAX_INTENTS = 2_000;

const buffers = new Map<string, ReceiptEvent[]>();
let unsubscribe: (() => void) | null = null;

function record(event: ReceiptEvent): void {
  const intentId = event.data.intentId;
  const existing = buffers.get(intentId) ?? [];
  buffers.delete(intentId);
  existing.push(event);
  if (existing.length > MAX_PER_INTENT) existing.splice(0, existing.length - MAX_PER_INTENT);
  buffers.set(intentId, existing);
  while (buffers.size > MAX_INTENTS) {
    const oldest = buffers.keys().next().value;
    if (oldest === undefined) break;
    buffers.delete(oldest);
  }
}

/** Starts buffering receipt events (idempotent; the router calls it). */
export function startReceiptEventBuffer(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeReceiptEvents(record);
}

/** Buffered receipt events of one intent, oldest first. */
export function readReceiptEvents(intentId: string): ReceiptEvent[] {
  return [...(buffers.get(intentId) ?? [])];
}

/**
 * Intent and receipt events of one intent in time order (stable: intent
 * events keep their order), after `afterEventId` when it is buffered (else
 * everything, like the engine's replay).
 */
export function mergeStreamEvents(intentEvents: readonly IntentEvent[], intentId: string, afterEventId?: string): (IntentEvent | ReceiptEvent)[] {
  const receipts = readReceiptEvents(intentId);
  const merged: (IntentEvent | ReceiptEvent)[] = [];
  let index = 0;
  for (const event of intentEvents) {
    while (index < receipts.length && (receipts[index] as ReceiptEvent).at < event.at) merged.push(receipts[index++] as ReceiptEvent);
    merged.push(event);
  }
  while (index < receipts.length) merged.push(receipts[index++] as ReceiptEvent);
  if (!afterEventId) return merged;
  const position = merged.findIndex((event) => event.id === afterEventId);
  return position === -1 ? merged : merged.slice(position + 1);
}
