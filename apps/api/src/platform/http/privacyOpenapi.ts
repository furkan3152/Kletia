/**
 * OpenAPI schema of the `privacy` trace returned by `POST /v1/intents`
 * (core privacyTrace.ts, docs/platform/data-retention.md).
 */
import { PLATFORM_PRIVACY_TRACE_VERSION } from "@kletia/core";
import { arrayOf, bool, obj, str, type JsonObject } from "./openapiKit.js";

const nullableInt = (description: string): JsonObject => ({ type: ["integer", "null"], minimum: 0, description });

export function privacySchemas(): JsonObject {
  return {
    PlatformPrivacyTrace: obj(
      {
        schemaVersion: str({ const: PLATFORM_PRIVACY_TRACE_VERSION }),
        receivedByKletia: bool({ const: true, description: "Kletia's API received the request (text or actions, accounts, constraints, metadata)." }),
        storage: obj(
          {
            stored: bool({ description: "False for dry runs: nothing of this request is stored." }),
            textHoursAfterFinal: nullableInt("Hours the request text stays in the stored intent after it is final; null when nothing is stored or there was no text."),
            intentDaysAfterFinal: nullableInt("Days the stored intent stays after it is final; null when nothing is stored."),
            deleteWith: { type: ["string", "null"], enum: ["DELETE /v1/intents/{id}", null], description: "How the holder of the intent id deletes it earlier." },
          },
          ["stored", "textHoursAfterFinal", "intentDaysAfterFinal", "deleteWith"],
        ),
        textInApplicationLogs: bool({ const: false, description: "The request text is never written to Kletia's application logs." }),
        modelProvider: obj(
          { sent: str({ enum: ["nothing", "masked_clause"], description: "`masked_clause`: one unread clause as Kletia words, amounts and unknown words replaced, never addresses or names." }) },
          ["sent"],
        ),
        quoteProviders: arrayOf(
          obj(
            { provider: str(), sawAccount: bool({ description: "The provider received the wallet address; it always receives the assets and amounts." }) },
            ["provider", "sawAccount"],
          ),
          { description: "Venues and bridges asked for a quote while planning." },
        ),
        publicIfSigned: bool({ const: true, description: "Signed transactions are public on their networks: amounts, addresses and timing." }),
        notes: arrayOf(str(), { description: "Recipients the trace does not itemize (RPC providers, name services, the Idempotency-Key store)." }),
      },
      ["schemaVersion", "receivedByKletia", "storage", "textInApplicationLogs", "modelProvider", "quoteProviders", "publicIfSigned", "notes"],
      { description: "What this request did with the caller's data. Unsigned; a statement, not a proof. See docs/platform/data-retention.md." },
    ),
  };
}

