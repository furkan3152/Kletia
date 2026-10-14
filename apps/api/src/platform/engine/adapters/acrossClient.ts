/**
 * Across API client (https://docs.across.to). Quotes come from
 * `GET /api/suggested-fees` (Across calls it legacy but publishes no sunset;
 * `/swap/approval` is the documented fallback) and settlement from
 * `GET /api/deposit/status`. The API is untrusted: every field the adapter
 * uses is validated here, and the adapter itself encodes the SpokePool
 * deposit from the validated numbers, checks the spoke pools against the
 * pins and proves the deposit and the fill on-chain.
 *
 * Keyless use works for quotes and status; production may set
 * ACROSS_API_KEY (sent as `Authorization: Bearer`) and ACROSS_INTEGRATOR_ID
 * (2-byte hex, appended to the deposit calldata after the 0x1dc0de marker).
 */
import { isBaseUnitAmount, isEvmAddress } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { fetchProviderJson } from "../http.js";
import { finiteNumber, isRecord } from "../util.js";

function readUrl(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  return raw.replace(/\/+$/u, "");
}

export const ACROSS_API_URL = readUrl("ACROSS_API_URL", "https://app.across.to/api");
const PROVIDER = "Across";

/** Across attribution marker: the deposit calldata ends with 0x1dc0de and the 2-byte integrator id. */
export const ACROSS_INTEGRATOR_DELIMITER = "1dc0de";

function invalid(detail: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_INVALID", `Across returned a quote Kletia refuses (${detail}).`, 502);
}

function headers(): Record<string, string> {
  const key = process.env.ACROSS_API_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * The configured integrator id (4 lowercase hex characters, without 0x), or
 * null when none is set. Read on every prepare; a malformed id refuses the
 * route instead of producing calldata Across would not attribute.
 */
export function acrossIntegratorId(): string | null {
  const raw = process.env.ACROSS_INTEGRATOR_ID?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{4}$/u.test(raw)) {
    throw new PlatformError("PROVIDER_UNAVAILABLE", "Across is misconfigured on this server: ACROSS_INTEGRATOR_ID must be a 2-byte 0x-prefixed hex value.", 502);
  }
  return raw.slice(2).toLowerCase();
}

export interface AcrossFeesRequest {
  readonly inputToken: string;
  readonly outputToken: string;
  readonly originChainId: number;
  readonly destinationChainId: number;
  /** Base units of the input; the deposit gives exactly this amount. */
  readonly amount: string;
  readonly depositor: string;
  readonly recipient: string;
}

export interface AcrossQuote {
  /** Exact amount a relayer must deliver on the destination (else the deposit is refunded after fillDeadline). */
  readonly outputAmount: string;
  /** Relayer fee total in input-token base units (capital + gas + LP). */
  readonly totalRelayFee: string;
  readonly estimatedFillTimeSec: number;
  readonly spokePool: string;
  readonly destinationSpokePool: string;
  readonly exclusiveRelayer: string;
  /** Exclusivity window in seconds after the deposit (the SpokePool's exclusivityParameter). */
  readonly exclusivityDeadline: number;
  /** Unix seconds; the SpokePool's quoteTimestamp. */
  readonly timestamp: number;
  /** Unix seconds; the SpokePool's fillDeadline. */
  readonly fillDeadline: number;
  readonly isAmountTooLow: boolean;
  readonly limits: {
    readonly minDeposit: string;
    readonly maxDeposit: string;
    readonly maxDepositInstant: string;
  };
  /** Across's quote id (informational). */
  readonly id: string | null;
}

function unixSeconds(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{9,11}$/u.test(text)) return null;
  return Number(text);
}

function amountField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!isBaseUnitAmount(value)) throw invalid(key);
  return value;
}

/**
 * `GET /api/suggested-fees` for an exact-input USDC deposit. The response
 * must echo the request's tokens and chains and carry every field the
 * deposit needs, well formed; the adapter checks the values against the pins
 * and the clock.
 */
