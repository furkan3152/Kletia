/**
 * What one `POST /v1/intents` did with the caller's data, field by field
 * (docs/platform/data-retention.md). Returned as `privacy` beside the intent.
 *
 * Built only from facts of the request and the planned graph: whether it was
 * stored, whether a model read a masked clause, and which quote providers
 * were asked (each one received the accounts or not, `sawAccount`). It is a
 * statement of what happened, not a proof: it is unsigned and covers this
 * request only. The legacy `/api/intent` route has its own trace
 * (`kletia_intent_privacy_trace_v1`).
 */
import type { IntentGraph } from "./intent.js";
import { INTENT_RETENTION } from "./retention.js";

export const PLATFORM_PRIVACY_TRACE_VERSION = "kletia_platform_privacy_trace_v1" as const;

export interface PlatformPrivacyTrace {
  readonly schemaVersion: typeof PLATFORM_PRIVACY_TRACE_VERSION;
  /** Kletia's API received the request (text or actions, accounts, constraints, metadata). */
  readonly receivedByKletia: true;
  readonly storage: {
    /** False for dry runs (`dryRun=true`): nothing of this request is stored. */
    readonly stored: boolean;
    /** How long the request text stays in the stored intent after it is final (hours); null when nothing is stored or there was no text. */
    readonly textHoursAfterFinal: number | null;
    /** How long the stored intent stays after it is final (days); null when nothing is stored. */
    readonly intentDaysAfterFinal: number | null;
    /** How the holder of the intent id deletes it earlier; null when nothing is stored. */
    readonly deleteWith: "DELETE /v1/intents/{id}" | null;
  };
  /** The request text is never written to Kletia's application logs (error codes and request ids are). */
  readonly textInApplicationLogs: false;
  readonly modelProvider: {
    /** `masked_clause`: one unread clause left as Kletia words with amounts and unknown words replaced (no addresses or names). */
    readonly sent: "nothing" | "masked_clause";
  };
  /** Venues and bridges asked for a quote while planning; `sawAccount`: the provider received the wallet address (and always the amounts and assets). */
  readonly quoteProviders: readonly { readonly provider: string; readonly sawAccount: boolean }[];
  /** Signed transactions are public on their networks: amounts, addresses and timing. */
  readonly publicIfSigned: true;
  /** Recipients this trace does not itemize, in plain words. */
  readonly notes: readonly string[];
}

const NOTES: readonly string[] = Object.freeze([
  "Network RPC providers configured by the deployment receive the accounts when Kletia reads balances and simulates transactions.",
  "Name services (ENS, Basenames, SNS) receive a name you typed when Kletia resolves it.",
  "With an Idempotency-Key, the response (this intent included) is kept for 24 hours to replay retries.",
]);

/** The trace of one planned request. */
export function platformPrivacyTrace(graph: IntentGraph, options: { readonly stored: boolean }): PlatformPrivacyTrace {
  const hours = INTENT_RETENTION.textGraceMs / 3_600_000;
  const days = INTENT_RETENTION.purgeAfterMs / 86_400_000;
  return {
    schemaVersion: PLATFORM_PRIVACY_TRACE_VERSION,
    receivedByKletia: true,
    storage: {
      stored: options.stored,
      textHoursAfterFinal: options.stored && graph.request.text !== undefined ? hours : null,
      intentDaysAfterFinal: options.stored ? days : null,
      deleteWith: options.stored ? "DELETE /v1/intents/{id}" : null,
    },
    textInApplicationLogs: false,
    modelProvider: { sent: graph.interpretation.modelReading?.used ? "masked_clause" : "nothing" },
    quoteProviders: (graph.interpretation.providersContacted ?? []).map((contact) => ({ provider: contact.provider, sawAccount: contact.sawAccount })),
    publicIfSigned: true,
    notes: NOTES,
  };
}
