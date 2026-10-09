/**
 * LI.FI API client (https://docs.li.fi). Kletia asks `GET /v1/quote` only for
 * the bridge tools the adapter can decode (`allowBridges`), never for
 * exchanges or destination calls, and tracks transfers with `GET /v1/status`.
 * Every response is validated field-by-field; anything unexpected fails
 * closed. Addresses in a response are never used as targets: the adapter
 * decodes the calldata and compares it with the pinned registry contracts.
 *
 * Keyless quotes are limited to 75 per two hours; set LIFI_API_KEY (sent as
 * `x-lifi-api-key`) in production. A 429 pauses LI.FI quoting for a minute so
 * the venue drops out of auctions instead of slowing them down.
 */
import { applySlippage, isBaseUnitAmount, isEvmAddress, isSolanaAddress } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { fetchProviderJson } from "../http.js";
import { finiteNumber, isRecord } from "../util.js";

function readLifiUrl(): string {
  const raw = process.env.LIFI_API_URL?.trim();
  if (!raw) return "https://li.quest/v1";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("LIFI_API_URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
    throw new Error("LIFI_API_URL must use HTTPS in production.");
  }
  return raw.replace(/\/+$/u, "");
}

export const LIFI_API_URL = readLifiUrl();
const LIFI_API_KEY = process.env.LIFI_API_KEY?.trim() || null;
/** Pause after LI.FI answers 429 (keyless quotes: 75 per two hours). */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const PROVIDER = "LI.FI";

let pausedUntil = 0;

/** Clears the rate-limit pause (tests). */
export function resetLifiClient(): void {
  pausedUntil = 0;
}

function headers(): Record<string, string> {
  return LIFI_API_KEY ? { "x-lifi-api-key": LIFI_API_KEY } : {};
}

function invalid(detail: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_INVALID", `LI.FI returned a quote Kletia refuses (${detail}).`, 502);
}

function sameAddress(a: string, b: string): boolean {
  return isEvmAddress(a) || isEvmAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface LifiQuoteRequest {
  readonly fromChain: number;
  readonly toChain: number;
  /** ERC-20 address on the origin chain. */
  readonly fromToken: string;
  /** ERC-20 address or SPL mint on the destination chain. */
  readonly toToken: string;
  /** Base units of `fromToken`. */
  readonly fromAmount: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly slippageBps: number;
  /** Bridge tools LI.FI may use (each has a calldata decoder in the adapter). */
  readonly allowBridges: readonly string[];
}

export interface LifiQuote {
  /** Bridge tool, e.g. "across" or "polymerStandard". */
  readonly tool: string;
  /** LI.FI transfer id; equals BridgeData.transactionId in the calldata and /v1/status. */
  readonly transactionId: string;
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly executionSeconds: number;
  readonly feesUsd: number | null;
  readonly fromAmountUsd: number | null;
  readonly toAmountUsd: number | null;
  readonly transaction: {
    readonly to: string;
    readonly from: string;
    readonly data: string;
    readonly value: string;
    readonly chainId: number;
    readonly gasLimit: string | null;
  };
}

function parseQuantity(value: unknown): string | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/u.test(value)) return BigInt(value).toString();
  if (isBaseUnitAmount(value)) return value;
  return null;
}

function sumUsd(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;
  let total = 0;
  let seen = false;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const usd = finiteNumber(entry.amountUSD);
    if (usd === null || usd < 0) continue;
    total += usd;
    seen = true;
  }
  return seen ? total : null;
}

/**
 * `GET /v1/quote` restricted to the decodable bridge tools: no exchanges, no
 * destination calls, fastest route first. The response must echo the request
 * (chains, tokens, amount, sender, recipient) and honour the slippage floor.
 */
