/**
 * Relay API client (https://docs.relay.link). Every response is validated
 * field-by-field; anything unexpected fails closed.
 */
import { applySlippage, isBaseUnitAmount, isEvmAddress, isSolanaAddress } from "@kletia/core";
import type { ExternalSolanaInstruction } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { fetchProviderJson } from "../http.js";
import { finiteNumber, isRecord } from "../util.js";

function readRelayUrl(): string {
  const raw = process.env.RELAY_API_URL?.trim();
  if (!raw) return "https://api.relay.link";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RELAY_API_URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
    throw new Error("RELAY_API_URL must use HTTPS in production.");
  }
  return raw.replace(/\/+$/u, "");
}

export const RELAY_API_URL = readRelayUrl();
const RELAY_API_KEY = process.env.RELAY_API_KEY?.trim() || null;

function headers(): Record<string, string> {
  return RELAY_API_KEY ? { "x-api-key": RELAY_API_KEY } : {};
}

/** Floor applied when Relay omits minimumAmount and no slippage was requested. */
const DEFAULT_FLOOR_SLIPPAGE_BPS = 50;

export const RELAY_NATIVE_EVM = "0x0000000000000000000000000000000000000000";
export const RELAY_NATIVE_SOLANA = "11111111111111111111111111111111";

export interface RelayQuoteRequest {
  readonly user: string;
  readonly recipient: string;
  readonly originChainId: number;
  readonly destinationChainId: number;
  readonly originCurrency: string;
  readonly destinationCurrency: string;
  /** Base units of the origin currency. */
  readonly amount: string;
  readonly slippageBps?: number;
}

export interface RelayCurrencyAmount {
  readonly chainId: number;
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: string;
  readonly minimumAmount: string;
  readonly amountUsd: number | null;
}

export interface RelayEvmCall {
  readonly kind: "evm";
  readonly stepId: string;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly chainId: number;
  readonly gas?: string;
}

export interface RelaySolanaCall {
  readonly kind: "svm";
  readonly stepId: string;
  readonly instructions: readonly ExternalSolanaInstruction[];
  readonly addressLookupTables: readonly string[];
}

export type RelayCall = RelayEvmCall | RelaySolanaCall;

export interface RelayQuote {
  readonly requestId: string;
  readonly calls: readonly RelayCall[];
  readonly currencyIn: RelayCurrencyAmount;
  readonly currencyOut: RelayCurrencyAmount;
  readonly feesUsd: number | null;
  readonly timeEstimateSeconds: number;
  /** Total impact (fees + price) in percent; negative means value lost. */
  readonly totalImpactPercent: number | null;
  readonly recipient: string | null;
}

function sameCurrency(a: string, b: string): boolean {
  return isEvmAddress(a) || isEvmAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function invalid(detail: string): PlatformError {
  return new PlatformError("RELAY_QUOTE_INVALID", `Relay returned an unexpected quote (${detail}).`, 502);
}

/**
 * `fallbackSlippageBps`: when Relay omits `minimumAmount`, the floor is derived
 * from the requested slippage instead of trusting the quoted amount.
 */
function parseCurrencyAmount(value: unknown, label: string, fallbackSlippageBps?: number): RelayCurrencyAmount {
  if (!isRecord(value) || !isRecord(value.currency)) throw invalid(`${label} missing`);
  const currency = value.currency;
  const chainId = currency.chainId;
  const address = currency.address;
  const decimals = currency.decimals;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) throw invalid(`${label}.chainId`);
  if (typeof address !== "string" || !(isEvmAddress(address) || isSolanaAddress(address))) throw invalid(`${label}.address`);
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw invalid(`${label}.decimals`);
  if (!isBaseUnitAmount(value.amount)) throw invalid(`${label}.amount`);
  const minimumAmount = isBaseUnitAmount(value.minimumAmount)
    ? value.minimumAmount
    : fallbackSlippageBps !== undefined
      ? applySlippage(value.amount, fallbackSlippageBps)
      : value.amount;
  return {
    chainId,
    address,
    symbol: typeof currency.symbol === "string" ? currency.symbol.slice(0, 16) : "?",
    decimals,
    amount: value.amount,
    minimumAmount,
    amountUsd: finiteNumber(value.amountUsd),
  };
}

function parseInstruction(value: unknown): ExternalSolanaInstruction {
  if (!isRecord(value) || typeof value.programId !== "string" || typeof value.data !== "string" || !Array.isArray(value.keys)) {
    throw invalid("solana instruction");
  }
  if (!isSolanaAddress(value.programId) || !/^(?:[0-9a-fA-F]{2})*$/u.test(value.data) || value.data.length > 4_000) {
    throw invalid("solana instruction fields");
  }
  const keys = value.keys.map((key) => {
    if (!isRecord(key) || typeof key.pubkey !== "string" || !isSolanaAddress(key.pubkey) ||
      typeof key.isSigner !== "boolean" || typeof key.isWritable !== "boolean") {
      throw invalid("solana instruction key");
    }
    return { pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable };
  });
  if (keys.length > 64) throw invalid("solana instruction keys");
  return { programId: value.programId, keys, data: value.data };
}

