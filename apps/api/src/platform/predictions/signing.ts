/**
 * Polymarket signing payloads and the relay's guards. Kletia builds typed
 * data for the user's wallet and checks what comes back; it never signs.
 *
 * - Orders: the Exchange `Order` struct under the domain
 *   { "Polymarket CTF Exchange", "2" | "3", 137, exchange } (docs "Place
 *   Orders"; @polymarket/clob-client-v2 1.2.0 `exchangeOrderBuilderV2.js`),
 *   signed by an EOA (signatureType 0, maker = signer = the account).
 * - Sign-in: `ClobAuth` under { "ClobAuthDomain", "1", 137 } (docs "API
 *   Authentication"), which the CLOB exchanges for L2 credentials.
 * - L2 requests: HMAC-SHA256 over timestamp + method + path + body with the
 *   base64 secret, url-safe base64 (the SDK's `buildPolyHmacSignature`).
 *
 * The relay fails closed: the order must be exactly the one prepare built
 * (Kletia's MAC over its typed-data hash, unexpired), and its signature
 * must recover to the account.
 */
import { createHmac } from "node:crypto";
import {
  BYTES32_ZERO,
  POLYMARKET_CLOB_AUTH,
  POLYMARKET_EXCHANGE_NAME,
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_POLYGON,
  type PolymarketOrderDraft,
  type PredictionTypedData,
} from "@kletia/core";
import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { PlatformError } from "../errors.js";
import { platformMac } from "../http/secrets.js";

/* ---------------------------------------------------------------- order */

/** The order's typed data for `eth_signTypedData_v4` (EIP712Domain left out, as viem takes it). */
export function orderTypedData(order: PolymarketOrderDraft): PredictionTypedData {
  return {
    domain: { name: POLYMARKET_EXCHANGE_NAME, version: order.domainVersion, chainId: POLYMARKET_POLYGON.chainId, verifyingContract: order.exchange },
    types: POLYMARKET_ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      side: order.side,
      signatureType: order.signatureType,
      timestamp: order.timestamp,
      metadata: order.metadata,
      builder: order.builder,
    },
  };
}

type ViemTypedData = Parameters<typeof hashTypedData>[0];

function viemTypedData(typed: PredictionTypedData): ViemTypedData {
  return {
    domain: { ...typed.domain, ...(typed.domain.verifyingContract ? { verifyingContract: typed.domain.verifyingContract as Hex } : {}) },
    types: typed.types as Record<string, { name: string; type: string }[]>,
    primaryType: typed.primaryType,
    message: typed.message as Record<string, unknown>,
  } as ViemTypedData;
}

/** EIP-712 hash of an order (the CLOB's order id). */
export function orderHash(order: PolymarketOrderDraft): Hex {
  return hashTypedData(viemTypedData(orderTypedData(order)));
}

const TICKET_PURPOSE = "predictions-order-v1";

