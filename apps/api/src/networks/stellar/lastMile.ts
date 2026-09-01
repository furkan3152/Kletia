import { isIP } from "node:net";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { STELLAR_TESTNET } from "./config.js";
import { findStellarPaymentCenterProviderManifest } from "./paymentCenterProviders.js";

const MAX_REMOTE_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
export const STELLAR_USDC_ASSET = `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`;

const SourceNetworkSchema = z.enum([
  "stellar_testnet",
  "arc_testnet",
  "base_sepolia",
  "arbitrum_sepolia",
]);

const LastMileQuoteRequestSchema = z
  .object({
    sourceNetwork: SourceNetworkSchema,
    amountMode: z.enum(["send_exact", "receive_exact"]),
    amount: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,7})?$/u),
    destinationCountry: z.string().trim().length(2),
    destinationCurrency: z.string().trim().length(3),
    deliveryMethod: z.string().trim().min(1).max(40),
    passkeyAccount: z.string().trim().optional(),
  })
  .strict()
  .transform((value, context) => {
    const amount = Number(value.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Amount must be positive and no greater than 1,000,000,000.",
      });
      return z.NEVER;
    }
    const country = value.destinationCountry.toUpperCase();
    const currency = value.destinationCurrency.toUpperCase();
    if (!/^[A-Z]{2}$/u.test(country) || !/^[A-Z]{3}$/u.test(currency)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationCurrency"],
        message: "Use ISO country and currency codes.",
      });
      return z.NEVER;
    }
    if (
      value.passkeyAccount &&
      !StrKey.isValidContract(value.passkeyAccount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passkeyAccount"],
        message: "The passkey identity must be a valid Stellar C-address.",
      });
      return z.NEVER;
    }
    return {
      ...value,
      destinationCountry: country,
      destinationCurrency: currency,
      deliveryMethod: value.deliveryMethod.toUpperCase(),
    };
  });

export type StellarLastMileQuoteRequest = z.infer<
  typeof LastMileQuoteRequestSchema
>;

export type AnchorDiscovery = {
  domain: string;
  networkPassphrase: string;
  transferServerSep24: string;
  transferServerSep6: string | null;
  directPaymentServer: string | null;
  anchorQuoteServer: string;
  kycServer: string | null;
  webAuthEndpoint: string | null;
  webAuthForContractsEndpoint: string | null;
  webAuthContractId: string | null;
  signingKey: string | null;
  sep45Advertised: boolean;
};

type Sep24AssetInfo = {
  enabled?: unknown;
  min_amount?: unknown;
  max_amount?: unknown;
};

type Sep38Asset = {
  asset: string;
  country_codes?: unknown;
  buy_delivery_methods?: unknown;
};

export type StellarLastMileCandidate = {
  provider: string;
  sourceNetwork: StellarLastMileQuoteRequest["sourceNetwork"];
  sourceAsset: "USDC";
  destinationCountry: string;
  destinationCurrency: string;
  deliveryMethod: string;
  sellAmount: string;
  buyAmount: string;
  totalPrice: string;
  price: string;
  fee: { total: string; asset: string } | null;
  quoteType: "indicative";
  observedAt: string;
  sep24: true;
  sep31PartnerAdvertised: boolean;
  sep38: true;
  settlementMode: "sep24_hosted_withdrawal";
  sep12Advertised: boolean;
  sep45Advertised: boolean;
  providerRole: "reference_anchor" | "reviewed_anchor" | "operator_allowlisted";
  realWorldSettlement: boolean | null;
  passkeyIdentityBound: false;
  executionReady: false;
  blockedReason: string;
  mockData: false;
};

export type StellarLastMileReadiness = {
  enabled: boolean;
  configuredAnchors: number;
  paymentCore: "unavailable" | "discovery_configured";
  identity: "stellar_secp256r1_contract_account";
  settlement: "sep24_hosted_withdrawal";
  pricing: "sep38_live_indicative";
  execution: "provider_and_user_authorization_required";
  reason: string;
  mockData: false;
};

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function envEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true";
}

function csv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function safeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    Boolean(host) &&
    isIP(host) === 0 &&
    host !== "localhost" &&
    host !== "localhost.localdomain" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal")
  );
}

export function normalizeAnchorOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw controlled(
      "STELLAR_ANCHOR_ALLOWLIST_INVALID",
      "Every Stellar anchor allowlist entry must be a valid HTTPS host.",
      500,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !safeHost(url.hostname)
  ) {
    throw controlled(
      "STELLAR_ANCHOR_ALLOWLIST_INVALID",
      "Stellar anchor allowlist entries must be public HTTPS origins without paths or credentials.",
      500,
    );
  }
  return url.origin;
}

