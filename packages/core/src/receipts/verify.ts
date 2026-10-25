/**
 * Receipt and log batch verification.
 */
import { CHAINS, isNetworkKey } from "../chains.js";
import { base64UrlDecode, sha256Hex, timingSafeEqualString } from "../hash.js";
import { verifyMerkleInclusion } from "../merkle.js";
import { receiptJcs, ReceiptProfileError } from "../receiptProfile.js";
import {
  RECEIPT_INCLUSION_GRACE_DAYS,
  RECEIPT_LOG_SPEC_VERSION,
  RECEIPT_SALT_PATTERN,
  RECEIPT_SPEC_VERSION,
} from "./constants.js";
import type {
  PlanRecord,
  ReceiptLogBatch,
  ReceiptPayload,
  ReceiptRequest,
  ReceiptSignature,
} from "./types.js";
import {
  intentRef,
  planRecordDigest,
  receiptCommitment,
  receiptKeyId,
  receiptLogBatchDigest,
  receiptLogSigningInput,
  receiptRequestDigest,
  receiptSigningInput,
} from "./digests.js";
import { receiptGroupPaths } from "./build.js";
import {
  KLETIA_RECEIPT_KEY_PINS,
  type ReceiptKey,
  type ReceiptProblem,
  type ReceiptVerification,
  type ReceiptWarning,
  type VerifyReceiptOptions,
} from "./keys.js";
import {
  groupSchemaIssues,
  hasExactKeys,
  isDay,
  isHex64,
  isRecord,
  isUint,
  payloadSchemaIssues,
} from "./schema.js";

/* ------------------------------------------------------------ Ed25519 */

/** RFC 8032 verification through Web Crypto (Node 20+, Chrome 137+, Firefox 129+, Safari 17+). Never throws. */
export async function verifyEd25519(x: string, message: string, signature: string): Promise<boolean> {
  const publicKey = base64UrlDecode(x);
  const signatureBytes = base64UrlDecode(signature);
  if (!publicKey || publicKey.length !== 32 || !signatureBytes || signatureBytes.length !== 64) return false;
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return false;
  try {
    const key = await subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signatureBytes), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

function isReceiptKey(value: unknown): value is ReceiptKey {
  return (
    isRecord(value) &&
    value.kty === "OKP" &&
    value.crv === "Ed25519" &&
    typeof value.x === "string" &&
    typeof value.kid === "string" &&
    (value.alg === undefined || value.alg === "Ed25519") &&
    typeof value.status === "string" &&
    ["active", "next", "retired", "revoked", "development"].includes(value.status) &&
    isDay(value.notBefore) &&
    (value.revokedOn === undefined || isDay(value.revokedOn))
  );
}

/** A key usable for `kid`: well formed and its kid is the thumbprint of its x. */
function findKey(kid: string, pins: readonly ReceiptKey[], supplied: readonly ReceiptKey[]): { key: ReceiptKey; provenance: "pinned" | "supplied" } | null {
  for (const [list, provenance] of [[pins, "pinned"], [supplied, "supplied"]] as const) {
    for (const key of list) {
      if (isReceiptKey(key) && key.kid === kid && receiptKeyId(key.x) === kid) return { key, provenance };
    }
  }
  return null;
}

function keyUsableOn(key: ReceiptKey, day: string): "ok" | "not_yet" | "revoked" {
  if (day < key.notBefore) return "not_yet";
  if (key.revokedOn !== undefined ? day >= key.revokedOn : key.status === "revoked") return "revoked";
  return "ok";
}

/** Verifies a log batch signature with any known key valid on the batch's day. */
export async function verifyReceiptLogBatch(
  batch: ReceiptLogBatch,
  signature: string,
  keys: readonly ReceiptKey[],
): Promise<{ readonly valid: boolean; readonly kid: string | null; readonly batchDigest: string }> {
  const batchDigest = receiptLogBatchDigest(batch);
  for (const key of keys) {
    if (!isReceiptKey(key) || receiptKeyId(key.x) !== key.kid || keyUsableOn(key, batch.closedOn) !== "ok") continue;
    if (await verifyEd25519(key.x, receiptLogSigningInput(batchDigest), signature)) return { valid: true, kid: key.kid, batchDigest };
  }
  return { valid: false, kid: null, batchDigest };
}

function isLogBatch(value: unknown): value is ReceiptLogBatch {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["spec", "seq", "size", "root", "previous", "closedOn"]) &&
    value.spec === RECEIPT_LOG_SPEC_VERSION &&
    isUint(value.seq) &&
    value.seq >= 1 &&
    isUint(value.size) &&
    value.size >= 1 &&
    isHex64(value.root) &&
    (value.previous === null || isHex64(value.previous)) &&
    isDay(value.closedOn)
  );
}

