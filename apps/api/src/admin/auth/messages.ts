/**
 * Sign-in and confirmation messages. The server builds every message and
 * stores its exact text with the nonce; the wallet signs exactly that text.
 *
 * - EVM: EIP-4361 (Sign-In with Ethereum) built with viem/siwe.
 * - Solana: the Sign-In With Solana text form (same fields as EIP-4361:
 *   domain, address, statement, URI, version, chain id, nonce, issued at,
 *   expiration time, request id), signed with the wallet's signMessage.
 * - Confirmation (step-up for writes that change defaults): a plain text
 *   message bound to the action, network, payload hash, address and nonce.
 */
import { ADMIN_SIGN_IN_REQUEST_ID, ADMIN_SIGN_IN_STATEMENT, canonicalJson } from "@kletia/core";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { sha256Hex } from "../../platform/http/secrets.js";

export interface LoginMessageInput {
  readonly origin: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export function buildEvmLoginMessage(input: LoginMessageInput & { readonly chainId: number }): string {
  return createSiweMessage({
    domain: new URL(input.origin).host,
    address: input.address as Address,
    statement: ADMIN_SIGN_IN_STATEMENT,
    uri: `${input.origin}/admin`,
    version: "1",
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expirationTime: input.expiresAt,
    requestId: ADMIN_SIGN_IN_REQUEST_ID,
  });
}

export function buildSolanaLoginMessage(input: LoginMessageInput): string {
  return [
    `${new URL(input.origin).host} wants you to sign in with your Solana account:`,
    input.address,
    "",
    ADMIN_SIGN_IN_STATEMENT,
    "",
    `URI: ${input.origin}/admin`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
    `Request ID: ${ADMIN_SIGN_IN_REQUEST_ID}`,
  ].join("\n");
}

export interface ConfirmationMessageInput {
  readonly action: string;
  readonly network: string | null;
  readonly payloadSha256: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
}

export function buildConfirmationMessage(input: ConfirmationMessageInput): string {
  return [
    "Kletia admin confirmation",
    `Action: ${input.action}`,
    ...(input.network ? [`Network: ${input.network}`] : []),
    `Payload-SHA256: ${input.payloadSha256}`,
    `Address: ${input.address}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
  ].join("\n");
}

/** The single `Nonce: <value>` line of a message, or null. */
export function extractNonce(message: string): string | null {
  const matches = [...message.matchAll(/^Nonce: ([A-Za-z0-9]{8,64})$/gmu)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

/** Value of a `Name: value` line, or null when absent or repeated. */
export function messageField(message: string, name: string): string | null {
  const lines = message.split("\n").filter((line) => line.startsWith(`${name}: `));
  return lines.length === 1 ? (lines[0] as string).slice(name.length + 2) : null;
}

/** sha256 hex of the canonical JSON of a confirmed payload (the request body without `confirmation`). */
export function payloadSha256(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
