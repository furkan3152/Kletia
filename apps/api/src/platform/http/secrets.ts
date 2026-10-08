/**
 * Secret material for the public API: unbiased base62 tokens, SHA-256
 * digests and AES-256-GCM sealing of webhook signing secrets.
 *
 * The sealing key is sha256(KLETIA_PLATFORM_SECRET). In production the
 * variable is required (at least 32 characters); without it webhooks fail
 * closed. The same holds whenever KLETIA_DATABASE_URL is set: sealed secrets
 * are persisted there, and a key published in this source file would make
 * them plaintext to anyone holding a database copy. Only a development
 * process with in-memory stores falls back to a fixed development key (with
 * a warning).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { platformDatabaseUrl } from "./db.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Largest multiple of 62 below 256: bytes at or above it are rejected to avoid modulo bias. */
const BASE62_CEILING = 248;

export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= BASE62_CEILING) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type PlatformSecretStatus = "configured" | "development_fallback" | "missing";

const DEVELOPMENT_SECRET = "kletia-development-platform-secret-do-not-use-in-production";
const MIN_PRODUCTION_SECRET_LENGTH = 32;

interface SealingKey {
  readonly status: PlatformSecretStatus;
  readonly key: Buffer | null;
}

let sealing: SealingKey | null = null;

function resolveSealingKey(): SealingKey {
  if (sealing) return sealing;
  const configured = process.env.KLETIA_PLATFORM_SECRET?.trim() ?? "";
  const production = process.env.NODE_ENV === "production";
  const persisted = platformDatabaseUrl() !== null;
  if (configured && (!production || configured.length >= MIN_PRODUCTION_SECRET_LENGTH)) {
    sealing = { status: "configured", key: createHash("sha256").update(configured, "utf8").digest() };
  } else if (production || persisted) {
    console.error(
      configured
        ? `[platform] KLETIA_PLATFORM_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters; webhooks are disabled.`
        : `[platform] KLETIA_PLATFORM_SECRET is not set${persisted && !production ? " (required when KLETIA_DATABASE_URL is set)" : ""}; webhooks are disabled until it is configured.`,
    );
    sealing = { status: "missing", key: null };
  } else {
    console.warn("[platform] KLETIA_PLATFORM_SECRET is not set; using the development sealing key for webhook secrets.");
    sealing = { status: "development_fallback", key: createHash("sha256").update(DEVELOPMENT_SECRET, "utf8").digest() };
  }
  return sealing;
}

export function platformSecretStatus(): PlatformSecretStatus {
  return resolveSealingKey().status;
}

/** True when webhook secrets can be sealed and opened. */
export function sealingAvailable(): boolean {
  return resolveSealingKey().key !== null;
}

function requireKey(): Buffer {
  const { key } = resolveSealingKey();
  if (!key) throw new Error("Platform sealing key is not configured.");
  return key;
}

/**
 * AES-256-GCM with a random 96-bit IV. `context` is authenticated (AAD), so a
 * sealed value only opens for the record it was sealed for.
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
 */
export function sealSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openSecret(sealed: string, context: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported sealed secret format.");
  const [, ivPart = "", tagPart = "", dataPart = ""] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed sealed secret.");
  const decipher = createDecipheriv("aes-256-gcm", requireKey(), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}
