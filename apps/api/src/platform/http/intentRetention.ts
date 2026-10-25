/**
 * Intent retention in the HTTP layer (docs/platform/data-retention.md):
 *
 *   DELETE /v1/intents/{id}   the holder of the intent id deletes the stored
 *                             intent now (204; 404 unknown; 409 INTENT_IN_FLIGHT
 *                             while a step is submitted, confirmed or settling)
 *   hourly sweep              removes the request text 24 h after an intent
 *                             became final and deletes the graph 30 days after
 *                             (engine/retention.ts)
 *
 * Receipts: removing the text drops the stored `intent.request` and
 * `intent.plan` disclosures (and `intent.outcome` when its title was the
 * text); deleting the graph withdraws every stored disclosure and share of
 * its receipts. Signed payloads (commitments only) and log leaves stay, so a
 * receipt downloaded earlier still verifies offline.
 */
import type { RequestHandler } from "express";
import { deleteStoredIntent, sweepIntentRetention, type RetentionHooks } from "../engine/retention.js";
import { handle, intentIdParam } from "./context.js";
import { receiptStore } from "./receipts/store.js";

/** The receipt side of retention: what the HTTP layer stores about the intent's receipts. */
export function receiptRetentionHooks(now: () => number = Date.now): RetentionHooks {
  return {
    afterRedact: async (intentId, groups) => {
      await receiptStore().dropDisclosureGroups(intentId, groups);
    },
    beforeDelete: async (intentId) => {
      await receiptStore().withdraw(intentId, new Date(now()).toISOString());
    },
  };
}

export function intentRetentionHandlers(): Record<string, RequestHandler[]> {
  return {
    "delete /intents/:id": [
      handle(async (req, res) => {
        await deleteStoredIntent(intentIdParam(req), receiptRetentionHooks());
        res.status(204).end();
      }),
    ],
  };
}

/** Hourly retention sweep (long-running hosts). Returns a stop function. */
export function startIntentRetentionPruner(intervalMs = 60 * 60_000): () => void {
  const timer = setInterval(() => {
    sweepIntentRetention({ hooks: receiptRetentionHooks() }).catch((error: unknown) =>
      console.warn("[platform] intent retention sweep failed:", error instanceof Error ? error.message : error),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
