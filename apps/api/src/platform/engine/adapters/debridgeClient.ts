/**
 * deBridge DLN API client (https://docs.debridge.com). Orders are created with
 * `GET /v1.0/dln/order/create-tx` (`prependOperatingExpenses=false`, so the
 * order gives exactly the step amount) and tracked through the order-tracking
 * API (`GET /api/Orders/{orderId}`). Every response is validated
 * field-by-field; the adapter decodes the returned transaction and compares
 * it with the pinned DlnSource and the step before anything reaches a wallet.
 *
 * Keyless use is limited (50 requests per minute); set DEBRIDGE_ACCESS_TOKEN
 * (sent as the `accesstoken` query parameter) in production.
 */
import { isBaseUnitAmount, isEvmAddress, isSolanaAddress } from "@kletia/core";
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

export const DLN_API_URL = readUrl("DEBRIDGE_API_URL", "https://dln.debridge.finance/v1.0");
export const DLN_TRACKING_URL = readUrl("DEBRIDGE_TRACKING_URL", "https://dln-api.debridge.finance");
const ACCESS_TOKEN = process.env.DEBRIDGE_ACCESS_TOKEN?.trim() || null;
const PROVIDER = "deBridge";

/** DLN's address for a chain's native asset (EVM zero address, Solana System program). */
export const DLN_NATIVE_EVM = "0x0000000000000000000000000000000000000000";
export const DLN_NATIVE_SOLANA = "11111111111111111111111111111111";

const ORDER_ID = /^0x[0-9a-fA-F]{64}$/u;

function invalid(detail: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_INVALID", `deBridge returned an order Kletia refuses (${detail}).`, 502);
}

function sameToken(a: string, b: string): boolean {
  return isEvmAddress(a) || isEvmAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface DlnOrderRequest {
  readonly srcChainId: number;
  readonly srcChainTokenIn: string;
  /** Base units of the input; the order gives exactly this amount. */
  readonly amount: string;
  readonly dstChainId: number;
  readonly dstChainTokenOut: string;
  readonly recipient: string;
  readonly sender: string;
  /** Account that may cancel the order on the destination network (the user's own). */
  readonly dstAuthority: string;
}

export interface DlnOrderQuote {
  readonly orderId: string;
  /** Exact amount the order takes on the destination network. */
  readonly takeAmount: string;
  /** Fixed fee in the origin network's native asset (base units), paid as transaction value. */
  readonly fixFee: string;
  readonly fulfillmentSeconds: number;
  readonly protocolFeeUsd: number | null;
  readonly inputUsd: number | null;
  readonly outputUsd: number | null;
  /** EVM origin: call target / spender, calldata and value. Solana origin: `data` is a hex wire transaction. */
  readonly tx: { readonly to: string | null; readonly data: string; readonly value: string | null };
}

/**
 * `GET /dln/order/create-tx` for an exact-input market order. The response
 * must echo the request (chains, tokens, amount) and carry a non-zero take
 * amount, an order id and a fixed fee.
 */
export async function fetchDlnOrder(request: DlnOrderRequest): Promise<DlnOrderQuote> {
  const query = new URLSearchParams({
    srcChainId: String(request.srcChainId),
    srcChainTokenIn: request.srcChainTokenIn,
    srcChainTokenInAmount: request.amount,
    dstChainId: String(request.dstChainId),
    dstChainTokenOut: request.dstChainTokenOut,
    dstChainTokenOutAmount: "auto",
    dstChainTokenOutRecipient: request.recipient,
    senderAddress: request.sender,
    srcChainOrderAuthorityAddress: request.sender,
    srcAllowedCancelBeneficiary: request.sender,
    dstChainOrderAuthorityAddress: request.dstAuthority,
    prependOperatingExpenses: "false",
    ...(ACCESS_TOKEN ? { accesstoken: ACCESS_TOKEN } : {}),
  });
  const body = await fetchProviderJson(`${DLN_API_URL}/dln/order/create-tx?${query.toString()}`, { provider: PROVIDER });
  if (!isRecord(body) || !isRecord(body.estimation) || !isRecord(body.tx)) throw invalid("missing estimation or transaction");
  const tokenIn = isRecord(body.estimation.srcChainTokenIn) ? body.estimation.srcChainTokenIn : {};
  const tokenOut = isRecord(body.estimation.dstChainTokenOut) ? body.estimation.dstChainTokenOut : {};
  if (
    tokenIn.chainId !== request.srcChainId ||
    typeof tokenIn.address !== "string" || !sameToken(tokenIn.address, request.srcChainTokenIn) ||
    tokenIn.amount !== request.amount ||
    tokenOut.chainId !== request.dstChainId ||
    typeof tokenOut.address !== "string" || !sameToken(tokenOut.address, request.dstChainTokenOut)
  ) {
    throw invalid("the order does not match the request");
  }
  if (!isBaseUnitAmount(tokenOut.amount) || tokenOut.amount === "0") throw invalid("take amount");
  if (typeof body.orderId !== "string" || !ORDER_ID.test(body.orderId)) throw invalid("orderId");
  if (!isBaseUnitAmount(body.fixFee)) throw invalid("fixFee");
  const tx = body.tx;
  if (typeof tx.data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/u.test(tx.data) || tx.data.length > 40_000) throw invalid("transaction data");
  const to = tx.to === undefined ? null : tx.to;
  if (to !== null && (typeof to !== "string" || !isEvmAddress(to))) throw invalid("transaction target");
  const value = tx.value === undefined ? null : String(tx.value);
  if (value !== null && !isBaseUnitAmount(value)) throw invalid("transaction value");
  const order = isRecord(body.order) ? body.order : {};
  const delay = finiteNumber(order.approximateFulfillmentDelay);
  return {
    orderId: body.orderId.toLowerCase(),
    takeAmount: tokenOut.amount,
    fixFee: body.fixFee,
    fulfillmentSeconds: delay !== null && delay >= 0 && delay < 86_400 ? Math.ceil(delay) : 60,
    protocolFeeUsd: finiteNumber(body.protocolFeeApproximateUsdValue),
    inputUsd: finiteNumber(tokenIn.approximateUsdValue),
    outputUsd: finiteNumber(tokenOut.approximateUsdValue),
    tx: { to, data: tx.data, value },
  };
}

/** Order ids a source transaction created (`GET /dln/tx/{hash}/order-ids`); empty when not indexed yet. */
export async function fetchDlnOrderIds(txHash: string): Promise<string[]> {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(txHash) && !isSolanaSignatureLike(txHash)) return [];
  const body = await fetchProviderJson(`${DLN_API_URL}/dln/tx/${encodeURIComponent(txHash)}/order-ids`, {
    provider: PROVIDER,
    allowStatus: [404],
  });
  if (!isRecord(body) || !Array.isArray(body.orderIds)) return [];
  return body.orderIds
    .slice(0, 8)
    .map((entry) => (typeof entry === "string" ? entry : isRecord(entry) && typeof entry.stringValue === "string" ? entry.stringValue : null))
    .filter((entry): entry is string => entry !== null && ORDER_ID.test(entry))
    .map((entry) => entry.toLowerCase());
}

