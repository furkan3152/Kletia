/**
 * The sign-in message the API builds and the panel shows in a ticket
 * before the wallet prompt. EVM wallets get EIP-4361 text; Solana wallets
 * get the same fields in the "Sign In With Solana" layout:
 *
 *   kletiaai.xyz wants you to sign in with your Solana account:
 *   D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm
 *
 *   Sign in to the Kletia admin panel. …
 *
 *   URI: https://kletiaai.xyz/admin
 *   Version: 1
 *   Nonce: …
 *   Issued At: …
 *   Expiration Time: …
 *
 * The server alone builds and verifies it; the panel reads it only to refuse
 * to ask a wallet to sign text that names another site, another address or a
 * past expiry (a defence against a tampered response). Pure.
 */
import type { AdminWalletKind } from "./types.ts";
import { sameAddress } from "./session.ts";

export interface SignInFields {
  readonly kind: AdminWalletKind;
  readonly domain: string;
  readonly address: string;
  readonly statement: string | null;
  readonly uri: string | null;
  readonly version: string | null;
  readonly chainId: number | null;
  readonly nonce: string | null;
  readonly issuedAt: string | null;
  readonly expirationTime: string | null;
  readonly requestId: string | null;
}

const HEADER = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your (Ethereum|Solana) account:$/u;

const FIELD_KEYS: Readonly<Record<string, keyof SignInFields>> = {
  URI: "uri",
  Version: "version",
  "Chain ID": "chainId",
  Nonce: "nonce",
  "Issued At": "issuedAt",
  "Expiration Time": "expirationTime",
  "Request ID": "requestId",
};

/** Reads the fields of an EIP-4361 or SIWS-style message; null when the text is not one. */
export function parseSignInMessage(message: string): SignInFields | null {
  const lines = message.replace(/\r\n/gu, "\n").split("\n");
  const head = HEADER.exec(lines[0] ?? "");
  if (!head || !lines[1]) return null;
  const kind: AdminWalletKind = head[3] === "Solana" ? "solana" : "evm";
  const fields: Record<string, string | number | null> = {};
  const statement: string[] = [];
  let inFields = false;
  for (const line of lines.slice(2)) {
    const match = /^([A-Za-z][A-Za-z ]*): (.*)$/u.exec(line);
    const key = match ? FIELD_KEYS[match[1] ?? ""] : undefined;
    if (match && key) {
      inFields = true;
      fields[key] = key === "chainId" ? Number.parseInt(match[2] ?? "", 10) : (match[2] ?? null);
      continue;
    }
    if (!inFields && line.trim()) statement.push(line);
  }
  const chainId = typeof fields.chainId === "number" && Number.isSafeInteger(fields.chainId) ? fields.chainId : null;
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  return {
    kind,
    domain: head[2] ?? "",
    address: lines[1].trim(),
    statement: statement.length > 0 ? statement.join(" ") : null,
    uri: text("uri"),
    version: text("version"),
    chainId,
    nonce: text("nonce"),
    issuedAt: text("issuedAt"),
    expirationTime: text("expirationTime"),
    requestId: text("requestId"),
  };
}

export interface SignInExpectation {
  readonly kind: AdminWalletKind;
  /** `window.location.host` of the panel. */
  readonly host: string;
  readonly address: string;
  /** EVM only: the chain id the panel asked for. */
  readonly chainId?: number;
  readonly now: number;
}

/** Problems that stop the panel from asking the wallet to sign (empty when the text is what was asked for). */
export function signInProblems(fields: SignInFields | null, expected: SignInExpectation): string[] {
  if (!fields) return ["The API sent a sign-in message the panel cannot read."];
  const problems: string[] = [];
  if (fields.kind !== expected.kind) problems.push(`The message is for ${fields.kind === "evm" ? "an Ethereum" : "a Solana"} account, not the wallet you chose.`);
  if (fields.domain !== expected.host) problems.push(`The message names ${fields.domain}, not ${expected.host}.`);
  if (!sameAddress(expected.kind, fields.address, expected.address)) problems.push("The message names another address than the connected wallet.");
  if (expected.kind === "evm" && expected.chainId !== undefined && fields.chainId !== expected.chainId) problems.push("The message names another chain than the one asked for.");
  if (!fields.nonce) problems.push("The message has no nonce.");
  const expiry = fields.expirationTime ? Date.parse(fields.expirationTime) : Number.NaN;
  if (!Number.isFinite(expiry)) problems.push("The message has no expiry.");
  else if (expiry <= expected.now) problems.push("The message has already expired. Start again.");
  return problems;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet), the encoding Solana uses for keys and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += (digits[digit] ?? 0) << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) out += BASE58_ALPHABET[digits[index] ?? 0];
  return out;
}

/** UTF-8 bytes of the exact message text (what a Solana wallet's `signMessage` signs). */
export function messageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}