function parseCalls(steps: unknown): RelayCall[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 4) throw invalid("steps");
  const calls: RelayCall[] = [];
  for (const step of steps) {
    if (!isRecord(step) || typeof step.id !== "string") throw invalid("step");
    if (step.kind !== "transaction") {
      throw new PlatformError(
        "RELAY_SIGNATURE_STEP_UNSUPPORTED",
        "Relay asked for an off-chain signature step; Kletia only executes on-chain transactions.",
        422,
      );
    }
    if (!Array.isArray(step.items) || step.items.length === 0 || step.items.length > 2) throw invalid("step items");
    for (const item of step.items) {
      if (!isRecord(item) || !isRecord(item.data)) throw invalid("step item");
      const data = item.data;
      if (Array.isArray(data.instructions)) {
        const tables = Array.isArray(data.addressLookupTableAddresses) ? data.addressLookupTableAddresses : [];
        if (!tables.every((table): table is string => typeof table === "string" && isSolanaAddress(table)) || tables.length > 8) {
          throw invalid("lookup tables");
        }
        calls.push({ kind: "svm", stepId: step.id, instructions: data.instructions.map(parseInstruction), addressLookupTables: tables });
        continue;
      }
      const { from, to, value, chainId, gas } = data;
      const callData = data.data;
      if (typeof from !== "string" || !isEvmAddress(from) || typeof to !== "string" || !isEvmAddress(to)) throw invalid("evm addresses");
      if (typeof callData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(callData)) throw invalid("evm data");
      const normalizedValue = value === undefined ? "0" : String(value);
      if (!isBaseUnitAmount(normalizedValue)) throw invalid("evm value");
      if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) throw invalid("evm chainId");
      calls.push({
        kind: "evm",
        stepId: step.id,
        from,
        to,
        data: callData,
        value: normalizedValue,
        chainId,
        ...(typeof gas === "string" && isBaseUnitAmount(gas) ? { gas } : typeof gas === "number" && Number.isSafeInteger(gas) ? { gas: String(gas) } : {}),
      });
    }
  }
  if (calls.length > 4) throw invalid("too many transactions");
  return calls;
}

function sumFeesUsd(fees: unknown): number | null {
  if (!isRecord(fees)) return null;
  let total = 0;
  let seen = false;
  for (const key of ["gas", "relayer", "app"]) {
    const entry = fees[key];
    if (!isRecord(entry)) continue;
    const usd = finiteNumber(entry.amountUsd);
    if (usd === null || usd < 0) continue;
    total += usd;
    seen = true;
  }
  return seen ? total : null;
}

export async function fetchRelayQuote(request: RelayQuoteRequest): Promise<RelayQuote> {
  const body = await fetchProviderJson(`${RELAY_API_URL}/quote`, {
    provider: "Relay",
    method: "POST",
    headers: headers(),
    body: {
      user: request.user,
      recipient: request.recipient,
      originChainId: request.originChainId,
      destinationChainId: request.destinationChainId,
      originCurrency: request.originCurrency,
      destinationCurrency: request.destinationCurrency,
      amount: request.amount,
      tradeType: "EXACT_INPUT",
      ...(RELAY_API_KEY ? { referrer: "kletia" } : {}),
      ...(request.slippageBps !== undefined ? { slippageTolerance: String(request.slippageBps) } : {}),
    },
  });
  if (!isRecord(body) || !isRecord(body.details)) throw invalid("details");
  const details = body.details;
  const currencyIn = parseCurrencyAmount(details.currencyIn, "currencyIn");
  const currencyOut = parseCurrencyAmount(details.currencyOut, "currencyOut", request.slippageBps ?? DEFAULT_FLOOR_SLIPPAGE_BPS);
  if (
    currencyIn.chainId !== request.originChainId ||
    !sameCurrency(currencyIn.address, request.originCurrency) ||
    currencyIn.amount !== request.amount
  ) {
    throw invalid("input does not match the request");
  }
  if (currencyOut.chainId !== request.destinationChainId || !sameCurrency(currencyOut.address, request.destinationCurrency)) {
    throw invalid("output does not match the request");
  }
  if (currencyOut.amount === "0" || currencyOut.minimumAmount === "0" || BigInt(currencyOut.minimumAmount) > BigInt(currencyOut.amount)) {
    throw invalid("output floor");
  }
  // The guaranteed floor must honour the requested slippage (1 base unit of rounding allowed).
  if (request.slippageBps !== undefined &&
    BigInt(currencyOut.minimumAmount) + 1n < BigInt(applySlippage(currencyOut.amount, request.slippageBps))) {
    throw invalid("output floor is below the requested slippage");
  }
  const calls = parseCalls(body.steps);
  const requestIds = new Set(
    (Array.isArray(body.steps) ? body.steps : [])
      .map((step) => (isRecord(step) && typeof step.requestId === "string" ? step.requestId : null))
      .filter((id): id is string => id !== null),
  );
  const requestId = typeof body.requestId === "string" ? body.requestId : [...requestIds][0];
  if (!requestId || !/^0x[0-9a-fA-F]{64}$/u.test(requestId)) throw invalid("requestId");
  const recipient = typeof details.recipient === "string" ? details.recipient : null;
  if (recipient !== null && !sameCurrency(recipient, request.recipient)) throw invalid("recipient does not match");
  const impact = isRecord(details.totalImpact) ? finiteNumber(details.totalImpact.percent) : null;
  const time = finiteNumber(details.timeEstimate);
  return {
    requestId,
    calls,
    currencyIn,
    currencyOut,
    feesUsd: sumFeesUsd(body.fees),
    timeEstimateSeconds: time !== null && time >= 0 && time < 86_400 ? Math.ceil(time) : 30,
    totalImpactPercent: impact,
    recipient,
  };
}

