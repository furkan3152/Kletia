// Writes the receipt key mirror, dist/.well-known/kletia-receipt-keys.json,
// at build time (portal S-23, plan decision 8). Verifiers trust a receipt key
// only when the API (GET /v1/receipts/keys) and this second origin list it
// with the same x and notBefore, so the mirror is generated from the same
// public values the API is configured with instead of a hand-kept file:
//
// - KLETIA_RECEIPT_PUBLIC_KEY: the active key's PUBLIC part, as JSON
//   `{ "x": "…", "notBefore": "YYYY-MM-DD" }` (a public JWK works too) or the
//   bare base64url `x` with KLETIA_RECEIPT_KEY_NOT_BEFORE. The API derives the
//   same key from KLETIA_RECEIPT_SIGNING_KEY, which the web build never sees.
// - KLETIA_RECEIPT_KEYSET: the earlier keys, the exact value the API has
//   (retired and revoked entries; anything else is ignored, as the API does).
// - KLETIA_RECEIPT_NEXT_KEY: optional, the announced next key (only with an
//   explicit notBefore, so both origins agree on it).
// - KLETIA_RECEIPT_ATTESTERS: optional JSON array of the EAS attesters
//   GET /v1/receipts/keys lists (`{ type, chain, address, schemaUid, status }`).
//
// Fails the build (fail closed) when any input carries private material (a
// `d` member, a PEM block), when a private receipt or attester key is in the
// build environment at all, when the active key is malformed, has no
// notBefore or is also listed in the key set (the API then refuses to sign),
// and, with KLETIA_RELEASE=1, when there is no active key or an input had to
// be ignored. Without any variable the mirror is empty, like the file in
// public/ that the development server serves.
//
// Node built-ins only. Usage: node scripts/write-receipt-keys.mjs [distDir]
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RECEIPT_KEYS_FILE = ".well-known/kletia-receipt-keys.json";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const CHAIN = /^eip155:[1-9][0-9]{0,15}$/u;
/** Environment variables that hold private receipt material: they belong to the API only. */
export const PRIVATE_VARIABLES = Object.freeze(["KLETIA_RECEIPT_SIGNING_KEY", "KLETIA_EAS_ATTESTER_KEY"]);

export class ReceiptMirrorError extends Error {}