function configuredAnchorOrigins(): string[] {
  return [...new Set(csv("STELLAR_ANCHOR_ALLOWLIST").map(normalizeAnchorOrigin))];
}

function configuredEndpointHosts(anchorOrigins: readonly string[]): Set<string> {
  const hosts = new Set(anchorOrigins.map((origin) => new URL(origin).hostname));
  for (const entry of csv("STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST")) {
    const normalized = normalizeAnchorOrigin(entry);
    hosts.add(new URL(normalized).hostname);
  }
  return hosts;
}

export function readConfiguredPaymentCenterEndpointHosts(): ReadonlySet<string> {
  return configuredEndpointHosts(configuredAnchorOrigins());
}

export function assertAllowedAnchorEndpoint(
  value: string,
  allowedHosts: ReadonlySet<string>,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw controlled(
      "STELLAR_ANCHOR_DISCOVERY_INVALID",
      "The anchor published an invalid endpoint.",
      502,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !safeHost(url.hostname) ||
    !allowedHosts.has(url.hostname)
  ) {
    throw controlled(
      "STELLAR_ANCHOR_ENDPOINT_NOT_ALLOWED",
      "The anchor endpoint is outside Kletia's reviewed host allowlist.",
      502,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function assertAllowedAnchorInteractiveUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw controlled(
      "STELLAR_ANCHOR_INTERACTIVE_URL_INVALID",
      "The anchor returned an invalid hosted-withdrawal URL.",
      502,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !safeHost(url.hostname) ||
    !allowedHosts.has(url.hostname)
  ) {
    throw controlled(
      "STELLAR_ANCHOR_INTERACTIVE_URL_NOT_ALLOWED",
      "The hosted-withdrawal URL is outside Kletia's reviewed provider hosts.",
      502,
    );
  }
  return url.toString();
}

const DISCOVERY_KEYS = new Set([
  "NETWORK_PASSPHRASE",
  "TRANSFER_SERVER",
  "TRANSFER_SERVER_SEP0024",
  "DIRECT_PAYMENT_SERVER",
  "ANCHOR_QUOTE_SERVER",
  "KYC_SERVER",
  "WEB_AUTH_ENDPOINT",
  "WEB_AUTH_FOR_CONTRACTS_ENDPOINT",
  "WEB_AUTH_CONTRACT_ID",
  "SIGNING_KEY",
]);

export function parseAnchorStellarToml(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  let globalSection = true;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      globalSection = false;
      continue;
    }
    if (!globalSection) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*(["'])([^\r\n]*?)\2\s*(?:#.*)?$/u.exec(
      line,
    );
    if (match && DISCOVERY_KEYS.has(match[1])) result[match[1]] = match[3];
  }
  return result;
}

async function readLimitedText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "text/plain, application/toml, application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw controlled(
      "STELLAR_ANCHOR_UNAVAILABLE",
      `Anchor returned HTTP ${response.status}.`,
      502,
    );
  }
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_REMOTE_BODY_BYTES) {
    throw controlled(
      "STELLAR_ANCHOR_RESPONSE_TOO_LARGE",
      "Anchor response exceeded Kletia's safety limit.",
      502,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REMOTE_BODY_BYTES) {
    throw controlled(
      "STELLAR_ANCHOR_RESPONSE_TOO_LARGE",
      "Anchor response exceeded Kletia's safety limit.",
      502,
    );
  }
  return new TextDecoder().decode(bytes);
}

async function readJsonObject(
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const text = await readLimitedText(url, timeoutMs);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw controlled(
      "STELLAR_ANCHOR_RESPONSE_INVALID",
      "Anchor returned invalid JSON.",
      502,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled(
      "STELLAR_ANCHOR_RESPONSE_INVALID",
      "Anchor returned an invalid response object.",
      502,
    );
  }
  return value as Record<string, unknown>;
}