export type RelayRequestStatus =
  | "waiting"
  | "pending"
  | "submitted"
  | "delayed"
  | "success"
  | "failure"
  | "refund"
  | "unknown";

const KNOWN_STATUSES: readonly RelayRequestStatus[] = ["waiting", "pending", "submitted", "delayed", "success", "failure", "refund"];

function parseStatus(value: unknown): RelayRequestStatus {
  return typeof value === "string" && (KNOWN_STATUSES as readonly string[]).includes(value) ? (value as RelayRequestStatus) : "unknown";
}

function hashList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 100).slice(0, 8)
    : [];
}

export interface RelayRequestState {
  readonly requestId: string;
  readonly status: RelayRequestStatus;
  readonly destinationTxHashes: readonly string[];
  readonly originTxHashes: readonly string[];
  readonly recipient: string | null;
  readonly outputAmount: string | null;
  readonly outputCurrency: string | null;
  readonly outputChainId: number | null;
}

function parseRequest(request: Record<string, unknown>): RelayRequestState | null {
  if (typeof request.id !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(request.id)) return null;
  const data = isRecord(request.data) ? request.data : {};
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const currencyOut = isRecord(metadata.currencyOut) ? metadata.currencyOut : {};
  const currency = isRecord(currencyOut.currency) ? currencyOut.currency : {};
  const outTxs = Array.isArray(data.outTxs) ? data.outTxs : [];
  const inTxs = Array.isArray(data.inTxs) ? data.inTxs : [];
  return {
    requestId: request.id,
    status: parseStatus(request.status),
    destinationTxHashes: hashList(outTxs.map((tx) => (isRecord(tx) ? tx.hash : null))),
    originTxHashes: hashList(inTxs.map((tx) => (isRecord(tx) ? tx.hash : null))),
    recipient: typeof request.recipient === "string" ? request.recipient : null,
    outputAmount: isBaseUnitAmount(currencyOut.amount) ? currencyOut.amount : null,
    outputCurrency: typeof currency.address === "string" ? currency.address : null,
    outputChainId: typeof currency.chainId === "number" ? currency.chainId : null,
  };
}

/** Looks up the Relay requests a deposit transaction created (usually one). */
export async function fetchRelayRequestsByHash(hash: string): Promise<RelayRequestState[]> {
  const body = await fetchProviderJson(`${RELAY_API_URL}/requests/v2?hash=${encodeURIComponent(hash)}`, {
    provider: "Relay",
    headers: headers(),
    allowStatus: [404],
  });
  if (!isRecord(body) || !Array.isArray(body.requests)) return [];
  return body.requests
    .slice(0, 8)
    .map((entry) => (isRecord(entry) ? parseRequest(entry) : null))
    .filter((entry): entry is RelayRequestState => entry !== null);
}

export async function fetchRelayStatus(requestId: string): Promise<RelayRequestState> {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(requestId)) {
    throw new PlatformError("RELAY_REQUEST_INVALID", "Invalid Relay request id.", 500);
  }
  const body = await fetchProviderJson(`${RELAY_API_URL}/intents/status/v2?requestId=${requestId}`, {
    provider: "Relay",
    headers: headers(),
  });
  const record = isRecord(body) ? body : {};
  return {
    requestId,
    status: parseStatus(record.status),
    destinationTxHashes: hashList(record.txHashes),
    originTxHashes: hashList(record.inTxHashes),
    recipient: null,
    outputAmount: null,
    outputCurrency: null,
    outputChainId: typeof record.destinationChainId === "number" ? record.destinationChainId : null,
  };
}
