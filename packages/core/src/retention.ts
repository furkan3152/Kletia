/**
 * Retention of stored intents (docs/platform/data-retention.md).
 *
 * A stored intent keeps the request text only while it can still change.
 * Once it is final (completed, cancelled or expired), and 24 hours later,
 * Kletia removes the text and its normalized copies and keeps a salted
 * SHA-256 digest and the length instead (`IntentTextRedaction`). Thirty days
 * after it became final the whole intent graph is deleted. An intent that
 * never becomes final (left failed, part-completed or indeterminate) loses
 * its text after 7 days without a change and is deleted after 90.
 *
 * The digest follows the receipts' commitment style (a domain prefix and a
 * fresh 128-bit salt, docs/platform/receipts.md): whoever kept the text can
 * prove it was the request (`requestTextDigest(text, salt) === digest`),
 * while the salt keeps equal sentences of two intents unlinkable. A short
 * sentence can still be guessed by someone holding the digest and the salt:
 * the digest is a proof aid, not encryption.
 */
import { sha256Hex, toWellFormedString } from "./hash.js";
import type { IntentStatus } from "./intent.js";

export const INTENT_RETENTION = Object.freeze({
  /** Text kept after an intent became final (completed, cancelled, expired). */
  textGraceMs: 24 * 60 * 60 * 1000,
  /** Whole graph kept after an intent became final. */
  purgeAfterMs: 30 * 24 * 60 * 60 * 1000,
  /** Text of an intent that is not final, kept after its last change. */
  staleTextMs: 7 * 24 * 60 * 60 * 1000,
  /** Graph of an intent that is not final, kept after its last change. */
  stalePurgeMs: 90 * 24 * 60 * 60 * 1000,
});

/** Statuses after which nothing can be prepared or submitted again. */
export const FINAL_INTENT_STATUSES: readonly IntentStatus[] = Object.freeze(["completed", "cancelled", "expired"]);

export const REQUEST_TEXT_DIGEST_PREFIX = "kletia.request-text.v1:";

/** What a stored intent keeps of its request text after retention removed it. */
export interface IntentTextRedaction {
  readonly alg: "sha256-salted-v1";
  /** hex SHA-256(UTF8("kletia.request-text.v1:" + salt + ":" + text)). */
  readonly digest: string;
  /** base64url of 16 random bytes, fresh per intent. */
  readonly salt: string;
  /** Length of the text in Unicode code points. */
  readonly length: number;
  readonly redactedAt: string;
}

/** The digest an `IntentTextRedaction` carries for `text` under `salt`. */
export function requestTextDigest(text: string, salt: string): string {
  return sha256Hex(`${REQUEST_TEXT_DIGEST_PREFIX}${salt}:${toWellFormedString(text)}`);
}

/** Length in Unicode code points (what `IntentTextRedaction.length` counts). */
export function requestTextLength(text: string): number {
  return [...text].length;
}
