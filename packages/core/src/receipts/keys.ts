/**
 * Receipt keys, pinned keys and the verification result types.
 */
import type { ReceiptProblemCode, ReceiptWarningCode } from "./constants.js";

/* ============================================================== verification */

export interface ReceiptKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  /** base64url public key (32 bytes). */
  readonly x: string;
  /** RFC 7638 thumbprint of `x` (`receiptKeyId`). */
  readonly kid: string;
  readonly alg: "Ed25519";
  readonly use: "sig";
  readonly status: "active" | "next" | "retired" | "revoked" | "development";
  /** YYYY-MM-DD: first day the key may sign. */
  readonly notBefore: string;
  /** YYYY-MM-DD: receipts with issuedOn >= revokedOn are invalid. */
  readonly revokedOn?: string;
}

/**
 * Production receipt keys pinned at release time. Empty until the operator
 * generates the production key: every receipt then needs a supplied key
 * (`provenance: "supplied"`), fetched from two origins by the SDK.
 */
export const KLETIA_RECEIPT_KEY_PINS: readonly ReceiptKey[] = Object.freeze([]);

export interface VerifyReceiptOptions {
  /** Extra keys (e.g. GET /v1/receipts/keys cross-checked with the web origin's mirror). Pins are always consulted first. */
  readonly keys?: readonly ReceiptKey[];
  /** Checks `intent.ref`. */
  readonly intentId?: string;
  /** Group paths or patterns that must be disclosed, e.g. ["steps.*.evidence"]. */
  readonly requireGroups?: readonly string[];
  /** Evaluation time for inclusion warnings (default: now). */
  readonly now?: number | Date;
  /** Replaces KLETIA_RECEIPT_KEY_PINS (tests and private deployments). */
  readonly pins?: readonly ReceiptKey[];
}

export interface ReceiptProblem {
  readonly code: ReceiptProblemCode;
  readonly path?: string;
  readonly message: string;
}

export interface ReceiptWarning {
  readonly code: ReceiptWarningCode;
  readonly message: string;
}

export interface ReceiptVerification {
  readonly valid: boolean;
  /** Recomputed digest ("" when the payload is not even well formed). */
  readonly digest: string;
  readonly kid: string;
  /** `none`: no key matched (KEY_UNKNOWN). */
  readonly key: { readonly status: ReceiptKey["status"] | "unknown"; readonly provenance: "pinned" | "supplied" | "none" };
  readonly disclosed: readonly string[];
  readonly sealed: readonly string[];
  readonly inclusion: { readonly valid: boolean; readonly batch: number } | null;
  readonly intentMatches: boolean | null;
  readonly problems: readonly ReceiptProblem[];
  readonly warnings: readonly ReceiptWarning[];
}
