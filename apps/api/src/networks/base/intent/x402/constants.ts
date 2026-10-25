/**
 * Limits, the non-public destination block list, response schemas and
 * the discovery cache.
 */
import { BlockList } from "node:net";
import { z } from "zod";
import { NETWORKS } from "../../../../shared/config/networks.js";

export const BASE_CAIP_NETWORK = `eip155:${NETWORKS.base.chainId}` as const;
export const CDP_BAZAAR_SEARCH_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
export const USDC_DECIMALS = 6;
export const DEFAULT_SERVER_CAP = "1";
export const DISCOVERY_TIMEOUT_MS = 8_000;
export const MAX_RESULTS = 8;
export const MAX_DISCOVERY_RESPONSE_BYTES = 1_048_576;
export const MAX_PREFLIGHT_RESPONSE_BYTES = 32_768;
export const MAX_PREFLIGHT_HEADER_BYTES = 32_768;
export const PREFLIGHT_TIMEOUT_MS = 7_000;
export const DNS_LOOKUP_TIMEOUT_MS = 3_000;
export const MAX_PAID_RESPONSE_BYTES = 1_048_576;
export const PAID_REQUEST_TIMEOUT_MS = 20_000;
export const DISCOVERY_CACHE_TTL_MS = 30_000;
export const MAX_DISCOVERY_CACHE_ENTRIES = 128;
export const QUERY_PATTERN = /^[^\u0000-\u001F\u007F]{2,120}$/u;
export const DECIMAL_USDC = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

export const NON_PUBLIC_DESTINATIONS = new BlockList();
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

export const paymentRequirementSchema = z
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

export const x402ChallengeSchema = z
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

export const bazaarResourceSchema = z
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

export const bazaarSearchSchema = z
  .object({
    resources: z.array(z.unknown()).max(100),
    partialResults: z.boolean(),
    searchMethod: z.enum(["hybrid", "vector", "text"]),
    x402Version: z.number().int(),
  })
  .passthrough();
export type BazaarSearchPayload = z.infer<typeof bazaarSearchSchema>;
type DiscoveryCacheEntry = {
  readonly expiresAt: number;
  readonly payload: BazaarSearchPayload;
};
export const discoveryCache = new Map<string, DiscoveryCacheEntry>();
export const discoveryRequests = new Map<string, Promise<BazaarSearchPayload>>();