async function discoverAnchor(
  origin: string,
  endpointHosts: ReadonlySet<string>,
  timeoutMs: number,
): Promise<AnchorDiscovery> {
  const toml = parseAnchorStellarToml(
    await readLimitedText(`${origin}/.well-known/stellar.toml`, timeoutMs),
  );
  if (!toml.TRANSFER_SERVER_SEP0024 || !toml.ANCHOR_QUOTE_SERVER) {
    throw controlled(
      "STELLAR_ANCHOR_PROTOCOL_INCOMPLETE",
      "Anchor does not advertise both SEP-24 and SEP-38.",
      503,
    );
  }
  if (toml.NETWORK_PASSPHRASE !== STELLAR_TESTNET.networkPassphrase) {
    throw controlled(
      "STELLAR_ANCHOR_NETWORK_MISMATCH",
      "Anchor discovery is not bound to the Stellar Testnet passphrase.",
      503,
    );
  }
  const optionalEndpoint = (key: string): string | null =>
    toml[key] ? assertAllowedAnchorEndpoint(toml[key], endpointHosts) : null;
  const webAuthForContractsEndpoint = optionalEndpoint(
    "WEB_AUTH_FOR_CONTRACTS_ENDPOINT",
  );
  const webAuthContractId = toml.WEB_AUTH_CONTRACT_ID || null;
  const signingKey = toml.SIGNING_KEY || null;
  return {
    domain: new URL(origin).hostname,
    networkPassphrase: toml.NETWORK_PASSPHRASE,
    transferServerSep24: assertAllowedAnchorEndpoint(
      toml.TRANSFER_SERVER_SEP0024,
      endpointHosts,
    ),
    transferServerSep6: optionalEndpoint("TRANSFER_SERVER"),
    directPaymentServer: optionalEndpoint("DIRECT_PAYMENT_SERVER"),
    anchorQuoteServer: assertAllowedAnchorEndpoint(
      toml.ANCHOR_QUOTE_SERVER,
      endpointHosts,
    ),
    kycServer: optionalEndpoint("KYC_SERVER"),
    webAuthEndpoint: optionalEndpoint("WEB_AUTH_ENDPOINT"),
    webAuthForContractsEndpoint,
    webAuthContractId,
    signingKey,
    sep45Advertised: Boolean(
      webAuthForContractsEndpoint && webAuthContractId && signingKey,
    ),
  };
}

export async function discoverConfiguredPaymentCenterProvider(
  domain: string,
): Promise<AnchorDiscovery> {
  const origins = configuredAnchorOrigins();
  const origin = origins.find((candidate) => new URL(candidate).hostname === domain);
  if (!origin) {
    throw controlled(
      "STELLAR_ANCHOR_NOT_CONFIGURED",
      "The requested payment provider is not in Kletia's reviewed allowlist.",
      404,
    );
  }
  const timeoutMs = Math.min(
    15_000,
    Math.max(
      2_000,
      Number(process.env.STELLAR_ANCHOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    ),
  );
  return discoverAnchor(origin, configuredEndpointHosts(origins), timeoutMs);
}

function optionalBound(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw controlled(
      "STELLAR_ANCHOR_INFO_INVALID",
      `Anchor SEP-24 field ${field} is invalid.`,
      502,
    );
  }
  return parsed;
}

function assertSep24Amount(
  sellAmount: string,
  minimum: number | null,
  maximum: number | null,
): void {
  const amount = Number(sellAmount);
  if (minimum !== null && amount < minimum) {
    throw controlled(
      "STELLAR_ANCHOR_AMOUNT_BELOW_MINIMUM",
      `Anchor SEP-24 minimum is ${minimum} USDC.`,
      503,
    );
  }
  if (maximum !== null && amount > maximum) {
    throw controlled(
      "STELLAR_ANCHOR_AMOUNT_ABOVE_MAXIMUM",
      `Anchor SEP-24 maximum is ${maximum} USDC.`,
      503,
    );
  }
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) {
    throw controlled(
      "STELLAR_ANCHOR_QUOTE_INVALID",
      `Anchor quote field ${field} is invalid.`,
      502,
    );
  }
  return value;
}

function supportsDestination(
  assets: unknown,
  request: StellarLastMileQuoteRequest,
): boolean {
  if (!Array.isArray(assets)) return false;
  const expected = `iso4217:${request.destinationCurrency}`;
  return assets.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const asset = candidate as Sep38Asset;
    if (asset.asset !== expected) return false;
    const countries = Array.isArray(asset.country_codes)
      ? asset.country_codes.filter((value): value is string => typeof value === "string")
      : [];
    if (
      countries.length > 0 &&
      !countries.some(
        (country) =>
          country.toUpperCase() === request.destinationCountry ||
          country.toUpperCase().startsWith(`${request.destinationCountry}-`),
      )
    ) {
      return false;
    }
    const deliveryMethods = Array.isArray(asset.buy_delivery_methods)
      ? asset.buy_delivery_methods
          .flatMap((method) =>
            method && typeof method === "object" && !Array.isArray(method)
              ? [String((method as Record<string, unknown>).name || "").toUpperCase()]
              : [],
          )
          .filter(Boolean)
      : [];
    return (
      deliveryMethods.length === 0 ||
      deliveryMethods.includes(request.deliveryMethod)
    );
  });
}