/**
 * Offline verification: profile, digest, key status, Ed25519 signature,
 * every present disclosure (commitment, schema and internal consistency),
 * required groups, the optional inclusion proof and the optional intent
 * id. Stops at the first fatal problem (shape, digest, key, signature);
 * collects the rest. Never throws.
 */
export async function verifyReceipt(document: unknown, options: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  try {
    return await verifyReceiptUnsafe(document, options);
  } catch (error) {
    // Fail closed on anything unexpected (hostile input, broken runtime).
    return {
      valid: false,
      digest: "",
      kid: "",
      key: { status: "unknown", provenance: "none" },
      disclosed: [],
      sealed: [],
      inclusion: null,
      intentMatches: null,
      problems: [{ code: "SCHEMA_INVALID", message: `The document could not be verified: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}.` }],
      warnings: [],
    };
  }
}

async function verifyReceiptUnsafe(document: unknown, options: VerifyReceiptOptions): Promise<ReceiptVerification> {
  const problems: ReceiptProblem[] = [];
  const warnings: ReceiptWarning[] = [];
  let digest = "";
  let kid = "";
  let keyView: ReceiptVerification["key"] = { status: "unknown", provenance: "none" };
  const finish = (extra: Partial<ReceiptVerification> = {}): ReceiptVerification => ({
    valid: problems.length === 0,
    digest,
    kid,
    key: keyView,
    disclosed: [],
    sealed: [],
    inclusion: null,
    intentMatches: null,
    problems,
    warnings,
    ...extra,
  });

  // 1. Shape.
  const root = isRecord(document) && !("payload" in document) && isRecord(document.receipt) ? document.receipt : document;
  if (!isRecord(root) || !isRecord(root.payload)) {
    problems.push({ code: "SCHEMA_INVALID", path: "payload", message: "The document has no receipt payload." });
    return finish();
  }
  const payload = root.payload;
  if (payload.spec !== RECEIPT_SPEC_VERSION) {
    problems.push({ code: "SPEC_UNSUPPORTED", path: "payload.spec", message: `Unsupported receipt spec ${String(payload.spec).slice(0, 40)}.` });
    return finish();
  }
  const signature = root.signature;
  kid = isRecord(signature) && typeof signature.kid === "string" ? signature.kid.slice(0, 128) : "";
  let jcs: string;
  try {
    jcs = receiptJcs(payload);
  } catch (error) {
    problems.push({ code: "PROFILE_VIOLATION", path: error instanceof ReceiptProfileError ? error.path : "payload", message: error instanceof Error ? error.message : "Outside the receipt profile." });
    return finish();
  }
  const schemaIssues = payloadSchemaIssues(payload);
  if (!isRecord(signature) || !hasExactKeys(signature, ["alg", "kid", "value"]) || signature.alg !== "Ed25519" || typeof signature.value !== "string") {
    schemaIssues.push("signature");
  }
  if (schemaIssues.length > 0) {
    problems.push({ code: "SCHEMA_INVALID", path: schemaIssues[0], message: `Malformed receipt fields: ${schemaIssues.slice(0, 8).join(", ")}.` });
    return finish();
  }
  const typed = payload as unknown as ReceiptPayload;
  const sig = signature as unknown as ReceiptSignature;

  // 2. Digest.
  digest = sha256Hex(jcs);
  if (typeof root.digest !== "string" || !timingSafeEqualString(root.digest, digest)) {
    problems.push({ code: "DIGEST_MISMATCH", path: "digest", message: "The digest does not match the payload." });
    return finish();
  }

  // 3. Key.
  if (sig.kid !== typed.issuer.kid) {
    problems.push({ code: "KEY_UNKNOWN", path: "signature.kid", message: "signature.kid differs from payload.issuer.kid." });
    return finish();
  }
  const found = findKey(sig.kid, options.pins ?? KLETIA_RECEIPT_KEY_PINS, options.keys ?? []);
  if (!found) {
    problems.push({ code: "KEY_UNKNOWN", path: "signature.kid", message: `No pinned or supplied key ${sig.kid}.` });
    return finish();
  }
  keyView = { status: found.key.status, provenance: found.provenance };
  const usable = keyUsableOn(found.key, typed.issuedOn);
  if (usable === "not_yet") {
    problems.push({ code: "KEY_NOT_YET_VALID", path: "payload.issuedOn", message: `The key may sign from ${found.key.notBefore}.` });
    return finish();
  }
  if (usable === "revoked") {
    problems.push({ code: "KEY_REVOKED", path: "signature.kid", message: found.key.revokedOn ? `The key was revoked on ${found.key.revokedOn}.` : "The key is revoked." });
    return finish();
  }

  // 4. Signature.
  if (!(await verifyEd25519(found.key.x, receiptSigningInput(digest), sig.value))) {
    problems.push({ code: "SIGNATURE_INVALID", path: "signature.value", message: "The Ed25519 signature does not verify (or this runtime cannot verify Ed25519)." });
    return finish();
  }

  // 5. Disclosures.
  const slots = new Map<string, string>();
  slots.set("intent.request", typed.intent.commitments.request);
  slots.set("intent.plan", typed.intent.commitments.plan);
  slots.set("intent.timing", typed.intent.commitments.timing);
  slots.set("intent.outcome", typed.intent.commitments.outcome);
  for (const step of typed.steps) {
    slots.set(`steps.${step.id}.parties`, step.commitments.parties);
    slots.set(`steps.${step.id}.amounts`, step.commitments.amounts);
    slots.set(`steps.${step.id}.evidence`, step.commitments.evidence);
  }
  const disclosed: string[] = [];
  const rawDisclosures = root.disclosures;
  if (rawDisclosures !== undefined && !isRecord(rawDisclosures)) {
    problems.push({ code: "DISCLOSURE_INVALID", path: "disclosures", message: "disclosures must be an object keyed by group path." });
  } else if (rawDisclosures) {
    for (const [path, disclosure] of Object.entries(rawDisclosures)) {
      const slot = slots.get(path);
      if (slot === undefined) {
        problems.push({ code: "DISCLOSURE_PATH_UNKNOWN", path: `disclosures.${path.slice(0, 80)}`, message: "No commitment slot has this path." });
        continue;
      }
      if (!isRecord(disclosure) || !hasExactKeys(disclosure, ["salt", "value"]) || typeof disclosure.salt !== "string" || !RECEIPT_SALT_PATTERN.test(disclosure.salt)) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: "A disclosure is { salt (base64url, 16 bytes), value }." });
        continue;
      }
      let commitment: string;
      try {
        commitment = receiptCommitment(path, { salt: disclosure.salt, value: disclosure.value });
      } catch (error) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: error instanceof Error ? error.message : "Outside the receipt profile." });
        continue;
      }
      if (!timingSafeEqualString(commitment, slot)) {
        problems.push({ code: "DISCLOSURE_MISMATCH", path: `disclosures.${path}`, message: "The disclosure does not match its commitment." });
        continue;
      }
      const issues = groupSchemaIssues(path, disclosure.value);
      const consistency = consistencyIssues(path, disclosure.value, typed);
      if (issues.length > 0 || consistency.length > 0) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: [...issues, ...consistency].slice(0, 6).join("; ") });
        continue;
      }
      disclosed.push(path);
    }
  }
  const order = [...slots.keys()];
  disclosed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const sealed = order.filter((slot) => !disclosed.includes(slot));

  // 6. Required groups.
  if (options.requireGroups && options.requireGroups.length > 0) {
    for (const path of receiptGroupPaths(options.requireGroups, typed)) {
      if (!disclosed.includes(path)) problems.push({ code: "DISCLOSURE_MISSING", path: `disclosures.${path}`, message: `${path} is required but not disclosed.` });
    }
    for (const pattern of options.requireGroups) {
      if (receiptGroupPaths([pattern], typed).length === 0 && !pattern.includes("*")) {
        problems.push({ code: "DISCLOSURE_MISSING", path: `disclosures.${pattern.slice(0, 80)}`, message: `${pattern.slice(0, 80)} is not a group of this receipt.` });
      }
    }
  }

  // 7. Inclusion.
  let inclusion: ReceiptVerification["inclusion"] = null;
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  if (root.inclusion !== undefined && root.inclusion !== null) {
    const proof = root.inclusion;
    let valid = false;
    let seq = 0;
    if (isRecord(proof) && isLogBatch(proof.batch) && typeof proof.batchSignature === "string" && isUint(proof.leafIndex) && Array.isArray(proof.path)) {
      seq = proof.batch.seq;
      const known = [...(options.pins ?? KLETIA_RECEIPT_KEY_PINS), ...(options.keys ?? [])];
      const signed = await verifyReceiptLogBatch(proof.batch, proof.batchSignature, known);
      valid =
        signed.valid &&
        verifyMerkleInclusion({ leaf: digest, leafIndex: proof.leafIndex, treeSize: proof.batch.size, path: proof.path as string[], root: proof.batch.root });
    }
    inclusion = { valid, batch: seq };
    if (!valid) problems.push({ code: "INCLUSION_INVALID", path: "inclusion", message: "The batch signature or the inclusion path does not verify." });
  } else {
    const ageDays = (nowMs - Date.parse(`${typed.issuedOn}T00:00:00Z`)) / 86_400_000;
    warnings.push(
      ageDays > RECEIPT_INCLUSION_GRACE_DAYS
        ? { code: "INCLUSION_OVERDUE", message: `Not in a log batch ${Math.floor(ageDays)} days after issuance; ask GET /v1/receipts/log/inclusion with the digest.` }
        : { code: "INCLUSION_PENDING", message: "Not in a log batch yet (batches close hourly)." },
    );
  }

  // 8. Intent id.
  let intentMatches: boolean | null = null;
  if (options.intentId !== undefined) {
    intentMatches = timingSafeEqualString(intentRef(options.intentId), typed.intent.ref);
    if (!intentMatches) problems.push({ code: "INTENT_REF_MISMATCH", path: "payload.intent.ref", message: "This receipt is about another intent." });
  }

  // 9. Warnings.
  if (!typed.intent.terminal) warnings.push({ code: "NOT_TERMINAL", message: `Status ${typed.intent.status} can still change; a newer receipt may supersede this one.` });
  if (sealed.length > 0) warnings.push({ code: "SEALED_GROUPS", message: `${sealed.length} group(s) are sealed by the holder.` });
  if (found.key.status === "retired") warnings.push({ code: "KEY_RETIRED", message: "Signed by a retired key (still valid for receipts it signed)." });
  if (found.key.status === "development") warnings.push({ code: "KEY_DEVELOPMENT", message: "Signed by a development key: not a production receipt." });

  return finish({ disclosed, sealed, inclusion, intentMatches });
}

