/**
 * Developer account sign-in and sessions.
 *
 * - POST /v1/accounts/nonce `{ walletKind, address, chainId? }`: the server
 *   builds the exact message (EIP-4361 for EVM wallets, the Sign In With
 *   Solana text for Solana wallets), bound to the calling origin, the address,
 *   a single-use nonce and a 5-minute expiry, and stores it with the nonce.
 * - POST /v1/accounts/session `{ message, signature }`: consumes the nonce
 *   (single use, before any signature check), checks the message is the
 *   stored one for this origin, then the signature (EVM: offline recovery,
 *   else ERC-1271 / ERC-6492 on the named network, a failed read is 502, never
 *   valid; Solana: ed25519). Returns a session token shown once; only its
 *   SHA-256 is stored.
 * - Sessions end 8 h after sign-in or after 1 h without a request, are bound
 *   to the origin that signed in, and are sent as `Kletia-Account-Session`.
 *
 * Every account route needs a first-party `Origin` (the CORS allowlist or
 * KLETIA_WEB_ORIGIN; 403 ACCOUNT_ORIGIN_FORBIDDEN otherwise, also when the
 * header is missing). The session travels in a header, never a cookie, so a
 * foreign page cannot ride on it. Sign-ins, refusals and every change are
 * written to the account audit log before the response; a failed audit write
 * fails the request and changes nothing.
 *
 * The signature checks and message helpers are the admin panel's
 * (admin/auth), used as they are.
 */
import { randomBytes } from "node:crypto";
import {
  ACCOUNT_EVM_NETWORKS,
  ACCOUNT_LIMITS,
  ACCOUNT_SESSION_HEADER,
  ACCOUNT_SESSION_TOKEN_PATTERN,
  ACCOUNT_SIGN_IN_PATH,
  ACCOUNT_SIGN_IN_REQUEST_ID,
  ACCOUNT_SIGN_IN_STATEMENT,
  CHAINS,
  type AccountActivityAction,
  type AccountNonceResponse,
  type AccountSessionView,
  type AccountSignInResponse,
  type AccountWalletKind,
  type NetworkKey,
} from "@kletia/core";
import type { Request, RequestHandler } from "express";
import { getAddress, type Address } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { extractNonce } from "../../../admin/auth/messages.js";
import { verifyEvmMessageSignature, verifySolanaMessageSignature } from "../../../admin/auth/signatures.js";
import { parseEvmAddress, parseSolanaAddress } from "../../../admin/config.js";
import { allowedOrigins } from "../../../shared/http/cors.js";
import { evmClient, type EvmNetworkKey } from "../../engine/chains/evm.js";
import { PlatformError } from "../../errors.js";
import { HttpError, invalidRequest, isRecord, requestIdOf } from "../context.js";
import { clientIp } from "../limits.js";
import { randomBase62, sha256Hex } from "../secrets.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { accountStore, type AccountAuditOutcome, type AccountNonceRecord, type AccountSessionRecord } from "./store.js";

const NONCE_TTL_MS = ACCOUNT_LIMITS.nonceTtlSeconds * 1000;
const SESSION_TTL_MS = ACCOUNT_LIMITS.sessionTtlSeconds * 1000;
const SESSION_IDLE_MS = ACCOUNT_LIMITS.sessionIdleSeconds * 1000;
const TOUCH_INTERVAL_MS = 60_000;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_SIGNATURE_LENGTH = 4_000;

/** Test seams: the clock and the EVM client used for smart-contract wallet signatures. */
export interface AccountAuthSeams {
  readonly now: () => Date;
  readonly evmClient: (network: EvmNetworkKey) => ReturnType<typeof evmClient>;
}

const DEFAULT_SEAMS: AccountAuthSeams = { now: () => new Date(), evmClient };
let seams: AccountAuthSeams = DEFAULT_SEAMS;

/** Replaces the clock or EVM client (tests); null restores the defaults. */
export function configureAccountAuth(next: Partial<AccountAuthSeams> | null): void {
  seams = next ? { ...DEFAULT_SEAMS, ...next } : DEFAULT_SEAMS;
}

export function accountNow(): Date {
  return seams.now();
}

/* ------------------------------------------------------------ errors */

function sessionRequired(message = "Sign in with your wallet to manage your projects."): HttpError {
  return new HttpError(401, "ACCOUNT_SESSION_REQUIRED", message);
}

function nonceInvalid(message = "The sign-in message is unknown, used or expired. Request a new one."): HttpError {
  return new HttpError(401, "ACCOUNT_NONCE_INVALID", message);
}