async function quoteAnchor(
  anchor: AnchorDiscovery,
  request: StellarLastMileQuoteRequest,
  timeoutMs: number,
): Promise<StellarLastMileCandidate> {
  const [sep24Info, sep38Info] = await Promise.all([
    readJsonObject(`${anchor.transferServerSep24}/info`, timeoutMs),
    readJsonObject(`${anchor.anchorQuoteServer}/info`, timeoutMs),
  ]);
  const withdraw = sep24Info.withdraw;
  const usdc =
    withdraw && typeof withdraw === "object" && !Array.isArray(withdraw)
      ? (withdraw as Record<string, unknown>).USDC
      : null;
  if (!usdc || typeof usdc !== "object" || Array.isArray(usdc)) {
    throw controlled(
      "STELLAR_ANCHOR_USDC_UNSUPPORTED",
      "Anchor does not offer a SEP-24 USDC withdrawal.",
      503,
    );
  }
  const usdcInfo = usdc as Sep24AssetInfo;
  if (usdcInfo.enabled !== true) {
    throw controlled(
      "STELLAR_ANCHOR_USDC_DISABLED",
      "Anchor has disabled SEP-24 USDC withdrawals.",
      503,
    );
  }
  const minimum = optionalBound(usdcInfo.min_amount, "withdraw.USDC.min_amount");
  const maximum = optionalBound(usdcInfo.max_amount, "withdraw.USDC.max_amount");
  if (request.amountMode === "send_exact") {
    assertSep24Amount(request.amount, minimum, maximum);
  }
  if (
    !Array.isArray(sep38Info.assets) ||
    !sep38Info.assets.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).asset === STELLAR_USDC_ASSET,
    )
  ) {
    throw controlled(
      "STELLAR_ANCHOR_USDC_IDENTITY_MISMATCH",
      "Anchor SEP-38 does not advertise the exact Circle Testnet USDC issuer.",
      503,
    );
  }
  if (!supportsDestination(sep38Info.assets, request)) {
    throw controlled(
      "STELLAR_ANCHOR_DESTINATION_UNSUPPORTED",
      "Anchor does not advertise this country, currency, and payout rail.",
      503,
    );
  }

  const query = new URLSearchParams({
    sell_asset: STELLAR_USDC_ASSET,
    buy_asset: `iso4217:${request.destinationCurrency}`,
    country_code: request.destinationCountry,
    buy_delivery_method: request.deliveryMethod,
    context: "sep24",
    [request.amountMode === "send_exact" ? "sell_amount" : "buy_amount"]:
      request.amount,
  });
  const price = await readJsonObject(
    `${anchor.anchorQuoteServer}/price?${query.toString()}`,
    timeoutMs,
  );
  const fee = price.fee;
  const feeObject =
    fee && typeof fee === "object" && !Array.isArray(fee)
      ? (fee as Record<string, unknown>)
      : null;
  const sellAmount = stringValue(price.sell_amount, "sell_amount");
  assertSep24Amount(sellAmount, minimum, maximum);
  const providerManifest = findStellarPaymentCenterProviderManifest(anchor.domain);
  return {
    provider: anchor.domain,
    sourceNetwork: request.sourceNetwork,
    sourceAsset: "USDC",
    destinationCountry: request.destinationCountry,
    destinationCurrency: request.destinationCurrency,
    deliveryMethod: request.deliveryMethod,
    sellAmount,
    buyAmount: stringValue(price.buy_amount, "buy_amount"),
    totalPrice: stringValue(price.total_price, "total_price"),
    price: stringValue(price.price, "price"),
    fee:
      feeObject &&
      typeof feeObject.total === "string" &&
      typeof feeObject.asset === "string"
        ? { total: feeObject.total, asset: feeObject.asset }
        : null,
    quoteType: "indicative",
    observedAt: new Date().toISOString(),
    sep24: true,
    sep31PartnerAdvertised: Boolean(anchor.directPaymentServer),
    sep38: true,
    settlementMode: "sep24_hosted_withdrawal",
    sep12Advertised: Boolean(anchor.kycServer),
    sep45Advertised: anchor.sep45Advertised,
    providerRole: providerManifest?.role || "operator_allowlisted",
    realWorldSettlement: providerManifest?.realWorldSettlement ?? null,
    passkeyIdentityBound: false,
    executionReady: false,
    blockedReason: anchor.sep45Advertised
      ? "Live SEP-24 price found. Kletia still needs authenticated SEP-45, a firm quote, and a hosted withdrawal session before preparing settlement."
      : "Live price found, but this anchor does not advertise complete SEP-45 contract-account authentication.",
    mockData: false,
  };
}

