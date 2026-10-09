/**
 * Receipt shares (receipts design §5.9, §9.2).
 *
 *   key        = 32 random bytes (returned once in the link, never stored)
 *   iv         = 12 random bytes
 *   plaintext  = UTF8(JCS({ receiptId, shareId, disclosures: { <selected paths> } }))
 *   ciphertext = AES-256-GCM(key, iv, plaintext, aad = "kletia.receipt-share.v1:" + receiptId + ":" + shareId)
 *   stored     = base64url(iv || ciphertext || tag)
 *   link       = <web origin>/r/<receiptId>#s=<shareId>&k=<base64url key>
 *
 * The fragment never reaches a server, so a database copy or an access log
 * never holds readable disclosures for a share. Kletia built the plaintext,
 * so this is not zero-knowledge; it keeps stored shares unreadable.
 * Shares are off by default, revocable, expire (30 days by default, 1 hour to
 * 365 days, or never when the owner asks) and limited to 10 active per receipt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  RECEIPT_ID_PATTERN,
  RECEIPT_PROFILES,
  RECEIPT_SHARE_AAD_PREFIX,
  RECEIPT_SHARE_ID_PATTERN,
  receiptGroupPaths,
  receiptGroupSlots,
  receiptJcs,
  selectReceiptDisclosures,
  type ReceiptDisclosure,
  type ReceiptPayload,
  type ReceiptProfile,
} from "@kletia/core";
import { invalidRequest, isRecord } from "../context.js";

export const DEFAULT_SHARE_SECONDS = 30 * 86_400;
export const MIN_SHARE_SECONDS = 3_600;
export const MAX_SHARE_SECONDS = 31_536_000;
const MAX_GROUP_PATTERNS = 64;
const GROUP_PATTERN = /^(?:intent\.(?:request|plan|timing|outcome)|steps\.(?:\*|[A-Za-z0-9_-]{1,32})\.(?:parties|amounts|evidence))$/u;

export interface ShareRequest {
  /** A profile name or explicit group paths/patterns (`steps.*.evidence`); default profile `route` (skeleton only). */
  readonly selection: { readonly profile: ReceiptProfile } | { readonly groups: readonly string[] };
  readonly sequence?: number;
  /** Seconds, or null for a share that never expires. */
  readonly expiresInSeconds: number | null;
}

/** Validates `{ profile?, groups?, sequence?, expiresInSeconds? }`. */
export function parseShareRequest(body: unknown): ShareRequest {
  const value = body === undefined || body === null ? {} : body;
  if (!isRecord(value)) throw invalidRequest("Body must be { \"profile\"?: \"route\" | \"amounts\" | \"proof\" | \"full\", \"groups\"?: [...], \"sequence\"?: n, \"expiresInSeconds\"?: n | null }.", [{ path: "", message: "Expected an object." }]);
  const issues: { path: string; message: string }[] = [];
  for (const key of Object.keys(value)) {
    if (!["profile", "groups", "sequence", "expiresInSeconds"].includes(key)) issues.push({ path: key, message: "Unknown field. Allowed: profile, groups, sequence, expiresInSeconds." });
  }
  if (value.profile !== undefined && value.groups !== undefined) issues.push({ path: "groups", message: "Send either profile or groups, not both." });
  let selection: ShareRequest["selection"] = { profile: "route" };
  if (value.profile !== undefined) {
    if (typeof value.profile !== "string" || !(value.profile in RECEIPT_PROFILES)) issues.push({ path: "profile", message: "Expected route, amounts, proof or full." });
    else selection = { profile: value.profile as ReceiptProfile };
  } else if (value.groups !== undefined) {
    const groups: unknown = value.groups;
    if (!Array.isArray(groups) || groups.length > MAX_GROUP_PATTERNS) issues.push({ path: "groups", message: `Expected a list of at most ${MAX_GROUP_PATTERNS} group paths.` });
    else {
      groups.forEach((group, index) => {
        if (typeof group !== "string" || !GROUP_PATTERN.test(group)) {
          issues.push({ path: `groups[${index}]`, message: "Expected intent.request|plan|timing|outcome or steps.<step id or *>.parties|amounts|evidence." });
        }
      });
      selection = { groups: [...new Set(groups.filter((group): group is string => typeof group === "string"))] };
    }
  }
  let sequence: number | undefined;
  if (value.sequence !== undefined) {
    if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) issues.push({ path: "sequence", message: "Expected a positive integer." });
    else sequence = value.sequence;
  }
  let expiresInSeconds: number | null = DEFAULT_SHARE_SECONDS;
  if (value.expiresInSeconds === null) expiresInSeconds = null;
  else if (value.expiresInSeconds !== undefined) {
    const seconds = value.expiresInSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < MIN_SHARE_SECONDS || seconds > MAX_SHARE_SECONDS) {
      issues.push({ path: "expiresInSeconds", message: `Expected ${MIN_SHARE_SECONDS}-${MAX_SHARE_SECONDS} seconds, or null for no expiry.` });
    } else expiresInSeconds = seconds;
  }
  if (issues.length > 0) throw invalidRequest("The share request is invalid.", issues);
  return { selection, ...(sequence !== undefined ? { sequence } : {}), expiresInSeconds };
}

