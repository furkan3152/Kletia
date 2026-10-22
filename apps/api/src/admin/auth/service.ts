/**
 * Admin authentication: nonces, sign-in with an EVM wallet (EIP-4361) or a
 * Solana wallet (Sign In With Solana text), cookie sessions, step-up
 * confirmations and the audit helper.
 */
import { randomBytes } from "node:crypto";
import {
  ADMIN_CONFIRM_ACTIONS,
  ADMIN_EVM_NETWORKS,
  CHAINS,
  type AdminConfirmAction,
  type AdminEvmNetwork,
  type AdminSessionView,
  type AdminWalletKind,
} from "@kletia/core";
import type { Request, Response } from "express";
import { getAddress, type Address } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { randomBase62, sha256Hex } from "../../platform/http/secrets.js";
import { evmAllowlist, parseEvmAddress, parseSolanaAddress, type AdminConfig } from "../config.js";
import type { AdminDeps, AdminSessionContext } from "../deps.js";
import { AdminHttpError, invalidRequest, requestIdOf } from "../http/errors.js";
import type { AdminNoncePurpose, AdminNonceRecord, AdminSessionRecord } from "../store/types.js";
import {
  buildConfirmationMessage,
  buildEvmLoginMessage,
  buildSolanaLoginMessage,
  extractNonce,
  messageField,
} from "./messages.js";
import { verifyEvmMessageSignature, verifySolanaMessageSignature } from "./signatures.js";

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

/** Actions that require a step-up confirmation signature: every state-changing route except logout. */
export const CONFIRM_ACTIONS = ADMIN_CONFIRM_ACTIONS;
export type ConfirmAction = AdminConfirmAction;

export function networkForChainId(chainId: number): AdminEvmNetwork | null {
  return ADMIN_EVM_NETWORKS.find((network) => CHAINS[network].evmChainId === chainId) ?? null;
}

export function allowedChainIds(): number[] {
  return ADMIN_EVM_NETWORKS.map((network) => CHAINS[network].evmChainId as number);
}

/** Canonical stored form: lower-cased EVM address, base58 Solana address as given. */
export function normalizeAddress(walletKind: AdminWalletKind, address: string): string | null {
  if (walletKind === "evm") return parseEvmAddress(address)?.toLowerCase() ?? null;
  return parseSolanaAddress(address);
}

export function displayAddress(walletKind: AdminWalletKind, stored: string): string {
  return walletKind === "evm" ? getAddress(stored) : stored;
}

export function isAllowlisted(config: AdminConfig, walletKind: AdminWalletKind, stored: string): boolean {
  return walletKind === "evm" ? config.evmAddresses.has(stored) : config.solanaAddresses.has(stored);
}

export function sessionActors(config: AdminConfig, record: AdminSessionRecord): string[] {
  return record.walletKind === "evm" ? [getAddress(record.address)] : evmAllowlist(config);
}

export function sessionView(config: AdminConfig, record: AdminSessionRecord): AdminSessionView {
  const idle = Math.min(record.lastSeenAt.getTime() + SESSION_IDLE_MS, record.expiresAt.getTime());
  return {
    address: displayAddress(record.walletKind, record.address),
    walletKind: record.walletKind,
    chainId: record.chainId,
    expiresAt: record.expiresAt.toISOString(),
    idleExpiresAt: new Date(idle).toISOString(),
    evmActors: sessionActors(config, record),
  };
}

function ipHash(req: Request): string | null {
  return req.ip ? sha256Hex(`kletia-admin-ip:${req.ip}`).slice(0, 32) : null;
}

/** Writes one audit row before the response; a failed write fails the request (503). */
export async function audit(
  deps: AdminDeps, req: Request, res: Response,
  entry: { readonly address: string | null; readonly action: string; readonly outcome: "ok" | "denied" | "error"; readonly target?: Readonly<Record<string, string>> },
): Promise<string> {
  try {
    const written = await deps.store().writeAudit({
      address: entry.address, action: entry.action, outcome: entry.outcome, target: entry.target ?? {},
      requestId: requestIdOf(res), ipHash: ipHash(req),
    }, deps.now());
    return written.id;
  } catch {
    throw new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "The admin audit log could not be written; nothing was changed.");
  }
}

/* ---------------- Nonces ---------------- */

export interface NonceRequestBody {
  readonly walletKind?: AdminWalletKind;
  readonly address: string;
  readonly chainId?: number;
  readonly purpose?: AdminNoncePurpose;
  readonly action?: string;
  readonly network?: string;
  readonly payloadSha256?: string;
}

