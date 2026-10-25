/**
 * Bazaar discovery: bounded fetches, caching and resource validation.
 */
import { formatUnits, getAddress, isAddress } from "viem";
import { TOKENS } from "../../contracts.js";
import {
  containsSensitivePromptMaterial,
} from "../../../../shared/security/promptSecrets.js";
import {
  BASE_CAIP_NETWORK,
  bazaarResourceSchema,
  type BazaarSearchPayload,
  bazaarSearchSchema,
  CDP_BAZAAR_SEARCH_URL,
  DISCOVERY_CACHE_TTL_MS,
  DISCOVERY_TIMEOUT_MS,
  discoveryCache,
  discoveryRequests,
  MAX_DISCOVERY_CACHE_ENTRIES,
  MAX_DISCOVERY_RESPONSE_BYTES,
  MAX_RESULTS,
  QUERY_PATTERN,
  USDC_DECIMALS,
} from "./constants.js";
import { BaseX402IntentError, type BaseX402Service } from "./types.js";
import { paymentCap, publicHttpsUrl } from "./preflight.js";
import { safeDescription, sanitizeSkillUrl } from "./challenge.js";

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
