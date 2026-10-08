/**
 * Webhook signatures: `Kletia-Signature: t=<unix>,v1=<hex hmac-sha256>` over
 * `${t}.${rawBody}`. Implemented on Web Crypto so it runs in Node 20+,
 * browsers and edge runtimes alike.
 */

export const WEBHOOK_SIGNATURE_HEADER = "kletia-signature";
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto is not available in this runtime.");
  return crypto.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await subtle().sign("HMAC", key, encoder.encode(message)));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export async function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export interface WebhookVerification {
  readonly valid: boolean;
  readonly reason?: "malformed" | "expired" | "mismatch";
  readonly timestamp?: number;
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<WebhookVerification> {
  if (!header) return { valid: false, reason: "malformed" };
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key = "", ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isSafeInteger(timestamp) || !signature || !/^[0-9a-f]{64}$/u.test(signature)) {
    return { valid: false, reason: "malformed" };
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: "expired", timestamp };
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqualHex(expected, signature)
    ? { valid: true, timestamp }
    : { valid: false, reason: "mismatch", timestamp };
}