function isSolanaSignatureLike(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/u.test(value);
}

export type DlnOrderState =
  | "Created"
  | "Fulfilled"
  | "SentUnlock"
  | "ClaimedUnlock"
  | "OrderCancelled"
  | "SentOrderCancel"
  | "ClaimedOrderCancel"
  | "Unknown";

const STATES: readonly DlnOrderState[] = ["Created", "Fulfilled", "SentUnlock", "ClaimedUnlock", "OrderCancelled", "SentOrderCancel", "ClaimedOrderCancel"];

export interface DlnOrderStatus {
  readonly orderId: string;
  readonly state: DlnOrderState;
  /** Destination fill transaction (EVM hash or Solana signature), once fulfilled. */
  readonly fulfillTx: string | null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.stringValue === "string" ? value.stringValue : null;
}

/** `GET /api/Orders/{orderId}` (tracking API); an unknown order reads as Unknown. */
export async function fetchDlnOrderStatus(orderId: string): Promise<DlnOrderStatus> {
  if (!ORDER_ID.test(orderId)) throw new PlatformError("STEP_INVALID", "The deBridge order id is malformed.", 500);
  const body = await fetchProviderJson(`${DLN_TRACKING_URL}/api/Orders/${orderId}`, { provider: PROVIDER, allowStatus: [404] });
  if (!isRecord(body)) return { orderId, state: "Unknown", fulfillTx: null };
  const id = stringValue(body.orderId);
  if (id !== null && id.toLowerCase() !== orderId.toLowerCase()) return { orderId, state: "Unknown", fulfillTx: null };
  const state = typeof body.state === "string" && (STATES as readonly string[]).includes(body.state) ? (body.state as DlnOrderState) : "Unknown";
  const fulfilled = isRecord(body.fulfilledDstEventMetadata) ? stringValue(body.fulfilledDstEventMetadata.transactionHash) : null;
  const fulfillTx = fulfilled && fulfilled.length <= 100 && (/^0x[0-9a-fA-F]{64}$/u.test(fulfilled) || isSolanaSignatureLike(fulfilled)) ? fulfilled : null;
  return { orderId, state, fulfillTx };
}

export function isDlnNativeAddress(value: string): boolean {
  return value === DLN_NATIVE_SOLANA || (isEvmAddress(value) && value.toLowerCase() === DLN_NATIVE_EVM);
}

export function dlnTokenAddress(native: boolean, address: string | null, svm: boolean): string {
  if (native || address === null) return svm ? DLN_NATIVE_SOLANA : DLN_NATIVE_EVM;
  if (!(svm ? isSolanaAddress(address) : isEvmAddress(address))) throw new PlatformError("ASSET_INVALID", "The asset address is invalid.", 500);
  return address;
}
