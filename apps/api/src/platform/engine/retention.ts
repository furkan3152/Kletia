/**
 * Retention of stored intents (docs/platform/data-retention.md).
 *
 * - Text: a stored intent keeps `request.text`, `interpretation.normalizedText`
 *   and the plan record's normalized text only while it can still change. 24
 *   hours after it became final (completed, cancelled or expired), or 7 days
 *   after its last change when it never becomes final, they are removed and
 *   `request.textRedaction` keeps a salted SHA-256 digest and the length.
 *   A title that was the normalized text becomes "<n>-step intent". The plan
 *   record's digest is recomputed, so a later receipt still verifies;
 *   `updatedAt` is unchanged.
 * - Graph: deleted 30 days after the intent became final, or 90 days after its
 *   last change.
 * - `deleteStoredIntent`: the holder of the intent id deletes it now (refused
 *   while a step is in flight).
 *
 * Receipts are handled by the HTTP layer through `RetentionHooks`: when the
 * text goes, the receipt disclosure groups that hold it are dropped; when the
 * graph goes, every stored disclosure and share goes with it. Signed receipt
 * payloads (commitments only) and transparency-log leaves stay.
 */
import { PlatformError, toPlatformError } from "../errors.js";
import { inFlight, intentRetentionStage, redactIntentText, type TextBearingGroup } from "./retentionPolicy.js";
import { getIntentStore } from "./service.js";

export * from "./retentionPolicy.js";

export interface RetentionHooks {
  /** The text was removed from the graph: drop these stored receipt disclosure groups. */
  readonly afterRedact?: (intentId: string, groups: readonly TextBearingGroup[]) => Promise<void>;
  /** The graph is about to be deleted (purge or DELETE): drop stored receipt disclosures and shares. */
  readonly beforeDelete?: (intentId: string) => Promise<void>;
}

export interface RetentionSweepResult {
  readonly redacted: number;
  readonly purged: number;
}

/** One pass: deletes graphs past their period, then removes the text of graphs past theirs (at most `limit` each). */
export async function sweepIntentRetention(options: { readonly now?: number; readonly limit?: number; readonly hooks?: RetentionHooks } = {}): Promise<RetentionSweepResult> {
  const store = getIntentStore();
  if (!store.listForRetention || !store.delete) return { redacted: 0, purged: 0 };
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 500;
  let purged = 0;
  for (const graph of await store.listForRetention("purge", now, limit)) {
    if (intentRetentionStage(graph, now) !== "purge") continue;
    await options.hooks?.beforeDelete?.(graph.id);
    if (await store.delete(graph.id)) purged += 1;
  }
  let redacted = 0;
  for (const graph of await store.listForRetention("redact", now, limit)) {
    if (intentRetentionStage(graph, now) !== "redact") continue;
    const next = redactIntentText(graph, now);
    if (!next) continue;
    try {
      // updatedAt is unchanged: a writer that changed the graph meanwhile wins, and the next sweep tries again.
      await store.update(graph.id, next.graph, graph.updatedAt);
    } catch (error) {
      if (toPlatformError(error).code === "INTENT_CONFLICT") continue;
      throw error;
    }
    await options.hooks?.afterRedact?.(graph.id, next.groups);
    redacted += 1;
  }
  return { redacted, purged };
}

/**
 * DELETE /v1/intents/{id}: the holder of the intent id deletes the stored
 * graph now. Refused with 409 INTENT_IN_FLIGHT while a step is submitted,
 * confirmed or settling (Kletia is still following money in motion).
 */
export async function deleteStoredIntent(id: string, hooks: RetentionHooks = {}): Promise<void> {
  try {
    const store = getIntentStore();
    if (!store.delete) throw new PlatformError("STORE_UNAVAILABLE", "This intent store cannot delete intents.", 503);
    const graph = await store.get(id);
    if (!graph) throw new PlatformError("INTENT_NOT_FOUND", "Intent not found.", 404);
    if (inFlight(graph)) {
      throw new PlatformError("INTENT_IN_FLIGHT", "A step of this intent is in flight. Delete it once the step has settled or failed.", 409);
    }
    await hooks.beforeDelete?.(id);
    await store.delete(id);
  } catch (error) {
    throw toPlatformError(error);
  }
}
