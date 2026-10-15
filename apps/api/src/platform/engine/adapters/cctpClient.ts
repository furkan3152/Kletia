/**
 * Circle Iris API client for CCTP V2 (https://developers.circle.com/cctp):
 * Fast Transfer fees with the Forwarding Service
 * (`GET /v2/burn/USDC/fees/{src}/{dst}?forward=true`) and the attested
 * message of a burn (`GET /v2/messages/{srcDomain}?transactionHash=`).
 * Keyless. Every field is validated here; the adapter decodes the message
 * bytes itself instead of trusting Iris's decoded view.
 *
 * Two Iris deployments serve two capital lanes (protocols design 3.5): the
 * production API attests mainnet burns, the sandbox API testnet burns. The
 * deployment is chosen from the SOURCE network's environment, and every
 * request asserts that source and destination share that environment: CCTP
 * domains repeat across lanes (3 is Arbitrum and Arbitrum Sepolia, 5 is
 * Solana and Solana Devnet), so a domain pair alone never picks the lane.
 */
import { CHAINS, sameCapitalLane, type NetworkKey } from "@kletia/core";
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

/** Production Iris (mainnet burns). */
export const CCTP_IRIS_URL = readUrl("CCTP_IRIS_API_URL", "https://iris-api.circle.com");
/** Sandbox Iris (testnet burns: Arc Testnet, Arbitrum Sepolia, Solana Devnet). */
export const CCTP_IRIS_SANDBOX_URL = readUrl("CCTP_IRIS_SANDBOX_URL", "https://iris-api-sandbox.circle.com");
const PROVIDER = "Circle";

/**
 * Refuses a CCTP route whose source and destination sit on different capital
 * lanes: production and testnet capital never mix (chains.ts).
 */
export function assertCctpLane(source: NetworkKey, destination: NetworkKey): void {
  if (!sameCapitalLane(source, destination)) {
    throw new PlatformError(
      "ROUTE_UNSUPPORTED",
      `Circle CCTP does not connect ${CHAINS[source].name} (${CHAINS[source].environment}) with ${CHAINS[destination].name} (${CHAINS[destination].environment}): mainnet and testnet USDC never mix.`,
      422,
    );
  }
}

/** The Iris deployment that attests burns from `source`: sandbox for testnet networks, production otherwise. */
export function irisUrl(source: NetworkKey): string {
  return CHAINS[source].environment === "testnet" ? CCTP_IRIS_SANDBOX_URL : CCTP_IRIS_URL;
}

/** Fast Transfer finality threshold (CCTP V2 "confirmed"); 2000 is Standard ("finalized"). */
export const CCTP_FAST_FINALITY = 1000;
/** Protocol fees above this many basis points are refused as an implausible fee table. */
const MAX_PROTOCOL_FEE_BPS = 100;

function invalid(detail: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_INVALID", `Circle returned a fee table Kletia refuses (${detail}).`, 502);
}

function domainPath(domain: number): string {
  if (!Number.isInteger(domain) || domain < 0 || domain > 1_000) throw new PlatformError("NETWORK_UNSUPPORTED", "Unknown CCTP domain.", 500);
  return String(domain);
}

export interface CctpFastFees {
  /** Protocol fee in hundredths of a basis point (1.3 bps = 130). */
  readonly protocolFeeCentiBps: number;
  /** Forwarding Service gas budget (USDC base units), the `high` estimate. */
  readonly forwardFeeHigh: bigint;
}

function units(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,30}$/u.test(value)) return BigInt(value);
  return null;
}

/** A CCTP lane endpoint: the network and its CCTP domain. */
export interface CctpEndpoint {
  readonly network: NetworkKey;
  readonly domain: number;
}

/**
 * Fast Transfer fees with forwarding, from the `finalityThreshold: 1000` row,
 * read from the Iris deployment of the source network's lane (refused when
 * source and destination are on different lanes).
 */
export async function fetchCctpFastFees(source: CctpEndpoint, destination: CctpEndpoint): Promise<CctpFastFees> {
  assertCctpLane(source.network, destination.network);
  const body = await fetchProviderJson(
    `${irisUrl(source.network)}/v2/burn/USDC/fees/${domainPath(source.domain)}/${domainPath(destination.domain)}?forward=true`,
    { provider: PROVIDER },
  );
  if (!Array.isArray(body)) throw invalid("not a list");
  const row = body.find((entry) => isRecord(entry) && entry.finalityThreshold === CCTP_FAST_FINALITY);
  if (!isRecord(row)) throw invalid("no Fast Transfer row");
  const bps = finiteNumber(row.minimumFee);
  if (bps === null || bps < 0 || bps > MAX_PROTOCOL_FEE_BPS) throw invalid("minimumFee");
  const centi = Math.round(bps * 100);
  if (Math.abs(centi - bps * 100) > 1e-6) throw invalid("minimumFee precision");
  const forward = isRecord(row.forwardFee) ? units(row.forwardFee.high) : null;
  if (forward === null) throw invalid("forwardFee.high (forwarding not offered on this route)");
  return { protocolFeeCentiBps: centi, forwardFeeHigh: forward };
}

/** The protocol fee CCTP charges on `amount`: ceil(amount x bps / 10,000). */
export function cctpProtocolFee(amount: bigint, centiBps: number): bigint {
  const numerator = amount * BigInt(centiBps);
  const denominator = 1_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

export interface CctpMessage {
  /** The attested message bytes (hex), or null until Iris has them. */
  readonly message: string | null;
  readonly eventNonce: string | null;
  /** "complete" once attested; anything else is still pending. */
  readonly status: string;
  /** Forwarding Service state ("COMPLETE" once minted on the destination), null when absent. */
  readonly forwardState: string | null;
  /** Destination mint transaction of the Forwarding Service. */
  readonly forwardTxHash: string | null;
}

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/u;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/u;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/u;

/**
 * Messages a burn transaction emitted, as the Iris deployment of the source
 * network's lane reports them; empty while not indexed (404).
 */
export async function fetchCctpMessages(source: CctpEndpoint, transactionHash: string): Promise<CctpMessage[]> {
  if (!EVM_HASH.test(transactionHash)) return [];
  const body = await fetchProviderJson(
    `${irisUrl(source.network)}/v2/messages/${domainPath(source.domain)}?transactionHash=${transactionHash}`,
    { provider: PROVIDER, allowStatus: [404] },
  );
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  return body.messages.slice(0, 8).filter(isRecord).map((entry): CctpMessage => {
    const forwardTx = typeof entry.forwardTxHash === "string" && (EVM_HASH.test(entry.forwardTxHash) || SOLANA_SIGNATURE.test(entry.forwardTxHash))
      ? entry.forwardTxHash
      : null;
    return {
      message: typeof entry.message === "string" && HEX.test(entry.message) && entry.message.length <= 4_000 ? entry.message : null,
      eventNonce: typeof entry.eventNonce === "string" && /^0x[0-9a-fA-F]{1,64}$/u.test(entry.eventNonce) ? entry.eventNonce : null,
      status: typeof entry.status === "string" ? entry.status.slice(0, 40) : "unknown",
      forwardState: typeof entry.forwardState === "string" ? entry.forwardState.slice(0, 40) : null,
      forwardTxHash: forwardTx,
    };
  });
}