/** The concrete group paths a share discloses for one payload; a pattern that matches nothing is refused. */
export function shareGroups(request: ShareRequest, payload: Pick<ReceiptPayload, "steps">): string[] {
  if ("profile" in request.selection) return receiptGroupPaths(request.selection.profile, payload);
  const slots = receiptGroupSlots(payload);
  const issues: { path: string; message: string }[] = [];
  request.selection.groups.forEach((pattern, index) => {
    if (receiptGroupPaths([pattern], payload).length === 0) issues.push({ path: `groups[${index}]`, message: `No group ${pattern} in this receipt (it has ${slots.length} groups).` });
  });
  if (issues.length > 0) throw invalidRequest("groups names parts this receipt does not have.", issues);
  return receiptGroupPaths(request.selection.groups, payload);
}

function aad(receiptId: string, shareId: string): Buffer {
  return Buffer.from(`${RECEIPT_SHARE_AAD_PREFIX}${receiptId}:${shareId}`, "utf8");
}

/** Encrypts the selected disclosures with a fresh key; the key is returned once (base64url) and never stored. */
export function encryptShare(
  receiptId: string,
  shareId: string,
  disclosures: Readonly<Record<string, ReceiptDisclosure>>,
  paths: readonly string[],
): { readonly ciphertext: string; readonly key: string } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = receiptJcs({ receiptId, shareId, disclosures: selectReceiptDisclosures(disclosures, paths) });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(receiptId, shareId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url"), key: key.toString("base64url") };
}

/** Decrypts a stored share with its link key; null when the key, the ids or the ciphertext do not match. */
export function decryptShare(receiptId: string, shareId: string, ciphertext: string, key: string): Record<string, ReceiptDisclosure> | null {
  try {
    const raw = Buffer.from(ciphertext, "base64url");
    const secret = Buffer.from(key, "base64url");
    if (raw.length < 12 + 16 || secret.length !== 32) return null;
    const decipher = createDecipheriv("aes-256-gcm", secret, raw.subarray(0, 12));
    decipher.setAAD(aad(receiptId, shareId));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isRecord(parsed) || parsed.receiptId !== receiptId || parsed.shareId !== shareId || !isRecord(parsed.disclosures)) return null;
    return parsed.disclosures as Record<string, ReceiptDisclosure>;
  } catch {
    return null;
  }
}

/** `<origin>/r/<receiptId>#s=<shareId>&k=<key>`. */
export function shareUrl(webOrigin: string, receiptId: string, shareId: string, key: string): string {
  return `${webOrigin}/r/${receiptId}#s=${shareId}&k=${key}`;
}

/** Parses a share link (any host; only the path and the fragment matter). Null when it is not one. */
export function parseShareUrl(value: string): { readonly receiptId: string; readonly shareId: string; readonly key: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) return null;
  const match = /^\/r\/(rcpt_[0-9a-f]{32})\/?$/u.exec(url.pathname);
  if (!match || url.search) return null;
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const shareId = fragment.get("s") ?? "";
  const key = fragment.get("k") ?? "";
  const receiptId = match[1] as string;
  if (!RECEIPT_ID_PATTERN.test(receiptId) || !RECEIPT_SHARE_ID_PATTERN.test(shareId) || !/^[A-Za-z0-9_-]{43}$/u.test(key)) return null;
  return { receiptId, shareId, key };
}
