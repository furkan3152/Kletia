/**
 * Receipt spec versions, id patterns, signing prefixes, statuses,
 * disclosure groups, profiles and problem codes.
 */
import type { IntentStatus } from "../intent.js";

/* ================================================================ constants */

export const RECEIPT_SPEC_VERSION = "kletia.receipt/v1" as const;
export const RECEIPT_LOG_SPEC_VERSION = "kletia.receipt-log/v1" as const;
export const PLAN_RECORD_SPEC_VERSION = "kletia.plan/v1" as const;
/** `rcpt_` + 32 hex (128 random bits). */
export const RECEIPT_ID_PATTERN = /^rcpt_[0-9a-f]{32}$/u;
/** `rsh_` + 24 hex. */
export const RECEIPT_SHARE_ID_PATTERN = /^rsh_[0-9a-f]{24}$/u;
/** Receipt, request, plan and batch digests: lower-case hex SHA-256. */
export const RECEIPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
/** Salts: base64url of 16 CSPRNG bytes. */
export const RECEIPT_SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export const RECEIPT_SIGNING_PREFIX = "kletia.receipt.v1:";
export const RECEIPT_LOG_SIGNING_PREFIX = "kletia.receipt-log.v1:";
export const RECEIPT_DISCLOSURE_PREFIX = "kletia.disclosure.v1:";
export const RECEIPT_INTENT_REF_PREFIX = "kletia.intent-ref.v1:";
/** AES-256-GCM additional data of a share: prefix + receiptId + ":" + shareId. */
export const RECEIPT_SHARE_AAD_PREFIX = "kletia.receipt-share.v1:";
/** A receipt not included in a log batch this long after `issuedOn` gets `INCLUSION_OVERDUE`. */
export const RECEIPT_INCLUSION_GRACE_DAYS = 2;

export type ReceiptIntentStatus = "completed" | "partially_completed" | "failed" | "cancelled";
/** Intent statuses that get a receipt. Not `expired` (nothing executed) nor `indeterminate` (manual review first). */
export const RECEIPTABLE_STATUSES: readonly ReceiptIntentStatus[] = Object.freeze(["completed", "partially_completed", "failed", "cancelled"]);
/** Statuses whose receipt can never be superseded. */
export const TERMINAL_RECEIPT_STATUSES: readonly ReceiptIntentStatus[] = Object.freeze(["completed", "cancelled"]);

export function isReceiptableStatus(status: IntentStatus): status is ReceiptIntentStatus {
  return (RECEIPTABLE_STATUSES as readonly string[]).includes(status);
}

/** Intent-level disclosure groups. */
export const RECEIPT_INTENT_GROUPS = Object.freeze(["request", "plan", "timing", "outcome"] as const);
/** Per-step disclosure groups. */
export const RECEIPT_STEP_GROUPS = Object.freeze(["parties", "amounts", "evidence"] as const);
export type ReceiptIntentGroup = (typeof RECEIPT_INTENT_GROUPS)[number];
export type ReceiptStepGroup = (typeof RECEIPT_STEP_GROUPS)[number];

export type ReceiptProfile = "route" | "amounts" | "proof" | "full";
/** Share profiles as group path patterns (`*` = every step). */
export const RECEIPT_PROFILES: Readonly<Record<ReceiptProfile, readonly string[]>> = Object.freeze({
  route: Object.freeze([]),
  amounts: Object.freeze(["steps.*.amounts", "intent.outcome"]),
  proof: Object.freeze(["steps.*.amounts", "intent.outcome", "steps.*.evidence", "intent.timing"]),
  full: Object.freeze([
    "intent.request",
    "intent.plan",
    "intent.timing",
    "intent.outcome",
    "steps.*.parties",
    "steps.*.amounts",
    "steps.*.evidence",
  ]),
});

export const RECEIPT_PROBLEM_CODES = Object.freeze([
  "SPEC_UNSUPPORTED",
  "SCHEMA_INVALID",
  "PROFILE_VIOLATION",
  "DIGEST_MISMATCH",
  "KEY_UNKNOWN",
  "KEY_NOT_YET_VALID",
  "KEY_REVOKED",
  "SIGNATURE_INVALID",
  "DISCLOSURE_PATH_UNKNOWN",
  "DISCLOSURE_INVALID",
  "DISCLOSURE_MISMATCH",
  "DISCLOSURE_MISSING",
  "INCLUSION_INVALID",
  "INTENT_REF_MISMATCH",
  /** SDK: a share link that does not decrypt. */
  "SHARE_DECRYPT_FAILED",
  /** SDK: an EAS envelope that does not verify. */
  "ATTESTATION_INVALID",
] as const);
export type ReceiptProblemCode = (typeof RECEIPT_PROBLEM_CODES)[number];

export const RECEIPT_WARNING_CODES = Object.freeze([
  "NOT_TERMINAL",
  "SEALED_GROUPS",
  "KEY_RETIRED",
  "KEY_DEVELOPMENT",
  "INCLUSION_PENDING",
  "INCLUSION_OVERDUE",
  /** Reverify: only one usable source per network. */
  "SINGLE_SOURCE",
] as const);
export type ReceiptWarningCode = (typeof RECEIPT_WARNING_CODES)[number];
