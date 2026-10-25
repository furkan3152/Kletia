/**
 * Receipt digests, signing inputs, key ids and salts.
 */
import {
  base64UrlEncode,
  sha256,
  sha256Hex,
  toWellFormedString,
} from "../hash.js";
import { receiptJcs } from "../receiptProfile.js";
import type { IntentGraph } from "../intent.js";
import {
  RECEIPT_DISCLOSURE_PREFIX,
  RECEIPT_INTENT_REF_PREFIX,
  RECEIPT_LOG_SIGNING_PREFIX,
  RECEIPT_SIGNING_PREFIX,
} from "./constants.js";
import type {
  PlanRecord,
  ReceiptLogBatch,
  ReceiptPayload,
  ReceiptRequest,
} from "./types.js";

/* ================================================================== digests */

export const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** hex sha256("kletia.intent-ref.v1:" + intentId). */
export function intentRef(intentId: string): string {
  return sha256Hex(`${RECEIPT_INTENT_REF_PREFIX}${intentId}`);
}

/** hex sha256(JCS(request)): hash what you receive, never re-project. */
export function receiptRequestDigest(request: ReceiptRequest): string {
  return sha256Hex(receiptJcs(request));
}

/** hex sha256(JCS(record)). */
export function planRecordDigest(record: PlanRecord): string {
  return sha256Hex(receiptJcs(record));
}

/** hex sha256(UTF8("kletia.disclosure.v1:") || JCS({ path, salt, value })). */
export function receiptCommitment(path: string, disclosure: { readonly salt: string; readonly value: unknown }): string {
  return sha256Hex(`${RECEIPT_DISCLOSURE_PREFIX}${receiptJcs({ path, salt: disclosure.salt, value: disclosure.value })}`);
}

/** hex sha256(JCS(payload)). Throws ReceiptProfileError outside the profile. */
export async function receiptDigest(payload: ReceiptPayload): Promise<string> {
  return sha256Hex(receiptJcs(payload));
}

/** The ASCII string the receipt key signs: "kletia.receipt.v1:" + digest (82 bytes). */
export function receiptSigningInput(digest: string): string {
  return `${RECEIPT_SIGNING_PREFIX}${digest}`;
}

/** hex sha256(JCS(batch)). */
export function receiptLogBatchDigest(batch: ReceiptLogBatch): string {
  return sha256Hex(receiptJcs(batch));
}

/** "kletia.receipt-log.v1:" + batchDigest. */
export function receiptLogSigningInput(batchDigest: string): string {
  return `${RECEIPT_LOG_SIGNING_PREFIX}${batchDigest}`;
}

/** RFC 7638 thumbprint of an Ed25519 public key `x` (base64url): the receipt `kid`. */
export function receiptKeyId(x: string): string {
  return base64UrlEncode(sha256(receiptJcs({ crv: "Ed25519", kty: "OKP", x })));
}

/** A fresh 128-bit salt (base64url) from the platform CSPRNG. */
export function randomReceiptSalt(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.getRandomValues) throw new Error("No CSPRNG is available in this runtime.");
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Dedupe digest of an intent's receiptable state (stored with the receipt
 * row, never inside the receipt): status and, per step, status, references
 * and fill references.
 */
export function receiptStateDigest(graph: IntentGraph, fills: Readonly<Record<string, readonly string[]>> = {}): string {
  return sha256Hex(
    receiptJcs({
      status: graph.status,
      steps: graph.steps.map((step) => ({
        id: step.id,
        status: step.status,
        references: [...(step.references ?? [])].map(toWellFormedString),
        fills: [...(fills[step.id] ?? [])].map(toWellFormedString),
      })),
    }),
  );
}