export async function fetchLifiQuote(request: LifiQuoteRequest): Promise<LifiQuote> {
  if (Date.now() < pausedUntil) {
    throw new PlatformError("PROVIDER_UNAVAILABLE", "LI.FI is rate limiting quotes; it is skipped for a minute.", 502);
  }
  if (request.allowBridges.length === 0) throw new PlatformError("ROUTE_UNSUPPORTED", "LI.FI has no decodable bridge for this route.", 422);
  const query = new URLSearchParams({
    fromChain: String(request.fromChain),
    toChain: String(request.toChain),
    fromToken: request.fromToken,
    toToken: request.toToken,
    fromAmount: request.fromAmount,
    fromAddress: request.fromAddress,
    toAddress: request.toAddress,
    slippage: String(request.slippageBps / 10_000),
    allowBridges: request.allowBridges.join(","),
    allowExchanges: "none",
    allowDestinationCall: "false",
    order: "FASTEST",
  });
  const body = await fetchProviderJson(`${LIFI_API_URL}/quote?${query.toString()}`, {
    provider: PROVIDER,
    headers: headers(),
    allowStatus: [429],
  });
  if (body === null) {
    pausedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    throw new PlatformError("PROVIDER_UNAVAILABLE", "LI.FI is rate limiting quotes; it is skipped for a minute.", 502);
  }
  if (!isRecord(body) || !isRecord(body.action) || !isRecord(body.estimate) || !isRecord(body.transactionRequest)) {
    throw invalid("missing action, estimate or transaction");
  }
  const { action, estimate } = body;
  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!request.allowBridges.includes(tool) || estimate.tool !== tool) throw invalid(`tool ${tool.slice(0, 32) || "?"} was not requested`);
  const transactionId = body.transactionId;
  if (typeof transactionId !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(transactionId)) throw invalid("transactionId");
  const fromToken = isRecord(action.fromToken) ? action.fromToken.address : null;
  const toToken = isRecord(action.toToken) ? action.toToken.address : null;
  if (
    action.fromChainId !== request.fromChain ||
    action.toChainId !== request.toChain ||
    typeof fromToken !== "string" || !sameAddress(fromToken, request.fromToken) ||
    typeof toToken !== "string" || !sameAddress(toToken, request.toToken) ||
    action.fromAmount !== request.fromAmount ||
    estimate.fromAmount !== request.fromAmount ||
    typeof action.fromAddress !== "string" || !sameAddress(action.fromAddress, request.fromAddress) ||
    typeof action.toAddress !== "string" || !sameAddress(action.toAddress, request.toAddress)
  ) {
    throw invalid("the route does not match the request");
  }
  if (!isBaseUnitAmount(estimate.toAmount) || !isBaseUnitAmount(estimate.toAmountMin)) throw invalid("amounts");
  const toAmount = estimate.toAmount;
  const toAmountMin = estimate.toAmountMin;
  if (toAmountMin === "0" || BigInt(toAmountMin) > BigInt(toAmount)) throw invalid("output floor");
  // The guaranteed floor must honour the requested slippage (1 base unit of rounding allowed).
  if (BigInt(toAmountMin) + 1n < BigInt(applySlippage(toAmount, request.slippageBps))) throw invalid("output floor is below the requested slippage");
  const tx = body.transactionRequest;
  const value = parseQuantity(tx.value ?? "0x0");
  if (
    typeof tx.to !== "string" || !isEvmAddress(tx.to) ||
    typeof tx.from !== "string" || !isEvmAddress(tx.from) ||
    typeof tx.data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/u.test(tx.data) || tx.data.length > 40_000 ||
    value === null ||
    typeof tx.chainId !== "number" || !Number.isSafeInteger(tx.chainId)
  ) {
    throw invalid("transaction fields");
  }
  const duration = finiteNumber(estimate.executionDuration);
  const fees = [sumUsd(estimate.feeCosts), sumUsd(estimate.gasCosts)].filter((entry): entry is number => entry !== null);
  return {
    tool,
    transactionId: transactionId.toLowerCase(),
    toAmount,
    toAmountMin,
    executionSeconds: duration !== null && duration >= 0 && duration < 86_400 ? Math.ceil(duration) : 1_800,
    feesUsd: fees.length > 0 ? fees.reduce((total, entry) => total + entry, 0) : null,
    fromAmountUsd: finiteNumber(estimate.fromAmountUSD),
    toAmountUsd: finiteNumber(estimate.toAmountUSD),
    transaction: {
      to: tx.to,
      from: tx.from,
      data: tx.data,
      value,
      chainId: tx.chainId,
      gasLimit: parseQuantity(tx.gasLimit),
    },
  };
}

export type LifiTransferStatus = "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED" | "UNKNOWN";

export interface LifiStatus {
  readonly status: LifiTransferStatus;
  /** DONE: COMPLETED | PARTIAL | REFUNDED; otherwise LI.FI's sub-status when given. */
  readonly substatus: string | null;
  readonly transactionId: string | null;
  readonly tool: string | null;
  readonly toAddress: string | null;
  readonly receiving: {
    readonly txHash: string | null;
    readonly chainId: number | null;
    readonly amount: string | null;
    readonly token: string | null;
  };
}

const STATUSES: readonly LifiTransferStatus[] = ["NOT_FOUND", "INVALID", "PENDING", "DONE", "FAILED"];

/**
 * `GET /v1/status` for an origin transaction. An unknown hash (404, LI.FI code
 * 1003) reads as NOT_FOUND: the transfer is not indexed yet.
 */
export async function fetchLifiStatus(txHash: string, fromChain: number, toChain: number): Promise<LifiStatus> {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(txHash) && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/u.test(txHash)) {
    throw new PlatformError("STEP_INVALID", "The bridge deposit reference is malformed.", 500);
  }
  const query = new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(toChain) });
  const body = await fetchProviderJson(`${LIFI_API_URL}/status?${query.toString()}`, {
    provider: PROVIDER,
    headers: headers(),
    allowStatus: [404],
  });
  const empty = { txHash: null, chainId: null, amount: null, token: null };
  if (body === null) return { status: "NOT_FOUND", substatus: null, transactionId: null, tool: null, toAddress: null, receiving: empty };
  const record = isRecord(body) ? body : {};
  const status = typeof record.status === "string" && (STATUSES as readonly string[]).includes(record.status)
    ? (record.status as LifiTransferStatus)
    : "UNKNOWN";
  const receiving = isRecord(record.receiving) ? record.receiving : {};
  const token = isRecord(receiving.token) ? receiving.token.address : null;
  const text = (value: unknown, max = 100) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
  return {
    status,
    substatus: text(record.substatus, 40),
    transactionId: typeof record.transactionId === "string" && /^0x[0-9a-fA-F]{64}$/u.test(record.transactionId)
      ? record.transactionId.toLowerCase()
      : null,
    tool: text(record.tool, 40),
    toAddress: typeof record.toAddress === "string" && (isEvmAddress(record.toAddress) || isSolanaAddress(record.toAddress)) ? record.toAddress : null,
    receiving: {
      txHash: text(receiving.txHash),
      chainId: typeof receiving.chainId === "number" && Number.isSafeInteger(receiving.chainId) ? receiving.chainId : null,
      amount: isBaseUnitAmount(receiving.amount) ? receiving.amount : null,
      token: typeof token === "string" && (isEvmAddress(token) || isSolanaAddress(token)) ? token : null,
    },
  };
}
