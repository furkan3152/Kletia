import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { z } from "zod";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { TOKENS } from "../contracts.js";
import { NETWORKS } from "../../../shared/config/networks.js";
import { containsSensitivePromptMaterial } from "../../../shared/security/promptSecrets.js";

const BASE_CAIP_NETWORK = `eip155:${NETWORKS.base.chainId}` as const;
const CDP_BAZAAR_SEARCH_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const USDC_DECIMALS = 6;
const DEFAULT_SERVER_CAP = "1";
const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 8;
const MAX_DISCOVERY_RESPONSE_BYTES = 1_048_576;
const MAX_PREFLIGHT_RESPONSE_BYTES = 32_768;
const MAX_PREFLIGHT_HEADER_BYTES = 32_768;
const PREFLIGHT_TIMEOUT_MS = 7_000;
const DNS_LOOKUP_TIMEOUT_MS = 3_000;
const MAX_PAID_RESPONSE_BYTES = 1_048_576;
const PAID_REQUEST_TIMEOUT_MS = 20_000;
const DISCOVERY_CACHE_TTL_MS = 30_000;
const MAX_DISCOVERY_CACHE_ENTRIES = 128;
const QUERY_PATTERN = /^[^\u0000-\u001F\u007F]{2,120}$/u;
const DECIMAL_USDC = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

const NON_PUBLIC_DESTINATIONS = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) {
  NON_PUBLIC_DESTINATIONS.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_DESTINATIONS.addSubnet(address, prefix, "ipv6");
}

const paymentRequirementSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    amount: z.string(),
    asset: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().int().positive().max(300).optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();

