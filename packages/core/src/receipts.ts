/**
 * Verifiable intent receipts, `kletia.receipt/v1`.
 *
 * A receipt is Kletia's Ed25519-signed statement about one finished intent:
 * a public skeleton (networks, step kinds, protocols, assets, statuses, day)
 * plus salted, path-bound SHA-256 commitments to private groups (request,
 * plan, timing, outcome, and per step parties, amounts and evidence).
 * Disclosures travel outside the signature, so a holder can share any subset
 * and the signature still verifies.
 *
 *   intentRef  = hex(SHA-256("kletia.intent-ref.v1:" + intentId))
 *   commitment = hex(SHA-256("kletia.disclosure.v1:" + JCS({ path, salt, value })))
 *   digest     = hex(SHA-256(JCS(payload)))
 *   signature  = Ed25519(key, "kletia.receipt.v1:" + digest)
 *   kid        = base64url(SHA-256(JCS({ crv: "Ed25519", kty: "OKP", x })))     (RFC 7638)
 *
 * Everything here is pure: `buildReceipt` never reads the chain (the engine's
 * `collectReceiptInputs` supplies anchors), `verifyReceipt` uses Web Crypto
 * only for Ed25519. JCS is the receipt profile of `receiptJcs`.
 *
 * The modules live in ./receipts/.
 */
export * from "./receipts/constants.js";
export * from "./receipts/types.js";
export {
  intentRef,
  planRecordDigest,
  randomReceiptSalt,
  receiptCommitment,
  receiptDigest,
  receiptKeyId,
  receiptLogBatchDigest,
  receiptLogSigningInput,
  receiptRequestDigest,
  receiptSigningInput,
  receiptStateDigest,
} from "./receipts/digests.js";
export * from "./receipts/build.js";
export * from "./receipts/keys.js";
export * from "./receipts/verify.js";