function signatureInvalid(): HttpError {
  return new HttpError(401, "ACCOUNT_SIGNATURE_INVALID", "The signature does not match the sign-in message and wallet.");
}

/* ------------------------------------------------------------ origin */

/** A first-party origin: the CORS allowlist (built-in and CORS_ORIGINS) or KLETIA_WEB_ORIGIN. */
export function accountOriginAllowed(origin: string | undefined): origin is string {
  return typeof origin === "string" && (allowedOrigins.includes(origin) || origin === kletiaWebOrigin());
}

declare module "express-serve-static-core" {
  interface Request {
    accountOrigin?: string;
    accountSession?: AccountSessionContext;
  }
}

/** Every account route: a first-party Origin header (CSRF and phishing guard), then the store must be usable. */
export const requireAccountOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get("origin");
  if (!accountOriginAllowed(origin)) {
    next(new HttpError(403, "ACCOUNT_ORIGIN_FORBIDDEN", "Developer accounts are used from the Kletia developer portal only."));
    return;
  }
  try {
    accountStore();
  } catch (error) {
    next(error);
    return;
  }
  req.accountOrigin = origin;
  next();
};

export function originOf(req: Request): string {
  if (!req.accountOrigin) throw new HttpError(403, "ACCOUNT_ORIGIN_FORBIDDEN", "Developer accounts are used from the Kletia developer portal only.");
  return req.accountOrigin;
}

/* ------------------------------------------------------------ addresses */

/** Stored form: lower-case EVM address, base58 Solana address as given. */
export function normalizeWallet(walletKind: AccountWalletKind, address: unknown): string | null {
  if (walletKind === "evm") return parseEvmAddress(address)?.toLowerCase() ?? null;
  return parseSolanaAddress(address);
}

export function displayWallet(walletKind: AccountWalletKind, stored: string): string {
  return walletKind === "evm" ? getAddress(stored) : stored;
}

function networkForChainId(chainId: number): EvmNetworkKey | null {
  const network = ACCOUNT_EVM_NETWORKS.find((key: NetworkKey) => CHAINS[key].evmChainId === chainId);
  return (network as EvmNetworkKey | undefined) ?? null;
}

export function accountChainIds(): number[] {
  return ACCOUNT_EVM_NETWORKS.map((key) => CHAINS[key].evmChainId as number);
}

/* ------------------------------------------------------------ audit */

export function ipHashOf(req: Request): string {
  return sha256Hex(`kletia-account-ip:${clientIp(req)}`).slice(0, 32);
}

export interface AuditEntry {
  readonly wallet: { readonly walletKind: AccountWalletKind; readonly address: string } | null;
  readonly action: AccountActivityAction;
  readonly outcome: AccountAuditOutcome;
  readonly projectId?: string | null;
  readonly keyId?: string | null;
  readonly target?: Readonly<Record<string, string>>;
}

/** Writes one audit row; a failure is 503 and the caller changes nothing. */
export async function audit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    await accountStore().writeAudit(
      {
        walletKind: entry.wallet?.walletKind ?? null,
        address: entry.wallet?.address ?? null,
        action: entry.action,
        outcome: entry.outcome,
        projectId: entry.projectId ?? null,
        keyId: entry.keyId ?? null,
        target: entry.target ?? {},
        requestId: requestIdOf(req),
        ipHash: ipHashOf(req),
      },
      accountNow(),
    );
  } catch {
    throw new PlatformError("STORE_UNAVAILABLE", "The account audit log could not be written; nothing was changed.", 503);
  }
}

/** Best effort: records that an audited change failed after its row was written. */
export async function auditFailure(req: Request, entry: Omit<AuditEntry, "outcome">): Promise<void> {
  try {
    await audit(req, { ...entry, outcome: "error" });
  } catch (error) {
    console.error("[platform] account audit failure row could not be written:", error instanceof Error ? error.message : error);
  }
}

/* ------------------------------------------------------------ messages */