const x402ChallengeSchema = z
  .object({
    x402Version: z.literal(2),
    accepts: z.array(paymentRequirementSchema).min(1).max(20),
    resource: z
      .object({
        url: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const bazaarResourceSchema = z
  .object({
    resource: z.string(),
    type: z.string(),
    x402Version: z.number().int(),
    description: z.string().optional(),
    lastUpdated: z.string(),
    curated: z.boolean().optional(),
    skillUrl: z.string().optional(),
    accepts: z.array(paymentRequirementSchema).max(50),
    extensions: z
      .object({
        bazaar: z
          .object({
            info: z
              .object({
                input: z
                  .object({
                    method: z.string().optional(),
                    queryParams: z.record(z.unknown()).optional(),
                    bodyType: z.string().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    metadata: z
      .object({
        description: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const bazaarSearchSchema = z
  .object({
    resources: z.array(z.unknown()).max(100),
    partialResults: z.boolean(),
    searchMethod: z.enum(["hybrid", "vector", "text"]),
    x402Version: z.number().int(),
  })
  .passthrough();
type BazaarSearchPayload = z.infer<typeof bazaarSearchSchema>;
type DiscoveryCacheEntry = {
  readonly expiresAt: number;
  readonly payload: BazaarSearchPayload;
};
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const discoveryRequests = new Map<string, Promise<BazaarSearchPayload>>();

export class BaseX402IntentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "BaseX402IntentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface BaseX402Service {
  readonly resource: string;
  readonly description: string;
  readonly curated: boolean;
  readonly lastUpdated: string;
  readonly method?: "GET" | "POST";
  readonly requestUrl?: string;
  readonly scheme: "exact";
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly amount: string;
  readonly maxTimeoutSeconds?: number;
  readonly skillUrl?: string;
}

export interface BaseX402ChallengeEvidence {
  readonly policyVersion: "kletia_x402_challenge_v1";
  readonly status: "verified";
  readonly method: "GET";
  readonly sourceRequestUrl: string;
  readonly requestUrl: string;
  readonly resourceUrl: string;
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly chainId: typeof NETWORKS.base.chainId;
  readonly scheme: "exact";
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly amount: string;
  readonly maxPayment: string;
  readonly maxTimeoutSeconds?: number;
  readonly requiredParams: readonly string[];
  readonly walletInputBinding?: {
    readonly parameter: "address" | "wallet";
    readonly value: string;
    readonly source: "active_user_address";
  };
  readonly observedAt: string;
}

export interface BaseX402BuyerPaymentRequirement {
  readonly scheme: "exact";
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: {
    readonly name: "USD Coin";
    readonly version: "2";
    readonly assetTransferMethod?: "eip3009";
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface PreparedBaseX402BuyerChallenge {
  readonly paymentRequiredHeader: string;
  readonly paymentRequired: {
    readonly x402Version: 2;
    readonly accepts: readonly Readonly<Record<string, unknown>>[];
    readonly resource: {
      readonly url: string;
      readonly [key: string]: unknown;
    };
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  readonly accepted: BaseX402BuyerPaymentRequirement;
  readonly evidence: BaseX402ChallengeEvidence;
}

export interface BaseX402BuyerUpstreamResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

declare global {
  namespace Express {
    interface Request {
      kletiaBaseX402Challenge?: BaseX402ChallengeEvidence;
    }
  }
}

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

function paymentCap(value: unknown): {
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

function publicHttpsUrl(value: unknown): URL {
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

async function resolvePinnedPublicDestination(hostname: string): Promise<{
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

async function requestPinnedX402Challenge(
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

function scalarHeader(
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

function decodePaymentRequiredHeader(value: unknown): unknown {
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

function requiredQueryParams(body: string): string[] {
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

function sameX402Resource(requested: URL, advertised: URL): boolean {
  if (
    requested.origin !== advertised.origin ||
    requested.pathname !== advertised.pathname
  ) {
    return false;
  }

  return !advertised.search || advertised.search === requested.search;
}

export function validateBaseX402Challenge(input: {
  readonly requestUrl: unknown;
  readonly maxPayment: unknown;
  readonly statusCode: number;
  readonly paymentRequired: unknown;
  readonly body?: string;
  readonly observedAt?: string;
}): BaseX402ChallengeEvidence {
  const requestUrl = publicHttpsUrl(input.requestUrl);
  const cap = paymentCap(input.maxPayment);
  if (input.statusCode !== 402) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_REQUIRED",
      "x402 resource did not return a verifiable HTTP 402 response without payment.",
      502,
    );
  }
  const challenge = x402ChallengeSchema.safeParse(
    decodePaymentRequiredHeader(input.paymentRequired),
  );
  if (!challenge.success) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 PAYMENT-REQUIRED v2 envelope is invalid.",
      502,
    );
  }
  let resourceUrl: URL;
  try {
    resourceUrl = publicHttpsUrl(challenge.data.resource.url);
  } catch {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_RESOURCE_MISMATCH",
      "Resource URL in x402 payment envelope does not match the active request.",
      502,
    );
  }
  if (!sameX402Resource(requestUrl, resourceUrl)) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_RESOURCE_MISMATCH",
      "Resource URL in x402 payment envelope does not match the active request.",
      502,
    );
  }

  const requirement = challenge.data.accepts.find((candidate) => {
    if (
      candidate.scheme !== "exact" ||
      candidate.network !== BASE_CAIP_NETWORK ||
      !/^(?:0|[1-9]\d*)$/u.test(candidate.amount) ||
      !isAddress(candidate.asset) ||
      !isAddress(candidate.payTo)
    ) {
      return false;
    }
    try {
      return (
        getAddress(candidate.asset) === getAddress(TOKENS.USDC) &&
        getAddress(candidate.payTo) !==
          "0x0000000000000000000000000000000000000000" &&
        BigInt(candidate.amount) > 0n &&
        BigInt(candidate.amount) <= cap.atomic &&
        (candidate.maxTimeoutSeconds === undefined ||
          candidate.maxTimeoutSeconds <= 300)
      );
    } catch {
      return false;
    }
  });
  if (!requirement) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_POLICY_MISMATCH",
      "x402 payment requirement does not match Base Mainnet, USDC, exact scheme, or user cap.",
    );
  }
  const requiredParams = requiredQueryParams(input.body || "");
  const missingParams = requiredParams.filter(
    (key) => !requestUrl.searchParams.get(key)?.trim(),
  );
  if (missingParams.length > 0) {
    throw new BaseX402IntentError(
      "X402_REQUIRED_INPUT_MISSING",
      `The x402 call requires the following mandatory URL parameters before payment: ${missingParams.join(", ")}. Resend the intent specifying the parameters explicitly.`,
    );
  }
  const observedAt = input.observedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 payment preflight time is invalid.",
      502,
    );
  }
  return {
    policyVersion: "kletia_x402_challenge_v1",
    status: "verified",
    method: "GET",
    sourceRequestUrl: requestUrl.toString(),
    requestUrl: requestUrl.toString(),
    resourceUrl: resourceUrl.toString(),
    network: BASE_CAIP_NETWORK,
    chainId: NETWORKS.base.chainId,
    scheme: "exact",
    asset: getAddress(requirement.asset),
    payTo: getAddress(requirement.payTo),
    amountAtomic: requirement.amount,
    amount: formatUnits(BigInt(requirement.amount), USDC_DECIMALS),
    maxPayment: cap.decimal,
    ...(requirement.maxTimeoutSeconds === undefined
      ? {}
      : { maxTimeoutSeconds: requirement.maxTimeoutSeconds }),
    requiredParams,
    observedAt: new Date(observedAt).toISOString(),
  };
}

function safeDescription(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
  return normalized || "CDP Bazaar x402 resource";
}

function sanitizeSkillUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return publicHttpsUrl(value).toString();
  } catch {
    return undefined;
  }
}

function applyDeclaredGetInput(
  resourceUrl: URL,
  value: unknown,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 20) return undefined;

  const preparedUrl = new URL(resourceUrl);
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      return undefined;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      return undefined;
    }
    const normalized = String(rawValue);
    if (normalized.length > 200) return undefined;
    preparedUrl.searchParams.set(key, normalized);
  }
  const result = preparedUrl.toString();
  return result.length <= 2_048 ? result : undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DISCOVERY_RESPONSE_BYTES
  ) {
    throw new BaseX402IntentError(
      "X402_BAZAAR_RESPONSE_TOO_LARGE",
      "CDP Bazaar response exceeded safe size limit.",
      502,
    );
  }
  if (!response.body) {
    throw new BaseX402IntentError(
      "X402_BAZAAR_RESPONSE_INVALID",
      "CDP Bazaar returned an empty response.",
      502,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BaseX402IntentError(
        "X402_BAZAAR_RESPONSE_TOO_LARGE",
        "CDP Bazaar response exceeded safe size limit.",
        502,
      );
    }
    chunks.push(value);
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ) as unknown;
  } catch {
    throw new BaseX402IntentError(
      "X402_BAZAAR_RESPONSE_INVALID",
      "CDP Bazaar did not return a verifiable JSON response.",
      502,
    );
  }
}

function cachedDiscovery(cacheKey: string): BazaarSearchPayload | null {
  const entry = discoveryCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    discoveryCache.delete(cacheKey);
    return null;
  }
  discoveryCache.delete(cacheKey);
  discoveryCache.set(cacheKey, entry);
  return entry.payload;
}

function storeDiscovery(cacheKey: string, payload: BazaarSearchPayload): void {
  discoveryCache.set(cacheKey, {
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    payload,
  });
  if (discoveryCache.size > MAX_DISCOVERY_CACHE_ENTRIES) {
    const oldest = discoveryCache.keys().next().value;
    if (oldest) discoveryCache.delete(oldest);
  }
}

async function fetchDiscovery(endpoint: URL): Promise<BazaarSearchPayload> {
  const cacheKey = endpoint.toString();
  const cached = cachedDiscovery(cacheKey);
  if (cached) return cached;

  const activeRequest = discoveryRequests.get(cacheKey);
  if (activeRequest) return activeRequest;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new BaseX402IntentError(
          "X402_BAZAAR_UNAVAILABLE",
          "CDP Bazaar service search is currently unavailable.",
          502,
        );
      }
      const payload = bazaarSearchSchema.safeParse(
        await readBoundedJson(response),
      );
      if (!payload.success || payload.data.x402Version !== 2) {
        throw new BaseX402IntentError(
          "X402_BAZAAR_RESPONSE_INVALID",
          "CDP Bazaar did not return a verifiable v2 response.",
          502,
        );
      }
      storeDiscovery(cacheKey, payload.data);
      return payload.data;
    } catch (error) {
      if (error instanceof BaseX402IntentError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new BaseX402IntentError(
          "X402_BAZAAR_TIMEOUT",
          "CDP Bazaar service search timed out.",
          504,
        );
      }
      throw new BaseX402IntentError(
        "X402_BAZAAR_UNAVAILABLE",
        "CDP Bazaar service search is currently unavailable.",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  })();

  discoveryRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    discoveryRequests.delete(cacheKey);
  }
}

export function clearBaseX402DiscoveryCacheForTests(): void {
  discoveryCache.clear();
  discoveryRequests.clear();
}

export function validateBaseX402Resource(
  rawResource: unknown,
  maxPaymentAtomic: bigint,
): BaseX402Service | null {
  const parsed = bazaarResourceSchema.safeParse(rawResource);
  if (!parsed.success) return null;
  const resource = parsed.data;
  if (
    resource.type !== "http" ||
    resource.x402Version !== 2 ||
    !Number.isFinite(Date.parse(resource.lastUpdated))
  ) {
    return null;
  }

  let resourceUrl: URL;
  try {
    resourceUrl = publicHttpsUrl(resource.resource);
  } catch {
    return null;
  }

  const requirement = resource.accepts.find((candidate) => {
    if (
      candidate.scheme !== "exact" ||
      candidate.network !== BASE_CAIP_NETWORK ||
      !/^(?:0|[1-9]\d*)$/.test(candidate.amount) ||
      !isAddress(candidate.asset) ||
      !isAddress(candidate.payTo)
    ) {
      return false;
    }
    return (
      getAddress(candidate.asset) === getAddress(TOKENS.USDC) &&
      BigInt(candidate.amount) > 0n &&
      BigInt(candidate.amount) <= maxPaymentAtomic
    );
  });
  if (!requirement) return null;
  const rawMethod =
    resource.extensions?.bazaar?.info?.input?.method?.toUpperCase();
  const method =
    rawMethod === "GET" || rawMethod === "POST" ? rawMethod : undefined;
  const requestUrl =
    method === "GET"
      ? applyDeclaredGetInput(
          resourceUrl,
          resource.extensions?.bazaar?.info?.input?.queryParams,
        )
      : undefined;

  return {
    resource: resourceUrl.toString(),
    description: safeDescription(
      resource.description || resource.metadata?.description,
    ),
    curated: resource.curated === true,
    lastUpdated: new Date(resource.lastUpdated).toISOString(),
    ...(method ? { method } : {}),
    ...(requestUrl ? { requestUrl } : {}),
    scheme: "exact",
    network: BASE_CAIP_NETWORK,
    asset: getAddress(requirement.asset),
    payTo: getAddress(requirement.payTo),
    amountAtomic: requirement.amount,
    amount: formatUnits(BigInt(requirement.amount), USDC_DECIMALS),
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    skillUrl: sanitizeSkillUrl(resource.skillUrl),
  };
}

export async function discoverBaseX402Services(input: {
  query: unknown;
  maxPayment: unknown;
  curatedOnly?: boolean;
}) {
  const query = String(input.query ?? "").trim();
  if (!QUERY_PATTERN.test(query)) {
    throw new BaseX402IntentError(
      "X402_DISCOVERY_QUERY_INVALID",
      "x402 service search must contain 2-120 visible characters.",
    );
  }
  if (containsSensitivePromptMaterial(query)) {
    throw new BaseX402IntentError(
      "X402_DISCOVERY_SENSITIVE_QUERY",
      "x402 service search cannot include private key, seed phrase, or API credentials.",
    );
  }
  const cap = paymentCap(input.maxPayment);
  const effectiveCuratedOnly = input.curatedOnly !== false;
  const endpoint = new URL(CDP_BAZAAR_SEARCH_URL);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("network", BASE_CAIP_NETWORK);
  endpoint.searchParams.set("asset", getAddress(TOKENS.USDC));
  endpoint.searchParams.set("scheme", "exact");
  endpoint.searchParams.set("maxUsdPrice", cap.decimal);
  endpoint.searchParams.set("limit", String(MAX_RESULTS));
  endpoint.searchParams.set(
    "curatedOnly",
    effectiveCuratedOnly ? "true" : "false",
  );

  const payload = await fetchDiscovery(endpoint);
  const services = payload.resources
    .map((resource) => validateBaseX402Resource(resource, cap.atomic))
    .filter((service): service is BaseX402Service => service !== null)
    .filter((service) => !effectiveCuratedOnly || service.curated === true)
    .slice(0, MAX_RESULTS);

  return {
    status: "success" as const,
    action: "x402_discover",
    actionType: "x402_discover",
    executionKind: "base_x402_discovery" as const,
    provider: "Coinbase CDP Bazaar" as const,
    services,
    search: {
      query,
      curatedOnly: effectiveCuratedOnly,
      maxPayment: cap.decimal,
      maxPaymentAtomic: cap.atomic.toString(),
      network: BASE_CAIP_NETWORK,
      asset: getAddress(TOKENS.USDC),
      partialResults: payload.partialResults,
      method: payload.searchMethod,
    },
    winnerMessage:
      services.length > 0
        ? `${services.length} Base Mainnet x402 service has been verified against the payment cap via CDP Bazaar.`
        : "CDP Bazaar did not return a verified Base Mainnet service for this query and payment cap.",
    trustNotice:
      "Bazaar is discovery data; the curated tag is not a security guarantee. Without Kletia registry claim-proof, no result is considered attested or trusted. Payment requires separate user approval and paid responses accept external data.",
  };
}

function boundedJsonBody(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BaseX402IntentError(
      "X402_BODY_INVALID",
      "x402 POST body must be a JSON object.",
    );
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new BaseX402IntentError(
      "X402_BODY_TOO_LARGE",
      "x402 POST body cannot exceed 4096 bytes.",
    );
  }
  return JSON.parse(serialized) as unknown;
}

function promptPaymentCaps(prompt: string): Array<{
  readonly atomic: bigint;
  readonly decimal: string;
}> {
  const scrubbed = prompt
    .replace(/https:\/\/[^\s<>"']+/giu, " ")
    .replace(/0x[a-f\d]{40}/giu, " ");
  const amount = String.raw`((?:\d+(?:[.,]\d+)?|[.,]\d+))`;
  const candidates: string[] = [];
  const prefixPattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:max(?:imum)?|at\s+most|up\s+to|no\s+more\s+than|payment\s+(?:cap|limit|ceiling)|cap(?:\s+(?:one|each|per)\s+(?:call|request))?|en\s+fazla|ödeme\s+(?:tavanı|limiti)|tavan|üst\s+sınır)(?=$|[^\p{L}\p{N}_])[^\d\r\n]{0,48}${amount}\s*USDC\b`,
    "giu",
  );
  const suffixPattern = new RegExp(
    String.raw`${amount}\s*USDC\b[^\d\r\n]{0,32}(?:max(?:imum)?|cap|limit|ceiling|at\s+most|or\s+(?:less|under)|under|below|tavan|sınır(?:la|ı)?|altında|altinda|veya\s+daha\s+az)(?=$|[^\p{L}\p{N}_])`,
    "giu",
  );
  for (const pattern of [prefixPattern, suffixPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(scrubbed)) !== null) {
      candidates.push(match[1]);
    }
  }
  const caps = new Map<
    string,
    {
      readonly atomic: bigint;
      readonly decimal: string;
    }
  >();
  for (const candidate of candidates) {
    const normalized = candidate.replace(",", ".").replace(/^\./, "0.");
    if (!DECIMAL_USDC.test(normalized)) continue;
    try {
      const atomic = parseUnits(normalized, USDC_DECIMALS);
      caps.set(atomic.toString(), {
        atomic,
        decimal: formatUnits(atomic, USDC_DECIMALS),
      });
    } catch {
      // An invalid decimal can never authorize a payment cap.
    }
  }
  return [...caps.values()];
}

function promptContainsPaymentCap(
  prompt: string,
  expectedAtomic: bigint,
): boolean {
  return promptPaymentCaps(prompt).some(
    ({ atomic }) => atomic === expectedAtomic,
  );
}

export async function preflightExplicitBaseX402GetPrompt(
  sourcePrompt: string,
  activeUserAddress?: unknown,
): Promise<BaseX402ChallengeEvidence | null> {
  if (
    !/\bx402\b/iu.test(sourcePrompt) ||
    !/\bGET\b/iu.test(sourcePrompt) ||
    /\bPOST\b/iu.test(sourcePrompt)
  ) {
    return null;
  }
  const urlCandidates = (
    sourcePrompt.match(/https:\/\/[^\s<>"']+/giu) || []
  ).map((candidate) => candidate.replace(/[),.;!?]+$/gu, ""));
  const uniqueUrls = [
    ...new Set(
      urlCandidates.flatMap((candidate) => {
        try {
          return [publicHttpsUrl(candidate).toString()];
        } catch {
          return [];
        }
      }),
    ),
  ];
  const caps = promptPaymentCaps(sourcePrompt);
  if (uniqueUrls.length !== 1 || caps.length !== 1) return null;
  const cap = paymentCap(caps[0].decimal);
  const sourceRequestUrl = publicHttpsUrl(uniqueUrls[0]);
  let requestUrl = new URL(sourceRequestUrl);
  let response = await requestPinnedX402Challenge(requestUrl);
  const missingParams = requiredQueryParams(response.body).filter(
    (key) => !requestUrl.searchParams.get(key)?.trim(),
  );
  let walletInputBinding:
    BaseX402ChallengeEvidence["walletInputBinding"] | undefined;
  if (missingParams.length > 0) {
    const parameter =
      missingParams.length === 1 ? missingParams[0].toLowerCase() : "";
    let walletAddress: string;
    try {
      walletAddress = getAddress(String(activeUserAddress || ""));
      if (walletAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("zero_address");
      }
    } catch {
      walletAddress = "";
    }
    if ((parameter !== "address" && parameter !== "wallet") || !walletAddress) {
      throw new BaseX402IntentError(
        "X402_REQUIRED_INPUT_MISSING",
        `The x402 call requires the following mandatory URL parameters before payment: ${missingParams.join(", ")}. Resend the intent specifying the parameters explicitly.`,
      );
    }
    requestUrl = new URL(sourceRequestUrl);
    requestUrl.searchParams.set(parameter, walletAddress);
    walletInputBinding = {
      parameter,
      value: walletAddress,
      source: "active_user_address",
    };

    response = await requestPinnedX402Challenge(requestUrl);
  }
  const evidence = validateBaseX402Challenge({
    requestUrl: requestUrl.toString(),
    maxPayment: cap.decimal,
    statusCode: response.statusCode,
    paymentRequired:
      scalarHeader(response.headers, "payment-required") ||
      scalarHeader(response.headers, "x-payment-required"),
    body: response.body,
  });
  return {
    ...evidence,
    sourceRequestUrl: sourceRequestUrl.toString(),
    ...(walletInputBinding ? { walletInputBinding } : {}),
  };
}

function exactBuyerRequirement(
  candidate: z.infer<typeof paymentRequirementSchema>,
  evidence: BaseX402ChallengeEvidence,
): BaseX402BuyerPaymentRequirement | null {
  const extra = candidate.extra;
  if (
    candidate.scheme !== "exact" ||
    candidate.network !== BASE_CAIP_NETWORK ||
    candidate.amount !== evidence.amountAtomic ||
    candidate.maxTimeoutSeconds === undefined ||
    candidate.maxTimeoutSeconds !== evidence.maxTimeoutSeconds ||
    !extra ||
    extra.name !== "USD Coin" ||
    extra.version !== "2" ||
    (extra.assetTransferMethod !== undefined &&
      extra.assetTransferMethod !== "eip3009")
  ) {
    return null;
  }
  try {
    if (
      getAddress(candidate.asset) !== getAddress(evidence.asset) ||
      getAddress(candidate.payTo) !== getAddress(evidence.payTo)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    ...candidate,
    scheme: "exact",
    network: BASE_CAIP_NETWORK,
    amount: evidence.amountAtomic,
    asset: getAddress(candidate.asset),
    payTo: getAddress(candidate.payTo),
    maxTimeoutSeconds: candidate.maxTimeoutSeconds,
    extra: {
      ...extra,
      name: "USD Coin",
      version: "2",
      ...(extra.assetTransferMethod === undefined
        ? {}
        : { assetTransferMethod: "eip3009" as const }),
    },
  };
}

export async function prepareBaseX402BuyerChallenge(input: {
  readonly url: unknown;
  readonly maxPayment: unknown;
  readonly wallet: unknown;
}): Promise<PreparedBaseX402BuyerChallenge> {
  const requestUrl = publicHttpsUrl(input.url);
  const cap = paymentCap(input.maxPayment);
  let wallet: string;
  try {
    wallet = getAddress(String(input.wallet || ""));
    if (wallet === "0x0000000000000000000000000000000000000000") {
      throw new Error("zero_address");
    }
  } catch {
    throw new BaseX402IntentError(
      "X402_BUYER_WALLET_INVALID",
      "x402 buyer wallet must be a valid, non-zero EVM address.",
    );
  }

  const response = await requestPinnedX402Challenge(requestUrl);
  const paymentRequiredHeader =
    scalarHeader(response.headers, "payment-required") ||
    scalarHeader(response.headers, "x-payment-required");
  const decoded = decodePaymentRequiredHeader(paymentRequiredHeader);
  const parsed = x402ChallengeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 PAYMENT-REQUIRED v2 envelope is invalid.",
      502,
    );
  }
  const evidence = validateBaseX402Challenge({
    requestUrl: requestUrl.toString(),
    maxPayment: cap.decimal,
    statusCode: response.statusCode,
    paymentRequired: paymentRequiredHeader,
    body: response.body,
  });
  if (evidence.maxTimeoutSeconds === undefined) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_POLICY_MISMATCH",
      "x402 payment requirement does not specify a limited authorization duration.",
      502,
    );
  }

  const walletParams = [...requestUrl.searchParams.entries()].filter(
    ([parameter]) => {
      const normalized = parameter.toLowerCase();
      return normalized === "address" || normalized === "wallet";
    },
  );
  if (walletParams.length > 1) {
    throw new BaseX402IntentError(
      "X402_BUYER_WALLET_URL_AMBIGUOUS",
      "x402 URL cannot contain multiple address/wallet entries simultaneously.",
    );
  }
  for (const [, supplied] of walletParams) {
    try {
      if (getAddress(supplied) !== wallet) {
        throw new Error("wallet_mismatch");
      }
    } catch {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_MISMATCH",
        "x402 address/wallet entry must match the active buyer wallet.",
      );
    }
  }

  for (const parameter of evidence.requiredParams) {
    const normalized = parameter.toLowerCase();
    if (normalized !== "address" && normalized !== "wallet") continue;
    const matches = [...requestUrl.searchParams.entries()].filter(
      ([candidate]) => candidate.toLowerCase() === normalized,
    );
    if (matches.length !== 1) {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_AMBIGUOUS",
        `x402 ${parameter} girdisi tekil olarak belirtilmelidir.`,
      );
    }
    const supplied = matches[0]?.[1];
    try {
      if (!supplied || getAddress(supplied) !== wallet) {
        throw new Error("wallet_mismatch");
      }
    } catch {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_MISMATCH",
        `The x402 ${parameter} input must match the active recipient wallet.`,
      );
    }
  }

  const eligible = parsed.data.accepts.flatMap((candidate) => {
    const normalized = exactBuyerRequirement(candidate, evidence);
    return normalized ? [normalized] : [];
  });
  if (parsed.data.accepts.length !== 1 || eligible.length !== 1) {
    throw new BaseX402IntentError(
      eligible.length === 0
        ? "X402_BUYER_EIP3009_REQUIRED"
        : "X402_BUYER_REQUIREMENT_AMBIGUOUS",
      eligible.length === 0
        ? "x402 buyer relay only accepts Base USDC EIP-3009 exact requirement."
        : "x402 buyer relay cannot sign multiple matching payment requirements.",
    );
  }

  return {
    paymentRequiredHeader: paymentRequiredHeader!,
    paymentRequired: JSON.parse(
      JSON.stringify(parsed.data),
    ) as PreparedBaseX402BuyerChallenge["paymentRequired"],
    accepted: eligible[0],
    evidence,
  };
}

export async function forwardPinnedBaseX402BuyerPayment(input: {
  readonly url: unknown;
  readonly paymentSignature: string;
}): Promise<BaseX402BuyerUpstreamResponse> {
  const url = publicHttpsUrl(input.url);
  if (
    typeof input.paymentSignature !== "string" ||
    input.paymentSignature.length < 4 ||
    input.paymentSignature.length > MAX_PREFLIGHT_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.paymentSignature)
  ) {
    throw new BaseX402IntentError(
      "X402_PAYMENT_SIGNATURE_INVALID",
      "PAYMENT-SIGNATURE header is invalid or exceeds safe size limits.",
    );
  }
  const destination = await resolvePinnedPublicDestination(url.hostname);
  return new Promise<BaseX402BuyerUpstreamResponse>((resolve, reject) => {
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
          "Payment-Signature": input.paymentSignature,
          "User-Agent": "Kletia-x402-buyer-relay/1.0",
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
          if (bytes > MAX_PAID_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new BaseX402IntentError(
                "X402_PAID_RESPONSE_TOO_LARGE",
                "Paid x402 response exceeded safe size limits.",
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
    request.setTimeout(PAID_REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_TIMEOUT",
          "The result of the paid x402 relay request could not be verified in time.",
          504,
        ),
      );
    });
    absoluteTimeout = setTimeout(() => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_TIMEOUT",
          "The result of the paid x402 relay request could not be verified in time.",
          504,
        ),
      );
    }, PAID_REQUEST_TIMEOUT_MS);
    request.on("error", (error) => {
      if (error instanceof BaseX402IntentError) return fail(error);
      return fail(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_INDETERMINATE",
          "The result of the paid x402 relay request could not be verified; no automatic retry will be performed.",
          502,
        ),
      );
    });
    request.end();
  });
}

function promptContainsUrl(prompt: string, expectedUrl: string): boolean {
  const candidates = prompt.match(/https:\/\/[^\s<>"']+/giu) || [];
  return candidates.some((candidate) => {
    try {
      return (
        publicHttpsUrl(candidate.replace(/[),.;!?]+$/g, "")).toString() ===
        expectedUrl
      );
    } catch {
      return false;
    }
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function promptContainsJsonObject(
  prompt: string,
  expectedValue: unknown,
): boolean {
  const expected = canonicalJson(expectedValue);
  for (let start = 0; start < prompt.length; start += 1) {
    if (prompt[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < prompt.length; index += 1) {
      const char = prompt[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(prompt.slice(start, index + 1));
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              canonicalJson(parsed) === expected
            ) {
              return true;
            }
          } catch {}
          start = index;
          break;
        }
      }
    }
  }
  return false;
}

export function assertBaseX402PaymentPromptBinding(
  maxPayment: unknown,
  sourcePrompt: string,
): void {
  const cap = paymentCap(maxPayment);
  if (
    !sourcePrompt.trim() ||
    !promptContainsPaymentCap(sourcePrompt, cap.atomic)
  ) {
    throw new BaseX402IntentError(
      "X402_PROMPT_PAYMENT_UNBOUND",
      "The x402 payment cap must match the open USDC amount in the current user message.",
    );
  }
}

export function buildBaseMcpX402Plan(
  intent: ParsedIntent,
  requestId: string,
  sourcePrompt?: string,
  challengeEvidence?: BaseX402ChallengeEvidence,
  activeUserAddress?: unknown,
) {
  const sourceUrl = publicHttpsUrl(intent.url).toString();
  let url = sourceUrl;
  const method = String(intent.method || "GET")
    .trim()
    .toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new BaseX402IntentError(
      "X402_METHOD_INVALID",
      "x402 request can only be GET or POST.",
    );
  }
  const cap = paymentCap(intent.maxPayment);
  if (sourcePrompt !== undefined) {
    if (
      !sourcePrompt.trim() ||
      !promptContainsUrl(sourcePrompt, sourceUrl) ||
      !promptContainsPaymentCap(sourcePrompt, cap.atomic)
    ) {
      throw new BaseX402IntentError(
        "X402_PROMPT_BINDING_FAILED",
        "x402 URL and payment cap must match the values in the current user message.",
      );
    }
    if (method === "POST" && !/\bpost\b/iu.test(sourcePrompt)) {
      throw new BaseX402IntentError(
        "X402_PROMPT_METHOD_UNBOUND",
        "The POST method must be explicitly specified in the current user message.",
      );
    }
  }
  const body =
    method === "POST" ? boundedJsonBody(intent.requestBody) : undefined;
  if (
    sourcePrompt !== undefined &&
    method === "POST" &&
    !promptContainsJsonObject(sourcePrompt, body)
  ) {
    throw new BaseX402IntentError(
      "X402_PROMPT_BODY_UNBOUND",
      "The x402 POST JSON body must exactly match the object in the current user message.",
    );
  }
  if (method === "GET" && intent.requestBody !== undefined) {
    throw new BaseX402IntentError(
      "X402_GET_BODY_FORBIDDEN",
      "GET x402 plan cannot contain a requestBody.",
    );
  }
  if (challengeEvidence !== undefined) {
    let evidenceAsset: string;
    let evidencePayTo: string;
    try {
      evidenceAsset = getAddress(challengeEvidence.asset);
      evidencePayTo = getAddress(challengeEvidence.payTo);
    } catch {
      throw new BaseX402IntentError(
        "X402_CHALLENGE_EVIDENCE_MISMATCH",
        "x402 payment pre-check evidence does not match the active intent.",
        500,
      );
    }
    let evidenceRequestUrl: string;
    let evidenceSourceUrl: string;
    try {
      evidenceRequestUrl = publicHttpsUrl(
        challengeEvidence.requestUrl,
      ).toString();
      evidenceSourceUrl = publicHttpsUrl(
        challengeEvidence.sourceRequestUrl,
      ).toString();
    } catch {
      throw new BaseX402IntentError(
        "X402_CHALLENGE_EVIDENCE_MISMATCH",
        "x402 payment pre-check evidence does not match the active intent.",
        500,
      );
    }
    let walletBindingMatches = true;
    if (challengeEvidence.walletInputBinding) {
      let activeWallet: string;
      try {
        activeWallet = getAddress(String(activeUserAddress || ""));
      } catch {
        activeWallet = "";
      }
      const binding = challengeEvidence.walletInputBinding;
      const expectedUrl = new URL(sourceUrl);
      if (expectedUrl.searchParams.has(binding.parameter)) {
        walletBindingMatches = false;
      } else {
        expectedUrl.searchParams.set(binding.parameter, binding.value);
      }
      walletBindingMatches =
        walletBindingMatches &&
        binding.source === "active_user_address" &&
        (binding.parameter === "address" || binding.parameter === "wallet") &&
        binding.value === activeWallet &&
        evidenceRequestUrl === expectedUrl.toString();
    } else {
      walletBindingMatches = evidenceRequestUrl === sourceUrl;
    }
    if (
      challengeEvidence.policyVersion !== "kletia_x402_challenge_v1" ||
      challengeEvidence.status !== "verified" ||
      challengeEvidence.method !== "GET" ||
      method !== "GET" ||
      evidenceSourceUrl !== sourceUrl ||
      !walletBindingMatches ||
      challengeEvidence.network !== BASE_CAIP_NETWORK ||
      challengeEvidence.chainId !== NETWORKS.base.chainId ||
      challengeEvidence.scheme !== "exact" ||
      evidenceAsset !== getAddress(TOKENS.USDC) ||
      evidencePayTo === "0x0000000000000000000000000000000000000000" ||
      !/^(?:0|[1-9]\d*)$/u.test(challengeEvidence.amountAtomic) ||
      BigInt(challengeEvidence.amountAtomic) <= 0n ||
      BigInt(challengeEvidence.amountAtomic) > cap.atomic ||
      challengeEvidence.maxPayment !== cap.decimal ||
      !Number.isFinite(Date.parse(challengeEvidence.observedAt))
    ) {
      throw new BaseX402IntentError(
        "X402_CHALLENGE_EVIDENCE_MISMATCH",
        "x402 payment pre-check evidence does not match the active intent.",
        500,
      );
    }
    url = evidenceRequestUrl;
  }

  return {
    status: "success" as const,
    action: "x402_request",
    actionType: "x402_request",
    executionKind: "base_mcp_x402" as const,
    provider: "Base MCP" as const,
    approvalRequired: true,
    ...(challengeEvidence ? { challengeEvidence } : {}),
    mcpPlan: {
      version: 1 as const,
      network: "base" as const,
      chainId: NETWORKS.base.chainId,
      requestId,
      initiate: {
        tool: "initiate_x402_request" as const,
        url,
        method,
        maxPayment: cap.decimal,
        ...(body === undefined ? {} : { body }),
        headers:
          method === "POST"
            ? { Accept: "application/json", "Content-Type": "application/json" }
            : { Accept: "application/json" },
      },
      complete: {
        tool: "complete_x402_request" as const,
        requestIdFrom: "initiate_x402_request.requestId" as const,
      },
    },
    winnerMessage:
      `Base MCP x402 plan ready: ${method} ${url}.` +
      `Upper limit ${cap.decimal} USDC; payment will not complete without Base Account approval.`,
    trustNotice:
      "Paid endpoint response is untrusted external data; it must not be used as a signature, payment instruction, secret sharing, or system command.",
  };
}