export async function fetchAcrossQuote(request: AcrossFeesRequest): Promise<AcrossQuote> {
  const query = new URLSearchParams({
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    originChainId: String(request.originChainId),
    destinationChainId: String(request.destinationChainId),
    amount: request.amount,
    depositor: request.depositor,
    recipient: request.recipient,
  });
  const body = await fetchProviderJson(`${ACROSS_API_URL}/suggested-fees?${query.toString()}`, { provider: PROVIDER, headers: headers() });
  if (!isRecord(body)) throw invalid("not an object");
  const inputToken = isRecord(body.inputToken) ? body.inputToken : null;
  const outputToken = isRecord(body.outputToken) ? body.outputToken : null;
  if (inputToken) {
    if (typeof inputToken.address !== "string" || inputToken.address.toLowerCase() !== request.inputToken.toLowerCase() || inputToken.chainId !== request.originChainId) {
      throw invalid("the input token does not match the request");
    }
  }
  if (outputToken) {
    if (typeof outputToken.address !== "string" || outputToken.address.toLowerCase() !== request.outputToken.toLowerCase() || outputToken.chainId !== request.destinationChainId) {
      throw invalid("the output token does not match the request");
    }
  }
  const outputAmount = amountField(body, "outputAmount");
  const totalRelayFee = isRecord(body.totalRelayFee) && isBaseUnitAmount(body.totalRelayFee.total) ? body.totalRelayFee.total : null;
  if (totalRelayFee === null) throw invalid("totalRelayFee");
  if (typeof body.spokePoolAddress !== "string" || !isEvmAddress(body.spokePoolAddress)) throw invalid("spokePoolAddress");
  if (typeof body.destinationSpokePoolAddress !== "string" || !isEvmAddress(body.destinationSpokePoolAddress)) throw invalid("destinationSpokePoolAddress");
  if (typeof body.exclusiveRelayer !== "string" || !isEvmAddress(body.exclusiveRelayer)) throw invalid("exclusiveRelayer");
  const exclusivity = finiteNumber(body.exclusivityDeadline);
  if (exclusivity === null || !Number.isInteger(exclusivity) || exclusivity < 0) throw invalid("exclusivityDeadline");
  const timestamp = unixSeconds(body.timestamp);
  if (timestamp === null) throw invalid("timestamp");
  const fillDeadline = unixSeconds(body.fillDeadline);
  if (fillDeadline === null) throw invalid("fillDeadline");
  if (typeof body.isAmountTooLow !== "boolean") throw invalid("isAmountTooLow");
  const limits = isRecord(body.limits) ? body.limits : null;
  if (!limits) throw invalid("limits");
  const fill = finiteNumber(body.estimatedFillTimeSec);
  return {
    outputAmount,
    totalRelayFee,
    estimatedFillTimeSec: fill !== null && fill >= 0 && fill < 86_400 ? Math.ceil(fill) : 60,
    spokePool: body.spokePoolAddress,
    destinationSpokePool: body.destinationSpokePoolAddress,
    exclusiveRelayer: body.exclusiveRelayer,
    exclusivityDeadline: exclusivity,
    timestamp,
    fillDeadline,
    isAmountTooLow: body.isAmountTooLow,
    limits: {
      minDeposit: amountField(limits, "minDeposit"),
      maxDeposit: amountField(limits, "maxDeposit"),
      maxDepositInstant: amountField(limits, "maxDepositInstant"),
    },
    id: typeof body.id === "string" ? body.id.slice(0, 80) : null,
  };
}

export type AcrossDepositState = "pending" | "filled" | "expired" | "refunded" | "unknown";

export interface AcrossDepositStatus {
  readonly state: AcrossDepositState;
  /** Origin deposit transaction as Across indexed it (null when not reported). */
  readonly depositTxHash: string | null;
  /** Destination fill transaction, once filled. */
  readonly fillTx: string | null;
  /** Origin refund transaction, once refunded. */
  readonly refundTx: string | null;
}

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/u;

function hashField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && EVM_HASH.test(value)) return value;
  }
  return null;
}

/**
 * `GET /api/deposit/status?originChainId&depositId`. A deposit Across has not
 * indexed yet (404) reads as unknown; so does a record for another origin
 * chain or deposit id.
 */
export async function fetchAcrossDepositStatus(originChainId: number, depositId: bigint): Promise<AcrossDepositStatus> {
  const query = new URLSearchParams({ originChainId: String(originChainId), depositId: depositId.toString() });
  const body = await fetchProviderJson(`${ACROSS_API_URL}/deposit/status?${query.toString()}`, {
    provider: PROVIDER,
    headers: headers(),
    allowStatus: [404],
  });
  const unknown: AcrossDepositStatus = { state: "unknown", depositTxHash: null, fillTx: null, refundTx: null };
  if (!isRecord(body)) return unknown;
  if (body.originChainId !== undefined && Number(body.originChainId) !== originChainId) return unknown;
  if (body.depositId !== undefined && String(body.depositId) !== depositId.toString()) return unknown;
  const status = typeof body.status === "string" ? body.status : "";
  const state: AcrossDepositState = status === "filled" || status === "expired" || status === "refunded" || status === "pending"
    ? status
    : status === "slowFillRequested"
      ? "pending"
      : "unknown";
  return {
    state,
    depositTxHash: hashField(body, "depositTxHash", "depositTxnRef"),
    fillTx: hashField(body, "fillTx", "fillTxnRef"),
    refundTx: hashField(body, "depositRefundTxHash", "depositRefundTxnRef"),
  };
}
