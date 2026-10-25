/**
 * Payment caps, public HTTPS URLs, DNS-pinned preflight requests and the
 * PAYMENT-REQUIRED header.
 */
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { formatUnits, parseUnits } from "viem";
import {
  DECIMAL_USDC,
  DEFAULT_SERVER_CAP,
  DNS_LOOKUP_TIMEOUT_MS,
  MAX_PREFLIGHT_HEADER_BYTES,
  MAX_PREFLIGHT_RESPONSE_BYTES,
  NON_PUBLIC_DESTINATIONS,
  PREFLIGHT_TIMEOUT_MS,
  USDC_DECIMALS,
} from "./constants.js";
import { BaseX402IntentError } from "./types.js";

function configuredServerCap(): bigint {
  const raw =
    process.env.X402_BUYER_MAX_PAYMENT_USDC?.trim() || DEFAULT_SERVER_CAP;
  if (!DECIMAL_USDC.test(raw)) {
    throw new BaseX402IntentError(
      "X402_BUYER_POLICY_INVALID",
      "Server x402 buyer payment cap is misconfigured.",
      503,
    );
  }
  const cap = parseUnits(raw, USDC_DECIMALS);
  if (cap <= 0n) {
    throw new BaseX402IntentError(
      "X402_BUYER_POLICY_INVALID",
      "Server x402 buyer payment cap must be positive.",
      503,
    );
  }
  return cap;
}

export function paymentCap(value: unknown): {
  atomic: bigint;
  decimal: string;
} {
  const raw = String(value ?? "").trim();
  if (!DECIMAL_USDC.test(raw)) {
    throw new BaseX402IntentError(
      "X402_MAX_PAYMENT_INVALID",
      "x402 maxPayment must be positive and contain at most 6 decimal places.",
    );
  }
  const atomic = parseUnits(raw, USDC_DECIMALS);
  const serverCap = configuredServerCap();
  if (atomic <= 0n || atomic > serverCap) {
    throw new BaseX402IntentError(
      "X402_MAX_PAYMENT_EXCEEDED",
      `A single x402 request is limited to a maximum of ${formatUnits(serverCap, USDC_DECIMALS)} USDC.`,
    );
  }
  return { atomic, decimal: formatUnits(atomic, USDC_DECIMALS) };
}

export function publicHttpsUrl(value: unknown): URL {
  let url: URL;
  const raw = String(value ?? "");
  if (raw.length === 0 || raw.length > 2_048) {
    throw new BaseX402IntentError(
      "X402_URL_INVALID",
      "x402 source must be a full HTTPS URL no longer than 2048 characters.",
    );
  }
  try {
    url = new URL(raw);
  } catch {
    throw new BaseX402IntentError(
      "X402_URL_INVALID",
      "x402 source must be a full HTTPS URL.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new BaseX402IntentError(
      "X402_URL_NOT_PUBLIC_HTTPS",
      "x402 source must be a public HTTPS URL without credentials or private hosts.",
    );
  }
  url.hash = "";
  return url;
}

function isPublicDestination(address: string, family: number): boolean {
  const expectedFamily = family === 4 ? "ipv4" : family === 6 ? "ipv6" : null;
  return (
    expectedFamily !== null &&
    isIP(address) === family &&
    !(family === 6 && /^::ffff:/iu.test(address)) &&
    !NON_PUBLIC_DESTINATIONS.check(address, expectedFamily)
  );
}

export async function resolvePinnedPublicDestination(hostname: string): Promise<{
  readonly address: string;
  readonly family: 4 | 6;
}> {
  let resolved: Array<{ address: string; family: number }>;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    resolved = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new BaseX402IntentError(
                "X402_PREFLIGHT_DNS_TIMEOUT",
                "DNS resolution for x402 resource timed out.",
                504,
              ),
            ),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof BaseX402IntentError) throw error;
    throw new BaseX402IntentError(
      "X402_PREFLIGHT_DNS_UNAVAILABLE",
      "The public network address of the x402 resource could not be verified.",
      502,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address, family }) => !isPublicDestination(address, family),
    )
  ) {
    throw new BaseX402IntentError(
      "X402_PREFLIGHT_PRIVATE_DESTINATION",
      "The x402 resource can only connect to public HTTPS targets.",
    );
  }
  const selected = resolved.find(({ family }) => family === 4) || resolved[0];
  return {
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

interface X402PreflightHttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export async function requestPinnedX402Challenge(
  url: URL,
): Promise<X402PreflightHttpResponse> {
  const destination = await resolvePinnedPublicDestination(url.hostname);
  return new Promise<X402PreflightHttpResponse>((resolve, reject) => {
    let settled = false;
    let absoluteTimeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      reject(error);
    };
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Kletia-x402-preflight/1.0",
        },
        maxHeaderSize: MAX_PREFLIGHT_HEADER_BYTES,
        lookup: ((_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [destination]);
            return;
          }
          callback(null, destination.address, destination.family);
        }) as NonNullable<Parameters<typeof httpsRequest>[1]>["lookup"],
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_PREFLIGHT_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new BaseX402IntentError(
                "X402_PREFLIGHT_RESPONSE_TOO_LARGE",
                "x402 payment preflight response exceeded safe size limit.",
                502,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          if (absoluteTimeout) clearTimeout(absoluteTimeout);
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => fail(error));
      },
    );
    request.setTimeout(PREFLIGHT_TIMEOUT_MS, () => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PREFLIGHT_TIMEOUT",
          "x402 payment preflight timed out.",
          504,
        ),
      );
    });
    absoluteTimeout = setTimeout(() => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PREFLIGHT_TIMEOUT",
          "x402 payment preflight timed out.",
          504,
        ),
      );
    }, PREFLIGHT_TIMEOUT_MS);
    request.on("error", (error) => {
      if (error instanceof BaseX402IntentError) return fail(error);
      return fail(
        new BaseX402IntentError(
          "X402_PREFLIGHT_UNAVAILABLE",
          "x402 resource could not be verified without payment.",
          502,
        ),
      );
    });
    request.end();
  });
}

export function scalarHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    return value[0];
  }
  return value;
}

export function decodePaymentRequiredHeader(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > MAX_PREFLIGHT_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 resource did not return a verifiable PAYMENT-REQUIRED header.",
      502,
    );
  }
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  let decoded: Buffer;
  try {
    decoded = Buffer.from(padded, "base64");
  } catch {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 payment requirement could not be decoded.",
      502,
    );
  }
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > MAX_PREFLIGHT_RESPONSE_BYTES
  ) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 payment requirement is not within safe size limits.",
      502,
    );
  }
  try {
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 payment requirement is not valid JSON.",
      502,
    );
  }
}

export function requiredQueryParams(body: string): string[] {
  if (!body.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).required_params;
  if (!Array.isArray(raw) || raw.length > 20) return [];
  const params = raw.filter(
    (value): value is string =>
      typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value),
  );
  return params.length === raw.length ? [...new Set(params)] : [];
}

export function sameX402Resource(requested: URL, advertised: URL): boolean {
  if (
    requested.origin !== advertised.origin ||
    requested.pathname !== advertised.pathname
  ) {
    return false;
  }

  return !advertised.search || advertised.search === requested.search;
}