/** Kletia's MAC over what prepare built: the order hash, its unsigned fields and the expiry. Null without a platform secret. */
export function orderTicket(order: PolymarketOrderDraft, expiresAt: number): string | null {
  const mac = platformMac(TICKET_PURPOSE, [orderHash(order), order.orderType, order.expiration, expiresAt].join("|"));
  return mac === null ? null : `${expiresAt}.${mac}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const UINT = /^\d{1,78}$/u;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/u;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string) => new PlatformError("PREDICTION_SIGNATURE_INVALID", message, 400, [{ path: "order", message }]);

const EXCHANGES: Readonly<Record<string, "2" | "3">> = {
  [POLYMARKET_POLYGON.ctfExchange]: "2",
  [POLYMARKET_POLYGON.negRiskCtfExchange]: "2",
  [POLYMARKET_POLYGON.exchangeV3]: "3",
};

/** The order a client sent back, read field by field (anything else refused). */
export function readOrderDraft(input: unknown): PolymarketOrderDraft {
  if (!isRecord(input)) throw invalid("Send the order exactly as prepare returned it.");
  const keys = ["salt", "maker", "signer", "tokenId", "makerAmount", "takerAmount", "side", "signatureType", "timestamp", "metadata", "builder", "expiration", "orderType", "exchange", "domainVersion"];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw invalid("The order carries fields prepare did not return.");
  const uints = ["salt", "tokenId", "makerAmount", "takerAmount", "timestamp", "expiration"] as const;
  for (const key of uints) if (typeof input[key] !== "string" || !UINT.test(input[key] as string)) throw invalid(`order.${key} must be the decimal string prepare returned.`);
  for (const key of ["maker", "signer"] as const) if (typeof input[key] !== "string" || !ADDRESS.test(input[key] as string)) throw invalid(`order.${key} must be an address.`);
  for (const key of ["metadata", "builder"] as const) if (typeof input[key] !== "string" || !BYTES32.test(input[key] as string)) throw invalid(`order.${key} must be 32 bytes.`);
  if (input.side !== 0 && input.side !== 1) throw invalid("order.side must be 0 (buy) or 1 (sell).");
  if (input.signatureType !== 0) throw invalid("Kletia relays EOA orders only (signatureType 0).");
  if (input.orderType !== "FAK" && input.orderType !== "GTC") throw invalid("order.orderType must be FAK or GTC.");
  const exchange = typeof input.exchange === "string" ? Object.keys(EXCHANGES).find((address) => address.toLowerCase() === (input.exchange as string).toLowerCase()) : undefined;
  if (!exchange || EXCHANGES[exchange] !== input.domainVersion) throw invalid("order.exchange and order.domainVersion must be a pinned Polymarket exchange.");
  return {
    salt: input.salt as string,
    maker: getAddress(input.maker as string),
    signer: getAddress(input.signer as string),
    tokenId: input.tokenId as string,
    makerAmount: input.makerAmount as string,
    takerAmount: input.takerAmount as string,
    side: input.side,
    signatureType: 0,
    timestamp: input.timestamp as string,
    metadata: (input.metadata as string).toLowerCase(),
    builder: (input.builder as string).toLowerCase(),
    expiration: input.expiration as string,
    orderType: input.orderType,
    exchange,
    domainVersion: EXCHANGES[exchange] as "2" | "3",
  };
}

/**
 * The relay's guard: the ticket matches this exact order (so prepare built
 * and checked it), it has not expired, maker and signer are the account, and
 * the signature recovers to the account. Throws PREDICTION_SIGNATURE_INVALID.
 */
export async function verifySignedOrder(order: PolymarketOrderDraft, ticket: unknown, signature: unknown, account: string, nowMs: number): Promise<Hex> {
  if (typeof ticket !== "string" || !/^\d{10}\.[\w-]{20,64}$/u.test(ticket)) throw invalid("Send the ticket exactly as prepare returned it.");
  const expiresAt = Number(ticket.split(".")[0]);
  if (nowMs / 1000 > expiresAt) throw invalid("The prepared order expired; prepare it again.");
  const expected = orderTicket(order, expiresAt);
  if (expected === null) throw new PlatformError("PREDICTION_SESSION_UNAVAILABLE", "This server cannot check prepared orders (no platform secret), so it relays none.", 503);
  if (expected !== ticket) throw invalid("The order differs from the one prepare built (or the ticket is not Kletia's).");
  if (order.maker.toLowerCase() !== account.toLowerCase() || order.signer.toLowerCase() !== account.toLowerCase()) throw invalid("The order's maker and signer must be the account that prepared it.");
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) throw invalid("Send the 65-byte signature (0x + 130 hex characters).");
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({ ...viemTypedData(orderTypedData(order)), signature: signature as Hex });
  } catch {
    throw invalid("The signature does not recover to an address.");
  }
  if (signer.toLowerCase() !== account.toLowerCase()) throw invalid("The signature is not the account's.");
  return orderHash(order);
}

/** A fresh order salt: random and within Number.MAX_SAFE_INTEGER (the CLOB body carries it as a JSON number). */
export function orderSalt(random: () => number = Math.random): string {
  return String(Math.floor(random() * Number.MAX_SAFE_INTEGER));
}

export const ZERO_BYTES32 = BYTES32_ZERO;

/* -------------------------------------------------------------- sign-in */

/** The ClobAuth typed data the wallet signs to sign in to the CLOB (no funds move). */
export function clobAuthTypedData(address: string, timestamp: number, nonce = 0): PredictionTypedData {
  return {
    domain: POLYMARKET_CLOB_AUTH.domain,
    types: POLYMARKET_CLOB_AUTH.types,
    primaryType: "ClobAuth",
    message: { address: getAddress(address), timestamp: String(timestamp), nonce, message: POLYMARKET_CLOB_AUTH.message },
  };
}

/** Seconds a ClobAuth signature is accepted after its timestamp. */
export const CLOB_AUTH_MAX_AGE_SECONDS = 300;

/** Checks a ClobAuth signature: recent, nonce 0, and recovering to the account. Returns its L1 headers. */
export async function verifyClobAuth(account: string, auth: unknown, nowMs: number): Promise<Record<string, string>> {
  const fail = (message: string) => new PlatformError("PREDICTION_SIGNATURE_INVALID", message, 400, [{ path: "auth", message }]);
  if (!isRecord(auth) || !Number.isSafeInteger(auth.timestamp) || typeof auth.signature !== "string" || !SIGNATURE.test(auth.signature)) {
    throw fail("Send auth as { timestamp, signature } from the sign-in step.");
  }
  const timestamp = auth.timestamp as number;
  const age = nowMs / 1000 - timestamp;
  if (age < -60 || age > CLOB_AUTH_MAX_AGE_SECONDS) throw fail("The sign-in signature is too old (or from the future); sign in again.");
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({ ...viemTypedData(clobAuthTypedData(account, timestamp)), signature: auth.signature as Hex });
  } catch {
    throw fail("The sign-in signature does not recover to an address.");
  }
  if (signer.toLowerCase() !== account.toLowerCase()) throw fail("The sign-in signature is not the account's.");
  return { POLY_ADDRESS: getAddress(account), POLY_SIGNATURE: auth.signature, POLY_TIMESTAMP: String(timestamp), POLY_NONCE: "0" };
}

/* ------------------------------------------------------------------- L2 */

export interface ClobCredentials {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

/** HMAC-SHA256 of timestamp + method + path + body under the base64 (or url-safe base64) secret, url-safe base64 out. */
export function clobL2Signature(secret: string, timestamp: number, method: string, path: string, body?: string): string {
  const key = Buffer.from(secret.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  return createHmac("sha256", key).update(`${timestamp}${method}${path}${body ?? ""}`, "utf8").digest("base64").replace(/\+/gu, "-").replace(/\//gu, "_");
}

export function clobL2Headers(credentials: ClobCredentials, address: string, timestamp: number, method: string, path: string, body?: string): Record<string, string> {
  return {
    POLY_ADDRESS: getAddress(address),
    POLY_SIGNATURE: clobL2Signature(credentials.secret, timestamp, method, path, body),
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: credentials.apiKey,
    POLY_PASSPHRASE: credentials.passphrase,
  };
}

export const validAddress = (value: string) => isAddress(value, { strict: false });