function validDay(value) {
  return typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** RFC 7638 thumbprint of an Ed25519 `x`: the receipt `kid` (as @kletia/core receiptKeyId computes it). */
export function receiptKid(x) {
  return createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest("base64url");
}

/** Throws when `value` (any JSON) carries private key material: a `d` member anywhere or a PEM block. */
function assertPublicOnly(value, label) {
  const visit = (node) => {
    if (typeof node === "string") {
      if (/-----BEGIN|PRIVATE KEY/u.test(node)) throw new ReceiptMirrorError(`${label} contains a PEM block. The web build takes public keys only; nothing was written.`);
      return;
    }
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === "object") {
      if (Object.prototype.hasOwnProperty.call(node, "d")) throw new ReceiptMirrorError(`${label} contains a private key member (d). The web build takes public keys only; nothing was written.`);
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReceiptMirrorError(`${label} is not valid JSON.`);
  }
}

/**
 * One public key entry, with the API's rules (signer.ts publicKeyEntry):
 * OKP/Ed25519, a 32-byte base64url x on the curve, a kid that matches,
 * notBefore and revokedOn as days, revokedOn for a revoked key. A string
 * when it is refused.
 */
export function publicKeyEntry(input, status, fallbackNotBefore) {
  const record = typeof input === "string" ? { x: input } : input;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return "not an object";
  if (record.kty !== undefined && record.kty !== "OKP") return "kty must be OKP";
  if (record.crv !== undefined && record.crv !== "Ed25519") return "crv must be Ed25519";
  const x = record.x;
  if (typeof x !== "string" || !B64URL_32.test(x) || Buffer.from(x, "base64url").length !== 32) return "x must be a base64url 32-byte Ed25519 public key";
  try {
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch {
    return "x is not an Ed25519 public key";
  }
  const kid = receiptKid(x);
  if (record.kid !== undefined && record.kid !== kid) return "kid does not match the key's RFC 7638 thumbprint";
  const notBefore = record.notBefore ?? fallbackNotBefore;
  if (!validDay(notBefore)) return "notBefore must be YYYY-MM-DD";
  if (record.revokedOn !== undefined && !validDay(record.revokedOn)) return "revokedOn must be YYYY-MM-DD";
  if (status === "revoked" && record.revokedOn === undefined) return "a revoked key needs revokedOn";
  return {
    kty: "OKP",
    crv: "Ed25519",
    x,
    kid,
    alg: "Ed25519",
    use: "sig",
    status,
    notBefore,
    ...(typeof record.revokedOn === "string" ? { revokedOn: record.revokedOn } : {}),
  };
}

function attesterEntry(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "not an object";
  const address = typeof input.address === "string" ? input.address.toLowerCase() : "";
  const schemaUid = typeof input.schemaUid === "string" ? input.schemaUid.toLowerCase() : "";
  if ((input.type ?? "eas") !== "eas") return "type must be eas";
  if (typeof input.chain !== "string" || !CHAIN.test(input.chain)) return "chain must be eip155:<chain id>";
  if (!ADDRESS.test(address)) return "address must be 0x followed by 40 hex characters";
  if (!BYTES32.test(schemaUid)) return "schemaUid must be 0x followed by 64 hex characters";
  if ((input.status ?? "active") !== "active") return "status must be active";
  return { type: "eas", chain: input.chain, address, schemaUid, status: "active" };
}

/**
 * The mirror document for an environment: `{ document, warnings }`. Throws
 * ReceiptMirrorError for every condition that must fail the build.
 */
export function buildReceiptMirror(env = process.env) {
  const warnings = [];
  const release = env.KLETIA_RELEASE === "1";
  for (const name of PRIVATE_VARIABLES) {
    if (env[name]?.trim()) throw new ReceiptMirrorError(`${name} is set in the web build environment. It is private and belongs to the API only; remove it from the web service. Nothing was written.`);
  }
  for (const name of ["KLETIA_RECEIPT_PUBLIC_KEY", "KLETIA_RECEIPT_KEYSET", "KLETIA_RECEIPT_NEXT_KEY", "KLETIA_RECEIPT_ATTESTERS"]) {
    const raw = env[name]?.trim();
    if (raw && /-----BEGIN|PRIVATE KEY/u.test(raw)) throw new ReceiptMirrorError(`${name} contains a PEM block. The web build takes public keys only; nothing was written.`);
  }

  const keys = [];
  // Earlier keys, exactly as the API reads them: an array of retired or revoked entries; anything else ignored.
  const keysetRaw = env.KLETIA_RECEIPT_KEYSET?.trim();
  if (keysetRaw) {
    let keyset = null;
    try {
      keyset = JSON.parse(keysetRaw);
    } catch {
      keyset = null;
    }
    if (keyset !== null) assertPublicOnly(keyset, "KLETIA_RECEIPT_KEYSET");
    if (!Array.isArray(keyset)) warnings.push("KLETIA_RECEIPT_KEYSET must be a JSON array; it was ignored (the API ignores it too).");
    else {
      keyset.forEach((entry, index) => {
        const status = entry?.status;
        if (status !== "retired" && status !== "revoked") {
          warnings.push(`KLETIA_RECEIPT_KEYSET[${index}]: status must be retired or revoked; ignored.`);
          return;
        }
        const parsed = publicKeyEntry(entry, status, "");
        if (typeof parsed === "string") warnings.push(`KLETIA_RECEIPT_KEYSET[${index}]: ${parsed}; ignored.`);
        else if (keys.some((key) => key.kid === parsed.kid)) warnings.push(`KLETIA_RECEIPT_KEYSET[${index}]: listed twice; ignored.`);
        else keys.push(parsed);
      });
    }
  }

  // The active key: its public part only.
  const activeRaw = env.KLETIA_RECEIPT_PUBLIC_KEY?.trim();
  if (activeRaw) {
    const input = activeRaw.startsWith("{") ? parseJson(activeRaw, "KLETIA_RECEIPT_PUBLIC_KEY") : activeRaw;
    assertPublicOnly(input, "KLETIA_RECEIPT_PUBLIC_KEY");
    const notBefore = env.KLETIA_RECEIPT_KEY_NOT_BEFORE?.trim() || undefined;
    if ((typeof input === "string" || input?.notBefore === undefined) && !notBefore) {
      throw new ReceiptMirrorError("KLETIA_RECEIPT_PUBLIC_KEY has no notBefore: add it to the JSON or set KLETIA_RECEIPT_KEY_NOT_BEFORE to the API's value (both origins must agree).");
    }
    const active = publicKeyEntry(input, "active", notBefore);
    if (typeof active === "string") throw new ReceiptMirrorError(`KLETIA_RECEIPT_PUBLIC_KEY: ${active}.`);
    if (typeof input === "object" && input.notBefore !== undefined && notBefore !== undefined && input.notBefore !== notBefore) {
      throw new ReceiptMirrorError("KLETIA_RECEIPT_PUBLIC_KEY.notBefore differs from KLETIA_RECEIPT_KEY_NOT_BEFORE.");
    }
    if (keys.some((key) => key.kid === active.kid)) {
      throw new ReceiptMirrorError("The active receipt key is also listed in KLETIA_RECEIPT_KEYSET: the API refuses to sign with it. Remove it from the key set.");
    }
    keys.unshift(active);
  } else if (release) {
    throw new ReceiptMirrorError("KLETIA_RELEASE=1 but KLETIA_RECEIPT_PUBLIC_KEY is not set: every hosted receipt would say it does not check out. Set the active public key.");
  }

  // The next key, announced before it signs.
  const nextRaw = env.KLETIA_RECEIPT_NEXT_KEY?.trim();
  if (nextRaw) {
    const input = nextRaw.startsWith("{") ? parseJson(nextRaw, "KLETIA_RECEIPT_NEXT_KEY") : nextRaw;
    assertPublicOnly(input, "KLETIA_RECEIPT_NEXT_KEY");
    if (typeof input === "string" || input?.notBefore === undefined) {
      warnings.push("KLETIA_RECEIPT_NEXT_KEY has no notBefore, so the API dates it by its own start day; it is left out of the mirror (give it an explicit notBefore).");
    } else {
      const next = publicKeyEntry(input, "next", undefined);
      if (typeof next === "string") warnings.push(`KLETIA_RECEIPT_NEXT_KEY: ${next}; ignored.`);
      else if (keys.some((key) => key.kid === next.kid)) warnings.push("KLETIA_RECEIPT_NEXT_KEY is already in the key set; ignored.");
      else keys.push(next);
    }
  }

  const attesters = [];
  const attestersRaw = env.KLETIA_RECEIPT_ATTESTERS?.trim();
  if (attestersRaw) {
    const list = parseJson(attestersRaw, "KLETIA_RECEIPT_ATTESTERS");
    assertPublicOnly(list, "KLETIA_RECEIPT_ATTESTERS");
    if (!Array.isArray(list)) throw new ReceiptMirrorError("KLETIA_RECEIPT_ATTESTERS must be a JSON array.");
    list.forEach((entry, index) => {
      const parsed = attesterEntry(entry);
      if (typeof parsed === "string") throw new ReceiptMirrorError(`KLETIA_RECEIPT_ATTESTERS[${index}]: ${parsed}.`);
      attesters.push(parsed);
    });
  }

  if (release && warnings.length > 0) {
    throw new ReceiptMirrorError(`KLETIA_RELEASE=1 and the receipt key inputs have problems:\n- ${warnings.join("\n- ")}`);
  }
  return { document: { keys, attesters }, warnings };
}

/** Writes `<distDir>/.well-known/kletia-receipt-keys.json`; returns what was written. */
export function writeReceiptKeys({ distDir = resolve(webRoot, "dist"), env = process.env } = {}) {
  const result = buildReceiptMirror(env);
  const target = resolve(distDir, RECEIPT_KEYS_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result.document, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { document, warnings } = writeReceiptKeys(process.argv[2] ? { distDir: resolve(process.argv[2]) } : {});
    for (const warning of warnings) console.warn(`write-receipt-keys: ${warning}`);
    const active = document.keys.find((key) => key.status === "active");
    console.log(
      `Receipt key mirror written: ${document.keys.length} key(s)${active ? `, active ${active.kid}` : ", no active key (receipts will not check out until KLETIA_RECEIPT_PUBLIC_KEY is set)"}, ${document.attesters.length} attester(s).`,
    );
  } catch (error) {
    console.error(`write-receipt-keys: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
