/**
 * Every read and relay the prediction venues make goes through this port:
 * Polymarket's Gamma, CLOB and Data APIs, its geoblock endpoint, and Polygon
 * eth_call / eth_getCode. Tests swap it for recorded fixtures
 * (`configurePredictionsIo`). Nothing here signs or sends a transaction; the
 * only POSTs carry an order or a sign-in the user already signed.
 */
import type { Hex } from "viem";
import { PlatformError } from "../errors.js";
import { evmClient } from "../engine/chains/evm.js";

export interface VenueResponse {
  readonly status: number;
  /** Parsed JSON, or null for an empty or non-JSON body. */
  readonly body: unknown;
}

export interface VenueRequest {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent exactly as given (the CLOB signs the serialized body). */
  readonly body?: string;
}

export interface PredictionsIo {
  /** One HTTP request to a venue API; throws `<PROVIDER>_UNAVAILABLE` when it cannot be reached. Any status is returned. */
  request(provider: string, url: string, init?: VenueRequest): Promise<VenueResponse>;
  /** eth_call on Polygon PoS at the latest block. */
  polygonCall(to: string, data: Hex): Promise<Hex>;
  /** Code at an address on Polygon PoS ("0x" for a plain wallet). */
  polygonCode(address: string): Promise<Hex>;
  /** Milliseconds since the epoch. */
  now(): number;
}

const HTTP_TIMEOUT_MS = 8_000;
/** Gamma events carry every market of the event: a page of ten is about 1 MB. */
const MAX_BYTES = 6_000_000;

/** `<PROVIDER>_<SUFFIX>` (resolved to the PROVIDER_* family by resolveErrorCode). */
export function providerCode(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/\W+/gu, "_")}_${suffix}`;
}

async function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), HTTP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const polygonUnreadable = () => new PlatformError("RPC_UNAVAILABLE", "Polygon could not be read. Try again shortly.", 502);

export const livePredictionsIo: PredictionsIo = {
  async request(provider, url, init = {}) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: { accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new PlatformError(providerCode(provider, "UNAVAILABLE"), `${provider} could not be reached. Try again shortly.`, 502);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new PlatformError(providerCode(provider, "UNAVAILABLE"), `${provider} answered more than Kletia reads.`, 502);
    }
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new PlatformError(providerCode(provider, "UNAVAILABLE"), `${provider} answered more than Kletia reads.`, 502);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  },
  async polygonCall(to, data) {
    try {
      const { data: result } = await timed(evmClient("polygon").call({ to: to as Hex, data }));
      return result ?? "0x";
    } catch {
      throw polygonUnreadable();
    }
  },
  async polygonCode(address) {
    try {
      return (await timed(evmClient("polygon").getCode({ address: address as Hex }))) ?? "0x";
    } catch {
      throw polygonUnreadable();
    }
  },
  now: () => Date.now(),
};

let current: PredictionsIo = livePredictionsIo;

export function predictionsIo(): PredictionsIo {
  return current;
}

/** Replaces the reads (tests: recorded fixtures); null restores the live port. */
export function configurePredictionsIo(io: PredictionsIo | null): void {
  current = io ?? livePredictionsIo;
}