function consistencyIssues(path: string, value: unknown, payload: ReceiptPayload): string[] {
  if (!isRecord(value)) return [];
  if (path === "intent.request") {
    try {
      return receiptRequestDigest(value.request as ReceiptRequest) === value.requestDigest ? [] : ["requestDigest does not match the request"];
    } catch {
      return ["request is outside the receipt profile"];
    }
  }
  if (path === "intent.plan") {
    if (value.plan === null || value.plan === undefined) return [];
    try {
      return planRecordDigest(value.plan as PlanRecord) === value.planDigest ? [] : ["planDigest does not match the plan record"];
    } catch {
      return ["plan is outside the receipt profile"];
    }
  }
  if (path.startsWith("steps.") && path.endsWith(".evidence") && Array.isArray(value.anchors)) {
    const stepId = path.slice("steps.".length, -".evidence".length);
    const step = payload.steps.find((entry) => entry.id === stepId);
    if (!step) return ["unknown step"];
    const chains = new Set<string>([step.chain]);
    const destination = step.settlement?.destinationNetwork;
    if (destination && isNetworkKey(destination)) chains.add(CHAINS[destination].id);
    const outside = value.anchors.filter((anchor) => isRecord(anchor) && typeof anchor.chain === "string" && !chains.has(anchor.chain));
    return outside.length > 0 ? ["an anchor is on a chain the step does not touch"] : [];
  }
  return [];
}
