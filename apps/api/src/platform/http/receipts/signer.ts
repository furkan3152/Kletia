/**
 * Receipt signing keys (receipts design §5.4, §8).
 *
 * - `KLETIA_RECEIPT_SIGNING_KEY`: base64url 32-byte Ed25519 seed, or a PKCS#8
 *   PEM Ed25519 private key. Refused when it equals or is derived from
 *   KLETIA_PLATFORM_SECRET (the sealing key is sha256 of that secret).
 * - `KLETIA_RECEIPT_KEY_NOT_BEFORE`: first UTC day (YYYY-MM-DD) the active key
 *   may sign. Required in production: a default would move with restarts and
 *   make earlier receipts look signed before the key existed.
 * - `KLETIA_RECEIPT_KEYSET`: JSON array of earlier public keys
 *   (`{ x, status: "retired" | "revoked", notBefore, revokedOn? }`).
 * - `KLETIA_RECEIPT_NEXT_KEY`: the next public key (`{ x, notBefore? }` or a
 *   JWK), announced as `status: "next"` before it signs anything.
 * - `KLETIA_RECEIPTS_ENABLED=false`: kill switch (nothing is issued; reads and
 *   the key set keep working).
 * - `KLETIA_EAS_ATTESTER_KEY`: optional secp256k1 key (0x + 64 hex, no funds)
 *   for EAS offchain envelopes; never a user key, never a gas wallet.
 *
 * Without a signing key a development process signs with an ephemeral key
 * (`status: "development"`, boot warning); production reports
 * `signer: "missing"` and keeps queueing until a key is configured.
 *
 * Signing goes through `ReceiptSigner` (64-byte RFC 8032 signatures), so a
 * remote signer (KMS or HSM) can replace the environment key
 * (`configureReceiptSigner`). The key never leaves this module and is never
 * logged.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, timingSafeEqual, type KeyObject } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base64UrlDecode, receiptKeyId, type ReceiptKey } from "@kletia/core";

export type ReceiptSignerStatus = "configured" | "development" | "missing" | "disabled";

/** Signs receipt and log signing inputs (ASCII) with an Ed25519 key. */
export interface ReceiptSigner {
  readonly kid: string;
  /** The public key as published (status `active`, or `development` for an ephemeral key). */
  readonly publicKey: ReceiptKey;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface ReceiptKeyring {
  readonly status: ReceiptSignerStatus;
  /** Null when no key may sign (missing, refused, revoked). Present but unused when disabled. */
  readonly signer: ReceiptSigner | null;
  /** Every published public key: active or development, next, retired and revoked. */
  readonly keys: readonly ReceiptKey[];
  /** Configuration problems (logged once at boot; never contain key material). */
  readonly problems: readonly string[];
  readonly attester: EasAttester | null;
}

export interface EasAttester {
  readonly address: string;
  readonly account: PrivateKeyAccount;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function utcDay(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

function validDay(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Receipts are on unless KLETIA_RECEIPTS_ENABLED is false/0/off. */
export function receiptsEnabled(): boolean {
  const raw = process.env.KLETIA_RECEIPTS_ENABLED?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

class LocalSigner implements ReceiptSigner {
  readonly kid: string;
  readonly publicKey: ReceiptKey;

  constructor(private readonly key: KeyObject, status: "active" | "development", notBefore: string) {
    const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
    if (typeof jwk.x !== "string") throw new Error("The receipt key has no public part.");
    this.kid = receiptKeyId(jwk.x);
    this.publicKey = Object.freeze({ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: this.kid, alg: "Ed25519", use: "sig", status, notBefore });
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(nodeSign(null, Buffer.from(message), this.key));
  }
}

/** A local signer from a 32-byte seed (tests, operators' tooling). */
export function signerFromSeed(seed: Uint8Array, options: { readonly status?: "active" | "development"; readonly notBefore?: string } = {}): ReceiptSigner {
  if (seed.length !== 32) throw new Error("An Ed25519 seed is 32 bytes.");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return new LocalSigner(key, options.status ?? "active", options.notBefore ?? utcDay());
}

/** Seed bytes of the configured key (for the derivation check), or the PEM key; null when unreadable. */
function parseSigningKey(raw: string): { key: KeyObject; seed: Buffer | null } | null {
  try {
    if (raw.includes("-----BEGIN")) {
      const key = createPrivateKey(raw);
      if (key.asymmetricKeyType !== "ed25519") return null;
      const der = key.export({ format: "der", type: "pkcs8" });
      const seed = der.length === 48 && der.subarray(0, 16).equals(PKCS8_ED25519_PREFIX) ? Buffer.from(der.subarray(16)) : null;
      return { key, seed };
    }
    const seed = base64UrlDecode(raw);
    if (!seed || seed.length !== 32) return null;
    const buffer = Buffer.from(seed);
    return { key: createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, buffer]), format: "der", type: "pkcs8" }), seed: buffer };
  } catch {
    return null;
  }
}

function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the receipt key equals the platform secret or is derived from it (its SHA-256, its bytes, its base64url decoding). */
function derivedFromPlatformSecret(raw: string, seed: Buffer | null): boolean {
  const secret = process.env.KLETIA_PLATFORM_SECRET?.trim();
  if (!secret) return false;
  if (raw === secret) return true;
  if (!seed) return false;
  const candidates = [createHash("sha256").update(secret, "utf8").digest(), Buffer.from(secret, "utf8")];
  const decoded = base64UrlDecode(secret);
  if (decoded) candidates.push(Buffer.from(decoded));
  if (/^(?:0x)?[0-9a-fA-F]{64}$/u.test(secret)) candidates.push(Buffer.from(secret.replace(/^0x/u, ""), "hex"));
  return candidates.some((candidate) => equalBytes(candidate.subarray(0, 32), seed) && candidate.length >= 32);
}

function publicKeyEntry(input: unknown, status: ReceiptKey["status"], fallbackNotBefore: string): ReceiptKey | string {
  const record = typeof input === "string" ? { x: input } : input;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return "not an object";
  const entry = record as Record<string, unknown>;
  if (entry.kty !== undefined && entry.kty !== "OKP") return "kty must be OKP";
  if (entry.crv !== undefined && entry.crv !== "Ed25519") return "crv must be Ed25519";
  const x = entry.x;
  if (typeof x !== "string" || !B64URL_32.test(x) || base64UrlDecode(x)?.length !== 32) return "x must be a base64url 32-byte Ed25519 public key";
  const kid = receiptKeyId(x);
  if (entry.kid !== undefined && entry.kid !== kid) return "kid does not match the key's RFC 7638 thumbprint";
  const notBefore = entry.notBefore ?? fallbackNotBefore;
  if (!validDay(notBefore)) return "notBefore must be YYYY-MM-DD";
  if (entry.revokedOn !== undefined && !validDay(entry.revokedOn)) return "revokedOn must be YYYY-MM-DD";
  if (status === "revoked" && entry.revokedOn === undefined) return "a revoked key needs revokedOn";
  return Object.freeze({
    kty: "OKP",
    crv: "Ed25519",
    x,
    kid,
    alg: "Ed25519",
    use: "sig",
    status,
    notBefore,
    ...(typeof entry.revokedOn === "string" ? { revokedOn: entry.revokedOn } : {}),
  });
}

function parseJson(raw: string | undefined): unknown {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function loadAttester(problems: string[]): EasAttester | null {
  const raw = process.env.KLETIA_EAS_ATTESTER_KEY?.trim();
  if (!raw) return null;
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(hex)) {
    problems.push("KLETIA_EAS_ATTESTER_KEY must be 0x followed by 64 hex characters; EAS envelopes are off.");
    return null;
  }
  try {
    const account = privateKeyToAccount(hex as `0x${string}`);
    return { address: account.address.toLowerCase(), account };
  } catch {
    problems.push("KLETIA_EAS_ATTESTER_KEY is not a valid secp256k1 key; EAS envelopes are off.");
    return null;
  }
}

/** Reads the environment into a keyring (pure apart from key generation for development). */
export function loadReceiptKeyring(): ReceiptKeyring {
  const problems: string[] = [];
  const keys: ReceiptKey[] = [];
  const today = utcDay();

  // Earlier keys (retired verify forever; revoked from revokedOn).
  const keyset = parseJson(process.env.KLETIA_RECEIPT_KEYSET);
  if (keyset === null || (keyset !== undefined && !Array.isArray(keyset))) problems.push("KLETIA_RECEIPT_KEYSET must be a JSON array; it was ignored.");
  else if (Array.isArray(keyset)) {
    keyset.forEach((entry, index) => {
      const status = (entry as { status?: unknown } | null)?.status;
      if (status !== "retired" && status !== "revoked") {
        problems.push(`KLETIA_RECEIPT_KEYSET[${index}]: status must be retired or revoked; ignored.`);
        return;
      }
      const parsed = publicKeyEntry(entry, status, "");
      if (typeof parsed === "string") problems.push(`KLETIA_RECEIPT_KEYSET[${index}]: ${parsed}; ignored.`);
      else keys.push(parsed);
    });
  }

  // The configured (or development) signing key.
  let signer: ReceiptSigner | null = null;
  let status: ReceiptSignerStatus = "missing";
  const raw = process.env.KLETIA_RECEIPT_SIGNING_KEY?.trim();
  if (raw) {
    const parsed = parseSigningKey(raw);
    const notBeforeRaw = process.env.KLETIA_RECEIPT_KEY_NOT_BEFORE?.trim();
    if (!parsed) problems.push("KLETIA_RECEIPT_SIGNING_KEY is not a base64url 32-byte Ed25519 seed or an Ed25519 PKCS#8 PEM key; receipts cannot be signed.");
    else if (derivedFromPlatformSecret(raw, parsed.seed)) problems.push("KLETIA_RECEIPT_SIGNING_KEY must not equal or derive from KLETIA_PLATFORM_SECRET; receipts cannot be signed.");
    else if (notBeforeRaw !== undefined && notBeforeRaw !== "" && !validDay(notBeforeRaw)) problems.push("KLETIA_RECEIPT_KEY_NOT_BEFORE must be YYYY-MM-DD; receipts cannot be signed.");
    else if (!notBeforeRaw && production()) problems.push("KLETIA_RECEIPT_KEY_NOT_BEFORE (YYYY-MM-DD) is required with a production receipt key; receipts cannot be signed.");
    else {
      const candidate = new LocalSigner(parsed.key, "active", notBeforeRaw || today);
      const listed = keys.find((key) => key.kid === candidate.kid);
      if (listed?.status === "revoked") problems.push("The configured receipt key is listed as revoked in KLETIA_RECEIPT_KEYSET; it will not sign.");
      else if (listed) problems.push("The configured receipt key is also listed in KLETIA_RECEIPT_KEYSET; remove it from there.");
      else {
        signer = candidate;
        status = "configured";
      }
    }
  } else if (!production()) {
    const { privateKey } = generateKeyPairSync("ed25519");
    signer = new LocalSigner(privateKey, "development", today);
    status = "development";
    problems.push("KLETIA_RECEIPT_SIGNING_KEY is not set; receipts are signed with an ephemeral development key (verifiers warn KEY_DEVELOPMENT).");
  } else {
    problems.push("KLETIA_RECEIPT_SIGNING_KEY is not set; receipts queue until a key is configured.");
  }
  if (signer) keys.unshift(signer.publicKey);

  // The next key, announced before it signs.
  const nextRaw = process.env.KLETIA_RECEIPT_NEXT_KEY?.trim();
  if (nextRaw) {
    const next = publicKeyEntry(nextRaw.startsWith("{") ? parseJson(nextRaw) : nextRaw, "next", today);
    if (typeof next === "string") problems.push(`KLETIA_RECEIPT_NEXT_KEY: ${next}; ignored.`);
    else if (keys.some((key) => key.kid === next.kid)) problems.push("KLETIA_RECEIPT_NEXT_KEY is already in the key set; ignored.");
    else keys.push(next);
  }

  if (!receiptsEnabled()) status = "disabled";
  return { status, signer, keys: Object.freeze(keys), problems: Object.freeze(problems), attester: loadAttester(problems) };
}

/* ------------------------------------------------------------ process state */

let keyring: ReceiptKeyring | null = null;
let override: { readonly signer: ReceiptSigner | null; readonly keys?: readonly ReceiptKey[] } | null = null;

/** The process keyring (resolved once; problems are logged once). */
export function receiptKeyring(): ReceiptKeyring {
  if (!keyring) {
    keyring = loadReceiptKeyring();
    for (const problem of keyring.problems) {
      if (keyring.status === "development" || problem.includes("ignored") || problem.includes("EAS")) console.warn(`[platform] receipts: ${problem}`);
      else console.error(`[platform] receipts: ${problem}`);
    }
  }
  if (!override) return keyring;
  const signer = override.signer;
  const keys = override.keys ?? [...(signer ? [signer.publicKey] : []), ...keyring.keys.filter((key) => key.status !== "active" && key.status !== "development")];
  return {
    status: !receiptsEnabled() ? "disabled" : signer ? (signer.publicKey.status === "development" ? "development" : "configured") : "missing",
    signer,
    keys,
    problems: keyring.problems,
    attester: keyring.attester,
  };
}

/**
 * Replaces the signer (a remote KMS/HSM signer, tests). `keys` replaces the
 * published set (default: the signer's key plus the environment's other
 * keys). `null` restores the environment configuration.
 */
export function configureReceiptSigner(signer: ReceiptSigner | null, options: { readonly keys?: readonly ReceiptKey[]; readonly reload?: boolean } = {}): void {
  if (options.reload) keyring = null;
  override = signer === null && !options.keys ? null : { signer, ...(options.keys ? { keys: options.keys } : {}) };
}

/** Forgets the resolved keyring and any override (tests that change the environment). */
export function resetReceiptKeyring(): void {
  keyring = null;
  override = null;
}

/** The signer allowed to issue now, or null (missing, refused, kill switch). */
export function activeReceiptSigner(): ReceiptSigner | null {
  const ring = receiptKeyring();
  return ring.status === "configured" || ring.status === "development" ? ring.signer : null;
}

export function receiptSignerStatus(): ReceiptSignerStatus {
  return receiptKeyring().status;
}

/** Published keys (GET /v1/receipts/keys; self-verification). */
export function receiptKeys(): readonly ReceiptKey[] {
  return receiptKeyring().keys;
}

export function easAttester(): EasAttester | null {
  return receiptKeyring().attester;
}