export async function issueNonce(
  deps: AdminDeps, origin: string, body: NonceRequestBody, session: AdminSessionContext | null,
): Promise<{ message: string; nonce: string; expiresAt: string; walletKind: AdminWalletKind }> {
  const purpose = body.purpose ?? "login";
  const now = deps.now();
  const nonce = randomBase62(24);
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  let walletKind: AdminWalletKind;
  let stored: string;
  let chainId: number | null;
  let message: string;
  if (purpose === "login") {
    walletKind = body.walletKind ?? "evm";
    const normalized = normalizeAddress(walletKind, body.address);
    if (!normalized) throw invalidRequest(walletKind === "evm" ? "address must be an EVM address." : "address must be a Solana address (base58, 32 bytes).");
    stored = normalized;
    if (walletKind === "evm") {
      if (typeof body.chainId !== "number" || !allowedChainIds().includes(body.chainId)) {
        throw invalidRequest(`chainId must be one of ${allowedChainIds().join(", ")}.`);
      }
      chainId = body.chainId;
      message = buildEvmLoginMessage({ origin, address: getAddress(stored), chainId, nonce, issuedAt: now, expiresAt });
    } else {
      chainId = null;
      message = buildSolanaLoginMessage({ origin, address: stored, nonce, issuedAt: now, expiresAt });
    }
  } else {
    if (!session) throw new AdminHttpError(401, "ADMIN_SESSION_REQUIRED", "Sign in before requesting a confirmation.");
    walletKind = session.record.walletKind;
    stored = session.record.address;
    chainId = session.record.chainId;
    const requested = normalizeAddress(walletKind, body.address);
    if (requested !== stored) throw invalidRequest("A confirmation must be signed by the signed-in wallet.");
    if (!body.action || !(CONFIRM_ACTIONS as readonly string[]).includes(body.action)) {
      throw invalidRequest(`action must be one of ${CONFIRM_ACTIONS.join(", ")}.`);
    }
    if (body.network !== undefined && !(ADMIN_EVM_NETWORKS as readonly string[]).includes(body.network)) {
      throw invalidRequest("network must be an EVM network key.");
    }
    if (!body.payloadSha256 || !/^[0-9a-f]{64}$/u.test(body.payloadSha256)) throw invalidRequest("payloadSha256 must be 64 lower-case hex characters.");
    message = buildConfirmationMessage({
      action: body.action, network: body.network ?? null, payloadSha256: body.payloadSha256,
      address: displayAddress(walletKind, stored), nonce, issuedAt: now,
    });
  }
  const record: AdminNonceRecord = {
    nonceHash: sha256Hex(nonce), walletKind, address: stored, chainId, origin, purpose, message, createdAt: now, expiresAt,
  };
  await deps.store().createNonce(record);
  return { message, nonce, expiresAt: expiresAt.toISOString(), walletKind };
}

/** Consumes the nonce named in `message` (single use, before any signature check). */
async function consumeMessageNonce(deps: AdminDeps, message: string, origin: string, purpose: AdminNoncePurpose): Promise<AdminNonceRecord> {
  const nonce = extractNonce(message);
  const invalid = new AdminHttpError(401, "ADMIN_NONCE_INVALID", "The sign-in message is unknown, used or expired. Request a new one.");
  if (!nonce) throw invalid;
  const record = await deps.store().consumeNonce(sha256Hex(nonce), deps.now());
  if (!record) throw invalid;
  if (record.message !== message || record.origin !== origin || record.purpose !== purpose) throw invalid;
  return record;
}

async function verifyRecordSignature(deps: AdminDeps, record: AdminNonceRecord, signature: string): Promise<boolean> {
  if (record.walletKind === "solana") return verifySolanaMessageSignature(record.address, record.message, signature);
  const network = record.chainId === null ? null : networkForChainId(record.chainId);
  if (!network) return false;
  return verifyEvmMessageSignature({
    client: () => deps.client(network), network, address: getAddress(record.address), message: record.message, signature,
  });
}

/* ---------------- Sign-in ---------------- */

/**
 * The address a sign-in message claims (second line), only when it parses as
 * an EVM or Solana address. Unverified: audit context for refused attempts.
 */
export function claimedLoginAddress(message: string): { walletKind: AdminWalletKind; address: string } | null {
  const lines = message.split("\n");
  const head = /wants you to sign in with your (Ethereum|Solana) account:$/u.exec(lines[0] ?? "");
  if (!head) return null;
  const walletKind: AdminWalletKind = head[1] === "Solana" ? "solana" : "evm";
  const normalized = normalizeAddress(walletKind, lines[1] ?? "");
  return normalized ? { walletKind, address: displayAddress(walletKind, normalized) } : null;
}

export interface LoginResult {
  readonly sessionId: string;
  readonly record: AdminSessionRecord;
}