export function validateStellarLastMileQuoteRequest(
  value: unknown,
): StellarLastMileQuoteRequest {
  const parsed = LastMileQuoteRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw controlled(
      "STELLAR_LAST_MILE_REQUEST_INVALID",
      parsed.error.issues[0]?.message || "Last-mile quote request is invalid.",
      400,
    );
  }
  return parsed.data;
}

export function readStellarLastMileReadiness(): StellarLastMileReadiness {
  const enabled = envEnabled("STELLAR_LAST_MILE_ENABLED", true);
  const configuredAnchors = configuredAnchorOrigins().length;
  const discoveryConfigured = enabled && configuredAnchors > 0;
  return {
    enabled,
    configuredAnchors,
    paymentCore: discoveryConfigured ? "discovery_configured" : "unavailable",
    identity: "stellar_secp256r1_contract_account",
    settlement: "sep24_hosted_withdrawal",
    pricing: "sep38_live_indicative",
    execution: "provider_and_user_authorization_required",
    reason: !enabled
      ? "Stellar Payment Center is disabled by configuration."
      : configuredAnchors === 0
        ? "No reviewed anchor domain is configured. Kletia will not invent a payout route."
        : "Reviewed anchor domains are configured for live discovery. Execution still requires one provider to pass SEP-24, SEP-38 and SEP-45 gates, followed by explicit user authorization.",
    mockData: false,
  };
}

export async function quoteConfiguredStellarPaymentProvider(
  domain: string,
  value: unknown,
): Promise<StellarLastMileCandidate> {
  const request = validateStellarLastMileQuoteRequest(value);
  const readiness = readStellarLastMileReadiness();
  if (!readiness.enabled) {
    throw controlled("STELLAR_LAST_MILE_DISABLED", readiness.reason, 503);
  }
  const origin = normalizeAnchorOrigin(domain);
  const origins = configuredAnchorOrigins();
  if (!origins.includes(origin)) {
    throw controlled(
      "STELLAR_ANCHOR_NOT_CONFIGURED",
      "The requested payout provider is not in the reviewed anchor allowlist.",
      503,
    );
  }
  const timeoutMs = Math.min(
    15_000,
    Math.max(
      2_000,
      Number(process.env.STELLAR_ANCHOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    ),
  );
  const endpointHosts = configuredEndpointHosts(origins);
  const anchor = await discoverAnchor(origin, endpointHosts, timeoutMs);
  return quoteAnchor(anchor, request, timeoutMs);
}

export async function compareStellarLastMileRoutes(value: unknown): Promise<{
  schemaVersion: "kletia_stellar_last_mile_quote_v1";
  request: StellarLastMileQuoteRequest;
  candidates: StellarLastMileCandidate[];
  unavailableProviders: Array<{ provider: string; reason: string }>;
  nextRequiredCapability: "sep45_firm_quote_sep24_execution";
  mockData: false;
}> {
  const request = validateStellarLastMileQuoteRequest(value);
  const readiness = readStellarLastMileReadiness();
  if (!readiness.enabled) {
    throw controlled(
      "STELLAR_LAST_MILE_DISABLED",
      readiness.reason,
      503,
    );
  }
  const origins = configuredAnchorOrigins();
  if (origins.length === 0) {
    throw controlled(
      "STELLAR_LAST_MILE_UNAVAILABLE",
      readiness.reason,
      503,
    );
  }
  const timeoutMs = Math.min(
    15_000,
    Math.max(
      2_000,
      Number(process.env.STELLAR_ANCHOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    ),
  );
  const endpointHosts = configuredEndpointHosts(origins);
  const settled = await Promise.allSettled(
    origins.map(async (origin) => {
      const anchor = await discoverAnchor(origin, endpointHosts, timeoutMs);
      return quoteAnchor(anchor, request, timeoutMs);
    }),
  );
  const candidates: StellarLastMileCandidate[] = [];
  const unavailableProviders: Array<{ provider: string; reason: string }> = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      candidates.push(result.value);
    } else {
      unavailableProviders.push({
        provider: new URL(origins[index]).hostname,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : "Provider did not return a reviewed live route.",
      });
    }
  });
  candidates.sort((left, right) =>
    request.amountMode === "send_exact"
      ? Number(right.buyAmount) - Number(left.buyAmount)
      : Number(left.sellAmount) - Number(right.sellAmount),
  );
  return {
    schemaVersion: "kletia_stellar_last_mile_quote_v1",
    request,
    candidates,
    unavailableProviders,
    nextRequiredCapability: "sep45_firm_quote_sep24_execution",
    mockData: false,
  };
}