interface MessageInput {
  readonly origin: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export function buildEvmSignInMessage(input: MessageInput & { readonly chainId: number }): string {
  return createSiweMessage({
    domain: new URL(input.origin).host,
    address: input.address as Address,
    statement: ACCOUNT_SIGN_IN_STATEMENT,
    uri: `${input.origin}${ACCOUNT_SIGN_IN_PATH}`,
    version: "1",
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expirationTime: input.expiresAt,
    requestId: ACCOUNT_SIGN_IN_REQUEST_ID,
  });
}

export function buildSolanaSignInMessage(input: MessageInput): string {
  return [
    `${new URL(input.origin).host} wants you to sign in with your Solana account:`,
    input.address,
    "",
    ACCOUNT_SIGN_IN_STATEMENT,
    "",
    `URI: ${input.origin}${ACCOUNT_SIGN_IN_PATH}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
    `Request ID: ${ACCOUNT_SIGN_IN_REQUEST_ID}`,
  ].join("\n");
}

/* ------------------------------------------------------------ nonce */

const NONCE_FIELDS = new Set(["walletKind", "address", "chainId"]);

export function parseNonceRequest(body: unknown): { walletKind: AccountWalletKind; address: string; chainId: number | null } {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"walletKind\", \"address\", \"chainId\"? }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => !NONCE_FIELDS.has(key));
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const walletKind = body.walletKind;
  if (walletKind !== "evm" && walletKind !== "solana") {
    throw invalidRequest("walletKind must be evm or solana.", [{ path: "walletKind", message: "Expected evm or solana." }]);
  }
  const address = normalizeWallet(walletKind, body.address);
  if (!address) {
    throw invalidRequest(walletKind === "evm" ? "address must be an EVM address." : "address must be a Solana address (base58, 32 bytes).", [
      { path: "address", message: "Invalid address." },
    ]);
  }
  if (walletKind === "solana") {
    if (body.chainId !== undefined) throw invalidRequest("chainId is for EVM wallets only.", [{ path: "chainId", message: "Not allowed for Solana." }]);
    return { walletKind, address, chainId: null };
  }
  const chainId = body.chainId;
  if (typeof chainId !== "number" || !accountChainIds().includes(chainId)) {
    throw invalidRequest(`chainId must be one of ${accountChainIds().join(", ")}.`, [{ path: "chainId", message: "Unsupported chain id." }]);
  }
  return { walletKind, address, chainId };
}

export async function issueSignInNonce(origin: string, body: unknown): Promise<AccountNonceResponse> {
  const { walletKind, address, chainId } = parseNonceRequest(body);
  const now = accountNow();
  const nonce = randomBase62(24);
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  const message = walletKind === "evm"
    ? buildEvmSignInMessage({ origin, address: getAddress(address), chainId: chainId as number, nonce, issuedAt: now, expiresAt })
    : buildSolanaSignInMessage({ origin, address, nonce, issuedAt: now, expiresAt });
  const record: AccountNonceRecord = { nonceHash: sha256Hex(nonce), walletKind, address, chainId, origin, message, createdAt: now, expiresAt };
  await accountStore().createNonce(record);
  return { message, nonce, expiresAt: expiresAt.toISOString(), walletKind };
}

/* ------------------------------------------------------------ sign-in */

/** The address a sign-in message claims (unverified; audit context for refused attempts only). */
function claimedAddress(message: string): string | null {
  const lines = message.split("\n");
  const head = /wants you to sign in with your (Ethereum|Solana) account:$/u.exec(lines[0] ?? "");
  if (!head) return null;
  const walletKind: AccountWalletKind = head[1] === "Solana" ? "solana" : "evm";
  const normalized = normalizeWallet(walletKind, lines[1] ?? "");
  return normalized ? displayWallet(walletKind, normalized) : null;
}

export function parseSignInRequest(body: unknown): { message: string; signature: string } {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"message\", \"signature\" }.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => key !== "message" && key !== "signature");
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const { message, signature } = body;
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    throw invalidRequest(`message must be the sign-in text (at most ${MAX_MESSAGE_LENGTH} characters).`, [{ path: "message", message: "Invalid message." }]);
  }
  if (typeof signature !== "string" || signature.length === 0 || signature.length > MAX_SIGNATURE_LENGTH) {
    throw invalidRequest("signature must be the wallet's signature of the message.", [{ path: "signature", message: "Invalid signature." }]);
  }
  return { message, signature };
}

async function signatureValid(record: AccountNonceRecord, signature: string): Promise<boolean> {
  if (record.walletKind === "solana") return verifySolanaMessageSignature(record.address, record.message, signature);
  const network = record.chainId === null ? null : networkForChainId(record.chainId);
  if (!network) return false;
  try {
    return await verifyEvmMessageSignature({
      client: () => seams.evmClient(network),
      network,
      address: getAddress(record.address),
      message: record.message,
      signature,
    });
  } catch {
    // The admin helper throws only when the chain could not be read: never "valid on doubt".
    throw new PlatformError("RPC_UNAVAILABLE", `The ${network} RPC could not check this smart-wallet signature right now. Retry shortly.`, 502);
  }
}

export function sessionView(record: AccountSessionRecord): AccountSessionView {
  const idle = Math.min(record.lastSeenAt.getTime() + SESSION_IDLE_MS, record.expiresAt.getTime());
  return {
    walletKind: record.walletKind,
    address: displayWallet(record.walletKind, record.address),
    chainId: record.chainId,
    expiresAt: record.expiresAt.toISOString(),
    idleExpiresAt: new Date(idle).toISOString(),
  };
}

export async function signIn(req: Request, body: unknown): Promise<AccountSignInResponse> {
  const origin = originOf(req);
  const { message, signature } = parseSignInRequest(body);
  const store = accountStore();
  const now = accountNow();
  const refused = async (reason: string, error: HttpError): Promise<never> => {
    const claimed = claimedAddress(message);
    // Unverified addresses never land in a wallet's own activity: they are kept as target context only.
    await audit(req, { wallet: null, action: "account.sign_in", outcome: "denied", target: { reason, ...(claimed ? { claimed } : {}) } });
    throw error;
  };
  const nonce = extractNonce(message);
  const record = nonce ? await store.consumeNonce(sha256Hex(nonce), now) : null;
  if (!record || record.message !== message || record.origin !== origin) return refused("nonce", nonceInvalid());
  const display = displayWallet(record.walletKind, record.address);
  if (record.walletKind === "evm") {
    const parsed = parseSiweMessage(message);
    const valid = validateSiweMessage({ message: parsed, domain: new URL(origin).host, address: display as Address, nonce: parsed.nonce, time: now });
    if (!valid || parsed.chainId !== record.chainId) {
      return refused("message", nonceInvalid("The sign-in message does not match this origin, address or time. Request a new one."));
    }
  }
  if (!(await signatureValid(record, signature))) return refused("signature", signatureInvalid());
  const token = `kl_acs_${randomBytes(32).toString("base64url")}`;
  const session: AccountSessionRecord = {
    idHash: sha256Hex(token),
    walletKind: record.walletKind,
    address: record.address,
    chainId: record.chainId,
    origin,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  await audit(req, {
    wallet: { walletKind: record.walletKind, address: record.address },
    action: "account.sign_in",
    outcome: "ok",
    target: { walletKind: record.walletKind, ...(record.chainId === null ? {} : { chainId: String(record.chainId) }) },
  });
  await store.createSession(session);
  return { token, session: sessionView(session) };
}

/* ------------------------------------------------------------ sessions */

export interface AccountSessionContext {
  readonly idHash: string;
  readonly record: AccountSessionRecord;
  readonly wallet: { readonly walletKind: AccountWalletKind; readonly address: string };
}

/** A live session for `token` at `origin`, or null (unknown, expired, idle, other origin). */
export async function resolveAccountSession(token: string, origin: string): Promise<AccountSessionContext | null> {
  if (!ACCOUNT_SESSION_TOKEN_PATTERN.test(token)) return null;
  const store = accountStore();
  const idHash = sha256Hex(token);
  const record = await store.getSession(idHash);
  if (!record) return null;
  const now = accountNow().getTime();
  if (record.expiresAt.getTime() <= now || now - record.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    await store.deleteSession(idHash);
    return null;
  }
  if (record.origin !== origin) return null;
  let current = record;
  if (now - record.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    current = { ...record, lastSeenAt: new Date(now) };
    await store.touchSession(idHash, current.lastSeenAt);
  }
  return { idHash, record: current, wallet: { walletKind: current.walletKind, address: current.address } };
}

/** Route guard after requireAccountOrigin: a live session in Kletia-Account-Session, else 401 ACCOUNT_SESSION_REQUIRED. */
export const requireAccountSession: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = req.get(ACCOUNT_SESSION_HEADER)?.trim();
    if (!token) throw sessionRequired();
    const session = await resolveAccountSession(token, originOf(req));
    if (!session) throw sessionRequired("The session is unknown, expired or from another site. Sign in again.");
    req.accountSession = session;
  })().then(() => next(), next);
};

export function accountSessionOf(req: Request): AccountSessionContext {
  if (!req.accountSession) throw sessionRequired();
  return req.accountSession;
}

export async function signOut(req: Request): Promise<void> {
  const session = accountSessionOf(req);
  await audit(req, { wallet: session.wallet, action: "account.sign_out", outcome: "ok" });
  await accountStore().deleteSession(session.idHash);
}