export async function verifyLogin(deps: AdminDeps, req: Request, res: Response, origin: string, message: string, signature: string): Promise<LoginResult> {
  const config = deps.config();
  let record: AdminNonceRecord;
  try {
    record = await consumeMessageNonce(deps, message, origin, "login");
  } catch (error) {
    // Replayed, unknown, expired or altered messages are login attempts too.
    if (error instanceof AdminHttpError && error.code === "ADMIN_NONCE_INVALID") {
      const claimed = claimedLoginAddress(message);
      await audit(deps, req, res, {
        address: claimed?.address ?? null, action: "auth.login.denied", outcome: "denied",
        target: { reason: "nonce", ...(claimed ? { walletKind: claimed.walletKind, claimed: "true" } : {}) },
      });
    }
    throw error;
  }
  const display = displayAddress(record.walletKind, record.address);
  const now = deps.now();
  if (record.walletKind === "evm") {
    const parsed = parseSiweMessage(message);
    const valid = validateSiweMessage({
      message: parsed, domain: new URL(origin).host, address: display as Address, nonce: parsed.nonce, time: now,
    });
    if (!valid || parsed.chainId !== record.chainId) {
      await audit(deps, req, res, { address: display, action: "auth.login.denied", outcome: "denied", target: { reason: "message", walletKind: "evm" } });
      throw new AdminHttpError(401, "ADMIN_NONCE_INVALID", "The sign-in message does not match this origin, address or time.");
    }
  } else if (record.expiresAt.getTime() <= now.getTime()) {
    throw new AdminHttpError(401, "ADMIN_NONCE_INVALID", "The sign-in message expired. Request a new one.");
  }
  const valid = await verifyRecordSignature(deps, record, signature);
  if (!valid) {
    await audit(deps, req, res, { address: display, action: "auth.login.denied", outcome: "denied", target: { reason: "signature", walletKind: record.walletKind } });
    throw new AdminHttpError(401, "ADMIN_SIGNATURE_INVALID", "The signature does not match the sign-in message and wallet.");
  }
  if (!isAllowlisted(config, record.walletKind, record.address)) {
    await audit(deps, req, res, { address: display, action: "auth.login.denied", outcome: "denied", target: { reason: "not_allowed", walletKind: record.walletKind } });
    throw new AdminHttpError(403, "ADMIN_NOT_ALLOWED", "This wallet is not an admin.");
  }
  const sessionId = randomBytes(32).toString("base64url");
  const session: AdminSessionRecord = {
    idHash: sha256Hex(sessionId), walletKind: record.walletKind, address: record.address, chainId: record.chainId,
    origin, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  await audit(deps, req, res, {
    address: display, action: "auth.login", outcome: "ok",
    target: { walletKind: record.walletKind, ...(record.chainId === null ? {} : { chainId: String(record.chainId) }) },
  });
  await deps.store().createSession(session);
  return { sessionId, record: session };
}

/** A valid session for `sessionId` at `origin`, or null (expired, revoked, allowlist shrink, other origin). */
export async function resolveSession(deps: AdminDeps, sessionId: string, origin: string): Promise<AdminSessionContext | null> {
  const config = deps.config();
  const idHash = sha256Hex(sessionId);
  const store = deps.store();
  const record = await store.getSession(idHash);
  if (!record) return null;
  const now = deps.now().getTime();
  const expired = record.expiresAt.getTime() <= now || now - record.lastSeenAt.getTime() > SESSION_IDLE_MS;
  if (expired || !isAllowlisted(config, record.walletKind, record.address)) {
    await store.deleteSession(idHash);
    return null;
  }
  if (record.origin !== origin) return null;
  let current = record;
  if (now - record.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    current = { ...record, lastSeenAt: new Date(now) };
    await store.touchSession(idHash, current.lastSeenAt);
  }
  return {
    idHash, record: current, view: sessionView(config, current), actors: sessionActors(config, current),
    actor: displayAddress(current.walletKind, current.address),
  };
}

/* ---------------- Step-up confirmation ---------------- */

/**
 * Verifies `confirmation` for `action` on `payloadHash`: a single-use confirm
 * nonce of this session's wallet and origin, the exact message, then the
 * wallet's signature. Throws ADMIN_CONFIRMATION_REQUIRED on any mismatch.
 */
export async function verifyConfirmation(
  deps: AdminDeps, session: AdminSessionContext, origin: string,
  expected: { readonly action: ConfirmAction; readonly network: string | null; readonly payloadSha256: string },
  confirmation: unknown,
): Promise<void> {
  const required = (message: string) => new AdminHttpError(403, "ADMIN_CONFIRMATION_REQUIRED", message);
  if (typeof confirmation !== "object" || confirmation === null) throw required("Sign the confirmation message with the admin wallet.");
  const { message, signature } = confirmation as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || typeof signature !== "string" || message.length > 2000 || signature.length > 4000) {
    throw required("confirmation must be { message, signature }.");
  }
  let record: AdminNonceRecord;
  try {
    record = await consumeMessageNonce(deps, message, origin, "confirm");
  } catch (error) {
    if (error instanceof AdminHttpError && error.code === "ADMIN_NONCE_INVALID") throw required("The confirmation is unknown, used or expired.");
    throw error;
  }
  if (record.walletKind !== session.record.walletKind || record.address !== session.record.address) {
    throw required("The confirmation belongs to another wallet.");
  }
  if (
    messageField(message, "Action") !== expected.action ||
    messageField(message, "Network") !== expected.network ||
    messageField(message, "Payload-SHA256") !== expected.payloadSha256
  ) {
    throw required("The confirmation does not match this request (action, network or payload hash).");
  }
  if (!(await verifyRecordSignature(deps, record, signature))) throw required("The confirmation signature is not valid for the signed-in wallet.");
}
